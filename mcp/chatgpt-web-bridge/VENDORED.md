# Vendored fork notice

Source: <https://github.com/Octo-Lex/ChatGPT-Web2API> @ `497527d` (MIT, Elephant Rock Lab).

Local delta carried in this copy (applied on top of upstream):

- **pre-submission timeout recovery** (`send_recovery.py`): a request may
  reconnect to its original target once (15-second cap) only while submission
  is known not to have started. Post-click transport failures check receipts
  by captured message ID (8-second cap), never resend. Arbitrary CDP evaluate
  and input commands are not replayed by the transport. Permission denial and
  cancellation stop the operation; recovery does not reload or launch a browser.

- **conv-affinity**: a tab's URL is its conversation identity — `/c/{id}` tabs are
  persistent shared resources adopted across sessions/processes; one tab per
  conversation; conv-bound tabs are never navigated away or closed by drivers.
- **background tab creation**: `Target.createTarget` uses `background:true` —
  the bridge never steals window focus.
- **request pacing** (`request_pace.py`): cross-process account-level throttle —
  send ≥30s, backend reads ≥8s, shared cooldown on 429. Prevents the
  「请求过于频繁/限制访问对话记录」 interstitial instead of reacting to it.
  Cooldowns are kind-split: a send-path rate limit (UI popup — account-wide)
  writes `cooldown_until` and gates both kinds; a 429 on
  `/backend-api/conversation*` — upstream's endpoint-scoped conversation
  limiter, sends keep working while it is active — writes
  `read_cooldown_until` and gates reads only.
- **conversation-read coalescing** (`mcp_server._conv_read_coalesced`):
  `wait_reply`/`get_conversation` polls dedup across pool slots via an
  in-flight join plus a cache whose TTL equals the read pace interval — the
  shared gate could not have returned fresher data anyway, and every saved
  request is one fewer hit on the flagged endpoint family. A joiner never
  holds the slot lock while awaiting a peer's fetch. Verification reads
  (`_verify_reply_persisted`) bypass the cache for current truth, invalidate
  the conversation's entry at send time, and write fresh results back so
  coalesced waiters see post-send state immediately.
- **project name resolution** (`resolve_project_id`): `project_id` accepts an
  exact project name; unknown/ambiguous names fail instead of landing in the
  wrong project.
- **upstream fixes**: temp-route misrouting, zh placeholder premature
  completion detection.
- **composer multiline insert** (`chatgpt_dom._insert_text`): CDP
  `Input.insertText` truncates at the first `\n` on the current
  conversation-page composer (only the first paragraph lands — observed
  live 2026-09-14 after a ChatGPT frontend update; the new-chat page
  composer still splits paragraphs correctly). Insert now goes through
  `document.execCommand('insertText')`, which routes through the editor's
  own text-insertion path and produces the block structure the canonical
  verifier reads back.
- `start.ps1`: persistent-Chrome topology launcher (Chrome standalone,
  daemons attach; restarting daemons never touches the browser/login).
- **lazy Chrome bring-up in MCP**: the stdio MCP path may call
  `ChromeProcess.ensure_running()` before its first tool call, giving it a
  harness-bound lifecycle with no resident daemon when unused. The shared
  SSE/REST daemon is managed by its launcher and health state; do not apply
  daemon restart advice to a stdio process. `install.ps1` resolves the venv
  via `W2A_VENV` (repo-external) else package-local `.venv`, matching
  `start.ps1`.
- **reply delivery reporting** (`chat_completion`, `chat_with_gpt`):
  post-send results expose the conversation ID and a persistence/delivery
  receipt when the bridge can establish one. `reply_persisted=true` means an
  assistant node was observed, not necessarily that its turn is terminal;
  tail `in_progress` still wins. A positive receipt is consumed as delivery
  evidence; false, null, absent, or ambiguous state is not an instruction to
  resend. A client timeout, cancellation, or transport error leaves delivery
  unknown until the same conversation is checked once. Recovery never nudges
  a conversation that is still generating; a retry needs explicit terminal
  failure evidence and the same target.
