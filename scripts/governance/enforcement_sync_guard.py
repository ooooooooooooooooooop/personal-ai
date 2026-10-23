#!/usr/bin/env python3
"""Fail-closed guard: the code enforcing the gate must be the code under test.

`.githooks/*` always runs from the working tree, but `pre-commit` prices its
checks against a frozen snapshot of the index. An uncommitted edit to the
enforcement chain therefore runs untested code, and nothing goes red: the
2026-10-22 incident shipped a narrowed gate the green 666-test run had never
seen, and it only surfaced as a push rejection 35 minutes later.

规则：治理者不得未宣称即执法 —— 改了执法代码就必须暂存它、测它、提交它，
不能带着半生不熟的工作区逻辑去裁决别人的提交。

Each hook prices a different baseline, so the comparison differs:

  --baseline index   pre-commit        baseline is the index; a staged edit IS
                                       the code under test, so only unstaged
                                       and untracked divergence counts.
  --baseline head    pre-push /        baseline is HEAD; anything not yet
                     post-commit       committed (staged or not) is divergence.

Untracked files under a monitored path count as divergence: a brand-new
enforcer module nobody staged still executes from disk.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

# Only files actually executed while a gate runs: `.githooks/*` invokes
# scripts/governance/canonical_writer.py, which imports scripts/personal_ai_sync.py.
# Nothing else on disk runs during enforcement, so nothing else is listed —
# monitoring a file that never executes would block commits for no safety gain
# (the zero-impact cull rule, applied to this guard itself).
ENFORCEMENT_PATHS: tuple[str, ...] = (
    ".githooks/",
    "scripts/personal_ai_sync.py",
    "scripts/governance/canonical_writer.py",
    "scripts/governance/enforcement_sync_guard.py",
)


def _git(repo: Path, *args: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode, proc.stdout


def divergent_paths(repo: Path, baseline: str) -> list[str] | None:
    """Enforcement files that differ from `baseline` (None = cannot inspect)."""
    paths: set[str] = set()
    if baseline == "head":
        rc, out = _git(repo, "diff", "--name-only", "HEAD", "--", *ENFORCEMENT_PATHS)
    else:
        rc, out = _git(repo, "diff", "--name-only", "--", *ENFORCEMENT_PATHS)
    if rc != 0:
        return None
    paths.update(line.strip() for line in out.splitlines() if line.strip())

    rc, out = _git(
        repo, "ls-files", "--others", "--exclude-standard", "--", *ENFORCEMENT_PATHS
    )
    if rc != 0:
        return None
    paths.update(line.strip() for line in out.splitlines() if line.strip())
    return sorted(paths)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".")
    parser.add_argument("--baseline", choices=("index", "head"), default="index")
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve()
    paths = divergent_paths(repo, args.baseline)
    if paths is None:
        print(
            "ENFORCEMENT_SYNC_UNINSPECTABLE: git could not report the "
            "enforcement chain; refusing to run the gate on unknown state",
            file=sys.stderr,
        )
        return 2
    if not paths:
        return 0

    print(
        "ENFORCEMENT_SYNC_VIOLATION: the gate would execute enforcer code that "
        f"differs from {args.baseline}",
        file=sys.stderr,
    )
    for path in paths:
        print(f"  divergent: {path}", file=sys.stderr)
    if args.baseline == "index":
        print(
            "Fix: `git add` these paths so the frozen candidate tree contains "
            "the code that will actually run, then retry the commit.",
            file=sys.stderr,
        )
    else:
        print(
            "Fix: commit (or stash) these paths so the enforcer matches HEAD, "
            "then retry.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
