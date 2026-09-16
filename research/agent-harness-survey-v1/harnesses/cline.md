# Cline

> Steward: Cline (cline.bot) · License: Apache-2.0 · Impl. language: TypeScript (Bun/Node) · First release: 2024 · **Version studied: `722b640c281f52e713e2ce88d05af1a3993af8d2` (main, 2026-09-15), accessed 2026-09-15**
> Repo: https://github.com/cline/cline · Docs: https://docs.cline.bot
> Epistemic basis: SOURCE-READ

**Important context:** at this commit Cline is a **monorepo that has fully restructured** — the historical single-file `src/core/task/index.ts` agent loop is gone. The runtime is a layered SDK (`sdk/packages/{shared,llms,agents,core}`) consumed by host apps (`apps/vscode`, `apps/cli`, `apps/cline-hub`, Tauri desktop example). Everything below describes this SDK architecture.

## 1. Positioning & design philosophy

Cline's bet is **"agent loop as embeddable SDK + host shells"**: the agent loop is a stateless, host-agnostic library (`@cline/agents`) with hook points; state, storage, approvals, and UI are pushed to `@cline/core` and host apps. The second bet is **hub-and-spoke session authority**: a detached `cline-hub` daemon can own sessions over WebSocket so multiple clients (CLI TUI, VS Code, desktop, automation) attach to the same authoritative runtime — the VS Code extension itself runs `backendMode: "local"` in-process by default (`apps/vscode/src/sdk/vscode-session-host.ts:167`). Tools are JSON-schema "AI SDK" style (`AgentTool` with `inputSchema` + `execute`), not XML text blocks — Cline abandoned XML tool-call parsing entirely.

## 2. Architecture overview

**Layers (FACT, sdk/ARCHITECTURE.md):**
- `@cline/shared` — contracts, zod schemas, hook event schema, storage paths, prompt builder, remote-config primitives
- `@cline/llms` — provider handlers via a generated models.dev-style catalog (`providers/providers.generated.ts`, ~200 provider specs), client families `openai-responses|openai-chat|anthropic`, model capabilities/facts
- `@cline/agents` — stateless `AgentRuntime` (alias `Agent`) — the loop, tool orchestration, hooks, event stream
- `@cline/core` — `ClineCore` facade (sessions, persistence, checkpoints, cron, hub, plugins, settings), `LocalRuntimeHost`/`HubRuntimeHost`/`RemoteRuntimeHost` via `runtime/host/host.ts`
- Apps — `apps/vscode` (extension; controller + webview bridge), `apps/cli` (Bun TUI + headless), `apps/cline-hub` (daemon + web UI), `apps/examples/desktop-app` (Tauri + Bun sidecar)

**Process model (FACT):** in VS Code, the extension host process runs `ClineCore` → `LocalRuntimeHost` → `AgentRuntime` in-process; the React webview talks to the extension over a **protobuf-defined gRPC-style bridge** (`apps/vscode/proto/cline/*.proto` services — task, checkpoints, mcp, models, state, slash…— serialized over `postMessage`; `apps/vscode/src/core/controller/grpc-handler.ts` + `webview-grpc-bridge.ts`). `apps/cli` auto-spawns the `cline-hub` daemon (per repo AGENTS.md) and connects over its WebSocket transport; the hub daemon owns `RuntimeHost` instances and brokers sessions/approvals (`sdk/packages/core/src/hub/{daemon,server,client,discovery}`).

**Agent loop location (FACT):** `sdk/packages/agents/src/agent-runtime.ts` (`AgentRuntime.execute`, :716). Session orchestration: `sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts`, `runtime-builder.ts`.

## 3. Agent loop

**Turn structure (FACT, agent-runtime.ts:716-968):** `execute()` → `callBeforeRunHooks` → emit `run-started` → push input messages → optional `getCompletionToolReminderMessage` → `while (iteration < maxIterations)`: `turn-started` → `generateAssistantMessageWithProviderRetry` (provider retry w/ backoff that still honors abort, :1091) → push assistant message, emit `assistant-message` → if no tool calls: emit `turn-finished`, then `getCompletionReminderMessages()` may inject a "reminder" user message and `continue` (re-prompt); else `finishRun("completed")` + `afterRun` hooks + `run-finished`. If tool calls: `executeToolCalls` (sequential or `toolExecution === "parallel"` via `Promise.all`, :1800), append tool messages, flush `pendingHookContexts` into a `displayRole:"system"` user message, then `findCompletingToolMessage` — a tool whose `lifecycle.completesRun === true` (e.g. `submit_and_exit`) with a non-error result ends the run.

