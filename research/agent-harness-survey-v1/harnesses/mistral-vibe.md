# Mistral Vibe

> Mistral AI · Apache-2.0 · Python 3.12+ (uv-managed) · First release 2025 (public CLI launch 2025-12)
> **Version studied: commit `d4b3223bbd74f83cbc08da4b9c3776c8ad196955` (2026-09-13), `mistral-vibe@2.25.4`, shallow clone accessed 2026-09-15**
> Repo: https://github.com/mistralai/mistral-vibe · Docs: https://github.com/mistralai/mistral-vibe#readme (docs live in-repo under `docs/` and `vibe/cli` help)
> Epistemic basis: SOURCE-READ (cross-referenced against arXiv:2609.00006)

## 1. Positioning & design philosophy

Vibe is the **opinionated vendor CLI**: a single Python package where the control surface is *profiles* (`ask`, `plan`, `accept-edits`, `auto-approve`, `smart-approve`, `explore`, `lean` — each carrying a safety label `SAFE`/`NEUTRAL`/`DESTRUCTIVE`/`SMART`/`YOLO`) and the loop's policy layer is a composable **middleware pipeline** (turn/price/token limits, auto-compact, context warnings, read-only gating) evaluated before every model step. It is **ACP-native** — the same engine serves the Textual TUI and a `vibe-acp` JSON-RPC server — and is mid-migration to a Rust "unified harness" (`mistralai-vibe-local-harness==0.4.5` dependency; `--legacy-harness`/`--experimental-harness` flags and a GrowthBook rollout gate the Python path). Compared with OpenCode's platform breadth and Pi's minimal core, Vibe's bet is *managed UX with opinionated defaults*. [FACT for structure; INFERENCE for design-intent framing]

## 2. Architecture overview

- **Single package** `vibe/` (`pyproject.toml`, `uv`): `vibe/core` is the engine (agent loop, tools, permissions, LLM backends, config layers, sessions, compaction, rewind, skills, hooks, MCP, plugins); `vibe/cli` is the Textual TUI; `vibe/acp` is the ACP server (`vibe-acp` entrypoint); `vibe/app_server` holds session-backend ports + the unified-harness adapter; `vibe/setup` runs onboarding. (src: `vibe/`, `AGENTS.md` layout notes @ d4b3223b)
- **Ports-and-adapters**: `_port.py`-suffixed interfaces (e.g. `_session_backend_port.py` `SessionBackend` Protocol); the ACP layer delegates to `session.app_server` abstractions so the legacy Python harness and the Rust harness are interchangeable backends. (src: `vibe/app_server/_session_backend_port.py`, `vibe/app_server/_unified_harness_backend_adapter.py`, `vibe/acp/agent.py` @ d4b3223b)
- **Entry points**: `vibe` (TUI + headless), `vibe-acp` (stdio JSON-RPC for IDE clients like Zed). (src: `pyproject.toml` scripts, `vibe/acp/entrypoint.py` @ d4b3223b)

## 3. Agent loop

- **Shape**: `AgentLoop._conversation_loop` (`vibe/core/agent_loop/_loop.py:2050`) — an async generator: open user turn → `while` model steps: `middleware_pipeline.run_before_turn(ctx)` → `MiddlewareAction.STOP` returns, `INJECT_MESSAGE`/`COMPACT`/`CONTINUE` mutate the turn → `_perform_llm_turn()` streams events → `ContextTooLongError` triggers `_run_compaction()` and **retries the same logical turn once** (`_reactive_recovery_used`/`_should_self_heal` guard) → `stats.steps += 1` → `_save_messages()` per step → title-generation cadence → drain pending injections → **continue while the last message is a `tool` result or injections remain** → on completion, post-turn hooks may append a retry user message (`_queue_post_turn_retry`) → `finally: _save_messages()`. (src: `_loop.py:2050-2145` @ d4b3223b)
- **Middleware pipeline** (`vibe/core/middleware.py`): `ConversationMiddleware.before_turn` Protocol → `MiddlewareResult{action, ...}`; built-ins `TurnLimitMiddleware` (`--max-turns`), `PriceLimitMiddleware` (`--max-price`), `TokenLimitMiddleware`, `AutoCompactMiddleware`, `ContextWarningMiddleware` (default 0.5 threshold → injects a warning), `ReadOnlyAgentMiddleware` (plan/read-only reminder injection, `make_plan_agent_reminder`). Pipeline is rebuilt on profile/config changes (`_loop.py:1836-1851`), reset on stop/compact (`ResetReason`). This is the paper's signature "middleware-pipeline loop." [FACT]
- **Tool execution**: `_run_tools_concurrently` (`_loop.py:2615`) creates one `asyncio.Task` per resolved tool call, feeding a shared event queue so tool start/update/end events stream incrementally; cancellation cancels outstanding tasks. [FACT]
- **Stuck/cost guards**: turn/price/token middleware are the guards — real limits expressed as middleware rather than hardcoded in the loop; no separate stuck detector. [FACT]

