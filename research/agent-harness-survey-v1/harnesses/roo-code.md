# Roo Code

> Steward: Roo Code Inc (RooCodeInc) · License: Apache-2.0 · Impl. language: TypeScript (pnpm monorepo; VS Code extension + `apps/cli`) · First release: 2024 (forked from Cline) · **Version studied: `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` (main HEAD, last commit 2026-05-15 "Remove roocode.com web app"), accessed 2026-09-15**
> Repo: https://github.com/RooCodeInc/Roo-Code · Docs: https://docs.roocode.com
> Epistemic basis: SOURCE-READ

## 1. Positioning & design philosophy

Roo Code's bet is **"Cline's loop, but everything is configurable"**: it kept the original Cline architecture (monolithic `Task` class, say/ask webview protocol, shadow-git checkpoints) and layered on the features Cline deliberately avoided — user-defined **custom modes** (roles with per-mode tool-group permissions), an **orchestrator mode** that delegates subtasks across modes (Boomerang tasks), multiple switchable **edit strategies** (search-replace diff, whole-file, apply-patch, search_and_replace), **embedding-based semantic code search** (code-index + Qdrant), per-mode rules directories, and a cost/request-capped auto-approval system. Where Cline's SDK redesign narrowed the tool surface to ~9 JSON-schema tools, Roo keeps ~24 native tools and an XML-free but provider-native protocol — the fork diverged by accretion, not redesign. FACT: `Task.ts` still contains `recursivelyMakeClineRequests` and comments referring to "cline" (Task.ts:2440-2449) — the lineage is in the identifiers.

## 2. Architecture overview

**Process model (FACT):** classic VS Code extension — everything runs in the **extension host process**; no daemon, no SDK split. `src/extension.ts` activates → `ClineProvider` (`src/core/webview/ClineProvider.ts`, ~3000+ lines) is registered as the sidebar webview view provider and is the God object: owns task stack, state, MCP hub, mode switching, delegation. The **webview UI** (`webview-ui/`, React) talks to the extension via typed `postMessage` (`WebviewMessage`/`ExtensionMessage` unions in `src/shared/`), handled by `webviewMessageHandler.ts`. **External control:** `src/extension/api.ts` exposes `RooCodeAPI` over a **node-ipc Unix/Windows socket** (`packages/ipc/src/ipc-server.ts`, `IpcMessageType` Ack/TaskCommand/etc.) — `apps/cli` connects through it (`apps/cli/src/agent/extension-client.ts`, `extension-host.ts` for spawning a headless extension host). Monorepo packages: `packages/types` (zod schemas), `packages/ipc`, `packages/core` (worktree service, custom tool registry), `packages/vscode-shim`.

**Agent loop location (FACT):** `src/core/task/Task.ts` — `initiateTaskLoop` (:2427) → `recursivelyMakeClineRequests` (:2461) → `attemptApiRequest` → streaming parse → `presentAssistantMessage` (`src/core/assistant-message/presentAssistantMessage.ts`).

## 3. Agent loop

**Turn structure (FACT):** `initiateTaskLoop` kicks off checkpoint service, then `while (!this.abort) { didEndLoop = await recursivelyMakeClineRequests(nextUserContent, includeFileDetails) }`; on `false` it re-prompts with `formatResponse.noToolsUsed()` ("consider whether you've completed the task") — a task **never self-completes**; the loop only ends on abort or `didEndLoop` (Task.ts:2451-2458 comment). `recursivelyMakeClineRequests` is iterative via an explicit `StackItem[]` stack (not recursion): each item carries `userContent`, `includeFileDetails`, `retryAttempt`. Per item: consecutive-mistake-limit ask → provider rate-limit wait (`maybeWaitForProviderRateLimit` + `Task.lastGlobalApiRequestTime` — global static throttle shared with subtasks, :2524) → `say("api_req_started")` → `getEnvironmentDetails` → stream → **`presentAssistantMessage` executes tools *during* streaming** (before the assistant message is saved, Task.ts:1048 comment) under `presentAssistantMessageLocked` to serialize partial-block processing.

