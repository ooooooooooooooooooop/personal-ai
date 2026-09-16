# Z.ai ZCode

> Z.ai (Zhipu AI) · Proprietary freeware (Coding Plan subscription tiers) · **Electron desktop app (download URLs expose `electron/releases/…`) embedding a Node.js agent runtime (`zcode.cjs`, shipped inside `resources/glm`)** — internals evidenced via the unofficial `kingsword09/zcode-cli` repackage · First public release 2025 · **Version studied: ZCode Desktop 3.11.2 (released 2026-09-04) + zcode-cli repo README (revision not recorded) · Date accessed 2026-09-15**
> Repo: none official (closed); unofficial evidence: https://github.com/kingsword09/zcode-cli · Docs: https://zcode.z.ai/en/docs
> Epistemic basis: MIXED (official docs + unofficial shipped-runtime repackage evidence)

## 1. Positioning & design philosophy

ZCode is Z.ai's first-party **agentic development environment (ADE)** built as the reference harness for **GLM-5.3** — the sell is model+harness co-design: "deeply tuned" for GLM-5.3's 1M-token context, flexible thought effort, and agentic-RL training, rather than a model-agnostic shell (VENDOR-CLAIM for tuning depth, FACT for the GLM-first product surface, src: zcode.z.ai/en/docs/agents, /welcome). Secondary bets: **goal-driven sessions** (Goal Mode with real-evidence verification), a **broad surface area** (desktop workspace + SSH/WSL/Docker remote dev + phone remote control + IM bot channels + scheduled/idle-time automations), and **Claude-Code-compatible extensibility** (skills/commands/subagents/hooks/plugin marketplaces including a preloaded Claude Code marketplace). The zcode-cli repackage proves the core is a **portable Node runtime** cleanly separable from its Electron/TUI shell (FACT, src: github.com/kingsword09/zcode-cli README).

## 2. Architecture overview

- **Desktop**: Electron app (dmg/exe under `cdn-zcode.z.ai/zcode/electron/releases/3.11.2/…`), macOS/Windows/Linux; workspace = project folder; sidebar of tasks grouped by workspace/group/timeline (FACT, src: download links in docs; /task-management).
- **Runtime (evidenced via zcode-cli)**: the desktop bundles an agent runtime under `resources/glm`, launched as `zcode.cjs` — a Node.js bundle that owns **agent loop, model access, sessions, tools, plugins, MCP, credential store, and provider configuration**. The UI talks to it through an **`@zcode/tui` adapter**; in zcode-cli that adapter is reimplemented on `@earendil-works/pi-tui`. Launch chain: `npm bin launcher → zcode.cjs (inherited terminal stdio) → @zcode/tui → pi-tui` (FACT, src: zcode-cli README "Architecture"; HOST_INTEGRATION.md — contract: hosts spawn `zcode` bin, inherit stdio, forward SIGINT/SIGTERM/SIGHUP, consume exit codes; runtime internals under `vendor/` are non-contract).
- **Process split**: launcher (config/login/version metadata, ~bounded stderr diagnostic log, model-catalog prefetch) vs runtime (everything agentic). `zcode version` reports both layers separately (`zcode-app-cli` + `zcode-runtime`) (FACT, src: zcode-cli docs/HOST_INTEGRATION.md).
- **App-server protocol**: the runtime exposes an `app-server` subcommand/protocol used for plugin marketplace ops — evidence of a programmatic control surface beyond TUI (FACT, src: zcode-cli README).
- **Remote execution**: SSH (built-in SSH client, password/key auth, remote-side resource download or local-download-then-upload), WSL (Windows desktop only), Docker (`docker exec`/`docker cp`) — file ops, terminal, git, and the agent itself run in the target environment while the desktop keeps account/model/UI (FACT, src: /docs/remote-development).
- **Headless modes**: `--prompt`, `--print`/`-p`, `--target` non-interactive entry points (FACT, src: zcode-cli README).

