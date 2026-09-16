"""u1_accept STATUS_UPDATE kind — governed bookkeeping for canonical sidecars."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

U1 = Path(__file__).resolve().parents[1] / "dsh" / "world-model" / "u1_accept.py"

LOOPS = """schema_version: "1.0"
open_loops:
  - id: "O7-test-loop"
    description: "nested dsh measurement blocked"
    status: "open"
    priority: "medium"
    created: "2026-09-12"
  - id: "other-loop"
    description: "untouched"
    status: "open"
    created: "2026-09-12"
"""


def _mk(root, proposal):
    canon = root / "canon"
    (canon / "proposals").mkdir(parents=True)
    (canon / "history").mkdir(parents=True)
    (canon / "open-loops.yaml").write_text(LOOPS, encoding="utf-8")
    (canon / "current.yaml").write_text("world_model: {}\n", encoding="utf-8")
    (canon / "proposals" / "p.json").write_text(
        json.dumps(proposal), encoding="utf-8")
    return canon


def _prop(payload):
    return {"kind": "STATUS_UPDATE", "status": "proposed", "payload": payload}


def _run(canon, *extra):
    return subprocess.run(
        [sys.executable, str(U1), "--canonical", str(canon),
         "--proposal", "p.json", *extra],
        capture_output=True, text=True)


class TestStatusUpdate(unittest.TestCase):
    def test_accept_applies_whitelisted_fields(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), _prop({
                "target": "open-loops.yaml", "loop_id": "O7-test-loop",
                "set": {"status": "closed",
                        "closed": "2026-09-16 fixed via 884c7b2"}}))
            r = _run(canon, "--decision", "accept", "--reason", "O7 resolved",
                     "--authority", "u1-review")
            self.assertEqual(r.returncode, 0, r.stderr)
            doc = yaml.safe_load((canon / "open-loops.yaml").read_text("utf-8"))
            e = next(x for x in doc["open_loops"] if x["id"] == "O7-test-loop")
            self.assertEqual(e["status"], "closed")
            self.assertEqual(e["closed"], "2026-09-16 fixed via 884c7b2")
            other = next(x for x in doc["open_loops"] if x["id"] == "other-loop")
            self.assertEqual(other["status"], "open")
            # backup + history + proposal lifecycle
            self.assertTrue(list((canon / "history").glob("pre-u1-*/open-loops.yaml")))
            log = (canon / "history" / "model-updates.jsonl").read_text("utf-8")
            self.assertIn('"U1_STATUS_APPLY"', log)
            prop = json.loads((canon / "proposals" / "p.json").read_text("utf-8"))
            self.assertEqual(prop["status"], "accepted")
            self.assertEqual(prop["decision"]["applied_loop"], "O7-test-loop")

    def test_rejects_non_whitelisted_field(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), _prop({
                "target": "open-loops.yaml", "loop_id": "O7-test-loop",
                "set": {"status": "closed", "description": "injected"}}))
            r = _run(canon, "--decision", "accept")
            self.assertNotEqual(r.returncode, 0)
            doc = yaml.safe_load((canon / "open-loops.yaml").read_text("utf-8"))
            e = next(x for x in doc["open_loops"] if x["id"] == "O7-test-loop")
            self.assertEqual(e["status"], "open")
            self.assertNotEqual(e["description"], "injected")

    def test_rejects_unknown_loop_and_bad_target(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), _prop({
                "target": "open-loops.yaml", "loop_id": "ghost",
                "set": {"status": "closed"}}))
            r = _run(canon, "--decision", "accept")
            self.assertNotEqual(r.returncode, 0)
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), _prop({
                "target": "current.yaml", "loop_id": "O7-test-loop",
                "set": {"status": "closed"}}))
            r = _run(canon, "--decision", "accept")
            self.assertNotEqual(r.returncode, 0)

    def test_reject_decision_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), _prop({
                "target": "open-loops.yaml", "loop_id": "O7-test-loop",
                "set": {"status": "closed"}}))
            r = _run(canon, "--decision", "reject", "--reason", "not yet")
            self.assertEqual(r.returncode, 0, r.stderr)
            doc = yaml.safe_load((canon / "open-loops.yaml").read_text("utf-8"))
            e = next(x for x in doc["open_loops"] if x["id"] == "O7-test-loop")
            self.assertEqual(e["status"], "open")
            prop = json.loads((canon / "proposals" / "p.json").read_text("utf-8"))
            self.assertEqual(prop["status"], "rejected")

    def test_model_proposal_still_works(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), {
                "kind": "MODEL_PROPOSAL", "status": "proposed",
                "payload": {"candidate": {"candidate_id": "D-1",
                                          "proposition": "p",
                                          "falsifier": "f"}}})
            r = _run(canon, "--decision", "provisional")
            self.assertEqual(r.returncode, 0, r.stderr)
            cur = yaml.safe_load((canon / "current.yaml").read_text("utf-8"))
            self.assertIn("D-1", cur["world_model"]["models"])


if __name__ == "__main__":
    unittest.main()
