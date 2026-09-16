#!/usr/bin/env python3
"""u1_accept.py — U1 governance apply path (V0.3.1).

MODEL_PROPOSAL / promoted HYPOTHESIS -> U1 decision -> canonical current.yaml.
STATUS_UPDATE -> U1 decision -> whitelisted fields on open-loops.yaml entries
  (status bookkeeping goes through the same governed path, not hand edits).

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

U1_VERSION = "U1-1.1"

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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True)
    ap.add_argument("--proposal", required=True,
                    help="proposal file inside canonical/proposals/")
    ap.add_argument("--decision", required=True,
                    choices=["accept", "provisional", "reject"])
    ap.add_argument("--reason", default="")
    ap.add_argument("--authority", default="u1-review",
                    help="accepting authority ref (must exist pre-change)")
    args = ap.parse_args()

    canon = Path(args.canonical)
    pfile = canon / "proposals" / args.proposal
    prop = json.loads(pfile.read_text(encoding="utf-8"))
    kind = prop.get("kind")
    if kind not in ("MODEL_PROPOSAL", "STATUS_UPDATE"):
        raise SystemExit(f"U1 apply supports MODEL_PROPOSAL/STATUS_UPDATE, "
                         f"got {kind}")

    if args.decision == "reject":
        prop["status"] = "rejected"
        prop["decision"] = {"decision": "reject", "reason": args.reason,
                            "authority": args.authority, "ts": utcnow()}
        pfile.write_text(json.dumps(prop, ensure_ascii=False, indent=2),
                         encoding="utf-8")
        print(json.dumps({"decision": "reject", "canonical_write": "NONE"}))
        return 0

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
    status = "provisional" if args.decision in ("accept", "provisional") else "?"
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
