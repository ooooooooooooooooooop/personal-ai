# Gemini CLI

> Google · Apache-2.0 · TypeScript/Node.js (npm workspace monorepo) · First release 2025-06
> **Version studied: commit `9c1b0a610534d6f8120964cf2672c07807d8fc90`, shallow clone accessed 2026-09-15**
> Repo: https://github.com/google-gemini/gemini-cli · Docs: https://geminicli.com/docs/
> Epistemic basis: SOURCE-READ (cross-referenced against arXiv:2609.00006)

## 1. Positioning & design philosophy

Gemini CLI bets on **openness as the product**: Apache-2.0 source, a permissive-by-default free tier (Google-account login), and an extension surface broad enough that the harness reads as a platform — extensions contribute MCP servers, context files, tools exclusions, hooks, skills, agents, policies, and themes through one manifest. Its distinctive engineering investment is *durability under failure*: a scheduler that runs every tool call through explicit validating→executing→completed/errored phases, hybrid loop detection (pattern matching plus an LLM "diagnostic agent"), and chat compression with structurally safe split points. Compared with Codex's "harness as security boundary," Gemini CLI is "harness as extensible host" — policy is real but the center of gravity is orchestration breadth. [INFERENCE — drawn from the extension-manager surface and the scheduler/loop-detection services]

## 2. Architecture overview

- **Process model**: Node.js monorepo; `packages/core` is the engine (model client, tools, scheduler, context, policy, sandbox), `packages/cli` is the terminal app (React/Ink UI, commands, extension manager, auth UX), plus `packages/a2a-server` (Agent-to-Agent protocol server) and test/adapter packages. [FACT — repo layout]
- **Entry points**: `packages/cli` binary; programmatic use via `@google/gemini-cli-core`; `a2a-server` exposes the agent over the A2A wire protocol. [FACT]
- **Agent loop location**: `packages/core/src/core/geminiChat.ts` — `GeminiChat` (line ~372) with `sendMessageStream` (line ~480); per-turn driver `turn.ts`; tool execution pipeline in `core/scheduler/`; compression in `context/chatCompressionService.ts`; loop detection in `services/loopDetectionService.ts`. [FACT]

## 3. Agent loop

- **Turn structure**: `GeminiChat.sendMessageStream` (`geminiChat.ts:480`) is an async generator: it appends the user message to durable history, streams model chunks, collects function calls, dispatches them through the scheduler, then appends tool responses back to history *durably* (preserving call IDs and linear ordering) before the next model request. [FACT]
- **Scheduler phases**: each tool call moves through validating → executing → completed/errored (`core/scheduler/`), so confirmation policy, argument validation, and execution are separate stages with their own error surfaces. [FACT]
- **Stopping conditions**: a turn ends when the model returns a response with no function calls; `complete-task`/`enter-plan-mode`/`exit-plan-mode` are tools, so plan mode and task completion are model-callable transitions rather than loop stages. [FACT — `tools/` listing]
- **Retry/recovery**: `sendMessageStream` distinguishes invalid-stream/invalid-content errors from connection and transient API errors with different retry handling; retries preserve history durability so a retried chunk doesn't duplicate tool responses. [FACT — geminiChat.ts retry paths]
- **Loop detection**: `services/loopDetectionService.ts` combines cheap pattern checks with an **LLM-based diagnostic check** — a dedicated system prompt (`LOOP_DETECTION_SYSTEM_PROMPT`, line ~68) asks a model to judge "stuck in an unproductive loop," looking for ≥5 consecutive identical model actions, alternating cycles with no net effect (e.g., edit→build→edit→build with the same error), while explicitly exempting productive repetition (different files, different errors, batch operations). Intervals are adaptive: high loop confidence shortens the check interval (min/max interval constants, lines ~45-63), and a `loop-detection-double-check` model alias confirms borderline verdicts. [FACT]
- **Token guards**: compression threshold + tool-response budgets (see §5); no hardcoded max-turn constant found — the loop guard is loop-detection plus user cancellation. [INFERENCE — searched turn/geminiChat]

