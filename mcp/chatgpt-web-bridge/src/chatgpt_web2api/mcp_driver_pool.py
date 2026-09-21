"""B1: MCP session-affine CDPDriver pool.

A lazy, bounded, session-affine pool of ``CDPDriver`` instances for MCP SSE.
In pool mode, MCP startup does NOT connect to Chrome. The first explicit
browser-affecting request for an MCP session materializes one owned
``CDPDriver``/tab. Later requests from the same session reuse that driver.
Different sessions receive different owned tabs, capped by pool size.

Design (peer-reviewed, implementation-ready per B1 spec):
  - Three slot states: PENDING → ACTIVE → CLOSING → DISOWNED.
  - Lock ordering: pool_lock → meta_lock (never reversed).
  - call_lock serializes ALL operations per session (reads + mutations).
  - Capacity is a hard cap on active + pending + closing slots.
  - A closing slot counts against capacity until driver.close() completes.
  - acquire() returns a sync _LeaseContext; the async logic is in _acquire_slot().
  - No driver.close() while pool_lock is held.
  - Idle sweeper marks closing but doesn't free capacity until close completes.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# P1.5: cap for lease history records (prevents unbounded growth).
_LEASE_HISTORY_LIMIT = 100

# Sweeper health probe: an idle slot whose sanity evaluate fails this many
# CONSECUTIVE sweeps is dead by definition — its own recovery probe failing
# means in-band recovery cannot heal it (2026-09-19 incident: a poisoned
# session whose reader leaked held its slot until process restart; the TTL
# sweeper never reclaimed it). Force-reaping frees the slot so the next
# acquire materializes a fresh driver — the bounded, automatic heal.
_FORCE_REAP_PROBE_FAILURES = 2

# Slot key shared by every non-chat (read/maintenance) tool. Its tab is an
# owned scratch tab: sweeping it closes the tab, and the next read tool pays a
# full chatgpt.com page load (unpaced backend traffic) to recreate it — so it
# is pinned: exempt from the idle-TTL sweep. Conversation-bound slots are not
# pinned; their tabs persist on their own and re-materializing is an adopt.
UTILITY_SLOT_KEY = "utility"
PINNED_SLOT_KEYS = frozenset({UTILITY_SLOT_KEY})


# ── Errors ────────────────────────────────────────────────────────────────

class PoolExhaustedError(RuntimeError):
    """Pool is full after acquire_timeout.

    Carries a default human-readable message (mirroring RateLimitError /
    AuthExpiredError in cdp_driver.py) so the MCP error-formatter can't
    surface an empty diagnostic. The bare ``raise PoolExhaustedError()``
    sites below now render as
    ``"PoolExhaustedError: no driver slot available within acquire_timeout.
    Retry later."`` rather than ``": . Retry later."``.

    P1.5: carries an optional ``active_leases`` dump so the error message
    names the sessions holding slots at exhaustion time.
    """

    def __init__(self, message: str | None = None, active_leases: list[str] | None = None) -> None:
        if message is None:
            message = "no driver slot available within acquire_timeout"
        if active_leases:
            message = f"{message} (active: {', '.join(active_leases)})"
        super().__init__(message)


class PoolShuttingDownError(RuntimeError):
    """Pool is shutting down; no new slots can be created."""

    def __init__(self, message: str | None = None) -> None:
        if message is None:
            message = "driver pool is shutting down; no new slots can be created"
        super().__init__(message)


class PoolSlotUnavailableError(RuntimeError):
    """A materialized slot's driver disappeared (race during shutdown)."""


# ── Account throttle breaker ──────────────────────────────────────────────

class AccountThrottleBreaker:
    """Pool-wide breaker that pauses mutations on account-throttle signals.

    Does NOT block reads. Does NOT handle CAPTCHA, hard account lock, or ban.
    Those require distinct failure modes.
    """

    def __init__(self, cooldown_seconds: float) -> None:
        self._cooldown = cooldown_seconds
        self._tripped_until: float | None = None
        self._lock = asyncio.Lock()

    def is_tripped(self) -> bool:
        return (
            self._tripped_until is not None
            and time.monotonic() < self._tripped_until
        )

    async def trip(self) -> None:
        async with self._lock:
            self._tripped_until = time.monotonic() + self._cooldown
        logger.warning(
            "Account-level throttle signal observed; pausing mutating MCP calls "
            "pool-wide for %.0fs (mcp_account_throttled)",
            self._cooldown,
        )

    def reset(self) -> None:
        self._tripped_until = None


