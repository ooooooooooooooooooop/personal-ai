#!/usr/bin/env python3
"""Governed content write inside an already-held mutation lease.

`canonical_writer.py with-lease` holds a lease and injects its ids into the
child environment, but it offers no way to perform a *receipted* write:
`personal_ai_sync.controlled_write_file` needs a lock object, and constructing
a fresh one would acquire a second lease. For hooks the repo already exposes
`CanonicalMutationLock.from_metadata` ("rehydrate a live lease for hooks
without creating a second lock"); this CLI wires that to the controlled write,
so a governed slice can be edited directly and still leave behind the
write-time receipt that the commit gate demands.

Invoked under the lease:

    canonical_writer.py with-lease --path <rel> -- \
        python scripts/governance/governed_write.py <rel> <content-file>

Exits non-zero and writes nothing unless a live lease exists AND the ids in
this process's environment match it (i.e. this process really is the holder).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import personal_ai_sync as pas  # noqa: E402


def _fail(code: str, detail: str) -> int:
    print(f"{code}: {detail}", file=sys.stderr)
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description="receipted write under an active lease")
    ap.add_argument("rel_path", help="repo-relative path to write")
    ap.add_argument("content_file", help="file holding the exact new content")
    args = ap.parse_args()

    rel = Path(args.rel_path).as_posix().removeprefix("./")

    lease = pas.read_active_mutation_lease(REPO_ROOT, lock_root=pas.MUTATION_LOCK_ROOT)
    if not lease or not lease.get("active"):
        return _fail("GOVERNED_WRITE_NO_LEASE", "no live shared lease exists")

    want_lease = os.environ.get("PERSONAL_AI_MUTATION_LEASE_ID")
    want_run = os.environ.get("PERSONAL_AI_MUTATION_RUN_ID")
    if not want_lease or not want_run:
        return _fail(
            "GOVERNED_WRITE_NO_BINDING",
            "run this under `canonical_writer.py with-lease` (lease ids missing from env)",
        )
    if lease.get("mutation_lease_id") != want_lease or lease.get("run_id") != want_run:
        return _fail(
            "GOVERNED_WRITE_LEASE_MISMATCH",
            f"active lease {lease.get('mutation_lease_id')}/{lease.get('run_id')} "
            f"is not bound to this process {want_lease}/{want_run}",
        )

    try:
        lock = pas.CanonicalMutationLock.from_metadata(
            lease, lock_root=pas.MUTATION_LOCK_ROOT
        )
        content = Path(args.content_file).read_text(encoding="utf-8")
        receipt_path, payload = pas.controlled_write_file(lock, rel, content)
    except pas.MutationOwnershipError as exc:
        return _fail(exc.code, str(exc))

    print(f"GOVERNED_WRITE_OK {rel} -> {receipt_path}")
    print(f"  post_write_sha256={payload['post_write_sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