## 4. Tool system

- **Inventory** (`packages/core/src/tools/`): shell + shell-background tools, read-file/`read-many-files`, write-file, `edit`, glob, grep (with a `ripGrep` implementation), ls, web-fetch, web-search, `write-todos`, `ask-user`, `enter-plan-mode`/`exit-plan-mode`, `complete-task`, `jit-context` (just-in-time context injection), `topicTool`, tracker tools, `get-internal-docs`, list/read-MCP-resource, `activate-skill`, `mcp-client`, memory tools. [FACT — directory listing]
- **Edit mechanism**: `edit.ts` implements **match-based editing** — the model supplies expected `old_string`/`new_string` and the tool locates the match (with `diff-utils.ts`, line-ending normalization in `line-endings.ts`, and diff options). arXiv:2609.00006 documents an **LLM repair/fixer fallback**: when the target match fails, a secondary model call proposes a corrected match rather than erroring out. [FACT for match-edit; paper claim for the fixer fallback]
- **Tool-result size handling**: large historical tool outputs are truncated to a line tail and may be offloaded to temp files; `compressionTruncationCounter` in `config.ts` (~line 906, 1849, 3821) tracks truncation events. [FACT]
- **MCP**: `mcp-client.ts`/`mcp-client-manager.ts` manage multiple MCP servers; `list-mcp-resources`/`read-mcp-resource` expose MCP resources as tools. [FACT]
- **Per-tool gating**: tool calls pass through `confirmation-policy`/policy engine before scheduler execution; approval requirements depend on approval mode, tool kind, trusted-folder state, and policy rules. [FACT]

## 5. Context management

- **System prompt composition**: `core/prompts.ts` assembles the system prompt from **capability-gated snippets** — blocks included only when the active model/mode supports them (e.g., sandbox-aware text, plan-mode text), per the paper's "capability-gated prompt snippets" finding and the prompts module structure. [FACT + paper cross-ref]
- **Memory / instruction files**: `utils/memoryDiscovery.ts` implements hierarchical `GEMINI.md` discovery — traversing upward from the working directory (`memoryDiscovery.ts:458`), merging global (`~/.gemini/`), extension-provided, and project files, with a legacy private-file fallback (`:357`) and silent-skipping of directory-shaped decoys (`:248-253`). [FACT]
- **Context manager**: `context/manager.ts` maintains a graph/working-buffer context with an event bus and pipeline orchestrator — context is assembled as a pipeline of contributors (memory files, environment, IDE diagnostics, open-file diffs from the IDE companion). [FACT]
- **Compression**: `context/chatCompressionService.ts` — when history exceeds `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` of the model's token limit (line 41), it compresses while preserving the most recent `COMPRESSION_PRESERVE_THRESHOLD = 0.3` fraction (line 47), with a dedicated function-response token budget (line 50) and split points chosen to avoid orphaning tool calls from their responses ("Recent tool outputs are preserved in full", line ~130). A separate `contextCompressionService.ts` handles working-buffer compression. [FACT]
- **Retrieval**: grep/glob/ripgrep only — consistent with the paper's finding of no embedding-based code retrieval in any audited harness. [FACT — tools listing shows no vector store]

## 6. Safety model

