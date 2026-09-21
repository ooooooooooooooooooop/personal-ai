# Reliability acceptance

Use the same Python installation as the MCP host. A passing unit test, a
successful new process, and an upgraded existing host are different evidence.
Keep runtime reports outside this public repository.

The stdio verifier reads the expected contract and source fingerprint from
this checkout as data, then compares them with the installed server's reply.
It does not add the checkout to the server's import path or accept an old
installation merely because that installation agrees with itself.

The dedicated `chatgpt-web` CI job runs the complete offline suite and actual
installed stdio entrypoint on Windows and Linux, independently of the repository
lint job. It explicitly disables account E2E tests, records slow tests and saves
JUnit results. A twenty-minute job limit prevents a wedged regression from
waiting indefinitely. CI does not claim that account-backed browser checks ran.

## Required layers

| Layer | Command / evidence | What it establishes |
| --- | --- | --- |
| Offline behavior | `python -m pytest -m "not e2e"` | Recovery budgets, delivery boundaries, cancellation, permissions, lease cleanup and local WebSocket routing. |
| Installed MCP protocol | `python scripts/verify_stdio.py` | Installed server starts in an explicitly isolated lazy-pool configuration, exposes the tools, and reports the expected contract and source fingerprint over actual stdio. |
| Public MCP read | `python scripts/verify_stdio.py --read` | The configured browser and lazy driver pool can complete one public read. No message is sent. |
| Real browser, no send | `python scripts/verify_browser.py --cdp-port 9222` | Own scratch tab, 90/300-line Unicode input and exact verification, cleanup, cancellation, three same-target reconnects and concurrent response routing. |
| Actual host activation | `runtime_info` on the host's connection, or that host's recorded `initialize` response | Match the advertised PID and start time to the live host child. Require matching startup/disk fingerprints, expected contract and `restart_required=false`; independently hash the current checkout. A new-process test cannot replace this. |
| Live send / persistence | Explicitly authorized disposable conversation | One submitted test turn has an exact receipt and persisted assistant response. Do not run this layer under maintenance-only or read-only authorization. |

Report each layer as passed, failed, or not run. An untested layer does not
become passed because a neighboring layer succeeded. Fixes must preserve the
public permission boundary and may not rely on browser refresh, switching to
another debugging port, or unbounded retries.

The standard `initialize` response advertises `capabilities.experimental["chatgpt-web2api/runtime"]`
with the same identity fields as `runtime_info`. This works when a host discards
server stderr; the handshake's `serverInfo.version` is the bridge package version,
not the MCP SDK version. A recorded handshake attests its initialization time,
so reject dead/reused PIDs and compare the current source separately. Later source
edits require another identity check or host reconnection.

## Failure scenarios that must remain covered

- An input timeout can leave a draft. Retyping replaces it; a failed focus or
  rejected insert does not authorize blind cleanup of an unrelated draft.
- A readiness probe that never finds an enabled send button must not dispatch
  a speculative click.
- A timeout after possible submission never replays the send. Receipt absence
  remains unknown.
- Poison recovery and the send wrapper share one pre-submit retry allowance.
  A recovery sanity probe must run without waiting on its own recovery lock.
- A stale reader cannot receive on a replacement socket or fail its futures.
- Cancellation cannot strand a pool lease, swallow the request deadline, or
  leave a newly materialized driver without an owner.
- A permission denial remains a permission denial through the driver, pool
  and fallback layers.
- A successful empty list, a backend HTTP failure, a backend request deadline
  and a CDP session timeout are different outcomes. Read-only fetches have a
  shared abort/status boundary; error bodies must not be exposed as tool data.

Freeze implementation before the complete regression run. If another change
is made during collection/execution, that run does not attest the final source.
Preserve real-browser failures and their source fingerprint instead of
overwriting them by retrying until green. The public read check and browser
composer/transport check are independent, so an upstream failure cannot hide
which other layers actually passed.

`Promise.race` settles observation but does not cancel a losing operation; do
not infer “nothing happened” from its timeout. See the
[Promise.race contract](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/race).
WebSocket receive cancellation is supported, while concurrent receivers on one
connection are forbidden; see the
[websockets connection contract](https://websockets.readthedocs.io/en/stable/reference/asyncio/connection.html).
