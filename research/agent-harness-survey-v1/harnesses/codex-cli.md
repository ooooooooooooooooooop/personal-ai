# Codex CLI

> OpenAI · Apache-2.0 · Rust (monorepo `codex-rs`, plus a TypeScript SDK crate) · First release ~2025-04
> **Version studied: commit `4e6450bbfd60bdfa845182f30aaa9d6f068e8bbd`, shallow clone accessed 2026-09-15**
> Repo: https://github.com/openai/codex · Docs: https://developers.openai.com/codex/cli
> Epistemic basis: SOURCE-READ (cross-referenced against arXiv:2609.00006)

## 1. Positioning & design philosophy

Codex CLI bets on **execution fidelity and policy rigor over configurability breadth**. Where most harnesses treat the shell as one generic tool, Codex builds a bespoke execution substrate: a Starlark-style rule engine (`execpolicy`) that statically classifies commands before they run, a pluggable OS sandbox per platform (Landlock/Bubblewrap on Linux, Seatbelt on macOS, restricted tokens on Windows), a custom `*** Begin Patch` edit DSL parsed by a dedicated crate, and per-model prompt/capability manifests shipped as data (`models-manager/models.json`) so harness behavior tracks each model's abilities rather than being hard-coded. The design reads as "the harness is the security boundary": the model proposes, the Rust core disposes. [INFERENCE — drawn from the centrality of `execpolicy`, `sandboxing`, and the orchestrator in the call graph]

## 2. Architecture overview

- **Process model**: a single Rust workspace (`codex-rs/`) of ~50 crates. The CLI binary (`cli/src/main.rs`) launches an async Tokio runtime; the core session lives in `core/src/session/` and `core/src/tasks/`. [FACT]
- **Major modules** (crate → role): `core` (session, turn engine, tools, agents, hooks, guardian), `protocol` (`protocol/src/protocol.rs`, the shared event/request types), `execpolicy` (command policy engine), `sandboxing` + `linux-sandbox` (OS sandbox backends), `apply-patch` (edit DSL parser), `rollout` (session persistence), `models-manager` (model manifest + per-model prompts), `hooks`, `skills`, `plugin`, `app-server` (remote control surface), `mcp-*` (MCP client). [FACT — crate layout]
- **Entry points**: `cli` (interactive TUI + subcommands), `exec` (non-interactive), `app-server` (JSON-RPC control plane), plus `resume`, `fork`, `queue`, `review`, `cloud` commands. [FACT — `cli/src/main.rs`]
- **Agent loop location**: `core/src/tasks/regular.rs` (`RegularTask::run`, line ~38) driving `run_turn` in `core/src/session/turn.rs` (line ~163). [FACT]

## 3. Agent loop

- **Turn structure**: `RegularTask::run` (`tasks/regular.rs:38-76`) runs `run_turn` in a `loop`, draining pending user input between turns so a message typed mid-turn becomes the next turn's input rather than being lost. [FACT]
- `run_turn` (`session/turn.rs:163`) owns the full cycle: pre-sampling compaction check (line ~1252 notes "Pre-turn compaction runs before run_turn creates the normal sampling step"), context build, sampling request, streaming response collection, tool execution, and follow-up decision. [FACT]
- **Concurrency**: responses stream as `ResponseEvent`s; parallel tool calls within a response are executed via `FuturesOrdered` (imported at `turn.rs:129`) so results return in call order while running concurrently. [FACT]
- **Stopping conditions**: a turn rolls over only when `needs_follow_up` is set — computed at `turn.rs:565` as `model_needs_follow_up || has_pending_input` — or a `Stop` hook requests continuation (`run_turn_stop_hooks`, `turn.rs:24`, ~644). Otherwise the task completes. `should_roll_over` at `turn.rs:600` decides whether the loop iterates. [FACT]
- **Retry/recovery**: retryable stream errors retry per provider-specific limits; `CodexErrorDetails::TurnAborted` (`turn.rs:200,268,627,740`) is the cancellation path — an aborted turn surfaces `TurnAborted` rather than a generic error. Context-window overflow triggers automatic compaction then resamples. [FACT + INFERENCE on compaction trigger ordering]
- **Planning mechanism**: a dedicated `update_plan` tool (spec in `tools/spec_plan.rs`) plus a plan/task-tracker surface; no mandatory plan phase — planning is a tool the model may call, not a loop stage. [FACT]
- **Max-turn guards**: no hardcoded global max-turn constant was located in `regular.rs`/`turn.rs`; termination is convergence-based (no follow-up + no pending input), bounded by user cancellation and hook decisions. [INFERENCE — searched `tasks/`, `session/turn.rs`]

