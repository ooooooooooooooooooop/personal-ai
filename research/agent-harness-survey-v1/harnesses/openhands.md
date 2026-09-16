# OpenHands

> All Hands AI (formerly OpenDevin; org now `OpenHands`) · MIT (with `enterprise/` under a separate license — `LICENSE` header) · Python (+ TS frontend) · First release 2024 (VENDOR-CLAIM) · **Version studied: tag `0.62.0`, commit `7fbb48c40679afd674970966b96185657d92a487`, accessed 2026-09-15.** Note: `main` HEAD (`23ca81c9ff6e638546f966d7f0e11a7682666179`, 2026-09-15) has been repurposed into **"Agent Canvas"**, a TypeScript/Electron control-center app (`package.json` name `@openhands/agent-canvas`); the Python harness last shipped as tag 0.62.0, and per arXiv:2609.00006 the V1 agent core now lives in the separate `software-agent-sdk` repository.
> Repo: https://github.com/All-Hands-AI/OpenHands · Docs: https://docs.openhands.dev
> Epistemic basis: SOURCE-READ (0.62.0 tag, `openhands/` package) + paper cross-reference for V1 changes

## 1. Positioning & design philosophy

OpenHands is the "everything is an event" pole of the corpus: a full-stack agent *platform* where the agent loop, tool execution, microagent retrieval, security analysis, and UI streaming are all decoupled subscribers on a persisted, secret-scrubbed event log (`openhands/events/stream.py`). Its bet is that observability, replayability, and sandbox isolation justify a heavier architecture — an `AgentController` state machine on top of an `EventStream`, an abstract `Runtime` that executes actions inside a per-session Docker container over HTTP, and a microagent knowledge layer. The paper calls it an "event-sourced conversation engine" (arXiv:2609.00006 §6.2.1). Against mini-swe-agent's ~190-line core, OpenHands is the maximal-harness reference: plugins, condensers, delegates, security analyzers, multiple surfaces (GUI server, CLI, resolver, headless).

## 2. Architecture overview

Multi-process by default. Entry points (FACT):

- `openhands/core/main.py:52 run_controller()` — headless/CLI entry: `create_agent` → `create_runtime` → `create_memory` → `AgentController` → `run_agent_until_done` (`core/loop.py` — literally `while controller.state.agent_state not in end_states: await asyncio.sleep(1)`; the loop is event-driven, not a Python while-loop over turns).
- `openhands/server/app.py` + `listen_socket.py` — FastAPI + Socket.IO web server; `conversation_manager` manages sessions; frontend in `frontend/` (React).
- `openhands-cli/` — standalone interactive CLI package.
- `openhands/resolver/` — GitHub/GitLab issue resolver for CI.
- `evaluation/` — benchmark harness (SWE-bench etc.).

Major modules: `openhands/controller/` (`agent_controller.py` — the loop brain; `agent.py` — agent ABC; `state/` — State + StateTracker; `stuck.py`; `replay.py`), `openhands/events/` (`stream.py`, `event_store.py`, `action/`, `observation/`, `serialization/`), `openhands/runtime/` (`base.py` + `impl/{docker,remote,local,kubernetes,cli}` + `action_execution_server.py`), `openhands/agenthub/` (`codeact_agent`, `browsing_agent`, `readonly_agent`, `loc_agent`, `visualbrowsing_agent`, `dummy_agent`), `openhands/memory/` (`memory.py`, `condenser/`), `openhands/microagent/`, `openhands/llm/` (`llm.py`, `llm_registry.py`, `fn_call_converter.py`, `retry_mixin.py`, `router/`), `openhands/security/`, `openhands/mcp/`, `openhands/storage/` (FileStore abstraction: local FS + others).

## 3. Agent loop

Event-sourced, callback-driven (FACT — `controller/agent_controller.py`):