## 4. Tool system

- **Discovery**: `ToolManager` (`vibe/core/tools/manager.py`) iterates tool classes found in `DEFAULT_TOOL_DIR` (`vibe/core/tools/builtins/`) plus `config.tool_paths` (custom Python tools); supports multiple *variants* per tool name (`_tool_variants_by_name`); MCP tools and connector tools integrate via registries; a `_permission_getter` callback and `defer_mcp` flag wire tool gating. (src: `tools/manager.py:80-279` @ d4b3223b)
- **Built-ins** (`vibe/core/tools/builtins/`): `bash` (plus managed-shell backends), `read`, `edit`, `write_file`, `grep`, `find`, `ls`-style listing, `task` (subagent delegation), glob/scratchpad/others — see §4 details below and `vibe/core/tools/builtins/` listing. [FACT]
- **Edit** (`builtins/edit.py`): exact-string `old_string`→`new_string` replacement; rejects empty old string, no-op edits, and ambiguous (multi-match) replacements unless `replace_all`; sensitive-path resolution goes through `resolve_file_tool_permission` (defaults to `ASK` even under permissive profiles); writes via an async file lock + `atomic_replace`. [FACT]
- **Write** (`builtins/write_file.py`): **create-only** — errors if the file exists ("Use edit to modify it"), optional parent-dir creation — a clean create/modify split. [FACT]
- **Bash** (`builtins/bash.py` + `_shell_permission_analysis.py`): command is parsed with **tree-sitter-bash** before permission evaluation; the analyzer enumerates dynamic constructs as *reasons* (command substitution, parameter/arithmetic expansion, process substitution, brace expansion, environment assignments, compound statements like `if`/`for`/`while`/`case`/subshells, Zsh-specific expansions) — anything not statically analyzable escalates to an approval reason; read-only allowlists and interactive/debugging command denylists; path-boundary analysis detects outside-workdir targets. (src: `_shell_permission_analysis.py:1-62` @ d4b3223b)
- **Truncation/results**: tool outputs flow through shared truncation utilities; results are `ToolResult`-typed with UI metadata (title/metadata/output). [FACT]
- **MCP**: `vibe/core/tools/mcp/` — registry + connection pool + authorization + descriptor cache + tool adapters; stdio/HTTP transports; **MCP sampling is supported**: `MCPSamplingHandler` (`tools/mcp_sampling.py`) maps server `CreateMessageRequestParams` into the active Vibe backend (system prompt + mapped messages) and returns `CreateMessageResult` — servers can call back into the model. [FACT]

## 5. Context management

- **System prompt** (`vibe/core/system_prompt.py` `get_universal_system_prompt`): configured base prompt → optional headless instructions → commit signature → active-model info → tool-aware OS section → available skills → available subagents → scratchpad → project context (git status/log via `ProjectContextProvider`, dangerous-directory warning, additional working dirs, `AGENTS.md`) → user/project instructions. Per-agent Markdown overlays provide per-profile prompts (paper: "per-agent Markdown prompts"). [FACT]
- **Git context safety**: `ProjectContextProvider` caches git context and deliberately invokes git with `-c core.fsmonitor=` and `--no-optional-locks` — a repo's fsmonitor hook can't execute payloads during context gathering, and no index locks are taken. [FACT]
- **Compaction** (`vibe/core/compaction/manager.py` + `context.py`): `CompactionManager` summarizes a selected snapshot of messages, builds an **injected user-message envelope** marking the compaction boundary, and only mutates the live message list *after* a successful summary — failures leave the transcript untouched; a tool-less dedicated summarizer is the fallback path; reactive compaction fires on `ContextTooLongError` mid-loop plus proactively via `AutoCompactMiddleware`. (src: `compaction/manager.py`, `_loop.py:2092-2099` @ d4b3223b)
- **Retrieval**: grep/find/read only; no embeddings — consistent with the paper's corpus-wide finding. [FACT]