- **`wait_reply` tool**: waits for a terminal assistant message or returns
  an evidence-bearing timeout (including `tail_status`, source and elapsed
  time). A user tail or an early/dead-style status is not by itself proof that
  a send was lost. `since_total` accepts a prior `get_conversation` `total` to
  wait only for a NEW reply. It replaces hand-rolled unbounded polling loops.
- **`get_conversation` disambiguation + file channel**: results now carry
  `reason` (`ok` / `empty` / `not_found` / `fetch_failed`) — 404s and fetch
  errors no longer masquerade as empty conversations — and `out_file`
  (absolute path) writes the page to disk so long replies never have to
  cross the MCP tool-result budget. Callers consume an `out_file`, a
  client-exposed overflow pointer or partial-page marker before issuing
  another read; safe tail/DOM
  observations remain explicitly marked as partial. A DOM `total` is only a
  rendered lower bound; `paging_supported=false` means do not advance
  `offset` as if the partial tail were a backend page.
- **`wait_reply` terminal-status gate**: a persisted assistant node whose
  backend status is still `in_progress` no longer counts as "replied" —
  the early-intro false positive (observed 2026-09-15) that made callers
  consume partial replies and misdiagnose a live generation as dead. The
  result gains `tail_status`; on `timeout`, `in_progress` means the web
  side is still generating (wait again, don't nudge).
- **composer draft auto-clear**: any failure inside the send window
  (type → click → send-ack), including client-side cancel, best-effort
  clears the composer — a failed send can no longer leave a draft that
  poisons the next send's canonical verification (observed 2026-09-15:
  recovery previously required manual browser-side cleanup).
- **`wait_reply` lock scope** (pool mode): the leased slot's `call_lock` is
  held only around each fetch, not across the poll sleep. It ran on the
  shared utility slot inside the lock for up to `timeout_seconds`, so one
  caller's wait queued every other read tool from every session behind it
  (observed 2026-09-15: a single MCP session shared by all Devin
  conversations, all of them stalled on chatgpt-web).
- **pinned utility slot**: `mcp_driver_pool.PINNED_SLOT_KEYS` exempts the
  shared utility slot from the idle-TTL sweep — closing its owned tab made the
  next read tool pay a full chatgpt.com page load (unpaced backend traffic)
  to recreate it. Conversation-bound slots stay sweepable (their tabs persist;
  re-materializing is an adopt, not a page load).
- **throttle attribution + pace logging**: `record_throttle(source=…)` logs
  which call site observed the 429 / rate-limit popup and how long the shared
  cooldown runs; `pace()` logs waits ≥1s (flagging account cooldown); the pool
  logs each lease's hold time on release. Both daemon entrypoints attach a
  rotating file log (`diagnostics.attach_daemon_log`) at
  `~/.chatgpt-web2api/diagnostics/{rest-8080,mcp-sse-8090}.log` — every
  launcher (start.ps1 hidden window, `ensure` self-heal with stderr=DEVNULL)
  used to drop stderr, leaving cooldowns unattributable. stdio MCP is
  untouched: the harness owns its stderr.
- **shared home workspace** (`cdp_driver._adopt_bare_home_tab`): non-conv
  drivers (utility slot, unbound session slots, the REST driver) adopt ONE
  existing bare `chatgpt.com/` tab instead of each parking a private
  homepage — converges the browser to ~1 background tab regardless of slot
  count, removing unthrottled per-slot ChatGPT clients from the flagged
  endpoint family. The adopted tab is `_shared_home_target` — lockable via
  the targetId-keyed MutationLock (parallel-mode sends stay legal), never
  closed by us; a shared tab navigated into `/c/{id}` flips to conv-bound so
  it is never navigated away from under its co-attached drivers.
  Conv-affinity drivers are unchanged: they still create/adopt dedicated
  `/c/{id}` tabs (per-conversation DOM isolation).