# ── Slot ──────────────────────────────────────────────────────────────────

@dataclass
class DriverSlot:
    """One session's slot in the pool. Transitions: PENDING → ACTIVE → CLOSING → DISOWNED.

    State is determined by the combination of fields (see B1 §2 state table):
      PENDING:  driver=None, ready_event unset, closing=False
      ACTIVE:   driver set, ready_event set, closing=False
      CLOSING:  closing=True (driver may be set or None; still counts vs capacity)
      DISOWNED: removed from _slots and _active_keys (not reachable)
    """
    session_key: str
    driver: Any | None  # CDPDriver | None
    breakers: Any  # BreakerRegistry
    meta_lock: asyncio.Lock
    call_lock: asyncio.Lock
    ready_event: asyncio.Event
    materialize_error: Exception | None = None
    created_at: float = 0.0
    last_used_at: float = 0.0
    in_flight: int = 0
    closing: bool = False
    probe_failures: int = 0
    # A closing slot may overlap a replacement slot with the same key.
    # Serialise close so the sweeper and shutdown cannot close it twice.
    close_lock: asyncio.Lock | None = None


# ── P1.5: Lease accounting records ────────────────────────────────────────

@dataclass
class LeaseRecord:
    """P1.5: per-lease lifecycle record for diagnostics.

    Created at acquire time, completed at release time with hold duration
    and release reason. Stored in the pool's ``_lease_history`` (capped)
    for post-hoc RCA. This is pure instrumentation — it does NOT influence
    pool behavior (capacity, eviction, blocking).
    """
    lease_id: str
    session_key: str
    acquired_at: float
    released_at: float | None = None
    hold_duration_s: float | None = None
    release_reason: str | None = None  # "normal" | "exception" | "cancellation"
    # Session keys can be rebound while an old slot is closing.  Use the
    # physical slot identity when checking for stale in_flight counts.
    slot_identity: int = 0



# ── Lease ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DriverLease:
    """Plain carrier for a leased driver. Does NOT implement __aenter__/__aexit__."""
    slot: DriverSlot
    driver: Any  # CDPDriver
    breakers: Any  # BreakerRegistry
    call_lock: asyncio.Lock
    lease_id: str = ""  # P1.5: correlates to a LeaseRecord for diagnostics


class _LeaseContext:
    """Async context manager wrapper. acquire() returns this (not a coroutine).

    Avoids the runtime bug where ``async with pool.acquire()`` would try to use
    a coroutine object as an async context manager.
    """

    def __init__(self, pool: McpSessionDriverPool, session_key: str) -> None:
        self._pool = pool
        self._session_key = session_key
        self._lease: DriverLease | None = None

    async def __aenter__(self) -> DriverLease:
        self._lease = await self._pool._acquire_slot(self._session_key)
        return self._lease

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._lease is None:
            return
        # P1.5: classify the release reason for lease accounting.
        if exc_type is None:
            reason = "normal"
        elif issubclass(exc_type, asyncio.CancelledError):
            reason = "cancellation"
        else:
            reason = "exception"
        release_task = asyncio.create_task(
            self._pool._release(
                self._lease.slot,
                lease_id=self._lease.lease_id,
                release_reason=reason,
            )
        )
        try:
            await asyncio.shield(release_task)
        except asyncio.CancelledError:
            # Context-manager cleanup must complete before propagating the
            # request cancellation; otherwise the lease record and count can
            # diverge and pin a pool slot indefinitely.
            try:
                await asyncio.shield(release_task)
            except asyncio.CancelledError:
                pass
            raise
        finally:
            self._lease = None


# ── Pool ──────────────────────────────────────────────────────────────────

