# Reliability changes — 2026-09-18

This revision reduces redundant bridge work and makes uncertain delivery explicit.
It does not change ChatGPT's generation speed or lower account pacing limits.

## 2026-09-19.2 — combined recovery and acceptance

The current contract is `2026-09-19.2`. Previous revision results below are
historical evidence, not a substitute for rerunning the current revision.
The repeatable checks and their limits are in [ACCEPTANCE.md](ACCEPTANCE.md).

- Poison self-heal and the send wrapper share one pre-submit recovery
  allowance. Recovery, its sanity probe and the original command use one
  deadline; the sanity probe cannot wait on its own recovery lock.
- Reader creation pins the exact socket before the task starts. Connection
  lifecycle paths share teardown, and a stale reader cannot fail the new
  session's pending commands or dispatch its events.
- Paste explicitly selects the composer contents before replacement. Failed
  focus/insertion does not authorize outer-layer draft cleanup; cleanup and
  input verification preserve cancellation and permission errors.
- Pool cancellation cleanup accounts for physical slots and partially created
  drivers. DOM read failures remain typed failures instead of empty success;
  fallback reads have a bounded allowance and cannot bypass a permission denial.
- Browser-domain permission failures are surfaced before fallback/retry, and
  conversation adoption uses an exact origin and conversation ID.
- The ordinary backend GET readers share an abort/status boundary. Backend
  request timeouts, HTTP failures and CDP timeouts have distinct outcomes;
  non-2xx responses cannot silently become empty lists. This layer does not
  automatically replay requests, and conversation 404 status is preserved.
- The standard MCP handshake carries the live process identity in
  `capabilities.experimental["chatgpt-web2api/runtime"]`. Hosts that drop
  stderr can still attest the actual connection. `serverInfo.version` names
  the bridge package, rather than inheriting the SDK version.

Acceptance includes actual MCP stdio and actual Chrome, with a dedicated
scratch tab and no submitted messages. Live-send persistence and activation
of an existing host must be reported separately; these scripts do not certify
either automatically.

## Contracts

| Situation | Behavior |
| --- | --- |
| A response or overflow file is already available | Consume it before making another request. |
| Only the latest messages are needed | Use `get_conversation(tail=...)`; one fetch supplies the tail and authoritative count when available. |
| Backend reads are throttled | A rendered DOM tail may be returned as partial data. Absolute pagination/counts remain unknown; `out_file` still works. |
| A read waiter is cancelled | Other subscribers may continue; the last subscriber cancels the shared fetch. Each fetch has a bounded lifetime. |
| `wait_reply` reaches its deadline | Return the observed state. A user tail or elapsed time alone does not prove a dead generation. |
| A send may have been submitted | Do not retry the entire send automatically. Preserve delivery stage and available IDs. |
| `Runtime.evaluate` times out before submission | One request-scoped reattachment to the original target, bounded to 15 seconds; rebuild preflight before retry. No reload, target creation, adoption, or browser launch. |
| A transport failure occurs after the click may have run | Check the captured POST and exact message ID, within 8 seconds. Missing/unavailable receipts stay unknown, never authorize resend. |
| An idle pool slot fails its sanity probe on two consecutive sweeps | The slot is dead by definition (its own recovery probe failed). The sweeper force-reaps it — pinned slots and leaked `in_flight` counts included — and the next request materializes a fresh driver. Bounded to ~2 sweep intervals, no process restart. |
| Browser permission is denied | Stop. No alternate browser or transport, permission changes, or manual-refresh workaround. |
| Explicit model selection fails | Fail before submission. Do not label a different model's response as the requested model. |
| A request is waiting | Report stage and elapsed time when the client supports progress. Heartbeats do not extend the absolute deadline. |
| Source files are updated | Query `runtime_info` on the actual client connection to detect a process still running the previous code. |
| A process owner must be checked on Windows | Use process-query APIs, never `os.kill(pid, 0)`. Unknown/access-denied results do not authorize reclaiming its resource. |

Delivery acknowledgement, completion, and persistence are separate facts. The
bridge reports only what it observed. A source fingerprint describes process
startup versus current disk contents; it does not attest to the web model or
browser frontend version.

Recovery contract version: `2026-09-19.2`. A new-process smoke test must not
be described as verification of an existing host's connection. Check
`runtime_info` on that connection, or match its recorded initialize identity to
the live host child and current checkout. Require matching startup/disk
fingerprints and `restart_required=false`. Upgrades use the host's connection lifecycle;
routine send recovery does not ask the user to refresh the browser.

## 2026-09-19.1 — composer insert cost + poisoned-session heal

Fixes for the two defects in
[BUGREPORT_2026-09-19](BUGREPORT_2026-09-19_insert_cost_and_poisoned_session.md),
both reproduced and measured in the field during an 11-chunk delivery:

- **Composer insert is now a single ProseMirror transaction.**
  `_insert_text` on the contenteditable composer dispatches a synthetic paste
  event (`ClipboardEvent` + `DataTransfer`) instead of
  `document.execCommand('insertText')`. execCommand fired one ProseMirror
  transaction per line, so insert cost scaled with newline count (~3 KB / 90
  lines took ~31 s, timed out mid-insert, and the partial draft made every
  retry slower — a self-locking loop). The paste path is flat in payload size
  (same payload ~0.02 s, field-measured). The legacy `<textarea>` fallback
  keeps execCommand: untrusted paste events get no default action on plain
  form controls. The canonical composer verify after insert is unchanged and
  remains the authoritative check, so a no-op paste still fails closed.