**Stopping conditions (FACT):** no-tool-call turn (+empty reminder set) → completed; completing-tool success → completed; `finishReason === "max-tokens"` with no tool calls → throw `MAX_TOKENS_INCOMPLETE_TURN_MESSAGE`; empty response → `Error("Model returned empty response")`; abort (`AbortController`, `ControlledStopError`, `AgentRuntimeAbortError`); exceeding `maxIterations` → throw.

**Retry/recovery (FACT):** per-turn `resetLastError`; provider errors classified via `classifyProviderError` into `errorClass` (`context_window_exceeded`, rate-limit, etc.); `ContextWindowOverflowError` triggers a **single** `overflowRecoveryAttempted` compaction retry (:732) through the context pipeline (recovery forces deterministic "basic" strategy, compaction.ts:44-49). Consecutive-mistake limiting is host-visible (`handleConsecutiveMistakeLimitReached` in the VS Code coordinator returns `{action:"stop"}` — stops the run rather than blocking, sdk-interaction-coordinator.ts:76). Hooks (`beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent`) can `applyStopControl` to halt the run.

**Planning (FACT):** none in the loop itself — Plan mode is a *tool preset + prompt contract + command guard* (see §6), not a loop branch.

## 4. Tool system

**Inventory (FACT, `extensions/tools/definitions.ts` + `presets.ts`):** `read_files` (batched multi-file), `search_codebase`, `run_commands` (batched shell commands w/ per-command output), `fetch_web_content`, `apply_patch`, `editor` (file write/edit), `skills` (load SKILL.md), `ask_question`, `submit_and_exit` (completion tool with `completesRun` lifecycle), plus preset-gated `spawn_agent`/`agent_teams` (see §7) and host `extraTools`. Presets: `act` (all minus apply_patch, no submit_and_exit — the interactive VS Code default), `plan` (act minus `editor`), `search`, `minimal`, `yolo` (adds `submit_and_exit`, drops ask_question, all policies auto-approved).

**Edit mechanism (FACT):** `editor` executor is host-provided (VS Code: `sdk-diff-edit-coordinator` shows inline diff preview + `autoApprovePreviewLingerMs`); `apply_patch` executor exists (Codex-style patch grammar, `executors/apply-patch-parser.ts`). There is no XML `<<<<<<< SEARCH` diff format in the SDK path — edits go through tool JSON inputs.

**Tool-result handling (FACT):** executors bound output (`executors/output-limits.ts`); shell output streams emit structured `tool-updated` events via `context.emitUpdate` which the hub maps to `tool.updated`; "proceed while running" detaches a foreground command into a size-capped temp log with active-command PID markers (ARCHITECTURE.md).

**MCP (FACT):** `extensions/mcp/` — `client.ts` wraps the official MCP SDK; transports `stdio|sse|streamableHttp` (types.ts:40-54), per-server connect budgets (~6s), OAuth callback `http://127.0.0.1:1456/mcp/oauth/callback`, dual stdio framing probe (Content-Length + newline JSON, client.ts:103-159), `mcpServers` config in `cline_mcp_settings.json` (`~/Documents/Cline/MCP/` legacy → `~/.cline/data/settings/`, `apps/vscode/src/hosts/vscode/mcp-settings-legacy-migration.ts`). Each server tool is wrapped as an `AgentTool` via `createMcpTools` (host side: `apps/vscode/src/sdk/vscode-runtime-builder.ts` `McpHubToolProvider`).

**Tool gating (FACT):** per-tool `ToolPolicy {enabled, autoApprove}` map (`config.toolPolicies`) + `beforeTool` hook `policy` overrides; the VS Code host builds policies from user auto-approve settings (`sdk-tool-policies.ts`).

## 5. Context management

