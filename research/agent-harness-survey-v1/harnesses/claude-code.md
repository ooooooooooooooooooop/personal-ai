# Claude Code

> Anthropic · Proprietary (closed-source npm binary; Agent SDK libraries are source-available) · TypeScript/Node.js (bundled native binary) · First release 2025-02
> **Version studied: documentation as of 2026-09-15 (docs reference versions up to ~v2.1.251); npm internals not audited per scope**
> Repo: https://github.com/anthropics/claude-code (issues only) · SDKs: https://github.com/anthropics/claude-agent-sdk-typescript, https://github.com/anthropics/claude-agent-sdk-python · Docs: https://code.claude.com/docs
> Epistemic basis: DOCS-ONLY (official docs + Agent SDK API surface), cross-referenced with arXiv:2609.00006 source audit; claims marked `VENDOR-CLAIM` or `[paper]` where not directly verifiable

## 1. Positioning & design philosophy

Claude Code bets on **a single programmable agent core surfaced everywhere**: the same agent loop, tools, permission system, and context management power the terminal CLI, IDE extensions, the desktop app, Claude Code on the web, background agents, and the Python/TypeScript Agent SDK (docs: "the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript" — SDK overview). The extensibility model is unusually deep — hooks (~30 lifecycle events, including `BeforeModel`-equivalents like `PreModelSwitch` and tool-batch events), skills, subagents, plugins, MCP, and LSP servers — so customization is the product's scaling strategy rather than model variety. [VENDOR-CLAIM for loop parity; FACT for documented surfaces]

## 2. Architecture overview

- **Distribution**: closed-source. The Agent SDK bundles a native Claude Code binary per platform — "Both the TypeScript and Python SDKs bundle a native Claude Code binary, so most installs need no separate Claude Code install" (SDK agent-loop docs). The CLI is also distributed via npm and native installers. [VENDOR-CLAIM — docs]
- **Internal layout**: not source-available. arXiv:2609.00006's source audit describes a streaming SSE event pipeline (`content_block_start`/`delta`/`stop`, `message_delta` events) feeding a tool-execution loop with concurrent tool batching. [paper claim — treat as unverified-by-us]
- **Surfaces**: terminal CLI, VS Code + JetBrains extensions, desktop app, web (claude.ai), headless `-p` mode, Agent SDK (Py/TS), Managed Agents (hosted REST API — a separate product), Remote Control/workers (implied by `worker_shutting_down` message subtype). [FACT — docs enumerate each]
- **Control plane**: hooks, settings files (`settings.json` at user/project/local/managed tiers), permission rules, MCP config (`.mcp.json`), and env vars form the configuration substrate. [FACT — docs]

## 3. Agent loop

Documented via the Agent SDK's agent-loop page (which states the SDK "runs the same execution loop that powers Claude Code"):

- **Cycle**: prompt → model evaluates → emits text and/or tool calls → tools execute → results feed back → repeat until a response with no tool calls. "Claude continues calling tools and processing results until it produces a response with no tool calls." [VENDOR-CLAIM — SDK docs]
- **Turn definition**: one tool-call round-trip; `max_turns`/`maxTurns` caps *tool-use turns only*; `max_budget_usd`/`maxBudgetUsd` caps by spend. [VENDOR-CLAIM — SDK docs]
- **Streaming model**: messages yielded as `SystemMessage` (subtypes `init`, `compact_boundary`, `informational`, `worker_shutting_down`), `AssistantMessage` (one per content block), `UserMessage` (tool results), `StreamEvent` (raw API deltas when partial messages enabled), `ResultMessage` (final text + usage + cost + session ID). [VENDOR-CLAIM — SDK docs]
- **Parallel tool batching**: the docs' hook lifecycle includes a `PostToolBatch` event — "after a full batch of parallel tool calls resolves, before the next model call" — confirming multi-tool-call batching per model response. arXiv:2609.00006 adds that tools carry explicit concurrency-safety metadata (read-only tools parallelize; edits/shell don't). [VENDOR-CLAIM for batch event; paper claim for safety metadata]
- **Planning**: `EnterPlanMode`/`ExitPlanMode` tools + plan permission mode — planning is a mode transition the model can invoke (`EnterPlanMode`) or the user can set, not a fixed loop stage. [FACT — tools reference]
- **Loop guards**: no documented max-iteration limit beyond `maxTurns` (subagent frontmatter also supports `maxTurns`, with resumable partial output); task list + TodoWrite give the model a self-tracking structure. [VENDOR-CLAIM]
- **Stop conditions**: `Stop`/`StopFailure` hook events fire on normal finish vs. API-error finish; `EndConversation` is a model-callable tool "in rare cases of sustained abusive [use]" that skips Pre/PostToolUse hooks. [FACT — tools + hooks reference]