class McpSessionDriverPool:
    """Lazy, bounded, session-affine pool of CDPDriver instances.

    Owned by the MCP server (mcp_server.py). The pool creates drivers on demand
    (lazy materialization), one per session key, bounded by pool_size. Idle
    slots are swept after TTL. The account throttle breaker pauses mutations
    pool-wide on account-throttle signals.
    """

    def __init__(
        self,
        config: Any,  # Config
        *,
        transport: str = "sse",
        port: int = 8090,
        driver_factory: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        cfg = config.chatgpt
        self._max_size = cfg.mcp_session_pool_size
        self._ttl = cfg.mcp_session_pool_ttl_seconds
        self._acquire_timeout = cfg.mcp_session_pool_acquire_timeout
        self._sweep_interval = cfg.mcp_session_pool_sweep_interval_seconds
        self._create_sem = asyncio.Semaphore(cfg.mcp_session_pool_create_concurrency)
        self._config = config
        self._transport = transport
        self._port = port
        # Injectable factory for testing; None = real CDPDriver creation.
        self._driver_factory = driver_factory

        self._slots: dict[str, DriverSlot] = {}
        self._active_keys: set[str] = set()
        # _active_keys is a set of logical bindings.  A closing slot and its
        # replacement can share a key, so physical capacity is tracked here
        # separately to preserve the hard max-size invariant.
        self._capacity_slots: dict[int, DriverSlot] = {}
        self._pool_lock = asyncio.Lock()
        self._capacity_available = asyncio.Condition(self._pool_lock)
        self._shutting_down = False
        self._account_breaker = AccountThrottleBreaker(
            cfg.mcp_account_throttle_cooldown_seconds
        )
        self._sweep_task: asyncio.Task | None = None
        # P1.5: lease accounting. _active_leases maps lease_id → LeaseRecord
        # for currently-held leases; _lease_history is a capped list of
        # completed records. Pure diagnostics — no behavioral influence.
        self._active_leases: dict[str, LeaseRecord] = {}
        self._lease_history: list[LeaseRecord] = []

    @property
    def active_leases(self) -> dict[str, LeaseRecord]:
        """Currently-held leases (lease_id → LeaseRecord)."""
        return self._active_leases

    @property
    def lease_history(self) -> list[LeaseRecord]:
        """Completed lease records (most recent last, capped at _history_cap)."""
        return self._lease_history

    @property
    def account_breaker(self) -> AccountThrottleBreaker:
        return self._account_breaker

    def acquire(self, session_key: str) -> _LeaseContext:
        """Return a sync _LeaseContext (NOT async). Use as ``async with pool.acquire(key)``."""
        return _LeaseContext(self, session_key)

    async def start_sweeper(self) -> None:
        """Start the idle-slot sweeper background task."""
        if self._sweep_task is None or self._sweep_task.done():
            self._sweep_task = asyncio.create_task(self._sweep_idle())

    async def _create_driver(self, slot: DriverSlot) -> Any:
        """Create and connect a new CDPDriver for a slot. Injectable for testing.

        Passes slot.breakers into CDPDriver so driver failure sites record
        into the slot's breaker registry (PR #42 review fix #3).
        Derives instance_id from the session_key for per-session tab-registry
        identity (PR #42 review fix #4).
        """
        if self._driver_factory is not None:
            return await self._driver_factory(self._config, self._transport, self._port, slot)
        # Real path: construct + connect a CDPDriver.
        import hashlib
        import os

        from .cdp_driver import CDPDriver
        from .tab_registry import TabRegistry

        cfg = self._config
        # Per-session tab-registry identity, derived from session_key (fix #4).
        # W2A_INSTANCE_ID in pool mode: suffix with session hash so each slot
        # gets a distinct registry identity rather than collapsing to one.
        session_hash = hashlib.sha256(slot.session_key.encode()).hexdigest()[:12]
        if os.environ.get("W2A_INSTANCE_ID"):
            base = os.environ["W2A_INSTANCE_ID"]
            server_identity = f"{base}:session:{session_hash}"
        else:
            server_identity = f"mcp:{self._transport}:{self._port}:session:{session_hash}"
        instance_id = TabRegistry.derive_instance_id(
            cdp_port=cfg.chrome.cdp_port,
            server_identity=server_identity,
        )
        # Conversation-affine slots: keys of the form "conv:<id>" bind the
        # slot (and its tab) to that conversation rather than to a session —
        # one tab per conversation, shared across sessions and processes.
        conv_affinity = (
            slot.session_key[5:]
            if slot.session_key.startswith("conv:")
            else None
        )
        driver = CDPDriver(
            cdp_port=cfg.chrome.cdp_port,
            tab_mode="owned",
            parallel_tabs=True,
            instance_id=instance_id,
            breakers=slot.breakers,
            conv_affinity=conv_affinity,
            pace_send_seconds=cfg.chatgpt.request_pace_send_seconds,
            pace_read_seconds=cfg.chatgpt.request_pace_read_seconds,
            pace_cooldown_seconds=cfg.chatgpt.request_pace_cooldown_seconds,
        )
        # Local delta: harness-bound lifecycle. Bring Chrome up lazily on
        # first driver materialization — attach when already running, else
        # cold-start via the election lock. Lets stdio-registered servers
        # run with zero resident daemons when the tool is never invoked.
        from .chrome import ChromeProcess

        try:
            await ChromeProcess(cfg).ensure_running()
            await driver.connect()
        except BaseException:
            # CDPDriver.connect() may have created a websocket or owned tab
            # before failing. The pool has not published the driver yet, so
            # this is the last owner responsible for closing it.
            await self._close_driver_instance(driver)
            raise
        return driver

    async def _materialize_slot(self, slot: DriverSlot) -> None:
        """Materialize the CDPDriver for a PENDING slot.

        Contract (B1 §12):
          - If this raises, it must have already closed any partially opened
            CDP websocket, owned tab, or browser resource.
          - It must attach only to the one owned tab for this slot.
          - It must not enumerate or attach to unrelated profile tabs.
        """
        logger.info("_materialize_slot entered: session_key=%s", slot.session_key)
        driver: Any | None = None
        try:
            driver = await self._create_driver(slot)
            async with slot.meta_lock:
                # Cancellation can race the handoff between factory return
                # and publication. Do not leave a driver that nobody owns.
                if slot.closing:
                    raise PoolSlotUnavailableError()
                slot.driver = driver
                driver = None
        except BaseException:
            # A factory may have completed before the task was cancelled, so
            # the caller cannot assume _create_driver cleaned the object.
            if driver is not None:
                await self._close_driver_instance(driver)
            raise

    @staticmethod
    async def _close_driver_instance(driver: Any) -> None:
        """Close a driver even when the owning task is being cancelled."""
        close_task = asyncio.create_task(driver.close())
        try:
            await asyncio.wait_for(asyncio.shield(close_task), timeout=5.0)
        except asyncio.CancelledError:
            # Keep the close running and wait for it before propagating the
            # cancellation, but keep cleanup bounded.
            try:
                await asyncio.wait_for(asyncio.shield(close_task), timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                close_task.cancel()
            raise
        except asyncio.TimeoutError:
            logger.error("Driver close exceeded 5s; cancelling cleanup task")
            close_task.cancel()
            try:
                await asyncio.wait_for(close_task, timeout=0.5)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass
        except Exception:
            logger.exception("Error closing driver during pool cleanup")

    async def _close_slot_driver(self, slot: DriverSlot) -> None:
        """Detach and close one slot exactly once, then free its capacity."""
        if slot.close_lock is None:
            # All pool-created slots have this field. The fallback keeps the
            # helper tolerant of old test fixtures constructed by hand.
            slot.close_lock = asyncio.Lock()
        async with slot.close_lock:
            # Preserve the pool_lock → meta_lock ordering used by acquire and
            # the sweeper. The potentially slow close happens after both are
            # released.
            async with self._pool_lock:
                async with slot.meta_lock:
                    driver = slot.driver
                    slot.driver = None
                    slot.closing = True
                    slot.in_flight = 0
            if driver is not None:
                await self._close_driver_instance(driver)
            async with self._pool_lock:
                # Capacity is physical, so remove by slot identity.  A
                # replacement with the same session key remains untouched.
                self._capacity_slots.pop(id(slot), None)
                if self._slots.get(slot.session_key) is slot:
                    del self._slots[slot.session_key]
                    self._active_keys.discard(slot.session_key)
                self._capacity_available.notify_all()

    async def _abandon_pending_slot(self, slot: DriverSlot) -> None:
        """Clean up a PENDING slot that failed or was abandoned."""
        driver_to_close: Any | None = None
        async with self._pool_lock:
            async with slot.meta_lock:
                slot.in_flight = 0
                slot.closing = True
                driver_to_close = slot.driver
                slot.driver = None
            if self._slots.get(slot.session_key) is slot:
                del self._slots[slot.session_key]
            slot.ready_event.set()
            # Keep the physical reservation until a partially materialised
            # driver has actually closed. This prevents an immediate retry
            # from exceeding the pool cap during cancellation cleanup.
        if driver_to_close is not None:
            try:
                await self._close_driver_instance(driver_to_close)
            finally:
                async with self._pool_lock:
                    self._capacity_slots.pop(id(slot), None)
                    if self._slots.get(slot.session_key) is slot:
                        del self._slots[slot.session_key]
                    if slot.session_key not in self._slots:
                        self._active_keys.discard(slot.session_key)
                    self._capacity_available.notify_all()
        else:
            async with self._pool_lock:
                self._capacity_slots.pop(id(slot), None)
                if self._slots.get(slot.session_key) is slot:
                    del self._slots[slot.session_key]
                if slot.session_key not in self._slots:
                    self._active_keys.discard(slot.session_key)
                self._capacity_available.notify_all()

    async def _acquire_slot(self, session_key: str) -> DriverLease:
        """Race-free, bounded slot acquisition. See B1 §5 for full design.

        Bounds:
          - acquire_timeout bounds waiting for pool capacity.
          - acquire_timeout bounds waiting for a pending slot to materialize.
          - acquire_timeout bounds waiting for the create semaphore.
          - acquire_timeout does NOT bound actual driver creation once started.
        """
        deadline = time.monotonic() + self._acquire_timeout

        while True:
            pending_slot: DriverSlot | None = None
            materialize_slot: DriverSlot | None = None

            async with self._pool_lock:
                if self._shutting_down:
                    raise PoolShuttingDownError()

                slot = self._slots.get(session_key)

                # Existing usable slot.
                if slot is not None and not slot.closing:
                    if not slot.ready_event.is_set():
                        pending_slot = slot
                    else:
                        async with slot.meta_lock:
                            if slot.closing or slot.driver is None:
                                pass  # Treat as unusable; loop to create/wait.
                            else:
                                slot.in_flight += 1
                                slot.last_used_at = time.monotonic()
                                return self._make_lease(slot)

                # Need a new slot.
                if pending_slot is None and (
                    slot is None or slot.closing or slot.driver is None
                ):
                    if len(self._capacity_slots) < self._max_size:
                        now = time.monotonic()
                        new_slot = DriverSlot(
                            session_key=session_key,
                            driver=None,
                            breakers=self._make_breakers(),
                            meta_lock=asyncio.Lock(),
                            call_lock=asyncio.Lock(),
                            ready_event=asyncio.Event(),
                            created_at=now,
                            last_used_at=now,
                            in_flight=1,
                            closing=False,
                            close_lock=asyncio.Lock(),
                        )
                        self._slots[session_key] = new_slot
                        self._active_keys.add(session_key)
                        self._capacity_slots[id(new_slot)] = new_slot
                        materialize_slot = new_slot
                        break

                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise PoolExhaustedError(active_leases=self._active_session_keys())

                    try:
                        await asyncio.wait_for(
                            self._capacity_available.wait_for(
                                lambda: (
                                    len(self._capacity_slots) < self._max_size
                                    or self._shutting_down
                                )
                            ),
                            timeout=remaining,
                        )
                    except TimeoutError:
                        raise PoolExhaustedError(active_leases=self._active_session_keys())

                    if self._shutting_down:
                        raise PoolShuttingDownError()
                    continue

            # Existing PENDING slot for this same session.
            if pending_slot is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PoolExhaustedError(active_leases=self._active_session_keys())
                try:
                    await asyncio.wait_for(
                        pending_slot.ready_event.wait(), timeout=remaining
                    )
                except TimeoutError:
                    raise PoolExhaustedError(active_leases=self._active_session_keys())
                continue

        assert materialize_slot is not None

        # Bound waiting for the create semaphore.
        sem_acquired = False
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise PoolExhaustedError(active_leases=self._active_session_keys())

            try:
                await asyncio.wait_for(
                    self._create_sem.acquire(), timeout=remaining
                )
                sem_acquired = True
            except TimeoutError:
                raise PoolExhaustedError(active_leases=self._active_session_keys())

            await self._materialize_slot(materialize_slot)

            # Success: publish or disown if shutdown started during
            # materialisation. The publish is inside the same cleanup scope
            # so cancellation while waiting for pool_lock cannot strand the
            # newly connected driver.
            driver_to_close: Any | None = None
            async with self._pool_lock:
                if self._shutting_down:
                    async with materialize_slot.meta_lock:
                        driver_to_close = materialize_slot.driver
                        materialize_slot.driver = None
                        materialize_slot.in_flight = 0
                        materialize_slot.closing = True
                    if self._slots.get(materialize_slot.session_key) is materialize_slot:
                        del self._slots[materialize_slot.session_key]
                    self._active_keys.discard(materialize_slot.session_key)
                    self._capacity_slots.pop(id(materialize_slot), None)
                    materialize_slot.ready_event.set()
                    self._capacity_available.notify_all()
                else:
                    materialize_slot.ready_event.set()

            if driver_to_close is not None:
                await self._close_driver_instance(driver_to_close)
                raise PoolShuttingDownError()

            # The slot is published with in_flight=1. Do not insert another
            # await before lease creation: cancellation in that window would
            # leave a count with no LeaseRecord.
            if materialize_slot.driver is None:
                raise PoolSlotUnavailableError()
            return self._make_lease(materialize_slot)

        except BaseException as e:
            if isinstance(e, Exception):
                materialize_slot.materialize_error = e
            # Shield rollback from the cancellation that brought us here.
            # _abandon_pending_slot also closes a driver assigned just before
            # cancellation, so this covers the materialize/publish handoff.
            cleanup_task = asyncio.create_task(
                self._abandon_pending_slot(materialize_slot)
            )
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                # Preserve the original cancellation, but wait for the
                # bounded cleanup before returning control to a retrying
                # caller. Otherwise the retry could observe stale capacity.
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError:
                    pass
            raise
        finally:
            if sem_acquired:
                self._create_sem.release()

    def _make_breakers(self):
        """Create a fresh BreakerRegistry for a slot."""
        from .breakers import BreakerRegistry
        return BreakerRegistry()

    def _make_lease(self, slot: DriverSlot) -> DriverLease:
        """P1.5: create a DriverLease + its LeaseRecord. Instruments the lease
        lifecycle for diagnostics (hold duration, release reason)."""
        lease_id = uuid.uuid4().hex[:12]
        record = LeaseRecord(
            lease_id=lease_id,
            session_key=slot.session_key,
            acquired_at=time.monotonic(),
            slot_identity=id(slot),
        )
        self._active_leases[lease_id] = record
        return DriverLease(
            slot=slot,
            driver=slot.driver,
            breakers=slot.breakers,
            call_lock=slot.call_lock,
            lease_id=lease_id,
        )

    def _active_session_keys(self) -> list[str]:
        """P1.5: session keys of currently-held leases (for exhaustion dumps)."""
        return sorted({r.session_key for r in self._active_leases.values()})

    async def _release(self, slot: DriverSlot, *, lease_id: str = "", release_reason: str = "normal") -> None:
        """Release a lease: decrement in_flight, update last_used_at.

        P1.5: also completes the LeaseRecord (hold duration + reason) and
        detects double-releases (a correctness bug where the same lease is
        released twice). Double-release logs a warning but does NOT re-decrement
        in_flight (that would undercount).

        Legacy callers without a ``lease_id`` (``lease_id=""``) skip tracking
        but still get the correct in_flight decrement (review finding A).
        """
        # P1.5: lease tracking. For tracked leases (lease_id non-empty),
        # complete the record or detect double-release.
        record = None
        skip_decrement = False
        if lease_id:
            # Do not remove the record until the slot lock has been acquired.
            # If cancellation interrupts that await, the sweeper must still
            # see a live lease and must not mistake it for a stale count.
            record = self._active_leases.get(lease_id)
            if record is None:
                # Confirmed double-release: lease_id was provided but is not in
                # active_leases. Log and do NOT re-decrement in_flight (review
                # finding A — re-decrementing would undercount).
                logger.warning(
                    "Double-release detected: lease_id=%s not in active_leases "
                    "(session=%s) — lease was already released; skipping "
                    "in_flight decrement to avoid undercount",
                    lease_id, slot.session_key,
                )
                skip_decrement = True
        # For untracked releases (lease_id="" — legacy/direct callers) and
        # normal tracked releases, decrement in_flight. Double-releases skip.
        if not skip_decrement:
            async with slot.meta_lock:
                slot.in_flight = max(0, slot.in_flight - 1)
                slot.last_used_at = time.monotonic()
            if record is not None:
                # Everything below is synchronous, so cancellation cannot
                # interrupt the transition after the count was decremented.
                self._active_leases.pop(lease_id, None)
                record.released_at = time.monotonic()
                record.hold_duration_s = record.released_at - record.acquired_at
                record.release_reason = release_reason
                logger.info(
                    "lease released: session=%s held=%.1fs reason=%s",
                    slot.session_key, record.hold_duration_s, release_reason,
                )
                self._lease_history.append(record)
                # Cap history to prevent unbounded growth.
                if len(self._lease_history) > _LEASE_HISTORY_LIMIT:
                    self._lease_history = self._lease_history[-_LEASE_HISTORY_LIMIT:]

    async def _probe_slot(self, slot: DriverSlot) -> bool:
        """Sanity-probe one idle slot's driver under its call_lock.

        Returns True when the driver answers a trivial evaluate. The probe
        goes through the normal ``_cdp`` path, so a poisoned session first
        attempts its in-band reattachment — the probe doubles as the
        recovery trigger, and only a slot whose RECOVERY probe fails
        accumulates a failure.

        Test doubles (plain MagicMock drivers) have no real async ``_js``
        and are reported healthy so injected fakes never trip the
        force-reap. A slot whose call_lock is busy has live traffic — that
        is its own health signal, so the probe skips this round.
        """
        driver = slot.driver
        if driver is None:
            return True
        if not asyncio.iscoroutinefunction(getattr(driver, "_js", None)):
            return True  # test double without a real evaluator — unprobeable
        try:
            await asyncio.wait_for(slot.call_lock.acquire(), timeout=1.0)
        except TimeoutError:
            return True  # busy with a real call — skip this round
        try:
            await driver._js("location.href", timeout=3)
            return True
        except Exception as e:
            logger.warning(
                "Pool health probe failed for slot %s: %s", slot.session_key, e
            )
            return False
        finally:
            slot.call_lock.release()

    async def _sweep_idle(self) -> None:
        """Background loop: close idle slots past TTL + force-reap wedged ones.

        Marks victims as closing=True but does NOT remove from _active_keys
        until driver.close() completes. This prevents transient N+1 live tabs.

        Two victim classes:
          1. idle past TTL (in_flight == 0, unpinned) — the original sweep;
          2. health-probe failures >= _FORCE_REAP_PROBE_FAILURES (pinned
             included) — a wedged driver that cannot heal in-band. Bounded
             to ~2 sweep intervals instead of lingering until restart.
        """
        while True:
            await asyncio.sleep(self._sweep_interval)
            now = time.monotonic()
            victims: list[DriverSlot] = []
            probe_candidates: list[DriverSlot] = []

            async with self._pool_lock:
                if self._shutting_down:
                    return
                for key in list(self._active_keys):
                    slot = self._slots.get(key)
                    if slot is None:
                        self._active_keys.discard(key)
                        continue
                    pinned = key in PINNED_SLOT_KEYS
                    async with slot.meta_lock:
                        if slot.driver is None or slot.closing:
                            continue
                        # in_flight leak guard (2026-09-19): a slot idle past
                        # TTL whose in_flight count never came back to zero
                        # (leaked reference) would never be swept. Lease
                        # records are the source of truth — no live lease for
                        # this session means the count is stale; clamp it so
                        # the slot can be reaped.
                        if (
                            slot.in_flight > 0
                            and slot.ready_event.is_set()
                            and now - slot.last_used_at > self._ttl
                            and not any(
                                r.slot_identity == id(slot)
                                or (r.slot_identity == 0 and r.session_key == key)
                                for r in self._active_leases.values()
                            )
                        ):
                            logger.warning(
                                "in_flight leak on slot %s (in_flight=%d, no live "
                                "lease, idle past TTL) — clamping to 0",
                                slot.session_key,
                                slot.in_flight,
                            )
                            slot.in_flight = 0
                        if (
                            not pinned
                            and slot.in_flight == 0
                            and now - slot.last_used_at > self._ttl
                        ):
                            slot.closing = True
                            victims.append(slot)
                            continue
                        if slot.in_flight == 0:
                            probe_candidates.append(slot)
                    # Do NOT discard active keys yet.
                    # Do NOT notify capacity yet.

            # Health probes run OUTSIDE the pool lock (CDP round-trips).
            for slot in probe_candidates:
                healthy = await self._probe_slot(slot)
                async with self._pool_lock:
                    async with slot.meta_lock:
                        # A slot may have been rebound or shut down while the
                        # probe was outside the pool lock. Never write probe
                        # state into a stale slot or reap a replacement.
                        if (
                            self._shutting_down
                            or self._slots.get(slot.session_key) is not slot
                        ):
                            continue
                        if healthy:
                            slot.probe_failures = 0
                            continue
                        slot.probe_failures += 1
                        if (
                            slot.probe_failures >= _FORCE_REAP_PROBE_FAILURES
                            and not slot.closing
                            and slot.in_flight == 0
                            and slot.driver is not None
                        ):
                            logger.error(
                                "Slot %s failed %d consecutive health probes — "
                                "force-reaping a wedged driver",
                                slot.session_key,
                                slot.probe_failures,
                            )
                            slot.closing = True
                            victims.append(slot)

            for slot in victims:
                # _close_slot_driver owns the identity check and is shared by
                # shutdown, so a slow close cannot free a replacement slot or
                # run driver.close() twice.
                try:
                    await self._close_slot_driver(slot)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("Error closing idle driver")

    async def close_all(self) -> None:
        """Shutdown: stop new creation, wake waiters, drain in-flight, close all."""
        async with self._pool_lock:
            self._shutting_down = True
            # Include retired closing slots as well as current mappings. A
            # session rebind can replace the mapping before the old close has
            # finished; shutdown still owns both physical drivers.
            slots = list({
                id(slot): slot for slot in self._capacity_slots.values()
            }.values())
            slots.extend(
                slot for slot in self._slots.values()
                if id(slot) not in {id(existing) for existing in slots}
            )
            self._capacity_available.notify_all()

        # Cancel the sweeper.
        if self._sweep_task is not None and not self._sweep_task.done():
            self._sweep_task.cancel()
            try:
                await self._sweep_task
            except asyncio.CancelledError:
                pass

        async def _close_one(slot: DriverSlot) -> None:
            # Wait for materialization to complete (or timeout).
            if not slot.ready_event.is_set():
                try:
                    await asyncio.wait_for(slot.ready_event.wait(), timeout=10.0)
                except TimeoutError:
                    logger.warning(
                        "shutdown proceeding without waiting for materialize: %s",
                        slot.session_key,
                    )
                    return

            # Drain in-flight (best-effort).
            drained = False
            for _ in range(100):
                async with slot.meta_lock:
                    if slot.in_flight == 0:
                        drained = True
                        break
                await asyncio.sleep(0.1)

            if not drained:
                async with slot.meta_lock:
                    current_in_flight = slot.in_flight
                logger.warning(
                    "MCP pool shutdown forcing close of driver for session %s "
                    "with in_flight=%d; request may see CDP error",
                    slot.session_key,
                    current_in_flight,
                )

            await self._close_slot_driver(slot)

        await asyncio.gather(*(_close_one(slot) for slot in slots))

    def status(self) -> dict:
        """Return pool diagnostics (for /health or debugging)."""
        return {
            "enabled": True,
            "max_size": self._max_size,
            "active_keys": len(self._active_keys),
            "capacity_slots": len(self._capacity_slots),
            "slots": {
                key: {
                    "session_key": s.session_key,
                    "has_driver": s.driver is not None,
                    "ready": s.ready_event.is_set(),
                    "closing": s.closing,
                    "in_flight": s.in_flight,
                    "probe_failures": s.probe_failures,
                    "created_at": s.created_at,
                    "last_used_at": s.last_used_at,
                }
                for key, s in self._slots.items()
            },
            "account_breaker_tripped": self._account_breaker.is_tripped(),
            "shutting_down": self._shutting_down,
            # P1.5: lease accounting summary for RCA / diagnostics.
            "leases": {
                "active_count": len(self._active_leases),
                "history_count": len(self._lease_history),
                "active": [
                    {"lease_id": r.lease_id, "session_key": r.session_key,
                     "acquired_at": r.acquired_at}
                    for r in self._active_leases.values()
                ],
                "recent": [
                    {"lease_id": r.lease_id, "session_key": r.session_key,
                     "hold_duration_s": r.hold_duration_s,
                     "release_reason": r.release_reason}
                    for r in self._lease_history[-10:]
                ],
            },
        }