## 4. Tool system

- **Registry**: `core/src/tools/registry.rs` holds trait-object handlers each with a `ToolExposure` level (`Direct`, `Deferred`, `Hidden`, `DirectModelOnly` — re-exported from `codex_tools` at `registry.rs:49`). `tool_exposure` (`registry.rs:473`) resolves per-tool visibility; parallel-capable tools report `supports_parallel_tool_calls()` (`registry.rs:488`). Exposure is conditioned on feature flags, model capabilities, provider, session source, and mode. [FACT]
- **Built-in inventory** (from `tools/spec_plan.rs` + handler modules under `tools/handlers/`): unified shell execution (`shell`/`unified_exec`), `write_stdin`, `apply_patch`, view_image, update_plan, get current time, sleep, context-remaining probe, MCP resource tools, plugin install, user-input/request tools, messaging, environment wait, web search, multi-agent spawn tools, code mode, dynamic/extension tools. [FACT]
- **Edit/patch mechanism**: a custom DSL — `*** Begin Patch` … `*** End Patch` with `Add File`/`Update File`/`Delete File` blocks — parsed by the standalone `apply-patch` crate (`apply-patch/src/parser.rs`). This is not unified diff; it is a model-friendly grammar designed to be reliably emitted and verified. [FACT]
- **Tool-result handling**: outputs flow through the orchestrator (`tools/orchestrator.rs`) which records them back into history; large outputs are bounded by context bookkeeping (token accounting in `context/`). Exact truncation limits were not exhaustively verified. [MIXED — orchestration FACT, limits partially verified]
- **MCP**: first-class MCP client crates; MCP tools register through the same registry and may start `Deferred` (loaded on demand rather than all upfront — a "tool search" mechanism indexed deferred tools). [FACT]
- **Per-tool gating**: approval requirement, sandbox requirement, and network requirement are all per-tool-call inputs to the orchestrator, not global flags. [FACT — `orchestrator.rs:4-26` imports approval/network/sandbox modules]

## 5. Context management

- **System prompt composition**: `core/src/context/` assembles the request from base instructions (`context/base_instructions.rs`), per-model `model_messages.instructions_template` from `models-manager/models.json`, environment info, discovered instruction files, tool specs, and the conversation. Prompts are **model data, not code**: each model's manifest entry carries its own instruction template, tool-mode, shell type, and capability flags, so updating `models.json` (delivered via models-manager, which can fetch updated manifests) re-tunes the prompt without a code release. [FACT]
- **Instruction files**: `core/src/agents_md.rs` implements hierarchical `AGENTS.md` discovery — files are collected from the working directory upward and merged into context. [FACT]
- **Compaction**: `core/src/compact.rs` plus `prompts/templates/compact/` implement summarization. Compaction runs *before* sampling when token pressure is predicted (`turn.rs:1252` comment), not only after overflow errors; there is also a remote/server-side compaction path in the rollout crate (`rollout/src/compression.rs`). [FACT]
- **Retrieval**: grep/glob-style tools only — consistent with arXiv:2609.00006's cross-system finding that none of the eleven audited harnesses, including Codex, uses vector-embedding retrieval for code. [VENDOR-NEUTRAL — paper claim, consistent with absence of embedding code in `tools/`]

## 6. Safety model

