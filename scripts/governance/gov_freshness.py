#!/usr/bin/env python3
"""governance/gov_freshness.py — read-only governance-run freshness probe (JSON on stdout).

App-lifecycle governance ownership（与 backup_status.py 同一模式）：app 而非 OS
计划任务决定 WHEN 治理检查跑；本探针回答"哪条 lane 逾期了"。逾期是数据不是
故障——exit 0；只有问题本身无法回答（设备配置缺失）才 exit 2。

证据源：<backup_root>/ledger/governance.jsonl 中 module=automation_<lane> 的行；
只有 execution_status == "SUCCESS" 的行才算一次真实跑完（finding 不影响新鲜度，
governance_status 原样透出供 UI 展示）。

Lanes 与 cadence（原 scheduler 触发器的等价物）：
  frequent   每日 04:00  → 26h
  sync-check 每日 09:00  → 26h
  weekly     周日 04:45  → 170h
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import _instance_root, load_yaml  # noqa: E402

LANES = {"frequent": 26, "sync-check": 26, "weekly": 170}


def _parse(ts: object) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None


def main() -> int:
    # 运行时才解析 instance root（env 优先），不能像模块常量那样 import 时
    # 绑死——否则测试/调用方设了 PERSONAL_AI_HOME 也会读到真实 ledger。
    cfg_path = _instance_root() / "sync" / "this-device.yaml"
    try:
        cfg = load_yaml(cfg_path)
        backup_root = Path(cfg["backup_root"])
    except (SystemExit, FileNotFoundError, KeyError, TypeError) as exc:
        print(json.dumps({"ok": False, "error": f"device config unreadable: {exc}"},
                         ensure_ascii=False))
        return 2

    ledger = backup_root / "ledger" / "governance.jsonl"
    rows: list[dict] = []
    if ledger.is_file():
        for line in ledger.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                rows.append(obj)

    now = dt.datetime.now().astimezone()
    out = {"ok": True, "ledger": str(ledger), "lanes": {}, "overdue": False}
    for lane, cadence in LANES.items():
        lane_rows = [r for r in rows
                     if r.get("module") == f"automation_{lane}"
                     and r.get("execution_status") == "SUCCESS"]
        stamps = [t for t in (_parse(r.get("ts")) for r in lane_rows) if t]
        last = max(stamps) if stamps else None
        last_row = max(lane_rows, key=lambda r: str(r.get("ts")), default=None)
        age_h = (now - last).total_seconds() / 3600 if last else None
        overdue = last is None or age_h > cadence
        out["lanes"][lane] = {
            "last_ok": last.isoformat(timespec="seconds") if last else None,
            "age_hours": round(age_h, 1) if age_h is not None else None,
            "cadence_hours": cadence,
            "overdue": overdue,
            "last_governance_status": (last_row or {}).get("status"),
        }
        out["overdue"] = out["overdue"] or overdue
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
