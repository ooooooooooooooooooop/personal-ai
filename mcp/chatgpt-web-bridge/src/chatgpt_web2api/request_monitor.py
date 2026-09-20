"""Bounded progress reporting; a heartbeat never extends a request deadline."""
from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar

ProgressCallback = Callable[[str], Awaitable[None]]
request_progress: ContextVar[ProgressCallback | None] = ContextVar("request_progress", default=None)


class RequestMonitor:
    def __init__(self, callback: ProgressCallback | None, budget: float, interval: float = 5):
        self.callback = callback
        self.budget = budget
        self.interval = interval
        self.started = time.monotonic()
        self.phase = "Waiting for browser/driver availability"
        self._task: asyncio.Task | None = None
        self._notify_lock = asyncio.Lock()

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    async def _emit(self) -> None:
        if self.callback is None:
            return
        # Progress delivery must not consume the operation's whole budget.
        try:
            async with asyncio.timeout(0.5):
                async with self._notify_lock:
                    await self.callback(
                        f"{self.phase} | elapsed={self.elapsed:.1f}s budget={self.budget:g}s"
                    )
        except Exception:
            pass

    async def update(self, phase: str) -> None:
        self.phase = phase
        await self._emit()

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            await self._emit()

    async def __aenter__(self):
        await self._emit()
        if self.callback is not None:
            self._task = asyncio.create_task(self._heartbeat())
        return self

    async def __aexit__(self, *exc):
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
