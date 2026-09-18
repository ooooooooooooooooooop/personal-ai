"""Tests for scripts/gate_planner.py — the delta-gate impact mapper."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import gate_planner  # noqa: E402


class TestGatePlanner(unittest.TestCase):
    def test_doc_only_change_is_delta(self):
        p = gate_planner.plan(["docs/foo.md"])
        self.assertEqual(p["mode"], "DELTA")
        self.assertEqual(p["compile"], [])
        self.assertEqual(p["unittest"], [])
        self.assertEqual(p["mcp_suites"], [])

    def test_research_doc_change_is_delta(self):
        p = gate_planner.plan(
            ["research/agent-harness-survey-v1/FEATURE_AUDIT.md"]
        )
        self.assertEqual(p["mode"], "DELTA")
        self.assertEqual(p["compile"], [])
        self.assertEqual(p["unittest"], [])

    def test_skill_change_scopes_to_nothing_but_compile(self):
        p = gate_planner.plan(["skills/minimal-implementation/SKILL.md"])
        self.assertEqual(p["mode"], "DELTA")
        self.assertEqual(p["unittest"], [])

    def test_gate_machinery_forces_full(self):
        for path in (
            ".githooks/pre-commit",
            "scripts/validate_repo.py",
            "scripts/personal_ai_sync.py",
            "scripts/governance/canonical_writer.py",
            "scripts/gate_planner.py",
            "skills/skill-quality-gate/scripts/quality_report.py",
            "skills.json",
            "mcp.json",
            "pyproject.toml",
        ):
            with self.subTest(path=path):
                self.assertEqual(gate_planner.plan([path])["mode"], "FULL")

    def test_unknown_path_fails_closed_to_full(self):
        p = gate_planner.plan(["some/random/newdir/file.txt"])
        self.assertEqual(p["mode"], "FULL")
        self.assertIn("unknown:some/random/newdir/file.txt", p["reasons"])

    def test_changed_py_is_compiled(self):
        p = gate_planner.plan(["scripts/m5_cordis_scan.py"])
        self.assertEqual(p["mode"], "DELTA")
        self.assertIn("scripts/m5_cordis_scan.py", p["compile"])

    def test_backslash_paths_normalized(self):
        p = gate_planner.plan(["scripts\\m5_cordis_scan.py"])
        self.assertEqual(p["mode"], "DELTA")
        self.assertIn("scripts/m5_cordis_scan.py", p["compile"])

    def test_dsh_change_runs_dsh_unittests(self):
        p = gate_planner.plan(["dsh/adapter/foo.js"])
        self.assertEqual(p["mode"], "DELTA")
        self.assertIn("tests/test_dsh_runtime.py", p["unittest"])

    def test_testfile_change_runs_itself(self):
        p = gate_planner.plan(["tests/test_governance.py"])
        self.assertEqual(p["unittest"], ["tests/test_governance.py"])

    def test_mcp_change_maps_its_suite(self):
        p = gate_planner.plan(["mcp/agent-switchboard/src/x.py"])
        self.assertIn("mcp/agent-switchboard/tests", p["mcp_suites"])
        self.assertIn("mcp/agent-switchboard/src/x.py", p["compile"])
        # pytest-style suites (the bridge) are never handed to unittest.
        p2 = gate_planner.plan(["mcp/chatgpt-web-bridge/src/x.py"])
        self.assertEqual(p2["mcp_suites"], [])

    def test_scripts_change_runs_importing_tests(self):
        # tests/test_personal_ai_sync.py imports personal_ai_sync
        p = gate_planner.plan(["scripts/personal_ai_sync.py"])
        self.assertEqual(p["mode"], "FULL")  # gate machinery → FULL anyway

    def test_plain_script_maps_via_imports(self):
        # A non-gate script covered by tests must select them via import scan.
        p = gate_planner.plan(["scripts/trace_identity.py"])
        self.assertEqual(p["mode"], "DELTA")
        self.assertIn("tests/test_trace_identity.py", p["unittest"])

    def test_mixed_change_unions(self):
        p = gate_planner.plan(
            ["docs/a.md", "dsh/x.js", "tests/test_repository.py"]
        )
        self.assertEqual(p["mode"], "DELTA")
        self.assertIn("tests/test_dsh_runtime.py", p["unittest"])
        self.assertIn("tests/test_repository.py", p["unittest"])

    def test_full_when_any_trigger_present(self):
        p = gate_planner.plan(["docs/a.md", "skills.json"])
        self.assertEqual(p["mode"], "FULL")
        self.assertEqual(p["compile"], "ALL")
        self.assertEqual(p["unittest"], "ALL")


if __name__ == "__main__":
    unittest.main()
