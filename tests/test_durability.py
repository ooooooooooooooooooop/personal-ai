#!/usr/bin/env python3
"""test_durability.py — unit tests for scripts/durability (temp-dir isolated)."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.modules.pop("common", None)  # scripts/{governance,durability}/common.py name collision
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "durability"))
import backup_status  # noqa: E402
import rpo_check  # noqa: E402


class TestBackupStatus(unittest.TestCase):
    """backup_status.main(): overdue is DATA (exit 0), config missing is exit 2."""

    def _env(self, rows, targets=(26,)):
        import datetime as dt
        d = Path(tempfile.mkdtemp())
        (d / "sync").mkdir(parents=True)
        tgt = "\n".join(f"  sessions: {t}" for t in targets)
        (d / "sync" / "this-device.yaml").write_text(
            f"device_id: T\nbackup_root: {str(d / 'bak').replace(chr(92), '/')}\nrpo_targets_hours:\n{tgt}\n",
            encoding="utf-8")
        bak = d / "bak" / "ledger"
        bak.mkdir(parents=True)
        with (bak / "runs.jsonl").open("w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        return d

    def _run(self, d):
        import contextlib
        import io
        old = os.environ.get("PERSONAL_AI_HOME")
        os.environ["PERSONAL_AI_HOME"] = str(d)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = backup_status.main()
        finally:
            if old is None:
                os.environ.pop("PERSONAL_AI_HOME", None)
            else:
                os.environ["PERSONAL_AI_HOME"] = old
        return code, json.loads(buf.getvalue())

    def test_overdue_is_data_not_failure(self):
        import datetime as dt
        old = (dt.datetime.now().astimezone() - dt.timedelta(hours=72)).isoformat(timespec="seconds")
        code, out = self._run(self._env([{"status": "ok", "ts": old}]))
        self.assertEqual(code, 0)
        self.assertTrue(out["overdue"])
        self.assertEqual(out["rpo_hours"], 26)
        self.assertGreater(out["age_hours"], 71)

    def test_fresh_and_error_rows_ignored(self):
        import datetime as dt
        now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        old = (dt.datetime.now().astimezone() - dt.timedelta(hours=72)).isoformat(timespec="seconds")
        rows = [{"status": "error", "ts": now}, {"status": "ok", "ts": now}, {"status": "ok", "ts": old}]
        code, out = self._run(self._env(rows))
        self.assertEqual(code, 0)
        self.assertFalse(out["overdue"], "latest ok row governs freshness; error rows never count")

    def test_no_ok_row_is_overdue(self):
        code, out = self._run(self._env([{"status": "error", "ts": "2026-01-01T00:00:00+08:00"}]))
        self.assertEqual(code, 0)
        self.assertTrue(out["overdue"])
        self.assertIsNone(out["last_ok"])

    def test_missing_config_exit_2(self):
        d = Path(tempfile.mkdtemp())  # no sync/this-device.yaml
        code, out = self._run(d)
        self.assertEqual(code, 2)
        self.assertFalse(out["ok"])


class TestRpo(unittest.TestCase):
    def row(self, dataset, finished, ok=True):
        return {"dataset": dataset, "status": "ok" if ok else "error",
                "integrity_status": "verified" if ok else "failed",
                "finished_at": finished}

    def test_healthy(self):
        import datetime as dt
        now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        r = rpo_check.evaluate("sessions", [self.row("sessions", now)], 26)
        self.assertEqual(r["status"], "HEALTHY")

    def test_breached_by_age(self):
        import datetime as dt
        old = (dt.datetime.now().astimezone() - dt.timedelta(hours=72)).isoformat(timespec="seconds")
        r = rpo_check.evaluate("sessions", [self.row("sessions", old)], 26)
        self.assertEqual(r["status"], "BREACHED")

    def test_unverified_does_not_count(self):
        import datetime as dt
        now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        r = rpo_check.evaluate("sessions", [self.row("sessions", now, ok=False)], 26)
        self.assertEqual(r["status"], "UNKNOWN")

    def test_unknown_when_no_backup(self):
        r = rpo_check.evaluate("sessions", [], 26)
        self.assertEqual(r["status"], "UNKNOWN")

    def test_simulate_age(self):
        r = rpo_check.evaluate("sessions", [], 26, simulate_hours=100)
        self.assertEqual(r["status"], "BREACHED")
        self.assertEqual(r["rpo_age_h"], 100)


class TestSqliteSnapshot(unittest.TestCase):
    def test_backup_api_consistency(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "src.sqlite"
            con = sqlite3.connect(src)
            con.execute("CREATE TABLE t (a TEXT)")
            con.execute("INSERT INTO t VALUES ('x')")
            con.commit()
            dst = Path(td) / "dst.sqlite"
            d = sqlite3.connect(dst)
            with d:
                con.backup(d)
            con.close()
            ok = d.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            self.assertTrue(ok)
            self.assertEqual(d.execute("SELECT a FROM t").fetchone()[0], "x")
            d.close()

    def test_corrupt_detected(self):
        with tempfile.TemporaryDirectory() as td:
            f = Path(td) / "b.sqlite"
            con = sqlite3.connect(f)
            con.execute("CREATE TABLE t (a BLOB)")
            con.execute("INSERT INTO t VALUES (randomblob(50000))")
            con.commit()
            con.close()
            data = bytearray(f.read_bytes())
            mid = len(data) // 2
            data[mid:mid + 4096] = b"\xff" * 4096  # wipe a full interior page
            f.write_bytes(bytes(data))
            con = sqlite3.connect(f)
            res = con.execute("PRAGMA integrity_check").fetchone()[0]
            con.close()
            self.assertNotEqual(res, "ok")


class TestIncrementalLogic(unittest.TestCase):
    def test_index_skips_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            f = Path(td) / "a" / "session.jsonl.zstd"
            f.parent.mkdir()
            f.write_bytes(b"payload")
            st = f.stat()
            index = {"a/session.jsonl.zstd": {"size": st.st_size, "mtime": int(st.st_mtime)}}
            prev = index.get("a/session.jsonl.zstd")
            skip = prev["size"] == st.st_size and prev["mtime"] == int(st.st_mtime)
            self.assertTrue(skip)
            time.sleep(0.02)
            f.write_bytes(b"payload-changed")
            st2 = f.stat()
            skip2 = prev["size"] == st2.st_size and prev["mtime"] == int(st2.st_mtime)
            self.assertFalse(skip2)


if __name__ == "__main__":
    unittest.main()
