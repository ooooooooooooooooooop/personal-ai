#!/usr/bin/env python3
"""Delta-gate planner for .githooks/pre-commit — snapshot edition.

The hook freezes the staged index into an immutable candidate tree
(``git write-tree``) and materializes it; this planner then maps the
frozen diff ``BASE..TREE`` to the checks that can observe it. Because
both the change list and the checked content come from git objects —
never from the live index or working tree — the plan is one consistent
snapshot of exactly what will be committed.

Modes: the schema is identical either way; FULL merely expands every
task set to its universe. The executor does not distinguish modes —
``tasks(delta) ⊆ tasks(full)`` holds by construction.

    {
      "mode": "DELTA" | "FULL",
      "reasons": [...],            # why FULL (audit trail)
      "compile": [...],            # tracked .py present in TREE
      "unittest": [...],           # tests/test_*.py present in TREE
      "mcp_suites": [...]          # mcp/<name>/tests dirs
    }

Fail-closed rules (any hit → FULL):
  * gate machinery / registries / CI config (TRIGGER_PREFIXES)
  * paths outside every known published layer (unknown:)
  * unknown/again git statuses (U/X/B/...), unmerged paths
  * test-inventory changes: deleted or renamed tests/test_*.py
  * changed .py containing opaque dynamic imports
    (importlib.import_module / __import__) — blast radius unknowable

Test selection: static import graph over the candidate tree via ast —
transitive reverse closure from each changed module to tests/test_*.py
(direct-only matching misses test→A→B chains). ``__init__.py`` maps to
its package path, since importing a submodule executes all parent
inits. Deletions keep producing reverse-dependency effects via a plain
text import scan of the test sources (a deleted module's name still
appears in the import lines of its dependents). Files containing
dynamic imports mark their transitive dependents always-run.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from pathlib import Path

# Paths whose change invalidates the incremental argument itself: the
# gate machinery, shared registries, CI config, and runtime
# scaffolding. Mirrored in .githooks/pre-commit's bootstrap classifier —
# the mode decision for gate paths must not depend on the candidate
# planner (which may itself be the modified file under evaluation).
TRIGGER_PREFIXES = (
    ".githooks/",
    ".github/workflows/",
    "scripts/gate_planner.py",
    "scripts/validate_repo.py",
    "scripts/governance/",
    "scripts/publish_check.py",
    "scripts/run_skill_evals.py",
    "scripts/sync_skills.py",
    "skills/skill-quality-gate/",
    "skills.json",
    "mcp.json",
    "pyproject.toml",
    "package.json",
    "package-lock.json",
    "requirements",
)

# JS-only dirs have no python import edge into tests/, but dsh behavior
# is exercised by these suites through config contracts — keep explicit.
UNITS_BY_PREFIX = {
    "dsh/": [
        "tests/test_dsh_compatibility.py",
        "tests/test_dsh_lifecycle.py",
        "tests/test_dsh_runtime.py",
        "tests/test_dsh_source_state.py",
    ],
}

MCP_SUITES_ALL = ["mcp/agent-switchboard/tests"]

# Published layers. Anything tracked outside these prefixes is
# unrecognized surface → fail-closed FULL.
KNOWN_PLAIN_PREFIXES = (
    "skills/",
    "mcp/",
    "host/",
    "pi/",
    "dsh/",
    "app/",
    "soul/",
    "docs/",
    "research/",
    "tests/",
    "scripts/",
    "_template/",
)

TEST_RE = re.compile(r"^tests/test_.*\.py$")


class Change:
    __slots__ = ("status", "path", "old_path")

    def __init__(self, status: str, path: str, old_path: str | None = None):
        self.status = status          # A M D T R C U X B or "?"
        self.path = path              # post-image path (new name for R)
        self.old_path = old_path      # pre-image path for R/C only


_STATUS_RE = re.compile(r"^[ACDMRTUXB?]\d*$")


def parse_name_status(ztext: str) -> list[Change]:
    """Parse `git diff --name-status -z` output.

    With -z every field is NUL-separated: ``STATUS\\0PATH\\0`` for
    ordinary entries and ``STATUS\\0OLD\\0NEW\\0`` for renames/copies
    (the status token carries a score suffix, e.g. ``R100``).
    """
    out: list[Change] = []
    toks = [t for t in ztext.split("\0") if t != ""]
    i = 0
    while i < len(toks):
        status = toks[i]
        i += 1
        if not _STATUS_RE.match(status):
            out.append(Change("?", status))
            continue
        letter = status[:1]
        if letter in ("R", "C"):
            old = toks[i] if i < len(toks) else ""
            new = toks[i + 1] if i + 1 < len(toks) else ""
            i += 2
            out.append(Change(letter, new, old))
        else:
            path = toks[i] if i < len(toks) else ""
            i += 1
            out.append(Change(letter, path))
    return out


def _dotted(path: str) -> str:
    """Repo-relative .py path → full dotted module name.

    ``scripts/memory/provider.py``        → ``scripts.memory.provider``
    ``scripts/workspace/__init__.py``     → ``scripts.workspace``
    """
    stem = path[:-3] if path.endswith(".py") else path
    if stem.endswith("/__init__"):
        stem = stem[: -len("/__init__")]
    return stem.replace("/", ".")


def _suffix_names(dotted: str) -> set[str]:
    """Every dotted suffix tests might import — over-matching is safe."""
    parts = dotted.split(".")
    return {".".join(parts[i:]) for i in range(len(parts))}


def _has_dynamic_import(tree: ast.AST) -> bool:
    """Opaque dynamic loading: importlib.import_module / __import__."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr == "import_module":
                return True
            if isinstance(f, ast.Name) and f.id == "__import__":
                return True
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "importlib" or a.name.startswith("importlib."):
                    # `import importlib` alone is fine; only the call is
                    # opaque — handled above. Keep walking.
                    continue
    return False


