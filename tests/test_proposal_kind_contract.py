"""Producer/consumer kind contract — no ghost kinds may pass silently.

The producer vocabulary is KIND_BY_CLASS in dsh/world-model/world-model.mjs
(landed 2026-09-15, f034133). The consumer vocabulary is KIND_BUCKETS in
mind/u1_accept.py. Nothing coupled the two until this file: the vocabulary grew
to nine outputs while the consumer still accepted two, and the gap surfaced only
as `got <kind>` at decision time.

Three properties are asserted here:
  1. Every kind the producer can emit has a named disposition in the consumer.
  2. Every kind actually present in a canonical queue has a named disposition.
  3. A kind with no disposition is refused with a diagnostic, not applied.

Background and timeline: docs/proposal-kind-contract-gap.md
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
U1 = ROOT / "mind" / "u1_accept.py"
MJS = ROOT / "dsh" / "world-model" / "world-model.mjs"
GAP_DOC = "docs/proposal-kind-contract-gap.md"


def _load_u1():
    spec = importlib.util.spec_from_file_location("u1_accept_under_test", U1)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


U1MOD = _load_u1()


def producer_kinds() -> set:
    """The nine class->kind outputs declared by the body's closed vocabulary."""
    src = MJS.read_text(encoding="utf-8")
    anchor = re.search(r"KIND_BY_CLASS\s*=\s*\{(.*?)\}", src, re.S)
    if not anchor:
        raise AssertionError(
            "KIND_BY_CLASS anchor not found in world-model.mjs — this sensor has "
            "lost its grip on the producer. Fix the extraction before trusting "
            "any green result from this file.")
    return set(re.findall(r"'([^']+)'", anchor.group(1)))


def queue_kinds() -> set:
    """Kinds present in a real queue, if one is reachable from this machine."""
    canon = Path(os.environ.get(
        "PAI_CANONICAL_DIR",
        str(Path.home() / ".personal-ai" / "canonical")))
    pdir = canon / "proposals"
    if not pdir.is_dir():
        return set()
    kinds = set()
    for f in pdir.glob("*.json"):
        try:
            kinds.add(json.loads(f.read_text(encoding="utf-8")).get("kind"))
        except (json.JSONDecodeError, OSError):
            continue
    kinds.discard(None)
    return kinds


class TestRegistryShape(unittest.TestCase):
    def test_buckets_are_disjoint(self):
        names = list(U1MOD.KIND_BUCKETS)
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                overlap = U1MOD.KIND_BUCKETS[a] & U1MOD.KIND_BUCKETS[b]
                self.assertFalse(
                    overlap, f"kind(s) {sorted(overlap)} are in both {a!r} and {b!r}")

    def test_union_equals_all_known(self):
        union = set().union(*U1MOD.KIND_BUCKETS.values())
        self.assertEqual(union, set(U1MOD.ALL_KNOWN_KINDS))

    def test_apply_set_is_exactly_what_landed_idempotently(self):
        # A regression guard on the dangerous bucket: widening this set adds a
        # canonical writer. It must never widen by accident.
        self.assertEqual(U1MOD.KIND_APPLY, {"MODEL_PROPOSAL", "STATUS_UPDATE"})


class TestProducerCoverage(unittest.TestCase):
    def test_every_producer_output_has_a_disposition(self):
        ghosts = producer_kinds() - set(U1MOD.ALL_KNOWN_KINDS)
        self.assertFalse(
            ghosts,
            f"producer can emit {sorted(ghosts)} but u1_accept has no bucket for "
            f"it — add the disposition to mind/u1_accept.py and {GAP_DOC}")

    def test_extraction_is_not_vacuous(self):
        # If the regex ever silently matches nothing, the test above would pass
        # on an empty set. Pin the expected population instead.
        self.assertGreaterEqual(len(producer_kinds()), 9)

    def test_queue_kinds_have_a_disposition(self):
        observed = queue_kinds()
        if not observed:
            self.skipTest("no reachable canonical queue on this machine")
        ghosts = observed - set(U1MOD.ALL_KNOWN_KINDS)
        self.assertFalse(ghosts, f"undispositioned kinds in the live queue: {sorted(ghosts)}")

    def test_no_live_debt_is_mistaken_for_fossil(self):
        # value-update and canonical are still written by world-model.mjs today.
        # Filing them under "retired" would invite a batch withdraw that deletes
        # a live channel's entire output.
        self.assertIn("value-update", U1MOD.KIND_DEBT_LIVE)
        self.assertIn("canonical", U1MOD.KIND_DEBT_LIVE)
        self.assertFalse(U1MOD.KIND_DEBT_LIVE & U1MOD.KIND_FOSSIL)