- **single shared chat router** (`cdp_driver.route_chat_target`): MCP and REST
  call one function — an explicit `conversation_id` ALWAYS continues that
  conversation (`ensure_current_conversation` verifies the live URL even when
  `_current_conv_id` already matches); `project_id` only scopes NEW
  conversations and can never veto an explicit target. Kills the 2026-09-17
  misroute (conv-affine tab preset `_current_conv_id` + non-empty
  `project_id` fell through to `navigate_new_chat` → messages went into
  fresh conversations).
- **conv-bound tab protection**: `ensure_scratch_tab` no longer bootstraps a
  conv-affine driver through bare `connect()` (its affinity re-adopted the
  very tab it was leaving); it creates an owned scratch tab via
  `_create_owned_tab(scratch=True)`. `navigate_new_chat` fails closed if the
  driver is still `_conv_target` after detaching — a shared conversation tab
  can never be navigated to a new chat.
- **non-blocking read gate** (`RequestPace.read_blocked_seconds` +
  `ReadThrottledError`): conversation reads probe the shared cooldown and
  fail fast instead of queueing behind it — the completion detector degrades
  to DOM observation (ReadThrottledError subclasses RuntimeError → the
  `fetch_failed` wrapper path), `wait_reply`/`get_conversation` return
  `status/reason=read_throttled` with `retry_after`, REST maps it to a 429.
  Read-path 429s honor upstream `Retry-After` and otherwise escalate the
  cooldown per consecutive-429 streak (300→600→1200→1800s cap), reset by
  `record_read_ok` on the first definitive non-429 answer.
- **tool-failure logging**: `_call_tool_pooled` logs every mapped exception
  (`tool %s failed (mapped): %s: %s`) and unmapped ones with traceback — a
  client-visible error can no longer leave zero trace in the daemon log.
- **streamable-HTTP transport**: the SSE daemon's Starlette app also mounts
  `/mcp` (`StreamableHTTPSessionManager`, stateful sessions) so harnesses
  without legacy-SSE clients (e.g. Codex, stdio + streamable-http only)
  converge on the same daemon/pool instead of spawning per-session stdio
  processes that share one Chrome without a shared pool. Session identity for
  the driver pool resolves `mcp-session-id` header → `http:{id}`.
- **send-button selector**: `#composer-submit-button` leads the chain (the
  2026 composer's canonical id); aria-label matching now also covers the
  Chinese "发送" label instead of relying solely on the testid fallback.
- **generation gate** (`generation_gate.py`): cross-process `generating.json`
  marks a conversation mid-generation after send acknowledgement; a second
  send to that conv — any process, any tab — fails fast with
  `GenerationInProgressError` (MCP `generation_in_progress`, REST 409) plus
  a live DOM probe (`is_generating`) covering manual browser sends.
  MutationLock is per-target and cannot cover same-conv/different-tab sends.
- **conversation binding** (`conv_binding.py`): `conv_bindings.json` binds a
  conversation to the target and the session that confirmed it. A first send
  — existing conv or brand-new chat — can return `confirmation_required`
  (Project + title + occupant warning, or `is_new_conversation` for fresh
  chats); `confirm=true` claims/takes over. A reconnect alone does not
  invalidate a still-valid explicit approval for the same target;
  re-confirm only when the Project/conversation/permission scope changes, the
  binding is stale, or the prior approval cannot be matched. `last_seen` TTL
  (30 min) + a bounded, safe Windows owner-pid liveness probe reclaim
  abandoned/daemon-restarted bindings.
  Reads never touch the registry.

- **runtime identity and bounded progress** (`runtime_info.py`, request
  monitoring): the running instance reports its startup source fingerprint,
  disk fingerprint, `started_at`, capabilities and `restart_required`, so a
  source edit is not confused with a live deployment. Long requests emit
  factual phase/elapsed progress with a bounded heartbeat; progress does not
  extend the operation deadline and does not justify a retry.

Runtime state is NOT vendored: `.venv`, `~/.chatgpt-web2api/` (config, tab
registry, pace file, locks, diagnostics, chrome profile — consolidated from
the pre-2026-09 split `~/.chatgpt_web2api/` dir, still honored as a legacy
config fallback), and conversation ids live per-device / per-account.
