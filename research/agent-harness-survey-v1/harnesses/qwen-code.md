# Qwen Code

> Alibaba (QwenLM) · Apache-2.0 · TypeScript (Node.js ≥22, npm workspaces) · First release: NOT VERIFIED from source (package version at commit: `0.23.4`) · **Version studied: commit `7157cdea7dfac69b9f3c883cae4f57c29ad3501c` (`7157cde`), date accessed 2026-09-15**
> Repo: https://github.com/QwenLM/qwen-code · Docs: https://qwenlm.github.io/qwen-code-docs/en/users/overview
> Epistemic basis: SOURCE-READ

## 1. Positioning & design philosophy

Qwen Code's bet is **fork-and-diverge**: take Google's open-source Gemini CLI codebase (Apache-2.0, Google copyright headers still intact throughout `packages/core`) and re-point it at the Alibaba/Qwen model ecosystem and Chinese-market provider landscape while keeping upstream's proven architecture (FACT, src: Google license headers e.g. packages/core/src/config/approval-mode.ts:1-5, package name `@qwen-code/qwen-code` in package.json @7157cde). Where it diverges, it diverges hard: an LLM-classifier permission layer, a model-executes-JavaScript "code mode", a `serve` daemon with real OS sandboxing (Seatbelt/Docker), channels (Telegram/DingTalk/WeCom-class chat surfaces per README), git-installed extensions with **converters that ingest Claude Code plugins and Gemini extensions**, and ~15 provider backends (FACT, src: packages/core/src/permissions/, packages/core/src/code-mode/, packages/cli/src/commands/serve/, packages/core/src/extension/ @7157cde). The implicit philosophy: inherit the harness, localize the model plane, and out-feature the upstream rather than redesign the loop.

## 2. Architecture overview

- **Layout**: npm-workspace monorepo; `packages/core` = headless engine (agent loop, tools, permissions, prompts, providers, MCP, hooks, subagents, services), `packages/cli` = terminal UI + commands (`serve`, `extensions`, `mcp`, `sessions`, `review`, `board`, `channel`, `auth` subcommand families), plus test-utils/mocks packages — the upstream Gemini CLI package split retained (FACT, src: packages/core/, packages/cli/src/commands/ @7157cde).
- **Agent loop**: `packages/core/src/core/client.ts` (`GeminiClient`-lineage orchestrator) + `packages/core/src/core/turn.ts` (per-turn stream adapter over `LlmChat.sendMessageStream`) (FACT, src: packages/core/src/core/client.ts, turn.ts @7157cde).
- **Interaction modes**: three explicitly distinct prompt/runtime modes — `interactive`, `headless` (non-interactive, forbidden from asking questions), `acp` (may ask via host) — selected in prompt construction (FACT, src: packages/core/src/core/prompts.ts @7157cde).
- **Server**: `packages/cli/src/commands/serve/` implements a multi-workspace daemon with session management, sandbox profiles (macOS Seatbelt, Docker), proxy/network config, custom sandbox images, mount parsing, UID/GID handling (FACT, src: packages/cli/src/commands/serve/ @7157cde).
- **Notable subsystems**: `code-mode/` (model writes JS that calls tools), `channels/` (chat-surface integrations), `extension/` (plugin store + converters), `subagents/`, `hooks/`, `goals/`, `memory/`, `skills/`, `services/` (chat recording, compression, cron, branch points, microcompaction, vision bridge), `lsp/`, `ide/` (FACT, src: packages/core/src/ directory listing @7157cde).

## 3. Agent loop

