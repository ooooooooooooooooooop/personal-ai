#!/usr/bin/env python3
"""usability_ledger.py — 好用度客观记账（本地专用，永不发布）。

设计契约见 docs/usability-ledger-design.md（预注册评估方法）。三条硬约束：
  1. 本地专用：ledger 只写 instance root（默认 ~/.personal-ai/usability/），
     拒绝写入任何 git 仓库内的路径。
  2. 客观记录：ledger 行只有计数/时长/哈希，schema 校验器拒绝任何自由文本键。
  3. 预注册评估：窗口、指标、判定规则全部写死在本文档与 evaluate()，
     评估时只读客观记录机械出结论。

CLI:
  ingest  --sessions-dir <dir> [--since YYYY-MM-DD]   从会话 JSONL(.zstd) 机械提取
  evaluate [--days 28]                                 滚动窗口对比 → 报告
  status                                              ledger 概况（行数/覆盖区间）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCHEMA = "USABILITY_SESSION_V1"

# ---- 客观指标白名单（自由文本键一律拒绝） --------------------------------
_METRIC_KEYS_INT = {
    "user_turns", "agent_turns", "tool_calls", "tool_errors",
    "repeat_user_msgs", "large_pastes", "unknown_events",
}
_METRIC_KEYS_FLOAT = {"first_response_latency_s", "session_duration_s"}
_METRIC_KEYS_LIST_HASH = {"error_signatures"}
_HARNESS_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

LARGE_PASTE_LINES = 40          # 用户单条消息 ≥40 行 = 人工转写代理信号
REPEAT_MIN_CHARS = 10           # 参与重述判定的最小消息长度（中文信息密度高，10 字已是一句指令）


def _hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate_row(row: dict) -> list[str]:
    """Fail-closed schema 校验：任何不在白名单的键/值类型都是违例。"""
    errs: list[str] = []
    if row.get("schema") != SCHEMA:
        errs.append("schema")
    if not _HASH_RE.match(str(row.get("session_id_hash", ""))):
        errs.append("session_id_hash")
    if not _HARNESS_RE.match(str(row.get("harness", ""))):
        errs.append("harness")
    try:
        date.fromisoformat(str(row.get("date", "")))
    except ValueError:
        errs.append("date")
    m = row.get("metrics")
    if not isinstance(m, dict):
        return errs + ["metrics"]
    allowed = _METRIC_KEYS_INT | _METRIC_KEYS_FLOAT | _METRIC_KEYS_LIST_HASH
    for k, v in m.items():
        if k not in allowed:
            errs.append(f"metrics.{k}:not-whitelisted")
        elif k in _METRIC_KEYS_INT and not (isinstance(v, int) and v >= 0):
            errs.append(f"metrics.{k}:not-nonneg-int")
        elif k in _METRIC_KEYS_FLOAT and not (v is None or isinstance(v, (int, float))):
            errs.append(f"metrics.{k}:not-number")
        elif k in _METRIC_KEYS_LIST_HASH and not (
                isinstance(v, list) and all(_HASH_RE.match(str(h)) for h in v)):
            errs.append(f"metrics.{k}:not-hash-list")
    return errs


def ledger_dir(root: Path | None = None) -> Path:
    """Ledger 目录：instance root 下，且禁止落在任何 git 仓库内。"""
    if root is None:
        home = os.environ.get("PERSONAL_AI_HOME") or os.environ.get("PERSONAL_AI_STATE")
        root = Path(home) if home else Path.home() / ".personal-ai"
    root = Path(root).resolve()
    probe = root
    while True:
        if (probe / ".git").exists():
            raise SystemExit(f"REFUSE: ledger root inside a git repo: {root}")
        if probe.parent == probe:
            break
        probe = probe.parent
    d = root / "usability"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---- ingest：会话 JSONL → 一行客观记账 -----------------------------------
# 事件分类映射是可配置的结构元数据（事件 type 名），不含任何内容。
# 2026-10-12 首次真实校准（C1）：对 884 个真实 DSH 会话做"仅 type 名直方图"
# 后的结果——真实词汇是 envelope 型（type + data 载荷），默认名全不匹配。
_DEFAULT_TYPE_MAP = {
    "user": {"user", "user_message", "human", "human_message", "input",
             "user/message"},
    "agent": {"assistant", "agent", "agent_message", "assistant_message", "output",
              "assistant/message"},
    "tool_call": {"tool_call", "tool_use", "function_call", "action",
                  "tool/call"},
    "tool_error": {"tool_error", "tool_failure", "error", "action_failed"},
    # DSH 错误不走独立 type：tool/result 的 content 部件带 isError 布尔；
    # pi 的 toolResult message 本体直接带 isError + toolName
    "tool_result": {"tool_result", "tool/result", "toolresult"},
}

# 已识别但不构成指标的流式/生命周期事件（同一真实直方图校准）。
# 它们不计入 unknown_events——unknown 留给真正没见过的类型，校准后应 ≈0。
_KNOWN_NON_METRIC = {
    "assistant/chunk", "tool-call-chunks", "reasoning-chunks", "text-chunks",
    "step/start", "step/end", "turn/start", "turn/end",
    "request/context", "request/header",
    "session", "session/end-seed", "session/title", "session/title-llm-request",
    "compaction/start", "compaction/end", "compaction/prune", "compaction/summary",
    "todo/write", "sandbox/mode", "approval/policy", "permission/preset",
    "approval/asked", "approval/decided",
    "agent/inbox/spliced", "subagent/descriptor", "goal/change", "schedule/change",
    "agent-preset/selected",
    "command/run", "command/done",
    "tool-workflow/agent-start", "tool-workflow/agent-end",
    "tool-workflow/run-start", "tool-workflow/run-end",
    "llm/retry", "llm/retry-started",
    # pi（app 层）生命周期事件
    "model_change", "thinking_level_change",
}


def _payload(ev: dict) -> dict:
    """envelope 解包：DSH 载荷在 data 子对象，pi 在 message 子对象，平铺事件原样返回。"""
    d = ev.get("data")
    if isinstance(d, dict):
        return d
    msg = ev.get("message")
    if isinstance(msg, dict):
        return msg
    return ev


def _read_events(path: Path) -> list[dict]:
    raw: bytes
    if path.suffix == ".zstd":
        import zstandard
        raw = zstandard.ZstdDecompressor().stream_reader(path.open("rb")).read()
    else:
        raw = path.read_bytes()
    events = []
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            events.append(obj)
    return events


def _event_time(ev: dict) -> datetime | None:
    for k in ("ts", "timestamp", "time", "created_at"):
        v = ev.get(k)
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                continue
        if isinstance(v, (int, float)) and v > 10_000_000_000 // 1000:
            try:
                return datetime.fromtimestamp(v / (1000 if v > 10_000_000_000 else 1),
                                              tz=timezone.utc)
            except (OSError, OverflowError, ValueError):
                continue
    return None


def _error_signature(ev: dict) -> str:
    """错误签名 = 工具名 + 错误类的哈希；不存任何错误文本。"""
    tool = str(ev.get("tool", ev.get("name", ev.get("tool_name", "?"))))[:64]
    cls = str(ev.get("error_class", ev.get("code", ev.get("status", "?"))))[:64]
    return _hash(f"{tool}|{cls}")


def _normalize(text_ev: str) -> str:
    return re.sub(r"\s+", " ", text_ev.strip().lower())


def ingest_session(path: Path, harness: str, type_map: dict | None = None) -> dict:
    tm = type_map or _DEFAULT_TYPE_MAP
    events = _read_events(path)
    m = {k: 0 for k in _METRIC_KEYS_INT}
    m.update({k: None for k in _METRIC_KEYS_FLOAT})
    err_sigs: list[str] = []
    seen_user_norm: set[str] = set()
    call_tools: dict[str, str] = {}  # callId → 工具名（tool/call 先于 tool/result）
    first_user_t: datetime | None = None
    first_agent_t: datetime | None = None
    times: list[datetime] = []

    for ev in events:
        t = _event_time(ev)
        if t:
            times.append(t)
        etype = str(ev.get("type", ev.get("role", ""))).lower()
        if etype == "message":
            # pi：外层 type 恒为 "message"，真分类在 message.role
            etype = str(_payload(ev).get("role", "")).lower()
        payload = _payload(ev)
        if etype in tm["user"]:
            m["user_turns"] += 1
            if first_user_t is None and t:
                first_user_t = t
            content = payload.get("content", payload.get("text", ""))
            if isinstance(content, list):
                content = "".join(p.get("text", "") for p in content
                                  if isinstance(p, dict) and isinstance(p.get("text"), str))
            if isinstance(content, str):
                lines = content.count("\n") + 1
                if lines >= LARGE_PASTE_LINES:
                    m["large_pastes"] += 1
                norm = _normalize(content)
                if len(norm) >= REPEAT_MIN_CHARS:
                    h = _hash(norm)
                    if h in seen_user_norm:
                        m["repeat_user_msgs"] += 1
                    seen_user_norm.add(h)
        elif etype in tm["agent"]:
            m["agent_turns"] += 1
            if first_agent_t is None and t:
                first_agent_t = t
            # pi：工具调用是 assistant message content 里的 toolCall 部件
            for part in (payload.get("content") or []):
                if isinstance(part, dict) and str(part.get("type", "")).lower() == "toolcall":
                    m["tool_calls"] += 1
                    if part.get("id"):
                        call_tools[str(part["id"])] = str(part.get("name", "?"))[:64]
        elif etype in tm["tool_call"]:
            m["tool_calls"] += 1
            cid = payload.get("callId") or payload.get("id")
            if cid:
                call_tools[str(cid)] = str(payload.get("name", payload.get("tool", "?")))[:64]
        elif etype in tm.get("tool_result", ()):
            msg = payload.get("message") if isinstance(payload.get("message"), dict) else payload
            if msg.get("isError") is True:
                # pi 形态：错误标志在 message 本体，工具名直接给出
                m["tool_errors"] += 1
                tool = str(msg.get("toolName", ""))[:64] or call_tools.get(str(msg.get("toolCallId", "")), "?")
                err_sigs.append(_hash(f"{tool}|isError"))
                continue
            for part in (msg.get("content") or []):
                # DSH 形态：错误标志在 tool-result 部件上，工具名由 callId 回联
                if isinstance(part, dict) and part.get("isError") is True:
                    m["tool_errors"] += 1
                    tool = call_tools.get(str(part.get("toolCallId", "")), "?")
                    err_sigs.append(_hash(f"{tool}|isError"))
        elif etype in tm["tool_error"]:
            m["tool_errors"] += 1
            err_sigs.append(_error_signature(ev))
        elif etype in _KNOWN_NON_METRIC:
            pass  # 已校准的非指标事件：不记 unknown
        else:
            m["unknown_events"] += 1

    if first_user_t and first_agent_t and first_agent_t >= first_user_t:
        m["first_response_latency_s"] = round((first_agent_t - first_user_t).total_seconds(), 3)
    if len(times) >= 2:
        m["session_duration_s"] = round((max(times) - min(times)).total_seconds(), 3)
    m["error_signatures"] = sorted(set(err_sigs))

    day = (min(times).date().isoformat() if times
           else date.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat())
    row = {
        "schema": SCHEMA,
        "session_id_hash": _hash(str(path)),
        "harness": harness,
        "date": day,
        "metrics": m,
    }
    errs = validate_row(row)
    if errs:
        raise ValueError(f"row failed schema validation: {errs}")
    return row


# ---- evaluate：预注册窗口对比（规则写死，见设计文档 §3） ------------------
WINDOW_DAYS = 28
MIN_SESSIONS_PER_WINDOW = 20
IMPROVE_THRESHOLD = 0.10       # 相对变化 ≥10% 才算有方向
# 核心指标（全部"越小越好"），评估时不得增删——增删即新版预注册
CORE_METRICS = (
    "median_user_turns", "tool_error_rate", "repeat_user_msg_rate",
    "large_paste_rate", "median_first_response_latency_s",
    "repeat_error_recurrences",
)


def _window_stats(rows: list[dict]) -> dict:
    turns, err_rates, rep_rates, paste_rates, latencies = [], [], [], [], []
    sig_seen: dict[str, int] = {}
    for r in rows:
        m = r["metrics"]
        turns.append(m["user_turns"])
        if m["tool_calls"]:
            err_rates.append(m["tool_errors"] / m["tool_calls"])
        if m["user_turns"]:
            rep_rates.append(m["repeat_user_msgs"] / m["user_turns"])
            paste_rates.append(m["large_pastes"] / m["user_turns"])
        if m["first_response_latency_s"] is not None:
            latencies.append(m["first_response_latency_s"])
        for h in m["error_signatures"]:
            sig_seen[h] = sig_seen.get(h, 0) + 1
    med = statistics.median
    return {
        "sessions": len(rows),
        "median_user_turns": med(turns) if turns else None,
        "tool_error_rate": med(err_rates) if err_rates else None,
        "repeat_user_msg_rate": med(rep_rates) if rep_rates else None,
        "large_paste_rate": med(paste_rates) if paste_rates else None,
        "median_first_response_latency_s": med(latencies) if latencies else None,
        # 同一错误签名在窗口内被 ≥2 个不同会话命中 = 重复犯错
        "repeat_error_recurrences": sum(1 for c in sig_seen.values() if c >= 2),
    }


def evaluate(rows: list[dict], today: date | None = None,
             days: int = WINDOW_DAYS) -> dict:
    today = today or date.today()
    cur_start = today - timedelta(days=days - 1)
    prev_start = cur_start - timedelta(days=days)

    def in_window(r, lo: date, hi: date) -> bool:
        return lo <= date.fromisoformat(r["date"]) <= hi

    cur = _window_stats([r for r in rows if in_window(r, cur_start, today)])
    prev = _window_stats([r for r in rows if in_window(r, prev_start, cur_start - timedelta(days=1))])

    if cur["sessions"] < MIN_SESSIONS_PER_WINDOW or prev["sessions"] < MIN_SESSIONS_PER_WINDOW:
        verdict = "INSUFFICIENT_DATA"
    else:
        improved = regressed = 0
        for k in CORE_METRICS:
            a, b = prev.get(k), cur.get(k)     # a=旧, b=新, 越小越好
            if a is None or b is None or a == 0:
                continue
            change = (b - a) / a
            if change <= -IMPROVE_THRESHOLD:
                improved += 1
            elif change >= IMPROVE_THRESHOLD:
                regressed += 1
        if improved >= 4 and regressed == 0:
            verdict = "BETTER"
        elif regressed >= 4 and improved == 0:
            verdict = "WORSE"
        else:
            verdict = "MIXED"
    return {
        "schema": "USABILITY_EVALUATION_V1",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window_days": days,
        "current_window": {"start": cur_start.isoformat(), "end": today.isoformat(), **cur},
        "previous_window": {"start": prev_start.isoformat(),
                            "end": (cur_start - timedelta(days=1)).isoformat(), **prev},
        "verdict": verdict,
        "rule": "BETTER iff >=4/6 core metrics improve >=10% and none regress >=10% "
                "(mirror for WORSE); min 20 sessions/window else INSUFFICIENT_DATA",
    }


# ---- CLI -------------------------------------------------------------------
def _ledger_path(root: Path | None) -> Path:
    return ledger_dir(root) / "ledger.jsonl"


def _load_rows(root: Path | None) -> list[dict]:
    p = _ledger_path(root)
    if not p.is_file():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def cmd_ingest(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve() if args.root else None
    p = _ledger_path(root)
    known = {r["session_id_hash"] for r in _load_rows(root)}
    since = date.fromisoformat(args.since) if args.since else None
    added = skipped = 0
    with p.open("a", encoding="utf-8") as out:
        for f in sorted(Path(args.sessions_dir).rglob("*.jsonl*")):
            if f.suffix not in {".jsonl", ".zstd"}:
                continue
            if since and date.fromtimestamp(f.stat().st_mtime, tz=timezone.utc) < since:
                continue
            row = ingest_session(f, harness=args.harness)
            if row["session_id_hash"] in known:
                skipped += 1
                continue
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            added += 1
    print(json.dumps({"added": added, "skipped_dup": skipped, "ledger": str(p)},
                     ensure_ascii=False))
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve() if args.root else None
    rows = _load_rows(root)
    result = evaluate(rows, days=args.days)
    out_dir = ledger_dir(root) / "reports"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"eval-{date.today().isoformat()}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"verdict": result["verdict"], "report": str(out),
                      "current": result["current_window"],
                      "previous": result["previous_window"]}, ensure_ascii=False))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve() if args.root else None
    rows = _load_rows(root)
    days = sorted({r["date"] for r in rows})
    print(json.dumps({
        "ledger": str(_ledger_path(root)),
        "rows": len(rows),
        "first_day": days[0] if days else None,
        "last_day": days[-1] if days else None,
    }, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("ingest", cmd_ingest), ("evaluate", cmd_evaluate), ("status", cmd_status)):
        p = sub.add_parser(name)
        p.add_argument("--root", default=None,
                       help="instance root（默认 PERSONAL_AI_HOME 或 ~/.personal-ai）")
        p.set_defaults(fn=fn)
    sub.choices["ingest"].add_argument("--sessions-dir", required=True)
    sub.choices["ingest"].add_argument("--harness", default="dsh")
    sub.choices["ingest"].add_argument("--since", default=None)
    sub.choices["evaluate"].add_argument("--days", type=int, default=WINDOW_DAYS)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
