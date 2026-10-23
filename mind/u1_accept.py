#!/usr/bin/env python3
"""u1_accept.py — U1 governance apply path (V0.3.1, consumer-side U1-1.2).

MODEL_PROPOSAL / promoted HYPOTHESIS -> U1 decision -> canonical current.yaml.
STATUS_UPDATE -> U1 decision -> whitelisted fields on open-loops.yaml entries
  (status bookkeeping goes through the same governed path, not hand edits).
reject / withdraw -> status-only close on the proposal file. Works for EVERY
  kind, including kinds that have no apply channel — closing an obsolete
  proposal must never be blocked by the apply gate.

Kind coverage is declared in KIND_BUCKETS below and kept in sync with the
producer vocabulary by tests/test_proposal_kind_contract.py. A kind that is in
no bucket is a "ghost kind" and is refused with a diagnostic rather than
applied or silently dropped. See docs/proposal-kind-contract-gap.md.

Rules:
  - canonical write happens ONLY here (proposals/ledger/distiller never write)
  - every apply writes a byte-exact backup first (rollback-capable)
  - accepted models enter with epistemic_status 'provisional' — real
    Observation promotes/demotes them later, not the proposal itself
  - provenance chain preserved: proposal -> hypothesis/problem/packet/episodes
  - proposal file status updated (its lifecycle), original payload untouched
"""
import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

U1_VERSION = "U1-1.2"

# ── Kind registry (consumer side) ────────────────────────────────────────
# "What may this script decide". Every bucket is disjoint; together they must
# cover the whole producer vocabulary, otherwise a proposal reaches the apply
# path with no defined disposition — a "ghost kind". Enforced by
# tests/test_proposal_kind_contract.py, which also extracts KIND_BY_CLASS from
# dsh/world-model/world-model.mjs so producer and consumer cannot drift apart
# silently. Rationale and timeline: docs/proposal-kind-contract-gap.md.
KIND_APPLY = {
    "MODEL_PROPOSAL",   # world_model class -> current.yaml world_model.models
    "STATUS_UPDATE",    # whitelisted bookkeeping -> open-loops.yaml
}
# Producer is alive, consumer does not exist yet. Structural debt, scoped to D1.
KIND_DEBT_LIVE = {
    "value-update",     # world-model.mjs:1236 / :1286 / :1320
    "canonical",        # world-model.mjs:1349
}
# Declared in the producer vocabulary, never observed in the queue.
KIND_DEBT_DECLARED = {
    "governance-u0", "governance-u1", "lineage-update", "body-binding",
    "gate-policy", "schema-update", "declassification",
}
# Producer retired on 2026-09-15 (f034133); the surviving files are a closed
# generation that predates KIND_BY_CLASS. Close them with --decision withdraw.
KIND_FOSSIL = {
    "model-update", "governance_u1", "schema", "config-declaration",
}
# Emitted by our own Python side, decided by their own owners — never here.
KIND_FOREIGN = {
    "HYPOTHESIS_PROPOSAL", "HYPOTHESIS_STATE_UPDATE",   # hypothesis_search.py
    "NOTE_PROPOSAL",                                    # hand-written escalation
}

KIND_BUCKETS = {
    "apply": KIND_APPLY,
    "debt_live": KIND_DEBT_LIVE,
    "debt_declared": KIND_DEBT_DECLARED,
    "fossil": KIND_FOSSIL,
    "foreign": KIND_FOREIGN,
}
ALL_KNOWN_KINDS = frozenset().union(*KIND_BUCKETS.values())

# Terminal decisions touch the proposal file only — never canonical — so they
# must stay available for every kind, including kinds that can never be
# accepted. Gating them behind the apply check (the pre-1.2 ordering) locked
# the operator out of closing fossil proposals at all.
TERMINAL_DECISIONS = {"reject": "rejected", "withdraw": "withdrawn"}
# A proposal in one of these states has already been ruled on.
DECIDED_STATUSES = {"accepted", "approved", "provisional", "rejected", "withdrawn"}


def _kind_bucket(kind: str) -> str:
    for name, kinds in KIND_BUCKETS.items():
        if kind in kinds:
            return name
    return "ghost"


