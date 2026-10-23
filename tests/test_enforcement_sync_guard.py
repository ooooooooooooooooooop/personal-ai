"""Tests for scripts/governance/enforcement_sync_guard.py.

The guard exists because the gate prices a frozen index snapshot while the
hooks execute code from the working tree. These tests are the sensor for that
rule: they prove a real divergence is caught, and — just as important — that a
dirty file outside the enforcement chain is NOT caught, so the guard cannot
quietly turn into a "commit nothing while anything is dirty" gate.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "governance"))

import enforcement_sync_guard as guard  # noqa: E402


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {proc.stderr}")
    return proc.stdout


class GuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "guard@example.com")
        git(self.repo, "config", "user.name", "guard")
        for rel in (
            "scripts/personal_ai_sync.py",
            "scripts/governance/canonical_writer.py",
            "scripts/governance/project_state_gov.py",
            ".githooks/pre-commit",
            "docs/readme.md",
        ):
            path = self.repo / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("placeholder\n", encoding="utf-8")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "init")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, rel: str, text: str = "changed\n") -> None:
        (self.repo / rel).write_text(text, encoding="utf-8")

    def test_clean_tree_passes_both_baselines(self) -> None:
        self.assertEqual(guard.divergent_paths(self.repo, "index"), [])
        self.assertEqual(guard.divergent_paths(self.repo, "head"), [])

    def test_unstaged_enforcer_edit_blocks_index_baseline(self) -> None:
        """The 2026-10-22 incident: enforcement code edited but never staged."""
        self._write("scripts/personal_ai_sync.py")
        self.assertEqual(
            guard.divergent_paths(self.repo, "index"),
            ["scripts/personal_ai_sync.py"],
        )

    def test_staged_enforcer_edit_is_the_code_under_test(self) -> None:
        """A staged edit IS the frozen candidate — refusing it would deadlock
        every legitimate commit that repairs the gate."""
        self._write("scripts/governance/canonical_writer.py")
        git(self.repo, "add", "scripts/governance/canonical_writer.py")
        self.assertEqual(guard.divergent_paths(self.repo, "index"), [])

    def test_staged_enforcer_edit_still_diverges_from_head(self) -> None:
        """For pre-push/post-commit the baseline is HEAD, so staged-but-not-
        committed enforcement code is still untested against that history."""
        self._write("scripts/governance/canonical_writer.py")
        git(self.repo, "add", "scripts/governance/canonical_writer.py")
        self.assertEqual(
            guard.divergent_paths(self.repo, "head"),
            ["scripts/governance/canonical_writer.py"],
        )

    def test_untracked_enforcer_module_blocks(self) -> None:
        """A brand-new enforcer file nobody staged still executes from disk."""
        new_hook = self.repo / ".githooks" / "pre-push"
        new_hook.write_text("#!/bin/sh\n", encoding="utf-8")
        self.assertIn(
            ".githooks/pre-push", guard.divergent_paths(self.repo, "index")
        )

    def test_dirty_non_enforcement_path_is_ignored(self) -> None:
        """Zero-impact cull: a governance module that never runs during
        enforcement must not block commits (the workspace routinely carries
        unrelated edits there)."""
        self._write("scripts/governance/project_state_gov.py")
        self._write("docs/readme.md")
        self.assertEqual(guard.divergent_paths(self.repo, "index"), [])
        self.assertEqual(guard.divergent_paths(self.repo, "head"), [])

    def test_main_reports_violation_with_nonzero_exit(self) -> None:
        self._write("scripts/personal_ai_sync.py")
        self.assertEqual(guard.main(["--repo", str(self.repo)]), 1)
        git(self.repo, "add", "scripts/personal_ai_sync.py")
        self.assertEqual(guard.main(["--repo", str(self.repo)]), 0)

    def test_enforcement_paths_cover_the_hook_chain(self) -> None:
        """Pin the chain: .githooks -> canonical_writer -> personal_ai_sync.

        If a hook starts invoking another module, this assertion is the place
        that should go red rather than a production push.
        """
        for path in (
            ".githooks/",
            "scripts/personal_ai_sync.py",
            "scripts/governance/canonical_writer.py",
        ):
            self.assertIn(path, guard.ENFORCEMENT_PATHS)
        writer = (ROOT / "scripts" / "governance" / "canonical_writer.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("import personal_ai_sync", writer)

    def test_hooks_probe_pyyaml_not_just_startup(self) -> None:
        """`-c ''` proves the interpreter starts, not that it can run the gate."""
        probe = (ROOT / ".githooks" / "_python.sh").read_text(encoding="utf-8")
        self.assertIn("import yaml", probe)
        for name in ("pre-commit", "pre-push", "post-commit"):
            hook = (ROOT / ".githooks" / name).read_text(encoding="utf-8")
            self.assertIn("_python.sh", hook, name)
            self.assertNotIn('"$PY" -c \'\'', hook, name)


if __name__ == "__main__":
    unittest.main()