- **Turn structure**: `Turn.run()` calls `LlmChat.sendMessageStream`, translates the provider stream into typed events — content, thought, citations, `tool_call_request`, `tool_call_response`, `tool_call_confirmation`, `user_cancelled`, `error`, `chat_compressed`, `max_session_turns`, `token_limit_exceeded`, `finished`, `loop_detected`, `retry`, hook system messages, goal state, model fallback — consumed by CLI/TUI or ACP (FACT, src: packages/core/src/core/turn.ts @7157cde).
- **Max-turn guards**: `const MAX_TURNS = 100` hard cap in client.ts:188; a separate configurable session-level `max_session_turns` event; turns are clamped `Math.min(turns, MAX_TURNS)` with an explicit "Ensure turns never exceeds MAX_TURNS to prevent infinite loops" comment; exhaustion ends the interaction with reason `max_turns` (FACT, src: packages/core/src/core/client.ts:188, :2877, :3712-3726 @7157cde).
- **Loop detection**: a `loop_detected` event exists; the client watches for repetitive tool-call patterns and terminates the turn (FACT, src: packages/core/src/core/client.ts `loop_detected` emission @7157cde — detection heuristics inspected at symbol level).
- **Steering/queueing**: the client supports continuation, steering (user message injection mid-turn), retry events, model fallback mid-session, and goal tracking (FACT, src: packages/core/src/core/client.ts, turn.ts @7157cde).
- **Retry/recovery**: stream-level retry events propagate to the UI; `forkedAgent.ts` and `background-agent-resume.ts` handle resuming background/forked agent runs; `createApprovalModeOverride(..., ApprovalMode.YOLO)` is applied to forked/background agents so they can't block on prompts (FACT, src: packages/core/src/agents/forkedAgent.ts:634, background-agent-resume.ts @7157cde).
- **Planning**: `plan` approval mode + plan tools (`tool-names.ts` includes plan/plan-mode tools); goals subsystem (`goals/`) gives the loop a persistent objective object the scheduler can resume toward `max_session_turns` boundaries (FACT, src: packages/core/src/config/approval-mode.ts:8, packages/core/src/goals/, client.ts:3712-3723 goal comment @7157cde).

## 4. Tool system

- **Inventory** (`packages/core/src/tools/tool-names.ts`): `exec`, `edit`, `write_file`, `read_file`, `grep_search`, `glob`, `run_shell_command`, `agent` (subagent spawn), `skill`, plan tools, web search/fetch, LSP tools, task/cron/team tools, MCP resource access, workflow tools, artifact tools, goal tools, `ask_user_question` (interactive/ACP only) — substantially larger surface than upstream Gemini CLI's core set (FACT, src: packages/core/src/tools/tool-names.ts @7157cde).
- **Edit mechanism**: exact `old_string`/`new_string` replacement with occurrence counting — failure modes reported distinctly: zero occurrences, expected-occurrence mismatch when multiple matches exist without `replace_all`, identical strings, missing file; the resulting content is additionally **secret-scanned** before write (FACT, src: packages/core/src/tools/edit.ts @7157cde).
- **Tool-result size handling**: truncation/output-slimming services exist (`services/compactionInputSlimming.ts`, `microcompaction/`); tool outputs feed the compression pipeline (FACT for service presence; thresholds not line-verified, searched: packages/core/src/services/, tools/ @7157cde).
- **MCP client**: `packages/core/src/mcp/` + `packages/cli/src/commands/mcp/`; MCP tools are deliberately **excluded from the AUTO-mode safe-tool allowlist** because third-party tools can't be statically trusted (FACT, src: packages/core/src/permissions/autoMode.ts @7157cde).
- **Code mode**: `packages/core/src/code-mode/` — the model emits a JavaScript program executed in a sandboxed runtime that calls `tools.<name>(args)` (tool-calls-as-code, the "code execution with MCP" pattern); limits ~128KB source, 30s timeout (FACT, src: packages/core/src/code-mode/ constants + protocol files @7157cde).

## 5. Context management

