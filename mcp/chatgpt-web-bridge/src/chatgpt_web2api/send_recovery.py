"""One request-scoped recovery, only before a submission can have happened."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from websockets.exceptions import ConnectionClosed, InvalidState

from .cdp_transport import CDPTimeoutError
from .composer_surface import ComposerReadinessError, recover_composer


@dataclass
class RecoveryBudget:
    driver: object
    attempts: int = 0


_budget: ContextVar[RecoveryBudget | None] = ContextVar("send_recovery_budget", default=None)


@contextmanager
def recovery_scope(driver):
    """Nested handler/stream scopes share one allowance, never one each."""
    current = _budget.get()
    if current is not None and current.driver is driver:
        yield current
        return
    token = _budget.set(RecoveryBudget(driver))
    try:
        yield _budget.get()
    finally:
        _budget.reset(token)


def is_recoverable_transport_error(exc: Exception) -> bool:
    # A deadline/cancellation, permission denial or arbitrary JS failure does
    # not establish that reconnecting is appropriate.
    if isinstance(exc, PermissionError):
        return False
    if isinstance(exc, CDPTimeoutError):
        return exc.method == "Runtime.evaluate"
    if isinstance(exc, (ConnectionClosed, ConnectionError)):
        return True
    return isinstance(exc, InvalidState) and "closed" in str(exc).lower()


def claim_transport_recovery(driver, method: str, timeout: float | None) -> None:
    """The poison gate and send wrapper share ONE pre-submit allowance.

    Receipt reads after possible submission may reattach under their own read
    deadline; they never replay the send and don't consume a pre-submit retry.
    """
    budget = _budget.get()
    if budget is None or budget.driver is not driver:
        return
    if driver.delivery_metadata.get("delivery_stage") != "not_started":
        return
    if budget.attempts:
        error = CDPTimeoutError(method, timeout, phase="recovery_exhausted")
        driver._annotate_delivery_error(error)
        error.recovery_attempts = budget.attempts
        raise error
    budget.attempts += 1


async def recover_before_submission(driver, exc, budget, on_progress=None) -> bool:
    driver._annotate_delivery_error(exc)
    exc.recovery_attempts = budget.attempts
    composer_failure = isinstance(exc, ComposerReadinessError) and exc.recovery_eligible
    if not composer_failure and not is_recoverable_transport_error(exc):
        return False
    if driver.delivery_metadata.get("delivery_stage") != "not_started" or budget.attempts:
        return False
    # Consume BEFORE awaiting; failed/cancelled recovery cannot get a second
    # allowance from an outer handler or rate-limit wrapper.
    budget.attempts += 1
    phase = "restore_composer_before_submission" if composer_failure else "reconnect_before_submission"
    await driver._notify_send_progress(on_progress, f"{phase} (attempt 1/1, budget 15s)")
    try:
        if composer_failure:
            await recover_composer(driver, exc)
        else:
            await driver.reconnect_for_send_recovery()
    except Exception as recovery_error:
        driver._annotate_delivery_error(recovery_error)
        recovery_error.recovery_attempts = budget.attempts
        if composer_failure and not hasattr(recovery_error, "readiness"):
            recovery_error.readiness = {
                "reason": "permission_denied" if isinstance(recovery_error, PermissionError) else "recovery_failed",
            }
        raise recovery_error from exc
    return True


async def run_with_send_recovery(driver, factory, on_progress=None):
    """Wrap a whole preflight+send handler, preserving its binding gates."""
    with recovery_scope(driver) as budget:
        driver._reset_delivery_metadata()
        while True:
            try:
                return await factory()
            except Exception as exc:
                driver._annotate_delivery_error(exc)
                if not await recover_before_submission(driver, exc, budget, on_progress):
                    raise
