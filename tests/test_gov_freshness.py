#!/usr/bin/env python3
"""test_gov_freshness.py — scripts/governance/gov_freshness.py 契约测试（temp-dir 隔离）。"""
from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.modules.pop("common", None)  # scripts/{governance,durability}/common.py name collision
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "governance"))
import gov_freshness  # noqa: E402


class TestGovFreshness(unittest.TestCase):
    """逾期是数据（exit 0）；只有设备配置不可读才 exit 2；FAILED 执行不算跑过。"""

    def _env(self, rows):
        d = Path(tempfile.mkdtemp())
        (d / "sync").mkdir(parents=True)
        (d / "sync" / "this-device.yaml").write_text(
            f"device_id: T\nbackup_root: {str(d / 'bak').replace(chr(92), '/')}\n",
            encoding="utf-8")
        led = d / "bak" / "ledger"
        led.mkdir(parents=True)
        with (led / "governance.jsonl").open("w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        return d

    def _run(self, d):
        old = os.environ.get("PERSONAL_AI_HOME")
        os.environ["PERSONAL_AI_HOME"] = str(d)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = gov_freshness.main()
        finally:
            if old is None:
                os.environ.pop("PERSONAL_AI_HOME", None)
            else:
                os.environ["PERSONAL_AI_HOME"] = old
        return code, json.loads(buf.getvalue())

    @staticmethod
    def _row(lane, hours_ago, execution="SUCCESS", status="pass"):
        ts = (dt.datetime.now().astimezone() - dt.timedelta(hours=hours_ago)).isoformat(timespec="seconds")
        return {"ts": ts, "module": f"automation_{lane}", "status": status,
                "execution_status": execution}

    def test_fresh_lane_not_overdue(self):
        code, out = self._run(self._env([self._row("frequent", 5)]))
        self.assertEqual(code, 0)
        self.assertFalse(out["lanes"]["frequent"]["overdue"])
        self.assertEqual(out["lanes"]["frequent"]["last_governance_status"], "pass")

    def test_stale_lane_overdue_but_exit_0(self):
        code, out = self._run(self._env([self._row("sync-check", 50)]))
        self.assertEqual(code, 0)
        self.assertTrue(out["lanes"]["sync-check"]["overdue"])
        self.assertTrue(out["overdue"])

    def test_failed_execution_never_counts(self):
        code, out = self._run(self._env([self._row("weekly", 1, execution="FAILED")]))
        self.assertEqual(code, 0)
        lane = out["lanes"]["weekly"]
        self.assertIsNone(lane["last_ok"])
        self.assertTrue(lane["overdue"])

    def test_findings_do_not_affect_freshness(self):
        # governance finding (status=review) 是检查结果，不影响"跑过"的事实
        code, out = self._run(self._env([self._row("frequent", 2, status="review")]))
        self.assertFalse(out["lanes"]["frequent"]["overdue"])

    def test_weekly_cadence_is_170h(self):
        code, out = self._run(self._env([self._row("weekly", 100)]))
        self.assertFalse(out["lanes"]["weekly"]["overdue"])
        code, out = self._run(self._env([self._row("weekly", 200)]))
        self.assertTrue(out["lanes"]["weekly"]["overdue"])

    def test_missing_config_exit_2(self):
        d = Path(tempfile.mkdtemp())
        code, out = self._run(d)
        self.assertEqual(code, 2)
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
