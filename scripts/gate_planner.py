#!/usr/bin/env python3
"""Delta-gate planner for .githooks/pre-commit.

The pre-commit hook used to run the full release gate on every commit:
~8-25 min dominated by unittest discovery (~7.5 min) and one python spawn
per .py file (~2753 spawns). The validators themselves are already cheap
(validate_repo --strict ~1.7s, quality_report all-skills ~0.1s), so the
only things worth scoping are compilation and unittest selection.

Model: the base commit is release-certified, so a new commit is certified
iff everything its diff could affect passes. The planner maps staged paths
to the checks that can observe them, fail-closed: anything unrecognized
escalates to FULL rather than skipping.

Usage (in the hook):
    python scripts/gate_planner.py --staged        # prints JSON plan
    python scripts/gate_planner.py --staged --field unittest   # one list

JSON shape:
    {
      "mode": "DELTA" | "FULL",
      "reasons": [...],            # why FULL (audit trail)
      "compile": [...] | "ALL",    # .py files to syntax-check
      "unittest": [...] | "ALL",   # tests/test_*.py to run
      "mcp_suites": [...]          # mcp/<name>/tests dirs to discover
    }
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

# Paths whose change invalidates the incremental argument itself: the gate
# machinery, shared registries, CI config, and runtime scaffolding. Any hit
# forces FULL so the gate can never talk itself out of checking itself.
FULL_TRIGGERS = (
    ".githooks/",
    ".github/workflows/",
    "scripts/gate_planner.py",
    "scripts/validate_repo.py",
    "scripts/personal_ai_sync.py",
    "scripts/governance/",
    "scripts/publish_check.py",
    "scripts/run_skill_evals.py",
    "scripts/sync_skills.py",
    "skills/skill-quality-gate/",
    "skills.json",
    "mcp.json",
    "pyproject.toml",
    "package.json",
    "package-lock.json",
)

FULL_TRIGGER_GLOBS = ("requirements",)

# Top-level dirs the repo unittests can observe. Docs, soul manifests, and
# JS layers are covered by validate_repo/npm instead — no unittest impact.
UNITS_BY_PREFIX = {
    "dsh/": [
        "tests/test_dsh_compatibility.py",
        "tests/test_dsh_lifecycle.py",
        "tests/test_dsh_runtime.py",
        "tests/test_dsh_source_state.py",
    ],
}

# scripts/ entries that are ordinary tooling (not gate machinery): a change
# still gets syntax-checked but only needs its own unittest coverage.
KNOWN_PLAIN_PREFIXES = (
    "skills/",
    "mcp/",
    "host/",
    "pi/",
    "dsh/",
    "app/",
    "soul/",
    "docs/",
    "tests/",
    "scripts/",
    "_template/",
)


def _staged_files(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--name-only",
         "--diff-filter=ACMR"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def plan(files: list[str]) -> dict:
    reasons: list[str] = []
    compile_set: set[str] = set()
    unittest_set: set[str] = set()
    mcp_suites: set[str] = set()

    for path in files:
        path = path.replace("\\", "/")
        if any(path.startswith(t) for t in FULL_TRIGGERS) or any(
            path.startswith(g) for g in FULL_TRIGGER_GLOBS
        ):
            reasons.append(path)
            continue
        if not any(path.startswith(p) for p in KNOWN_PLAIN_PREFIXES):
            reasons.append(f"unknown:{path}")
            continue
        # Compile list is a pure function of paths — existence filtering
        # happens at execution time (a staged file may have been deleted
        # from the worktree since `git add`).
        if path.endswith(".py"):
            compile_set.add(path)
        for prefix, tests in UNITS_BY_PREFIX.items():
            if path.startswith(prefix):
                unittest_set.update(tests)
        if path.startswith("tests/") and path.endswith(".py"):
            unittest_set.add(path)
        # MCP suites: only agent-switchboard's tests are unittest-compatible
        # (the bridge suite is pytest-style and needs its own venv — it is
        # run separately, never by this hook).
        if path.startswith("mcp/agent-switchboard/"):
            mcp_suites.add("mcp/agent-switchboard/tests")

    if reasons:
        return {
            "mode": "FULL",
            "reasons": sorted(reasons),
            "compile": "ALL",
            "unittest": "ALL",
            "mcp_suites": sorted(mcp_suites),
        }
    return {
        "mode": "DELTA",
        "reasons": [],
        "compile": sorted(compile_set),
        "unittest": sorted(unittest_set),
        "mcp_suites": sorted(mcp_suites),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--staged", action="store_true",
                    help="read the file list from the git index")
    ap.add_argument("--files", nargs="*", default=None,
                    help="explicit file list (for dry runs)")
    ap.add_argument("--field",
                    choices=("mode", "compile", "unittest", "mcp_suites"),
                    help="print just that value (mode) or list, one per line")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parent.parent
    files = (
        _staged_files(repo)
        if args.staged
        else (args.files if args.files is not None else [])
    )
    result = plan(files)
    if args.field:
        value = result[args.field]
        if isinstance(value, str):
            print(value)
            return 0
        for item in ([] if value == "ALL" else value):
            print(item)
        if value == "ALL":
            print("ALL")
        return 0
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
