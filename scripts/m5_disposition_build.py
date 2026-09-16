#!/usr/bin/env python3
"""m5_disposition_build.py — emit docs/cordis-disposition.json from the M5
inventory with a per-package disposition (the machine-checkable artifact the
markdown matrix summarizes).

Usage:
  python scripts/m5_disposition_build.py <inventory.json> [--check]

Without --check: writes docs/cordis-disposition.json.
With --check: verifies the committed JSON covers every inventoried package
exactly once, classes are valid, and prints class counts. Exit 1 on mismatch.

The assignment below mirrors docs/cordis-disposition.md; names not listed in
any explicit set default to D (rewrite on the new seams) and are printed for
review before the file is written.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "docs" / "cordis-disposition.json"

CLASSES = {"A", "B", "C", "D", "E"}

# A 搬 — mechanism is harness-neutral, port into host/
A = {
    "dsh-atomic-write": "atomic file replace — canonical write protection",
    "dsh-timeout": "clampTimeout primitive — durable-job timeout arm",
    "dsh-output-retention": "bounded retention primitive — audit/log trimming",
    "dsh-compaction-tool-result-pruner": "replay-safe head/mid/tail pruning — M3 compaction candidate",
    "dsh-token-meter": "replay-aware token metering — merged into TURN_ACCOUNTING",
    "dsh-sandbox-windows-acl": "Windows ACL write-restricted spawn — containment domain 3",
    "node-addon-landlock-run": "Landlock self-restricted exec (Linux) — sandbox option",
    "dsh-session-query-sqlite": "SQLite FTS5 session search backend — host memory retrieval",
}

# B 适配 — seam contract maps to a host contract; implementation stays in dsh body
B = {
    "dsh-goal": "goal contract seam → evidence requirements (host contract, dsh impl)",
    "dsh-tools": "tool-surface seam → Pi customTools + composite guard",
    "dsh-host-apiproxy": "remote API proxy seam → HostChannel (M6)",
    "dsh-fs-observation-policy": "fs event seam policy → fileops/audit contract",
    "dsh-goal-round-driver": "round-driver seam → ContinuationGovernor contract",
}

# C→Chord — channel/replicated-state/UI-state surfaces rebuilt on Chord later
C = {
    "dsh-client-connection": "HTTP-up/WS-down wire consumer → Chord RemoteServiceBinding",
    "dsh-client-runtime": "SlotRegistry/SessionRuntime replicated client core → replicatedState",
    "dsh-client-modules": "dual-side module system → Chord facet (node+browser)",
    "dsh-client-hmr": "client dynamic surface → facet",
    "dsh-client-locale": "client locale surface → facet",
    "dsh-api-gateway": "Typert remote host/BFF → Chord remote service endpoint",
    "dsh-api-remotes": "remote endpoints → Chord remote service endpoint",
    "dsh-typert-protocol": "Typert RPC metadata → wire protocol layer",
    "dsh-typert-loader": "Typert loader → wire protocol layer",
    "dsh-typert-registry": "Typert registry → wire protocol layer",
    "dsh-session-projection-cache": "persistent projection cache → replicatedState",
}

# E 删 — DSH product identity / web product surface / cordis meta-framework
E_META = {
    "cordis", "cordis-plugin-group", "cordis-plugin-loader", "cordis-plugin-hmr",
    "cordis-plugin-include", "cordis-plugin-timer", "schemastery", "cosmokit",
    "dsh", "dsh-base", "dsh-app-boot", "dsh-cmdline", "dsh-headless",
    "dsh-launch-environment", "dsh-persona", "dsh-anonymous-user-id", "dsh-scope",
    "dsh-host-plugin-inventory", "dsh-cordis-host-runner", "dsh-cordis-client-runner",
    "dsh-tool-cordis", "dsh-brand",
}
E_WEB_EXACT = {"dsh-web-frontend", "dsh-web-app", "dsh-host-frontend-static", "dsh-host-webserver"}


def classify(name: str) -> tuple[str, str]:
    if name in A:
        return "A", A[name]
    if name in B:
        return "B", B[name]
    if name in C:
        return "C", C[name]
    if name in E_META:
        return "E", "cordis meta-framework / DSH product identity — stays in dsh body"
    if name in E_WEB_EXACT or name.startswith("dsh-client-ui-"):
        return "E", "web product surface — stays in dsh body (R8: web_ui is a dsh capability)"
    return "D", "mechanism valid, seam rewired — rewritten on host/pi seams (M1-M6)"


def main() -> int:
    inventory_path = sys.argv[1]
    check = "--check" in sys.argv
    inventory = json.loads(Path(inventory_path).read_text(encoding="utf-8"))
    names = [p["package"] for p in inventory]

    defaulted = [n for n in names if n not in A and n not in B and n not in C
                 and n not in E_META and n not in E_WEB_EXACT
                 and not n.startswith("dsh-client-ui-")]
    if defaulted and not check:
        print(f"# {len(defaulted)} packages default to D (rewrite):")
        for n in sorted(defaulted):
            print(f"#   {n}")

    rows = [
        {"package": n, "class": cls, "note": note}
        for n in sorted(names)
        for cls, note in [classify(n)]
    ]

    if check:
        committed = json.loads(OUT.read_text(encoding="utf-8"))
        got = {r["package"]: r["class"] for r in committed["packages"]}
        want = {r["package"]: r["class"] for r in rows}
        missing = sorted(set(want) - set(got))
        extra = sorted(set(got) - set(want))
        drift = sorted(n for n in want if n in got and got[n] != want[n])
        if missing or extra or drift:
            print(f"FAIL missing={missing} extra={extra} drift={drift}")
            return 1
        counts = {c: sum(1 for r in rows if r["class"] == c) for c in "ABCDE"}
        print(f"OK {len(committed['packages'])} packages covered: {counts}")
        return 0

    doc = {
        "generated_by": "scripts/m5_disposition_build.py",
        "source_inventory": inventory_path,
        "classes": {
            "A": "port mechanism into host/",
            "B": "adapt seam contract to host contract; impl stays in dsh body",
            "C": "rebuild on Chord service/facet/replicatedState",
            "D": "rewrite on host/pi seams (mechanism valid, seam changed)",
            "E": "drop — DSH product identity / web surface / cordis meta",
        },
        "packages": rows,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    counts = {c: sum(1 for r in rows if r["class"] == c) for c in "ABCDE"}
    print(f"wrote {OUT} — {len(rows)} packages: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
