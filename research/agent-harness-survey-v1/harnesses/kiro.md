# Kiro (AWS Kiro IDE + kiro-cli + Kiro Web/Mobile + Kiro Crew)

> Steward: AWS (Amazon) · License: Proprietary — AWS Intellectual Property License (predecessor Q Developer CLI was Apache-2.0); **Kiro Crew is open source** · Impl. language: harness closed source; historically IDE agent in TypeScript, CLI in Rust, Web agent in Python before consolidation (FACT per Kiro blog); Crew is Python · First release: Kiro IDE preview July 2025; kiro-cli Nov 2025 (as Q CLI successor); Kiro Web GA 2026-09-01 · **Version studied: IDE 1.1 (changelog 2026-09-10, Code OSS 1.131 base), kiro-cli 2.21.x/V3 harness line (changelog 2026-09-11), Crew 0.6.0 (2026-09-05); docs fetched 2026-09-15**
> Repo: https://github.com/kirodotdev/Kiro (issues/feedback only — agent source closed; Crew sources published) · Docs: https://kiro.dev/docs
> **Epistemic basis: DOCS-ONLY**

Tag legend: **FACT** = documented behavior · **VENDOR-CLAIM** = marketing statement · **INFERENCE** = derived structure.

## 1. Positioning & design philosophy

