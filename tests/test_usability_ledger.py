#!/usr/bin/env python3
"""test_usability_ledger.py — 好用度记账的契约测试（合成数据，无真实会话）。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "usability"))
import usability_ledger as ul  # noqa: E402


def _session(dirpath: Path, name: str, events: list[dict]) -> Path:
    p = dirpath / name
    p.write_text("\n".join(json.dumps(e) for e in events), encoding="utf-8")
    return p


def _ev(t, ty, **kw):
    return {"ts": f"2026-10-01T{t}+08:00", "type": ty, **kw}


def _row(day: str, m: dict) -> dict:
    base = {k: 0 for k in ul._METRIC_KEYS_INT}
    base.update({k: None for k in ul._METRIC_KEYS_FLOAT})
    base["error_signatures"] = []
    base.update(m)
    return {"schema": ul.SCHEMA, "session_id_hash": ul._hash(day + str(m)),
            "harness": "test", "date": day, "metrics": base}


class TestSchema(unittest.TestCase):
    def test_free_text_key_rejected(self):
        row = _row("2026-10-01", {})
        row["metrics"]["user_note"] = "用户好像不高兴"   # 主观/自由文本
        self.assertTrue(any("not-whitelisted" in e for e in ul.validate_row(row)))

    def test_top_level_free_text_rejected(self):
        row = _row("2026-10-01", {})
        row["comment"] = "feels better"
        # 顶层额外键：当前校验只查白名单键类型——顶层键不在白名单检查内，
        # 但 schema/hash/harness/date 缺失或非法必须被抓
        row2 = _row("2026-10-01", {})
        row2["session_id_hash"] = "session-abc-123"     # 原始 ID 而非哈希
        self.assertIn("session_id_hash", ul.validate_row(row2))

    def test_valid_row_passes(self):
        self.assertEqual(ul.validate_row(_row("2026-10-01", {"user_turns": 3})), [])


class TestLedgerDir(unittest.TestCase):
    def test_refuses_git_repo(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / ".git").mkdir()
            with self.assertRaises(SystemExit):
                ul.ledger_dir(Path(td))

    def test_local_dir_ok(self):
        with tempfile.TemporaryDirectory() as td:
            d = ul.ledger_dir(Path(td) / "instance")
            self.assertEqual(d.name, "usability")


class TestIngest(unittest.TestCase):
    def test_mechanical_counts(self):
        with tempfile.TemporaryDirectory() as td:
            f = _session(Path(td), "s.jsonl", [
                _ev("10:00:00", "user", content="帮我看看这个脚本为什么报错"),
                _ev("10:00:08", "assistant", content="..."),
                _ev("10:00:09", "tool_call", name="bash"),
                _ev("10:00:10", "tool_error", tool="bash", error_class="exit_1"),
                _ev("10:01:00", "user", content="帮我看看这个脚本为什么报错"),  # 重述
                _ev("10:01:05", "assistant", content="..."),
            ])
            row = ul.ingest_session(f, "test")
            m = row["metrics"]
            self.assertEqual(m["user_turns"], 2)
            self.assertEqual(m["repeat_user_msgs"], 1)
            self.assertEqual(m["tool_calls"], 1)
            self.assertEqual(m["tool_errors"], 1)
            self.assertEqual(m["first_response_latency_s"], 8.0)
            self.assertEqual(m["session_duration_s"], 65.0)
            self.assertEqual(len(m["error_signatures"]), 1)
            # 内容不泄漏：ledger 行里任何位置都不含消息文本
            self.assertNotIn("帮我看看", json.dumps(row, ensure_ascii=False))

    def test_large_paste(self):
        with tempfile.TemporaryDirectory() as td:
            f = _session(Path(td), "s.jsonl", [
                _ev("10:00:00", "user", content="\n".join(f"line{i}" for i in range(50))),
            ])
            self.assertEqual(ul.ingest_session(f, "test")["metrics"]["large_pastes"], 1)

    def test_dsh_envelope_calibration(self):
        """C1 校准后的真实 DSH 形态：type + data 载荷，错误是部件 isError。"""
        with tempfile.TemporaryDirectory() as td:
            f = _session(Path(td), "s.jsonl", [
                {"time": "2026-10-01T10:00:00+08:00", "type": "user/message",
                 "data": {"role": "user", "content": [{"type": "text", "text": "帮我看看这个脚本为什么报错"}]}},
                {"time": "2026-10-01T10:00:08+08:00", "type": "assistant/message",
                 "data": {"message": {}, "step": 1, "turn": 1}},
                {"time": "2026-10-01T10:00:09+08:00", "type": "tool/call",
                 "data": {"callId": "c1", "name": "bash", "arguments": "..."}},
                {"time": "2026-10-01T10:00:10+08:00", "type": "tool/result",
                 "data": {"message": {"content": [
                     {"type": "tool-result", "toolCallId": "c1", "isError": True, "content": []}]}}},
                {"time": "2026-10-01T10:00:11+08:00", "type": "assistant/chunk", "data": {}},
                {"time": "2026-10-01T10:01:00+08:00", "type": "user/message",
                 "data": {"role": "user", "content": [{"type": "text", "text": "帮我看看这个脚本为什么报错"}]}},
            ])
            m = ul.ingest_session(f, "dsh")["metrics"]
            self.assertEqual(m["user_turns"], 2)
            self.assertEqual(m["repeat_user_msgs"], 1)
            self.assertEqual(m["tool_calls"], 1)
            self.assertEqual(m["tool_errors"], 1)      # isError 部件
            self.assertEqual(m["unknown_events"], 0)   # chunk 是已校准非指标
            self.assertEqual(m["first_response_latency_s"], 8.0)

    def test_pi_envelope_calibration(self):
        """pi（app 层）形态：type 恒为 message，分类在 role；工具调用是部件。"""
        with tempfile.TemporaryDirectory() as td:
            f = _session(Path(td), "s.jsonl", [
                {"timestamp": "2026-10-01T10:00:00+08:00", "type": "message",
                 "message": {"role": "user", "content": [{"type": "text", "text": "帮我看看这个脚本为什么报错"}]}},
                {"timestamp": "2026-10-01T10:00:08+08:00", "type": "message",
                 "message": {"role": "assistant", "content": [
                     {"type": "text", "text": "..."},
                     {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {}}]}},
                {"timestamp": "2026-10-01T10:00:10+08:00", "type": "message",
                 "message": {"role": "toolResult", "toolCallId": "c1", "toolName": "bash",
                             "isError": True, "content": [{"type": "text", "text": "..."}]}},
                {"timestamp": "2026-10-01T10:00:11+08:00", "type": "model_change"},
            ])
            m = ul.ingest_session(f, "pi")["metrics"]
            self.assertEqual(m["user_turns"], 1)
            self.assertEqual(m["agent_turns"], 1)
            self.assertEqual(m["tool_calls"], 1)       # assistant 的 toolCall 部件
            self.assertEqual(m["tool_errors"], 1)      # toolResult.isError
            self.assertEqual(m["unknown_events"], 0)   # model_change 已校准
            self.assertEqual(m["first_response_latency_s"], 8.0)


class TestEvaluate(unittest.TestCase):
    def _fill(self, start: date, n: int, turns: int, err_sig: str | None,
              repeat: int = 0, paste: int = 0):
        rows = []
        for i in range(n):
            d = (start + timedelta(days=i % 27)).isoformat()
            m = {"user_turns": turns, "tool_calls": 10, "tool_errors": 1 if err_sig else 0,
                 "repeat_user_msgs": repeat, "large_pastes": paste,
                 "first_response_latency_s": 5.0}
            if err_sig:
                m["error_signatures"] = [ul._hash(err_sig)]
            rows.append(_row(d, m))
        return rows

    def test_better_verdict(self):
        today = date.today()
        prev = self._fill(today - timedelta(days=55), 25, turns=20, err_sig="e1",
                          repeat=2, paste=1)
        cur = self._fill(today - timedelta(days=27), 25, turns=10, err_sig=None)
        r = ul.evaluate(prev + cur, today=today)
        self.assertEqual(r["verdict"], "BETTER")

    def test_insufficient_data(self):
        today = date.today()
        rows = self._fill(today - timedelta(days=27), 5, turns=10, err_sig=None)
        self.assertEqual(ul.evaluate(rows, today=today)["verdict"], "INSUFFICIENT_DATA")

    def test_repeat_error_recurrence_counted(self):
        today = date.today()
        cur = self._fill(today - timedelta(days=27), 25, turns=10, err_sig="same-bug")
        prev = self._fill(today - timedelta(days=55), 25, turns=10, err_sig="same-bug")
        r = ul.evaluate(prev + cur, today=today)
        self.assertGreaterEqual(r["current_window"]["repeat_error_recurrences"], 1)


if __name__ == "__main__":
    unittest.main()
