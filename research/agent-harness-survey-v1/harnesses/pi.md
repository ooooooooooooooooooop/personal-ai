# Pi

> Earendil Works (Mario Zechner / badlogic) · MIT · TypeScript (Node.js, npm-workspace monorepo) · First release 2025
> **Version studied: commit `f9bcd351dc3cedf989bc5fc0f8aa012db5737df2` (2026-09-14), `@mariozechner/pi-coding-agent@0.85.1`, shallow clone accessed 2026-09-15**
> Repo: https://github.com/earendil-works/pi · Docs: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs
> Epistemic basis: SOURCE-READ (cross-referenced against arXiv:2609.00006)

## 1. Positioning & design philosophy

Pi bets on **minimal core, extension-everything**. The agent loop is a small standalone library (`packages/agent`); the product (`packages/coding-agent`) layers tools, sessions, prompts, and a Textual TUI on top, and deliberately pushes nearly all policy to userland: extensions are in-process TypeScript modules that can register tools, commands, providers, renderers, and intercept every lifecycle event. Two deliberate rejections stand out: **no MCP** (docs argue CLI tools with READMEs are a better integration model than a protocol shim) and **no in-process sandbox** (security.md: a partial sandbox "would be easy to misunderstand as a security boundary" — real isolation belongs to the OS/container). Where OpenCode is a platform-server and Vibe an opinionated product, Pi is a *harness construction kit* that happens to ship a good CLI. [FACT for code structure + docs; INFERENCE for design-intent framing]

## 2. Architecture overview

- **Monorepo** (`packages/`): `agent` (the loop library), `coding-agent` (CLI product: tools, sessions, extensions, TUI wiring), `ai` (provider/model abstraction + OAuth), `tui` (terminal UI toolkit), plus `protocol`, `server`, `client`, `chord`, `session-backends/sqlite-node`, `evals`, `telemetry`. (src: `packages/` listing @ f9bcd351)
- **Layering**: `pi-agent-core` (`packages/agent`) knows nothing about coding tools — it is a generic loop over `AgentTool`s emitting an event stream; `coding-agent` supplies tools, system prompt, session format, and the extension host. The same loop is meant to be embedded by other programs. (src: `packages/agent/src/agent-loop.ts`, `agent.ts`; `packages/coding-agent/src/core/` @ f9bcd351)
- **Entry points**: `pi` CLI (`coding-agent/src/main.ts`) with modes `interactive` (TUI), `print` (`-p`), `json`, and `rpc` (JSONL stdin/stdout command channel); programmatic use via the agent/coding-agent packages and `docs/sdk.md`. [FACT]

## 3. Agent loop

- **Functional core**: `agentLoop()`/`runAgentLoop()` (`packages/agent/src/agent-loop.ts`) append the prompt to the context, emit lifecycle events, and hand off to `runLoop`, which streams one provider turn, collects tool calls, executes them, and repeats while the last message is tool results. There is **no planner, reflection stage, turn cap, or stuck-detector in the core** (paper finding; confirmed by the small loop surface). [FACT + paper cross-ref]
- **Event-stream orientation**: the loop yields typed events (turn/message/tool_execution start/update/end); tool arguments are prepared and schema-validated before execution; `beforeToolCall` may mutate args or block with a reason; tool results flow through `afterToolCall`; a tool batch ends early if all results set `terminate: true`. (src: `packages/agent/src/agent-loop.ts` @ f9bcd351)
- **Concurrency**: tool calls in one assistant message execute **concurrently by default** (per-call `beforeToolCall` gates still apply); incremental `tool_execution_update` events let tools stream partial output. [FACT]
- **Steering & queues** (`packages/agent/src/agent.ts`): the `Agent` class owns mutable state (messages, tools, model, streaming state, pending tool calls, error) plus two input channels — `steer()` (interrupt-biased mid-run guidance) and a follow-up queue — plus hooks `shouldStopAfterTurn`, `prepareNextTurn`, `prepareNextTurnWithContext`. Errors never escape silently: failures and aborts are converted into assistant messages with `stopReason: "error"|"aborted"` so the transcript stays well-formed. [FACT]
- **Retry**: `packages/ai/src/utils/retry.ts` — `retryAssistantCall` with exponential `retryDelayMs` (base delay ×2^attempt, capped `DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000`) and `isRetryableAssistantError` over provider errors on the assistant message. [FACT]

