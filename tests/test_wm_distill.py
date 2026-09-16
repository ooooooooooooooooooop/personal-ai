"""L1 distill operator tests — adjudicated gates: deterministic/idempotent,
provenance, provisional+falsifier, dedup, calibration-over-all-predictions."""
import json
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dsh" / "world-model"))
import distill  # noqa: E402


def _ev(seq, et, pid=None, payload=None, ts="2026-09-16T00:00:00Z"):
    ev = {"event_id": f"ev-{seq}", "event_type": et, "timestamp": ts,
          "session_id": "s1", "seq": seq, "payload": payload or {}}
    if pid:
        ev["prediction_id"] = pid
    return ev


def _mk(root, events, current=None, proposals=None):
    state = root / "state"
    canon = root / "canon"
    (state / "ledger").mkdir(parents=True)
    (canon / "proposals").mkdir(parents=True)
    (state / "ledger" / "2026-09-16.jsonl").write_text(
        "\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    (canon / "current.yaml").write_text(current or "world_model: {}\n", encoding="utf-8")
    for name, body in (proposals or {}).items():
        (canon / "proposals" / name).write_text(json.dumps(body), encoding="utf-8")
    return state, canon


def _pair(seq, pid, subject, verdict, mid=None):
    return [
        _ev(seq, "PREDICTION_CREATED", pid,
            {"prediction_id": pid, "subject": subject, "model_id": mid,
             "expected_observation": "x", "falsifier": "f"},
            f"2026-09-16T00:0{seq}:00Z"),
        _ev(seq + 100, "PREDICTION_EVALUATED", pid,
            {"verdict": verdict}, f"2026-09-16T01:0{seq}:00Z"),
    ]


class TestDistill(unittest.TestCase):
    def test_refute_cluster_emits_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            evs = (_pair(1, "p1", "stream reliability", "refuted")
                   + _pair(2, "p2", "stream reliability", "refuted"))
            state, canon = _mk(Path(d), evs)
            r = distill.distill(state, canon, canon / "proposals")
            self.assertEqual(r["proposals_written"], 1)
            out = json.loads(next((canon / "proposals").glob("*MODEL_PROPOSAL*")).read_text("utf-8"))
            cand = out["payload"]["candidate"]
            self.assertEqual(out["kind"], "MODEL_PROPOSAL")
            self.assertEqual(out["status"], "proposed")
            self.assertEqual(cand["epistemic_status"], "provisional")
            self.assertTrue(cand["falsifier"])
            self.assertEqual(cand["candidate_class"], "counterevidence")
            self.assertEqual(cand["cluster"]["refuted"], 2)
            self.assertEqual(len(cand["evidence_refs"]), 4)

    def test_idempotent_rerun_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            evs = (_pair(1, "p1", "gate accuracy", "confirmed")
                   + _pair(2, "p2", "gate accuracy", "confirmed"))
            state, canon = _mk(Path(d), evs)
            r1 = distill.distill(state, canon, canon / "proposals")
            r2 = distill.distill(state, canon, canon / "proposals")
            self.assertEqual(r1["proposals_written"], 1)
            self.assertEqual(r2["proposals_written"], 0)
            self.assertEqual(len(list((canon / "proposals").glob("*.json"))), 1)

    def test_min_support_and_censored_counted(self):
        with tempfile.TemporaryDirectory() as d:
            evs = (_pair(1, "p1", "one-off", "confirmed")
                   + _pair(2, "p2", "other", "unknown")
                   + [_ev(3, "PREDICTION_CREATED", "p3",
                          {"prediction_id": "p3", "subject": "other"})])
            state, canon = _mk(Path(d), evs)
            r = distill.distill(state, canon, canon / "proposals")
            self.assertEqual(r["proposals_written"], 0)
            c = r["calibration"]
            self.assertEqual(c["confirmed"], 1)
            self.assertEqual(c["censored_unknown"], 1)
            self.assertEqual(c["never_evaluated"], 1)

    def test_dedup_vs_pending_proposal(self):
        with tempfile.TemporaryDirectory() as d:
            evs = (_pair(1, "p1", "dup topic", "confirmed")
                   + _pair(2, "p2", "dup topic", "confirmed"))
            prior = {"kind": "MODEL_PROPOSAL", "status": "proposed",
                     "payload": {"candidate": {"dedup_key": "subject:dup topic",
                                               "candidate_id": "D-old"}}}
            state, canon = _mk(Path(d), evs, proposals={"p.json": prior})
            r = distill.distill(state, canon, canon / "proposals")
            self.assertEqual(r["proposals_written"], 0)
            self.assertEqual(r["skipped_duplicate"], 1)

    def test_determinism_input_order_independent(self):
        with tempfile.TemporaryDirectory() as d:
            a = _pair(1, "p1", "s", "confirmed") + _pair(2, "p2", "s", "refuted")
            state, canon = _mk(Path(d) / "a", a)
            b = _pair(1, "p1", "s", "confirmed") + _pair(2, "p2", "s", "refuted")
            state2, canon2 = _mk(Path(d) / "b", list(reversed(b)))
            r1 = distill.distill(state, canon, canon / "proposals")
            r2 = distill.distill(state2, canon2, canon2 / "proposals")
            n1 = next((canon / "proposals").glob("*.json")).name
            n2 = next((canon2 / "proposals").glob("*.json")).name
            self.assertEqual(r1["proposals_written"], r2["proposals_written"])
            self.assertEqual(n1, n2)


if __name__ == "__main__":
    unittest.main()