**Stopping conditions (FACT):** `attempt_completion` → `say("completion_result")` → `ask("completion_result")` — user approve ends interaction; feedback pushes a tool_result and continues. `mistake_limit_reached` ask when `consecutiveMistakeCount >= consecutiveMistakeLimit` (`DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3`, packages/types/src/provider-settings.ts:29; `ToolRepetitionDetector` also fires the same ask after 3 *identical* tool calls, tools/ToolRepetitionDetector.ts). `allowedMaxRequests`/`allowedMaxCost` auto-approval caps escalate to an `auto_approval_max_req_reached` ask (auto-approval/AutoApprovalHandler.ts). Abort via `this.abort` checks + `AskIgnoredError` for ask/state races.

**Retry/recovery (FACT):** `retryAttempt` on stack items; empty-assistant-response handling (`userMessageWasRemoved` re-adds user content); `retrySaveApiConversationHistory` for persistence races; API errors surface as `say("api_req_failed")` + retry ask. No automatic LLM-retry on malformed tool calls — errors become tool_result text fed back to the model (`formatResponse.toolError`).

**Planning (FACT):** `update_todo_list` tool (markdown checklist, always available) + Architect mode + orchestrator delegation — planning is prompt/mode-level, not a loop phase.

## 4. Tool system

**Inventory (FACT, `packages/types/src/tool.ts` toolNames + `src/shared/tools.ts` TOOL_GROUPS):** ~24 tools: `read_file`, `write_to_file`, `apply_diff`, `edit`, `search_replace`, `edit_file`, `apply_patch`, `search_and_replace`, `search_files`, `list_files`, `execute_command`, `read_command_output`, `codebase_search`, `use_mcp_tool`, `access_mcp_resource`, `ask_followup_question`, `attempt_completion`, `switch_mode`, `new_task`, `update_todo_list`, `run_slash_command`, `skill`, `generate_image`, `custom_tool`. **Tool groups** gate per-mode availability: `read` = read/search/list/codebase_search; `edit` = apply_diff/write_to_file/generate_image (+ opt-in `customTools`: edit, search_replace, edit_file, apply_patch); `command` = execute_command/read_command_output; `mcp`; `modes` = switch_mode/new_task (alwaysAvailable). `ALWAYS_AVAILABLE_TOOLS` = ask_followup_question, attempt_completion, switch_mode, new_task, update_todo_list, run_slash_command, skill. Edit groups accept `{fileRegex}` restrictions (Architect gets `edit` limited to `\.md$`). `TOOL_ALIASES` map model-emitted aliases (`write_file`→`write_to_file`, `search_and_replace`→`edit`) — aliases preserved in history, resolved at execution.

**Edit mechanisms (FACT — multiple coexisting):** `apply_diff` = multi-block `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` with marker-sequencing validation, `\\<` escaping rules, fuzzy match + line-number hints (diff/strategies/multi-search-replace.ts); `write_to_file` whole-file; opt-in `edit`/`search_replace`/`edit_file`/`apply_patch` (Codex patch format, `tools/apply-patch/`). All funnel through `DiffViewProvider` for user-visible diff approval.

**Tool calls (FACT):** "Tool calling is native-only" (prompts/system.ts:65 `effectiveProtocol = "native"`) — provider function-calling; `NativeToolCallParser` normalizes; XML protocol removed.

**Tool-result size (FACT):** `read_file` truncates with `[File truncated: showing N of M total lines]`; `execute_command` output bounded; `executeRipgrep`/`list_files` respect `maxWorkspaceFiles` (default 200) and `.rooignore`/`RooIgnoreController`.

**MCP (FACT):** `services/mcp/McpHub.ts` — stdio/sse/streamable-http via official SDK, zod-validated per-type schemas (McpHub.ts:76-130), `use_mcp_tool`/`access_mcp_resource` tools, per-tool auto-approve toggles (`mcp.ts` in auto-approval), marketplace/registry integration in controller (`controller/mcp/*`).

## 5. Context management