## 4. Tool system

- **Inventory** (`core/tools/index.ts`): eight built-ins — `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`. Two curated bundles: `createCodingTools` = read+bash+edit+write; `createReadOnlyTools` = read+grep+find+ls. Each tool has both a `create*Tool` (executable) and `create*ToolDefinition` (schema+description only) constructor — the same definitions feed the extension/tool system. [FACT]
- **Pluggable execution backends**: every tool takes an `*Operations` interface (`ReadOperations`, `BashOperations`, `EditOperations`, …) and `createLocal*Operations` is just the default — tool execution can be remoted (SSH/container/custom env) without forking; `BashSpawnContext`/`BashSpawnHook` wrap process spawn. This is the "remote execution seam" noted in the paper. (src: `core/tools/index.ts:1-91`, `docs/containerization.md` @ f9bcd351)
- **Edit mechanism** (`core/tools/edit.ts` + `edit-diff.ts` + `file-mutation-queue.ts`): input is `{path, edits[]}` — a batch of exact `oldText`→`newText` pairs checked against the *original* content (not incrementally applied); rejects empty `oldText`, duplicate matches, and overlapping edits. Fallback chain: exact match → normalization-based fuzzy match (line endings, trailing whitespace, Unicode quote/dash normalization, special spaces); on fuzzy hit, unchanged line blocks are overlaid from the original to preserve bytes; writes preserve BOM and the file's line-ending style; returns a display diff + unified patch. Same-file mutations serialize through a queue keyed by resolved realpath; different files proceed in parallel. [FACT]
- **Output handling**: `truncate.ts` (`truncateHead`/`truncateTail`/`truncateLine`, `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`) shared by tools. [FACT]
- **MCP**: **none** — Pi deliberately ships no MCP client; the documented extension philosophy favors CLI tools + READMEs and in-process extension tools (docs/extensions.md). [FACT — absence confirmed in source + docs]

## 5. Context management

- **System prompt** (`core/system-prompt.ts`, ~168 lines): identity → tool section (only tools with supplied snippets are listed) → tool-dependent exploration guidance → configured guidelines → always-on concise-response/file-path rules → Pi docs paths → `<project_context>` (context files) → skills (only when `read` or `bash` is present) → cwd. A custom system prompt *replaces* the default but still gets project-context/skills/cwd appended. The paper's characterization — a small builder whose content co-varies with the active toolset — matches. [FACT]
- **Instruction files**: `AGENTS.md`/`CLAUDE.md` loaded regardless of project trust (context is not a privileged resource); `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` are trust-gated. (src: `docs/security.md` @ f9bcd351)
- **Compaction** (`core/compaction/compaction.ts`): triggers when context exceeds `contextWindow - reserveTokens` (defaults `reserveTokens: 16384`, `keepRecentTokens: 20000`); token accounting prefers provider-reported usage, estimates trailing messages; summaries recursively merge the prior summary and track `readFiles`/`modifiedFiles` for the handoff; the `session_before_compact` extension event can veto or fully customize the compaction (custom instructions, replacement prompt). Branch summarization exists for session-tree navigation (`branch-summarization.ts`). [FACT]
- **Retrieval**: grep/find/ls/read only; no embeddings or vector index — consistent with the paper's corpus-wide finding. [FACT]

## 6. Safety model

