"""CDP transport — Chrome DevTools Protocol wire primitives.

Phase 5 PR2 extraction (no behavior change). Owns the active page-websocket
wire layer that was previously inlined in ``CDPDriver``:

  - ``_reader_loop`` — background reader; sole consumer of ``_ws.recv()``,
    routes each CDP response to its id-keyed pending Future.
  - ``_cdp`` — send a CDP command + await its response via the future table;
    only retries an explicitly allow-listed read-only command on socket death.
  - ``_should_reconnect`` — pure error classifier for socket-death signatures.
  - ``_js`` / ``_js_strict`` — soft / strict ``Runtime.evaluate`` wrappers.
  - ``_js_with_data`` / ``_js_with_data_strict`` — safe ``__D`` data injection.

The driver-reference collaborator seam: ``CDPTransport`` holds a reference to
its owning ``CDPDriver`` and reaches through it for the live CDP socket and
the id-keyed response table. None of that state migrates into this module —
it stays on the driver so external attribute reads (connect/reconnect/close,
``is_connected``) and test stubs that poke ``driver._ws`` /
``driver._pending`` / ``driver._reader_task`` keep working unchanged.

Boundary (Layer 1 only): this module is the ACTIVE page-websocket wire layer.
Connection lifecycle, tab discovery (``connect``/``reconnect``/
``_find_*_ws``/``_create_owned_tab``/``_browser_cdp``), and ``close`` stay in
``cdp_driver.py`` (Layer 2). ``reconnect`` owns breaker semantics; this module
calls back into ``driver.reconnect()`` but never duplicates or moves breaker
handling.

Call-rule inside CDPTransport method bodies:

  transport state:         self._driver._ws
                           self._driver._msg_id
                           self._driver._pending
  layer-2 callback:        self._driver.reconnect()
  sibling wire helpers:    self._cdp(...)
                           self._js(...)
                           self._js_strict(...)

Internal wire-to-wire calls (``_js`` → ``_cdp``, ``_js_with_data`` → ``_js``)
go through ``self._driver`` (not ``self``) so driver monkeypatches of
``driver._cdp`` / ``driver._js`` keep intercepting — the same driver-facing
seam BackendClient relies on.
"""

from __future__ import annotations

import asyncio
import json
import logging

logger = logging.getLogger(__name__)


class CDPTimeoutError(TimeoutError):
    """A CDP operation exceeded its wall-clock budget.

    ``asyncio.TimeoutError`` by itself loses the command that timed out.  That
    is particularly dangerous for ``Runtime.evaluate``: a caller must be able
    to distinguish a pre-submit probe timeout from a timeout while a mutation
    may already have been sent, and make the recovery decision at the driver
    layer.  The transport therefore exposes the method and the phase without
    deciding whether a reconnect or replay is safe.

    ``TimeoutError`` remains the base class for callers that only need the
    historic exception contract.
    """

    def __init__(
        self, method: str, timeout: float | None = None, *, phase: str = "response"
    ) -> None:
        self.method = method
        self.timeout = float(timeout) if timeout is not None else None
        self.phase = phase
        if self.timeout is None:
            message = f"CDP timeout in {method} (phase={phase})"
        else:
            message = f"CDP timeout in {method} after {self.timeout:.3f}s (phase={phase})"
        super().__init__(message)


# A socket can die after a command has been written but before its response is
# observed.  Retrying an arbitrary CDP method in that window is a duplicate
# side effect.  Keep this list deliberately small and explicit.  In
# particular, Runtime.evaluate is *never* safe here because the expression is
# caller supplied, and Input.* is always a user-visible mutation.
READ_ONLY_RECONNECT_METHODS = frozenset(
    {
        "Browser.getVersion",
        "Page.getFrameTree",
        "Page.getLayoutMetrics",
        "Page.getNavigationHistory",
        "Runtime.getHeapUsage",
        "Runtime.getIsolateId",
        "Target.getTargetInfo",
        "Target.getTargets",
        "Network.getAllCookies",
        "Network.getCookies",
    }
)

