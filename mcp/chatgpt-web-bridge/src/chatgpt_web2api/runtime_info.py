"""Browser-free identity of the code snapshot that started this process."""
from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path

from . import __version__

_SOURCE_ROOT = Path(__file__).resolve().parent
_STARTED_AT = datetime.now(timezone.utc).isoformat()
CONTRACT_VERSION = "2026-09-19.2"


def source_fingerprint(root: Path = _SOURCE_ROOT) -> str | None:
    """Hash package sources, independent of installation path and CRLF."""
    digest = hashlib.sha256()
    try:
        paths = sorted(root.glob("*.py"))
        if not paths:
            return None
        for path in paths:
            digest.update(path.name.encode("utf-8") + b"\0")
            digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
            digest.update(b"\0")
    except OSError:
        return None
    return digest.hexdigest()


# Frozen at import. Never substitute the current disk hash for this value.
_STARTUP_SOURCE_FINGERPRINT = source_fingerprint()


def get_runtime_info() -> dict:
    disk = source_fingerprint()
    known = _STARTUP_SOURCE_FINGERPRINT is not None and disk is not None
    return {
        "package_version": __version__,
        "contract_version": CONTRACT_VERSION,
        "pid": os.getpid(),
        "started_at": _STARTED_AT,
        "startup_source_fingerprint": _STARTUP_SOURCE_FINGERPRINT,
        "disk_source_fingerprint": disk,
        "restart_required": disk != _STARTUP_SOURCE_FINGERPRINT if known else None,
        "capabilities": [
            "bounded_tool_requests", "stage_progress", "tail_read",
            "cancellation_aware_reads", "explicit_model_fail_closed",
            "no_retry_after_possible_submission",
            "bounded_pre_submit_reconnect", "receipt_first_timeout_recovery",
            "shared_recovery_budget", "socket_bound_readers",
            "bounded_backend_reads", "typed_backend_failures",
        ],
    }