1. `AgentController.__init__` subscribes `self.on_event` to the `EventStream` under `EventStreamSubscriber.AGENT_CONTROLLER` (line 167-170) and injects a `SystemMessageAction` (line 245 `_add_system_message`).
2. Every event appended to the stream is dispatched to subscribers; `on_event` → `_on_event` records history via `StateTracker`, routes Actions/Observations, then `should_step(event)` decides whether the agent gets a turn (lines 402-441): user `MessageAction`s, `AgentDelegateAction`, `Condensation(Action|Request)`, and any non-null Observation trigger a step.
3. `_step()` (line 852): requires `AgentState.RUNNING` and no `_pending_action`; runs `state_tracker.run_control_flags()` (iteration & budget flags), `_is_stuck()` check, then `action = self.agent.step(self.state)`.
4. Runnable actions go through confirmation gating (§6) and are posted back to the stream with `event_stream.add_event(action, AGENT)` (line 1004). The `Runtime` subscriber picks them up, executes, and posts an Observation — which triggers the next step. `AgentFinishAction` → FINISHED; `AgentRejectAction` → REJECTED.
5. `AgentState` machine: RUNNING, FINISHED, ERROR, STOPPED, REJECTED, AWAITING_USER_INPUT, AWAITING_USER_CONFIRMATION, USER_CONFIRMED, USER_REJECTED, RATE_LIMITED (`core/schema`); transitions emit `AgentStateChangedObservation` and `save_state()` (lines 662-714).

`CodeActAgent.step` (`agenthub/codeact_agent/codeact_agent.py:161-225`): pops `pending_actions` deque if non-empty (one LLM response can yield several actions, executed serially); `/exit` shortcut; runs `condenser.condensed_history(state)` — returns either a `View` (events to send) or a `Condensation` action (returned immediately so the controller posts it and re-steps); builds messages via `ConversationMemory.process_events` + `apply_prompt_caching`; calls `self.llm.completion(messages, tools, extra_body={metadata})`; maps the response to Actions via `function_calling.response_to_actions`.

- **Stopping**: `AgentFinishAction`; `max_iterations` default 500 (`core/config/config_utils.py:8 OH_MAX_ITERATIONS`); `max_budget_per_task` USD cap via `budget_flag` synced to LLM metrics (`state_tracker.sync_budget_flag_with_metrics`, line 879).
- **Retry/recovery**: LiteLLM retry decorator with configured `num_retries`, `retry_min_wait`, `retry_max_wait`, `retry_multiplier` (`llm/llm.py:221-227`, `retry_mixin.py`); rate-limit → `AgentState.RATE_LIMITED` until final retry (lines 347-362); context-window errors detected by string-matching LiteLLM exceptions (lines 919-948) → `CondensationRequestAction` if `enable_history_truncation` else `LLMContextWindowExceedError`; malformed tool calls → `ErrorObservation` fed back into history (lines 905-918).
- **Stuck detection**: `StuckDetector` (`controller/stuck.py`) — five heuristics: repeating action+observation, repeating action+error, monologue (consecutive agent messages), alternating A-B-A-B pattern, context-window-error loops. On stuck → `AgentStuckInLoopError` → ERROR; `LoopRecoveryAction` offers restart-before-loop / restart-with-last-user-message / stop (lines 602-619).
- **Replay**: `ReplayManager` can inject a recorded trajectory instead of live steps (line 895-898) — used for evals.

## 4. Tool system

Function-calling native. Tool inventory assembled in `CodeActAgent._get_tools` (`codeact_agent.py:108-153`), each a `ChatCompletionToolParam`, gated by `AgentConfig` flags (`enable_cmd`, `enable_think`, `enable_finish`, `enable_condensation_request`, `enable_browsing`, `enable_jupyter`, `enable_plan_mode`, `enable_llm_editor`/`enable_editor`):