# Private alias keeps the policy easy to discover for tests and for future
# transport code without making callers depend on the public spelling.
_READ_ONLY_RECONNECT_METHODS = READ_ONLY_RECONNECT_METHODS


# Every Runtime.evaluate expression is wrapped in a Promise.race against a
# timer that rejects slightly before the transport budget.  Chromium
# serializes Runtime.evaluate per session, so one never-settling in-page
# promise (observed: a hung backend fetch with no AbortController)
# head-of-line blocks every later command on that session — seen in the
# field as identical response-phase timeouts on unrelated sends while the
# page itself answered fresh sessions instantly.  The wrapper guarantees
# each evaluate SETTLES, turning a silent queue wedge into a typed,
# recoverable error.  Chrome's own evaluate ``timeout`` param does not
# reliably terminate an evaluation parked awaiting a promise, so it cannot
# serve this role.  A genuinely wedged renderer main thread (sync infinite
# loop) still cannot be interrupted — that case is what the poisoned-
# session recovery below exists to contain.
#
# The marker doubles as the timeout signature ``_is_timeout_detail`` looks
# for, so a watchdog rejection surfaces as CDPTimeoutError(phase="cdp") on
# both the soft and strict evaluate paths.
_EVAL_WATCHDOG_MARKER = "__cgw_eval_watchdog_timeout__"
_EVAL_WATCHDOG_MARGIN_MS = 250


def _wrap_self_settling(expr: str, timeout: float) -> str:
    """Wrap ``expr`` so the evaluate always settles within ``timeout``.

    The original expression keeps running in the page even after the
    watchdog wins the race — the wrapper changes *observation*, not the
    expression's side effects, which is exactly the ambiguity contract
    callers already handle for timed-out commands.
    """
    try:
        budget_ms = int(float(timeout) * 1000)
    except (TypeError, ValueError):
        budget_ms = 15000
    watchdog_ms = max(100, budget_ms - _EVAL_WATCHDOG_MARGIN_MS)
    # Trailing semicolons/whitespace would be a syntax error inside the
    # Promise.resolve() argument position.
    body = expr.rstrip().rstrip(";")
    return (
        "Promise.race([Promise.resolve((" + body + ")),"
        "new Promise(function(_, rej){setTimeout(function(){"
        "rej(new Error('" + _EVAL_WATCHDOG_MARKER + "'));"
        "}," + str(watchdog_ms) + ")})])"
    )


