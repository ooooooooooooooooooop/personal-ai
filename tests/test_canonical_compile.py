"""Content-coverage contract for the compiled briefing.

`mind/canonical_compile.py` is the last metre between canonical and the body:
whatever it drops is invisible from the inside, because the body cannot tell
"this prior does not exist" from "this prior did not fit". For five weeks it
selected §3 models with `list(models.items())[:6]` — insertion order — while
`u1_accept` appended new models to the end. Nine models existed, six reached the
brief, and the three that did not included two that had been accepted months
earlier. The bytes were never the problem: 831 were still free.

So the properties asserted here are about *coverage*, not formatting:

  1. Every non-superseded model reaches §3, however deep it sits in the file.
  2. Every superseded model moves to §4 — retired, not deleted.
  3. Under the byte budget nothing is dropped and no truncation marker appears.
  4. Over the byte budget, anything dropped is named in a visible marker.
  5. Values are not capped at five either; the next channel to land there
     (value updates) would inherit exactly the same silent cutoff.

Background: docs/c22-accept-evidence.md §4 E, docs/briefing-truncation-fix.md
"""
import importlib.util
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPILER = ROOT / "mind" / "canonical_compile.py"


def _load_compiler():
    spec = importlib.util.spec_from_file_location("canonical_compile_under_test", COMPILER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CC = _load_compiler()

TS_OLD = "2026-09-13T13:41:52Z"
TS_NEW = "2026-09-15T00:25:13Z"


def _model(prop, ts=TS_NEW, status=None, op=None, ep=None, **extra):
    m = {"proposition": prop, "confidence": "medium", "provenance": {"ts": ts, "decision": "accept"}}
    if status is not None:
        m["status"] = status
    if op is not None:
        m["operational_status"] = op
    if ep is not None:
        m["epistemic_status"] = ep
    m.update(extra)
    return m


def _fixture(tmp, models, competing=None, values=None, sources=None):
    """Write a minimal but real-shaped canonical dir and return its path."""
    canon = Path(tmp)
    current = {
        "identity": {"entity_id": "test-entity"},
        "theory_version": "test",
        "schema_version": "test",
        "world_model": {
            "models": models,
            "competing_models": competing or {},
            "known_residuals": [],
        },
        "value_model": {"current_values": values or {}},
    }
    (canon / "current.yaml").write_text(yaml.safe_dump(current, allow_unicode=True), encoding="utf-8")
    (canon / "governance.yaml").write_text(yaml.safe_dump({
        "u0_constitutional": {"root_authorities": {"normative_authority_root": "owner"}},
        "normative_authorities": {"owner": {"scopes": ["truth_over_comfort"]}},
    }, allow_unicode=True), encoding="utf-8")
    (canon / "lineage.yaml").write_text(yaml.safe_dump(
        {"entity_id": "test-entity", "lineage_head": "h1", "continuity_epoch": 1}, allow_unicode=True),
        encoding="utf-8")
    (canon / "sources.yaml").write_text(
        yaml.safe_dump({"sources": sources or {}}, allow_unicode=True), encoding="utf-8")
    (canon / "open-loops.yaml").write_text(yaml.safe_dump({"open_loops": []}, allow_unicode=True), encoding="utf-8")
    (canon / "operators.yaml").write_text(yaml.safe_dump({}, allow_unicode=True), encoding="utf-8")
    return canon


def _section(text, n):
    """Body of section n, without the following section header."""
    start = text.index(f"## {n}. ")
    nxt = text.find("\n## ", start + 1)
    return text[start:] if nxt == -1 else text[start:nxt]


def _section3_ids(text):
    return re.findall(r"^- \*\*(.+?)\*\*", _section(text, 3), flags=re.M)


def _section4_ids(text):
    return re.findall(r"^- (.+?): SUPERSEDED", _section(text, 4), flags=re.M)


# The 3 retired + 6 live shape the live canonical actually had on 2026-10-23,
# including the acceptance order that hid the newest models at the tail.
LEGACY = {
    "H3": _model("old three", status="SUPERSEDED", superseded_by="H3'",
                 superseded_reason="redistill"),
    "H2": _model("old two", status="SUPERSEDED", superseded_by="H2'",
                 superseded_reason="redistill"),
    "H1": _model("old one", status="SUPERSEDED", superseded_by="H1'",
                 superseded_reason="redistill"),
    "H1'": _model("successor one", status="未得到支持（保留为待检验假设）"),
    "H2'": _model("successor two", status="部分支持"),
    "H3'": _model("successor three", status="当前最强解释"),
    # accepted 2026-09-15, appended after the six above — position 7 and 8
    "M-attribution-requirements": _model("attribution needs controls", ep="provisional"),
    "M-sandbox-admission-gate": _model("shell dies at temp-root preflight", ts=TS_OLD,
                                       op="usable", ep="provisional"),
    # accepted into the sandbox during the C22 probe — position 9
    "cand-8975ff9f": _model("freshly accepted candidate"),
}


class CoverageContract(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.canon = _fixture(self._tmp.name, LEGACY)
        self.text = CC.compile_briefing(self.canon)

    def tearDown(self):
        self._tmp.cleanup()

    def test_all_nine_models_are_present(self):
        for mid in LEGACY:
            with self.subTest(model=mid):
                self.assertIn(mid, self.text)

    def test_every_live_model_reaches_section_three(self):
        live = [m for m, v in LEGACY.items() if "SUPERSEDED" not in str(v.get("status", ""))]
        got = _section3_ids(self.text)
        self.assertEqual(sorted(got), sorted(live),
                         "§3 must carry exactly the non-superseded models")
        # the three positions the old slice could never reach
        for mid in ("M-attribution-requirements", "M-sandbox-admission-gate", "cand-8975ff9f"):
            self.assertIn(mid, got)

    def test_superseded_models_move_to_section_four_and_leave_three(self):
        got4 = _section4_ids(self.text)
        self.assertEqual(sorted(got4), ["H1", "H2", "H3"])
        for mid in ("H1", "H2", "H3"):
            self.assertNotIn(f"- **{mid}**", _section(self.text, 3))
        # retired is not deleted: the successor is still named
        self.assertIn("→ H3'", _section(self.text, 4))

    def test_usable_model_leads_then_newest_adoption(self):
        ids = _section3_ids(self.text)
        self.assertEqual(ids[0], "M-sandbox-admission-gate",
                         "operational_status: usable must lead §3")
        self.assertEqual([m for m in ids if m.startswith("M-") or m == "cand-8975ff9f"],
                         ["M-sandbox-admission-gate", "M-attribution-requirements", "cand-8975ff9f"])

    def test_each_model_appears_once_and_only_in_one_section(self):
        in3, in4 = _section3_ids(self.text), _section4_ids(self.text)
        self.assertEqual(len(in3), len(set(in3)))
        self.assertEqual(set(in3) & set(in4), set(), "a model is either a prior or a correction")

    def test_fits_budget_so_nothing_is_dropped(self):
        self.assertLessEqual(len(self.text.encode("utf-8")), CC.HARD_CAP)
        self.assertNotIn("[truncated]", self.text,
                         "a brief that fits must not claim truncation")
        self.assertEqual(len(_section3_ids(self.text)) + len(_section4_ids(self.text)),
                         len(LEGACY), "under budget, coverage is total")


class Ordering(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def test_usable_first_then_newest_adoption(self):
        models = {
            "old": _model("old", ts="2026-09-01T00:00:00Z"),
            "new": _model("new", ts="2026-10-01T00:00:00Z"),
            "mid": _model("mid", ts="2026-09-15T00:00:00Z"),
            "usable-oldest": _model("usable", ts="2026-08-01T00:00:00Z", op="usable"),
        }
        ids = _section3_ids(CC.compile_briefing(_fixture(self._tmp.name, models)))
        self.assertEqual(ids, ["usable-oldest", "new", "mid", "old"],
                         "actionable first; within a tier newest provenance.ts first")

    def test_missing_timestamp_sorts_oldest_not_newest(self):
        models = {
            "no-stamp": {"proposition": "undated"},
            "stamped": _model("dated", ts="2026-01-01T00:00:00Z"),
        }
        ids = _section3_ids(CC.compile_briefing(_fixture(self._tmp.name, models)))
        self.assertEqual(ids, ["stamped", "no-stamp"],
                         "an absent stamp must not buy front-of-line")


class EmptyAndValueSections(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def test_empty_section_three_is_explicit(self):
        canon = _fixture(self._tmp.name, {"H1": _model("only", status="SUPERSEDED",
                                                      superseded_by="H2")})
        text = CC.compile_briefing(canon)
        self.assertIn("no active models", _section(text, 3),
                      "an empty §3 and a failed channel read identically — say which one it is")

    def test_values_are_not_capped_at_five(self):
        values = {f"v{i}": f"constraint {i}" for i in range(7)}
        canon = _fixture(self._tmp.name, {"M1": _model("one")}, values=values)
        text = CC.compile_briefing(canon)
        for key in values:
            with self.subTest(value=key):
                self.assertIn(f"- {key}:", text)

    def test_values_keep_file_order_when_untimestamped(self):
        values = {"alpha": "a", "beta": "b", "gamma": "c"}
        canon = _fixture(self._tmp.name, {"M1": _model("one")}, values=values)
        body = _section(CC.compile_briefing(canon), 5)
        self.assertLess(body.index("- alpha:"), body.index("- beta:"))
        self.assertLess(body.index("- beta:"), body.index("- gamma:"))


class VisibleTruncation(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def _fat(self, n=8, size=1400):
        return {f"M-fat-{i}": _model("x" * size) for i in range(n)}

    def test_over_budget_reports_what_it_dropped(self):
        canon = _fixture(self._tmp.name, self._fat(),
                         values={"a": "1", "b": "2", "c": "3", "d": "4"})
        text = CC.compile_briefing(canon)
        raw = text.encode("utf-8")
        self.assertLessEqual(len(raw), CC.HARD_CAP, "the 8KiB cap is absolute")
        self.assertIn("[truncated]", text, "an over-budget brief must say it is over budget")
        marker = next(l for l in text.splitlines() if "[truncated]" in l)
        self.assertRegex(marker, r"\d+ entry/entries dropped")
        self.assertTrue(re.search(r"M-fat-\d", marker),
                        "the marker must name which models were dropped, not just how many")

    def test_values_are_spent_before_models(self):
        # Declared priority (module docstring): unresolved > alerts > models >
        # corrections > values. Values are the cheapest loss, so they absorb the
        # cut and §3 keeps every model.
        models = {f"M-{i}": _model("small proposition") for i in range(4)}
        values = {f"v{i:02d}": "z" * 200 for i in range(60)}
        canon = _fixture(self._tmp.name, models, values=values)
        text = CC.compile_briefing(canon)
        self.assertLessEqual(len(text.encode("utf-8")), CC.HARD_CAP)
        self.assertEqual(_section3_ids(text), list(models),
                         "the model set must survive while values absorb the cut")
        self.assertIn("[truncated]", _section(text, 5))
        self.assertNotIn("[truncated]", _section(text, 3))

    def test_corrections_are_spent_before_models(self):
        # The old trim order was [values, models, corrections, alerts, loops],
        # which contradicts the declared priority and spends the prior itself
        # while two hundred lines of correction history are still in the file.
        models = {f"M-{i}": _model("small proposition") for i in range(4)}
        sources = {f"s{i:02d}": {"correction_history": ["c" * 200] * 4} for i in range(40)}
        canon = _fixture(self._tmp.name, models, sources=sources)
        text = CC.compile_briefing(canon)
        self.assertLessEqual(len(text.encode("utf-8")), CC.HARD_CAP)
        self.assertEqual(_section3_ids(text), list(models),
                         "models outrank corrections, so corrections absorb the cut first")
        self.assertIn("[truncated]", _section(text, 4))


class NoPositionalCaps(unittest.TestCase):
    """The defect was a slice, so the slice itself is the regression surface."""

    def test_no_item_slice_on_collections_that_must_be_complete(self):
        src = COMPILER.read_text(encoding="utf-8")
        hits = re.findall(r"\.items\(\)\)\[:\s*\d+\]", src)
        self.assertEqual(hits, [],
                         "a positional cap on items() silently drops entries; "
                         "let the byte budget decide and mark what it drops")

    def test_no_slice_on_the_model_or_value_collections(self):
        src = COMPILER.read_text(encoding="utf-8")
        hits = re.findall(
            r"\b(models|comp|cv|active|values|retired|open_loops)\b[^\n]*\[:\s*\d+\]", src)
        self.assertEqual(hits, [],
                         "collections whose completeness is the contract must not be "
                         "sliced by position — the defect was exactly `list(models.items())[:6]`")

    def test_section_three_handles_both_model_maps(self):
        # competing_models were a second, separately sliced population: `[:4]`.
        # A live alternative belongs to §3; a retired one to §4; `note` is prose.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            models = {"M1": _model("primary")}
            comp = {
                "C-live": _model("alternative", ts="2026-10-02T00:00:00Z"),
                "C-dead": _model("retired", status="SUPERSEDED——4 false positives"),
                "note": "prose, not a model",
            }
            text = CC.compile_briefing(_fixture(tmp, models, competing=comp))
        self.assertIn("C-live", _section3_ids(text))
        self.assertIn("C-dead", _section4_ids(text))
        self.assertNotIn("C-dead", _section3_ids(text))
        self.assertNotIn("prose, not a model", text)
        self.assertEqual(_section3_ids(text)[0], "C-live",
                         "a newer alternative outranks an older primary")


class ArtifactBytes(unittest.TestCase):
    """The cap is only real if it measures the artifact the body is handed."""

    def test_reported_size_equals_the_file_on_disk(self):
        import json
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            canon = _fixture(tmp, {"M1": _model("one " * 40)})
            p = subprocess.run([sys.executable, str(COMPILER), "--canonical", str(canon)],
                               capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(p.returncode, 0, p.stderr)
            report = json.loads(p.stdout)
            on_disk = (canon / "briefing.md").stat().st_size
        self.assertEqual(report["briefing_bytes"], on_disk,
                         "a text-mode write translates \\n to \\r\\n on Windows, so the "
                         "reported budget and the artifact disagree by one byte per line")


class LiveCanonical(unittest.TestCase):
    """Optional smoke check against a mounted canonical (set PAI_CANONICAL_DIR)."""

    def test_live_models_all_reach_the_brief(self):
        import os
        d = os.environ.get("PAI_CANONICAL_DIR")
        if not d:
            self.skipTest("PAI_CANONICAL_DIR not set — no mounted canonical to check")
        canon = Path(d)
        cur = yaml.safe_load((canon / "current.yaml").read_text(encoding="utf-8")) or {}
        w = cur.get("world_model") or {}
        text = CC.compile_briefing(canon)
        in3 = set(_section3_ids(text))
        in4 = set(_section4_ids(text))
        for mid, m in list((w.get("models") or {}).items()) + list((w.get("competing_models") or {}).items()):
            if mid == "note":
                continue
            sup = CC._is_superseded(m)
            with self.subTest(model=mid):
                if sup:
                    self.assertIn(mid, in4)
                else:
                    self.assertIn(mid, in3)


if __name__ == "__main__":
    unittest.main()
