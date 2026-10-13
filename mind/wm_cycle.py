#!/usr/bin/env python3
"""wm_cycle.py — run the world-model cycle up to the governance boundary.

The chain is:

  ledger/runs ──lp_evaluator──> learning metrics
              ──distiller────> proposals/          (MODEL_PROPOSAL — never current.yaml)
  canonical   ──canonical_compile──> briefing.md        ─> ContextEnvelope
              ──instruction_compile────> instruction/generated.md ─> InstructionEnvelope
  proposals/  ──u1_accept──────> canonical             <-- STOP HERE

Everything before `u1_accept` is DERIVATION or PROPOSAL: it reads the record and
writes derived artifacts, and it is safe to run unattended. `u1_accept` writes
the canonical, which governance.yaml reserves (`canonical_write: u1_governed`) —
that is a governance act, not a computation, and this script does not take it.
A cycle that accepted its own proposals would be a self-granting authority,
which revision_rules forbids.

So "automating the distillation chain" means automating THIS — the part up to the
proposal — and leaving acceptance where it belongs. Running it by hand step by
step was never a design; it was the absence of this entry point.

TRIGGER - when this runs. The signal is REPETITION, not a single event and not a clock.

  A single refutation is noise. theory/sources/02_解释贝叶斯更新:
  "一次失败可能只是噪声" - and the world model stores only what is 稳定 (not a
  one-off) and 可迁移 (not one event). What licenses MODEL FAILURE is a 残差结构:
  the same kind of failure recurring, so `reality - prediction` shows a PATTERN
  rather than scatter. "2026年9月9日某人说了一句话" is explicitly not world-model
  material.

  So the adapter counts refutations per KIND and asks for a re-examination when
  one kind recurs. It asks for a LOOK, not a revision: whether a structure
  actually exists is distiller.py's judgement - it groups by signature and
  checks independence - so a run with nothing structural in it will correctly
  produce nothing.

  THE COUNT IS DECLARED, NOT DEFAULTED. How many recurrences make a structure
  visible is a domain judgement, and the pilot owns it (adapter-pilot-evaluation
  -rubric §四 B-P1: do not invent pseudo-precise numbers; §五: decision rules
  must be PRE-REGISTERED; §七: undeclared = UNMEASURED). The runtime reads:

    <canonicalDir>/learning-trigger.json
      { "refutation_threshold": <positive integer>, "declared_by": "...", "reason": "..." }

  A canonical change goes through the pilot's U1 governance path, so the pilot
  writes it, never the runtime. Absent the declaration the adapter does NOT fire
  and reports the gap - an invented default would be a decision the pilot owns.

  Both simpler triggers are wrong:
    - "a refutation"  -> fires on noise (a single failure is not evidence of a
                         structure; that is 过度抽象, the theory's failure mode)
    - "the clock"     -> fires on nothing in particular, and misses the point
                         that what matters is recurrence, not elapsed time

  The event already exists: the adapter writes PREDICTION_EVALUATED to the
  ledger every turn, and now also asks the body to schedule this cycle on
  recurrence. A periodic sweep remains a FALLBACK, not the mechanism.


Usage:
  python mind/wm_cycle.py --instance <instanceRoot> [--canonical <canonicalDir>]
                          [--abstractor none|llm|...]
                          [--closed-minutes 30] [--dry-run]

  <instanceRoot> must contain canonical/ UNLESS --canonical is given. Pass the
  RESOLVED canonical explicitly whenever the instance mounts one
  (PAI_CANONICAL_DIR / WORLD_MODEL_HOME): the default <instanceRoot>/canonical
  is only the fallback, and on a mounted instance it is a DIFFERENT, stale
  directory — compiling it would produce a briefing nobody reads and proposals
  in the wrong place, silently.

  The state dir defaults to <instance>/world-model (pi layout; DSH keeps its
  own under ~/.dsh/world-model — pass --state to point at it explicitly).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(step: str, argv: list[str], dry: bool) -> dict:
    """Run one chain step. A failing step is reported, never fatal — the cycle is
    a sequence of independent derivations, and one broken input must not hide the
    fact that the others could still run."""
    if dry:
        return {"step": step, "dry_run": True, "argv": argv}
    p = subprocess.run([sys.executable, str(HERE / argv[0]), *argv[1:]],
                       capture_output=True, text=True)
    return {
        "step": step,
        "ok": p.returncode == 0,
        "returncode": p.returncode,
        "stdout_tail": (p.stdout or "").strip().splitlines()[-6:],
        "stderr_tail": (p.stderr or "").strip().splitlines()[-4:] if p.returncode else [],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True, help="instance root (holds the state dir)")
    ap.add_argument("--canonical", default=None,
                    help="canonical dir; default <instance>/canonical. Pass the RESOLVED "
                         "canonical when the instance mounts one (WORLD_MODEL_HOME etc.) — "
                         "the fallback under the instance root can be a different, stale dir.")
    ap.add_argument("--state", default=None,
                    help="world-model state dir; default <instance>/world-model")
    ap.add_argument("--abstractor", default="none",
                    help="passed to distiller.py: none→ABSTAIN (default), llm, file, template")
    ap.add_argument("--closed-minutes", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.instance)
    canon = Path(args.canonical) if args.canonical else root / "canonical"
    if not canon.exists():
        raise SystemExit(f"no canonical at {canon}")
    state = Path(args.state) if args.state else root / "world-model"
    out = root / "learning"
    if not args.dry_run:
        out.mkdir(parents=True, exist_ok=True)

    steps = []
    # 1. Learning metrics from the closed record (read-mostly; writes <out>/).
    if state.exists():
        steps.append(run("lp_evaluator", [
            "lp_evaluator.py", "--state", str(state), "--out", str(out),
            "--closed-minutes", str(args.closed_minutes), "--canonical", str(canon),
        ], args.dry_run))
    else:
        steps.append({"step": "lp_evaluator", "ok": True, "skipped":
                      f"no state dir at {state} — the adapter has not run here yet"})

    # 2. Distillation → proposals/ ONLY. Never canonical.
    steps.append(run("distiller", [
        "distiller.py", "--state", str(state), "--canonical", str(canon),
        "--closed-minutes", str(args.closed_minutes), "--abstractor", args.abstractor,
    ], args.dry_run))

    # 3. Compile the canonical into the two artifacts the model reads.
    steps.append(run("canonical_compile", ["canonical_compile.py", "--canonical", str(canon)], args.dry_run))
    steps.append(run("instruction_compile", ["instruction_compile.py", "--canonical", str(canon)], args.dry_run))

    report = {
        "cycle": "up to the governance boundary",
        "instance": str(root),
        "canonical": str(canon),
        "state": str(state),
        "steps": steps,
        "stopped_before": {
            "step": "u1_accept",
            "why": "it writes the canonical (canonical_write: u1_governed) — a governance act, "
                   "not a computation. Review proposals/ and decide.",
        },
        "next": f"python mind/u1_accept.py --canonical {canon} --proposal <proposals/...> --decision accept --reason ...",
    }
    if args.abstractor == "none":
        report["note"] = ("abstractor=none → distiller ABSTAINS. That is a real result, not a "
                          "failure: without an abstractor it will not invent models. Pass "
                          "--abstractor llm (or file) to enable proposal generation.")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
