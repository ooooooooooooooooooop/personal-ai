#!/usr/bin/env python3
"""reversibility_compile.py — compile learned models into a gate-readable overlay.

WHY THIS EXISTS (finding G11): the gate's danger classification is a hardcoded
dictionary in host/src/core/irreversible.js. Models learned in the canonical DO
reach the agent (the briefing's section 3 is compiled from world_model.models),
but the gate never reads them — so a refutation like "I thought `foo` was safe
and it destroyed X" can produce a model proposal, reach the briefing, reach the
agent, and STILL leave the gate unchanged. The prior could only be relaxed by
editing code. This compiler closes that gap.

WHAT IT EMITS: <canonicalDir>/reversibility.json

    { "schema_version": 1,
      "abstractor": "none" | "file",
      "canonical_watermark": "<the canonical's watermark at compile time>",
      "relaxations": [
        { "model_id": "M-…", "match": { "tool": "bash", "command_head": "ls" },
          "class": "reversible",
          "scope_conditions": ["headless DSH session"], "evidence_refs": ["…"] } ] }

SAFETY BOUNDARIES (each one is load-bearing; without any of them the overlay is
a backdoor around the gate rather than the benefit of learning):

  * Only RELAXATIONS are representable. `class` must be "reversible"; a
    tightening is the built-in prior's job, not this file's. There is no
    "default: reversible" switch — the prior cannot be disabled wholesale.
  * A relaxation MUST cite evidence_refs. Unevidenced relaxation is rejected.
  * A relaxation MUST carry scope_conditions. Global relaxation is rejected.
  * model_id must name a model that actually exists in the canonical — the
    overlay is derived from models, not asserted independently of them.
  * The watermark is stamped. If the canonical drifts afterwards the overlay is
    STALE and the runtime ignores it wholesale (fail-closed) — the prior stands.

NOT AUTOMATIC. `--abstractor none` (the default) ABSTAINS: no abstractor, no
relaxations. Same convention as distiller.py, and the same reason — theory v0.5
§五 rule 4: 人是生成回路的一部分，协议不设计成全自动.

Usage:
  python mind/reversibility_compile.py --canonical <dir>                      # abstain
  python mind/reversibility_compile.py --canonical <dir> \
      --abstractor file --proposals <relaxations.json>                        # operator/LLM supplied
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    raise SystemExit("PyYAML required")

ALLOWED_CLASSES = {"reversible"}


def load_yaml(p: Path) -> dict:
    if not p.exists():
        return {}
    d = yaml.safe_load(p.read_text(encoding="utf-8"))
    return d if isinstance(d, dict) else {}


def canonical_models(canonical: Path) -> dict:
    cur = load_yaml(canonical / "current.yaml")
    return ((cur.get("world_model") or {}).get("models") or {})


def watermark(canonical: Path) -> str | None:
    cur = load_yaml(canonical / "current.yaml")
    return cur.get("watermark")


def validate(relaxations: list, model_ids: set) -> tuple[list, list]:
    """Returns (accepted, rejected). Rejection is the point, not a side effect."""
    ok, bad = [], []
    for i, r in enumerate(relaxations):
        if not isinstance(r, dict):
            bad.append({"index": i, "why": "not an object"})
            continue
        mid = r.get("model_id")
        if not mid or mid not in model_ids:
            bad.append({"index": i, "why": f"model_id {mid!r} does not name a model in the canonical"})
            continue
        cls = r.get("class")
        if cls not in ALLOWED_CLASSES:
            bad.append({"index": i, "why": f"class {cls!r} not allowed — the overlay may only RELAX "
                                           f"(allowed: {sorted(ALLOWED_CLASSES)})"})
            continue
        match = r.get("match")
        if not isinstance(match, dict) or not match.get("tool"):
            bad.append({"index": i, "why": "match.tool is required"})
            continue
        sc = r.get("scope_conditions")
        if not isinstance(sc, list) or not sc:
            bad.append({"index": i, "why": "scope_conditions is required and must be non-empty — "
                                           "global relaxation is not accepted"})
            continue
        ev = r.get("evidence_refs")
        if not isinstance(ev, list) or not ev:
            bad.append({"index": i, "why": "evidence_refs is required and must be non-empty — "
                                           "unevidenced relaxation is not accepted"})
            continue
        ok.append({"model_id": mid, "match": match, "class": cls,
                   "scope_conditions": sc, "evidence_refs": ev})
    return ok, bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True)
    ap.add_argument("--abstractor", default="none", choices=["none", "file"])
    ap.add_argument("--proposals", default=None,
                    help="file mode: JSON list of proposed relaxations")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    canonical = Path(args.canonical)
    if not canonical.exists():
        raise SystemExit(f"no canonical at {canonical}")
    models = canonical_models(canonical)
    if not models:
        # Not fatal: an instance with no models simply has nothing to learn from.
        print(json.dumps({"emitted": False, "why": "canonical has no world_model.models"},
                         ensure_ascii=False), file=sys.stderr)

    proposals = []
    if args.abstractor == "none":
        note = ("abstractor=none → ABSTAIN. No relaxations are produced. That is a real result, "
                "not a failure: without an abstractor this will not invent rules. Pass "
                "--abstractor file --proposals <path> to supply operator/LLM-proposed relaxations.")
    else:
        note = "operator/LLM supplied via --proposals"
        if not args.proposals:
            raise SystemExit("--abstractor file requires --proposals <path>")
        raw = json.loads(Path(args.proposals).read_text(encoding="utf-8"))
        proposals = raw.get("relaxations") if isinstance(raw, dict) else raw
        if not isinstance(proposals, list):
            raise SystemExit("--proposals must be a JSON list, or {\"relaxations\": [...]}")

    accepted, rejected = validate(proposals, set(models.keys()))
    if rejected:
        # Refuse to emit a partial overlay silently: a dropped relaxation would
        # look like "the model didn't support it" instead of "the proposal was bad".
        print(json.dumps({"error": "REJECTED", "rejected": rejected}, ensure_ascii=False, indent=2),
              file=sys.stderr)
        return 2

    out = {
        "schema_version": 1,
        "compiled_from": "world_model.models",
        "abstractor": args.abstractor,
        "note": note,
        "canonical_watermark": watermark(canonical),
        "relaxations": accepted,
    }
    path = canonical / "reversibility.json"
    if not args.dry_run:
        path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": str(path), "dry_run": args.dry_run,
                      "relaxations": len(accepted), "models_seen": len(models),
                      "abstractor": args.abstractor}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