def _kind_refusal(kind: str, decision: str) -> str:
    """Refuse an apply decision with a disposition, not just the raw kind.

    A bare 'got <kind>' tells the operator nothing about whether the proposal is
    obsolete, undeveloped, or simply not ours — three different next actions.
    """
    doc = "docs/proposal-kind-contract-gap.md"
    if decision in TERMINAL_DECISIONS:
        # Unreachable in correct ordering. If it ever fires, the terminal branch
        # has been moved behind the apply gate and the operator is locked out
        # again — say so instead of blaming the proposal's kind.
        return (f"internal ordering error: terminal decision {decision!r} on "
                f"kind {kind!r} reached the apply gate. The terminal branch must "
                f"run before this check in main().")
    action = f"cannot {decision} kind {kind!r}"
    bucket = _kind_bucket(kind)
    if bucket == "fossil":
        return (f"{action}: retired 2026-09-15 (f034133) — the producer now "
                f"emits MODEL_PROPOSAL. This file is a closed generation; close "
                f"it with --decision withdraw instead of applying it. See {doc}.")
    if bucket == "debt_live":
        return (f"{action}: no U1 apply channel exists yet (structural debt, "
                f"scoped to D1). The producer is still live, so this proposal "
                f"cannot be applied by any path today. See {doc}.")
    if bucket == "debt_declared":
        return (f"{action}: declared in the producer vocabulary but no apply "
                f"channel exists and none has ever been produced. See {doc}.")
    if bucket == "foreign":
        return (f"{action}: this kind is owned by its producer, not by "
                f"u1_accept. See {doc}.")
    return (f"{action}: unknown kind — it is absent from the producer "
            f"vocabulary, the apply set and every debt bucket. Refusing to "
            f"guess; add it to the registry in {__file__} and to {doc} first.")

# STATUS_UPDATE: bookkeeping updates to canonical sidecar files. Whitelist-only:
# target file, entry id, and settable fields are all constrained — the proposal
# cannot invent structure, touch current.yaml, or write outside the sidecar.
STATUS_TARGETS = {"open-loops.yaml": "open_loops"}
STATUS_FIELDS = {"status", "closed", "note", "priority"}
SCALAR_TYPES = (str, int, float, bool, type(None))


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(
        timespec="seconds").replace("+00:00", "Z")


def _apply_status_update(canon: Path, pfile: Path, prop: dict,
                         args: argparse.Namespace) -> int:
    payload = prop.get("payload") or {}
    target = payload.get("target")
    if target not in STATUS_TARGETS:
        raise SystemExit(f"STATUS_UPDATE target must be one of "
                         f"{sorted(STATUS_TARGETS)}, got {target!r}")
    loop_id = payload.get("loop_id")
    if not isinstance(loop_id, str) or not loop_id:
        raise SystemExit("STATUS_UPDATE requires payload.loop_id")
    updates = payload.get("set")
    if not isinstance(updates, dict) or not updates:
        raise SystemExit("STATUS_UPDATE requires non-empty payload.set")
    bad_keys = sorted(k for k in updates if k not in STATUS_FIELDS)
    if bad_keys:
        raise SystemExit(f"STATUS_UPDATE fields not allowed: {bad_keys}")
    for key, val in updates.items():
        if not isinstance(val, SCALAR_TYPES) or isinstance(val, (list, dict)):
            raise SystemExit(f"STATUS_UPDATE field {key!r} must be a scalar")
        if isinstance(val, str) and len(val) > 2000:
            raise SystemExit(f"STATUS_UPDATE field {key!r} exceeds 2000 chars")

    tpath = canon / target
    doc = yaml.safe_load(tpath.read_text(encoding="utf-8"))
    entries = (doc or {}).get(STATUS_TARGETS[target]) or []
    hits = [e for e in entries if isinstance(e, dict) and e.get("id") == loop_id]
    if len(hits) != 1:
        raise SystemExit(f"STATUS_UPDATE loop_id {loop_id!r} matches "
                         f"{len(hits)} entries (require exactly 1)")
    entry = hits[0]

    bdir = canon / "history" / f"pre-u1-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    bdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(tpath, bdir / target)

    applied = {}
    for key, val in updates.items():
        applied[key] = {"old": entry.get(key), "new": val}
        entry[key] = val
    tpath.write_text(yaml.safe_dump(doc, allow_unicode=True,
                                    sort_keys=False), encoding="utf-8")

    prop["status"] = "accepted" if args.decision == "accept" else "provisional"
    prop["decision"] = {"decision": args.decision, "reason": args.reason,
                        "authority": args.authority, "ts": utcnow(),
                        "applied_loop": loop_id, "fields": applied,
                        "rollback": str(bdir)}
    pfile.write_text(json.dumps(prop, ensure_ascii=False, indent=2),
                     encoding="utf-8")

    mlog = canon / "history" / "model-updates.jsonl"
    with mlog.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "ts": utcnow(), "kind": "U1_STATUS_APPLY", "target": target,
            "loop_id": loop_id, "fields": sorted(updates),
            "decision": args.decision, "proposal": pfile.name,
            "authority": args.authority, "rollback": str(bdir),
            "schema_version": "1.2"}, ensure_ascii=False) + "\n")

    print(json.dumps({"decision": args.decision, "applied_loop": loop_id,
                      "fields": sorted(updates), "rollback": str(bdir),
                      "u1_version": U1_VERSION}, ensure_ascii=False))
    return 0