- **Approval modes** (`policy/types.ts:49-52`): `PLAN` (read-only exploration + plan presentation), `DEFAULT` (interactive approval), `AUTO_EDIT` (file edits auto-approved, shell/side effects still prompt), `YOLO` (all auto-approved; `PRIORITY_YOLO_ALLOW_ALL = 998`, line ~388). Mode changes are gated by folder trust — `setApprovalMode` throws for `YOLO`/`AUTO_EDIT` in untrusted folders (`config.test.ts:2139-2147`). [FACT]
- **Policy engine**: `core/src/policy/` evaluates tool calls against ordered policy rules (TOML policy files can be shipped by extensions); `confirmation-bus/` decouples the approval prompt UI from core. [FACT]
- **Sandboxing**: `core/src/sandbox/` + `cli/src/config/sandboxConfig.ts` select a sandbox backend per platform — Docker, Podman, macOS `sandbox-exec`, gVisor `runsc`, LXC, Windows-native sandboxing; `GEMINI_SANDBOX` env var overrides the CLI flag. Commands run inside the chosen backend with the project mounted. [FACT — sandboxConfig + paper cross-ref]
- **Trusted folders**: a folder-trust check gates both elevated approval modes and which context/extensions load — untrusted projects can't silently receive project-level config. [FACT — config.test.ts + trust checks]
- **Safety classifiers**: `core/src/safety/` contains content-safety plumbing; the paper additionally describes network/domain restrictions inside sandbox profiles. [FACT for module; MIXED for depth]

## 7. Orchestration

- **Agent registry**: `core/src/agents/agentRegistry.ts` loads agent definitions from built-ins, user, project, and extension sources; built-ins include codebase-investigator, CLI-help, generalist, and browser agents where enabled. [FACT + paper cross-ref]
- **Symmetric session protocol / A2A**: `packages/a2a-server` exposes the agent over the Agent-to-Agent protocol — the paper describes this as a symmetric session protocol where the same agent surface serves CLI users and remote peers. [FACT for a2a-server existence; paper claim for the protocol design]
- **Subagents**: subagent invocations run in isolated context like other harnesses; agent definitions are extension-contributable. [FACT — agentRegistry sources]
- **Headless/CI**: non-interactive mode (`-p`/`--prompt`), JSON output flags, and the a2a-server give three programmatic surfaces. [FACT — cli commands]
- **IDE story**: a companion IDE extension feeds open-file diffs and diagnostics into the context pipeline (`context/` contributors). [FACT]

## 8. Extensibility

- **Extensions** (`cli/src/config/extension.ts`, `extension-manager.ts`, `commands/extensions/`): a single installed extension can contribute MCP servers, context (`GEMINI.md`-style) files, excluded tools, settings, themes, planning config, hooks, skills, agents, and policy rules — the broadest single-manifest surface among the three harnesses in this survey. [FACT — extension-manager + paper]
- **Hooks** (`core/src/hooks/types.ts`): `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompress`. `BeforeModel`/`AfterModel`/`BeforeToolSelection` are unusual — extensions can observe or steer model I/O and which tools are offered, not just tool execution. [FACT]
- **Skills**: `core/src/skills/skillLoader.ts` loads `SKILL.md` files (YAML frontmatter `name`/`description`); `activate-skill.ts` is the model-callable entry. [FACT]
- **Custom commands / themes / settings**: extension-contributed plus user-level config. [FACT — extension-manager]

## 9. Session & state

- **Persistence**: sessions/checkpoints are stored under `~/.gemini/` (project-scoped tmp dirs); chat history is the durable structure `GeminiChat` maintains, with tool responses written back with stable IDs so resume/fork preserves call pairing. [FACT — geminiChat durability; storage paths in cli config]
- **Resume**: `--resume`/`--continue`-style session restore plus checkpointing on file edits (file-checkpointing restores workspace state). [FACT — cli commands; MIXED on exact checkpoint format depth]
- **Compression as state**: compression writes a summary boundary into history rather than mutating the log, similar in spirit to Codex's compact boundary. [INFERENCE from chatCompressionService design]

## 10. Model layer

