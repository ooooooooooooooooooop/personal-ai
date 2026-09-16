# Trae (ByteDance Trae IDE + SOLO + trae-agent CLI)

> Steward: ByteDance (international entity: SPRING (SG) PTE. LTD.) · License: Proprietary IDE/SOLO; the sibling `trae-agent` CLI is open source (MIT) · Impl. language: IDE closed source on a VS Code base (FACT that it is VS Code-derived per public docs/reviews); `trae-agent` is Python · First release: IDE public launch early 2025 · **Version studied: Trae IDE "TraeCode" v3.5.9x line (Aug 2026 changelog entries); SOLO docs current; docs fetched 2026-09-15**
> Repo: https://github.com/bytedance/trae-agent (open CLI only) · Docs: https://docs.trae.ai · https://trae.ai
> **Epistemic basis: DOCS-ONLY** (IDE/SOLO) + **open-source README** for `trae-agent`

Tag legend: **FACT** = documented behavior · **VENDOR-CLAIM** = marketing statement · **INFERENCE** = derived structure.

## 1. Positioning & design philosophy

Trae's bet is *maximum agent surface at minimum price*: an AI-native VS Code-class IDE with two graded autonomy levels — a collaborative **IDE Agent** (the merged successor of the earlier "Chat"/"Builder" modes) and **SOLO**, a "context engineer" persona that runs the full pipeline plan→code→preview→deploy — historically famous for offering frontier models on a free tier (VENDOR-CLAIM on positioning; FACT on mode structure, src: https://docs.trae.ai/ide/agent-mode, https://docs.trae.ai/solo, https://trae.ai/pricing). SOLO is positioned not as a chatbot but as a "Responsive Coding Agent" that consumes the *visible context* of the IDE — editor, browser preview, terminal, docs — as its input space (VENDOR-CLAIM, src: https://docs.trae.ai/solo). ByteDance also open-sourced `trae-agent`, a research-grade CLI sharing the brand's agent lineage, which is the only place Trae's loop internals are directly observable (FACT, src: https://github.com/bytedance/trae-agent).

## 2. Architecture overview