- **Approval modes** (`protocol/src/protocol.rs:985-1007`): `UnlessTrusted` (prompt unless trusted/command allowlisted), `OnRequest` (model requests escalation), `Granular(GranularApprovalConfig)` (per-category config, ~line 1003/1011), `Never` (fail-closed, "failures are immediately returned"). [FACT]
- **Sandbox policies** (`protocol.rs:1071-1097`): `DangerFullAccess`, `ReadOnly` (with optional network), `ExternalSandbox` (defer to an outer sandbox), `WorkspaceWrite` (read + workspace-scoped writes; network access separately gated — `protocol.rs:1204-1229` maps policies to capabilities). [FACT]
- **Execution policy engine**: `execpolicy/` evaluates every shell command against Starlark-style rules — `prefix_rule(pattern=[...], decision?, justification?, match?, not_match?)` where decision ∈ `allow | prompt | forbidden` (defaults `allow`); `match`/`not_match` examples are validated when the policy loads (`execpolicy/README.md:5-8,17-19`). `host_executable` rules control basename fallback for absolute paths (`README.md:43-44`). [FACT]
- **Orchestration of a single call**: `tools/orchestrator.rs:4-6` documents the pipeline — *approval → select sandbox → attempt → retry with an escalated sandbox strategy on denial (no re-approval)* — with dedicated modules for network approval (`tools/network_approval`), deferred approvals, and sandbox attempts (`tools/sandboxing`). [FACT]
- **OS sandboxes**: Linux via Bubblewrap + Landlock-related code (`linux-sandbox/`), macOS Seatbelt, Windows restricted-token paths (`sandboxing/`). [FACT — crate contents]
- **Guardian**: `core/src/guardian/` is an isolated synchronous LLM reviewer for approval decisions — "Hosts approval decisions and the isolated synchronous reviewer" (`guardian/mod.rs:1-3`) with request/input budget checks (`check_guardian_prompt_budget`, `check_pending_guardian_input`). arXiv:2609.00006 reports it fails closed when review output is invalid or unavailable. [FACT for existence; paper claim for fail-closed]
- **Destructive-op guards**: `forbidden` execpolicy decisions are absolute (no prompt possible); deny rules can remove a tool's visibility entirely. [FACT]

## 7. Orchestration