def _mk(root, proposal):
    canon = root / "canon"
    (canon / "proposals").mkdir(parents=True)
    (canon / "history").mkdir(parents=True)
    (canon / "open-loops.yaml").write_text("open_loops: []\n", encoding="utf-8")
    (canon / "current.yaml").write_text("world_model: {}\n", encoding="utf-8")
    (canon / "proposals" / "p.json").write_text(json.dumps(proposal), encoding="utf-8")
    return canon


def _run(canon, *extra):
    return subprocess.run(
        [sys.executable, str(U1), "--canonical", str(canon), "--proposal", "p.json",
         *extra], capture_output=True, text=True)


class TestTerminalDecisionsAreKindAgnostic(unittest.TestCase):
    """The pre-1.2 ordering gated reject behind the apply check, so an operator
    could not close an obsolete proposal at all. That lockout is the regression."""

    def test_reject_closes_a_fossil_kind(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), {"kind": "model-update", "status": "proposed",
                                  "payload": {"change": "old"}})
            r = _run(canon, "--decision", "reject", "--reason", "retired kind")
            self.assertEqual(r.returncode, 0, r.stderr)
            prop = json.loads((canon / "proposals" / "p.json").read_text("utf-8"))
            self.assertEqual(prop["status"], "rejected")
            self.assertEqual(prop["decision"]["reason"], "retired kind")

    def test_withdraw_closes_a_fossil_kind_without_touching_canonical(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), {"kind": "model-update", "status": "proposed",
                                  "payload": {"change": "old"}})
            before = (canon / "current.yaml").read_bytes()
            r = _run(canon, "--decision", "withdraw", "--reason", "fossil")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((canon / "current.yaml").read_bytes(), before)
            out = json.loads(r.stdout)
            self.assertEqual(out["canonical_write"], "NONE")
            self.assertEqual(out["status"], "withdrawn")

    def test_repeat_withdraw_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), {"kind": "canonical", "status": "proposed",
                                  "payload": {}})
            _run(canon, "--decision", "withdraw", "--reason", "first")
            first = (canon / "proposals" / "p.json").read_text("utf-8")
            r = _run(canon, "--decision", "withdraw", "--reason", "second")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((canon / "proposals" / "p.json").read_text("utf-8"), first,
                             "a second close must not rewrite the audit record")

    def test_withdraw_cannot_un_apply_an_accepted_proposal(self):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), {"kind": "MODEL_PROPOSAL", "status": "accepted",
                                  "payload": {}})
            r = _run(canon, "--decision", "withdraw", "--reason", "oops")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("demotion", r.stderr)
            prop = json.loads((canon / "proposals" / "p.json").read_text("utf-8"))
            self.assertEqual(prop["status"], "accepted")


class TestApplyRefusalsCarryADisposition(unittest.TestCase):
    def _apply(self, kind):
        with tempfile.TemporaryDirectory() as d:
            canon = _mk(Path(d), {"kind": kind, "status": "proposed",
                                  "payload": {"candidate": {"candidate_id": "M-1"}}})
            before = (canon / "current.yaml").read_bytes()
            r = _run(canon, "--decision", "accept", "--reason", "t")
            self.assertNotEqual(r.returncode, 0, f"{kind} must not be applicable")
            self.assertEqual((canon / "current.yaml").read_bytes(), before,
                             "a refused apply must leave canonical byte-identical")
            return r.stderr

    def test_fossil_names_the_retirement_date_and_the_way_out(self):
        err = self._apply("model-update")
        self.assertIn("2026-09-15", err)
        self.assertIn("withdraw", err)
        self.assertIn(GAP_DOC, err)

    def test_live_debt_says_the_producer_is_still_running(self):
        err = self._apply("value-update")
        self.assertIn("structural debt", err)
        self.assertIn(GAP_DOC, err)

    def test_ghost_kind_is_refused_as_unknown(self):
        err = self._apply("totally-made-up-kind")
        self.assertIn("unknown kind", err)
        self.assertIn("Refusing to guess", err)

    def test_foreign_kind_is_not_ours_to_decide(self):
        err = self._apply("HYPOTHESIS_PROPOSAL")
        self.assertIn("owned by its producer", err)


if __name__ == "__main__":
    unittest.main()