class CDPTransport:
    """Active page-websocket CDP wire primitives, composed by ``CDPDriver``.

    Constructed once in ``CDPDriver.__init__`` and stored as
    ``self._transport``. The driver keeps thin delegating methods for every
    method here so its public/private API surface is byte-identical to
    pre-extraction.
    """

    def __init__(self, driver) -> None:
        self._driver = driver
        # Recovery is a transport-wide single-flight operation.  It is kept
        # here (rather than on the driver) because it is only an implementation
        # detail of the poison gate; the driver still owns the socket and its
        # lifecycle.  The flag also prevents a recovery callback which probes
        # the page through ``_cdp`` from recursively entering recovery.
        self._poison_recovery_active = False
        self._poison_recovery_owner: asyncio.Task | None = None

    # ── CDP primitives ────────────────────────────────────────

    async def _reader_loop(self, ws=None) -> None:
        """Background reader: sole consumer of self._ws.recv().

        Routes each incoming CDP message to the matching pending Future by id.
        Messages without an id (unsolicited CDP events like
        ``Network.requestWillBeSent``, ``Page.frameNavigated``) are dispatched
        to a registered event handler if one exists for the event's method
        name (via ``driver._cdp_event_handlers``); otherwise they are logged
        at DEBUG and discarded.

        Event-handler contract: handlers MUST be fast and non-blocking. The
        reader loop is the sole consumer of ``ws.recv()`` and also resolves
        all pending CDP command futures — blocking it on heavy work (e.g.
        parsing a large POST body synchronously) risks unrelated CDP
        timeouts. Handlers that need to do expensive work should schedule it
        via ``loop.create_task`` and return immediately. If a handler raises,
        it is logged and swallowed so one bad handler cannot kill the reader.

        On ConnectionClosed, fails all pending futures so callers don't hang.
        """
        d = self._driver
        # Pin THIS socket for the loop's whole life. Reading ``d._ws``
        # dynamically let a reader that survived a reconnect steal recv()
        # from the REPLACEMENT socket: websockets forbids concurrent recv,
        # the new reader died with ConcurrencyError, and no response was
        # ever routed again — every command then timed out at the
        # transport layer and in-band recovery could never heal
        # (2026-09-19 poisoned-session incident). With the socket pinned,
        # a stale reader keeps reading its own socket, which the reconnect
        # paths close, so it dies on ConnectionClosed instead.
        # The lifecycle owner passes the socket captured immediately before
        # scheduling the task.  The optional default preserves the old test
        # and driver seam for callers that start a reader directly.
        ws = d._ws if ws is None else ws
        if ws is None:
            # A reader can be scheduled just as close()/reconnect() tears the
            # session down.  There is no socket to consume and, crucially,
            # no current pending table that this task may fail.
            return
        try:
            while True:
                raw = await ws.recv()
                # ``reconnect`` swaps ``driver._ws`` before reaping the old
                # reader.  A cancellation-resistant old reader may still
                # produce one last frame.  It must not dispatch that frame to
                # the new session (events can mutate correlation state and a
                # stale response must never touch the new pending table).
                if d._ws is not ws:
                    logger.debug("CDP stale reader exited after socket replacement")
                    return
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    logger.debug("CDP reader: unparseable frame, discarding")
                    continue
                mid = msg.get("id")
                if mid is None:
                    # Unsolicited CDP event. Dispatch to a registered handler
                    # if one exists for this method name; else debug-log.
                    method = msg.get("method")
                    if method:
                        # Generic dispatch table on the driver (Layer 2 owns
                        # handler registration — transport is wire-only).
                        handlers = getattr(d, "_cdp_event_handlers", None)
                        handler = handlers.get(method) if handlers else None
                        if handler is not None:
                            try:
                                handler(msg)
                            except Exception:
                                logger.exception(
                                    "CDP event handler failed for %s", method
                                )
                        elif logger.isEnabledFor(logging.DEBUG):
                            logger.debug("CDP event: %s", method)
                    continue
                fut = d._pending.pop(mid, None)
                if fut and not fut.done():
                    fut.set_result(msg)
                else:
                    logger.debug("CDP reader: response for unknown/stale id %s", mid)
        except Exception as e:
            # Socket closed or errored — fail all pending callers so they
            # don't hang waiting for a response that will never arrive.
            logger.warning("CDP reader loop ended: %s", e)
            # The old reader's exception is not evidence about the current
            # socket.  In particular, do not fail the replacement socket's
            # pending futures or poison its session.  This check is the
            # companion to the socket pin above and is required even when
            # ``close()`` on the old websocket races with a new connect().
            if d._ws is not ws:
                return
            if type(e).__name__ == "ConcurrencyError":
                # recv() raced another reader on this socket: frame routing
                # on the session is dead by definition (the socket itself
                # may still be healthy). Poison the session so the next
                # command reattaches a fresh session instead of every call
                # timing out one by one behind a socket nobody reads.
                logger.error(
                    "CDP reader lost the recv race (ConcurrencyError) — "
                    "session routing is dead; poisoning the session"
                )
                d._session_poisoned = True
            elif not isinstance(e, (asyncio.CancelledError,)):
                # A live reader ending for any other socket error means the
                # routing path is gone.  Poisoning makes the next command
                # perform the driver's bounded same-target recovery instead
                # of writing into a socket nobody consumes.
                d._session_poisoned = True
            for mid, fut in list(d._pending.items()):
                if not fut.done():
                    fut.set_exception(e)

    async def _cdp(
        self,
        method: str,
        params: dict = None,
        timeout: float = 15,
        _retry: bool = True,
        _deadline: float | None = None,
    ) -> dict:
        """Send a CDP command and await its response.

        Uses the background reader + id-keyed Future table (#7 fix) so
        concurrent _cdp calls each receive their own response without
        cross-eating each other's frames.

        A single timeout budget covers both ``ws.send`` and response delivery;
        a slow send cannot consume the full budget and then receive another
        full response timeout.  The pending future is removed and cancelled in
        ``finally`` on every exit path, including caller cancellation.

        A socket-death retry is allowed only for
        :data:`READ_ONLY_RECONNECT_METHODS`.  ``Runtime.evaluate``, ``Input.*``
        and unknown methods deliberately propagate the socket error.  The
        driver owns the bounded recovery policy for mutating operations and
        must reconcile delivery before it performs any replay.
        """
        d = self._driver
        loop = asyncio.get_running_loop()
        try:
            budget = max(0.0, float(timeout))
        except (TypeError, ValueError):
            raise ValueError(f"invalid CDP timeout for {method!r}: {timeout!r}") from None
        # Establish the absolute deadline BEFORE poison recovery.  Recovery
        # is part of this command's budget; it must not silently add the
        # driver's 15-second same-target reconnect allowance on top of a
        # caller's 200ms CDP timeout.  ``_deadline`` is private and used only
        # by the allow-listed replay below to preserve the original budget.
        deadline = (
            float(_deadline)
            if _deadline is not None
            else loop.time() + budget
        )
        # ``is True`` (not truthiness): test doubles hand out auto-attributes
        # that are truthy MagicMocks and must not trip the recovery path.
        current_task = asyncio.current_task()
        poisoned = getattr(d, "_session_poisoned", False) is True
        recovery_owned_by_current = (
            self._poison_recovery_active
            and current_task is self._poison_recovery_owner
        )
        if poisoned and recovery_owned_by_current:
            # A recovery callback must never recursively recover itself.  This
            # can happen if its sanity probe times out and poisons the fresh
            # socket before the callback has unwound.
            raise CDPTimeoutError(method, budget, phase="reconnect")
        if poisoned or (
            self._poison_recovery_active and not recovery_owned_by_current
        ):
            await self._recover_poisoned_session(
                deadline=deadline, method=method, budget=budget
            )
            if deadline - loop.time() <= 0:
                raise CDPTimeoutError(method, budget, phase="reconnect")
        d._msg_id += 1
        mid = d._msg_id
        fut: asyncio.Future = loop.create_future()
        d._pending[mid] = fut
        # ``__new__``-constructed test drivers may lack the forensic table;
        # tracking is best-effort and never gates the command itself.
        meta = getattr(d, "_pending_meta", None)
        if meta is not None:
            meta[mid] = (method, loop.time())

        async def _await_with_budget(awaitable, phase: str):
            remaining = deadline - loop.time()
            if remaining <= 0:
                # Do not create an un-awaited send coroutine when the budget
                # is already exhausted.
                if hasattr(awaitable, "close"):
                    awaitable.close()
                raise CDPTimeoutError(method, budget, phase=phase)
            try:
                return await asyncio.wait_for(awaitable, remaining)
            except asyncio.TimeoutError as exc:
                raise CDPTimeoutError(method, budget, phase=phase) from exc

        try:
            try:
                if deadline - loop.time() <= 0:
                    raise CDPTimeoutError(method, budget, phase="send")
                await _await_with_budget(
                    d._ws.send(
                        json.dumps({"id": mid, "method": method, "params": params or {}})
                    ),
                    "send",
                )
            except Exception as exc:
                # A send-side socket death is replayable only for a command
                # proven idempotent by the explicit allowlist.  This check is
                # intentionally after timeout handling: timeouts are
                # ambiguous and are never retried at this layer.
                if (
                    _retry
                    and method in READ_ONLY_RECONNECT_METHODS
                    and self._should_reconnect(exc)
                ):
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        raise CDPTimeoutError(method, budget, phase="reconnect") from exc
                    logger.warning(
                        "CDP read-only send failed (%s); reconnecting within remaining budget",
                        exc,
                    )
                    try:
                        await asyncio.wait_for(d.reconnect(), remaining)
                    except asyncio.TimeoutError as reconnect_exc:
                        raise CDPTimeoutError(
                            method, budget, phase="reconnect"
                        ) from reconnect_exc
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        raise CDPTimeoutError(method, budget, phase="retry") from exc
                    # The recursive call gets only the unspent part of the
                    # original deadline and cannot recurse again.
                    return await self._cdp(
                        method,
                        params,
                        timeout=remaining,
                        _retry=False,
                        _deadline=deadline,
                    )
                raise

            # Do not turn a response timeout into a socket retry.  The command
            # may have been accepted and is therefore ambiguous to replay.
            # A response that never arrives also means the session queue may
            # be head-of-line blocked by this command — poison the session so
            # the next command reattaches instead of starving behind it.
            try:
                response = await _await_with_budget(fut, "response")
            except CDPTimeoutError:
                self._poison_session(method, budget, mid)
                raise
            # A permission refusal is meaningful for every CDP domain (for
            # example Network.enable), not only Runtime.evaluate.  Surface it
            # at the wire boundary so listeners cannot mistake a raw error
            # response for a successful enable.  Other CDP error responses
            # remain raw for the existing caller contract.
            self._raise_for_permission_error(method, response)
            return response
        finally:
            # The reader may have popped the entry already.  Identity checking
            # prevents a late cleanup from touching a future for a reused id.
            if d._pending.get(mid) is fut:
                d._pending.pop(mid, None)
            if meta is not None:
                meta.pop(mid, None)
            if not fut.done():
                fut.cancel()

    def _poison_session(self, method: str, budget: float, mid: int) -> None:
        """Mark the session wedged and dump in-flight forensics.

        A response-phase timeout means a command was written but its
        response never arrived.  With self-settling evaluates the only
        remaining cause is a renderer-level wedge (or a transport dead in
        a way the reader hasn't noticed); either way every later command
        on this socket queues behind the missing response, so the next
        command must reattach instead of reusing the session.
        """
        d = self._driver
        d._session_poisoned = True
        loop = asyncio.get_running_loop()
        try:
            inflight = [
                f"{m}(age={loop.time() - t:.1f}s)"
                for other_mid, (m, t) in d._pending_meta.items()
                if other_mid != mid
            ]
            inflight_text = ", ".join(inflight) if inflight else "none"
        except Exception:
            # Forensics must never mask the poison itself (e.g. stub drivers
            # in tests that don't model _pending_meta).
            inflight_text = "unavailable"
        logger.error(
            "CDP session poisoned: %s response never arrived within %.3fs; "
            "other in-flight commands: %s — next command forces a fresh session",
            method,
            budget,
            inflight_text,
        )

    async def _recover_poisoned_session(
        self,
        *,
        deadline: float | None = None,
        method: str = "CDP",
        budget: float | None = None,
    ) -> None:
        """Rebuild the page websocket after a poisoned (wedged) session.

        The only safe recovery is a NEW session to the SAME target:
        ``reconnect_for_send_recovery`` reattaches without adopting or
        navigating tabs and fails closed (``OwnedTabRequiredError``) when
        the original target is gone.  The flag is cleared before recovery
        so the recovery probe's own evaluate passes the entry check, and
        re-armed on failure so the next command retries recovery instead
        of queueing behind the suspect socket.
        """
        d = self._driver
        lock = getattr(d, "_poison_lock", None)
        if not isinstance(lock, asyncio.Lock):
            # Backwards-compatible test doubles and old driver instances may
            # not expose the lock yet.  Install one once so concurrent callers
            # still share a single recovery attempt.
            lock = asyncio.Lock()
            d._poison_lock = lock

        async def _remaining() -> float | None:
            if deadline is None:
                return None
            left = deadline - asyncio.get_running_loop().time()
            if left <= 0:
                raise CDPTimeoutError(
                    method, budget, phase="reconnect"
                )
            return left

        remaining = await _remaining()
        try:
            if remaining is None:
                await lock.acquire()
            else:
                try:
                    await asyncio.wait_for(lock.acquire(), remaining)
                except asyncio.TimeoutError as exc:
                    raise CDPTimeoutError(
                        method, budget, phase="reconnect"
                    ) from exc
        except asyncio.CancelledError:
            # Waiting for the gate is caller cancellation, not a recovery
            # failure.  Do not mutate the poison flag owned by another caller.
            raise

        try:
            if not d._session_poisoned:
                return  # a concurrent caller already recovered
            # When a send request is already inside recovery_scope, the poison
            # gate consumes that scope's single pre-submit allowance.  This
            # prevents the outer send wrapper from reconnecting a second time
            # after transport recovery has already spent the attempt.
            try:
                from .send_recovery import claim_transport_recovery

                claim_transport_recovery(d, method, budget)
            except ImportError:
                # Keep construction-time/backwards-compatible test doubles
                # usable while the optional send orchestration is unavailable.
                pass
            d._session_poisoned = False
            self._poison_recovery_active = True
            self._poison_recovery_owner = asyncio.current_task()
            try:
                logger.warning(
                    "CDP session poisoned — reattaching a fresh session to the same target"
                )
                remaining = await _remaining()
                try:
                    if remaining is None:
                        recovery = d.reconnect_for_send_recovery()
                    else:
                        # The lifecycle owner accepts the remaining command
                        # budget so discovery/handshake cannot outlive this
                        # _cdp call.  Keep a no-argument fallback for old
                        # test doubles and pre-lifecycle driver instances.
                        recovery = d.reconnect_for_send_recovery(timeout=remaining)
                except TypeError:
                    recovery = d.reconnect_for_send_recovery()
                if remaining is None:
                    await recovery
                else:
                    try:
                        # Keep the recovery callback in this task.  The
                        # callback's same-session sanity probe enters
                        # ``_cdp`` and must be recognized as the recovery
                        # owner; ``wait_for(coro, ...)`` would wrap it in a
                        # child Task and make it wait on its own poison gate.
                        async with asyncio.timeout(remaining):
                            await recovery
                    except asyncio.TimeoutError as exc:
                        raise CDPTimeoutError(
                            method, budget, phase="reconnect"
                        ) from exc
            except BaseException:
                # CancelledError must also re-arm poison: otherwise a caller
                # cancelled while the driver was tearing down would leave the
                # half-recovered socket looking healthy to the next command.
                d._session_poisoned = True
                raise
            finally:
                self._poison_recovery_active = False
                self._poison_recovery_owner = None
            d._session_poisoned = False
            logger.warning("CDP poisoned session recovered (fresh session, same target)")
        finally:
            lock.release()

    @staticmethod
    def _should_reconnect(exc: Exception) -> bool:
        """True for errors that mean the WebSocket is dead/tearing down.

        ConnectionClosed (and its subclasses) and the ``no close frame``
        InvalidState are the socket-death signatures; everything else
        (TimeoutError, application errors) must NOT trigger a reconnect.
        """
        # Permission and typed timeout errors are application outcomes, even
        # when their diagnostic text happens to contain socket wording.  They
        # must never enter the reconnect classifier.
        if isinstance(exc, (PermissionError, CDPTimeoutError)):
            return False

        # websockets.ConnectionClosed + subclasses (ConnectionClosedError,
        # ConnectionClosedOK). Imported lazily so a missing/renamed class in
        # other websockets versions degrades to a name check instead of ImportError.
        name = type(exc).__name__
        if name in {"ConnectionClosed", "ConnectionClosedError", "ConnectionClosedOK"}:
            return True
        msg = str(exc).lower()
        return "no close frame" in msg or "connection closed" in msg

    async def _js(self, expr: str, timeout: float = 15) -> str:
        resp = await self._driver._cdp(
            "Runtime.evaluate",
            {
                "expression": _wrap_self_settling(expr, timeout),
                "awaitPromise": True,
                "returnByValue": True,
                "timeout": int(timeout * 1000),
            },
            timeout=timeout,
        )
        self._raise_for_cdp_error("Runtime.evaluate", resp, timeout)
        result = resp.get("result", {})
        exception_details = result.get("exceptionDetails")
        if exception_details:
            # Keep the historic soft result for ordinary JavaScript exceptions,
            # but never hide permission or execution-timeout signals that the
            # caller must classify explicitly.
            if self._is_permission_detail(exception_details):
                raise PermissionError(
                    f"Runtime.evaluate permission denied: "
                    f"{self._detail_text(exception_details)}"
                )
            if self._is_timeout_detail(exception_details):
                if self._is_watchdog_detail(exception_details):
                    self._mark_watchdog_timeout()
                raise CDPTimeoutError("Runtime.evaluate", timeout, phase="cdp")
        return resp.get("result", {}).get("result", {}).get("value", "")

    async def _js_with_data(self, expr_template: str, data: dict, timeout: float = 15) -> str:
        """Evaluate JS with safely injected data variables.

        Injects *data* as the ``__D`` argument of an async IIFE so the
        templates can reference ``__D.keyName`` for any key.  The data is
        passed as a JSON-serialized call argument (never string-concatenated
        into the body), which eliminates injection vectors entirely.

        Earlier versions emitted a top-level ``const __D = ...;``, which
        collides with the global ``__D`` that chatgpt.com's own page defines
        and raised ``SyntaxError: Identifier '__D' has already been
        declared`` — silently returning empty for every
        memory/project/conversation read.  Passing ``__D`` as a function
        parameter sidesteps the collision completely: there is no
        declaration to conflict, and the parameter shadows the global
        within the IIFE's scope.

        *expr_template* is evaluated as an expression in a position where
        its return value becomes the IIFE's result, so existing templates
        (which are self-invoking like ``(async () => {...})()``) keep
        working unchanged.
        """
        # Pass __D as an argument. Using `void ` makes `__D=>(...)` an
        # arrow expression body, so the template's value is returned.
        wrapped = f"( (__D) => ({expr_template}) )({json.dumps(data)})"
        return await self._driver._js(wrapped, timeout=timeout)

    async def _js_strict(self, expr: str, timeout: float = 15) -> str:
        """Strict JS evaluation — raises CDPJSError on failure instead of "".

        Inspects the CDP response for:
        - ``error`` (CDP-level error, e.g. execution context destroyed)
        - ``exceptionDetails`` (JS threw an exception)
        - missing ``result.result`` (undefined return, type mismatch)

        On any of these, raises CDPJSError with the detail. On success,
        returns the value string (same as _js).

        Callers that already handle exceptions benefit immediately. Callers
        that depend on the ""-on-error contract must wrap in try/except.
        """
        # Imported lazily to avoid a module-load circular dependency.
        from .cdp_driver import CDPJSError

        resp = await self._driver._cdp(
            "Runtime.evaluate",
            {
                "expression": _wrap_self_settling(expr, timeout),
                "awaitPromise": True,
                "returnByValue": True,
                "timeout": int(timeout * 1000),
            },
            timeout=timeout,
        )
        # CDP-level error (e.g. "Execution context was destroyed").
        # Permission and timeout errors get their own typed exceptions so the
        # driver can apply the correct recovery policy.
        self._raise_for_cdp_error("Runtime.evaluate", resp, timeout)
        result = resp.get("result", {})
        # JS exception
        if result.get("exceptionDetails"):
            exd = result["exceptionDetails"]
            exc_text = exd.get("exception", {}).get("description", "") or exd.get("text", "")
            if self._is_permission_detail(exd):
                raise PermissionError(
                    f"Runtime.evaluate permission denied: {self._detail_text(exd)}"
                )
            if self._is_timeout_detail(exd):
                if self._is_watchdog_detail(exd):
                    self._mark_watchdog_timeout()
                raise CDPTimeoutError("Runtime.evaluate", timeout, phase="cdp")
            raise CDPJSError(
                f"JS exception: {exc_text[:500]}",
                details=exd,
            )
        inner = result.get("result", {})
        # Undefined or unserializable return
        if inner.get("type") in ("undefined",) or "value" not in inner:
            raise CDPJSError(
                f"JS returned {inner.get('type', 'unknown')} (no value)",
                details={"type": inner.get("type")},
            )
        return inner.get("value", "")

    @staticmethod
    def _detail_text(detail) -> str:
        """Flatten a CDP error/exception detail to a bounded diagnostic string."""

        if isinstance(detail, str):
            return detail
        if not isinstance(detail, dict):
            return str(detail)
        parts = []
        for key in ("message", "text", "description"):
            value = detail.get(key)
            if value:
                parts.append(str(value))
        exception = detail.get("exception")
        if isinstance(exception, dict):
            for key in ("description", "value"):
                value = exception.get(key)
                if value:
                    parts.append(str(value))
        return "; ".join(parts) or str(detail)

    @classmethod
    def _is_permission_detail(cls, detail) -> bool:
        text = cls._detail_text(detail).lower()
        return any(
            phrase in text
            for phrase in (
                "permission denied",
                "access denied",
                "not allowed",
                "forbidden",
                "permissionerror",
                "notallowederror",
                "securityerror",
                "blocked by permissions",
            )
        )

    @classmethod
    def _is_timeout_detail(cls, detail) -> bool:
        text = cls._detail_text(detail).lower()
        return "timed out" in text or "timeout" in text or "time out" in text

    @classmethod
    def _is_watchdog_detail(cls, detail) -> bool:
        """Return True only for the transport's own in-page watchdog.

        Browser/application timeout messages are not proof that the currently
        running expression can be terminated.  Only the private marker means
        this transport owns the observation timeout and should poison the
        session without replaying the expression.
        """

        return _EVAL_WATCHDOG_MARKER in cls._detail_text(detail)

    def _mark_watchdog_timeout(self) -> None:
        """Record an observation timeout without claiming cancellation.

        The Promise.race watchdog only changes which result is observed.  The
        expression may already have started a fetch or mutation and cannot be
        generically cancelled without risking a page-wide interruption.  Mark
        the session poisoned so the next operation reattaches to a fresh CDP
        session, and leave delivery/side-effect fate unknown.  In particular,
        this path never replays the original Runtime.evaluate.
        """

        self._driver._session_poisoned = True
        logger.warning(
            "Runtime.evaluate watchdog fired; underlying expression fate is "
            "unknown — poisoning session and forbidding replay"
        )

    @classmethod
    def _raise_for_permission_error(cls, method: str, response: dict) -> None:
        """Raise only explicit permission failures from any CDP command.

        The low-level command contract intentionally leaves ordinary CDP
        ``error`` objects untouched.  Permission failures are the exception:
        treating one as a normal response can make a domain listener report
        itself ready when Chrome actually refused the operation.
        """

        error = response.get("error") if isinstance(response, dict) else None
        if error and cls._is_permission_detail(error):
            raise PermissionError(f"{method} permission denied: {cls._detail_text(error)}")

    @classmethod
    def _raise_for_cdp_error(
        cls, method: str, response: dict, timeout: float
    ) -> None:
        """Raise typed errors for a CDP response-level ``error`` object."""

        error = response.get("error") if isinstance(response, dict) else None
        if not error:
            return
        if cls._is_permission_detail(error):
            raise PermissionError(f"{method} permission denied: {cls._detail_text(error)}")
        if cls._is_timeout_detail(error):
            raise CDPTimeoutError(method, timeout, phase="cdp")
        # Import lazily to preserve cdp_driver <-> cdp_transport startup order.
        from .cdp_driver import CDPJSError

        raise CDPJSError(
            f"CDP error in {method}: {cls._detail_text(error)}",
            details=error if isinstance(error, dict) else {"error": error},
        )

    async def _js_with_data_strict(
        self, expr_template: str, data: dict, timeout: float = 15
    ) -> str:
        """Strict variant of _js_with_data — raises CDPJSError on failure."""
        wrapped = f"( (__D) => ({expr_template}) )({json.dumps(data)})"
        return await self._driver._js_strict(wrapped, timeout=timeout)