- **Deliberately no sandbox**: `docs/security.md` — built-in tools run with the invoking user's permissions; extensions are in-process TS with the same rights; prompt injection from repo content is called out as expected local-agent risk. The stated boundary is OS/container-level isolation; `containerization.md` documents running pi inside containers or routing built-in tool execution into a micro-VM (Gondolin). [FACT — doc + absence of sandbox code]
- **Project trust** (`core/project-trust.ts`): project-local settings/resources/extensions/skills/prompts/themes/`.pi/SYSTEM.md`/`APPEND_SYSTEM.md` and package installs require trust; bare `.pi/` doesn't count; saved decisions live in `~/.pi/agent/trust.json` keyed by canonical dir (parent-dir decisions inherit); `defaultProjectTrust` ∈ ask|always|never governs unset cases; non-interactive modes never prompt — `ask`/`never` resolve untrusted, `always` trusts; `--approve`/`--no-approve` override per run; the `project_trust` extension event can own the decision. [FACT]
- **Tool-call gating**: extension `tool_call` event and the loop's `beforeToolCall` can block or rewrite any call before execution — safety policy is extension-defined rather than a fixed permission matrix (contrast OpenCode/Vibe). [FACT]
- **Audit**: append-only session log + session tree gives a durable audit trail; there is no approval-mode ladder in the core. [FACT]

## 7. Orchestration

- **Steering model**: `Agent.steer()` (mid-run steering queue) + follow-up queue + `shouldStopAfterTurn`/`prepareNextTurn` hooks — orchestration primitives live in the agent object rather than a planner process. (src: `packages/agent/src/agent.ts` @ f9bcd351)
- **Session tree**: fork/clone/`session_before_fork`/`session_before_tree` events and `/tree` navigation — branching is a first-class session-tree operation over parent-linked entries (see §9). [FACT]
- **Subagents**: no built-in `task`/subagent tool in `core/tools`; sub-agent patterns are built via extensions (sessions can be created/switched/forked through `ctx.sessionManager` and `newSession`/`fork`/`switchSession` APIs). [FACT — absence in tool registry; extension API surface in `core/extensions/types.ts`]
- **Surfaces**: TUI (interactive), `print` (`-p`, text or `--mode json` event stream), `--mode rpc` (JSONL command channel: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, …; strict LF-delimited framing, optional request `id`s); `packages/server` + `client` for remote operation; SDK per `docs/sdk.md`. (src: `coding-agent/src/main.ts:112-125`, `docs/rpc.md` @ f9bcd351)

## 8. Extensibility