- `execute_bash` (`tools/bash.py`) — run a shell command in the runtime.
- `think` (`ThinkTool`) — log a thought, returns fixed observation.
- `finish` (`FinishTool`) — end task with outputs.
- `condensation_request` — agent-initiated compaction.
- `browser` / `browse` — browsergym-based web actions (Linux runtimes only; skipped on win32, line 135).
- `execute_ipython_cell` (`IPythonTool`) — Jupyter cell in the runtime's Jupyter plugin.
- `task_tracker` (`create_task_tracker_tool`, plan mode) — plan/view a `TASKS.md` task list persisted to the session dir (`runtime/base.py:936-992`).
- File editing — two options: `str_replace_editor` (`tools/str_replace_editor.py`, Anthropic-style `view`/`create`/`str_replace`/`insert`/`undo_edit` with exact-match `old_str` uniqueness contract — the ACI lineage from SWE-agent) or `LLMBasedFileEditTool` (`tools/llm_based_edit.py`). `SHORT_TOOL_DESCRIPTION_LLM_SUBSTRS` shrinks descriptions for gpt-4/o1/o3/o4 models (lines 111-123).
- **MCP tools**: `mcp_tools` merged into the callable set; `response_to_actions` maps unknown tool names matching MCP tool names to `MCPAction` (`function_calling.py:73+`, `codeact_agent.py:296-300`).

Actions and Observations are typed event classes (`events/action/*.py`, `events/observation/*.py`): `CmdRunAction`, `IPythonRunCellAction`, `FileReadAction`, `FileWriteAction`, `FileEditAction`, `BrowseURLAction`, `BrowseInteractiveAction`, `AgentDelegateAction`, `MessageAction`, `RecallAction`, `CondensationAction`, `TaskTrackingAction`, `MCPAction`, `ChangeAgentStateAction`, `NullAction`, … each carrying a `tool_call_metadata` link back to the originating tool call so observations can be paired (e.g. `_handle_observation` line 549, `end_delegate` line 841-845).

- **Result size**: observations are truncated for display/logging via `truncate_content(content, max_message_chars)` (`agent_controller.py:537-541`); `max_message_chars` is an LLMConfig field; tool docs warn of `<response clipped>` (str_replace_editor description).
- **Runtime dispatch**: `Runtime.run_action` (`runtime/base.py:928-1007`) dispatches on `action.action` string to `run`/`run_ipython`/`read`/`write`/`edit`/`browse`/`browse_interactive`/`call_tool_mcp`; unsupported → `ErrorObservation`.
- **Sandbox execution**: `DockerRuntime` starts a per-session container running `action_execution_server.py` — a FastAPI service *inside the sandbox* exposing `POST /execute_action`, `/server_info`, `/update_mcp_server` (`runtime/action_execution_server.py:757+`); the host runtime serializes the Action to JSON, POSTs it, deserializes the Observation. Image is built on demand (`maybe_build_runtime_container_image`, `docker_runtime.py:233`). `LocalRuntime`/`CLIRuntime` run the same server on the host for dev. FACT.
- **Tool gating**: per-tool `security_risk` param (the LLM self-rates each call — `tools/security_utils.py` `SECURITY_RISK_DESC`, applied by `set_security_risk` in `function_calling.py:59-70`) + confirmation mode (§6).

## 5. Context management

