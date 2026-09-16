#!/usr/bin/env python3
"""m5_cordis_scan.py — Cordis service inventory for the M5 disposition matrix.

Scans a DSH install tree's @deepseek-ai packages (top-level + nested under
dsh/node_modules) and extracts, per package:
  - package name / description
  - declared cordis services (Service subclass names, ctx.provide/inject keys)
  - injected dependencies (service-level coupling)
  - whether it registers CLI commands / web UI / channels

Output: JSON inventory to stdout; the disposition matrix is authored from it.
Read-only audit tool — never writes into the scanned tree.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SERVICE_DECL = re.compile(
    r"class\s+(\w+)\s+extends\s+(?:Service|Context\.Service|cordis\.Service)"
)
INJECT = re.compile(r"(?:inject|depends|using)\s*[:=]\s*\[([^\]]*)\]", re.S)
INJECT_ITEM = re.compile(r"['\"]([\w.-]+)['\"]")
PROVIDE = re.compile(r"(?:ctx\.provide|Context\.service|\.service)\s*\(?\s*['\"]([\w.-]+)['\"]")
NAME_KEY = re.compile(r"(?:name|key)\s*=\s*['\"]([\w.-]+)['\"]")


def scan_package(pkg_dir: Path) -> dict:
    info = {"package": pkg_dir.name, "dir": str(pkg_dir), "description": "",
            "services": [], "injects": set(), "provides": set(),
            "has_commands": False, "has_ui": False, "loc_js": 0}
    pj = pkg_dir / "package.json"
    if pj.exists():
        try:
            meta = json.loads(pj.read_text(encoding="utf-8", errors="replace"))
            info["description"] = meta.get("description", "")
            info["version"] = meta.get("version", "")
        except Exception:
            pass
    src = list(pkg_dir.glob("**/*.js")) + list(pkg_dir.glob("**/*.ts"))
    # exclude nested node_modules INSIDE the package (the package itself lives
    # under a node_modules dir — that part is fine)
    src = [p for p in src if ".d.ts" not in p.name
           and "node_modules" not in p.relative_to(pkg_dir).parts]
    for f in src[:400]:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        info["loc_js"] += text.count("\n")
        for m in SERVICE_DECL.finditer(text):
            info["services"].append(m.group(1))
        for m in INJECT.finditer(text):
            info["injects"].update(INJECT_ITEM.findall(m.group(1)))
        info["provides"].update(PROVIDE.findall(text))
        low = f.name.lower()
        if "command" in low:
            info["has_commands"] = True
        if any(k in low for k in ("ui", "view", "component", "page", "web")):
            info["has_ui"] = True
    info["injects"] = sorted(info["injects"])
    info["provides"] = sorted(info["provides"])
    info["services"] = sorted(set(info["services"]))
    return info


def main(root: str) -> None:
    base = Path(root)
    seen = set()
    out = []
    roots = [
        base / "node_modules" / "@deepseek-ai",
        base / "node_modules" / "@deepseek-ai" / "dsh" / "node_modules" / "@deepseek-ai",
    ]
    for r in roots:
        if not r.exists():
            continue
        for pkg in sorted(r.iterdir()):
            if not pkg.is_dir() or pkg.name in seen:
                continue
            seen.add(pkg.name)
            out.append(scan_package(pkg))
    json.dump(out, sys.stdout, indent=1, ensure_ascii=True)
    print(f"\n# scanned {len(out)} packages", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