- **Thread-tree model**: `core/src/agent/` implements an agent registry with spawn-depth tracking; sessions form a tree — a parent can fork a child with full or reduced history, and parent↔child communication rides the same session input queue used for user input. [FACT, consistent with paper's "thread-tree" description]
- **Multi-agent tools**: `tools/handlers/multi_agents*` expose spawn/communicate primitives as model-callable tools, so the model (not just the user) initiates subagents. [FACT]
- **Surfaces**: interactive TUI (`cli`), non-interactive `exec`, `review` mode, `app-server` JSON-RPC control plane for IDE/remote clients, `cloud` for hosted runs, `resume`/`fork`/`queue` session operations. [FACT — `cli/src/main.rs` subcommands]
- **Headless/SDK**: `codex exec` is the CI path; a TypeScript SDK package in the monorepo wraps the core. [FACT — repo layout]
- **Wire protocol**: `protocol/` crate defines the typed event envelope shared between core, TUI, and app-server (JSON-RPC over stdio for app-server). [FACT]

## 8. Extensibility

- **Hooks**: `hooks/` crate fires lifecycle events — `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `Interrupt` — wired into the turn loop (e.g., `run_turn_stop_hooks` at `turn.rs:644`). [FACT]
- **Skills**: `skills/` crate loads Markdown skills (SKILL.md-style) into the session. [FACT — crate exists; format follows the agentskills convention]
- **Plugins**: `plugin/` crate + a `plugin install` tool spec — plugins can ship skills/agents/MCP config. [FACT]
- **MCP**: external tools via MCP servers, registered through the tool registry (often `Deferred`). [FACT]
- **Exec policy**: users extend safety by writing their own `.policy` rule files — an unusual "safety as user-editable config" surface. [FACT — `execpolicy/README.md`]
- **Custom prompts/personas**: per-model instruction templates are data (`models.json`), and `AGENTS.md` is user-editable context. [FACT]

## 9. Session & state

- **Persistence**: `rollout/` crate writes sessions as JSONL "rollout" files with canonical filenames (`rollout/src/rollout_file_name.rs`), decoded by `decode_rollout_line`/`parse_rollout_line` (`lib.rs:50-76`). Each record carries distinct thread vs. rollout IDs so reverted/forked histories coexist without collision. [FACT]
- **Resume/fork**: `codex resume`, `codex fork`, archive/delete/queue commands operate on the rollout store; `session_index.rs`, `reverse_jsonl_scanner.rs` (tail-first reading of large rollouts), and `state_db.rs`/`sqlite_metrics.rs` provide indexing. [FACT]
- **Transcript model**: an append-only event log — every input, response item, tool call/result, and compaction boundary is a JSONL line; resume replays the log to rebuild context. [FACT — recorder.rs + decoder]
- **Checkpoints/rewind**: fork-from-anywhere plus distinct rollout IDs gives rewind semantics without mutating history. [INFERENCE from fork + dual IDs]

## 10. Model layer

- **Provider abstraction**: `core/src/client_common.rs` + provider-specific clients; the OpenAI Responses API is primary, with a "Responses Lite" capability flag for providers supporting a reduced surface. [FACT]
- **Model manifest**: `models-manager/models.json` is the single source of per-model truth — instruction template, context limit, tool mode, shell type, supported features (parallel tool calls, web search, code mode, multi-agent version). The manager can refresh manifests, so model support updates ship as data. [FACT]
- **Auth**: OpenAI sign-in / API key; providers selectable via config. Enterprise deployments route through configured providers. [FACT — client_common + config]
- **Routing/fallback**: model choice is explicit per session; retry logic is per-provider. No automatic cross-model fallback was verified. [MIXED — searched `client_common.rs`, models-manager]

## 11. Notable mechanisms

1. **Execpolicy as a pre-execution static analyzer** — commands are classified `allow/prompt/forbidden` by pattern rules *before* the approval prompt or sandbox decision, with self-validating `match`/`not_match` examples; the policy file is user-editable, making the safety boundary auditable config rather than prompt text. (`execpolicy/`) [FACT]
2. **Escalation-without-reapproval retry** — the orchestrator retries a denied sandbox attempt with an escalated strategy without re-asking the user, collapsing the "approve → sandbox fails → approve again" loop other harnesses suffer. (`orchestrator.rs:4-6`) [FACT]
3. **Prompts-as-data per model** — `models.json` carries instruction templates and capability flags per model; harness behavior follows the model manifest and can be updated out-of-band. (`models-manager/`) [FACT]
4. **Guardian reviewer** — an isolated synchronous LLM pass arbitrates selected approval requests with bounded input budgets, separate from the conversation model. (`core/src/guardian/`) [FACT]
5. **Dual-ID rollout log** — thread ID vs. rollout ID lets forks and reverts share a store without rewriting history; `reverse_jsonl_scanner` reads huge logs tail-first for fast resume listing. (`rollout/`) [FACT]

## 12. Evidence log

- `codex-rs/` @ `4e6450bbfd60bdfa845182f30aaa9d6f068e8bbd` — all FACT-tagged source claims (paths cited inline) — accessed 2026-09-15
  - `core/src/tasks/regular.rs:38-76`, `core/src/session/turn.rs:129,163,200,565,600,644,1252` — agent loop
  - `core/src/tools/registry.rs:49,283,311,473,488`, `core/src/tools/spec_plan.rs`, `core/src/tools/orchestrator.rs:4-26`, `core/src/tools/handlers/` — tool system
  - `protocol/src/protocol.rs:985-1229` — approval modes + sandbox policies
  - `execpolicy/README.md:5-88`, `execpolicy/src/` — policy engine
  - `core/src/guardian/mod.rs:1-46` — guardian reviewer
  - `rollout/src/lib.rs:50-76`, `rollout_file_name.rs`, `reverse_jsonl_scanner.rs`, `session_index.rs` — persistence
  - `core/src/agents_md.rs`, `core/src/compact.rs`, `models-manager/models.json`, `core/src/context/` — context layer
  - `hooks/src/`, `skills/src/`, `plugin/`, `app-server/`, `cli/src/main.rs` — extensibility + surfaces
- https://arxiv.org/abs/2609.00006 (*Harness Engineering*, §Codex) — cross-reference for Tokio state machine, thread-tree orchestration, Guardian fail-closed behavior, no-embeddings finding — accessed 2026-09-15
- **Conflicts / gaps / unverified**:
  - No hardcoded global max-turn limit located; termination appears convergence-based — an INFERENCE, not confirmed absence.
  - Exact tool-output truncation thresholds not fully verified in `context/` token accounting.
  - `code mode` and `dynamic/extension tools` specs seen in the registry but not deeply audited.
  - Windows sandbox implementation present in `sandboxing/` but internals not line-verified.