## 6. Safety model

- **Permission engine** (`vibe/core/tools/permissions.py`): `ToolPermission` (allow/ask/never semantics) + `PermissionStore` of rules scoped by tool name × permission scope × wildcard invocation pattern; session-scoped approvals reset between sessions. `_should_execute_tool` order: bypass/auto-approve → resolve tool context → permanent allow/deny rules → matching previously-approved rule → else `request broker` approval prompt; only an explicit "yes" executes. (src: `tools/permissions.py`, `_loop.py` `_should_execute_tool` @ d4b3223b)
- **Profiles** (`vibe/core/agents/models.py`, `vibe/agents.py`): `ask` (NEUTRAL), `plan` (SAFE; write/edit restricted to plan files), `accept-edits` (DESTRUCTIVE; auto-approves write/edit), `auto-approve` (YOLO; bypasses permissions), `smart-approve` (SMART; model-classifier gate), `explore` (SAFE read-only subagent), `lean` (Lean-prover profile). Profile choice is the primary safety lever; `agent_type == SUBAGENT` marks delegation targets. [FACT]
- **Hooks as policy**: `PRE_TOOL` hooks can deny or rewrite tool inputs before execution (`hooks/executor.py`), `POST_AGENT` hooks can inject retry/user content — declarative commands with `match` filters, timeouts (default 60s), strictness. (src: `hooks/models.py`, `hooks/config.py` @ d4b3223b)
- **No OS sandbox**: none found in the inspected source; `--worktree` gives git-worktree isolation (a *branch* boundary, not a syscall boundary); `trusted_folders.toml` under VIBE_HOME gates project trust. [FACT — absence confirmed; worktree/​trust at `vibe/core/rewind`, `paths/_vibe_home.py`]
- **Sensitive paths**: edit/bash sensitive-path patterns default to `ASK` even in permissive profiles; `env`-file and outside-workdir accesses funnel through permission scopes. [FACT]

## 7. Orchestration

- **Subagents**: `task` tool (`builtins/task.py`) takes `{task, agent}` (default `explore`); only profiles with `agent_type == SUBAGENT` are valid targets; `explore` is read-only; **depth capped at 1** (a subagent cannot spawn another); the parent receives a compact `TaskResult{response, turns_used, completed}` — sequential in-process delegation, per the paper. (src: `tools/builtins/task.py`, `core/subagents.py` @ d4b3223b)
- **ACP-native**: `vibe-acp` (`acp/entrypoint.py` → `acp/agent.py` `run_acp_server`) speaks ACP over stdio: `session/prompt`, `session/cancel`, auth methods (browser + terminal/env-var methods), prompt capabilities, plus an extension-method surface (`session/set_title`, `session/delete`, `session/retrying`, trust/rewind/review extensions, `connectors/*`, `projectLinks/*`, `identity/*`/`account/*`). Sessions map to `session.app_server` backends so the Rust harness can serve the same protocol. (src: `acp/agent.py:440-1148` @ d4b3223b)
- **TUI/headless**: `vibe` runs the Textual TUI or headless prompts; `vibe.setup` handles first-run onboarding (`--setup`); session title generation is a scheduled background task inside the loop (`_title_cadence`). [FACT]
- **Dual harness**: `--legacy-harness`/`--experimental-harness` and a GrowthBook rollout select between the Python `AgentLoop` and the Rust `mistralai-vibe-local-harness` backend — the harness itself is behind a feature-flagged seam. (src: `acp/entrypoint.py:28-46`, `app_server/_unified_harness_backend_adapter.py` @ d4b3223b)