- **Abstraction**: `core/src/core/contentGenerator.ts` — `ContentGenerator` abstracts streaming generation, token counting, and embeddings behind one interface. [FACT]
- **Auth modes** (enumerated in contentGenerator/config): Google OAuth personal login (free tier), Gemini API key, Vertex AI, legacy Cloud Shell, compute default credentials, and gateway/proxy mode. Detection order: Google GCA env → Vertex AI → gateway base URL → Gemini API key → compute/Cloud Shell credentials. [FACT]
- **Model routing**: per-request model selection with alias support (`loop-detection-double-check` alias exists for internal calls); fallback between models on rate-limit is config-driven. [FACT for aliases; MIXED on fallback depth]
- **BYOK**: yes — API key and Vertex modes are first-class, not second-class citizens of the OAuth path. [FACT]

## 11. Notable mechanisms

1. **LLM-judged loop detection with adaptive cadence** — pattern heuristics escalate to a dedicated diagnostic-model check whose confidence adjusts the polling interval, with a second "double-check" model verdict for borderline cases; the prompt's exemption list (batch operations, varied debugging) is unusually careful about false positives. (`services/loopDetectionService.ts:35-110`) [FACT]
2. **Split-safe compression** — summarization picks boundaries that never orphan a tool call from its response and preserves the newest ~30% of history verbatim under a separate function-response budget. (`context/chatCompressionService.ts:41-130`) [FACT]
3. **`BeforeModel`/`AfterModel`/`BeforeToolSelection` hooks** — interception points around the model call itself and around tool *offering*, a lever most harnesses don't expose. (`core/src/hooks/types.ts`) [FACT]
4. **Trust-gated privilege** — `YOLO`/`AUTO_EDIT` throw on untrusted folders, binding the most dangerous modes to a filesystem trust decision rather than a flag alone. (`config.test.ts:2139-2147`) [FACT]
5. **Extension-everything manifest** — one extension can inject policy rules, hooks, agents, skills, context, and tool exclusions, making "distributable harness configuration" a first-class artifact. (`cli/src/config/extension-manager.ts`) [FACT]

## 12. Evidence log

- `gemini-cli/` @ `9c1b0a610534d6f8120964cf2672c07807d8fc90` — all FACT-tagged source claims (paths cited inline) — accessed 2026-09-15
  - `packages/core/src/core/geminiChat.ts:372,480`, `core/turn.ts`, `core/scheduler/` — agent loop
  - `packages/core/src/services/loopDetectionService.ts:35-110` — hybrid loop detection
  - `packages/core/src/tools/` (full listing incl. `edit.ts`, `jit-context.ts`, `ripGrep.ts`) — tool inventory
  - `packages/core/src/context/chatCompressionService.ts:38-130`, `context/manager.ts` — compression + context pipeline
  - `packages/core/src/utils/memoryDiscovery.ts:248-558` — hierarchical `GEMINI.md`
  - `packages/core/src/policy/types.ts:49-64,388`, `core/confirmation-bus/`, `core/src/sandbox/`, `cli/src/config/sandboxConfig.ts` — safety
  - `packages/core/src/agents/agentRegistry.ts`, `packages/a2a-server/` — orchestration
  - `packages/core/src/hooks/types.ts`, `core/src/skills/skillLoader.ts`, `cli/src/config/extension*.ts` — extensibility
  - `packages/core/src/core/contentGenerator.ts` — model layer
- https://arxiv.org/abs/2609.00006 (*Harness Engineering*, §Gemini CLI) — async-generator loop, hybrid loop detection, capability-gated prompts, LLM edit-fixer fallback, A2A symmetric protocol, four approval modes, cross-platform sandboxing — accessed 2026-09-15
- **Conflicts / gaps / unverified**:
  - The checkout exhibited Windows checkout anomalies (many files showed as deleted in `git status` though core sources were intact); all cited paths were verified present and readable, but peripheral directories were not exhaustively audited.
  - Edit-tool LLM fixer fallback relies on the paper; the `edit.ts` match path was verified but the fallback call path was not line-traced.
  - Exact checkpoint/rewind file format under `~/.gemini/` not fully verified.
  - Windows-native sandbox backend listed in config but internals not audited.