- **Extension host** (`core/extensions/`): extensions are TS/JS modules loaded via `jiti` (so TypeScript works without a build step); each exports a factory receiving `ExtensionAPI`. Discovery: `.pi/extensions` (project, trust-gated), global agent dir, configured paths, direct `.ts`/`.js` files, subdirectories with `index.ts|js`, and package manifests declaring a `pi` field — deliberately **one directory level deep** unless a manifest declares entrypoints. Loading is **transactional**: registrations are staged and committed only if the factory succeeds. Bundled/compiled builds resolve imports through virtual module aliases. (src: `core/extensions/loader.ts`, `runner.ts`, `types.ts`; `docs/extensions.md` @ f9bcd351)
- **API surface**: `registerTool`, `registerCommand` (slash commands), `registerFlag`, `registerShortcut`, message/entry renderers, custom providers, header/footer/editor UI components (`ctx.ui`), `sendMessage`/`appendEntry` for custom session entries, `ctx.compact()`, `ctx.getContextUsage()`, `ctx.getSystemPrompt()`, `ctx.sessionManager` (newSession/fork/switchSession), `ctx.modelRegistry`/`model`/`scopedModels` incl. streaming model calls. [FACT]
- **Event surface** (~40 events): `project_trust`, `resources_discover`, `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`/`session_compact`/`session_compact_failed`, `session_before_tree`/`session_tree`, `session_shutdown`, `before_agent_start`, `agent_start`/`agent_end`/`agent_settled`, `ui_prompt_start`/`end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`update`/`end`, `context`, `before_provider_headers`, `before_provider_request`, `after_provider_response`, `model_select`, `thinking_level_select`, `tool_call`, `tool_result`, `user_bash`, `input`. (src: `core/extensions/types.ts:1257+`, `docs/extensions.md` @ f9bcd351)
- **Packages** (`core/package-manager.ts`, `docs/packages.md`): `pi install` accepts `npm:` specs (pinned versions skip updates; `npmCommand` can route through mise/asdf), `git:`/protocol URLs (SSH-supported, `@ref` pinned; clones under `~/.pi/agent/git/<host>/<path>` or `.pi/git/`, reconciled+`npm install` on update), and local paths. A package is a `package.json` with a `pi` manifest (`extensions`/`skills`/`prompts`/`themes` arrays w/ globs+`!exclusions`) or convention directories; `pi-package` keyword for gallery discoverability; project (`.pi/npm`) vs global (`~/.pi/agent/npm`) scope. [FACT]
- **Skills/prompts/themes**: `SKILL.md`-style skills, prompt templates, and themes discovered via the same package/resource machinery (`collectSkillEntries`, `collectAutoPromptEntries`, `collectAutoThemeEntries` in package-manager.ts). [FACT]

## 9. Session & state

- **Format** (`core/session-manager.ts`, format v3): append-only **JSONL**; header `{id, timestamp, cwd, version, parentSession?}`; every entry has `{id, parentId, timestamp, payload}` — entries form a **linked tree** and a movable leaf pointer marks the active branch; context reconstruction walks parent links from the leaf. Entry types: messages, thinking-level/model changes, compaction summaries, branch summaries, custom entries, custom messages, labels, session info. `custom` entries persist extension state *without* entering model context; `custom message` entries *do* enter context. (src: `core/session-manager.ts`; `docs/session-format.md` @ f9bcd351)
- **Branching**: `/tree`, fork, clone, `session_before_tree`/`session_tree` events operate over this tree; compaction writes a summary entry + retained tail rather than mutating history. [FACT]
- **Location**: session dirs derived from cwd under the pi agent dir (`~/.pi/agent` by default); `.jsonl` files can be passed directly (`-session <path>`). An alternative **SQLite session backend** exists in `packages/session-backends/sqlite-node` (repo + migrations + benchmarks) — the tree model is backend-agnostic. [FACT]
- **Rewind**: the tree is the rewind mechanism — branch to any earlier entry; filesystem state is *not* snapshotted (contrast OpenCode's shadow git and Vibe's Checkpointer). [FACT]

## 10. Model layer

- **`packages/ai`** is a first-party provider stack: `api/` holds wire-format implementations — anthropic-messages, openai-completions, openai-responses (+shared/prompt-cache), openai-codex-responses (incl. WebSocket), azure-openai-responses, google-generative-ai/google-shared, google-vertex, bedrock-converse-stream, mistral-conversations, pi-messages, cloudflare — each with a `.lazy.ts` deferred-loading twin. (src: `packages/ai/src/api/` @ f9bcd351)
- **Provider catalog**: ~35 provider modules (`providers/*.ts` + `*.models.ts`): anthropic, openai, openai-codex, google, google-vertex, azure-openai-responses, amazon-bedrock, mistral, groq, deepseek, xai, openrouter, github-copilot, kimi-coding, moonshotai(+cn), minimax(+cn), zai(+coding-cn), qwen-token-plan(+individual+cn), xiaomi(+cn/ams/sgp), nvidia, huggingface, baseten, cerebras, together, fireworks, ant-ling, cloudflare-workers-ai(+ai-gateway), vercel-ai-gateway, opencode, opencode-go, radius — aggregated by the generated `models.generated.ts` (`scripts/generate-models.ts`; never edited by hand per AGENTS.md). [FACT]
- **Auth**: `auth/` — credential-store + per-provider OAuth modules (anthropic, github-copilot, kimi-coding, openai-codex, openrouter, xai, device-code, pkce, oauth-page); env-API-key resolution (`env-api-keys.ts`). [FACT]
- **Resolution** (`core/model-registry.ts`, `model-resolver.ts`, `model-config.ts`): `ModelRegistry` merges the generated catalog with user `models.json` custom providers (`baseUrl`, `apiKey`, `api` wire-format, per-model entries, `allow_fallbacks`); `model-resolver` parses `provider/model:thinkingLevel` patterns (e.g. `zai-org/GLM-5.1-FP8:high`) and reports fallback warnings. BYOK is a config file, not a plugin. [FACT]
- **Test seam**: `providers/faux.ts` — a fake provider used by the test harness (`test/suite/harness.ts`); no real API calls in tests. [FACT]

## 11. Notable mechanisms

1. **Byte-preserving fuzzy edit** — when normalized matching rescues a failed exact match, unchanged line blocks are overlaid from the original content so a fuzzy edit can't silently reformat the rest of the file; multi-edit batches are checked against the *original* content with overlap rejection, and same-file writes serialize on a realpath-keyed queue. (`core/tools/edit.ts`, `edit-diff.ts`, `file-mutation-queue.ts`)
2. **Transactional extension loading** — extension factories stage registrations that commit only on success; `jiti` runs raw TS; virtual module aliases let compiled binaries resolve bundled modules; discovery is deliberately shallow (one level) unless a package manifest declares entrypoints. (`core/extensions/loader.ts`)
3. **Session-as-tree** — every entry carries `parentId`; a leaf pointer picks the live branch; compaction, branching, custom extension state, and `/tree` navigation all ride one append-only JSONL structure. (`core/session-manager.ts`, `docs/session-format.md`)
4. **Tool definitions vs. executions split** — every tool exposes `create*ToolDefinition` (schema/description for the model) separately from `create*Tool` (execution through an `*Operations` backend), so the same tool surface can run against a local FS, SSH, or a micro-VM unchanged. (`core/tools/index.ts`)
5. **Steering channels** — `steer()` vs. follow-up queue vs. `shouldStopAfterTurn`/`prepareNextTurn` gives mid-run course correction without a planner; errors are folded into the transcript as `stopReason` messages instead of thrown away. (`packages/agent/src/agent.ts`)

## 12. Evidence log

- `pi/` @ `f9bcd351dc3cedf989bc5fc0f8aa012db5737df2` — all FACT claims (paths cited inline) — accessed 2026-09-15
  - `packages/agent/src/agent-loop.ts`, `agent.ts` — functional loop, steering/follow-up queues, lifecycle events
  - `packages/coding-agent/src/core/tools/{index,read,bash,powershell,edit,edit-diff,file-mutation-queue,grep,find,ls,write,truncate}.ts` — tool system
  - `packages/coding-agent/src/core/system-prompt.ts` — prompt builder; `core/compaction/{compaction,branch-summarization}.ts` — compaction
  - `packages/coding-agent/src/core/{session-manager,project-trust,package-manager,model-registry,model-resolver,model-config}.ts` — sessions, trust, packages, model resolution
  - `packages/coding-agent/src/core/extensions/{loader,runner,types}.ts` — extension host/API
  - `packages/coding-agent/src/main.ts`, `docs/{extensions,packages,rpc,session-format,security,containerization,skills,custom-provider,sdk}.md` — modes, RPC, package sources, security posture
  - `packages/ai/src/{api,providers,auth,utils/retry.ts,models.generated.ts}` — model layer
  - `packages/session-backends/sqlite-node/` — alternative session backend
- https://arxiv.org/abs/2609.00006 (*Harness Engineering*, §Pi) — functional-core/steering-queue characterization, toolset-covariant prompt, no planner/turn-cap finding, MCP-holdout framing — accessed 2026-09-15
- **Conflicts / gaps / unverified**:
  - `packages/server`, `client`, `chord`, `protocol` (remote/collab surfaces) were listed but not line-audited.
  - The `session-backends/sqlite-node` backend's wiring (when it is selected vs. JSONL) was not fully traced.
  - Extension `tool_call`-hook argument-mutation details were verified at type level (`types.ts`), not through the runner's commit path line-by-line.
  - No built-in approval/permission ladder was found; if the TUI implements UI-level confirms outside the inspected core files, that layer was not audited.
