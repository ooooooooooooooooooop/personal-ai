#!/usr/bin/env python3
"""body_bind.py — governed body binding: release the old body, bind the new one.

WHY THIS TOOL EXISTS: body_binding is an operator act with declared rules
(governance update_classes.body_binding: "BCC-1 全项 PASS · BODY_RELEASED 先行 ·
epoch+1"). Until now those rules had NO tooling — binding meant hand-editing
canonical, which is exactly the ungoverned write the constitution forbids and
the rules exist to prevent. This tool makes the governed path the EASY path.

WHAT IT DOES (apply mode, in order — any failure stops before any write):
  1. precondition checks (see below; fail-closed, nothing is written)
  2. backup lineage.yaml + current.yaml into history/pre-bind-<ts>/
  3. BODY_RELEASED lineage event for the outgoing body (if one is bound)
  4. BODY_BOUND lineage event for the new body; continuity_epoch += 1;
     lineage_head updated in BOTH lineage.yaml and current.yaml
  5. recompile the derived projections (briefing.md, instruction/generated.md)
     so the stale projection never silently disagrees with the new binding

WHAT IT REFUSES TO DO:
  - bind while another body is still bound, unless --release-current is given
    (the governance order is BODY_RELEASED *先行* — the release must be a
    recorded event BEFORE the bind, never implied by it)
  - bind without a BCC-1 verdict: pass --verify-bcc <adapter> to RUN the bench
    now, or --bcc-evidence <ref> to cite a prior PASS (e.g. a test run id).
    Refusing to proceed without one of the two is the point: the requirement
    is declared, so the tool declares how it was met rather than assuming it.
  - re-bind the body that is already bound (a no-op bind would still bump the
    epoch and append lineage — history pollution without an event)

This tool is harness-agnostic: the body id and harness type come from the
operator, no body is named here.

Usage:
  python mind/body_bind.py --canonical <dir> --body <body-id> --harness <type>
      --operator <who> --reason <why>
      (--verify-bcc <adapter.mjs> | --bcc-evidence <reference>)
      [--release-current] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_yaml(p: Path) -> dict:
    if not p.exists():
        return {}
    data = yaml.safe_load(p.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def dump_yaml(p: Path, data: dict) -> None:
    p.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                 encoding="utf-8")


def lineage_event(kind: str, schema_version: str, **fields) -> dict:
    ev = {
        "event_id": f"evt-{uuid.uuid4().hex[:12]}",
        "event": kind,
        "ts": utcnow(),
        "schema_version": schema_version,
    }
    ev.update(fields)
    return ev


def append_lineage(canon: Path, ev: dict) -> None:
    hist = canon / "history"
    hist.mkdir(exist_ok=True)
    with open(hist / "lineage.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")


def fail(msg: str) -> "SystemExit":
    return SystemExit(f"body_bind refused: {msg}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True)
    ap.add_argument("--body", required=True, help="body id to bind")
    ap.add_argument("--harness", required=True, help="harness type of the new body")
    ap.add_argument("--operator", required=True, help="who performs this binding")
    ap.add_argument("--reason", required=True, help="why this binding happens")
    ap.add_argument("--bcc-evidence", default=None,
                    help="reference to a prior BCC-1 PASS (test run, report path)")
    ap.add_argument("--verify-bcc", default=None, metavar="ADAPTER",
                    help="run mind/bcc_check.py against this adapter NOW and "
                         "require PASS (mutually exclusive with citing evidence)")
    ap.add_argument("--release-current", action="store_true",
                    help="record BODY_RELEASED for the currently bound body first")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    canon = Path(args.canonical)
    lin_path = canon / "lineage.yaml"
    cur_path = canon / "current.yaml"
    if not lin_path.exists() or not cur_path.exists():
        raise fail(f"canonical at {canon} lacks lineage.yaml/current.yaml")

    lin = load_yaml(lin_path)
    cur = load_yaml(cur_path)
    entity = (lin.get("entity_id") or (cur.get("identity") or {}).get("entity_id")
              or "REPLACE_ME")
    schema_version = str(cur.get("schema_version") or lin.get("schema_version") or "1.2")
    current_body = (lin.get("active_body") or {}).get("body_id")

    # --- preconditions: fail-closed, nothing written yet ---------------------
    if current_body == args.body:
        raise fail(f"{args.body} is already the bound body "
                   f"(epoch {lin.get('continuity_epoch')}) — a no-op bind would "
                   f"only pollute lineage")
    if current_body and not args.release_current:
        raise fail(f"body '{current_body}' is still bound; governance order is "
                   f"BODY_RELEASED 先行 — pass --release-current to record the "
                   f"release as an event before the bind")
    if not args.bcc_evidence and not args.verify_bcc:
        raise fail("BCC-1 PASS is a declared requirement — provide --verify-bcc "
                   "to run the bench now, or --bcc-evidence to cite a prior PASS")

    bcc_ref = args.bcc_evidence
    if args.verify_bcc:
        env = {**os.environ, "BCC_PLUGIN": str(Path(args.verify_bcc).resolve())}
        p = subprocess.run([sys.executable, str(HERE / "bcc_check.py"),
                            "--canonical", str(canon)],
                           capture_output=True, text=True, env=env)
        if p.returncode != 0:
            raise fail(f"BCC-1 bench did not PASS for {args.verify_bcc} — "
                       f"binding requires it; bench output tail: "
                       f"{(p.stdout or '').strip().splitlines()[-3:]}")
        bcc_ref = f"live bench run {utcnow()} (bcc_check PASS)"

    epoch_now = int(lin.get("continuity_epoch") or 0)
    epoch_next = epoch_now + 1
    events = []
    if current_body:
        events.append(lineage_event(
            "BODY_RELEASED", schema_version, entity_id=entity,
            body_id=current_body,
            harness_type=(lin.get("active_body") or {}).get("harness_type"),
            operator=args.operator, reason=args.reason,
            note="release precedes bind (body_binding: BODY_RELEASED 先行)"))
    bind_ev = lineage_event(
        "BODY_BOUND", schema_version, entity_id=entity,
        body_id=args.body, harness_type=args.harness, bcc_version="BCC-1",
        continuity_epoch=epoch_next, operator=args.operator, reason=args.reason,
        bcc_evidence=bcc_ref)
    events.append(bind_ev)

    new_active = {
        "body_id": args.body,
        "harness_type": args.harness,
        "bcc_version": "BCC-1",
        "bound_at": bind_ev["ts"],
        "lease": (lin.get("active_body") or {}).get("lease")
                 or "exclusive-canonical-writer",
    }

    if args.dry_run:
        print(json.dumps({
            "dry_run": True, "entity_id": entity,
            "release": current_body, "bind": args.body,
            "continuity_epoch": f"{epoch_now} -> {epoch_next}",
            "events": events, "active_body_after": new_active,
            "would_backup_to": f"history/pre-bind-<ts>/",
        }, ensure_ascii=False, indent=2))
        return 0

    # --- apply ---------------------------------------------------------------
    backup = canon / "history" / f"pre-bind-{datetime.now():%Y%m%d-%H%M%S}"
    backup.mkdir(parents=True, exist_ok=True)
    shutil.copy2(lin_path, backup / "lineage.yaml")
    shutil.copy2(cur_path, backup / "current.yaml")

    for ev in events:
        append_lineage(canon, ev)

    transitions = lin.get("major_transitions")
    if not isinstance(transitions, list):
        transitions = []
    transitions.extend({"event": ev["event_id"], "kind": ev["event"]} for ev in events)
    lin["major_transitions"] = transitions
    lin["active_body"] = new_active
    lin["continuity_epoch"] = epoch_next
    lin["lineage_head"] = bind_ev["event_id"]
    dump_yaml(lin_path, lin)

    identity = cur.get("identity")
    if not isinstance(identity, dict):
        identity = {}
    identity["lineage_head"] = bind_ev["event_id"]
    cur["identity"] = identity
    dump_yaml(cur_path, cur)

    # The projections (briefing / instruction) are derivations: recompile so a
    # stale projection never silently disagrees with the new binding. A failed
    # recompile is reported, not fatal — the binding itself is already recorded.
    compiles = {}
    for name, argv in {
        "canonical_compile": ["canonical_compile.py", "--canonical", str(canon)],
        "instruction_compile": ["instruction_compile.py", "--canonical", str(canon)],
    }.items():
        p = subprocess.run([sys.executable, str(HERE / argv[0]), *argv[1:]],
                           capture_output=True, text=True)
        compiles[name] = {"ok": p.returncode == 0,
                          "stderr_tail": (p.stderr or "").strip().splitlines()[-3:]
                          if p.returncode else []}

    print(json.dumps({
        "applied": True, "entity_id": entity,
        "released": current_body, "bound": args.body,
        "continuity_epoch": epoch_next,
        "events": [ev["event_id"] for ev in events],
        "bcc_evidence": bcc_ref,
        "backup": str(backup),
        "recompiled": compiles,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