## 4. Tool system

- **Built-in inventory** (tools reference, ~44 tools): `Agent`, `Artifact`, `AskUserQuestion`, `Bash`, `CronCreate/Delete/List`, `Edit`, `EndConversation`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Glob`, `Grep`, `ListAgents`, `ListMcpResourcesTool`, `LSP`, `Monitor`, `NotebookEdit`, `PowerShell`, `PushNotification`, `Read`, `ReadMcpResourceTool`, `RemoteTrigger`, `ReportFindings`, `ScheduleWakeup`, `SendFeedback`, `SendMessage`, `SendUserFile`, `ShareOnboardingGuide`, `Skill`, `TaskCreate/Get/List/Output/Stop/Update`, `TodoWrite`, `ToolSearch`, `WaitForMcpServers`, `WebFetch`, `WebSearch`, `Workflow`, `Write`. [FACT — tools reference table]
- **Deferred tool loading**: `ToolSearch` — "searches for and loads deferred tools when tool search [is enabled]" — matching the paper's deferred-loading finding: tools are indexed and pulled into context on demand. [FACT for the tool; paper claim for mechanism]
- **Edit mechanism**: `Edit` is documented as "targeted edits" (match-replace semantics per community knowledge; exact matching/fallback internals not doc-specified — NOT FOUND for whether an LLM fixer exists). [FACT for existence; gap noted]
- **Shell duality**: separate `Bash` (unixy shell) and `PowerShell` (native Windows shell) tools, plus `Monitor` for background commands that stream output lines back as events. [FACT]
- **Per-tool permission requirements** (docs table): `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Artifact`, `PowerShell` require approval (in Manual mode); read-only tools and task/schedule/message tools don't. `Bash` auto-runs a built-in set of read-only commands. [FACT — permissions doc]
- **MCP**: first-class client — `.mcp.json` config, `ListMcpResourcesTool`/`ReadMcpResourceTool` tools, `WaitForMcpServers` gating, `Elicitation`/`ElicitationResult` hook events nested inside MCP tool execution. [FACT — tools + hooks reference]
- **Unusual built-ins**: `LSP` (language-server code intelligence — jump-to-def/find-refs as a tool), `Workflow` (dynamic scripted workflows orchestrating subagents), `RemoteTrigger` (scheduled cloud "Routines"), `Monitor`, `ScheduleWakeup` (self-paced `/loop`), `Artifact` (publish to claude.ai). [FACT — tools reference]

## 5. Context management

- **Memory files**: `CLAUDE.md` at four tiers in load order — managed policy (OS system dirs), user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), local (`./CLAUDE.local.md`); parent-directory files load at launch, subdirectory files load on demand when files under them are read; `@path` imports supported; `claudeMdExcludes` setting. Path-scoped rules live in `.claude/rules/` (glob-scoped instruction files). [FACT — memory doc]
- **Auto memory**: Claude writes its own per-repository notes (preferences, corrections), shared across worktrees, loaded every session (first 200 lines or 25KB); subagents can maintain their own auto memory. [VENDOR-CLAIM — memory doc]
- **System prompt**: proprietary; arXiv:2609.00006 describes modular assembly split by a dynamic boundary (static cacheable prefix vs. dynamic tail). `experimental.cacheTtl` subagent frontmatter (`5m`/`1h` prompt-cache lifetime, v2.1.248+) and the "denying an entire tool removes it from context" cache-behavior doc confirm prompt-cache-aware design. [paper claim for structure; FACT for cache controls]
- **Subagent context**: subagents get *only* their own system prompt + basic environment details, "not the Claude Code system prompt"; `omitClaudeMd` skips CLAUDE.md loading; built-in Explore/Plan skip CLAUDE.md and git status by default for speed. [FACT — sub-agents doc]
- **Compaction**: automatic compaction emits a `compact_boundary` system message; `PreCompact`/`PostCompact` hooks bracket it. The paper describes compaction near an estimated threshold with image stripping and post-compact file/skill restoration. [VENDOR-CLAIM for events; paper claim for internals]
- **Retrieval**: Glob/Grep/LSP only — no embedding retrieval, consistent with the paper's eleven-system finding. [FACT — tools reference]

## 6. Safety model

- **Permission modes** (docs table): `default` (labeled **Manual**; `manual` accepted as alias, v2.1.200+), `acceptEdits` (auto-accepts file edits + `mkdir/touch/mv/cp` inside working dirs), `plan` (read-only exploration), `auto` (classifier auto-approves with "background safety checks"), `dontAsk` (auto-denies would-prompt calls), `bypassPermissions` (skips prompts except never-auto-approved actions). Subagent frontmatter accepts the same modes. [FACT — permissions doc]
- **Rule system**: `allow`/`ask`/`deny` rules in `Tool(specifier)` syntax (`Bash(npm run *)`, `Read(~/secrets/**)`, `WebFetch(domain:…)`, `Agent(Explore)`, `Skill(deploy *)`); evaluation order is deny → ask → allow regardless of specificity; denying a bare tool name removes the tool from the model's context entirely. [FACT — permissions doc]
- **Auto mode classifier**: on Pro/Max/Team, sessions start in `auto` mode where "a classifier reviews actions instead of you"; `PermissionDenied` hook fires on classifier denials and can set `retry: true`. [VENDOR-CLAIM — permissions + hooks docs]
- **Sandboxed Bash**: opt-in OS sandbox for the Bash tool — macOS Seatbelt (built-in), Linux/WSL2 Bubblewrap + `socat` network proxy, optional seccomp filter (`@anthropic-ai/sandbox-runtime`); no native Windows. Filesystem write scope (working dir + temp + `--add-dir` dirs) and per-domain network allowlist enforced by the OS; first-hit domains prompt (or go to the classifier in auto mode). Modes: auto-allow vs. regular permissions; `sandbox.enabled`, `sandbox.allowUnsandboxedCommands`, `sandbox.failIfUnavailable`, `excludedCommands`, `allowAllUnixSockets` settings; unsandboxed fallbacks run through the normal permission flow with a distinct prompt title. [FACT — sandboxing doc]
- **Always-on guards**: deny rules respected even in auto-allow sandbox mode; `rm`/`rmdir` on critical paths always hit the regular flow; `bypassPermissions` still refuses a documented set of never-auto-approved actions; managed settings can `disableBypassPermissionsMode`/`disableAutoMode`. [FACT — permissions/sandboxing docs]
- **Worktree isolation**: `EnterWorktree`/`ExitWorktree` tools + `isolation: worktree` subagent frontmatter run work in a temporary git worktree with path-redirect checks; a command resolving back to the main checkout fails (v2.1.203+). [FACT — sub-agents + worktrees docs]

## 7. Orchestration

- **Subagents**: `Agent` tool spawns agents defined as Markdown + YAML frontmatter in `.claude/agents/` (project), `~/.claude/agents/` (user), managed-settings dir (org), plugins, or `--agents` JSON. Frontmatter: `name`, `description`, `tools`/`disallowedTools`, `model` (`inherit` or alias), `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `omitClaudeMd`, `isolation: worktree`, `experimental.cacheTtl`. Built-ins: `Explore` (read-only, model inherits capped at Opus), `Plan` (read-only), `general-purpose` (all tools), plus helpers (`statusline-setup`, `claude-code-guide`). Descriptions >15K tokens trigger a startup warning — subagent prompts load on demand. [FACT — sub-agents doc]
- **Foreground/background filters**: every subagent loses a fixed tool list (e.g., `ExitPlanMode` unless `permissionMode: plan`); *background* subagents (the default where fork mode is on) keep only a whitelist (`Read/Grep/Glob/Bash/PowerShell/Edit/Write/NotebookEdit/WebFetch/WebSearch/TodoWrite/Skill/ToolSearch/EnterWorktree/ExitWorktree/Monitor/TaskStop/SendMessage/Artifact` + all MCP tools). Forks skip both filters. [FACT — sub-agents doc]
- **Beyond single-session**: `agent teams` (Claude-supervised teammate sessions that keep task+cron tools), `cross-session messaging` (`SendMessage`/`ListAgents`), `agent view`/background agents for parallel monitored sessions, `RemoteTrigger` for cloud Routines. [FACT — docs cross-refs]
- **Headless/CI**: `-p` print mode with `--output-format json`/streaming; `Setup` hook event exists specifically for `--init-only`/CI preparation; Agent SDK for programmatic embedding (loop, tools, permissions, hooks, sessions, plugins all programmable). [FACT — hooks + SDK docs]
- **Multi-surface**: same sessions/hook events fire across terminal, IDE, desktop, web ("Claude Code fires the same hook events wherever it runs"). [VENDOR-CLAIM — hooks doc]

## 8. Extensibility

- **Hooks**: ~30 documented events — `SessionStart`, `Setup`, `SessionEnd`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `WorktreeCreate`, `WorktreeRemove`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `PreModelSwitch`, `PostModelSwitch`. Handler types: shell commands (stdin JSON), HTTP endpoints (POST body), MCP tool calls, LLM-prompt hooks, subagent hooks; JSON output can return decisions (block/modify/`retry`). [FACT — hooks reference]
- **Skills**: `SKILL.md` (agentskills.io open standard) in `~/.claude/skills/`, `.claude/skills/`, managed dir, or plugins; Claude Code extends the standard with invocation control (`disable-model-invocation`), subagent execution, `model`/`effort`, `allowed-tools`, and dynamic context injection (`` !`cmd` `` lines execute and inline output before Claude sees the skill). Custom commands merged into skills (`.claude/commands/*.md` ≡ skill). Bundled skills: `/doctor`, `/code-review`, `/debug`, `/loop`, `/run`, `/verify`, `/run-skill-generator`, `/batch`, `/claude-api` — the run/verify pair learns and *records* launch recipes as per-project skills. [FACT — skills doc]
- **Plugins**: directory + optional `.claude-plugin/plugin.json` manifest; root-level `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/` (added to Bash PATH), `settings.json` defaults; namespaced invocation (`/plugin:skill`); distribution via marketplaces, `--plugin-dir`, or auto-load from the skills dir; plugin subagents forfeit `hooks`/`mcpServers`/`permissionMode` fields for security. [FACT — plugins doc]
- **MCP / LSP / monitors**: external tools via MCP; LSP servers give the `LSP` tool per-language code intelligence; `monitors/` run background watchers. [FACT — plugins + tools docs]

## 9. Session & state

- **Persistence**: sessions resume via `--resume`/`--continue`; the SDK `ResultMessage` carries a session ID for resumption; session storage format is proprietary (JSONL transcripts under `~/.claude/projects/` per community knowledge — NOT VERIFIED in official docs). [VENDOR-CLAIM for resume; gap on format]
- **Fork**: subagent/conversation "fork mode" runs spawned agents against a fork of the current conversation; SDK sessions support fork. [FACT — sub-agents doc]
- **Checkpoints**: file-state tracking exists at least to the extent that "approvals… last until session end" and worktrees isolate writes; a user-facing checkpoint/rewind feature is not clearly documented — NOT FOUND (searched: tools reference, hooks reference). [gap]
- **Scheduled state**: `CronCreate` tasks are session-scoped and "restored on `--resume` or `--continue` if unexpired." [FACT — tools reference]
- **Cross-session**: auto memory (§5) is the persistence across sessions; `CLAUDE.md`/rules are the shared layer; cross-session messaging links live sessions. [FACT]

## 10. Model layer

- **Providers**: Anthropic API (direct), Claude subscription (Pro/Max/Team/Enterprise login), Amazon Bedrock, Google Cloud Vertex AI / Agent Platform, Microsoft Foundry, "Claude Platform on AWS" — third-party integrations doc enumerates the enterprise providers. [FACT — sub-agents + third-party-integrations docs]
- **Model selection**: per-session model choice; `CLAUDE_CODE_SUBAGENT_MODEL` env + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` override subagent models; org `availableModels` allowlist can block/substitute models; per-subagent `model` frontmatter and `effort` levels (shown in `/tasks`, v2.1.242+). [FACT — sub-agents doc]
- **Prompt caching**: explicit TTL control (`5m`/`1h`) via subagent `experimental.cacheTtl` and cache-lifetime precedence docs — the harness is prompt-cache-aware by design. [FACT — sub-agents + prompt-caching docs]
- **BYOK**: API-key auth supported in Agent SDK; docs note Anthropic does not allow third-party products to offer claude.ai login/rate limits — SDK apps use API keys. [FACT — SDK overview]
- **Routing/fallback**: no documented automatic model fallback; model is explicit per session/subagent. NOT FOUND for internal retry/failover specifics. [gap]

## 11. Notable mechanisms

1. **Hook surface breadth** — ~30 lifecycle events including `PostToolBatch` (observe a whole parallel batch before the next model call), `PreModelSwitch`/`PostModelSwitch`, `PermissionDenied` with `retry`, and MCP-nested `Elicitation`; handlers can be commands, HTTP endpoints, MCP tools, LLM prompts, or subagents. This is the deepest documented interception surface of the three harnesses. [FACT — hooks reference]
2. **Filter-layered subagent inheritance** — subagents don't just get "fewer tools": a fixed removal list applies to all, a second whitelist applies to background agents, and forks bypass both — the same definition resolves to different tool pools by execution mode, with `/tasks` surfacing the effective model+effort. [FACT — sub-agents doc]
3. **Skills that teach the harness** — `/run-skill-generator` and `/verify` *record what worked* as committed per-project skills (`.claude/skills/run-<name>/`), turning successful sessions into reusable procedural memory; dynamic context injection (`` !`cmd` ``) grounds skills in live state before the model reads them. [FACT — skills doc]
4. **Domain-granular network policy** — sandboxed Bash enforces a per-domain egress allowlist enforced by the OS (socat proxy), with first-hit prompting/classifier review — network policy as a distinct axis from filesystem scope. [FACT — sandboxing doc]
5. **Deferred tools via ToolSearch** — tool definitions themselves are context-budgeted: the model searches and loads tool schemas on demand rather than paying for all upfront, matching the paper's deferred-loading finding. [FACT for tool existence; paper claim for the mechanism]

## 12. Evidence log

- https://code.claude.com/docs/en/tools-reference — full built-in tool inventory, per-tool permission requirements, rule syntax — accessed 2026-09-15
- https://code.claude.com/docs/en/permissions — permission modes table, allow/ask/deny order, tool-removal semantics, `.claude/settings.local.json` persistence, auto-mode classifier — accessed 2026-09-15
- https://code.claude.com/docs/en/sandboxing — Seatbelt/Bubblewrap/socat/seccomp sandbox design, modes, network domains, settings keys, platform limits — accessed 2026-09-15
- https://code.claude.com/docs/en/hooks — complete hook event list, handler types, JSON I/O, lifecycle diagram — accessed 2026-09-15
- https://code.claude.com/docs/en/sub-agents — built-in subagents, frontmatter schema, tool filters, worktree isolation, model selection order, background/fork behavior — accessed 2026-09-15
- https://code.claude.com/docs/en/skills — SKILL.md standard, bundled skills, dynamic context injection, run/verify recipe recording — accessed 2026-09-15
- https://code.claude.com/docs/en/plugins — plugin manifest, directory structure, namespacing, plugin-subagent restrictions — accessed 2026-09-15
- https://code.claude.com/docs/en/memory — CLAUDE.md tiers, `.claude/rules/`, auto memory, imports — accessed 2026-09-15
- https://code.claude.com/docs/en/agent-sdk/overview + /agent-loop — SDK/CLI loop parity claim, turn/message model, max_turns/budget caps, bundled binary — accessed 2026-09-15
- https://arxiv.org/abs/2609.00006 (*Harness Engineering*, §Claude Code) — SSE streaming internals, concurrent tool batching with concurrency-safety metadata, deferred tool loading, modular system prompt with cache boundary, three-layer permissions, recursive composition, coordinator/worker mode, compaction internals — accessed 2026-09-15
- **Conflicts / gaps / unverified**:
  - All loop internals (SSE pipeline, batching metadata, prompt assembly, compaction internals) come from the paper's source audit or docs, not our own read of the binary — flagged as paper claim / VENDOR-CLAIM throughout.
  - Session transcript file format/location: community-known (`~/.claude/projects/*.jsonl`) but not confirmed in official docs fetched — marked unverified.
  - Whether `Edit` has an LLM fallback matcher (cf. Gemini's documented fixer): NOT FOUND in docs.
  - Checkpoint/rewind feature for file edits: not clearly documented — NOT FOUND.
  - Automatic model failover/routing: NOT FOUND.
