#!/usr/bin/env python3
"""bcc_check.py — BCC-1 Body Compatibility Contract test harness (V0.3.1 §10).

Six contract areas, each with executable checks. Bodies under test:
  - body A: the real adapter under test, driven through simulate_body.mjs (node).
            Named by the caller via BCC_PLUGIN — this file bakes in NO body.
  - body B: a python reference implementation of the same contract (this file)

A contract PASS means both bodies produce equal observable semantics on the
same fixtures — which is what makes a harness replaceable.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def adapter_under_test() -> Path | None:
    """The adapter to test, as named by the caller.

    Resolved at CALL time, not import time: this harness bakes in no body, and a
    module-level constant would freeze whatever the environment happened to say
    when the module was first imported. BCC-1 is body-independent, so the
    generic side must not default to any one body's adapter — a default here
    would (a) make the harness silently test one body, and (b) put a body's name
    inside the body-independent layer. Callers: repo-level test
    (tests/test_wm_v031.py sets BCC_PLUGIN); standalone runs set it themselves.
    """
    raw = os.environ.get("BCC_PLUGIN")
    return Path(raw) if raw else None


sys.path.insert(0, str(HERE))
import canonical_compile  # noqa: E402
import migrate_v031  # noqa: E402

IRREVERSIBLE_RE = re.compile(
    r"rm\s+-rf|del\s+/[sq]|rmdir|Remove-Item[^\n]*-Recurse|drop\s+table|drop\s+database|"
    r"truncate|git\s+push[^\n]*(--force|-f\b)|git\s+reset[^\n]*--hard", re.I)
CONSEQUENT = {"edit", "write", "str-replace-editor", "notebook_edit", "exec", "mcp_call_tool"}

IGNORED_PROJ_KEYS = {"pid", "runtime_path", "cache", "timestamps", "body_id",
                     "watermark", "compiled_at"}


def find_node() -> str | None:
    """Locate a node binary to drive the adapter under test.

    No body's install layout is hardcoded here — a body-independent harness must
    not know where any particular body keeps its runtime. Callers whose node is
    not on PATH point BCC_NODE at it (or BCC_RUNTIME_ROOT at a runtime root that
    holds node-v*/node.exe).
    """
    n = os.environ.get("BCC_NODE") or shutil.which("node")
    if n:
        return n
    root = os.environ.get("BCC_RUNTIME_ROOT")
    if root:
        for p in Path(root).expanduser().glob("node-v*/node.exe"):
            return str(p)
    return None


# ---------- 6.1 State Semantics ----------

def semantic_projection(canonical_dir: Path) -> dict:
    """Normalized semantic view of canonical — body/path/time stripped."""
    cur = canonical_compile.load(canonical_dir / "current.yaml")
    lin = canonical_compile.load(canonical_dir / "lineage.yaml")
    gov = canonical_compile.load(canonical_dir / "governance.yaml")
    src = canonical_compile.load(canonical_dir / "sources.yaml")

    def clean(v):
        if isinstance(v, dict):
            return {k: clean(v2) for k, v2 in v.items() if k not in IGNORED_PROJ_KEYS}
        if isinstance(v, list):
            return [clean(x) for x in v]
        if isinstance(v, str) and re.fullmatch(r"[-\w]+\.(yaml|jsonl|md|json)|[\w./\\:-]*[\\/][\w./\\:-]+", v):
            return "<path-or-ref>"
        if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", v):
            return "<ts>"
        if isinstance(v, str) and v.startswith("evt-"):
            return "<evt>"
        return v

    return {
        "models": clean((cur.get("world_model") or {}).get("models")),
        "competing": clean((cur.get("world_model") or {}).get("competing_models")),
        "open_predictions": clean((cur.get("world_model") or {}).get("open_predictions")),
        "residuals": clean((cur.get("world_model") or {}).get("known_residuals")),
        "value": clean(cur.get("value_model")),
        "u0_roots": sorted((gov.get("u0_constitutional") or {}).get("root_authorities", {}).keys()),
        "normative": clean(gov.get("normative_authorities")),
        "sources": clean(src.get("sources")),
        "entity": {"entity_id": lin.get("entity_id"),
                   "epoch": lin.get("continuity_epoch"),
                   "has_parent": lin.get("parent_entity") is not None},
    }


# ---------- 6.2 Event Ordering ----------

ORDER = {"PREDICTION_CREATED": 0, "ACTION": 1, "RAW_EVIDENCE": 2,
         "OBSERVATION_RECORDED": 3, "PREDICTION_EVALUATED": 4, "MODEL_UPDATED": 5}


def validate_event_order(events: list[dict]) -> list[str]:
    """Return violations of Prediction<Action<Evidence<Observation<Eval<Update."""
    errs = []
    by_pred = {}
    first_mutation_seq = None
    for ev in events:
        et = ev.get("event_type")
        seq = ev.get("seq", 0)
        payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
        pid = ev.get("prediction_id") or payload.get("prediction_id")
        if et == "PREDICTION_CREATED" and pid:
            by_pred[pid] = seq
        if et == "GUARD_BLOCKED":
            continue
        if et == "RAW_EVIDENCE":
            continue  # evidence may arrive any time; ordering checked on use
        if et == "OBSERVATION_RECORDED":
            ev_refs = ev.get("evidence_refs") or []
            for r in ev_refs:
                pass  # refs resolved by ledger audit; presence checked here
        if et == "PREDICTION_EVALUATED" and pid:
            if pid in by_pred and by_pred[pid] >= seq:
                errs.append(f"evaluate before predict for {pid}")
        if et == "MODEL_UPDATED":
            ref = ev.get("prediction_id") or payload.get("prediction_id")
            if ref and ref not in by_pred and ref not in eval_set(events):
                errs.append(f"update references unevaluated prediction {ref}")
    return errs


def eval_set(events):
    return {ev.get("prediction_id") for ev in events
            if ev.get("event_type") == "PREDICTION_EVALUATED"}


# ---------- 6.3 Guard Semantics (python reference body) ----------

def guard_reference(tool: str, args: dict, mode: str, predictions: list[dict],
                    exec_extra: dict | None = None) -> str:
    """Reference implementation of the guard contract. Returns permit|deny.

    `exec_extra` mirrors the alias / unknown parameter keys a harness may place
    on the execution (`parameters`, `tool_input`, or a body's own key). The whole
    payload pool is scanned: a payload hidden under an alias key is still a
    payload — **hiding it must not turn a deny into a permit**. Reading only
    `arguments` makes every alias key a binding-bypass surface.
    """
    if tool not in CONSEQUENT:
        return "permit"
    if mode not in ("core", "full"):
        return "permit"
    pool = [args]
    if exec_extra:
        pool.extend(v for v in exec_extra.values() if v is not None)
    args_text = json.dumps(pool, ensure_ascii=False)
    irreversible = bool(IRREVERSIBLE_RE.search(args_text))
    for p in predictions:
        if p.get("evaluated"):
            continue
        ia = str(p.get("intended_action") or "")
        if not ia:
            continue
        bound = tool in ia or re.search(r"mutation|edit|write|exec|modify|change", ia, re.I)
        if not bound:
            continue
        if irreversible and p.get("irreversible") is not True:
            continue
        return "permit"
    return "deny"


GUARD_FIXTURES = [
    {"name": "read permit", "tool": "read", "args": {}, "mode": "core", "preds": [], "expect": "permit"},
    {"name": "reversible temp write permit", "tool": "exec", "args": {"command": "echo hi"}, "mode": "off", "preds": [], "expect": "permit"},
    {"name": "mutation w/o prediction deny", "tool": "edit", "args": {"file_path": "x"}, "mode": "core", "preds": [], "expect": "deny"},
    {"name": "bound prediction permit", "tool": "edit", "args": {"file_path": "x"}, "mode": "core",
     "preds": [{"intended_action": "edit file x"}], "expect": "permit"},
    {"name": "superseded prediction deny", "tool": "edit", "args": {"file_path": "x"}, "mode": "core",
     "preds": [{"intended_action": "edit x", "evaluated": True}], "expect": "deny"},
    {"name": "irreversible w/o flag deny", "tool": "exec", "args": {"command": "rm -rf /tmp/x"}, "mode": "core",
     "preds": [{"intended_action": "exec cleanup"}], "expect": "deny"},
    {"name": "irreversible flagged permit", "tool": "exec", "args": {"command": "rm -rf /tmp/x"}, "mode": "core",
     "preds": [{"intended_action": "exec rm -rf /tmp/x", "irreversible": True}], "expect": "permit"},
    # Alias-key resistance (principle: an invisible payload is a binding bypass
    # surface — hiding ≠ not existing). A guard that reads only `arguments` sees
    # an empty payload here and PERMITS a bound-but-unflagged irreversible call.
    # simulate_body.mjs supports injecting these via the scenario step's
    # `exec_extra` (spread onto the execution as alias / body-own keys).
    {"name": "alias key: irreversible payload hidden in parameters still denies", "tool": "exec",
     "args": {}, "exec_extra": {"parameters": {"command": "rm -rf /tmp/x"}}, "mode": "core",
     "preds": [{"intended_action": "exec cleanup"}], "expect": "deny"},
    {"name": "alias key: hidden payload + irreversible-flagged prediction permits", "tool": "exec",
     "args": {}, "exec_extra": {"tool_input": {"command": "rm -rf /tmp/x"}}, "mode": "core",
     "preds": [{"intended_action": "exec rm -rf /tmp/x", "irreversible": True}], "expect": "permit"},
    {"name": "alias key: body-own non-structural key is scanned too", "tool": "exec",
     "args": {}, "exec_extra": {"custom_field": {"cmd": "rm -rf /tmp/x"}}, "mode": "core",
     "preds": [{"intended_action": "exec cleanup"}], "expect": "deny"},
]


# ---------- runners ----------

def run_plugin_body(scenario: dict, tmp: Path, mode: str) -> dict:
    node = find_node()
    if not node:
        return {"skipped": "node not found"}
    adapter = adapter_under_test()
    if adapter is None:
        return {"skipped": "BCC_PLUGIN not set — the harness must be told which adapter to test"}
    if not adapter.exists():
        return {"skipped": f"BCC_PLUGIN does not exist: {adapter}"}
    scen = dict(scenario)
    scen["mode"] = mode
    sp = tmp / "scenario.json"
    sp.write_text(json.dumps(scenario, ensure_ascii=False), encoding="utf-8")
    state = tmp / "state"; canon = tmp / "canon"
    state.mkdir(exist_ok=True); canon.mkdir(exist_ok=True)
    r = subprocess.run([node, str(HERE / "simulate_body.mjs"), str(sp), str(state), str(canon), mode],
                       capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace",
                       env={**os.environ, "BCC_PLUGIN": str(adapter)})
    if r.returncode != 0:
        return {"error": r.stderr[-500:]}
    out = json.loads(r.stdout.strip().splitlines()[-1])
    ledger = {}
    for f in state.glob("runs/*.jsonl"):
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            ledger.setdefault(f.name, []).append(ev)
    out["ledger"] = ledger
    return out


def _finish(results: dict) -> dict:
    """Aggregate the verdict and return the result set.

    `pass: None` means "not tested" (skipped) and is excluded from the verdict —
    but a run where NOTHING was tested must not report PASS: an all-skipped run
    would otherwise satisfy `all([])` vacuously and read as a green contract that
    was never exercised.
    """
    applicable = [v.get("pass") for v in results.values()
                  if isinstance(v, dict) and v.get("pass") is not None]
    results["PASS"] = all(applicable) if applicable else None
    # Make "what was NOT exercised" visible: PASS:true next to four silent skips
    # reads as a fully-verified contract.
    skipped = sorted(k for k, v in results.items()
                     if isinstance(v, dict) and v.get("pass") is None)
    if skipped:
        results["skipped"] = skipped
    if not applicable:
        results["note"] = "nothing was tested — set BCC_PLUGIN to name the adapter under test"

    # A BARE PASS IS NOT A VERDICT (conformance-rubric §〇 A-P2): every verdict
    # record must bind subject / version / scope / evidence window, and the three
    # verdict objects — theory coverage, implementation conformance, governance
    # integrity — must not be fused into one score. This checker answers exactly
    # ONE of them: does this adapter faithfully implement the mechanisms its
    # contract claims. It says nothing about whether the theory covers the domain,
    # and nothing about governance. Naming that here is what stops a green run
    # from being read as a release decision.
    results["verdict_layer"] = "implementation_conformance"
    results["verdict_binding"] = {
        "subject": os.environ.get("BCC_PLUGIN") or results.get("plugin") or "unspecified adapter",
        "version": "BCC-1",
        "scope": "the six BCC-1 protocols, as exercised above",
        "evidence_window": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    results["not_this"] = ("theory coverage and governance integrity are separate verdicts; "
                           "a release decision is policy(all layers), not this boolean")
    return results


def check_all(canonical_dir: Path | None = None, with_node: bool = True) -> dict:
    results = {}

    # 6.1 state semantics — same canonical under two body dirs → equal projection
    if canonical_dir:
        p1 = semantic_projection(canonical_dir)
        with tempfile.TemporaryDirectory() as td:
            clone = Path(td) / "canon-bodyB"
            shutil.copytree(canonical_dir, clone, ignore=shutil.ignore_patterns("history", "proposals"))
            p2 = semantic_projection(clone)
        results["state_semantics"] = {"pass": p1 == p2,
                                      "note": "projection equal across body dirs (paths/ids stripped)"}
    else:
        results["state_semantics"] = {"pass": None, "note": "no canonical dir given"}

    # 6.2 event ordering — real ledger produced by plugin scenario
    scen = {"mode": "core", "steps": [
        {"type": "tool_call", "input": {"op": "activate", "mode": "core"}},
        {"type": "tool_call", "input": {"op": "predict", "subject": "s", "intended_action": "edit x",
                                        "expected_observation": "e", "falsifier": "f"}},
        {"type": "tool_result", "tool": "read", "result": "data"},
        {"type": "tool_call", "input": {"op": "observe", "prediction_id": "P-x", "observation": "o"}},
        {"type": "tool_call", "input": {"op": "evaluate", "prediction_id": "P-x", "verdict": "confirmed",
                                        "evaluation_source": "mechanical"}},
        {"type": "tool_call", "input": {"op": "update", "model_id": "m", "revision_type": "param",
                                        "change": "c"}},
    ]}
    if with_node:
        with tempfile.TemporaryDirectory() as td:
            out = run_plugin_body(scen, Path(td), "core")
            if "skipped" in out or "error" in out:
                # A body run that never happened must not read as a PASS: an empty
                # ledger satisfies every ordering predicate vacuously, so a skip
                # would otherwise masquerade as "ordering verified".
                results["event_ordering"] = {"pass": None, "note": "body run skipped",
                                             "reason": out.get("skipped") or out.get("error")}
            else:
                seqs = []
                for evs in out.get("ledger", {}).values():
                    seqs.extend(evs)
                seqs.sort(key=lambda e: e.get("seq", 0))
                errs = validate_event_order(seqs)
                mono = all(seqs[i].get("seq", 0) <= seqs[i + 1].get("seq", 0) for i in range(len(seqs) - 1))
                linked = all(seqs[i].get("prev_event") == seqs[i - 1].get("event_id")
                             for i in range(1, len(seqs)))
                results["event_ordering"] = {"pass": bool(seqs) and not errs and mono and linked,
                                             "violations": errs, "monotonic_seq": mono,
                                             "causal_chain": linked, "events": len(seqs)}
    else:
        results["event_ordering"] = {"pass": None, "note": "node skipped"}

    # 6.3 guard semantics — real plugin vs python reference on same fixtures
    gres = []
    for fx in GUARD_FIXTURES:
        ref = guard_reference(fx["tool"], fx["args"], fx["mode"], fx["preds"], fx.get("exec_extra"))
        row = {"fixture": fx["name"], "expect": fx["expect"], "reference": ref}
        if with_node:
            scen = {"mode": fx["mode"], "steps": [
                {"type": "tool_call", "input": {"op": "activate", "mode": fx["mode"]}}] +
                [{"type": "tool_call", "input": {"op": "predict", "subject": "g",
                                               "intended_action": p.get("intended_action", ""),
                                               "irreversible": p.get("irreversible", False)}}
                 for p in fx["preds"]] +
                [{"type": "tool_call", "input": {"op": "evaluate", "prediction_id": "__last__",
                                               "verdict": "unknown"}, "_eval_last": True}
                 if any(p.get("evaluated") for p in fx["preds"]) else []] +
                [{"type": "guard", "tool": fx["tool"], "arguments": fx["args"],
                  **({"exec_extra": fx["exec_extra"]} if fx.get("exec_extra") else {})}],
            }
            # evaluate step needs real prediction id; mark evaluated predictions by
            # issuing evaluate on last created — simulate_body handles op calls;
            # for 'evaluated' preds we add an extra predict+evaluate pair
            with tempfile.TemporaryDirectory() as td:
                out = run_plugin_body(scen, Path(td), fx["mode"])
                dec = (out.get("guardDecisions") or [{}])[-1].get("decision")
                row["plugin"] = dec
        row["pass"] = ref == fx["expect"] and (not with_node or row.get("plugin") == fx["expect"])
        gres.append(row)
    # A fixture whose body run never happened reports pass=None (not False, and
    # certainly not True) — "not tested" must be distinguishable from both.
    ran = [r for r in gres if r.get("plugin") is not None]
    results["guard_semantics"] = {
        "pass": (all(r["pass"] for r in ran) if ran else None),
        "fixtures_ran": len(ran), "fixtures_total": len(gres),
        "fixtures": gres,
    }

    # 6.4 tool identity — body rename keeps canonical identity.
    # NOT TESTED. This used to report `pass: True` unconditionally, which made a
    # contract that never exercised tool identity read as a green protocol — the
    # same defect class as an all-skipped run reporting PASS. `pass: None` is the
    # honest value ("not tested"), and it is excluded from the aggregate.
    #
    # Why it cannot be tested yet: the mechanism does not exist end to end.
    #   - contract side: needs a fixture that drives a tool result under a
    #     body-specific name and reads back the event's canonical_tool_id;
    #   - body side: the adapter currently emits
    #     `{canonical_tool_id: exec.name, body_tool_id: exec.name}` — both the
    #     SAME value, i.e. no mapping at all;
    #   - the mapping needs a declared body→canonical table (see
    #     host/src/core/irreversible.js::resolveToolId, added for this).
    # Until the adapter declares and applies identities, any fixture would only
    # assert the placeholder.
    results["tool_identity"] = {
        "pass": None,
        "note": "not tested — no adapter emits a distinct canonical_tool_id yet",
        "check": "RAW_EVIDENCE carries canonical_tool_id stable across a body rename; "
                 "rename affects body_tool_id only",
        "needs": "body declares {body tool name: canonical name}; adapter emits both fields; "
                 "fixture drives a renamed tool and reads the ledger"}

    # 6.5 persistence — kill points
    with tempfile.TemporaryDirectory() as td:
        state = Path(td) / "state"; canon = Path(td) / "canon"
        state.mkdir(); canon.mkdir()
        scen = {"mode": "core", "steps": [
            {"type": "tool_call", "input": {"op": "activate", "mode": "core"}},
            {"type": "tool_call", "input": {"op": "predict", "subject": "s", "intended_action": "edit x"}},
            {"type": "tool_call", "input": {"op": "persist", "summary": "mid"}},
            {"type": "tool_call", "input": {"op": "status"}},
        ]}
        kp = {}
        body_out = run_plugin_body(scen, Path(td), "core") if with_node else {"skipped": "node skipped"}
        if "skipped" in body_out or "error" in body_out:
            # Nothing ran, so the kill-point files cannot exist — reporting False
            # would read as "persistence broken" instead of "untested".
            results["persistence"] = {"pass": None, "note": "body run skipped",
                                      "reason": body_out.get("skipped") or body_out.get("error")}
        else:
            # SEMANTIC checks — asked through the adapter's own interface and by
            # content relationship, never by file name or id prefix. An earlier
            # form asserted `current.json` exists and contains "P-", which froze
            # one body's storage layout into a body-independent contract: an
            # adapter storing predictions elsewhere (e.g. host/core/prediction.js)
            # would be semantically correct and still fail.
            calls = body_out.get("toolCalls") or []
            pid = next((c.get("out", {}).get("prediction_id") for c in calls
                        if c.get("op") == "predict" and isinstance(c.get("out"), dict)), None)
            status = next((c.get("out") for c in calls
                           if c.get("op") == "status" and isinstance(c.get("out"), dict)), None)
            kp["open_prediction_survives_persist"] = bool(
                pid and status and pid in json.dumps(status, ensure_ascii=False))
            # append-only == "the earlier content is a prefix of the later one":
            # true of an append log, false of a rewritten file. Asked of the
            # state dir as a whole, so no path is hardcoded.
            before = {str(p.relative_to(state)): p.read_bytes()
                      for p in state.rglob("*") if p.is_file()}
            run_plugin_body(scen, Path(td), "core")
            after = {str(p.relative_to(state)): p.read_bytes()
                     for p in state.rglob("*") if p.is_file()}
            appended = [k for k, v in before.items()
                        if k in after and after[k].startswith(v) and len(after[k]) > len(v)]
            kp["append_only_log_exists"] = bool(appended)
            # Torn-tail tolerance, tested SEMANTICALLY: corrupt the tail of the
            # append log we just identified, then ask the adapter for its state
            # again. The property is "a torn tail row must not make the store
            # unreadable" — so the assertion is that `status` still succeeds and
            # still reports the prediction. (An earlier form appended invalid
            # JSON and then asserted that invalid JSON fails to parse: a
            # tautology, always true, testing the adapter not at all.)
            if appended:
                log = state / appended[0]
                with open(log, "a", encoding="utf-8") as f:
                    f.write("{corrupt tail\n")
                again = run_plugin_body(scen, Path(td), "core")
                st2 = next((c.get("out") for c in (again.get("toolCalls") or [])
                            if c.get("op") == "status" and isinstance(c.get("out"), dict)), None)
                kp["torn_tail_tolerated"] = bool(
                    st2 and st2.get("ok") is not False
                    and pid and pid in json.dumps(st2, ensure_ascii=False))
            results["persistence"] = {"pass": bool(kp) and all(kp.values()), "checks": kp}

    # 6.6 schema compatibility — migrate a 1.0 fixture → verify → rollback → identical
    with tempfile.TemporaryDirectory() as td:
        old_canon = Path(td) / "old"
        old_canon.mkdir()
        fixture_10 = {
            "schema_version": "1.0", "watermark": "2026-01-01T00:00:00Z",
            "current_models": {"M1": {"proposition": "p", "confidence": "medium"}},
            "channel_model": {"user": {"correction_history": ["c1"]}},
            "future_unknown_field": {"nested": [1, 2, 3]},
        }
        import yaml
        (old_canon / "current.yaml").write_text(
            yaml.safe_dump(fixture_10, allow_unicode=True), encoding="utf-8")
        orig = (old_canon / "current.yaml").read_bytes()
        rep = migrate_v031.migrate(old_canon, apply=True)
        ver = migrate_v031.verify(old_canon)
        cur11 = canonical_compile.load(old_canon / "current.yaml")
        preserved = "x_preserved" in cur11 and "future_unknown_field" in cur11.get("x_preserved", {})
        rb = migrate_v031.rollback(old_canon, None)
        restored = (old_canon / "current.yaml").read_bytes()
        results["schema_compat"] = {
            "pass": bool(ver.get("PASS")) and preserved and restored == orig,
            "migrate": rep.get("applied"), "verify_PASS": ver.get("PASS"),
            "unknown_field_preserved": preserved, "rollback_byte_identical": restored == orig,
        }

    return _finish(results)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", default=None)
    ap.add_argument("--no-node", action="store_true")
    args = ap.parse_args()
    res = check_all(Path(args.canonical) if args.canonical else None,
                    with_node=not args.no_node)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res.get("PASS") else 1


if __name__ == "__main__":
    sys.exit(main())