**System prompt (FACT):** `prompts/system.ts` `SYSTEM_PROMPT`/`generatePrompt` assembles: `roleDefinition` (per mode!) → markdown formatting → shared tool-use section → tool-use guidelines → capabilities (cwd, MCP server list when mode has `mcp` group) → **modes section** (`getModesSection` — catalog of all modes+whenToUse so the model can `switch_mode`) → skills section → rules section → system info → objective → custom instructions (`addCustomInstructions`: global + mode `customInstructions` + `.roo/rules/`, `.roo/rules-{mode}/`, language, `rooIgnoreInstructions`). Prompt components overridable per mode via `customModePrompts`.

**Instruction files (FACT):** `.roomodes` (project YAML/JSON custom modes — takes precedence over global `custom_modes.yaml`), `.roo/rules/` + `.roo/rules-{mode}/` + global `~/.roo/` equivalents (CustomModesManager.ts, custom-instructions.ts:211-421), `.rooignore` file-access control, `AGENTS.md`-style support via rules dirs. VS Code setting `newTaskRequireTodos` enforces todos on subtasks.

**Compaction (FACT):** `core/condense/index.ts` — LLM summarization where tool_use/tool_result blocks are first **flattened to text** (`toolUseToText`/`toolResultToText`) so the summary pass needs no tools param; `foldedFileContext.ts` folds prior file reads. `core/context-management/` = sliding-window truncation of old tool results. Trigger is threshold-on-context + manual command.

**Retrieval (FACT — the embeddings counterexample):** `services/code-index/` — semantic code search: 8 embedders (openai, openai-compatible, ollama, gemini, mistral, bedrock, openrouter, vercel-ai-gateway) → **Qdrant vector store** (`vector-store/qdrant-client.ts`), scanner + file watcher keep the index warm; surfaced as `codebase_search` tool in the `read` group. This contradicts the survey paper's "nobody uses embeddings" claim — Roo Code does (opt-in, needs Qdrant + embedder config). Lexical path: `services/ripgrep` (bundled rg) + tree-sitter (`services/tree-sitter`) for file outlines.

## 6. Safety model

