# Bug report — 2026-09-19 — composer insert cost (newline-driven) + unrecoverable poisoned session

Reported from a downstream consumer session delivering a long audit over this
bridge. Two related defects occurred during an 11-message chunked delivery.
Private conversation identifiers are omitted from this public report.

## Defect A — `_insert_text` cost scales with newline count, not bytes

**Symptom.** `type_message` returns `not_started` with a 3s `Runtime.evaluate`
timeout, yet a partial draft appears in the composer (DOM side effects despite
"not_started"). Retrying per the old intuition makes it worse: each attempt
adds another partial draft, and the now-larger draft makes every subsequent
insert slower — a self-locking loop.

**Root cause (measured).** The insertion path uses
`document.execCommand('insertText', …)` (see `chatgpt_dom.py`). On ChatGPT's
ProseMirror composer this fires **one transaction per text segment/line**, so
cost is driven by **newline count**, not byte count:

| Payload | execCommand('insertText') | paste-event dispatch |
|---|---|---|
| ~3 KB, ~90 lines | ~31 s (times out) | ~0.02 s |

This fully explains the earlier "composer draft pollution" incident
(2026-09-18): the insert was still running when the timeout fired, and the
residue then poisoned follow-up operations.

**Suggested fix.** Insert via a synthetic paste event
(`ClipboardEvent` with a `DataTransfer`, dispatched on the composer) — a single
ProseMirror transaction regardless of line count — or otherwise batch the
insert into one transaction. Also: `not_started` semantics should distinguish
"not submitted" from "no DOM side effects yet"; today a partially-inserted
draft reports as `not_started`, which invites exactly the resend that wedges
the channel.

## Defect B — poisoned session is unrecoverable in-band

**Symptom.** After defect A wedged the conversation slot, every subsequent
call on that slot failed with the same 3s evaluate timeout — including the
recovery path's own post-reconnect sanity evaluate (`location.href`,
`send_recovery.py:61-64`). Meanwhile a **fresh direct CDP websocket to the same
page target answered identical evaluates in ~0.1 s**, so the page itself was
healthy.

**Analysis.** Consistent with the `_poison_session` comment ("one evaluate
that never settles head-of-line blocks all later commands in the session"),
plus a likely reader-task leak: `_reader_loop` (`cdp_transport.py:187`) does a
dynamic `d._ws.recv()` per iteration; if the old reader task survives a
reconnect, `websockets` forbids concurrent `recv`, the new reader dies, and no
response is ever routed again — every evaluate then times out at the transport
layer. Reconnect only cancels the `_reader_task` it knows about, so the leak
is never healed. The pool TTL sweeper
(`mcp_session_pool_ttl_seconds=300`) also did not reclaim the slot within the
waited window (suspected leaked `in_flight` reference or wedged
rematerialization).

**What fixed it.** Killing the bridge process and letting the host respawn it
(new pool, new asyncio state). After respawn, the same delivery completed with
zero timeouts.

**Suggested fixes.**
- On reconnect, cancel *and await* the old reader task; treat a
  `ConcurrencyError` in the reader as fatal to the driver, not just the read.
- Track `in_flight` so the sweeper can force-reap slots whose sanity evaluate
  has failed N consecutive times (a slot that fails its own recovery probe is
  dead by definition).
- Surface "session wedged, restart required" as a first-class error instead of
  repeated per-call timeouts.

## Workaround used downstream (for reference only)

Instantiated the bridge's `CDPDriver` directly, monkeypatched `_insert_text`
to the paste-event path, and ran the full `send_and_stream` discipline
(baseline/anchor/pace/capture/ack/reconcile) unchanged. All 11 chunks
delivered and backend-verified (conversation total 20 → 44). This was an
emergency measure to complete a time-sensitive delivery, not a bypass of bridge
policy; no messages were resent, and every chunk was verified persisted before
the next was sent.

## Environment

- Bridge process at failure: pid 15228 (wedged); pid 28868 (after restart, healthy).
- Bridge code state: RELIABILITY.md revision `2026-09-18.2`.
- Client: Claude Code MCP host on Windows 11, CDP endpoint 9222.
