#!/usr/bin/env python3
"""durability/backup_status.py — read-only backup freshness probe (JSON on stdout).

App-lifecycle backup ownership: the app (not the OS scheduler) decides WHEN
backups run; this probe is how it asks "is one overdue?". Overdue is data,
not failure — exit 0 with {"overdue": true}. Exit 2 only when the question
itself cannot be answered (device config missing/unreadable).

Boundary: same as common.py — standalone tool, no aic / MemoryProvider / LLM.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import backup_root, device_config, ledger_rows  # noqa: E402


def _parse(ts: object) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None


def main() -> int:
    try:
        cfg = device_config()
        root = backup_root()
    except SystemExit as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    rows = ledger_rows()
    ok_stamps = [t for t in (_parse(r.get("ts")) for r in rows if r.get("status") == "ok") if t]
    last = max(ok_stamps) if ok_stamps else None
    targets = [v for v in (cfg.get("rpo_targets_hours") or {}).values()
               if isinstance(v, (int, float))]
    rpo = min(targets) if targets else 26
    now = dt.datetime.now().astimezone()
    age_h = (now - last).total_seconds() / 3600 if last else None
    print(json.dumps({
        "ok": True,
        "backup_root": str(root),
        "last_ok": last.isoformat(timespec="seconds") if last else None,
        "age_hours": round(age_h, 1) if age_h is not None else None,
        "rpo_hours": rpo,
        "overdue": last is None or age_h > rpo,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