- **A stale reader can no longer steal the replacement session.**
  `_reader_loop` pins the socket it started with instead of re-reading
  `driver._ws` each iteration; `reconnect()` and
  `reconnect_for_send_recovery()` close the old socket *before* reaping the
  reader, because close is the one signal guaranteed to end a recv() that
  cancellation failed to interrupt. A reader that ever loses a recv race
  (`ConcurrencyError`) now poisons the session, so the next command
  reattaches a fresh session instead of every call timing out one by one
  behind a socket nobody reads. Previously this combination made a poisoned
  slot unrecoverable in-band — only a process restart healed it.
- **The pool force-reaps slots that cannot heal.** The idle sweeper now
  health-probes idle slots under their call lock (the probe goes through the
  normal `_cdp` path, so it doubles as the poison-recovery trigger). A slot
  failing two consecutive probes is force-reaped and rematerialized on next
  acquire — pinned utility slots included, and `in_flight` counts that
  leaked away from the lease ledger no longer block the sweep. The wedged
  slot in the incident report survived precisely because it was recently
  used (TTL sweep skipped it) and possibly held a leaked `in_flight`
  reference; both holes are closed.

Timeout semantics are unchanged and still load-bearing: a timed-out insert
or send may already have had DOM side effects. The pre-submission recovery
rebuilds preflight (select-all + retype + canonical verify), so a partial
draft is replaced, never duplicated; a possible submission is never
replayed.

Verification for this revision: the package-wide offline run passed all 889
collected tests (31 real-account end-to-end tests excluded). New regression
tests pin the single-transaction paste shape, the textarea execCommand
fallback, reader socket pinning against `_ws` swaps, recv-race poisoning,
wedged-slot force-reap (plain + pinned), probe-recovery reset, and the
`in_flight` leak clamp. A live smoke against the real account
(the former one-off smoke, no message sent) confirmed on the shipping code
path: `location.href` evaluate 0.05 s, `get_projects` returned the real
project list, and the incident-shaped payload (89 newlines) typed and
canonically verified in 0.62 s including the built-in settle waits — the
previously ~31 s execCommand path. The owned smoke tab was closed
afterwards. No live SEND was performed for this revision; activation on an
existing host connection required its own runtime receipt. The one-off script
has since been replaced by [scripts/verify_browser.py](scripts/verify_browser.py);
current acceptance uses the contract at the top of this document.

## Reference projects and protocol guidance

- [ChatGPT-Web2API](https://github.com/Octo-Lex/ChatGPT-Web2API) is the upstream
  basis of this fork. Its DOM transport and retry machinery were inspected;
  replaying an entire operation is restricted here to known pre-submission
  failures.
- [ask-bridge](https://github.com/doggy8088/ask-bridge/blob/main/README.en.md)
  documents visible operation stages, configurable timeouts, and aborting
  before sending when the requested model cannot be selected. Those behaviors
  informed the stage reporting and model-selection contract here.
- [ChatCmd](https://github.com/int04/ChatCmd) documents queue/readiness and
  reconnect handling. Its separation of submission and result recovery informed
  the delivery contract; this patch does not replace the bridge with that
  project's architecture.
- The MCP specification describes [cancellation and resource cleanup](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
  and [request timeouts](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
  Progress is not a reason to let requests run without a maximum deadline.
- [Python's `os.kill` documentation](https://docs.python.org/3/library/os.html#os.kill)
  specifies different Windows signal behavior; signal zero is not a portable
  liveness probe.

These are behavioral references, not copied implementations. Existing upstream
licensing and attribution remain in [VENDORED.md](VENDORED.md).

## Historical verification boundary — 2026-09-18

Offline tests exercise the MCP protocol with a mocked browser, send-stage
transitions, cancellation, file output, model selection, and Windows process
liveness. They do not establish real-account latency or compatibility with a
future ChatGPT frontend. An end-to-end send is a separate test that creates a
real web message; do not confuse an offline pass with that observation.

The results below record that earlier revision, including its failures. They
are not the current acceptance status. Current source must pass every layer
in [ACCEPTANCE.md](ACCEPTANCE.md); private run receipts stay outside the package.

Validation on Windows for the recovery revision:

- The package-wide offline run passed all 866 collected tests; 31 real-account
  end-to-end tests were excluded. After extending permission classification to
  browser `NotAllowedError`/`SecurityError` names, all 121 affected recovery,
  transport, identity, protocol and conversation-guard tests passed (including
  four new permission cases). The full suite was not repeated for that final
  classification-only addition.
- Repository structure, all 22 skill quality gates and `git diff --check` passed.
  A fresh stdio MCP process returned the new contract and a matching source hash
  without acquiring a browser driver.
- Agent-switchboard: 472 tests run, one skipped, no failures. Unchanged Pi and
  DSH suites passed in the original checkout with its installed dependencies.
- The repository-wide unittest run reported a cold-start lifecycle error and
  did not complete within its 180-second limit. It is not reported as a pass.
  The unchanged host suite had 89 passes, one multi-process competition failure
  and five cancelled tests; the app suite lacked Electron (12 passes, one
  failure). These results prevent claiming an all-green repository/release gate.
- The fresh installed stdio smoke returned contract `2026-09-18.2` with matching
  fingerprints. It did not verify an existing Devin-owned stdio connection;
  that connection requires its own `runtime_info` receipt before activation can
  be claimed. No private host RPC or browser-permission workaround was used.
- Real-account web-send tests were excluded. No claim of measured ChatGPT
  generation-speed improvement is made.