- **System prompt**: `packages/core/src/core/prompts.ts` composes the system prompt per interaction mode — interactive vs headless vs ACP differ (headless explicitly forbids questions/`ask_user_question`; ACP permits them through the host). Blocks cover: dedicated-tool guidance (prefer `read_file`/`edit`/`grep_search` over shell equivalents), batching/parallelism guidance, absolute-path rules, background-process guidance, interactive-command warnings, subagent delegation, codebase search, and "respect tool decisions" (don't retry denied actions) (FACT, src: packages/core/src/core/prompts.ts @7157cde).
- **Instruction/memory files**: Qwen-branded equivalents of upstream's context files — `QWEN_DIR` (`.qwen`), Qwen-specific ignore parsing, Qwen memory/imports, plus `.agents` skill directories (FACT, src: packages/core/src/core/prompts.ts QWEN_DIR refs, packages/core/src/config/storage.ts, packages/core/src/skills/ @7157cde).
- **Compaction**: `services/chatCompressionService.ts` + `services/microcompaction/` + `compactionInputSlimming.ts`; compression emits a `chat_compressed` stream event and stores a compression **checkpoint** record in the JSONL transcript so history can be rebuilt (FACT, src: packages/core/src/services/chatCompressionService.ts, chatRecordingService.ts:326-500 @7157cde).
- **Retrieval**: grep/glob/LSP/codebase-search tools; no embedding index in the coding loop — consistent with the no-RAG norm (FACT for tool inventory; NOT FOUND for embeddings, searched: packages/core/src/tools/, services/ @7157cde).

## 6. Safety model

- **Approval modes**: `ApprovalMode` enum = `PLAN`, `DEFAULT`, `AUTO_EDIT`, `AUTO`, `YOLO` (FACT, src: packages/core/src/config/approval-mode.ts:7-13 @7157cde).
- **Rule engine**: permission rules with deny/ask/allow decisions at persistent and session scopes (`permissions/permission-manager`-level files under `permissions/`) (FACT, src: packages/core/src/permissions/ @7157cde).
- **AUTO mode — three layers** (`permissions/autoMode.ts`): (1) accept-edits fast path for workspace file edits; (2) a **safe-tool allowlist** of read-only/low-risk tools that bypasses the classifier — MCP tools intentionally excluded; (3) an **LLM classifier** for everything else (FACT, src: packages/core/src/permissions/autoMode.ts @7157cde).
- **LLM classifier** (`permissions/classifier.ts`): two-stage — a fast stage (`max_tokens=32`, thinking disabled, 10s timeout) and a review stage (`max_tokens=4096`, 30s timeout); API errors, timeouts, schema failures, and context overflow are **fail-closed** (treated as blocked/unavailable) (FACT, src: packages/core/src/permissions/classifier.ts @7157cde).
- **OS sandbox**: real sandboxing exists in the `serve` path — macOS Seatbelt profile files, Docker/container execution settings, proxy/network naming, custom sandbox images, mount spec parsing, UID/GID mapping (FACT, src: packages/cli/src/commands/serve/ sandbox profile and container files @7157cde).
- **Secret hygiene**: the edit/write path scans resulting content for secrets before persisting (FACT, src: packages/core/src/tools/edit.ts @7157cde).
- **Forked/background agents**: forced `ApprovalMode.YOLO` via `createApprovalModeOverride` — headless execution can't block on interactive prompts (FACT, src: packages/core/src/agents/forkedAgent.ts:634 @7157cde).

## 7. Orchestration

- **Subagents**: `packages/core/src/subagents/builtin-agents.ts` — default `general-purpose` agent; `review-agent` used by the review skill/command, deliberately restricted to ReadFile/Grep/Glob/Shell/WriteFile/Edit; resolution precedence session > project > user > extension > builtin (FACT, src: packages/core/src/subagents/builtin-agents.ts @7157cde).
- **Fork/background**: `forkedAgent.ts` + `background-agent-resume.ts` — agents can fork with cache-aware context (`forkedAgent.cache.test.ts`) and resume in background; approval mode overridden to YOLO (FACT, src: packages/core/src/agents/forkedAgent.ts, background-agent-resume.ts @7157cde).
- **Headless**: `--prompt`/non-interactive path under `packages/cli/src/nonInteractive/` with its own prompt variant; `agent-headless`/`agent-transcript` modules support API-style runs (FACT, src: packages/cli/src/nonInteractive/, packages/core/src/agents/agent-headless*.ts, agent-transcript.ts @7157cde).
- **Serve daemon**: `qwen serve` → multi-workspace/session server with sandboxed execution and client attachment — the closest analog to a self-hosted agent backend among the three harnesses in this batch (FACT, src: packages/cli/src/commands/serve/ @7157cde).
- **ACP/IDE/chat surfaces**: ACP interaction mode in prompts; `ide/` package; `channels/` directory + `channel` CLI commands wire chat platforms (Telegram/DingTalk/WeCom-class surfaces shown in README imagery — VENDOR-CLAIM for the platform list, FACT for the channel subsystem); `board` command exists (FACT, src: packages/core/src/core/prompts.ts ACP mode, packages/core/src/channels/, packages/cli/src/commands/ @7157cde).
- **Teams/workflows/goals**: `teams`, `workflows`, `goals` subsystems let multiple agent runs coordinate — workflow state uses `journal.jsonl` snapshots under project `.qwen` storage (FACT, src: packages/core/src/config/storage.ts, packages/core/src/agents/, cli commands @7157cde).

## 8. Extensibility

- **Extensions** (`packages/core/src/extension/`): git-based install (`extension-git-client.ts`, `extension-git-credentials.ts`), a store (`extension-store.ts`), settings/preferences, archive-safety checks, and — uniquely — **format converters**: `claude-converter.ts` ingests Claude Code plugins, `gemini-converter.ts` ingests Gemini CLI extensions, `extension-converter.ts` handles the generic path; `agent-plugins-v1` defines the plugin spec; CLI exposes `extensions install|list|enable|disable|uninstall|link|new|sources|settings` (FACT, src: packages/core/src/extension/, packages/cli/src/commands/extensions/ @7157cde).
- **Skills**: `packages/core/src/skills/` + `skill` tool; skill providers resolve from `.agents` and Qwen dirs at session/project/user/extension/builtin layers (FACT, src: packages/core/src/skills/, subagents/builtin-agents.ts precedence @7157cde).
- **Hooks**: `packages/core/src/hooks/` — lifecycle hook system emitting `hook system message` events into the turn stream (FACT, src: packages/core/src/hooks/, turn.ts event surface @7157cde; event list matches upstream shape).
- **MCP**: `qwen mcp` command family + core MCP client; per-server config in settings; OAuth token storage `mcp-oauth-tokens.json` (FACT, src: packages/cli/src/commands/mcp/, packages/core/src/config/storage.ts @7157cde).
- **Custom providers**: `models/` + `providers/` allow user-defined OpenAI-compatible providers with presets for Alibaba (coding plan/standard/token plan), Moonshot, DeepSeek, ModelScope, MiniMax, OpenRouter, Z.ai, plus a generic custom provider (FACT, src: packages/core/src/providers/, models/ @7157cde).

## 9. Session & state

- **Transcript persistence**: `ChatRecordingService` writes per-session JSONL transcripts `<sessionId>.jsonl` under the project's chat directory inside `.qwen`; record types include messages, **branch checkpoints** (session forks) and **compression checkpoints**; `parentSessionId`/`parentUuid` chain reconstruction lets a forked session inherit history (FACT, src: packages/core/src/services/chatRecordingService.ts:292-500, :1141 @7157cde).
- **Storage layout** (`config/storage.ts`): global `~/.qwen` holds `settings.json`, `oauth_creds.json`, `mcp-oauth-tokens.json`, workflows, extensions, chats, checkpoints, memory; project `.qwen` holds workflow snapshots, `journal.jsonl`, chat runtime JSON; extension dir under global storage (FACT, src: packages/core/src/config/storage.ts @7157cde).
- **Resume/fork**: `sessions` CLI commands list/resume; branch-point service (`services/branch-points.ts`) implements session forking via branch checkpoint records; background-agent resume path persists run state (FACT, src: packages/cli/src/commands/sessions/, services/branch-points.ts, chatRecordingService.ts branch_checkpoint @7157cde).
- **Cron/tasks**: `cronScheduler.ts` + `cronTasksFile.ts` + `cronTasksLock.ts` — scheduled tasks persisted to a file with lock management (FACT, src: packages/core/src/services/cronScheduler.ts et al. @7157cde).
- **Memory**: `memory/` subsystem + memory files under global `.qwen` — cross-session memory exists (FACT, src: packages/core/src/memory/, config/storage.ts @7157cde).

## 10. Model layer

- **Abstraction**: `ContentGenerator` interface (upstream shape retained) with OpenAI-compatible and Anthropic generators; `openaiContentGenerator/` adapts the large set of OpenAI-compatible providers (FACT, src: packages/core/src/openaiContentGenerator/, models/ @7157cde).
- **Auth types**: `AuthType` includes OpenAI API key, OpenAI Responses, **Qwen OAuth**, Gemini, Vertex AI, Anthropic — i.e. upstream auth paths retained *plus* Qwen's device-flow OAuth (FACT, src: packages/core auth-type definitions under core/ or models/ @7157cde — file inspected at symbol level).
- **Provider breadth**: provider implementations for DashScope, DeepSeek, Fireworks, Grok, Mistral, ModelScope, OpenRouter, Z.ai, Cerebras, MiniMax and others; preset list spans Alibaba coding plan / standard / token plan, Moonshot, and custom OpenAI-compatible endpoints — a far wider first-party provider set than upstream (FACT, src: packages/core/src/providers/ directory listing @7157cde).
- **Fallback/routing**: model-fallback stream events exist (mid-session fallback surfaces as an event); goals/arena managers can spawn runs under pinned approval modes; no separate LLM-router service found (FACT for fallback event; router NOT FOUND, searched: packages/core/src/core/, models/ @7157cde).
- **BYOK**: yes — arbitrary OpenAI-compatible base URL + key via custom provider config (FACT, src: packages/core/src/providers/ custom provider preset @7157cde).

## 11. Notable mechanisms

1. **LLM-judged permission AUTO mode with a hard floor**: static allowlist handles routine reads, a two-stage `max_tokens=32`→`4096` classifier judges the rest, MCP tools never get the fast path, and every classifier failure mode fails closed — model judgment bounded by a fixed deny floor, similar in spirit to Devin CLI's Smart mode but implemented as a classifier chain (FACT, src: packages/core/src/permissions/autoMode.ts, classifier.ts @7157cde).
2. **Code mode**: the model writes a ≤128KB JavaScript program run in a sandboxed runtime that invokes `tools.<name>(args)` — collapses multi-step tool orchestration into one model turn; a genuinely different tool-call substrate than the standard JSON-function-calling loop (FACT, src: packages/core/src/code-mode/ @7157cde).
3. **Extension converters**: `claude-converter.ts`/`gemini-converter.ts` translate Claude Code plugins and Gemini CLI extensions into Qwen's `agent-plugins-v1` format — a deliberate compatibility land-grab on the incumbent ecosystems (FACT, src: packages/core/src/extension/ @7157cde).
4. **Serve + real sandbox**: the daemon path ships Seatbelt profiles and Docker containerization with proxy/UID/GID/mount plumbing — the only harness of these three with OS-level isolation in-tree (FACT, src: packages/cli/src/commands/serve/ @7157cde).
5. **Upstream divergence inventory (Gemini CLI)** — *retained*: package split (`core`/`cli`), `GeminiClient`/`Turn` architecture, `ContentGenerator` abstraction, tool scheduler, hooks, subagents, MCP, sessions, noninteractive + ACP surfaces, Google copyright headers and deprecated `Gemini*` aliases (FACT — headers e.g. approval-mode.ts:1-5; alias files under packages/core). *Changed*: branding/storage (`.qwen` vs `.gemini`, `QWEN_DIR`, Qwen ignore/memory), prompt text incl. interaction-mode rules and tool-name-specific guidance, tool inventory/names (`tool-names.ts` adds agent/skill/plan/cron/team/workflow/artifact/goal tools beyond upstream's core), provider layer (Qwen OAuth + ~15 providers vs upstream's Gemini/Vertex), the AUTO classifier (upstream has no LLM permission judge), serve+sandbox, extensions with converters, channels, code mode (FACT for the Qwen-side evidence; the upstream comparison is structural — no upstream Gemini commit was cloned for a file-level diff; searched: packages/core, packages/cli @7157cde).

## 12. Evidence log

- `packages/core/src/core/client.ts` @7157cde — `MAX_TURNS=100` (:188), turn clamping (:3712-3726), event surface, steering/goals/fallback — accessed 2026-09-15
- `packages/core/src/core/turn.ts` @7157cde — `LlmChat.sendMessageStream` adapter, typed event stream — accessed 2026-09-15
- `packages/core/src/core/prompts.ts` @7157cde — interactive/headless/ACP prompt variants, tool-use rules — accessed 2026-09-15
- `packages/core/src/tools/tool-names.ts`, `tools/edit.ts` @7157cde — tool inventory, exact-match edit + occurrence checks + secret scan — accessed 2026-09-15
- `packages/core/src/config/approval-mode.ts` @7157cde — `PLAN/DEFAULT/AUTO_EDIT/AUTO/YOLO` enum (:7-13) — accessed 2026-09-15
- `packages/core/src/permissions/autoMode.ts`, `classifier.ts` @7157cde — 3-layer AUTO mode, MCP exclusion, two-stage fail-closed classifier — accessed 2026-09-15
- `packages/core/src/subagents/builtin-agents.ts` @7157cde — `general-purpose`/`review-agent`, tool restriction, precedence chain — accessed 2026-09-15
- `packages/core/src/agents/forkedAgent.ts`, `background-agent-resume.ts` @7157cde — fork/background runs, YOLO override (:634) — accessed 2026-09-15
- `packages/core/src/code-mode/` @7157cde — JS-program tool execution, 128KB/30s limits — accessed 2026-09-15
- `packages/core/src/services/chatRecordingService.ts`, `chatCompressionService.ts`, `branch-points.ts`, `cronScheduler.ts` @7157cde — JSONL transcripts, branch/compression checkpoints, cron — accessed 2026-09-15
- `packages/core/src/config/storage.ts` @7157cde — `.qwen` layout, settings/oauth/chats/checkpoints/memory — accessed 2026-09-15
- `packages/core/src/extension/` @7157cde — git-installed extensions, claude/gemini converters, `agent-plugins-v1` — accessed 2026-09-15
- `packages/cli/src/commands/serve/` @7157cde — daemon, Seatbelt/Docker sandbox, proxy/mount/UID plumbing — accessed 2026-09-15
- `packages/core/src/providers/`, `models/`, `openaiContentGenerator/` @7157cde — provider inventory, auth types — accessed 2026-09-15
- `README.md`, `package.json` @7157cde — branding, version 0.23.4, channel/platform claims — accessed 2026-09-15
- Conflicts/gaps: upstream Gemini CLI was **not** cloned — the divergence list is structural (Qwen-side evidence + retained headers/aliases), not a file-level diff; loop-detection heuristic internals not line-verified; tool-output truncation thresholds not line-verified; channel platform list is README-sourced (VENDOR-CLAIM); first-release date not verified (shallow clone).
