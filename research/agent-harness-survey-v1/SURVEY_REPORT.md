# Agent Harness Survey V1 — Synthesis Report

> **Track**: `research/agent-harness-survey-v1/` · **Date**: 2026-09-15 · **Status**: COMPLETE (25 per-harness studies in `harnesses/`)
> **Corpus**: 14 deep-dives (`harnesses/*.md`) + ~20 profiled in `inventory.md`
> **Anchor reference**: arXiv:2609.00006 *Harness Engineering* (2nd ed., Jul 2026) — source-code anatomy of 11 of our corpus systems; our studies re-verify at Sept-2026 HEADs.

---

## 1. What a harness is

An agent = model + **harness**: the runtime coupling an LLM to the world through seven canonical subsystems (arXiv:2609.00006 §2.3):

| Subsystem | Role | Minimal observed | Maximal observed |
|---|---|---|---|
| Agent loop | Alternates inference with action; owns stop conditions + failure recovery | Mini-SWE-Agent: linear `while` over one bash tool | OpenHands: event-sourced conversation over persistent event log, parallel action batches |
| LLM integration | Provider protocols; prompt assembly; caching, thinking, routing | Mini-SWE-Agent: one LiteLLM call + one Jinja template | Hermes: 5 owned transports, 29 provider profiles; Codex: server-delivered model catalog |
| Tools & actions | Defines/executes what the agent can do; file editing above all | Mini-SWE-Agent: bash only | Claude Code: ~43 typed tools with deferred loading; Codex: tool calls as V8-executed code |
| Memory & context | Rations the context window; persists knowledge across turns/sessions | Mini-SWE-Agent: unbounded linear history | Codex: agent-maintained cross-session memory; Gemini CLI: graph-based context distillation |
| Safety & permissions | Decides what runs/asks/is forbidden; isolates execution | Mini-SWE-Agent: cost+step limits only | Codex: Starlark policy + LLM approval reviewer + tri-platform OS sandbox |
| Orchestration | Spawns/coordinates sub-agents; connects to other agents | Aider: none (single-agent by design) | Claude Code: recursive composition; Omnigent: cross-vendor meta-layer |
| Extensibility | Config, hooks, skills, plugins, MCP | Mini-SWE-Agent: structural typing | Pi: everything-is-an-extension; Codex: marketplace plugins |

Two cross-cutting surfaces sit alongside: the **interface layer** (TUI/CLI/IDE/HTTP/SDK) and the **session substrate** (transcripts, persistence, resume/fork).

## 2. The floor is low