## 8. Extensibility

- **Hooks** (`vibe/core/hooks/`): types `POST_AGENT`, `PRE_TOOL`, `POST_TOOL`; sources host/project/project-plugin/global/global-plugin/client; **protocol adapters for Vibe, Claude Code, and Kimi Code hook formats** — Vibe accepts foreign-hook schemas; config = `{command, match, timeout(60s), strict, description}`; invocation context carries session id, transcript path, cwd, parent session id + tool fields. (src: `hooks/models.py`, `hooks/config.py`, `hooks/executor.py` @ d4b3223b)
- **Skills** (`core/skills/manager.py`): SKILL.md-style skills discovered from project `.vibe/skills`, global Vibe dirs, and `.agents/skills`; frontmatter-parsed, enable/disable patterns; registry/cache path for remote skills (incl. an option to fetch Mistral-published skills). [FACT]
- **Plugins** (`vibe/plugins/`, `vibe/plugins/builtins/vibe/plugin.json`): manifest-driven (`plugin.json`), plugins contribute hooks/config from project and global scopes. [FACT]
- **Custom tools**: `config.tool_paths` — Python files exposing `BaseTool` subclasses, discovered by `ToolManager` with hash-namespaced synthetic module names; same permission pipeline as built-ins. (src: `tools/manager.py:65-238` @ d4b3223b)
- **MCP**: configured servers join the tool surface via the MCP registry/pool; connectors (`core/tools/connectors/`) are a second integration family. [FACT]

## 9. Session & state

- **Persistence** (`core/session/session_logger.py`): per-session directory with a metadata file + `messages.jsonl` appended per step (secure file creation; atomic overwrite for metadata); metadata carries session info, model, cwd, title, git metadata; persistence can be disabled; session root under `VIBE_HOME` (`paths/_vibe_home.py`: `logs/session`, plus `plans/`, `worktrees/`, `trusted_folders.toml`, `vibehistory`, `cache.toml`, `projects.toml`, `whoami_cache.json`). [FACT]
- **Rewind & checkpoints** (`core/rewind/manager.py`, `core/checkpoints/checkpointer.py`): `Checkpointer` snapshots files around tool calls; `RewindManager` restores the conversation to a prior user-message turn — **default forks** (original kept as parent branch), in-place mode truncates — and can optionally **restore file contents** from checkpoints, which is stronger than Pi's transcript-only branching. [FACT]
- **Transcript model**: append-only `messages.jsonl` with role-typed messages; compaction boundary is itself a message; the loop persists after every model step so the on-disk log stays fresh. [FACT]

## 10. Model layer

- **Backends** (`vibe/core/llm/backend/`): `Backend` enum = `MISTRAL` + `GENERIC` (`core/types.py:46-49`). `MistralBackend` wraps the `mistralai` SDK; `GenericBackend` is an httpx streaming client with **`api_style` adapters**: `openai`, `reasoning`, `anthropic`, `openai-responses`, `vertex-anthropic` — one backend, five wire dialects selected per provider config. (src: `llm/backend/factory.py`, `generic.py:213-226` @ d4b3223b)
- **Providers/models**: providers declared in config (`name`, `api_base`, `backend`, key via env); built-in catalog includes `mistral-vibe-cli-latest` (alias `mistral-medium-3.5`), voxtral TTS entry, Mistral API/wss endpoints; model patterns support globs and `re:` regex (`vibe_schema.py`). BYOK = a generic-backend provider entry. [FACT]
- **Config layering** (`core/config/builder.py` + `layers/`): default → user → project → environment → agent_profile → overrides → admin → discovered → growthbook layers; per-field merge strategies with origin tracking; **untrusted and empty layers are skipped** — project config can't apply before trust. [FACT]
- **Sampling**: `MCPSamplingHandler` lets MCP servers issue `CreateMessage` calls through the *active* model — the harness is an MCP client that can also be an MCP-server's LLM. [FACT]
- **Usage accounting**: `AgentStats` tracks steps, session token totals, cache hits, and per-outcome tool-call counters (`tool_calls_agreed/rejected/hook_denied/…`). (src: `core/types.py:52-62` @ d4b3223b)