Kiro's bet: **one agent harness behind every surface, spec-driven development as the canonical workflow**. Instead of a chat loop, Kiro's headline mechanism is *specs* — the agent decomposes intent into `requirements.md` (EARS-notation acceptance criteria), `design.md`, and an executable `tasks.md` dependency graph run in parallel waves (FACT, src: https://kiro.dev/docs/specs/). Architecturally, Kiro merged three formerly separate agents (IDE in TypeScript, CLI in Rust, Web in Python) into a single **standalone harness process** that all surfaces drive over the open **Agent Client Protocol (ACP)** — "one brain, many faces" (FACT, src: https://kiro.dev/blog/one-agent/, https://kiro.dev/docs/how-kiro-works/, https://kiro.dev/blog/which-kiro-app-should-i-pick/). The product family now spans IDE, CLI, Web (GA 2026-09-01), Mobile preview, cloud sessions, and **Kiro Crew** — an open-source, self-hosted persistent personal-agent gateway in the OpenClaw/Clawdbot genre (FACT, src: https://kiro.dev/changelog/, https://kiro.dev/docs/crew/).

## 2. Architecture overview

- **Unified agent harness** — a lightweight standalone server process that "runs alongside your codebase, starts quickly, and owns everything on the agent side" (orchestrating conversation, executing tools, managing context, evaluating permissions, talking to LLM providers); clients own interaction/presentation only. Being a process — not a library — is the deliberate boundary that prevents per-client divergence; the same harness runs on a laptop or inside a cloud sandbox (FACT, src: https://kiro.dev/docs/how-kiro-works/, https://kiro.dev/blog/one-agent/).
- **Surfaces** — Kiro IDE (Code OSS 1.131 base as of 1.1), `kiro-cli`, Kiro Web, Mobile (preview), all ACP clients of the same harness (FACT, src: https://kiro.dev/changelog/, https://kiro.dev/docs/cli/acp/).
- **Harness generations** — kiro-cli v3 runs the unified harness; a `--v2` flag / `chat.agentEngine` setting can run a single session on the legacy V2 harness (Q-CLI lineage) (FACT, src: https://kiro.dev/changelog/ — "V2 Harness Flag", 2.21.4).
- **Config surface** — `.kiro/` directory: `specs/`, `steering/`, `hooks/*.json`, `agents/*.{json,md}`, `settings/mcp.json`, `.kiroignore`; global `~/.kiro/` mirrors these (FACT, src: docs pages for specs/steering/hooks/custom-agents/mcp/kiroignore).
- **Cloud runtime** — cloud sessions and Kiro Web tasks run the harness in a managed per-task sandbox that clones repos, configures env, controls internet domains, and ships a headless Chrome + Playwright MCP + Chrome DevTools MCP for verification (FACT, src: https://kiro.dev/docs/cloud-sessions/, https://kiro.dev/docs/web/sandbox/).
- **Crew** — separate open-source "Gateway" (Python wheel, default `http://localhost:5476`) providing persistent sessions, semantic memory (in-process embeddings with keyword fallback), cron jobs, heartbeats/monitor loops, task runner with checkpoints, subagents, lessons/self-learning, chat channels (Slack/Discord/Telegram/Teams/Webex/WeCom/WeChat), remote crews, and a **pluggable agent backend** (KAS / Claude Code / Codex selectable) (FACT, src: https://kiro.dev/docs/crew/, https://kiro.dev/changelog/ 0.6.0).

## 3. Agent loop

Documented loop order (FACT, src: https://kiro.dev/docs/how-kiro-works/):

1. Assemble prompt + conversation history + steering/AGENTS.md + attachments + agent config.
2. Send to selected model (or Auto routing).
3. Evaluate permission rules + `.kiroignore` for each proposed action.
4. Run pre-tool hooks (`PreToolUse`) — can block or gate on confirmation.
5. Execute built-in / MCP / Power / subagent tool calls.
6. Feed results back to the model; iterate until the task completes or input is needed.
7. Compact older context automatically when the window fills.
8. Run `AgentStop`/`SessionEnd`-class hooks at completion.

- **Modes** — interactive chat (default supervised flow), **plan mode** (research/plan before edits; `Shift+Tab` in CLI), **spec mode** (requirements→design→tasks pipeline), **Autopilot vs Supervised** agent-autonomy setting (`kiroAgent.agentAutonomy`: Autopilot auto-runs allowed actions, Supervised asks) (FACT, src: https://kiro.dev/docs/cli/v3/, https://kiro.dev/docs/permissions/, IDE chat docs).
- **Web autonomous mode** — clarify → plan → specialized sub-agents execute → opens PR(s); mid-run questions move the task to a "Needs attention" state; model selection is automatic in this mode (FACT, src: https://kiro.dev/docs/web/autonomous-mode/).
- **Spec execution** — `tasks.md` tasks form a dependency graph executed in parallel waves; each task maps back to requirements (FACT, src: https://kiro.dev/docs/specs/feature-specs/).
- **Steering mid-run** — CLI queue-steering lets users queue messages during a run (FACT, src: https://kiro.dev/docs/cli/chat/queue-steering/).
- **Guards** — Crew exposes explicit bounds: `agent.chat_turn_timeout_secs` default 14400 (4h), `agent.subagent_timeout_secs` 10800 (3h), `agent.subagent_max_turns` up to 1000 tool calls, `orchestrator.max_plan_duration_seconds` default 2h for unattended plans (FACT, src: https://kiro.dev/changelog/ 0.6.0). IDE/CLI turn-limit internals: NOT FOUND.

## 4. Tool system

Documented built-in tool inventory (FACT, src: https://kiro.dev/docs/tools/, https://kiro.dev/docs/reference/built-in-tools/):

| Category | Tools |
|---|---|
| Filesystem | read file(s), list directory, file search, regex/grep search, `fs_write`, `str_replace`, `fs_append`, delete file |
| Shell | `execute_bash`, `control_bash_process`, process output/listing |
| Web | `web_search`, `web_fetch` |
| Delegation | `invoke_subagent`, task/todo list, `goal` (CLI) |
| Context | `disclose_context`, `introspect` (indexed Kiro docs: semantic + BM25), `tool_search` (BM25 search that *defers* MCP tool loading until needed), session settings, knowledge (experimental) |
| Code intel | `code` tool: tree-sitter + LSP-powered structural queries (CLI) |
| Meta | `create_hook`, Powers activation, thinking (experimental) |

- **Edit mechanism** — search/replace-style edits (`str_replace`) + full-file writes + append, surfaced as reviewable diffs (FACT, src: tools doc).
- **Tool gating** — every tool maps to a permission capability (fs_read, fs_write, shell, web_fetch, web_search, mcp, subagent, skill, power, context, diagnostics, sandbox_network) evaluated deny > ask > allow (FACT, src: https://kiro.dev/docs/permissions/).
- **MCP** — `mcpServers` JSON config at user + workspace scope; per-agent server lists + `includeMcpJson`; OAuth flows; `autoApprove`/`disabledTools` per server; `kiro://` one-click install links gated by a confirmation dialog; tools/prompts/resources/elicitation supported; `tool_search` enables deferred tool discovery (FACT, src: https://kiro.dev/docs/mcp/).
- **Tool-result size handling** — compaction covers history; per-tool truncation internals NOT FOUND.

## 5. Context management

- **Steering files** — `.kiro/steering/*.md` (workspace) + `~/.kiro/steering/` (global); foundation files `product.md`/`tech.md`/`structure.md`; inclusion modes `always`, `fileMatch` (globs), `manual`, `auto` (model matches by name+description — skills-style); `AGENTS.md` auto-included; `#[[file:...]]` references; team steering deployable via MDM; custom agents must opt steering in via `resources` (FACT, src: https://kiro.dev/docs/steering/).
- **`.kiroignore`** — gitignore-style exclusion of files/dirs from agent context and tools (FACT, src: https://kiro.dev/docs/kiroignore/).
- **Compaction** — automatic summarization as the window fills; preserves goals, decisions, task status, modified file paths, constraints, next steps, user intent; may drop tool-call minutiae/resolved errors; CLI tunables `compaction.excludeMessages` (verbatim recent pairs) and `compaction.excludeContextWindowPercent`; manual `/compact` (FACT, src: https://kiro.dev/docs/compaction/).
- **Retrieval** — deterministic: grep/file-search + LSP/tree-sitter `code` tool + `introspect` doc index (semantic+BM25 for *docs*, not code); no documented embedding index over the user's codebase — matches the industry norm (FACT on tools; INFERENCE that no vector index exists — searched: tools/context docs, no embeddings claims found).
- **CLI context tools** — `/context add <globs>` per-session file pinning with token-usage breakdown (FACT, src: https://kiro.dev/docs/cli/chat/context/).

## 6. Safety model

- **Capability permission algebra** — capabilities × effects (`deny` > `ask` > `allow`) × scopes (Kiro hardcoded → admin `managed-settings.json` → user → workspace → agent → session); workspace rules are stored **outside the repo** (`~/.kiro/workspace-roots/<hash>`) so a cloned repo cannot inject trust rules (FACT, src: https://kiro.dev/docs/permissions/, https://kiro.dev/docs/configuration/).
- **Shell safety** — compound commands are parsed and each segment matched separately; defaults allow `fs_read` on workspace + read-only git/system-info, always-ask on `.git/**` writes and `.kiro/agents|hooks` + `.kiroignore` modifications, hardcoded denies on settings dirs (FACT, src: https://kiro.dev/docs/permissions/).
- **Autonomy tiers** — Autopilot vs Supervised (`kiroAgent.agentAutonomy`); ACP policy presets (`_meta.kiro.policyPreset`) let hosts request a posture (FACT, src: permissions doc).
- **Hooks as guardrails** — `PreToolUse` hooks can block or require confirmation; `PostToolUse`/file-event hooks automate checks (FACT, src: https://kiro.dev/docs/hooks/).
- **Cloud sandbox** — per-task isolation, domain-level internet access control, env/secret injection via configured variables, teardown on completion (FACT, src: https://kiro.dev/docs/web/sandbox/).
- **Crew security** — `agent.sandbox` command gate (changelog warns: keep enabled, credential-path protection moved off command-text inspection), consent records, remote-crew trust posture inheritance (FACT, src: changelog 0.6.0, crew docs).
- **Enterprise** — managed settings via MDM/IAM, VPC endpoints (PrivateLink), data perimeters, compliance pages (FACT, src: https://kiro.dev/docs/enterprise/, privacy-and-security docs).

## 7. Orchestration

- **Custom agents & subagents** — `.kiro/agents/*.{json,md}` + `~/.kiro/agents/`; fields: name, description, tools, excludedTools, permissions, resources (`file://`, `skill://`), model, mcpServers/includeMcpJson, welcomeMessage, toolAliases; invoked as subagents via `invoke_subagent`; workspace definitions take precedence (FACT, src: https://kiro.dev/docs/custom-agents/).
- **Cross-surface sessions** — same harness locally (`kiro-cli`), in cloud (`kiro-cli --cloud --repo owner/repo`), or from IDE Agent Focus; sessions can start on one surface and be checked/resumed on another (FACT, src: https://kiro.dev/docs/cli/chat/, https://kiro.dev/blog/cloud-sessions/).
- **Web autonomous mode** — sub-agent fan-out per plan step, PR output, PR comment commands `/kiro all`, `/kiro fix` drive further iterations (FACT, src: https://kiro.dev/docs/web/autonomous-mode/, web/github docs).
- **ACP everywhere** — `kiro-cli acp` serves the harness over JSON-RPC stdio; supports `session/new|load|prompt|cancel|set_mode|set_model`, `loadSession`, image prompts; usable from JetBrains, Zed, any ACP editor (FACT, src: https://kiro.dev/docs/cli/acp/).
- **Headless/CI** — `kiro-cli` headless mode for non-interactive runs; exit codes documented (FACT, src: https://kiro.dev/docs/cli/headless/, reference docs).
- **Crew orchestration** — gateway-spawned subagents, remote crews (chat on a peer's runtime), crew members that dispatch workers, monitor loops that wake on change, scheduled jobs, task-runner with checkpointed multi-step plans (FACT, src: https://kiro.dev/docs/crew/, changelog 0.6.0).

## 8. Extensibility

- **Hooks** — `.kiro/hooks/*.json` (`version: v1`): triggers incl. `PromptSubmit`, `AgentStop`, `SessionStart`, `AgentSpawn`, `PreToolUse`, `PostToolUse`, `FileCreate`/`FileSave`/`FileDelete`, `PreTaskExecution`/`PostTaskExecution` (IDE), legacy manual hooks; two action kinds — run a command or send an agent prompt; regex matchers, timeouts, enabled flags, confirmation options on stop hooks (FACT, src: https://kiro.dev/docs/hooks/).
- **Powers** — plugins conforming to the open **Agent Plugins** spec (maintainers incl. Amazon, Cursor, Microsoft, OpenAI, Vercel): `plugin.json` manifest + `skills/` + `mcp.json` + `dev.kiro/`; **keyword-activated dynamic loading** (tools/MCP loaded on demand instead of upfront — explicitly pitched as the fix for context overload); registry incl. Datadog, Figma, Neon, Stripe, Supabase, AWS Aurora; legacy `POWER.md` still supported; cloud-synced powers for account-backed config (FACT, src: https://kiro.dev/docs/powers/).
- **Agent Skills** — standalone `SKILL.md` instruction packages; composable inside Powers and agents (FACT, src: https://kiro.dev/docs/skills/, powers doc).
- **MCP** — full client (tools, prompts, resources, elicitation, OAuth) — src above.
- **Slash/prompt customization** — saved prompts, custom agents, session settings; CLI `/tangent` for forked side-conversations (FACT, src: CLI docs).

## 9. Session & state

- **Directory-scoped persistence** — CLI remembers conversations per working directory; `kiro-cli chat --resume|--resume-id|--resume-picker`; `/chat new|save|load` (JSON export/import) (FACT, src: https://kiro.dev/docs/cli/chat/).
- **Checkpoints & rewind** — per-prompt checkpoints snapshot files the agent touches; **restore reverts files AND rewinds conversation context**; *Revert* undoes only the latest turn's file changes; **bash/MCP/external edits are not tracked**; CLI Rewind can fork the conversation from a checkpoint (FACT, src: https://kiro.dev/docs/checkpoints/).
- **Session search** — local index over titles/prompts (+ optionally agent responses); tool output excluded (FACT, src: changelog 2.21.4).
- **Cross-session/cloud** — cloud sessions keep running when the client disconnects; Configuration Sync carries steering/agents/skills/powers/hooks into new local sessions from cloud config (FACT, src: https://kiro.dev/blog/cloud-sessions/, changelog 2026-09-01).
- **Web memory** — learns durable patterns from PR feedback (documented as feedback-driven; scope-limited to your own comments) (FACT/VENDOR-CLAIM, src: https://kiro.dev/docs/web/memory/).
- **Storage format/paths** — internal store NOT FOUND (closed); Crew persists sessions/memory/schedules/checkpoints in its data dir (FACT, crew docs).

## 10. Model layer

- **Lineup (documented)** — Anthropic: Claude Opus 5/4.8/4.7/4.6/4.5, Sonnet 5/4.6/4.5/4.0, Haiku 4.5 (contexts 200K–1M); OpenAI: GPT-5.6 Sol/Terra/Luna (272K); open-weight: DeepSeek 3.2, MiniMax M2.5/M2.1, GLM-5, Qwen3 Coder Next; regions US/EU; per-model credit multipliers (0.05x–2.4x); tier gating Free/Pro/Pro+/Pro Max (FACT, src: https://kiro.dev/docs/models/).
- **Auto routing** — "Auto" selects the model per task (1.0x); model selection applies to chat only; web autonomous mode always self-selects (FACT, src: models doc, autonomous-mode doc).
- **Reasoning effort** — adjustable effort levels documented (FACT, src: https://kiro.dev/docs/models/effort/).
- **Auth** — GitHub, Gmail, Builder ID, IAM Identity Center; enterprise SSO/IdP; subscriptions Q Developer + Kiro interoperable (FACT, src: https://kiro.dev/docs/upgrade-guides/migrating-from-q/).
- **BYOK** — NOT FOUND (searched: models/auth docs) — Kiro is subscription/auth-only; no documented bring-your-own-key path.

## 11. Notable mechanisms

1. **Single harness behind ACP** — merging three per-surface agents into one standalone process driven by an open protocol is the most explicit published account of the "harness as product" architecture; ACP extended via `_meta.kiro.*` (policy presets) (src: https://kiro.dev/blog/one-agent/, https://kiro.dev/docs/cli/acp/).
2. **EARS specs as executable structure** — requirements (`WHEN … THE SYSTEM SHALL …`) → design → task DAG executed in parallel waves; Quick Spec collapses the gates; bugfix specs (`bugfix.md`) and IDE-only Correctness (property-based-test generation) extend the pipeline (src: https://kiro.dev/docs/specs/, feature-specs, quick-spec).
3. **Permission algebra with repo-external workspace trust** — capability×effect×scope with deny>ask>allow and workspace rules stored outside the repo is a notably rigorous model; compound-command parsing closes the `&&`-injection hole (src: https://kiro.dev/docs/permissions/).
4. **Powers = just-in-time tool loading** — keyword-activated Agent Plugins that defer MCP tool definitions until relevant; `tool_search` (BM25) applies the same deferred-loading idea to raw MCP servers (src: https://kiro.dev/docs/powers/, https://kiro.dev/docs/tools/).
5. **Crew: an AWS-shipped OpenClaw** — open-source persistent gateway (sessions/memory/cron/heartbeats/subagents/task-runner) whose agent backend is *pluggable* — KAS, Claude Code, or Codex — an unusual "harness-agnostic personal agent" offering from a hyperscaler (src: https://kiro.dev/docs/crew/, changelog 0.6.0).
6. **Checkpoints that rewind conversation + files together** — restores both the filesystem and the context to the pre-turn state; explicitly scoped to built-in file tools only (src: https://kiro.dev/docs/checkpoints/).

## 12. Evidence log

- https://kiro.dev/docs/how-kiro-works/ — unified harness, loop stages, ACP boundary — accessed 2026-09-15
- https://kiro.dev/blog/one-agent/ — three-agent consolidation, standalone-process rationale, per-language history — accessed 2026-09-15
- https://kiro.dev/blog/which-kiro-app-should-i-pick/ — TS/Rust/Python per-client agents → one harness — accessed 2026-09-15
- https://kiro.dev/docs/specs/ · /feature-specs/ · /quick-spec/ — requirements/design/tasks, EARS, dependency waves, no-gate quick spec — accessed 2026-09-15
- https://kiro.dev/docs/steering/ — steering scopes/modes, AGENTS.md, resources — accessed 2026-09-15
- https://kiro.dev/docs/hooks/ — hook triggers/actions/blocking — accessed 2026-09-15
- https://kiro.dev/docs/permissions/ — capabilities, effects, scopes, workspace-external trust, shell parsing, autopilot/supervised — accessed 2026-09-15
- https://kiro.dev/docs/custom-agents/ — agent file format, subagent invocation — accessed 2026-09-15
- https://kiro.dev/docs/tools/ · /reference/built-in-tools/ — tool inventory incl. code/tool_search/introspect — accessed 2026-09-15
- https://kiro.dev/docs/mcp/ — MCP config/scopes/install links — accessed 2026-09-15
- https://kiro.dev/docs/powers/ — Agent Plugins spec, dynamic loading, registry — accessed 2026-09-15
- https://kiro.dev/docs/compaction/ — compaction strategy + CLI tunables — accessed 2026-09-15
- https://kiro.dev/docs/checkpoints/ — checkpoint/revert/rewind semantics and limits — accessed 2026-09-15
- https://kiro.dev/docs/kiroignore/ — context/tool exclusion — accessed 2026-09-15
- https://kiro.dev/docs/cli/v3/ — V3 unified-harness CLI feature list — accessed 2026-09-15
- https://kiro.dev/docs/cli/chat/ — sessions, resume, /chat save/load, /context, inline shell — accessed 2026-09-15
- https://kiro.dev/docs/cli/acp/ — ACP methods/capabilities — accessed 2026-09-15
- https://kiro.dev/docs/cli/headless/ — non-interactive mode — accessed 2026-09-15
- https://kiro.dev/docs/cloud-sessions/ + https://kiro.dev/blog/cloud-sessions/ — `--cloud`, managed sandbox — accessed 2026-09-15
- https://kiro.dev/docs/web/autonomous-mode/ — clarify/plan/sub-agent/PR flow, auto model — accessed 2026-09-15
- https://kiro.dev/docs/web/sandbox/ — per-task sandbox, browser automation stack — accessed 2026-09-15
- https://kiro.dev/docs/web/memory/ — PR-feedback memory — accessed 2026-09-15
- https://kiro.dev/docs/models/ · /available-models/ · /effort/ — lineup, Auto, effort — accessed 2026-09-15
- https://kiro.dev/docs/upgrade-guides/migrating-from-q/ — Q Developer lineage: auto-update path, backwards compatibility, license change, feature parity — accessed 2026-09-15
- https://kiro.dev/docs/crew/ + https://kiro.dev/changelog/ — Crew gateway/channels/memory/pluggable backends; version line IDE 1.1 / CLI 2.21.4 / Crew 0.6.0 — accessed 2026-09-15

**Conflicts / gaps / unverified**: harness implementation language post-consolidation NOT FOUND (pre-consolidation languages are documented); IDE/CLI turn-limit and per-tool truncation internals NOT FOUND; BYOK not documented; Crew↔harness relationship is "backend plug-in" (documented) but the KAS backend's internals are not public; spec "Correctness"/PBT is IDE-only per docs. Amazon Q Developer lineage is FACT for the CLI (direct successor, backwards-compatible, license change documented); the IDE's relationship to Q Developer *plugin* technology is described only as "leverages advanced Q Developer functionality" — precise shared internals NOT FOUND.