**Permission modes (FACT):** modes are *capability profiles*, not approval levels — the `groups` array restricts tool classes per mode (Ask = read+mcp only; Orchestrator `groups: []` = only always-available delegation tools; Architect's edit limited to markdown via fileRegex). `validateToolUse.ts` rejects out-of-group calls with a tool error.

**Approval flow (FACT):** every mutating tool calls `callbacks.askApproval`/`task.ask("tool"|"command"|...)` → `ClineMessage` ask posted to webview → user Approve/Reject (+feedback text routed back as tool_result). `AutoApprovalHandler` (auto-approval/) — per-capability toggles + `allowedCommands`/`deniedCommands` **longest-prefix-match with deny-wins** (commands.ts:153-191) + global `allowedMaxRequests`/`allowedMaxCost` ceilings that escalate to an ask when exceeded. `enableCheckpoints` + `checkpointTimeout` gate snapshotting.

**Sandboxing:** none at OS level (FACT: `execute_command` runs in VS Code terminal via `TerminalRegistry`, shell-integration tracked, `TerminalRegistry.isProcessHot` delays until "cool"). File access bounded by `RooIgnoreController` (.rooignore) and `.roo` protected paths (`core/protect`). Secrets in VS Code SecretStorage (`isSecretStateKey`). `switch_mode`/`new_task` always require ask approval in default config.

## 7. Orchestration

**Subagents / Boomerang (FACT — current design is delegation, not pause/resume):** `new_task` → `ClineProvider.delegateParentAndOpenChild` (:2783): parent flushes pending tool_results to API history → parent task **disposed** (`removeClineFromStack`) → provider `handleModeSwitch` to child's mode → child created as *sole active task* with `startTask:false` → parent history row marked `status:"delegated"`, `delegatedToId`/`awaitingChildId`/`childIds` → child started. Child `attempt_completion` → `delegateToParent` → `reopenParentFromDelegation` rehydrates the parent (from persisted `task-persistence` API history) with the child's result summary injected as a tool_result. **Single-open invariant** — only one live `Task` at a time; depth is via nested `parentTaskId` chains. This replaced the older pause-and-resume stack. Cost: parent context is reconstructed from disk each handoff; race handling is all in the metadata repair paths (ClineProvider.ts:421-445).

**Headless/CI (FACT):** `apps/cli` — drives the extension through the IPC socket or spawns a headless extension host (`extension-host.ts`); `RooCodeAPI` (extension/api.ts) exposes `startNewTask`, `sendMessage`, `cancelTask`, mode/config setters, `TaskEvent` stream. **No headless-in-process mode** — a VS Code(-ish) host is always required (vscode-shim fakes it for CLI/tests). Wire protocols: node-ipc socket; no ACP, no HTTP server at this commit. `roomote` (remote/mobile control): **NOT FOUND** at this commit (searched src/, apps/, packages/ for roomote/remote-control; the May-2026 HEAD predates or postdates that branding — the IPC API + CLI are the nearest equivalents).

## 8. Extensibility

- **Custom modes** (FACT): `modeConfigSchema` (packages/types/src/mode.ts:96) — slug/name/roleDefinition/whenToUse/description/customInstructions/groups — via global `custom_modes.yaml`, project `.roomodes`, or UI; per-mode rules dirs; mode-specific marketplace.
- **Slash commands** (`run_slash_command`, experiment `runSlashCommand`), **custom tools** (`custom_tool`, experiment `customTools`, `packages/core` customToolRegistry), **skills** (`skill` tool + `services/skills/SkillsManager` + SKILL.md), **MCP servers** (per-mode `mcp` group), **image generation** tool (experiment `imageGeneration`).
- **Experiments gate features** (FACT): `packages/types/src/experiment.ts` — `preventFocusDisruption`, `imageGeneration`, `runSlashCommand`, `customTools`.
- **Provider profiles**: multiple saved provider configs + per-mode model pinning.
- No hooks system comparable to Cline/goose plugin hooks at this commit (NOT FOUND — searched src/core for hooks dirs; closest is command listeners + code-index watchers).

## 9. Session & state

**Persistence (FACT):** VS Code `globalState` + per-task dirs under extension storage: `task-persistence/` splits `api_conversation_history.json` (API-facing messages) from `ui_messages.json` (ClineMessage say/ask feed) — the classic Cline two-transcript model. Task history items carry `status: active|delegated|completed`, `parentTaskId`/`childIds`/`awaitingChildId`/`delegatedToId`, token/cost totals (`getApiMetrics`). Resume = rehydrate `Task` from history (`createTaskWithHistoryItem`, parent/root relink at ClineProvider.ts:826-995). Fork = `editMessageAndRegenerate`-style truncation + history copy (checkpoint restore rewinds files + chat).

**Checkpoints (FACT — still shadow-git):** `services/checkpoints/ShadowCheckpointService.ts` + `RepoPerTaskCheckpointService`: a **separate git repo per workspace** (`shadowDir` under extension storage, env-sanitized `simple-git` to block `GIT_DIR`/`GIT_WORK_TREE` leaks, `getExcludePatterns` ignore list), commits checkpoint per completed tool-batch; restore = checkout + file diff view (`checkpointRestore` in controller + `checkpoint-diff`-equivalent via git diff). This is the mechanism Cline itself abandoned for in-repo `refs/cline/checkpoints/*` — a clean architectural fork-point to cite.

## 10. Model layer

**Abstraction (FACT):** `src/api/providers/` — ~37 provider classes over a common `ApiHandler` (`buildApiHandler`): anthropic(+vertex), openai, openai-native(+codex), openai-compatible, bedrock, vertex, gemini, openrouter, requesty, unbound, litellm, deepseek, xai, mistral, moonshot, minimax, zai, qwen-code, sambanova, baseten, fireworks, poe, lm-studio, native-ollama, vscode-lm, fake-ai, router-provider, vercel-ai-gateway + fetchers for remote model lists. BYOK everywhere; OpenRouter/Roo Code Cloud defaults; per-provider `ApiStream` → `attemptApiRequest`. `getApiProtocol`/`isRetiredProvider` pick message transforms (`api/transform/`). Model→tool-set adaptation: `includedTools`/`customTools` opt-ins, `modelInfo` capability flags (e.g. supportsComputerUse, native tool support). No generated catalog — providers are hand-maintained, which is why the list is 1/5 the size of Cline's ~200-spec generated registry.

## 11. Notable mechanisms (incl. divergences from Cline)

**Divergence summary (FACT, all verified at the two commits studied):**

| Axis | Cline @722b640 (2026-09) | Roo Code @b867ec9 (2026-05) |
|---|---|---|
| Runtime shape | Layered SDK monorepo; loop stateless in `@cline/agents` | Monolith extension; `Task.ts` (4619 lines) owns loop |
| Tool protocol | JSON-schema `AgentTool`s | Native function-calling + aliases |
| Tools | ~9 SDK tools + host extras | ~24 tools incl. multi-edit variants |
| Plan/Act | presets + command-guard hook | generalized to N modes w/ tool groups |
| Subagents | `spawn_agent` + agent-teams (mailboxes, outcomes) | `new_task` single-open delegation, dispose+rehydrate |
| Checkpoints | in-repo `refs/cline/checkpoints/*` stash-commits | shadow git repo per workspace (simple-git) |
| Sessions | SQLite `sessions.db` + manifests | globalState + per-task JSON files |
| Semantic search | not in default toolset | code-index embeddings + Qdrant |
| Multi-surface | CLI/hub/desktop/web via WS | VS Code + CLI over node-ipc |
| Providers | ~200 generated specs | ~37 hand-written handlers |

1. **Tool-group permissioning per mode** — `groups: ["read", ["edit",{fileRegex:"\\.md$"}]]` is a genuinely expressive capability model (per-mode, per-regex) that Cline's two-preset system lacks; the schema-level enforcement (`validateToolUse`) makes it a hard bound, not a prompt suggestion.
2. **Single-open delegation** — Boomerang v2 turns subtasking into *task replacement* with metadata repair (`status:"delegated"`, `awaitingChildId`), avoiding any need to hold two live agent loops; the parent is literally garbage-collected and rebuilt from disk on return.
3. **Streaming-time tool execution** — `presentAssistantMessage` runs tools as blocks arrive, interleaved with the stream (with a lock + pending-updates queue), so an edit tool starts before the model finishes talking.
4. **Deny-wins longest-prefix command ACL** (auto-approval/commands.ts) — `allowedCommands`/`deniedCommands` matched by longest prefix per chained subcommand; simple, legible, and safe-by-default.
5. **Embedding-based codebase search** — the only harness of the three shipping vector retrieval (opt-in; needs Qdrant). Counter-evidence to "nobody uses embeddings."

## 12. Evidence log

- `src/core/task/Task.ts` @b867ec9 — loop, stack items, mistake limit, delegation entry — accessed 2026-09-15
- `src/core/assistant-message/presentAssistantMessage.ts`, `src/core/tools/*.ts`, `src/shared/tools.ts` — tool dispatch/inventory/groups/aliases — accessed 2026-09-15
- `packages/types/src/{mode,tool,experiment}.ts`, `src/core/prompts/system.ts` + `sections/`, `src/core/config/CustomModesManager.ts` — modes + prompt assembly — accessed 2026-09-15
- `src/core/webview/ClineProvider.ts` (`delegateParentAndOpenChild` :2783, `reopenParentFromDelegation`), `src/core/tools/{NewTaskTool,AttemptCompletionTool}.ts` — Boomerang mechanics — accessed 2026-09-15
- `src/services/checkpoints/*`, `src/services/mcp/McpHub.ts`, `src/services/code-index/*`, `packages/ipc/src/ipc-server.ts`, `src/extension/api.ts`, `apps/cli/src/agent/*` — checkpoints, MCP, embeddings, IPC/CLI — accessed 2026-09-15
- Conflicts/gaps: (a) **`roomote` NOT FOUND** at this commit — the repo's main HEAD is 2026-05-15 and predates the public roomote launch; the IPC API + CLI are documented instead; (b) the older pause/resume Boomerang was already replaced by delegate/dispose at this commit — claims about "paused parent tasks" describe an earlier design; (c) `packages/core` worktree service and `apps/vscode-nightly` not deeply read; (d) `packages/core` worktree service and `apps/vscode-nightly` not deeply read.