def _import_names(src: str) -> tuple[list[tuple[str, int, list[str]]], bool]:
    """(module, level, imported-names) tuples + dynamic-import flag."""
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        return [], True  # unparseable → treat as opaque (fail-closed)
    out: list[tuple[str, int, list[str]]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend((a.name, 0, []) for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            names = [a.name for a in node.names]
            out.append((node.module or "", node.level or 0, names))
    return out, _has_dynamic_import(tree)


def build_graph(
    src_root: Path, py_files: list[str]
) -> tuple[dict[str, set[str]], dict[str, set[str]], set[str]]:
    """Static import graph over the candidate snapshot.

    Returns (name_index, fwd_edges, dyn_files):
      name_index  — dotted suffix → {file paths}
      fwd_edges   — file → {files it may import}
      dyn_files   — files with opaque dynamic imports / unparseable
    """
    name_index: dict[str, set[str]] = {}
    dotted_of: dict[str, str] = {}
    for path in py_files:
        d = _dotted(path)
        dotted_of[path] = d
        for suffix in _suffix_names(d):
            name_index.setdefault(suffix, set()).add(path)

    def resolve(name: str) -> set[str]:
        return name_index.get(name, set())

    def resolve_from(base_pkg: str, names: list[str]) -> set[str]:
        hits = set(resolve(base_pkg)) if base_pkg else set()
        for n in names:
            if n == "*":
                prefix = base_pkg + "." if base_pkg else ""
                hits.update(
                    f for f, d in dotted_of.items()
                    if d == base_pkg or d.startswith(prefix)
                )
            else:
                hits.update(resolve(f"{base_pkg}.{n}" if base_pkg else n))
        return hits

    fwd: dict[str, set[str]] = {}
    dyn: set[str] = set()
    for path in py_files:
        try:
            src = (src_root / path).read_text(encoding="utf-8",
                                              errors="replace")
        except OSError:
            continue
        imports, is_dyn = _import_names(src)
        if is_dyn:
            dyn.add(path)
        edges: set[str] = set()
        pkg = dotted_of[path]
        if not path.endswith("/__init__.py"):
            pkg = pkg.rpartition(".")[0]  # enclosing package
        for mod, level, names in imports:
            if level:
                parts = pkg.split(".") if pkg else []
                keep = max(len(parts) - (level - 1), 0)
                base = ".".join(parts[:keep])
                if mod:
                    base = f"{base}.{mod}" if base else mod
                edges |= resolve_from(base, names)
            else:
                edges |= resolve_from(mod, names)
                # `import a.b.c` also executes a/__init__ and a.b/__init__
                segs = mod.split(".")
                for k in range(1, len(segs)):
                    edges |= resolve(".".join(segs[:k]))
        edges.discard(path)
        fwd[path] = edges
    return name_index, fwd, dyn


def _reverse_closure(fwd: dict[str, set[str]], starts: set[str]) -> set[str]:
    rev: dict[str, set[str]] = {}
    for src, dsts in fwd.items():
        for d in dsts:
            rev.setdefault(d, set()).add(src)
    seen = set(starts)
    stack = list(starts)
    while stack:
        for dep in rev.get(stack.pop(), ()):
            if dep not in seen:
                seen.add(dep)
                stack.append(dep)
    return seen


def _tests_text_scan(
    src_root: Path, test_files: list[str], names: set[str]
) -> set[str]:
    """Tests whose import lines mention any name — catches dependents of
    deleted modules (absent from the tree's import graph) and any other
    residual static-import escape."""
    pats = [
        re.compile(rf"(?:^|\s)(?:import|from)\s+{re.escape(n)}(?:\.|\s|$)")
        for n in names
    ]
    hits: set[str] = set()
    for tf in test_files:
        try:
            src = (src_root / tf).read_text(encoding="utf-8",
                                            errors="replace")
        except OSError:
            continue
        if any(p.search(src) for p in pats):
            hits.add(tf)
    return hits


def _universe(tree_files: set[str]) -> tuple[list[str], list[str]]:
    py = sorted(p for p in tree_files if p.endswith(".py"))
    tests = sorted(p for p in tree_files if TEST_RE.match(p))
    return py, tests


def _full(reasons: list[str], tree_files: set[str]) -> dict:
    py, tests = _universe(tree_files)
    return {
        "mode": "FULL",
        "reasons": sorted(set(reasons)),
        "compile": py,
        "unittest": tests,
        "mcp_suites": list(MCP_SUITES_ALL),
    }


def plan(
    changes: list[Change],
    tree_files: set[str],
    src_root: Path,
    *,
    force_full: bool = False,
) -> dict:
    if force_full:
        return _full(["--force-full (bootstrap classifier)"], tree_files)

    reasons: list[str] = []
    compile_set: set[str] = set()
    unittest_set: set[str] = set()
    mcp_suites: set[str] = set()

    py_files = sorted(p for p in tree_files if p.endswith(".py"))
    test_files = sorted(p for p in tree_files if TEST_RE.match(p))
    name_index, fwd, dyn = build_graph(src_root, py_files)

    # Tests depending (transitively) on opaque dynamic modules can never
    # be excluded by a static plan — the graph is provably incomplete
    # around them. They run on every DELTA.
    always_run = {
        t for t in _reverse_closure(fwd, set(dyn)) if TEST_RE.match(t)
    }
    # Test files performing dynamic imports themselves: same rule.
    always_run |= {t for t in test_files if t in dyn}
    unittest_set |= always_run

    affected_paths: set[str] = set()
    names_for_text_scan: set[str] = set()

    for ch in changes:
        paths = [ch.path] + ([ch.old_path] if ch.old_path else [])
        if ch.status in ("U", "X", "B", "?") or ch.status not in (
            "A", "C", "D", "M", "R", "T",
        ):
            reasons.append(f"status:{ch.status}:{ch.path}")
            continue
        for p in paths:
            if not p:
                continue
            p = p.replace("\\", "/")
            if any(p.startswith(t) for t in TRIGGER_PREFIXES):
                reasons.append(p)
                continue
            if not any(p.startswith(k) for k in KNOWN_PLAIN_PREFIXES):
                reasons.append(f"unknown:{p}")
                continue
            # Deleted/renamed-out test files shrink the inventory
            # silently — a structural change the delta plan cannot price.
            if TEST_RE.match(p) and (
                ch.status == "D" or (ch.status == "R" and p == ch.old_path)
            ):
                reasons.append(f"test-inventory:{p}")
                continue
            if p.endswith(".py"):
                if p in tree_files:
                    compile_set.add(p)
                    affected_paths.add(p)
                # Present or deleted: the module's names still map
                # dependents via the text scan.
                names_for_text_scan |= _suffix_names(_dotted(p))
                if p in dyn:
                    reasons.append(f"dynamic-import:{p}")
            if TEST_RE.match(p) and p in tree_files:
                unittest_set.add(p)
            for prefix, tests in UNITS_BY_PREFIX.items():
                if p.startswith(prefix):
                    unittest_set.update(t for t in tests if t in tree_files)
            if p.startswith("mcp/agent-switchboard/"):
                mcp_suites.add("mcp/agent-switchboard/tests")

    if reasons:
        return _full(reasons, tree_files)

    # Transitive reverse closure: every test that can reach a changed
    # module through the import graph.
    unittest_set |= {
        t for t in _reverse_closure(fwd, affected_paths)
        if TEST_RE.match(t)
    }
    # Text scan over test sources: covers deleted modules and any name
    # the AST graph could not resolve.
    unittest_set |= _tests_text_scan(src_root, test_files,
                                     names_for_text_scan)

    return {
        "mode": "DELTA",
        "reasons": [],
        "compile": sorted(compile_set),
        "unittest": sorted(unittest_set),
        "mcp_suites": sorted(mcp_suites),
    }


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=True,
    ).stdout


def _load_snapshot(repo: Path, base: str, tree: str):
    out = _git(repo, "diff", "--name-status", "-z", base, tree)
    files = set(filter(None, _git(
        repo, "ls-tree", "-r", "--name-only", tree).split("\n")))
    return parse_name_status(out), files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="BASE commit oid (frozen diff start)")
    ap.add_argument("--tree", help="TREE oid of the candidate snapshot")
    ap.add_argument("--repo", help="git object source (default: the "
                                 "repo containing this script)")
    ap.add_argument("--src", help="materialized candidate dir "
                                "(defaults to repo worktree)")
    ap.add_argument("--files", nargs="*", default=None,
                    help="explicit file list — dry runs only, "
                         "all treated as modified")
    ap.add_argument("--force-full", action="store_true",
                    help="bootstrap already decided FULL — emit the "
                         "universe plan without further analysis")
    ap.add_argument("--field",
                    choices=("mode", "compile", "unittest",
                             "mcp_suites", "reasons"),
                    help="print just that field, one item per line")
    args = ap.parse_args()

    repo = (Path(args.repo).resolve() if args.repo
            else Path(__file__).resolve().parent.parent)
    src_root = Path(args.src) if args.src else repo

    if args.base and args.tree:
        changes, tree_files = _load_snapshot(repo, args.base, args.tree)
    elif args.files is not None:
        changes = [Change("M", f) for f in args.files]
        try:
            tree_files = set(filter(None, _git(
                repo, "ls-files").split("\n")))
        except Exception:
            # Dry-run without a git repo (e.g. inside a materialized
            # snapshot): approximate the universe from the filesystem.
            tree_files = {
                str(p.relative_to(src_root)).replace("\\", "/")
                for p in src_root.rglob("*")
                if p.is_file() and not any(
                    part.startswith(".")
                    for part in p.relative_to(src_root).parts
                )
            }
        for c in changes:
            tree_files.add(c.path)
    else:
        ap.error("need --base/--tree or --files")

    result = plan(changes, tree_files, src_root,
                  force_full=args.force_full)
    if args.field:
        value = result[args.field]
        for item in value if isinstance(value, list) else [value]:
            print(item)
        return 0
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
