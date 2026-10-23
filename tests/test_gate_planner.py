"""Tests for scripts/gate_planner.py — snapshot-edition delta gate."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import gate_planner


def ch(status, path, old=None):
    return gate_planner.Change(status, path, old)


class Fixture:
    """Minimal source tree for graph-dependent tests."""

    def __init__(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.files = set()

    def add(self, path: str, content: str = ""):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        self.files.add(path)
        return self

    def plan(self, changes, **kw):
        return gate_planner.plan(changes, self.files, self.root, **kw)

    def cleanup(self):
        self.dir.cleanup()


class TestChangeParsing(unittest.TestCase):
    def test_name_status_basic(self):
        z = "M\0docs/a.md\0A\0scripts/x.py\0D\0tests/test_gone.py\0"
        out = gate_planner.parse_name_status(z)
        self.assertEqual(
            [(c.status, c.path, c.old_path) for c in out],
            [("M", "docs/a.md", None),
             ("A", "scripts/x.py", None),
             ("D", "tests/test_gone.py", None)],
        )

    def test_name_status_rename_split(self):
        z = "R100\0old/name.py\0new/name.py\0"
        out = gate_planner.parse_name_status(z)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].status, "R")
        self.assertEqual(out[0].old_path, "old/name.py")
        self.assertEqual(out[0].path, "new/name.py")

    def test_name_status_malformed_token(self):
        out = gate_planner.parse_name_status("no-tab-token\0")
        self.assertEqual(out[0].status, "?")


class TestPlanClassification(unittest.TestCase):
    def test_doc_only_change_is_delta(self):
        fx = Fixture()
        try:
            fx.add("docs/foo.md")
            p = fx.plan([ch("M", "docs/foo.md")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertEqual(p["compile"], [])
            self.assertEqual(p["unittest"], [])
            self.assertEqual(p["mcp_suites"], [])
        finally:
            fx.cleanup()

    def test_research_doc_change_is_delta(self):
        fx = Fixture()
        try:
            fx.add("research/x/FEATURE_AUDIT.md")
            p = fx.plan([ch("M", "research/x/FEATURE_AUDIT.md")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertEqual(p["compile"], [])
        finally:
            fx.cleanup()

    def test_gate_machinery_forces_full(self):
        fx = Fixture()
        try:
            fx.add("scripts/gate_planner.py")
            fx.add("scripts/x.py")
            p = fx.plan([ch("M", "scripts/gate_planner.py"),
                         ch("M", "scripts/x.py")])
            self.assertEqual(p["mode"], "FULL")
            self.assertIn("scripts/gate_planner.py", p["reasons"])
            self.assertIn("scripts/x.py", p["compile"])  # universe
        finally:
            fx.cleanup()

    def test_hook_file_forces_full(self):
        fx = Fixture()
        try:
            p = fx.plan([ch("M", ".githooks/pre-commit")])
            self.assertEqual(p["mode"], "FULL")
        finally:
            fx.cleanup()

    def test_unknown_path_fails_closed_to_full(self):
        fx = Fixture()
        try:
            p = fx.plan([ch("M", "weird/new-thing.txt")])
            self.assertEqual(p["mode"], "FULL")
            self.assertTrue(any(r.startswith("unknown:") for r in p["reasons"]))
        finally:
            fx.cleanup()

    def test_root_document_stays_plain(self):
        """Root-level facts docs must not drag in a FULL regression.

        They carry no directory prefix, so before KNOWN_PLAIN_FILES they
        were classified ``unknown:`` — a one-line edit to AGENTS.md cost a
        ~13 min full suite. Fail-closed is preserved for every root file
        that is NOT listed here.
        """
        fx = Fixture()
        try:
            p = fx.plan([ch("M", "AGENTS.md"), ch("M", "FAILURES.md")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertFalse(
                any(r.startswith("unknown:") for r in p["reasons"])
            )
            # An unlisted root file still fails closed.
            p2 = fx.plan([ch("M", "BOOTSTRAP.md")])
            self.assertEqual(p2["mode"], "FULL")
            self.assertTrue(
                any(r.startswith("unknown:") for r in p2["reasons"])
            )
        finally:
            fx.cleanup()

    def test_unknown_status_fails_closed(self):
        fx = Fixture()
        try:
            p = fx.plan([ch("U", "scripts/x.py")])
            self.assertEqual(p["mode"], "FULL")
            self.assertTrue(any(r.startswith("status:U") for r in p["reasons"]))
        finally:
            fx.cleanup()

    def test_backslash_paths_normalized(self):
        fx = Fixture()
        try:
            fx.add("docs/x.md")
            p = fx.plan([ch("M", "docs\\x.md")])
            self.assertEqual(p["mode"], "DELTA")
        finally:
            fx.cleanup()

    def test_mcp_change_maps_its_suite(self):
        """A registered MCP suite is planned when its package changes.

        The registry is empty since agent-switchboard retired, so the suite is
        injected here: this asserts the mapping mechanism still works for the
        next package that needs separate discovery, without pinning the test
        to a package that no longer exists.
        """
        fx = Fixture()
        try:
            suite = "mcp/demo-pkg/tests"
            fx.add("mcp/demo-pkg/src/x.py")
            fx.add("mcp/demo-pkg/tests/test_x.py")
            with mock.patch.object(gate_planner, "MCP_SUITES_ALL", [suite]):
                p = fx.plan([ch("M", "mcp/demo-pkg/src/x.py")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertIn(suite, p["mcp_suites"])
            self.assertIn("mcp/demo-pkg/src/x.py", p["compile"])
        finally:
            fx.cleanup()

    def test_deleted_mcp_package_drops_its_suite(self):
        """Retiring an MCP package must not demand a suite that no longer exists.

        `unittest discover -s mcp/<name>/tests` on a missing directory raises
        ImportError and fails the gate, so deleting a package would be
        uncommittable. The suite is dropped from BOTH the delta plan and the
        FULL universe — but only for suites already registered in
        MCP_SUITES_ALL, so retiring one package cannot silently add another
        package's tests to every run.
        """
        fx = Fixture()
        try:
            fx.add("scripts/a.py").add("docs/x.md")
            for force in (False, True):
                p = fx.plan([ch("M", "docs/x.md")], force_full=force)
                self.assertEqual(p["mcp_suites"], [], f"force_full={force}")
            # Registered-but-deleted is dropped; registered-and-present stays —
            # i.e. retiring one package cannot silently add a sibling's tests.
            fx.add("mcp/present-pkg/tests/test_y.py")
            registry = ["mcp/gone-pkg/tests", "mcp/present-pkg/tests"]
            with mock.patch.object(gate_planner, "MCP_SUITES_ALL", registry):
                p = fx.plan([ch("M", "docs/x.md")], force_full=True)
            self.assertEqual(p["mcp_suites"], ["mcp/present-pkg/tests"])
        finally:
            fx.cleanup()

    def test_force_full_emits_universe(self):
        fx = Fixture()
        try:
            fx.add("scripts/a.py").add("tests/test_a.py")
            p = fx.plan([ch("M", "docs/x.md")], force_full=True)
            self.assertEqual(p["mode"], "FULL")
            self.assertEqual(set(p["compile"]), {"scripts/a.py",
                                                 "tests/test_a.py"})
            self.assertEqual(p["unittest"], ["tests/test_a.py"])
            # The universe is "every registered suite that still exists in the
            # candidate tree": a retired MCP package must not be demanded back
            # (`discover -s` on a missing dir raises ImportError).
            self.assertEqual(p["mcp_suites"], [])
            fx.add("mcp/demo-pkg/tests/test_x.py")
            with mock.patch.object(gate_planner, "MCP_SUITES_ALL",
                                   ["mcp/demo-pkg/tests"]):
                p2 = fx.plan([ch("M", "docs/x.md")], force_full=True)
            self.assertEqual(p2["mcp_suites"], ["mcp/demo-pkg/tests"])
        finally:
            fx.cleanup()

    def test_delta_subset_of_full(self):
        """The mechanical invariant: tasks(delta) ⊆ tasks(full)."""
        fx = Fixture()
        try:
            fx.add("scripts/svc.py").add(
                "tests/test_svc.py", "import scripts.svc\n")
            changes = [ch("M", "scripts/svc.py")]
            d = fx.plan(changes)
            f = fx.plan(changes, force_full=True)
            for key in ("compile", "unittest", "mcp_suites"):
                self.assertLessEqual(set(d[key]), set(f[key]), key)
        finally:
            fx.cleanup()


class TestImportGraph(unittest.TestCase):
    def test_direct_importer_selected(self):
        fx = Fixture()
        try:
            fx.add("scripts/provider.py")
            fx.add("tests/test_modernized_memory.py",
                   "from scripts.memory.provider import FileMemoryProvider\n"
                   "import provider\n")
            # direct import by module name
            fx.add("tests/test_provider.py", "import scripts.provider\n")
            p = fx.plan([ch("M", "scripts/provider.py")])
            self.assertIn("tests/test_provider.py", p["unittest"])
        finally:
            fx.cleanup()

    def test_transitive_closure(self):
        """test -> service -> policy: changing policy must reach test."""
        fx = Fixture()
        try:
            fx.add("scripts/policy.py")
            fx.add("scripts/service.py", "import scripts.policy\n")
            fx.add("tests/test_chain.py", "import scripts.service\n")
            p = fx.plan([ch("M", "scripts/policy.py")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertIn("tests/test_chain.py", p["unittest"])
        finally:
            fx.cleanup()

    def test_init_py_maps_to_package_consumers(self):
        """scripts/workspace/__init__.py affects importers of
        scripts.workspace.* — importing a submodule executes the init."""
        fx = Fixture()
        try:
            fx.add("scripts/workspace/__init__.py")
            fx.add("scripts/workspace/execution_contract.py")
            fx.add("tests/test_workspace_isolation.py",
                   "from scripts.workspace.execution_contract import X\n")
            p = fx.plan([ch("M", "scripts/workspace/__init__.py")])
            self.assertIn("tests/test_workspace_isolation.py",
                          p["unittest"])
        finally:
            fx.cleanup()

    def test_deleted_module_still_maps_dependents(self):
        fx = Fixture()
        try:
            # provider.py absent from tree (deleted); test still imports it
            fx.add("tests/test_provider.py",
                   "from scripts.memory.provider import FileMemoryProvider\n")
            p = fx.plan([ch("D", "scripts/memory/provider.py")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertIn("tests/test_provider.py", p["unittest"])
            self.assertNotIn("scripts/memory/provider.py", p["compile"])
        finally:
            fx.cleanup()

    def test_deleted_test_forces_full(self):
        fx = Fixture()
        try:
            fx.add("tests/test_alive.py")
            p = fx.plan([ch("D", "tests/test_gone.py")])
            self.assertEqual(p["mode"], "FULL")
            self.assertTrue(any(r.startswith("test-inventory:")
                                for r in p["reasons"]))
        finally:
            fx.cleanup()

    def test_renamed_test_forces_full(self):
        fx = Fixture()
        try:
            fx.add("tests/test_new.py")
            p = fx.plan([ch("R", "tests/test_new.py",
                            "tests/test_old.py")])
            self.assertEqual(p["mode"], "FULL")
        finally:
            fx.cleanup()

    def test_dynamic_import_in_changed_file_forces_full(self):
        fx = Fixture()
        try:
            fx.add("scripts/loader.py",
                   "import importlib\n"
                   "importlib.import_module(name)\n")
            p = fx.plan([ch("M", "scripts/loader.py")])
            self.assertEqual(p["mode"], "FULL")
            self.assertTrue(any(r.startswith("dynamic-import:")
                                for r in p["reasons"]))
        finally:
            fx.cleanup()

    def test_test_with_dynamic_import_always_runs(self):
        fx = Fixture()
        try:
            fx.add("scripts/unrelated.py")
            fx.add("tests/test_dyn.py",
                   "import importlib\nimportlib.import_module(x)\n")
            p = fx.plan([ch("M", "scripts/unrelated.py")])
            self.assertEqual(p["mode"], "DELTA")
            self.assertIn("tests/test_dyn.py", p["unittest"])
        finally:
            fx.cleanup()

    def test_from_package_import_module_covered(self):
        """from pkg import mod — leaf-name matching."""
        fx = Fixture()
        try:
            fx.add("scripts/aic/dsh_compatibility.py")
            fx.add("tests/test_dsh_compatibility.py",
                   "from scripts.aic import dsh_compatibility\n")
            p = fx.plan([ch("M", "scripts/aic/dsh_compatibility.py")])
            self.assertIn("tests/test_dsh_compatibility.py",
                          p["unittest"])
        finally:
            fx.cleanup()


class TestCli(unittest.TestCase):
    def test_files_mode_emits_json(self):
        repo = Path(__file__).resolve().parent.parent
        out = subprocess.run(
            [sys.executable,
             str(repo / "scripts" / "gate_planner.py"),
             "--files", "docs/x.md"],
            capture_output=True, text=True, check=True, cwd=repo,
        )
        plan = json.loads(out.stdout)
        self.assertEqual(plan["mode"], "DELTA")


class TestSuiteRegistryIsTheSingleSource(unittest.TestCase):
    """MCP_SUITES_ALL must be the only place MCP suites are enumerated.

    The retirement of agent-switchboard left five separate hardcoded copies
    behind (planner FULL branch, planner DELTA branch, publish_all, and the
    tests themselves). Each copy that survives the package it names is a gate
    whose only possible outcome is failure.
    """

    def test_publish_all_derives_mcp_gates_from_the_registry(self):
        repo = Path(__file__).resolve().parent.parent
        src = (repo / "scripts" / "publish_all.py").read_text(encoding="utf-8")
        self.assertIn("from gate_planner import MCP_SUITES_ALL", src)
        self.assertNotIn(
            "mcp/agent-switchboard", src,
            "publish_all must not name a package directly — it follows the registry",
        )

    def test_delta_branch_does_not_name_a_package(self):
        repo = Path(__file__).resolve().parent.parent
        src = (repo / "scripts" / "gate_planner.py").read_text(encoding="utf-8")
        # The only allowed mention is the retirement note next to the registry.
        body = src.split("MCP_SUITES_ALL: list[str] = []", 1)[1]
        self.assertNotIn("mcp/agent-switchboard", body)


if __name__ == "__main__":
    unittest.main()
