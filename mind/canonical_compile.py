#!/usr/bin/env python3
"""canonical_compile.py — compile canonical L2/L3 state into runtime artifacts.

Outputs (written into the canonical dir):
  briefing.md          GENERATED 7-section onboarding brief (V0.3.1 §7)
  runtime-state.json   projection the plugin reads: identity, lineage head,
                       active body/lease, normative authorities, alerts

Briefing contract:
  - fixed sections 0-6 (Identity / Unresolved First / Reliability Alerts /
    Current Best Models / Corrections & Superseded / Task-Relevant Values /
    Retrieval Pointers)
  - every Current Best Model carries proposition + confidence + scope +
    support refs + strongest counterevidence + falsifier/revision trigger
    (a prior plus the keys to overthrow it — not a conclusion dump)
  - target 4-6 KiB UTF-8, hard cap 8 KiB; overflow trimmed by priority
    (lowest dropped first): values > corrections > models > alerts > unresolved
  - OFF/CORE/FULL all receive the same brief (mode = ritual depth, not on/off)

Which models reach §3 is a coverage contract, not a display choice:
  - every model whose status is not SUPERSEDED appears in §3; retired models
    move to §4 (they are history, and they used to squat in §3's first seats);
  - order is usable-first, then newest `provenance.ts` first — NOT insertion
    position, which put every newly accepted model past the cutoff;
  - no magic count decides membership. Only the byte budget may drop an entry,
    and anything it drops is named in a visible `[truncated]` marker, so a
    shrinking brief can never look like a complete one.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

TARGET_MAX = 6 * 1024
HARD_CAP = 8 * 1024


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class _Section(list):
    """One briefing section: rendered entries, plus the label each one carries.

    Entries are stored already rendered (a model is a multi-line block, a loop is
    a single line) and `labels` runs parallel to them, so the budget trimmer can
    report by name what it removed instead of quietly shortening the brief.
    """

    def __init__(self, title: str):
        super().__init__([title])
        self.labels: list[str] = [""]

    def add(self, text: str, label: str = "") -> None:
        self.append(text)
        self.labels.append(label)

    def drop_last(self) -> str:
        self.pop()
        return self.labels.pop()


def _render(sections: list[_Section]) -> str:
    return "\n\n".join("\n".join(sec) for sec in sections)


def _ts_epoch(entry) -> float:
    """When this entry was adopted, in epoch seconds; 0.0 when unknown.

    `provenance.ts` is stamped by the accepting authority and is the only
    timestamp every model carries. `accepted_at` / `updated_at` / `ts` are
    checked next because value updates (the D1-B channel) may carry those
    instead. A missing or unparsable stamp sorts as OLDEST, never as "now":
    an absent timestamp must not buy an entry front-of-line.
    """
    if not isinstance(entry, dict):
        return 0.0
    pv = entry.get("provenance")
    raw = pv.get("ts") if isinstance(pv, dict) else None
    for cand in (raw, entry.get("accepted_at"), entry.get("updated_at"), entry.get("ts")):
        if isinstance(cand, str) and cand.strip():
            try:
                dt = datetime.fromisoformat(cand.strip().replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
    return 0.0


def _is_superseded(m) -> bool:
    """True when this model has been replaced — it is history, not a prior.

    `status` is free text (the corpus carries states like 当前最强解释), so the
    retired marker is matched anywhere in it; `superseded_by` is the structured
    equivalent for entries that carry it.
    """
    if not isinstance(m, dict):
        return False
    if "SUPERSEDED" in str(m.get("status") or ""):
        return True
    return bool(m.get("superseded_by"))


def _model_order(row) -> tuple:
    """§3 order: actionable first, then newest adoption, then canonical order.

    `operational_status == 'usable'` means the body may act on this model now, so
    it leads; within a tier the newest `provenance.ts` wins; ties keep canonical
    file order (deterministic, and it preserves the author's sequencing).
    """
    idx, _mid, m = row
    op = m.get("operational_status") if isinstance(m, dict) else None
    return (0 if op == "usable" else 1, -_ts_epoch(m), idx)


def _value_order(row) -> tuple:
    """§5 order: newest stamped value first, unstamped values after in file order.

    Values carry no timestamp today, so this is currently a no-op that only
    fixes the traversal order. It exists because the next thing to land here is
    a value-update channel: without a stable order, "keep the first five" comes
    straight back as the same silent truncation.
    """
    idx, (_key, val) = row
    ts = _ts_epoch(val)
    return (0 if ts else 1, -ts, idx)


def load(p: Path) -> dict:
    if not p.exists():
        return {}
    d = yaml.safe_load(p.read_text(encoding="utf-8"))
    return d if isinstance(d, dict) else {}


def fmt_model(mid: str, m: dict) -> str:
    if not isinstance(m, dict):
        return f"- {mid}: {m}"
    prop = m.get("proposition", "")
    conf = m.get("confidence", "")
    status = m.get("status", "")
    scope = m.get("coverage") or m.get("boundary") or m.get("scope") or ""
    sup = m.get("evidence_refs") or []
    if isinstance(sup, list):
        sup = "; ".join(str(x) for x in sup[:3])
    fals = m.get("falsifier") or ""
    lines = [f"- **{mid}** [{conf or 'n/a'}] {prop}"]
    if status:
        lines.append(f"  status: {status if isinstance(status, str) else json.dumps(status, ensure_ascii=False)}")
    if scope:
        lines.append(f"  scope: {scope}")
    if sup:
        lines.append(f"  support: {sup}")
    counter = m.get("counterevidence") or m.get("counter") or ""
    lines.append(f"  counter: {counter if counter else 'none recorded'}")
    lines.append(f"  revise_if: {fals if fals else 'not specified — treat as weakly held'}")
    return "\n".join(lines)


def compile_briefing(canon: Path) -> str:
    cur = load(canon / "current.yaml")
    gov = load(canon / "governance.yaml")
    lin = load(canon / "lineage.yaml")
    src = load(canon / "sources.yaml")
    loops = load(canon / "open-loops.yaml")
    ops = load(canon / "operators.yaml")

    ident = cur.get("identity") or {}
    w = cur.get("world_model") or {}
    v = cur.get("value_model") or {}

    s0 = _Section("## 0. Identity")
    s0.add(f"entity: {ident.get('entity_id','?')} | theory {cur.get('theory_version','?')} | "
           f"schema {cur.get('schema_version','?')} | lineage_head {lin.get('lineage_head','?')}")
    s0.add("你是 Personal AI 当班的认知劳工。这份简报是 prior + 推翻 prior 的钥匙，不是脚本。")

    s1 = _Section("## 1. Unresolved First")
    open_loops = [l for l in (loops.get("open_loops") or [])
                  if isinstance(l, dict) and l.get("status") == "open"]
    for l in open_loops:
        s1.add(f"- [{l.get('priority','?')}] {l.get('id','?')}: {str(l.get('description',''))[:180]}",
               str(l.get("id") or ""))
    for r in (w.get("known_residuals") or []):
        s1.add(f"- residual: {str(r)[:160]}")
    if w.get("open_predictions"):
        s1.add(f"- open_predictions: {w['open_predictions']}")
    if len(s1) == 1:
        s1.add("- (none recorded)")

    s2 = _Section("## 2. Reliability Alerts")
    for sid, s in (src.get("sources") or {}).items():
        if not isinstance(s, dict):
            continue
        lim = s.get("known_limits")
        er = s.get("epistemic_reliability") or {}
        weak = [d for d, r in er.items()
                if isinstance(r, dict) and r.get("level") in ("low", "unknown", "provisional")]
        parts = []
        if weak:
            parts.append("weak domains: " + ", ".join(weak[:4]))
        if lim:
            parts.append(str(lim)[:140])
        if parts:
            s2.add(f"- {sid}: {'; '.join(parts)}", str(sid))
    if len(s2) == 1:
        s2.add("- (no degraded sources recorded)")

    s3 = _Section("## 3. Current Best Models")
    models = w.get("models") or {}
    comp = w.get("competing_models") or {}
    combined = [(k, m) for k, m in models.items()] + [(k, m) for k, m in comp.items()]
    active: list[tuple[int, str, dict]] = []
    retired: list[tuple[str, dict]] = []
    seen: set[str] = set()
    for idx, (mid, m) in enumerate(combined):
        if mid == "note" or mid in seen:  # `note` is prose, not a model; models[] owns an id
            continue
        seen.add(mid)
        if _is_superseded(m):
            retired.append((mid, m))
        else:
            active.append((idx, mid, m))
    active.sort(key=_model_order)
    for _idx, mid, m in active:
        s3.add(fmt_model(mid, m), str(mid))
    if len(s3) == 1:
        # An empty §3 and a failed channel read identically from inside the body.
        s3.add("- (no active models — nothing here is a prior; see §4 for retired ones)")

    s4 = _Section("## 4. Corrections & Superseded")
    for mid, m in retired:
        status = str(m.get("status") or "") if isinstance(m, dict) else str(m)
        by = str((m.get("superseded_by") if isinstance(m, dict) else "") or "").strip()
        reason = str((m.get("superseded_reason") if isinstance(m, dict) else "") or "").strip()
        if not reason:  # competing_models carry the reason inside `status`
            reason = status.replace("SUPERSEDED", "").lstrip("—-·: ").strip()
        tail = f" → {by}" if by else ""
        s4.add(f"- {mid}: SUPERSEDED{tail} — {reason[:160]}" if reason
               else f"- {mid}: SUPERSEDED{tail}", str(mid))
    for sid, s in (src.get("sources") or {}).items():
        for c in (s.get("correction_history") or [])[:4]:
            s4.add(f"- {sid} correction: {str(c)[:160]}", str(sid))
    if len(s4) == 1:
        s4.add("- (none recorded)")

    s5 = _Section("## 5. Task-Relevant Values / Constraints")
    cv = (v.get("current_values") or {})
    for _idx, (k, val) in sorted(enumerate(cv.items()), key=_value_order):
        s5.add(f"- {k}: {str(val)[:140]}", str(k))
    # Look the authority up BY NAME from the constitutional root, rather than
    # hardcoding one: this read `.user.` while governance.yaml declares `.owner.`
    # (root_authorities.normative_authority_root: owner), so the line silently
    # produced nothing. A key that no source carries is a dead branch, not a
    # missing value.
    root_name = ((gov.get("u0_constitutional") or {}).get("root_authorities") or {}).get("normative_authority_root")
    na = ((gov.get("normative_authorities") or {}).get(root_name) or {}).get("scopes") or {}
    if na:
        scopes = na if isinstance(na, list) else [f"{k}={v2}" for k, v2 in na.items()]
        s5.add(f"- {root_name} normative scopes: " + ", ".join(str(x) for x in scopes))

    s6 = _Section("## 6. Retrieval Pointers")
    s6.add("- full state: world_model(op:\"status\"); canonical: current.yaml/governance.yaml/lineage.yaml/sources.yaml")
    s6.add("- proposals 治理：canonical 只能经 proposal→评审修改；runtime 直接写会被视为越权")
    s6.add("- world_model ops: activate/model/predict/observe/evaluate/update/probe/meta/value/input/persist/status")

    # Trim lowest-priority entries first, matching the declared order in the
    # module docstring: values > corrections > models > alerts > unresolved.
    # The old list trimmed MODELS before corrections, which inverted the stated
    # priority and made the §3 hole worse than it had to be.
    sections = [s0, s1, s2, s3, s4, s5, s6]
    hdr = "# PERSONAL AI BRIEF (GENERATED — do not hand-edit)\n" \
          "# classification: INTERNAL | basis: compiled_from_canonical\n\n"
    text = hdr + _render(sections) + "\n"
    if len(text.encode("utf-8")) > HARD_CAP:
        # drop lowest-priority whole entries until under the target; never exceed hard cap
        order = [5, 4, 3, 2, 1]
        dropped: dict[int, list[str]] = {}
        for idx in order:
            while len(sections[idx]) > 2 and len(text.encode("utf-8")) > TARGET_MAX:
                dropped.setdefault(idx, []).append(sections[idx].drop_last())
                text = hdr + _render(sections) + "\n"
        # A trimmed brief must say that it is trimmed, and what it lost. Silence
        # here is what made the §3 hole invisible for five weeks.
        for idx, labels in dropped.items():
            named = ", ".join(l for l in labels[:8] if l) or f"{len(labels)} untitled"
            sections[idx].add(f"- [truncated] {len(labels)} entry/entries dropped for the "
                              f"{HARD_CAP // 1024}KiB cap: {named} — full text stays in canonical/")
            text = hdr + _render(sections) + "\n"
        if len(text.encode("utf-8")) > HARD_CAP:
            text = text.encode("utf-8")[:HARD_CAP - 40].decode("utf-8", "ignore") + \
                "\n…(hard-capped at 8KiB)\n"
    return text


def compile_runtime_state(canon: Path) -> dict:
    cur = load(canon / "current.yaml")
    gov = load(canon / "governance.yaml")
    lin = load(canon / "lineage.yaml")
    src = load(canon / "sources.yaml")
    return {
        "compiled_at": utcnow(),
        "schema_version": cur.get("schema_version"),
        "theory_version": cur.get("theory_version"),
        "identity": cur.get("identity") or {},
        "entity_id": lin.get("entity_id"),
        "lineage_head": lin.get("lineage_head"),
        "continuity_epoch": lin.get("continuity_epoch"),
        "active_body": lin.get("active_body") or {},
        "parent_entity": lin.get("parent_entity"),
        "normative_authorities": gov.get("normative_authorities") or {},
        "u0_root_authorities": (gov.get("u0_constitutional") or {}).get("root_authorities") or {},
        "update_classes": (gov.get("u1_evolvable") or {}).get("update_classes") or {},
        "sources": {k: {kk: s.get(kk) for kk in ("source_type", "roles", "known_limits")}
                    for k, s in (src.get("sources") or {}).items() if isinstance(s, dict)},
        "open_predictions": (cur.get("world_model") or {}).get("open_predictions") or [],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--canonical", required=True)
    ap.add_argument("--check", action="store_true", help="report freshness, write nothing")
    args = ap.parse_args()
    canon = Path(args.canonical)

    briefing = compile_briefing(canon)
    state = compile_runtime_state(canon)
    n = len(briefing.encode("utf-8"))
    report = {"briefing_bytes": n, "target": "4-6KiB", "hard_cap": "8KiB",
              "over_target": n > TARGET_MAX, "over_cap": n > HARD_CAP,
              "entity": state.get("entity_id"), "epoch": state.get("continuity_epoch")}
    if args.check:
        bp = canon / "briefing.md"
        rp = canon / "runtime-state.json"
        yamls = [p for p in canon.glob("*.yaml")]
        newest_yaml = max((p.stat().st_mtime for p in yamls), default=0)
        report["stale"] = {
            "briefing.md": not bp.exists() or bp.stat().st_mtime < newest_yaml,
            "runtime-state.json": not rp.exists() or rp.stat().st_mtime < newest_yaml,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    # Write BYTES, not text: on Windows `write_text` translates every "\n" to
    # "\r\n", so a 5986-byte briefing landed on disk as 6063 bytes while the
    # report (and the cap it enforces) still said 5986. The budget is only real
    # if it measures the object the body is handed — one byte per line of slack
    # is enough to walk an 8KiB cap past 8KiB.
    (canon / "briefing.md").write_bytes(briefing.encode("utf-8"))
    (canon / "runtime-state.json").write_bytes(
        json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8"))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