## 11. Notable mechanisms

1. **Middleware-as-loop-policy** — turn/price/token limits, auto-compaction, context warnings, and read-only enforcement are uniform `before_turn` middleware returning `STOP`/`INJECT_MESSAGE`/`COMPACT`/`CONTINUE`; policy composes without touching the loop body. (`core/middleware.py`, `_loop.py:1836-1887`)
2. **Tree-sitter permission analysis** — bash commands are parsed, not regex'd: the analyzer names *which* dynamic construct (command substitution, `$()` arithmetic, subshells, Zsh expansions…) forced escalation, so approval prompts carry concrete reasons. (`tools/builtins/_shell_permission_analysis.py`)
3. **fsmonitor self-defense** — project-context git calls pin `-c core.fsmonitor=` + `--no-optional-locks` so a hostile repo's fsmonitor hook can't run code during context gathering and no locks are taken on a repo the agent only reads. (`core/system_prompt.py` `ProjectContextProvider`)
4. **Compaction envelope + fork-rewind** — compaction writes a boundary-marked injected user message only after a successful summary; rewind defaults to *forking* the session (original preserved as parent) and can restore file snapshots taken around tool calls — transcript and filesystem rewind in one gesture. (`core/compaction/manager.py`, `core/rewind/manager.py`, `core/checkpoints/checkpointer.py`)
5. **Foreign-hook compatibility** — the hook executor accepts Claude Code and Kimi Code hook protocols alongside Vibe's own, lowering migration friction — a cross-vendor adoption seam. (`core/hooks/models.py`)
6. **MCP sampling** — one of the few studied harnesses where an MCP server can call back into the harness's model; contrast OpenCode, where sampling is explicitly disabled. (`core/tools/mcp_sampling.py`)

## 12. Evidence log

- `mistral-vibe/` @ `d4b3223bbd74f83cbc08da4b9c3776c8ad196955` — all FACT claims (paths cited inline) — accessed 2026-09-15
  - `vibe/core/agent_loop/_loop.py:1836-2150,2615+`, `core/middleware.py`, `_request_broker.py`, `_title_cadence.py` — loop, middleware, tool concurrency
  - `vibe/core/tools/{manager.py, permissions.py, base.py, builtins/{bash,_shell_permission_analysis,edit,write_file,task}.py, mcp/, mcp_sampling.py}` — tool system + MCP
  - `vibe/core/system_prompt.py`, `core/compaction/{manager,context}.py` — prompt + compaction
  - `vibe/core/agents/models.py`, `vibe/agents.py`, `core/hooks/{models,config,executor}.py`, `core/skills/manager.py`, `core/config/{builder.py,layers/}`, `core/paths/_vibe_home.py` — profiles, hooks, skills, config, paths
  - `vibe/core/session/session_logger.py`, `core/rewind/manager.py`, `core/checkpoints/checkpointer.py` — persistence + rewind
  - `vibe/core/llm/backend/{factory,generic,mistral,anthropic,openai_responses,vertex,reasoning_adapter}.py`, `core/types.py` — model layer
  - `vibe/acp/{entrypoint,agent,session}.py`, `vibe/app_server/` — ACP + harness seam
  - `vibe/plugins/`, `pyproject.toml` — plugins, packaging
- https://arxiv.org/abs/2609.00006 (*Harness Engineering*, §Mistral Vibe) — middleware-pipeline loop, per-agent Markdown prompts, profile/safety-label taxonomy, sequential in-process subagents, ACP-native positioning — accessed 2026-09-15
- **Conflicts / gaps / unverified**:
  - The Rust `mistralai-vibe-local-harness` is a compiled dependency; its internals are not in this repo — the Python↔Rust parity surface was verified only at the adapter/flag level.
  - `smart-approve`'s classifier implementation detail was not line-traced (profile + gate wiring verified).
  - Full builtin tool inventory was enumerated from `builtins/` listing; a few less-central tools (scratchpad, managed-shell variants) were not individually audited.
  - MCP transport matrix (stdio/HTTP/streamable-HTTP + OAuth flow internals) was verified at the registry/pool/authorization module level, not each transport's full code path.