- **Trae IDE ("TraeCode")** — closed-source VS Code-derived editor; AI surfaces include the Agent side panel, inline chat, Cue tab-completion, SOLO mode switch, Task Management panel, and DiffView/review UI (FACT, src: https://docs.trae.ai/ide/agent-mode, https://docs.trae.ai/ide/code-review, https://docs.trae.ai/ide/changelog).
- **SOLO** — Trae's autonomous mode/product: inside the IDE as the SOLO switch and as standalone web/desktop experiences; executes multi-step plans with its own tool set (editor, terminal, browser preview, deployment integrations) (FACT, src: https://docs.trae.ai/solo, https://docs.trae.ai/solo/models).
- **`trae-agent` CLI** — open-source Python harness: Click-based CLI (`run`, `interactive`, `show-config`, `tools` subcommands), YAML-configured multi-provider LLM client, tool set (edit/bash/search), trajectory recorder, and a "Lakeview" summarization component for long tasks (FACT, src: https://github.com/bytedance/trae-agent README/docs).
- **Context subsystem** — a code index built per workspace (Settings → Context → Code Index Management) powering `#Folder`/`#Workspace` retrieval; `.gitignore` + `.trae/.ignore` exclusions (FACT, src: https://docs.trae.ai/ide/number-sign, https://docs.trae.ai/ide/ignore-files).
- **MCP client + marketplace** — IDE and SOLO both host an MCP layer; config at `.trae/mcp.json` (project) / user config; an official Figma MCP is highlighted (FACT, src: https://docs.trae.ai/ide/model-context-protocol).
- **Process/model internals** — NOT FOUND (closed source): loop file paths, token guards, exact context assembly order are not documented.

## 3. Agent loop

**IDE Agent mode** (FACT, src: https://docs.trae.ai/ide/agent-mode):
- User prompt + `#` context references → agent plans (it can emit a task plan and ask for confirmation before executing on non-trivial work) → iterative tool calls (read/search/edit/run) → streams progress → produces reviewable diffs.
- Built-in **Search subagent** handles codebase exploration so the main loop stays focused.
- Stopping: agent stops on task completion, on blocking question, or on user interrupt; users can send follow-ups to steer.

**SOLO mode** (FACT, src: https://docs.trae.ai/solo, https://docs.trae.ai/solo/solo-coder):
- **SOLO Coder** — for complex projects: Plan mode (structured plan gated for approval), task decomposition into a **Task Management** panel (parallel/queued tasks), orchestration of specialized subagents, integrated preview/browser verification, and DiffView for review.
- **SOLO Builder** — web-app pipeline: PRD → Figma-to-code → code → preview → deploy; pre-integrated services (Supabase for DB/auth, Stripe for payments, Vercel for deployment, LLM API helpers) (FACT, src: https://docs.trae.ai/solo/solo-builder).
- **Webview tool set** — SOLO's browser environment can inspect DOM/console to verify UI work (FACT, src: https://docs.trae.ai/solo).

**`trae-agent` CLI loop** (FACT, open source, src: https://github.com/bytedance/trae-agent):
- Classic ReAct loop: LLM → tool calls → observation, with `max-steps` guard; interactive mode supports steering; **Lakeview** generates milestone summaries during long runs; full **trajectory recording** (every LLM call + tool result serialized for replay/eval) — the mechanism that powered ByteDance's SWE-bench submissions.

**Retry/recovery internals, token budgets** — NOT FOUND for IDE/SOLO (searched: agent-mode docs, changelog); `trae-agent` exposes max-steps and summarization knobs.

## 4. Tool system

- **IDE/SOLO built-ins** (documented categories): file read/write, code/file search, terminal/command execution (gated by auto-run policy), web search, webview/browser control (SOLO), doc/knowledge tools (`#Doc`), deployment/integration tools in SOLO Builder (Supabase/Stripe/Vercel), and a Codebase context tool (FACT, src: https://docs.trae.ai/ide/agent-mode, https://docs.trae.ai/solo).
- **Edit mechanism** — diff-based proposals rendered in DiffView with per-file accept/reject; the *Code Review* feature replaces blanket auto-accept with three review modes and an agent-powered summary/review pass that can send findings back via "Fix in Chat" (FACT, src: https://docs.trae.ai/ide/code-review, https://docs.trae.ai/ide/agent-powered-code-review).
- **`trae-agent` tools** — file editor (view/create/str-replace), bash, sequential thinking, task-done signal; tool schemas are plain JSON-schema over a provider-agnostic LLM client (FACT, src: repo README/`trae_agent/tools`).
- **MCP** — supported in both IDE and SOLO; `Builder with MCP` exists as a built-in agent persona pre-wired to consume MCP tools; project config `.trae/mcp.json`; first-use auth prompts; auto-run toggle per server (FACT, src: https://docs.trae.ai/ide/model-context-protocol).
- **Tool-output truncation/limits** — NOT FOUND (searched: MCP/agent docs).

## 5. Context management

- **Explicit references** — `#` syntax: `#Code` (symbol-level, needs LSP), `#File`, `#Folder` and `#Workspace` (need completed code index), `#Doc` (user doc sets, up to ~1000 files / 50MB), `#Problems` (diagnostics), `#Web`, `#Rule`, `#Past Chats` (FACT, src: https://docs.trae.ai/ide/number-sign).
- **Code index** — per-workspace index built asynchronously (auto for workspaces ≤ ~5000 files per docs); powers folder/workspace retrieval; `.gitignore` respected, `.trae/.ignore` adds exclusions (FACT, src: https://docs.trae.ai/ide/ignore-files, https://docs.trae.ai/ide/number-sign). Whether the index is embedding-based or deterministic: NOT FOUND officially (searched: docs). *Third-party reporting of the privacy policy says codebase files may be temporarily uploaded for embedding computation with plaintext deleted afterward — tag as third-party/policy-derived, src: https://trae.ai/privacy-policy + secondary coverage.*
- **Rules** — user rules (`~/.trae/user_rules`), project rules `.trae/rules/*.md` with `alwaysApply`/`description`/`globs` frontmatter, plus root-level `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md` loaded as project instructions; rule application modes: Always Apply / Apply to Specific Files / Apply Intelligently / Apply Manually (FACT, src: https://docs.trae.ai/ide/rules).
- **SOLO context** — "visible context": SOLO consumes what the IDE surfaces show (editor buffers, browser preview, terminal output, docs) as grounding (VENDOR-CLAIM framing, FACT that these surfaces feed the agent, src: https://docs.trae.ai/solo).
- **Compression** — context-window compression for long conversations is documented ("compact context" behavior); algorithm/thresholds NOT FOUND (searched: context docs).

## 6. Safety model

- **Command execution policy** — four modes: always require manual run / denylist / allowlist / always auto-run; high-risk command detection flags dangerous commands even under auto-run (FACT, src: https://docs.trae.ai/ide/agent-mode + settings docs).
- **Sandbox (beta)** — filesystem isolation restricting agent writes to the project dir + temp + dependency dirs; violations surface Skip/Run/Add-to-allowlist choices; shell interception blocks `rm`-class operations outside scope (FACT, src: https://docs.trae.ai/ide/changelog — sandbox entries).
- **MCP trust** — first-run authorization prompt per server; per-server auto-run toggle; project `.trae/mcp.json` travels with the repo (FACT, src: https://docs.trae.ai/ide/model-context-protocol).
- **Review gating** — DiffView + three review modes + agent-powered code review mean changes are meant to be human-reviewed, not auto-applied (FACT, src: https://docs.trae.ai/ide/code-review).
- **Privacy posture** — policy FACT: Trae's privacy policy (updated 2026-01) lists collection of prompts, code/text, file uploads, embeddings, metadata, usage data; inputs may be shared with LLM providers; data stored in US/Singapore/Malaysia; no dedicated "privacy mode" toggle (src: https://trae.ai/privacy-policy). Third-party claim (tag accordingly): independent reporting (Unit 221B and derivative coverage) describes persistent telemetry connections to ByteDance infrastructure even when telemetry toggled off (src: https://copilot-alternatives.com/alternative/trae/ and the Unit 221B writeup it cites). The repo's own notes: treat telemetry claims as third-party, not vendor-confirmed.
- **Prompt-injection handling** — NOT FOUND (searched: docs).

## 7. Orchestration

- **Built-in agents** — IDE: default "Agent" + legacy "Builder"/"Builder with MCP" personas; SOLO: SOLO Coder / SOLO Builder (FACT, src: https://docs.trae.ai/ide/agent-mode, https://docs.trae.ai/solo).
- **Custom agents** — UI-created agents with custom prompts, tool selections, MCP bindings, and a "callable by other agents" flag enabling multi-agent delegation (FACT, src: https://docs.trae.ai/ide/custom-agents).
- **Subagents** — `.md` files with frontmatter (`name`, `description`, `model`, `tools`/`disallowedTools`, `mcpServers`); invoked by the main agent or `@`-mentioned (FACT, src: https://docs.trae.ai/ide/subagents).
- **Task Management panel** — SOLO decomposes work into tracked tasks that can run in parallel; progress visible per task (FACT, src: https://docs.trae.ai/solo).
- **Headless/CI** — `trae-agent` CLI is the headless path (`trae-cli run "..." --max-steps N`), JSON trajectory output for CI/eval (FACT, src: https://github.com/bytedance/trae-agent).
- **Wire protocols** — MCP for tools; no ACP or external agent protocol documented for IDE/SOLO — NOT FOUND (searched: docs, changelog).
- **Remote dev** — WSL and SSH-remote workflows documented in changelog/remote docs (FACT, src: https://docs.trae.ai/ide/changelog).

## 8. Extensibility

- **Rules** (`user_rules`, `.trae/rules/*.md`, AGENTS/CLAUDE family) — FACT, src above.
- **Custom agents & subagents** — FACT, src above.
- **MCP** — marketplace + manual config + `Builder with MCP` persona — FACT, src above.
- **#Doc knowledge sets** — user-curated doc corpora attachable to context — FACT, src: https://docs.trae.ai/ide/number-sign.
- **Plugins/extensions** — VS Code-compatible extension host; Trae ships its own marketplace experience (FACT on extensions existing; specifics NOT FOUND beyond docs).
- **Hooks (event-triggered automations like Kiro/Cursor hooks.json)** — NOT FOUND (searched: docs index, changelog, web).
- **Skills (SKILL.md packages)** — NOT FOUND in official docs (searched: docs index, changelog).

## 9. Session & state

- **Sessions** — IDE chats persist per workspace; `#Past Chats` can pull earlier sessions into context (FACT, src: https://docs.trae.ai/ide/number-sign).
- **Task state** — SOLO Task Management persists task lists/plans per workspace session (FACT on the panel; storage format NOT FOUND).
- **Checkpoints/restore** — a restore/checkpoint flow exists for reverting agent changes (DiffView-based per-change revert; community/bug-report evidence shows an `ai-agent/snapshot` store under app data). Formal checkpoint docs: PARTIAL — cite changelog + https://github.com/Trae-AI/TRAE/issues/767 as evidence a snapshot mechanism exists; exact semantics NOT FOUND.
- **`trae-agent`** — deterministic trajectory files (JSON) per run for replay/debug; resumable interactive sessions (FACT, src: repo).
- **Cross-session memory** — `#Past Chats` retrieval + rules; a long-term memory feature beyond that NOT FOUND (searched: docs).

## 10. Model layer

- **Lineup (documented mid-2026, varies by region)** — GPT-5.4, GPT-5.2, Seed-2.1-Turbo (ByteDance), MiniMax-M3/M2.7, Kimi-K2.5, Gemini-3.1-Pro-Preview, Gemini-3-Flash-Preview; subagent-usable models incl. Dola-Seed-2.0-Code, DeepSeek-V3.2, Gemini-2.5-Flash (FACT, src: https://docs.trae.ai/ide/models, https://docs.trae.ai/solo/models).
- **TRAE Auto Model** — Trae's own routing option that picks a model per task; default in SOLO surfaces (FACT on existence; routing logic NOT FOUND — proprietary, src: https://docs.trae.ai/solo/models).
- **BYOK** — custom-model support via ~30 preset providers plus arbitrary OpenAI/Anthropic-compatible endpoints (FACT, src: https://docs.trae.ai/ide/models).
- **Regional splits** — CN version (Trae CN / "Trae国内版") ships Doubao/DeepSeek lineups; US region lacks some options (GPT/MiniMax availability differs) (FACT, src: https://docs.trae.ai/ide/models + CN docs).
- **Auth/pricing** — account-based; historically generous free tier (the product's growth driver), now Free + Pro plans with model quotas; SOLO usage metered (FACT, src: https://trae.ai/pricing).
- **`trae-agent`** — provider-agnostic: OpenAI, Anthropic, Doubao, Azure, OpenRouter, Ollama, Gemini via YAML config; `model_provider`/`model` per config (FACT, src: repo docs/config files).

## 11. Notable mechanisms

1. **Two-tier autonomy ladder** — same product exposes collaborative Agent mode and SOLO autonomous mode (plan→execute→preview→deploy) with Plan-mode gating and a Task Management panel — a clean UX study in graduated autonomy (src: https://docs.trae.ai/solo).
2. **`trae-agent`'s Lakeview + trajectory recording** — milestone summarization plus full-fidelity run serialization built for SWE-bench-style eval; the most inspectable ByteDance agent loop (src: https://github.com/bytedance/trae-agent).
3. **Cue completion stack** — Cue/Cue-Pro repo-level chained completion: a trained retriever localizes edit points, RAG pulls repo context, and a fusion model emits multi-hunk edits (plus smart import/rename via LSP) — an unusually engineered tab system (FACT, src: https://docs.trae.ai/ide/cue + changelog entries on Cue-Pro).
4. **Agent-powered Code Review loop** — review modes + AI summarizer that can bounce findings back into chat as fix tasks (src: https://docs.trae.ai/ide/agent-powered-code-review).
5. **Pre-integrated vertical stack in SOLO Builder** — Figma→code, Supabase, Stripe, Vercel wired in as first-class tools rather than generic MCP (src: https://docs.trae.ai/solo/solo-builder).

## 12. Evidence log

- https://docs.trae.ai/ide/agent-mode — IDE agent loop, run modes, Search subagent — accessed 2026-09-15
- https://docs.trae.ai/solo — SOLO mode overview, visible-context positioning — accessed 2026-09-15
- https://docs.trae.ai/solo/solo-coder · https://docs.trae.ai/solo/solo-builder — SOLO personas, Plan mode, integrations — accessed 2026-09-15
- https://docs.trae.ai/ide/number-sign — `#` context reference inventory — accessed 2026-09-15
- https://docs.trae.ai/ide/ignore-files — code index + `.trae/.ignore` — accessed 2026-09-15
- https://docs.trae.ai/ide/rules — rule types, frontmatter, AGENTS/CLAUDE support — accessed 2026-09-15
- https://docs.trae.ai/ide/model-context-protocol — MCP config, auth, auto-run — accessed 2026-09-15
- https://docs.trae.ai/ide/custom-agents · https://docs.trae.ai/ide/subagents — agent/subagent definitions — accessed 2026-09-15
- https://docs.trae.ai/ide/code-review · https://docs.trae.ai/ide/agent-powered-code-review — DiffView/review modes/AI review — accessed 2026-09-15
- https://docs.trae.ai/ide/models · https://docs.trae.ai/solo/models — model lineup, Auto Model, BYOK — accessed 2026-09-15
- https://docs.trae.ai/ide/changelog — version line, sandbox beta, Cue-Pro, remote dev — accessed 2026-09-15
- https://github.com/bytedance/trae-agent — open-source CLI: loop, tools, Lakeview, trajectory, providers — accessed 2026-09-15
- https://github.com/Trae-AI/TRAE/issues/767 — evidence of `ai-agent/snapshot` checkpoint store — accessed 2026-09-15
- https://trae.ai/pricing — free/Pro tiers — accessed 2026-09-15
- https://trae.ai/privacy-policy — data-collection categories — accessed 2026-09-15
- https://copilot-alternatives.com/alternative/trae/ — third-party telemetry summary citing Unit 221B — accessed 2026-09-15

**Conflicts / gaps / unverified**: embedding-vs-deterministic index internals NOT FOUND officially (policy text implies embeddings are computed server-side); exact SOLO loop/turn limits, checkpoint semantics, memory features, ACP/wire protocol, and sandbox coverage on all OSes are NOT FOUND; telemetry claims are third-party-reported, not vendor-confirmed; relationship between `trae-agent` and the in-IDE agent is brand/architecture lineage (INFERENCE), not shared source.