def _apply_terminal_decision(pfile: Path, prop: dict,
                             args: argparse.Namespace) -> int:
    """Status-only transition: the proposal file changes, canonical never does.

    Deliberately kind-agnostic. Closing an obsolete or never-appliable proposal
    is exactly the operation that must remain possible for kinds the apply path
    rejects.
    """
    new_status = TERMINAL_DECISIONS[args.decision]
    current = prop.get("status")
    if current == new_status:
        # Idempotent: re-running the same close must not append a second
        # decision record (that would rewrite the audit trail's ts/authority).
        print(json.dumps({"decision": args.decision, "status": current,
                          "canonical_write": "NONE", "changed": False}))
        return 0
    if current in DECIDED_STATUSES - {"rejected", "withdrawn"}:
        raise SystemExit(
            f"cannot {args.decision}: proposal is already {current!r}. A decide "
            f"that has been applied cannot be undone here — reversal is a "
            f"demotion proposal, not a status edit.")
    prop["status"] = new_status
    prop["decision"] = {"decision": args.decision, "reason": args.reason,
                        "authority": args.authority, "ts": utcnow()}
    pfile.write_text(json.dumps(prop, ensure_ascii=False, indent=2),
                     encoding="utf-8")
    print(json.dumps({"decision": args.decision, "status": new_status,
                      "kind": prop.get("kind"), "canonical_write": "NONE",
                      "changed": True}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True)
    ap.add_argument("--proposal", required=True,
                    help="proposal file inside canonical/proposals/")
    ap.add_argument("--decision", required=True,
                    choices=["accept", "provisional", "reject", "withdraw"])
    ap.add_argument("--reason", default="")
    ap.add_argument("--authority", default="u1-review",
                    help="accepting authority ref (must exist pre-change)")
    args = ap.parse_args()

    canon = Path(args.canonical)
    pfile = canon / "proposals" / args.proposal
    prop = json.loads(pfile.read_text(encoding="utf-8"))
    kind = prop.get("kind")

    # Terminal decisions first, apply gate second. Ordering is load-bearing: an
    # apply-channel check ahead of this branch leaves an operator holding an
    # obsolete proposal with no way to close it.
    if args.decision in TERMINAL_DECISIONS:
        return _apply_terminal_decision(pfile, prop, args)

    if kind not in KIND_APPLY:
        raise SystemExit(_kind_refusal(kind, args.decision))

    if kind == "STATUS_UPDATE":
        return _apply_status_update(canon, pfile, prop, args)

    cand = (prop.get("payload") or {}).get("candidate") or {}
    mid = cand.get("candidate_id")
    if not mid:
        raise SystemExit("proposal has no candidate_id")

    cur_path = canon / "current.yaml"
    cur = yaml.safe_load(cur_path.read_text(encoding="utf-8"))
    # rollback backup — byte-exact, before any mutation
    bdir = canon / "history" / f"pre-u1-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    bdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cur_path, bdir / "current.yaml")

    models = cur.setdefault("world_model", {}).setdefault("models", {})
    # Only accept/provisional can reach here — reject and withdraw return from
    # the terminal branch above, so there is no residual "?" status path.
    status = "provisional"
    models[mid] = {
        "proposition": cand.get("proposition"),
        "epistemic_status": status,
        "operational_status": "usable",
        "scope": cand.get("scope"),
        "scope_conditions": cand.get("scope_conditions"),
        "confidence": cand.get("confidence", "low"),
        "confidence_basis": cand.get("confidence_basis"),
        "evidence_refs": (cand.get("supporting") or {}).get("evidence_refs", []),
        "episode_refs": (cand.get("supporting") or {}).get("episode_refs", []),
        "counterevidence": cand.get("counterexamples", []),
        "known_exceptions": cand.get("known_exceptions", []),
        "falsifier": cand.get("falsifier"),
        "promotion_criteria": cand.get("promotion_criteria"),
        "access": cand.get("access") or {"level": "PRIVATE",
                                         "basis": ["taint_inheritance"]},
        "provenance": {
            "proposal": args.proposal,
            "decision": args.decision,
            "authority": args.authority,
            "ts": utcnow(),
            "promoted_from": cand.get("promoted_from"),
        },
        "update_history": f"U1 {args.decision}: {args.reason}"[:400],
    }
    cur_path.write_text(yaml.safe_dump(cur, allow_unicode=True,
                                       sort_keys=False), encoding="utf-8")

    prop["status"] = "accepted" if args.decision == "accept" else "provisional"
    prop["decision"] = {"decision": args.decision, "reason": args.reason,
                        "authority": args.authority, "ts": utcnow(),
                        "applied_model": mid, "rollback": str(bdir)}
    pfile.write_text(json.dumps(prop, ensure_ascii=False, indent=2),
                     encoding="utf-8")

    mlog = canon / "history" / "model-updates.jsonl"
    with mlog.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "ts": utcnow(), "kind": "U1_APPLY", "model_id": mid,
            "decision": args.decision, "proposal": args.proposal,
            "authority": args.authority, "rollback": str(bdir),
            "schema_version": "1.2"}, ensure_ascii=False) + "\n")

    print(json.dumps({"decision": args.decision, "model_id": mid,
                      "epistemic_status": status, "rollback": str(bdir),
                      "u1_version": U1_VERSION}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