Mini-SWE-Agent implements all seven subsystems in ~100 LoC — a while loop, one template, one tool, a message list, two limits — and reports SWE-bench Verified results in the same range as systems three orders of magnitude larger. What separates floor from production is not task completion but safety, recovery, cost management, extensibility, and platform surfaces. (~3/5 of OpenCode's non-test source is clients/transports, not the harness proper.)

## 3. Thirteen cross-cutting observations (arXiv:2609.00006, condensed)

1. **Code size spans 3 orders of magnitude for similar tasks; loop sophistication does not predict benchmark performance.** Most mass is safety/UX/extensibility/transports.
2. **Provider-native optimizations are gated on who pays the per-provider conditional-code cost**, not on tight coupling — multi-provider systems (Hermes, OpenCode, Pi) buy the same menu via central per-provider conditioning layers.
3. **Prompt rhetoric converges where engineering experience converges, then thins as trust calibrates.** Anti-gold-plating phrasing is near-isomorphic across six codebases; Codex's newest generation dropped both commit rules and anti-gold-plating as models internalized the norms. Policy is migrating from prompt prose to configuration.
4. **File-editing strategy is a top determinant of code-modification accuracy; model-aware polymorphism is no longer Aider's alone.** Frontier camp converged on exact unique-substring edits; drift-tolerant camp keeps fuzzy cascades (OpenCode 9-stage, Hermes 9-strategy); Gemini CLI added LLM edit-repair — a third option.
5. **Persistent memory has replaced compaction as the context-engineering frontier.** Compaction converged (7/11 threshold-triggered LLM summarization, increasingly incremental); the differentiator is the memory write path — four governance models: agent-maintained (Codex), human-gated inbox (Gemini), model-direct-bounded (Hermes/OpenHands/Claude Code), pre-turn agentic recall (OpenClaw).
6. **OS-level sandboxing is the most code-expensive capability, and it is a choice, not a consequence of scale.** Hermes (huge) ships zero OS isolation — delegates containment to pluggable backends and spends on content-borne threats (promptware scanning, skills supply chain, hardline floor surviving --yolo). Pi documents refusal as a security argument (partial sandbox = false assurance).
7. **Coordinator-worker emerges independently everywhere** — all four vendor systems, OpenHands, Hermes (SQLite-blackboard swarm), OpenCode, OpenClaw at the protocol layer. Convergent evolution, scoped to systems that build multi-agent into core.
8. **Skills overtook MCP as the most-adopted extensibility standard (9/11 vs 8/11).** Deferred loading near-universal; conditional activation (paths/requires/PathTrigger); a supply chain emerged — registries, trust tiers, quarantine, provenance, first agent-authored skills.
9. **Twin absences survived 3× corpus expansion: zero agentic frameworks, zero vector-RAG code retrieval.** All loops are hand-rolled async; retrieval is ripgrep/glob/tree-sitter/Markdown files; conversation-scale recall is lexical (FTS5) or hybrid in exactly one default.
10. **Anthropic's Effective Agents patterns line up closely with independently-built vendor harnesses** — shared empirical reality, guidance influence, or both.
11. **Inter-agent protocols went three-role**: ACP now serves editor↔agent, harness hosting (OpenHands runs Claude Code/Codex/Gemini as interchangeable ACP step-backends; Hermes consumes an ACP agent as model transport), and A2A mesh (Gemini only). For a harness's own sub-agents, 8/9 use in-process primitives — OpenClaw's ACP spawn is the lone exception.
12. **The platform turn completed in H1-2026**: extension substrates converged; distribution acquired marketplaces/trust tiers/agent authors; vendors ship importers for each other's on-disk state + MDM-grade governance; harnesses became importable SDKs while framework vendors shipped harnesses; the agent is addressable behind OpenAI-compatible endpoints; Omnigent orchestrates 11 vendor harnesses behind one API.
13. **The 90-line minimum viable harness implements 10/18 design recommendations directly** — no framework, no RAG, no vector store, no multi-agent, no sandbox. Conjecture: on a frontier model it matches Mini-SWE-Agent's numbers; beyond that is a model-capability question, not a scaffold question.

## 4. Trade-off framework (five axes)

| Axis | Poles | Corpus positions |
|---|---|---|
| Simplicity ↔ Capability | ~100 LoC ↔ ~1M LoC | Mini-SWE-Agent ↔ OpenHands/OpenCode/Claude Code |
| Safety ↔ Autonomy | permission-everything ↔ --yolo | Codex sandbox-first ↔ Pi documented-absence; Hermes: yolo + hardline floor |
| Provider coupling ↔ agnosticism | vendor-locked ↔ 75+ providers | Claude Code ↔ OpenCode |
| Monolithic ↔ modular | one binary ↔ client/server + extension host | Mini-SWE-Agent ↔ OpenCode/Pi/OpenClaw |
| Scaffold complexity ↔ model capability | invest in machinery ↔ let the model carry | OpenHands ↔ Mini-SWE-Agent; trend: policy thinning as models improve (Obs 3) |

## 5. Design recommendations worth stealing (arXiv §16, condensed)

- Start linear; graduate to middleware pipeline (Mistral Vibe) only when ≥3 orthogonal turn policies exist.
- Ship a foundation model → couple tight + generic fallback; multi-provider → central per-model conditioning layer (Pi quirk flags / Hermes profiles / OpenCode transform matrix).
- Start with bash; add tools per observed failure mode; >~15 tools → deferred loading (Claude Code ToolSearchTool ~40% prompt cut; Codex/Hermes BM25 tool search).
- Match edit contract to model tier: exact-substring for frontier, fuzzy cascade for open/weaker; never line numbers; LLM edit-repair is the third way.
- Auto-discover hierarchical Markdown context files — including neighbors' conventions (AGENTS.md, CLAUDE.md, .cursorrules); nested files injected JIT at subtree touch.
- Threshold compaction with verbatim recent tail + incremental merge + reactive refire on overflow.
- No code-RAG. Ripgrep/glob/tree-sitter/LSP.
- Dev tool → 3-mode approvals (PLAN/DEFAULT/YOLO) + permission-scope patterns; enterprise/shared → OS sandbox + policy-as-code + audit trails; keep a floor beneath YOLO (Hermes: 12 hardline patterns, bypass flag frozen at import).
- Stay single-agent until a concrete breadth-first phase needs parallel context isolation (multi-agent ≈ 15× tokens).
- Ship an ACP **server** (three audiences: IDEs, hosting harnesses, meta-harnesses); keep own sub-agents in-process; A2A is Gemini's bet alone.
- Skills for capability templates, MCP for external integrations — in that order; treat third-party skills as packages (trust tiers, scanning, quarantine).
- No LangChain/LangGraph/AutoGen/CrewAI/LlamaIndex/Pydantic-AI in the runtime; no vector-embedding code retrieval; no 1:1 SaaS-API-to-tool wrapping; ship cheap stuck-detection caps (turn/cost/format-error), skip fancy loop detectors.

## 6. Per-harness comparison matrix

<!-- filled after worker review -->

| Harness | Loop paradigm | Edit strategy | Compaction | Sandbox | Orchestration | Ext headline |
|---|---|---|---|---|---|---|
| Claude Code | streaming loop + concurrent tool batching | exact unique-substring | threshold <13K buffer + file post-restore | opt-in sandbox-runtime wrapper; 3-layer perms | recursive composition, context forking, coordinator mode | hooks + skills + subagents + plugins + marketplace |
| Codex CLI | Tokio async state machine | apply_patch DSL (V8 code calls) | server-catalog per-generation prompts | Seatbelt/Landlock/seccomp/Win + Starlark + Guardian LLM reviewer | thread-tree spawn, AgentControl registry | marketplace plugins; BM25 tool_search |
| Gemini CLI | async-generator + hybrid loop detection | exact + LLM edit-fixer | compact at 50% keep last 30%; graph distillation | cross-platform sandbox (2nd after Codex) | registry + symmetric session protocol + A2A | extensions + slash commands + early MCP |
| OpenCode | log-as-queue | per-model toolset swap (patch DSL for GPT fam); 9-stage fuzzy cascade | anchored incremental summaries | policy-only; syntax-aware permissioning (tree-sitter) | concurrent child sessions | plugins; model-family prompt matrix (9 prompts) |
| Mistral Vibe | middleware pipeline | exact match (migrated from fuzzy mid-2026) | middleware-triggered, two-tier, reactive | permission-scope patterns + agent-profile gates | sequential subagent `task` | skills + MCP + custom tools + agents + hooks |
| Pi | functional core + steering queues | exact + Unicode/whitespace canonicalization | compaction over session tree | documented absence (argument: partial = false assurance) | sub-agents as extension; fleets as package | everything-is-an-extension; packages via npm/git |
| OpenClaw | gateway + pluggable harness registry | delegated to hosted runtime | per-harness; Active Memory pre-turn recall | scope-based authorization | session-based; ACP spawn; hosts Codex/Copilot runtimes | plugin SDK incl. agent-harness plugins |
| Hermes | budgeted loop + stop-guards | 9-strategy fuzzy chain (inspired by OpenCode) | lineage compaction (session rotation + ancestry) | delegates to 6 pluggable backends; promptware scanning; hardline floor | config-gated orchestrator + SQLite-blackboard swarm; MoA | self-improving skill loop; agentskills.io |
| Aider | ReAct-ish + lint/test reflection | polymorphic per-model edit formats; RelativeIndenter | recursive summarization | minimal | none by design | config-driven |
| OpenHands | event-sourced conversation engine (v0.62; `main` is now a TS/Electron control-center — pivot documented) | — | pluggable condensation; overflow→condense | ensemble defense-in-depth | parallel delegation over conversation trees | microagents; agent-server (every UI a client) |
| Mini-SWE-Agent | ~190-line linear while; stdout-sentinel exit; exceptions-as-control-flow | none (bash does it) | none (unbounded linear) | cost/step caps | none | structural typing |
| Goose | dual loop: legacy `reply_internal` → formal `state_machine/` migration | — | — | goose-mode lattice (Auto/Approve/SmartApprove/Chat) + LLM permission judge | subagents; `goose serve` ACP HTTP server | recipes + hooks + MCP-first |
| Cline | stateless `AgentRuntime.execute()` (SDK split from stateful core + hub daemon over WS) | — | core-managed compaction | plan-mode command guard; tool presets (plan/act/search/minimal/yolo) | hub daemon multi-client | in-repo `refs/cline/checkpoints/*` replaces shadow-git |
| Roo Code | monolithic `Task.ts` (~4.6k LoC, retains Cline original) | — | — | N custom modes + fileRegex tool-group permissioning | Boomerang single-open-task delegation (parent disposed→rehydrated) | shadow-git checkpoints; **Qdrant embedding `codebase_search`** |
| Kimi Code | XState-style loop + `max_steps_per_turn`; DI×scope engine | — | — | ordered permission-policy chain + tree-sitter bash analysis | coder/explore/plan subagents; ACP + kap-server + klient SDK | plugin marketplace; KAOS fs/process abstraction (local+SSH) |
| Qwen Code | Gemini-fork loop; MAX_TURNS=100 | code-mode: model writes JS calling `tools.<name>()` | inherited Gemini | 3-layer AUTO + fail-closed 2-stage LLM classifier; Seatbelt/Docker via serve daemon | inherited | extension converters for Claude/Gemini plugins |
| Crush | loop delegated to external `charm.land/fantasy` (PrepareStep/StopWhen hooks) | — | context-window auto-summarize via StopWhen | mvdan/sh embedded shell + exec-handler blocklists | — | crushrc bash config; ~70-endpoint REST+SSE daemon; Catwalk provider DB |
| DSH | Cordis service composition (~110 services); goal-round-driver multi-round continuation; waterfall interception seams (`agent/pre-step`, `agent/request`, `tools/post-execute`) | `tool-str-replace-editor` | `compaction-basic` service (+ repo fork w/ convergence guards) | sandbox/approval stack as mounted services; plugin `tools.guard()` fail-closed | subagent spawn/fork providers; workflow worker-thread; ralph iterative driver; jobs registry | Cordis patch layering; skills; user-level plugin seam |

### DOCS-ONLY corpus (mechanism visibility varies)

| Harness | Distinctive mechanisms evidenced |
|---|---|
| Claude Code | ~44 tools + ToolSearch deferred loading; ~30 hook events; 6 permission modes + auto-mode classifier; sandboxed bash w/ per-domain egress; subagent `isolation: worktree`; SKILL.md + `` !`cmd` `` injection; plugin manifest surface |
| Cursor | codebase index → **retired 2026** (Merkle-synced encrypted vectors → local "Instant Grep"); Agent/Composer; Shadow Workspace; checkpoints; own small models for tab/apply |
| Trae | `#` context system; code index + `.trae/.ignore`; custom `.md` subagents; 4-tier command auto-run + sandbox beta; SOLO Coder/Builder; open-source `trae-agent` w/ trajectory recording |
| Kiro | one standalone harness process behind all surfaces over ACP; specs (EARS requirements/design/tasks dep-graph in parallel waves); agent hooks; deny>ask>allow capability algebra; **Kiro Crew**: open-source OpenClaw-genre gateway w/ pluggable backends |
| Devin | VM-per-session + blueprints/snapshots; secrets scopes; playbooks/`!macros`; planning mode + Agency; `/handoff` (100KB diff cap); ACU metering + sleep; Dynamic Workflows (hash-keyed resume); fail-closed bubblewrap sandbox |
| WorkBuddy | authorized-directory file access; 20+ skills + **OpenClaw-skills compatibility**; multi-model switching; 100+ domain experts + leader-integrator teams; 7×24 cloud-persistent tasks; project spaces w/ connector isolation; WeCom/IM bridge; shares `.codebuddy` engine evidence w/ CodeBuddy |
| CodeArts Agent | IDE/plugin/CLI-TUI + `--attach` daemon; Agent Team (Leader + persistent-context teammates + shared task pool); **10M-line keyword+semantic+graph codebase index**; SDD/Explore modes; Skills/Rules centers; CodeArts MCP 8-module DevOps bridge; enterprise governance (SSO/audit/seats) |
| ZCode | Goal Mode w/ evidence-verified completion + state recovery; 4 exec modes (build/edit/yolo/plan); `$` skills / `@` refs / `plugin://`; dual-scope rewind; Remote Dev vs Remote Control vs Bot Channel; bundled `resources/glm`→`zcode.cjs` runtime + pi-tui repackage path |

## 7. Notable mechanisms worth stealing (cross-harness)

- **Policy-as-code with parse-time-validated examples** (Codex Starlark execpolicy).
- **Hardline floor that survives --yolo** (Hermes: 12 patterns; bypass flag frozen at module import so injected content can't flip it).
- **Harness hosting via ACP** (OpenHands runs vendor CLIs as step-backends; Omnigent generalizes; Kiro consolidated three per-surface agents into ONE standalone harness process all surfaces drive over ACP; OpenClaw's in-process harness registry is the same idea without the wire).
- **Harness mimicry** (Pi presents Claude Code identity to ride subscription OAuth — flag as a supply-chain/trust concern, not a pattern to copy).
- **Turn-level checkpoints** (shadow-git per step in OpenCode/Hermes; per-message snapshots in Mistral Vibe; Cline moved checkpoints into `refs/cline/checkpoints/*`; ZCode dual-scope rewind).
- **Syntax-aware command permissioning** (OpenCode tree-sitter parsing + arity-scoped grants; Kimi tree-sitter bash analysis; Crush mvdan/sh embedded shell with exec-handler blocklists).
- **Fail-closed LLM permission classifiers** (Qwen Code 2-stage; Goose LLM permission judge; Codex Guardian reviewer).
- **Writer-claim fencing** (OpenClaw `activeWriterRunId`/`expectedWriterRunId` verified inside the SQLite commit transaction — supersession as a storage invariant).
- **Event-sourced session substrates** (OpenHands event log; OpenCode log-as-queue; Pi session tree w/ movable head; Kimi `wire.jsonl`; OpenClaw JSONL + checkpoint sidecars) — fork/rewind/resume fall out of the log for free.
- **Steering queues** (Pi steering/follow-up queues polled at loop checkpoints; OpenClaw `getSteeringMessages`; Kiro queue-steering) — mid-run user injection without corrupting the turn.
- **Managed-composition boundary** (DSH: runtime + base packages + plugin rows rendered from a canonical registry with `aic diff` as drift authority — treats the whole harness as generated configuration).
- **Skills as the interoperability layer beyond vendors** (WorkBuddy ships OpenClaw-compatible skills; Hermes implements agentskills.io; OpenCode reads `~/.claude/skills`) — the bundle format is becoming a cross-vendor wire format.
- **Cloud-side persistence & metering** (Devin VM-per-session + ACU + Dynamic Workflows; WorkBuddy 7×24 tasks; ZCode Bot Channel; Kiro cloud sessions) — the agent as a daemon, not a process lifetime.

### 7.1 Where the paper's claims bend (our expanded corpus)

- **"No vector embeddings for code" (Obs 9) is a terminal-harness truth, not an industry truth.** In the added corpus: Roo Code ships Qdrant-backed `codebase_search`; CodeArts advertises a 10M-line keyword+semantic+graph index; Trae maintains a code index. And the strongest data point is a *retreat*: Cursor's Merkle-synced encrypted vector index was being retired in favor of local "Instant Grep" as of mid-2026 — the flagship indexer converged toward the deterministic norm. Net: IDE/enterprise harnesses still buy indexes; terminal harnesses don't; the trend arrow points away from embeddings.
- **"No agentic frameworks" still holds** — closest boundary case found: Crush delegates its loop to external module `charm.land/fantasy` (a loop library, not a framework), and Cline split a stateless `AgentRuntime` SDK from its stateful core. Both are ownership-preserving extractions, not framework adoption.
- **Forks as a research instrument**: qwen-code (fork of gemini-cli) shows exactly which surfaces a vendor rewires for a different model family — prompts, permission classifier, code-mode tool calls, extension converters — and what they leave untouched.

## 8. Sources & evidence standard

Primary: per-harness studies in `harnesses/*.md` (each carries commit hash + source list). Anchor: arXiv:2609.00006. Landscape: `inventory.md` sources. All snapshots dated 2026-09-15; these systems ship weekly.

## 9. Known gaps

- Closed systems (Claude Code, Cursor, Trae, Kiro, Devin, WorkBuddy, CodeArts, ZCode) studied via docs/SDK/shipped-internals — internal loop/prompt/compaction details marked DOCS-ONLY or NOT FOUND per file.
- OpenHands `main` pivoted to a TS/Electron control-center ("Agent Canvas"); the Python harness study reads tag 0.62.0 — dated but documented.
- Roo `roomote` + hooks not found at studied commit; Crush's `charm.land/fantasy` loop internals not inspected (external module); kimi-code OS-sandbox/router NOT FOUND.
- DSH studied from this repo's published artifacts only; upstream implementation sections marked INTERNAL/NOT PUBLISHED.
- Tier-B inventory entries are profiles, not implementation studies.
- Track visibility: a governance quarantine in `.git/info/exclude` (added by a parallel adjudication session) was lifted 2026-09-15 after owner review; directory is now normally trackable. Commit/publish remains an owner decision via the repo's governed commit path.