- **System prompt**: Jinja2 `system_prompt.j2` per agent (`agenthub/codeact_agent/prompts/`), rendered by `PromptManager` (`utils/prompt.py`) into a `SystemMessageAction` added once at controller init. Sections include ROLE, EFFICIENCY ("combine multiple actions into a single action… use sed and grep"), FILE_SYSTEM_GUIDELINES, CODE_QUALITY, VERSION_CONTROL (commit hygiene, co-author trailer `Co-authored-by: openhands <openhands@all-hands.dev>`), PULL_REQUESTS, PROBLEM_SOLVING_WORKFLOW (explore→analyze→test→implement→verify), SECURITY, SECURITY_RISK_ASSESSMENT (instructs the model to fill the `security_risk` tool param), EXTERNAL_SERVICES, ENVIRONMENT_SETUP. Variants: `system_prompt_interactive.j2`, `system_prompt_long_horizon.j2`, selected via `resolved_system_prompt_filename` (plan mode swaps the file unless overridden — `agent_config.py:71-79`). FACT.
- **Microagent injection**: `microagent_info.j2` renders triggered knowledge (§8).
- **History → messages**: `ConversationMemory.process_events` (`memory/conversation_memory.py`) converts the condensed event list into `Message`s — pairing tool calls with their observations, inserting the initial user message, managing user/assistant alternation, applying vision only when `llm.vision_is_active()`, and honoring `max_message_chars`.
- **Compaction ("condensers")**: pluggable `Condenser` ABC (`memory/condenser/condenser.py`) returning `View | Condensation`; a `CONDENSER_REGISTRY` maps config types. Nine implementations in `memory/condenser/impl/`: `no_op`, `observation_masking`, `browser_output`, `recent_events`, `llm_summarizing` (keeps first N + LLM summary of forgotten events, `max_size=100`/`keep_first=1`), `amortized_forgetting`, `llm_attention`, `structured_summary`, `conversation_window` (**default**, `agent_config.py:54-59` — keeps system msg + first user msg + recall obs, drops middle events preserving action-obs pairs), and `pipeline` (chains condensers). Condensation is itself event-sourced: a `CondensationAction(forgotten_event_ids=...)` lands in the log so replays stay faithful (FACT — `conversation_window_condenser.py`, `agent_controller` handles it via `should_step`).
- **Prompt caching**: `conversation_memory.apply_prompt_caching` sets cache breakpoints for caching-capable models (line 688+).
- **Retrieval**: none beyond microagent trigger matching — no embeddings, no repo map. Deterministic keyword triggers only (matches paper's no-RAG finding, arXiv:2609.00006 §13.2).
- The paper notes the V1 SDK replaced `PromptManager` with a guarded `PromptRegistry` of ordered `PromptSection`s bucketed into STATIC/DYNAMIC cache tiers (18 named sections incl. a `SOUL.md`-backed Soul section), and consolidated condensers to three — V1 claims from arXiv:2609.00006 §7.2.5/§9.4, not in 0.62.0.

## 6. Safety model

Defense-in-depth, the corpus's most layered pre-V1 (FACT unless noted):

- **Sandboxing**: default runtime is a Docker container per session (`runtime/impl/docker/`); remote/k8s for cloud; `local`/`cli` for un-sandboxed dev. Workspace mounted at `/workspace`; `SANDBOX_ENV_*` env passthrough (`runtime/base.py:80-88`); sandbox `timeout` enforced via `action.set_hard_timeout` (line 371-373).
- **Confirmation mode**: `confirmation_mode` + `ActionConfirmationStatus`. Runnable actions (`CmdRun`, `IPythonRunCell`, `BrowseInteractive`, `FileEdit`, `FileRead`) are risk-scored then possibly held at `AWAITING_CONFIRMATION` → `AgentState.AWAITING_USER_CONFIRMATION` (agent_controller.py:950-999); USER_CONFIRMED/USER_REJECTED resumes or returns to AWAITING_USER_INPUT.
- **SecurityAnalyzer** (`security/options.py`): pluggable — `invariant` (Invariant Labs), `llm` (LLMRiskAnalyzer), `grayswan` (GraySwan external API). Fail-safe: no analyzer configured ⇒ every action treated `UNKNOWN` ⇒ confirmation required in confirmation mode (lines 236-243). `HIGH` risk always requires confirmation (non-CLI). CLI mode sets AWAITING_CONFIRMATION and handles risk itself (lines 974-980).
- **LLM self-rating**: the tool schema includes a `security_risk` arg the model fills per call — prompt-instructed in the SECURITY_RISK_ASSESSMENT prompt section (`function_calling.py:59-70`, `tools/security_utils.py`).
- **Secrets**: `EventStream.set_secrets/update_secrets`; every event is serialized through `_replace_secrets` before persistence, replacing secret values with `<secret_hidden>` while protecting top-level system fields (`stream.py:215-244`). Git provider tokens are refreshed into the sandbox env on demand (`_export_latest_git_provider_tokens`, `runtime/base.py:326-368`).
- **Network policy**: whatever the container provides; no explicit egress policy layer found (NOT FOUND in `runtime/`).
- V1 per paper: adds deterministic `PatternSecurityAnalyzer`/`PolicyRailSecurityAnalyzer` (shell-AST rails like fetch-to-exec, catastrophic-delete), `EnsembleSecurityAnalyzer` worst-case-wins, `<UNTRUSTED_CONTENT>` wrapping for repo-derived context (arXiv:2609.00006 §10.3 — V1, not in studied tag).

## 7. Orchestration

- **Subagents**: `AgentDelegateAction` → `start_delegate` creates a child `AgentController` (`is_delegate=True`, `delegate_level+1`) **sharing the same event stream**, with its own `State` (inputs from `action.inputs`) but shared `metrics`, iteration flag, and budget flag (`agent_controller.py:724-783`). While a delegate runs, parent `on_event` forwards everything to it; on finish/error `end_delegate` posts an `AgentDelegateObservation` linked to the delegate's tool call (lines 449-475, 785-850). Sequential delegation only — one delegate at a time. The paper notes V1 replaced this with tool-based delegation (`TaskTool`/`DelegateTool` running concurrent threaded tasks on separate conversation logs) — V1 claim.
- **Parallelism**: none in V0 beyond the subscriber thread pools (each subscriber gets a dedicated `ThreadPoolExecutor(1)` + event loop, `stream.py:130-148`).
- **Surfaces**: web GUI (FastAPI + Socket.IO `listen_socket.py`, `conversation_manager/`), `openhands-cli` (standalone CLI package, own `main()`), headless (`core/main.py`, `python -m openhands.core.main -t "task"`), GitHub/GitLab/Bitbucket **resolver** (`resolver/` + `integrations/` for issue→PR automation), `app_server/` for the SaaS API. Events stream to clients via the `SERVER` subscriber.
- **Wire protocols**: Socket.IO for UI; HTTP between host runtime and in-sandbox `action_execution_server.py` (`/execute_action`); MCP client+server support (§8). The repo's README at HEAD shows the product evolved into an ACP host ("run OpenHands, Claude Code, Codex, Gemini, or any ACP-compatible agent") — that's the Agent Canvas app, not the Python core.
- **Session-as-API**: `conversation_stats`, `RuntimeStatus` enums, and the whole stream are inspectable — the event log *is* the API model.

## 8. Extensibility

- **Microagents** (`microagent/` + `openhands/microagent/`): Markdown files with YAML frontmatter. `BaseMicroagent.load` → `KnowledgeMicroagent` (keyword `triggers` — matched against user messages in `Memory._find_microagent_knowledge`), `RepoMicroagent` (always-on repo instructions; third-party convention files `.cursorrules`, `agents.md`, `agent.md` are auto-imported as repo microagents — `microagent.py:28-45`), `TaskMicroagent`. Loaded from global `microagents/` (43 bundled: `add_agent`, `address_pr_comments`, `fix-py-line-too-long`, …), `~/.openhands/microagents`, and workspace `.openhands/microagents` (`memory/memory.py:35-84`).
- **Recall flow**: every user `MessageAction` causes the controller to inject a `RecallAction` (`WORKSPACE_CONTEXT` on first message, `KNOWLEDGE` after — `agent_controller.py:578-592`); the `Memory` subscriber (a second event-stream subscriber) answers with a `RecallObservation` carrying repo context + matched microagent knowledge.
- **Runtime plugins**: `PluginRequirement`s (`AgentSkillsRequirement`, `JupyterRequirement`, `VSCodeRequirement` — `runtime/plugins/`) bootstrap agent-skills Jupyter functions inside the sandbox.
- **Custom agents**: `Agent.get_cls` registry + `agenthub/` agents; `agent_configs`/`agent_to_llm_config` dicts let delegates run different agents/models.
- **MCP**: `openhands/mcp/client.py` (`connect_http`, `connect_stdio`, `call_tool`), `mcp/utils.py` (`create_mcp_clients`, `convert_mcp_clients_to_tools` → `ChatCompletionToolParam`s), `runtime/mcp/proxy.py` `MCPProxyManager` mounts MCP servers inside the sandbox FastAPI app (`/update_mcp_server` endpoint). Config via `MCPConfig` (`core/config/mcp_config.py`). FACT.
- **Config**: `config.template.toml` + pydantic `OpenHandsConfig`/`AgentConfig`/`LLMConfig`/`SandboxConfig`/`SecurityConfig`; per-agent `[agent.X]` and per-LLM `[llm.X]` sections.
- Hooks/skills in the Claude-Code sense: NOT FOUND in 0.62.0 (microagents are the extension surface).

## 9. Session & state

- **Persistence** (`events/stream.py` + `events/event_store.py` + `storage/locations.py`): every event is a JSON file — `sessions/{sid}/events/{id}.json` (or `users/{uid}/conversations/{sid}/events/`); writes go through `FileStore` (local FS default; pluggable). A page cache (`_write_page_cache`, `cache_size` events/page) is written alongside for fast sequential reads (lines 174-213). Events >1 MB logged as warnings (line 190).
- **Agent state**: `agent_state.pkl` — `pickle`+base64 `State` (`state/state.py:122-168`), saved on every state transition (`save_state`, line 712-714); history deliberately excluded from the pickle — rebuilt by replaying the event stream (`_init_history`, `state_tracker.py:104`). Conversation stats in `conversation_stats.pkl`; LLM registry state in `llm_registry.json`; conversation metadata in `metadata.json`/`init.json`.
- **Resume/fork**: resume = replay events from the store into `state.history` and continue appending (the event log is append-only with `cur_id` monotonic ids). Fork: NOT FOUND as a first-class op in V0 (paper says V1 makes history a *tree* with movable head — V1 claim).
- **Transcript model**: `get_trajectory` produces a serialized trajectory after close (`agent_controller.py:1093`); `--save-trajectory-path` writes `{sid}.json` (`core/main.py:303`).
- **Cross-session memory**: microagents + `~/.openhands` user store; no learned memory.

## 10. Model layer

- **Abstraction**: LiteLLM (`llm/llm.py` wraps `litellm.completion`), like aider — but with a much thicker layer on top. FACT.
- **Retry**: `RetryMixin` + `retry_decorator` with `num_retries`/`retry_min_wait`/`retry_max_wait`/`retry_multiplier` from `LLMConfig` (tenacity-style exp backoff; `LLM_RETRY_EXCEPTIONS` incl. Timeout/InternalServerError/RateLimit; `llm.py:43-49,221-227`).
- **LLMRegistry** (`llm/llm_registry.py`): service-id-keyed LLM instances shared across agents/delegates; `request_extraneous_completion` for side queries (condensers); `subscribe`/`notify` registry events.
- **Router**: `llm/router/` (`rule_based`) — `get_router(agent_config)` can swap the agent's LLM for a routing LLM (`codeact_agent.py:96`).
- **Non-FC fallback**: `fn_call_converter.py` rewrites function-calling requests into text prompt + parses responses back for models without native tool calling (FACT — module exists and is wired through llm config `native_tool_calling` checks).
- **Model features**: `model_features.py` detects vision, prompt-cache support, stop-word quirks per model name; `streaming_llm.py` for streamed variants; `openhands` provider names rewritten to `litellm_proxy/…` (`llm.py:125-128`).
- **Auth/BYOK**: standard LiteLLM env vars + config TOML `llm.api_key`; `LLMRegistry` lets different agents/delegates carry different `LLMConfig`s; `extra_body.metadata` tags calls with session/agent for billing (`codeact_agent.py:214-218`).
- **Metrics**: `Metrics` per LLM accumulated into `state.metrics`, budget flag synced each step (`state_tracker.sync_budget_flag_with_metrics`).

## 11. Notable mechanisms

1. **The EventStream is the entire system** — a persisted pub/sub log where agent, runtime, memory, server, and resolver are symmetric subscribers (`EventStreamSubscriber` enum, `stream.py:23-31`). Every event is durable JSON with monotonic ids, page-cached reads, and secret-scrubbed writes. Debugging = reading the log; replay = re-feeding it. The single most portable idea in this codebase.
2. **Condensation as an action, not a side channel** — the agent itself can emit `CondensationRequestAction`/`CondensationAction`; the controller treats them as ordinary events that re-trigger `step`. History truncation is thus replayable and inspectable like everything else (`codeact_agent.py:196-202`, `agent_controller.py:940-944`).
3. **In-sandbox FastAPI executor** — the action/observation boundary is an HTTP API *inside* the sandbox (`action_execution_server.py`), so `local`, `docker`, `remote`, and `kubernetes` runtimes share one execution contract; MCP servers are mounted inside the same app. Runtime substitution is an address change, not a code change.
4. **Five-heuristic stuck detector** — `stuck.py` codifies loop pathologies (repeat pairs, repeat+error, monologue, ABAB alternation, ctx-error loops) as deterministic detectors over the event history; cheap, no LLM call.
5. **Delegate = child controller on the same stream** — subagents inherit the parent's event stream, metrics, and budget, so delegation is observable end-to-end and budget leaks are impossible by construction (FACT — `start_delegate` passes `self.state.metrics` and `iteration_flag`/`budget_flag` by reference).
6. **Secrets scrubbing at persistence** — `_replace_secrets` rewrites event dicts before disk write, protecting the transcript store rather than hoping prompts don't leak (`stream.py:221-244`).

## 12. Evidence log

- `openhands/controller/agent_controller.py` @7fbb48c (tag 0.62.0) — event-driven loop, confirmation gating, delegates, stuck handling, state machine — accessed 2026-09-15
- `openhands/events/stream.py`, `storage/locations.py`, `controller/state/state.py`, `state_tracker.py` @7fbb48c — event persistence, secret scrubbing, session layout, state pickle — accessed 2026-09-15
- `openhands/agenthub/codeact_agent/codeact_agent.py`, `function_calling.py`, `tools/*.py`, `prompts/system_prompt.j2` @7fbb48c — agent step, tool inventory, prompt composition — accessed 2026-09-15
- `openhands/runtime/base.py`, `runtime/impl/docker/docker_runtime.py`, `runtime/action_execution_server.py` @7fbb48c — runtime abstraction, in-sandbox executor — accessed 2026-09-15
- `openhands/memory/memory.py`, `memory/condenser/**`, `microagent/microagent.py`, `security/options.py`, `mcp/client.py`, `mcp/utils.py`, `llm/llm.py`, `llm/llm_registry.py`, `core/main.py`, `core/loop.py` @7fbb48c — memory/condensers/microagents/security/MCP/LLM layer/entry — accessed 2026-09-15
- OpenHands `main` @23ca81c9 — confirms repo repurposed to Agent Canvas (TypeScript; `@openhands/agent-canvas` package.json, README) — accessed 2026-09-15
- https://arxiv.org/abs/2609.00006 (HTML v1) — §6.2.1 event-sourced engine (V1 SDK details: LocalConversation, EventLog flock locking, SecretRegistry, tree state, ParallelToolExecutor resource locks), §7.2.5 PromptRegistry cache tiers, §9.4 condenser consolidation (10→3), §10.3 V1 analyzers, §11.4 V1 task-tool delegation — accessed 2026-09-15
- Conflicts/gaps: studied V0 (0.62.0), the last Python release in this repo; V1 SDK (software-agent-sdk repo) mechanisms cited only via the paper — flagged V1 where used. `enterprise/` subdir not audited (separate license). Frontend (`frontend/`) and `openhands-ui/` not studied. `loc_agent`/`visualbrowsing_agent` not audited. Exact `cache_size` page value and `num_retries` defaults not read line-by-line (config defaults, not re-verified).
