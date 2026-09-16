#!/usr/bin/env python3
"""distill.py — L1 distill operator (next-gen-strong-wm, ADMITTED 2026-09-16).

Reads the append-only prediction/outcome trail (stateDir/ledger/*.jsonl),
clusters evaluated prediction→outcome pairs, and emits MODEL_PROPOSAL
candidates into canonicalDir/proposals/ — proposal-only, never writes
canonical content files.

Adjudicated gates (chatgpt-web 2026-09-16):
  - deterministic / idempotent: sorted inputs, content-hash filenames,
    no wall-clock in output content (timestamp derived from evidence)
  - provenance complete: every candidate carries evidence_refs = event_ids
  - provisional + falsifier mandatory on every candidate
  - no semantic-duplicate models: dedup vs current.yaml models and vs
    already-proposed candidates (by dedup_key = normalized subject+scope)
  - calibration includes censored (unknown/superseded/unsettled) pairs —
    reliability is computed over ALL predictions, not only settled ones
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml

DISTILL_VERSION = "L1-0.1"
SETTLED = {"confirmed", "refuted", "partial"}
CENSORED = {"unknown"}  # superseded/never-evaluated counted separately


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", str(s or "").lower())).strip()


def _load_ledger(ledger_dir: Path):
    """Yield (event, lineno) in deterministic order: filename sort, then seq."""
    events = []
    for f in sorted(ledger_dir.glob("*.jsonl")):
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(ev, dict) and ev.get("event_type"):
                ev["_src"] = f"{f.name}:{i + 1}"
                events.append(ev)
    events.sort(key=lambda e: (e.get("timestamp") or "", e.get("seq") or 0, e.get("event_id") or ""))
    return events


def _pairs(events):
    """prediction_id -> {created, evaluations[], observations[]}"""
    preds = {}
    for ev in events:
        et = ev["event_type"]
        pl = ev.get("payload") or {}
        pid = ev.get("prediction_id") or pl.get("prediction_id")
        if et == "PREDICTION_CREATED":
            preds[pid] = {"created": ev, "evaluations": [], "observations": []}
        elif pid and pid in preds:
            if et == "PREDICTION_EVALUATED":
                preds[pid]["evaluations"].append(ev)
            elif et == "OBSERVATION_RECORDED":
                preds[pid]["observations"].append(ev)
    return preds


def _cluster_key(rec):
    c = rec["created"].get("payload") or {}
    mid = c.get("model_id")
    if mid:
        return f"model:{_norm(mid)}"
    return f"subject:{_norm(c.get('subject'))}"


def _existing_keys(canon: Path):
    """dedup keys already claimed by current.yaml models + pending proposals."""
    keys = set()
    cur = canon / "current.yaml"
    if cur.exists():
        try:
            data = yaml.safe_load(cur.read_text(encoding="utf-8", errors="replace")) or {}
        except yaml.YAMLError:
            data = {}
        for section in ("models", "competing_models"):
            entries = (data.get("world_model") or {}).get(section) or []
            if isinstance(entries, dict):
                entries = list(entries)
            for m in entries:
                if isinstance(m, dict):
                    for k in ("model_id", "id", "subject"):
                        if m.get(k):
                            keys.add(f"model:{_norm(m[k])}")
                            keys.add(f"subject:{_norm(m[k])}")
    pdir = canon / "proposals"
    if pdir.exists():
        for f in sorted(pdir.glob("*.json")):
            try:
                p = json.loads(f.read_text(encoding="utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            cand = (p.get("payload") or {}).get("candidate") or {}
            dk = cand.get("dedup_key")
            if dk:
                keys.add(dk)
            for k in ("candidate_id", "subject"):
                if cand.get(k):
                    keys.add(f"model:{_norm(cand[k])}")
                    keys.add(f"subject:{_norm(cand[k])}")
    return keys


def _fingerprint(candidate: dict) -> str:
    return hashlib.sha256(
        json.dumps(candidate, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:12]


def distill(state_dir: Path, canon: Path, out_dir: Path, min_support: int = 2):
    events = _load_ledger(state_dir / "ledger")
    preds = _pairs(events)
    existing = _existing_keys(canon)
    out_dir.mkdir(parents=True, exist_ok=True)

    clusters = {}
    for pid, rec in preds.items():
        clusters.setdefault(_cluster_key(rec), []).append((pid, rec))

    written, skipped_dup, clusters_seen = [], [], 0
    calibration = {"confirmed": 0, "refuted": 0, "partial": 0,
                   "censored_unknown": 0, "superseded": 0, "never_evaluated": 0}

    for key in sorted(clusters):
        recs = clusters[key]
        settled, censored = [], []
        for pid, rec in recs:
            evs = rec["evaluations"]
            if not evs:
                calibration["never_evaluated"] += 1
                censored.append((pid, rec))
                continue
            last = evs[-1].get("payload") or {}
            v = str(last.get("verdict") or "").lower()
            if v in SETTLED:
                calibration[v] += 1
                settled.append((pid, rec, v))
            elif last.get("superseded_by") or "superseded" in str(last.get("residual", "")).lower():
                calibration["superseded"] += 1
                censored.append((pid, rec))
            else:
                calibration["censored_unknown"] += 1
                censored.append((pid, rec))
        if len(settled) < min_support:
            continue
        clusters_seen += 1
        if key in existing:
            skipped_dup.append(key)
            continue

        n_c = sum(1 for *_, v in settled if v == "confirmed")
        n_r = sum(1 for *_, v in settled if v == "refuted")
        n_p = sum(1 for *_, v in settled if v == "partial")
        n_all = len(settled) + len(censored)
        sample = settled[0][1]["created"].get("payload") or {}
        subj = sample.get("subject") or key
        evidence = sorted({ev.get("event_id") for _, rec, _ in settled
                           for ev in [rec["created"], *rec["evaluations"], *rec["observations"]]
                           if ev.get("event_id")})
        latest_ts = max(ev.get("timestamp") or "" for _, rec, _ in settled
                        for ev in [rec["created"], *rec["evaluations"]]) or None

        if n_r:
            prop = (f"关于 {subj} 的现行假设存在反例：{n_r}/{len(settled)} 已结算预测 refuted"
                    f"（confirm {n_c} / partial {n_p}；另有 {len(censored)} 未结算）。")
            falsifier = (f"对 {subj} 的同型新预测被 confirmed 且反例机制被定位解释，"
                         f"则本候选降级。")
            cand_class = "counterevidence"
        else:
            prop = (f"关于 {subj} 的模式在已结算预测中稳定成立："
                    f"{n_c}/{len(settled)} confirmed（partial {n_p}；{len(censored)} 未结算）。")
            falsifier = (f"对 {subj} 的同型新预测出现 refuted（非测量噪声）即降级本候选。")
            cand_class = "stable-pattern"

        candidate = {
            "candidate_id": f"D-{key.split(':', 1)[0]}-{_fingerprint({'k': key, 'c': n_c, 'r': n_r})[:8]}",
            "dedup_key": key,
            "proposition": prop,
            "revision_type": "structure",
            "epistemic_status": "provisional",
            "falsifier": falsifier,
            "candidate_class": cand_class,
            "cluster": {"key": key, "settled": len(settled), "confirmed": n_c,
                        "refuted": n_r, "partial": n_p, "censored": len(censored),
                        "total_pairs": n_all},
            "evidence_refs": evidence,
        }
        fname = f"{(latest_ts or '1970-01-01')[:10]}-MODEL_PROPOSAL-{_fingerprint(candidate)}.json"
        body = {
            "schema_version": "1.2", "kind": "MODEL_PROPOSAL",
            "session_id": "distill", "timestamp": latest_ts,
            "body_id": "distill-operator", "distill_version": DISTILL_VERSION,
            "classification": {"level": "PRIVATE", "basis": ["taint_or_default"]},
            "payload": {"candidate": candidate}, "status": "proposed",
        }
        path = out_dir / fname
        if path.exists():
            try:
                if json.loads(path.read_text(encoding="utf-8")) == body:
                    continue  # idempotent: identical artifact already on disk
            except json.JSONDecodeError:
                pass
            skipped_dup.append(fname)
            continue
        path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if not path.exists():
            raise SystemExit(f"proposal write unverified: {path}")
        written.append(str(path))

    return {
        "distill_version": DISTILL_VERSION,
        "ledger_events": len(events), "predictions": len(preds),
        "clusters": clusters_seen, "proposals_written": len(written),
        "skipped_duplicate": len(skipped_dup),
        "calibration": calibration,  # all predictions incl. censored — adjudicated hard constraint
        "written": written,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", required=True, help="world-model stateDir (has ledger/)")
    ap.add_argument("--canonical", required=True, help="canonicalDir")
    ap.add_argument("--out", default=None, help="proposal output dir (default <canonical>/proposals)")
    ap.add_argument("--min-support", type=int, default=2)
    args = ap.parse_args()

    canon = Path(args.canonical)
    out = Path(args.out) if args.out else canon / "proposals"
    result = distill(Path(args.state_dir), canon, out, args.min_support)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