**System prompt (FACT):** `sdk/packages/shared/src/prompt/cline.ts` `buildClineSystemPrompt` — selects base prompt `DEFAULT_CLINE_SYSTEM_PROMPTS.ACT|YOLO` (`prompt/system/{act,yolo}.ts`, ~35 lines each — much shorter than legacy Cline's multi-thousand-line prompt), substitutes `{{PLATFORM_NAME}}/{{CWD}}/{{CURRENT_DATE}}/{{IDE_NAME}}/{{CLINE_METADATA}}/{{CLINE_RULES}}`. `CLINE_RULES` slot = caller rules + `MODE_TAG_INSTRUCTIONS` (explains `<user_input mode="...">` wrappers stamped on user messages) + `PLAN_MODE_INSTRUCTIONS` when mode=plan (two variants: `switch_to_act_mode` tool for CLI, or manual-toggle for VS Code). `CLINE_METADATA` = `# Workspace Configuration` JSON (root, hint, git remotes w/ **credentials redacted** by `redactRemoteUrlCredentials`, latest commit/branch) injected only for the managed `cline` provider.

**Memory/instruction files (FACT):** `.clinerules` + `.cline/rules` + `.cline/cron/*.md` specs loaded by `extensions/config/user-instruction-config-loader.ts`; rules ride in the prompt's rules slot.

**Compaction (FACT):** `extensions/context/compaction.ts` — `COMPACTION_TRIGGER_RATIO = 0.9`, `DEFAULT_TARGET_RATIO = 0.7`, `DEFAULT_PRESERVE_RECENT_TOKENS = 20_000` (compaction-shared.ts:17-19); two strategies: `basic-compaction` (deterministic summarization) and `agentic-compaction` (LLM-driven); provider-rejected context overflow forces basic strategy. Session compaction state persisted (`session/models/session-compaction.ts`); a `pre_compact` hook event exists.

**Retrieval (FACT):** `search_codebase` (host executor — ripgrep-backed in VS Code via `integrations/` + bundled rg binaries) + `read_files`. **No embeddings** in the SDK path — consistent with the "nobody uses embeddings" finding. (The old extension's `codebase_search` semantic search is not in the new tool set; the VS Code host may still expose it via extra tools — INFERENCE, not verified in this pass.)

## 6. Safety model

**Permission modes (FACT):** Plan/Act modes are implemented as tool presets + prompt contract + a **plan-mode command-guard hook** (`extensions/tools/command-guard.ts` + `command-guard-extension.ts` registered by the runtime builder for plan sessions) that hard-blocks file-mutating `run_commands` (rm/mv/cp, `sed -i`, redirection outside /tmp, state-changing git/package commands) with a tool error — defense in depth: prompt says don't, hook enforces. `yolo` preset sets `autoApprove: true` on all tools.

**Approval flow (FACT):** tool policy `autoApprove === false` → `config.requestToolApproval` host callback (agent-runtime.ts:1934). VS Code: `SdkInteractionCoordinator.handleRequestToolApproval` emits a `ClineMessage` ask via the webview bridge, opens the diff preview first (`onToolApprovalAsk`), and resolves on user Approve/Reject (`sdk-interaction-coordinator.ts`). Hub path: approvals are brokered as hub commands to attached clients. Desktop sidecar: **file-based IPC** — writes `{sessionId}.request.{toolCallId}.json` to an approval dir and polls for a `*.decision.*.json` (`runtime/tools/tool-approval.ts`).

**Sandboxing (FACT):** `runtime/tools/subprocess-sandbox.ts` exists (subprocess sandbox lifecycle for shell exec), but the default posture is no OS sandbox — VS Code `run_commands` runs in integrated terminals. Command guard is the destructive-op backstop in plan mode; in act mode, approval + auto-approve lists are it. Secrets: provider keys via host secret storage; MCP OAuth tokens managed in `extensions/mcp/oauth.ts`.

## 7. Orchestration

**Subagents/teams (FACT):** `extensions/tools/team/` — `spawn_agent` (delegated sub-agent run, `delegated-agent.ts`, `subagent-prompts.ts`) and a full **agent-teams** toolset: `team_spawn_teammate`, `team_task`, `team_run_task`, `team_send_message`, `team_broadcast`, `team_read_mailbox`, `team_await_runs`, `team_create_outcome`, `team_finalize_outcome`, `team_status`, `team_shutdown_teammate`, `team_cleanup` etc. (team-tools.ts:303-850) — persistent teammate agents with mailboxes, shared task stores (`tasks/` agenda-task manager w/ SQLite store), and outcome artifacts. Sessions have `parent_session_id`/`parent_agent_id`/`team_name` columns; team state persisted under `~/.cline/data/teams/` (`team-persistence-store.ts`, `state.json` + `task-history.jsonl`).

**Headless/SDK/CI (FACT):** `apps/cli` — interactive TUI (`-i`) and one-shot prompt mode; `cline auth`, `doctor`, cron automation (`core/src/cron/` — `.cline/cron/*.md` one_off/schedule/event specs, SQLite cron store, schedule-tool). `@cline/sdk` package exposes the runtime to third parties; `sdk/examples/` + plugins examples exist.

**Wire protocols (FACT):** hub = WebSocket command/reply + event stream (`hub/server/transport`), discovery records for detached daemon auto-connect, `connectToHub`/`NodeHubClient`/`HubSessionClient`/`HubUIClient` adapters; extension↔webview = protobuf-over-postMessage services; desktop = file-IPC approvals + WS transport; ACP support appears in `apps/cli/src/acp` (not verified in depth).

## 8. Extensibility

- **Hooks** (FACT): `core/src/hooks/` — event names `agent_start|agent_resume|agent_abort|agent_end|agent_error|tool_call|tool_result|prompt_submit|pre_compact|session_shutdown` (shared/hooks/events.ts:58-69); file-based hooks discovered from config dirs by filename (TaskStart/TaskResume/TaskCancel/TaskComplete/TaskError/PreToolUse/PostToolUse/UserPromptSubmit/PreCompact/SessionShutdown with .sh/.js/.ts/.py… extensions, hook-file-config.ts:30-62), run via subprocess with JSON payload; in-process `AgentHooks` hook points throughout the runtime; hook output can `appendContext` into the model stream (agent-runtime.ts:856-873).
- **Plugins** (FACT): `extensions/plugin/` — plugin loader + **plugin sandbox** (`plugin-sandbox.ts`, module import isolation) + plugin-contributed skills/MCP servers (`agent-plugin/loader.ts`, `plugin-server-registration.ts`); plugins live under extensions dirs; `sdk/examples/plugins`.
- **Skills** (FACT): `skills` tool loads SKILL.md; agent-plugin packages carry `skills/` components (loader.ts:420-563).
- **Slash commands**: `builtin-slash-commands.ts` + slash proto service; workflows under `.cline/`.
- **Custom tools**: host `extraTools` + hub `custom_tool.*` capability executors (e.g. `switch_to_act_mode` is a client capability in hub, hub-capability-tool-executors.test.ts:191).
- **Remote config / managed instructions**: `remote-config/` + `shared/src/remote-config` — org-managed instruction materialization for enterprise deployment.

## 9. Session & state

**Persistence (FACT):** `~/.cline/data/` (env `CLINE_DATA_DIR`): `db/sessions.db` (SQLite via `services/storage/sqlite-session-store.ts` — session rows incl. `parent_session_id`, `team_name`, `is_subagent`, `transcript_path`, `hook_path`, `messages_path`, `status_lock` for stale-session reconciliation), `sessions/<id>/` per-session dirs with `manifest` JSON (`stores/session-manifest-store.ts`, zod-validated `SessionManifest`), message/transcript files, hook log `hooks.jsonl`; `teams/` for team state; `connectors.db` separate DB so connector credentials stay decoupled. Optimistic-concurrency retries (`OCC_MAX_RETRIES = 4`) on writes; stale sessions reconciled (`failed_external_process_exit`).

**Resume/fork (FACT):** sessions resume by id (`SessionType`/status machine: `running|idle` transitions owned by turns); hub attach/detach lets another client resume the same session; `ClineCore.restore` replaces a session's history at a checkpoint and starts a replacement session.

**Checkpoints (FACT — major redesign):** `hooks/checkpoint-hooks.ts` — after each run, creates a **stash-compatible commit in the user's own repo**: `git stash create` + synthesized third parent for untracked files (persistent per-session `GIT_INDEX_FILE` under `~/.cline/data/checkpoint-scratch/<sha256(cwd+sessionId)>` for incremental hashing; pins `-c core.ignorestat=false -c core.splitIndex=false`), stored under `refs/cline/checkpoints/{sessionId}/{runCount}` — invisible to `git stash list`. Restore (`session/checkpoint-restore.ts`) = transactional: private ref `refs/cline/restore-transactions/{uuid}` captures pre-restore state via `stash push --include-untracked`, then `reset --hard` + `clean -fd` + `stash apply`; refuses if branch moved off the restore base. No more shadow git repo — the old `checkpoint-shadow-git` approach was replaced by in-repo private refs (contrast Roo Code §11).

## 10. Model layer

**Abstraction (FACT):** `@cline/llms` — `providers/providers.generated.ts` holds ~200 generated provider specs (models.dev-style catalog: `abacus`…`zai`), each mapped to one of a few client protocols (`openai-responses`, `openai-chat`, `anthropic` — builtins.ts:607-620); custom routing metadata (bedrock cache points, anthropic-compatible routes), model capabilities/facts files, `factory-registry.ts` builds handlers. BYOK: API keys per provider; `cline`/`cline-pass` = managed provider (Cline's own backend w/ account auth, workspace metadata injection); OAuth token manager (`runtime-oauth-token-manager.ts`); `vscode-lm` host integration exists in `apps/vscode/src/sdk/vscode-lm`. Fallback/routing: `model-tool-routing.ts` maps models to tool variants; committed-runtime model overrides (`overrides.maxTokens`, `temperature`) per provider+mode in cline-session-factory.ts:894-904.

## 11. Notable mechanisms

1. **Plan mode = preset + prompt + command guard, not a loop state.** The plan contract is written twice (once telling the model, once as enforcement): `command-guard.ts` parses `run_commands` input and hard-blocks mutations. Cheap and portable across hosts.
2. **`submit_and_exit` as a `lifecycle.completesRun` tool.** Run completion is *declared by a tool result*, which lets the hub anchor `task.completed` telemetry to the exact tool call and lets `yolo`/automation runs terminate deterministically — while the interactive VS Code host simply omits the tool and infers turn end (`vscode-runtime-builder.ts:85-87` comment).
3. **In-repo checkpoint refs.** Stash-shaped commits under `refs/cline/checkpoints/` (incl. untracked files as a third parent, persistent scratch index for incremental hashing, transactional restore). All the benefits of shadow-git snapshots without a parallel repo — but note it writes refs into the user's repository.
4. **File-IPC tool approval** (`runtime/tools/tool-approval.ts`): a `*.request.*.json`/`*.decision.*.json` file-pair protocol lets a Bun sidecar get human approval from a Tauri shell with zero sockets — the lowest-tech bridge in the survey.
5. **Detached-command lifecycle with process-generation tokens** (ARCHITECTURE.md): "proceed while running" reaps via PID + start-token pairing so PID reuse can't extend log retention — unusually careful process hygiene.

## 12. Evidence log

- `sdk/packages/agents/src/agent-runtime.ts` @722b640 — loop, stopping conditions, hooks, approval callback — accessed 2026-09-15
- `sdk/packages/core/src/extensions/tools/{presets,definitions}.ts`, `executors/` — tool inventory/presets — accessed 2026-09-15
- `sdk/packages/shared/src/prompt/{cline.ts,system/act.ts,yolo.ts}` — system prompt composition — accessed 2026-09-15
- `sdk/packages/core/src/hooks/checkpoint-hooks.ts`, `session/checkpoint-restore.ts`, `services/storage/sqlite-session-store.ts` — checkpoints + persistence — accessed 2026-09-15
- `sdk/packages/core/src/extensions/mcp/*`, `extensions/tools/team/*`, `extensions/context/compaction*.ts` — MCP, teams, compaction — accessed 2026-09-15
- `apps/vscode/src/sdk/{vscode-session-host.ts,sdk-interaction-coordinator.ts,vscode-runtime-builder.ts,cline-session-factory.ts}`, `apps/vscode/proto/cline/*.proto` — host wiring — accessed 2026-09-15
- Conflicts/gaps: (a) the legacy `src/` tree is gone — older write-ups describing XML tool parsing/`Task` class/`attempt_completion` XML are stale at this commit; (b) `apps/cline-hub` web UI internals and `apps/cli` ACP mode not deeply read; (c) whether VS Code still ships a `codebase_search` semantic tool via extraTools was not confirmed (no embeddings found in SDK default tools); (d) `subprocess-sandbox.ts` existence confirmed but its default enablement not verified.