## 3. Agent loop

- **Turn loop**: prompt → streamed model response with tool calls (file ops, terminal, browser, agent spawn) → permission gates per execution mode → turn ends; a turn footer renders structured session-goal status (FACT, src: /docs/agents; zcode-cli README).
- **Goal Mode** (`/goal`): sets one **session objective**; after each round a separate completion check verifies the goal with **real evidence** (changed files, command output, tests — a conclusive-sounding reply or plan is insufficient); unmet → auto-starts another round; stops on completion, pause/clear, or configured usage budget; **goal state persists across session reopen**; cannot be set in Plan mode or while a task is running (FACT, src: /docs/goal).
- **Execution modes** (Shift+Tab cycle): **Ask before changes** (default), **Edit automatically** (edits auto, commands still confirm), **Plan mode** (read-only, proposes plan then implements on confirm), **Full access**; internal mode names per zcode-cli: `build`→`edit`→`yolo`→`plan` (FACT, src: /docs/agents "Execution Modes"; zcode-cli README).
- **Steering**: typing during a turn shows a "waiting" state and injects at a **safe model-step boundary**; queued inputs run FIFO; `Esc` cancels (FACT, src: zcode-cli README "steering/cancellation").
- **Auto-continue**: ordinary agent questions auto-continue after a 5-minute default; permission requests and plan approvals never auto-continue (FACT, src: /docs/agents).
- **Retry/compaction**: model requests get a default 5-retry budget (`ZCODE_MODEL_RETRY_MAX_RETRIES`), 60s stream idle timeout (`modelStream.idleTimeoutMs`), retryable errors shown in TUI; auth/invalid-request non-retryable; automatic context compaction exists (`/compact` manual) (FACT, src: zcode-cli docs/CONFIGURATION.md; /docs/commands).
- **Thought levels**: per-turn effort Low/High/**Max (default)** for GLM-5.3, also on Claude/GPT-class connected models (FACT, src: /docs/agents).

## 4. Tool system

- **Core tools**: file read/edit/write, search (bundled enhanced find/grep binaries per zcode-cli), bash/terminal with auto-backgrounding of long commands, **Browser Use** official plugin (drives the built-in browser: open/click/fill/screenshot; headless Chromium backend in CLI, `--browser-use=headless`, `--browser-executable`), computer use (macOS), Agent tool for subagents, Skill tool for on-demand skill bodies, MCP tools, wiki-generation readers (FACT, src: /docs/agents, /docs/browser-use; zcode-cli README).
- **Tool-call surfacing**: active tool/background-task/open-plan activity is persistently visible; task center tracks running+background work (FACT, src: zcode-cli README).
- **Edit tracking**: per-turn file changes with +/− counts, `/diff` view, **Undo/Reapply** per turn (all-or-nothing snapshot semantics), and workspace **checkpoints** enabling rewind (conversation-only / conversation+workspace / workspace-only scopes; runtime computes a "complete safe checkpoint plan"; externally-changed files not overwritten; bash-side mutations aren't checkpointed) (FACT, src: /docs/edit-history; zcode-cli README "rewind").
- **MCP tools**: stdio/HTTP/SSE transports, OAuth for remote servers; official HTTP MCP services gated behind a runtime "trusted-origin registry" (`official_auth_unavailable` diagnostic when absent) (FACT, src: /docs/mcp-services; zcode-cli CONFIGURATION.md).
- **Plugin-shipped tools**: plugins bundle skills, commands, subagents, MCP servers, hooks — enabled components register into the workspace as a unit (FACT, src: /docs/plugin).

## 5. Context management

- **Instruction files**: `AGENTS.md` read from user-global + current workspace only — **no multi-level merge, no `@import`/`@include` expansion, no per-task rule-file selection** (explicitly documented limits, FACT, src: /docs/agents "Project Instructions").
- **Memory**: opt-in per-project memory — after each successful turn the agent distills reusable facts to local Markdown (`memory/*.md` + `MEMORY.md` index under the user config dir); **off by default, never uploaded, not in git, main-conversation-only (subagents neither read nor write)**, and no browse/clear UI yet (FACT, src: /docs/memory, /docs/agents "Project Memory").
- **Composer context**: `@` file/folder/plugin references (plugin refs as `plugin://name@marketplace` markdown links), `#` past-conversation links, `$` skill invocation, `/` commands; long pastes become attachments instead of flooding the prompt (FACT, src: /docs/agents, /docs/plugin; zcode-cli README).
- **Skills injection**: `SKILL.md` name+description (≤250 chars) injected per turn under a fixed metadata budget — when the budget overflows, skills degrade to **names-only** listing; bodies load on demand via the Skill tool (FACT, src: /docs/skill; zcode-cli README skill docs).
- **Compaction**: `/compact` manual + automatic compaction; `/context` inspects prompt composition, cache and context usage; context-remaining metric in UI; forking blocked while a compaction runs (FACT, src: /docs/commands, /docs/agents; zcode-cli README).
- **Repo Wiki**: agent-generated architecture guide per workspace — model navigates the tree itself under a filtered read view (`.git`, deps, build output, gitignored paths, secret-named files like `token`/`secret`/`credential`/`password`, symlink targets all excluded); output `wiki.json` in user data dir (never in repo); auto-refresh check at end of turn when code changed; generation via OpenAI Chat Completions protocol only (FACT, src: /docs/repo-wiki).

## 6. Safety model

- **Four execution modes** + per-action permission prompts: decisions **Allow / Allow for session or project / Reject / Always Reject**; permission prompts pause the task and block the composer (FACT, src: /docs/agents, /docs/safety-confirm).
- **Blocked-action transparency**: 3.11.2 added clearer reasons when an action is blocked (FACT, src: /en/changelog).
- **Hooks as a control plane**: `PreToolUse` can allow/ask/deny; `PermissionRequest` event lets a hook arbitrate prompts; **`PostToolUseFailure`** and `Stop` (block → up to 3 re-entry loops) complete the lifecycle; protocol = JSON line on stdin → exit code/stdout JSON; **project-level hooks are deliberately ignored** (config_project_hooks_ignored) — only user-level/plugin hooks run, a supply-chain mitigation (FACT, src: /docs/hooks; zcode-cli README).
- **Remote surfaces**: Remote Control shares a QR/bearer-token link — treat link as a secret; bot-channel follow-ups scoped to bound workspaces (FACT, src: /docs/remote-control, /docs/bot-channel).
- **Credential storage**: desktop stores credentials encrypted (`enc:v1:` prefix, key held by desktop process) — zcode-cli reads desktop config but cannot copy creds, forcing fresh sign-in (FACT, src: zcode-cli CONFIGURATION.md).
- **Wiki read filter**: secret-named and gitignored files excluded from wiki model context (FACT, src: /docs/repo-wiki).
- **Sandboxing**: OS-level command sandbox like Devin's — NOT FOUND (permission modes only; searched: safety-confirm, agents, hooks docs).

## 7. Orchestration

- **Subagents**: built-ins `general-purpose` (full tools) and read-only `Explore`; user-defined `~/.zcode/agents/<name>.md` (own model, thinking effort, tools, system prompt); Agent calls **auto-background after ~1s** (`subagents.autoBackgroundMs`, `run_in_background:true` forces); `/tasks` task center can message/resume/stop background agents — resumable from the saved child session; task output survives restart (64KiB cap) (FACT, src: /docs/subagents; zcode-cli CONFIGURATION.md "Background agents").
- **Fork**: fork a session from any cleanly-completed assistant message — inherits history/model/thought-level/goal progress; **no file rollback**, no queued/background copy; original keeps running (FACT, src: /docs/agents "Forking").
- **Side conversation**: `/side`/`/btw` ephemeral sibling tab that reads main history as context, can use tools, doesn't inherit goal/queue/background work (FACT, src: /docs/agents).
- **Automations**: scheduled tasks (hourly→custom cron rules; project/permission/model/thought-level per task; can bind to an existing session) + **idle-time tasks** — free queue-based runs for Coding-Plan subscribers via a dedicated idle-time channel; time-limited segments **re-queue and continue in the same session**; user-typed messages bill normally (FACT, src: /docs/automations, /docs/idle-time-tasks).
- **Remote Control**: phone-browser control surface for an **already-open desktop workspace** — sends messages, approves permissions, views progress; does not create a runtime or sync code (FACT, src: /docs/remote-control).
- **Bot Channel**: follow-up execution over IM — **WeChat and Feishu** today (DingTalk/Discord/WeCom listed as later); Feishu renders streaming cards, tool activity collapsed, decision requests as separate cards; `/bind` flow (FACT, src: /docs/bot-channel).
- **Remote Development**: SSH/WSL/Docker execution targets; local skills/MCP/plugins syncable into the remote env (FACT, src: /docs/remote-development).

## 8. Extensibility

- **Skills**: `SKILL.md` (required `name`, `description`; description ≤250 chars; body size limits); user `~/.zcode/skills/<name>/SKILL.md` + project scope; **import from Claude Code, Codex, OpenClaw, Augment, Windsurf** (copy or symlink); `$name` invocation; plugin-bundled skills (FACT, src: /docs/skill).
- **Commands**: Markdown files under `~/.zcode/commands/` (user) and project dir (workspace); `/goal`, `/compact`, `/side`, `/btw`, `/diff`, `/context`, `/status`, `/activity`, `/tasks`, `/search`, `/transcript`, `/copy`, `/cls`, `/new`, `/settings`, `/model`, `/login`, `/setup` builtins (FACT, src: /docs/commands; zcode-cli README).
- **Plugins**: directory layout declares skills/commands/agents/MCP/hooks; `plugin.json`/`marketplace.json` manifests; **public catalog served from GitHub + preloaded Claude Code marketplace + custom sources** (GitHub repo, git URL, local dir); install scope user|workspace; CLI `zcode plugins list/enable/disable/install/…` via app-server protocol (FACT, src: /docs/plugin; zcode-cli README).
- **MCP**: `~/.zcode/cli/config.json` user scope + `<project>/.zcode/config.json` workspace scope; `.agents/mcp.json` compatibility fallback (`.zcode` wins within a scope, panel writes always to `.zcode`); import from Claude/Codex/OpenCode configs; OAuth for remote servers (FACT, src: /docs/mcp-services; zcode-cli CONFIGURATION.md).
- **Hooks**: stdin-JSON/exit-code protocol, events SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/Stop; user+plugin scopes only (FACT, src: /docs/hooks).
- **Config surface**: single `config.json` w/ strict schema; env overrides (`ZCODE_BASE_URL`, `ZCODE_TUI_MODE`, notification vars, `ZCODE_DISABLE_MODEL_CATALOG_REFRESH`); project overrides via `zcode.json` / `.zcode/config.json` (FACT, src: zcode-cli CONFIGURATION.md, /docs/configuration).

## 9. Session & state

- **Sessions**: per-workspace task list (grouped/workspace/timeline views; search; auto-archive candidates by 3/7/14/30-day retention; unarchive/delete); resume across app restart; draft tasks (FACT, src: /docs/task-management).
- **Rewind**: double-`Esc` rewind — conversation-only, conversation+workspace, or workspace-only; runtime computes a safe checkpoint plan; files changed externally aren't clobbered; bash mutations not checkpointed (FACT, src: zcode-cli README; /docs/edit-history).
- **Edit history**: edit a sent user message → resets chat and/or files back to that point; per-turn file snapshots for Undo/Reapply (FACT, src: /docs/edit-history).
- **Goal state**: persists across reopening the session (FACT, src: /docs/goal).
- **Task center**: background tasks + saved outputs persist (64KiB cap), resumable child sessions (FACT, src: zcode-cli README).
- **Wiki artifacts**: `~/.zcode/v2/repo-wiki/<workspace-hash>/wiki.json` — one wiki+one language per repo, no page-level regenerate or version history (FACT, src: /docs/repo-wiki).
- **Diagnostics**: bounded 2MB rotated runtime stderr log (owner-only perms) (FACT, src: zcode-cli CONFIGURATION.md).
- **Session DB format**: NOT FOUND (closed; zcode-cli treats sessions as runtime-owned, searched: README/CONFIGURATION).

## 10. Model layer

- **GLM-5.3 flagship**: vendor claims 1M-token stable context, long-horizon coding, index-sharing, speculative decoding, RL training for agentic coding; flexible thought effort surfaced as Low/High/Max (Max default) (VENDOR-CLAIM, src: /docs/welcome, /docs/agents).
- **Dual-role model config**: `model.main` (conversation) + `model.lite` (lightweight + **subagent** work) — model refs `provider-id/model-id` (FACT, src: zcode-cli CONFIGURATION.md).
- **Provider model**: `provider.<id>.kind` ∈ `anthropic` / `openai-compatible` / `openai`; per-provider `baseURL`, `apiKey`, `apiKeyRequired`, `headers`; per-model catalog records with `modalities.input/output` (text/audio/image/video/pdf — capability gates derived from input list) and `limit.context/output`; login gate special-cases provider IDs `zai`/`bigmodel` (upstream CLI 0.15.x evidence) (FACT, src: zcode-cli CONFIGURATION.md).
- **Model catalog auto-update**: TUI background-fetches Z.ai's official model catalog (6h cache, `model-catalog.json` + `model-catalog-managed.json` bookkeeping; auto-added entries retire only if untouched/unselected; `CI=1` or env disables) (FACT, src: zcode-cli CONFIGURATION.md).
- **Auth paths**: Z.ai OAuth (macOS-only `zcode://` callback bridge in zcode-cli; runtime does token exchange + encrypted credential persistence + Coding-Plan API-key resolution), Z.ai/BigModel Coding Plan API key, or any custom provider key — the harness is **model-proxy friendly**: arbitrary Anthropic/OpenAI-compatible endpoints work (FACT, src: /docs/configuration; zcode-cli CONFIGURATION.md).
- **Third-party models**: Claude, GPT etc. connectable w/ own thought levels; multimodal attach gated by declared `modalities.input` (image blocks silently dropped otherwise) (FACT, src: /docs/agents; zcode-cli CONFIGURATION.md).

## 11. Notable mechanisms

1. **Extractable runtime**: the entire agent core is a Node bundle (`resources/glm` → `zcode.cjs`) that a third party repackaged behind a pi-tui TUI — demonstrating a clean runtime/shell split and giving rare *evidence-level* visibility into a closed harness's layering (FACT, src: zcode-cli README/HOST_INTEGRATION).
2. **Goal Mode's evidence-verified loop**: completion is judged against changed files/command output/tests, not the model's claim — a verifier gate between rounds, plus a usage-budget stop (FACT, src: /docs/goal).
3. **Dual-scope rewind**: conversation vs workspace checkpoint axes are independent, with the runtime computing a safe restore plan that won't overwrite externally modified files — finer-grained than typical "checkpoint restore" (FACT, src: zcode-cli README; /docs/edit-history).
4. **Idle-time free channel**: a dedicated execution channel where automatic segments cost nothing, segments re-queue continuing the same session, and *user-typed* messages explicitly re-enter billing — an unusually explicit cost model woven into the loop (FACT, src: /docs/idle-time-tasks).
5. **Skill metadata budget**: a fixed prompt budget for skill metadata that degrades to names-only on overflow — documented graceful degradation for context pressure (FACT, src: /docs/skill).
6. **Ignored project hooks**: project-level hooks are refused by design — config files in a repo can't inject arbitrary code into every teammate's hook pipeline (FACT, src: /docs/hooks).

## 12. Evidence log

- https://zcode.z.ai/en/docs/welcome + /agents — positioning, GLM-5.3 claims, execution modes, thought levels, `@`/`#`/`$`, AGENTS.md limits, memory, side conversation, fork, auto-continue, browser use — accessed 2026-09-15
- https://zcode.z.ai/en/docs/goal — Goal Mode semantics, evidence verification, persistence, budget stop — accessed 2026-09-15
- https://zcode.z.ai/en/docs/safety-confirm — permission decisions/scopes — accessed 2026-09-15
- https://zcode.z.ai/en/docs/subagents — built-in agents, custom `~/.zcode/agents/*.md` — accessed 2026-09-15
- https://zcode.z.ai/en/docs/skill — SKILL.md fields/limits, import paths, metadata injection — accessed 2026-09-15
- https://zcode.z.ai/en/docs/commands — command files + builtins — accessed 2026-09-15
- https://zcode.z.ai/en/docs/mcp-services — transports, config files, `.zcode` vs `.agents` precedence — accessed 2026-09-15
- https://zcode.z.ai/en/docs/hooks — event list, stdin/exit protocol, project-hooks-ignored — accessed 2026-09-15
- https://zcode.z.ai/en/docs/plugin — bundle components, marketplace (GitHub catalog, Claude Code marketplace preload, custom sources), per-workspace enable — accessed 2026-09-15
- https://zcode.z.ai/en/docs/memory — off-by-default project memory, local Markdown, subagent exclusion — accessed 2026-09-15
- https://zcode.z.ai/en/docs/repo-wiki — wiki generation, filtered reads, storage path, OC-protocol-only generation — accessed 2026-09-15
- https://zcode.z.ai/en/docs/edit-history — message edit, per-turn undo — accessed 2026-09-15
- https://zcode.z.ai/en/docs/task-management — views, groups, archive retention, file tree, git graph — accessed 2026-09-15
- https://zcode.z.ai/en/docs/automations + /idle-time-tasks — scheduled + free-queue tasks — accessed 2026-09-15
- https://zcode.z.ai/en/docs/remote-development — SSH/WSL/Docker, credential store, resource download, skill/MCP sync — accessed 2026-09-15
- https://zcode.z.ai/en/docs/remote-control — phone control of open workspace — accessed 2026-09-15
- https://zcode.z.ai/en/docs/bot-channel — WeChat/Feishu bots, streaming cards — accessed 2026-09-15
- https://zcode.z.ai/en/docs/ADE-tools + /configuration — ADE surfaces, provider config — accessed 2026-09-15
- https://zcode.z.ai/en/changelog — 3.11.2 (2026-09-04): PDF/media preview, per-workspace plugins, blocked-action reasons, task/sidebar, browser persistence, context/model-switching/MCP/remote-reconnect/truncation/wiki/task-recovery fixes — accessed 2026-09-15
- https://github.com/kingsword09/zcode-cli (+ raw README, docs/CONFIGURATION.md, docs/HOST_INTEGRATION.md) — unofficial repackage: `resources/glm`→`zcode.cjs` runtime boundary, `@zcode/tui`/pi-tui adapter, inherited-stdio child-process launch, app-server protocol, main/lite model roles, provider kinds, catalog auto-update, `subagents.autoBackgroundMs`, retry/idle-timeout config, `enc:v1:` creds, headless flags, rewind/steering/task-center behavior, internal mode names (build/edit/yolo/plan); repo revision not recorded in session — accessed 2026-09-15
- Conflicts/gaps: official source code unavailable — zcode-cli README is unofficial (its observations are evidence about the shipped runtime, not vendor docs); session DB format, system-prompt structure, exact compaction policy NOT FOUND; upstream runtime version strings observed indirectly (`zcode-runtime` version reported by `zcode version`; upstream CLI 0.15.x referenced in config docs).
