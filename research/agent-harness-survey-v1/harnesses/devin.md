# Devin

> Cognition AI · Proprietary · TypeScript/Electron-class client surfaces + proprietary cloud agent runtime (INFERENCE — closed source) · First public GA March 2024; Devin CLI (ex-Windsurf lineage) added after the July 2025 Windsurf acquisition · **Version studied: Devin CLI stable v3000.10.21 (released 2026-09-10) + cloud Devin docs as of date accessed 2026-09-15**
> Repo: none (closed) · Docs: https://docs.devin.ai · Web app: https://app.devin.ai
> Epistemic basis: DOCS-ONLY

## 1. Positioning & design philosophy

Devin's bet is that the unit of agent work is a **session on its own cloud VM that ends in a PR**, not a keystroke in an editor. Every session boots a fresh copy of a pre-built machine snapshot (repos cloned, dependencies installed, secrets injected) and owns a shell, a VS Code-based IDE, a browser/desktop environment, and a git identity; parallelism is achieved by spawning more sessions ("managed Devins", Dynamic Workflows), not by threading subagents inside one process (FACT, src: docs.devin.ai/onboard-devin/environment, /work-with-devin/advanced-capabilities). The second bet is **environment-as-code for agents**: blueprints (YAML) → builds → snapshots give every session an identical known-good machine (FACT). The Devin CLI/Desktop surface (Windsurf/Cascade lineage, post-acquisition) reuses the same account, model routing, and team-policy plane for local interactive work, with `/handoff` pushing a task — including repo, branch, and a ≤100KB `git diff` — into a cloud session (FACT, src: docs.devin.ai/work-with-devin/devin-handoff).

## 2. Architecture overview

- **Cloud agent (Devin)**: each session = one isolated VM (Linux default; Windows and macOS/Xcode VMs supported via `runs-on` blueprint field) booted from the org's active snapshot. The web app exposes Devin's tools — Shell, embedded VS Code IDE, Browser/Desktop (interactive), Progress tab — and the human can take over the same machine (FACT, src: docs.devin.ai/work-with-devin/devin-session-tools, /onboard-devin/environment/macos-support, /windows-support).
- **Environment pipeline**: blueprint YAML (tools, deps, env vars, secrets, file attachments, GitHub-Actions steps) → build → snapshot; exactly one active snapshot per org; enterprise adds a 3-tier blueprint hierarchy (enterprise/org) and golden snapshots (legacy) (FACT, src: docs.devin.ai/onboard-devin/environment/blueprints, /product-guides/snapshots).
- **Devin CLI**: local terminal agent (`devin` binary; install via curl script, Homebrew cask, Windows installer, or bundled inside Devin Desktop). REPL + `devin -p` single-turn headless mode. Runs ACP server for JetBrains/Zed/Xcode embedding. Shares Devin account auth, models, and admin team-settings with the cloud product (FACT, src: docs.devin.ai/cli/index, /cli/acp/*).
- **Devin Desktop / Devin Local**: the acquired Windsurf IDE; "Devin Local" shares the Devin CLI agent harness and its modes (Normal/Plan/Ask agent profiles; Normal/Accept-Edits/Smart/Bypass/Autonomous permission modes); Cascade remains the legacy Windsurf agent (FACT, src: docs.devin.ai/desktop/devin-local, /cli/enterprise/controls "a local agent like Cascade").
- **API surface**: `api.devin.ai` v3 — `/v3/organizations/{org}/…` (sessions, knowledge, playbooks, secrets) and `/v3/enterprise/…`, service-user credentials (`cog_` keys) with RBAC and `create_as_user_id` impersonation (FACT, src: docs.devin.ai/api-reference/overview).
- **Devin Outposts**: self-hosted workers (`devin-remote` binary, fleet API, spawn contract) so sessions run on customer infra (FACT, src: docs.devin.ai/cloud/outposts/overview).

## 3. Agent loop

- **Cloud session lifecycle**: prompt → optional planning step → execution with visible progress steps (each step expandable to shell/edit/browser detail) → verification (CI, tests, video recordings) → PR. Planning mode: Devin auto-detects complex tasks and proposes a plan first; an "Agency" behavior setting controls whether it waits for plan approval (FACT, src: docs.devin.ai/release-notes/2024 "Planning mode"/"Agency"). Ask Devin's plan flow generates a context-rich prompt and hands it to a session (src: /work-with-devin/ask-devin).
- **CLI loop**: agent profiles `normal`/`plan`/`ask` (plan = read-only toolset: grep, glob, read, todo, ask_user_question, exit_plan_mode) independent of permission modes; `/plan` enters plan mode and can send the prompt in one step; `megaplan`/`ultraplan`/`masterplan` keywords force extended planning with ≥1 clarifying question; plans persist as Markdown in `~/.devin/plans/` (or `~/.windsurf/plans/`) and are `@`-mentionable into later sessions (FACT, src: docs.devin.ai/cli/reference/commands, /desktop/cascade/modes, /cli/changelog/stable).
- **Stopping/steering**: long shell commands auto-background after a wait period with a background shell ID the agent can poll; queued user messages; `/btw` side chats are read-only forks of session context (FACT, src: /cli/essential-commands, /work-with-devin/devin-session-tools).
- **Retry/recovery**: refusal fallback retries a refused turn on alternate models (`DEVIN_REFUSAL_FALLBACK`); `agent.compaction_threshold_tokens` triggers auto-compaction earlier than the context-window default; reopened sessions stream stored conversation without a second in-memory copy (FACT, src: /cli/changelog/stable v3000.10.21).
- **Orchestrated loops**: Dynamic Workflows replace the in-agent coordinator with a **deterministic Python script** Devin writes and runs — primitives `register_workflow(meta)`, `agent(prompt, phase=, schema=, label=)` (JSON-Schema structured output), `pipeline(items, stage1…)` (no stage barrier), `parallel([...])`, `log()`; every agent call is hash-keyed on prompt+schema+settings so a resumed run replays recorded results and only re-runs unfinished work (FACT, src: /work-with-devin/dynamic-workflows).

## 4. Tool system

- **Cloud**: shell exec, IDE file edits, browser (with cookie/session persistence and savable browser profiles zipped into the blueprint), computer-use desktop (incl. Android emulator, iOS Simulator on macOS VMs), git/GitHub ops (branches, PRs, stacked PRs, PR-comment replies, check-run reporting), side-chat read-only tool, MCP tools (STDIO/SSE/HTTP servers + marketplace plugins) (FACT, src: /work-with-devin/devin-session-tools, /computer-use, /browser-auth, /mcp).
- **CLI**: file read/write/edit tools, exec with per-command rules, `webfetch`/`web_search` (deniable by name), `run_subagent`/`read_subagent`, plan-mode tools (read-only set + `exit_plan_mode`), MCP tools; `agent.codex_tools` optionally swaps in the Codex toolset (shell reads/searches + `apply_patch`) for GPT models (FACT, src: /cli/changelog/stable, /cli/reference/permissions).
- **Edit mechanism**: `edit`/`write` tools; exact diff format not documented — NOT FOUND (searched: CLI docs, changelog). Evidence of search-replace-style edits + unified-diff rendering in TUI (INFERENCE from changelog diff-preview behavior).
- **Tool-result handling**: long-running exec auto-backgrounds; large diff previews truncated to last 50 lines in UI; tool-call names title-cased ("Read lines 10-20 in src/main.rs") for read-only shell commands (FACT, src: /cli/changelog/stable, /cli/essential-commands).
- **Tool gating**: per-tool-type permission table (read-only/fetch/bash/edit-write) × permission mode; `disabled_tools` config array; skills can declare `allowed-tools`; subagent profiles carry their own tool access (FACT, src: /cli/reference/permissions, /cli/extensibility/skills).

## 5. Context management

- **Instructions hierarchy (CLI/Desktop)**: AGENTS.md support in cloud sessions and CLI; Rules system + `.devin/` and `.windsurf/` project dirs; skills auto-loaded from `.devin/skills/`, `.windsurf/skills/`, `.agents/skills/`, `.claude/skills/`, `.cursor/skills/` project paths and global equivalents (incl. `~/.codeium/<channel>/skills/` — Windsurf-lineage paths) (FACT, src: /onboard-devin/agents-md, /cli/extensibility/rules, /cli/extensibility/skills/overview, /cli/changelog/stable).
- **Cloud knowledge plane**: **Knowledge** = org/enterprise-scoped instruction items with mandatory *trigger descriptions*; Devin retrieves an item when current work relates to its trigger (relevance-gated recall — INFERENCE: model- or embedding-judged, mechanism undocumented), pinnable to a repo or all repos, folder-organized, per-user enable/disable, plus auto-suggested knowledge mined from session feedback (FACT, src: /product-guides/knowledge).
- **Playbooks**: reusable task prompts (`.devin.md`, `!macro` invocation, version history, team/community libraries) — "a custom system prompt for a repeated task" (FACT, src: /product-guides/creating-playbooks).
- **Codebase retrieval**: repos are **indexed** after SCM connection; Ask Devin uses "advanced code search" over the index with cited answers; DeepWiki auto-generates architecture wikis with cluster-based page planning (steerable via `.devin/wiki.json`, ≤30 pages / 80 enterprise) — this is a genuine retrieval/indexing surface, a partial counterexample to the "no-RAG" norm, though confined to the Q&A/wiki surfaces rather than the coding loop (FACT for indexing+wiki; INFERENCE for embedding use — mechanism not documented; src: /work-with-devin/ask-devin, /deepwiki, /onboard-devin/index-repo).
- **Compaction**: `/compact` manual; automatic compaction threshold configurable (`agent.compaction_threshold_tokens`); compaction drops skills from context but they are re-discovered when trigger paths are touched (FACT, src: /cli/changelog/stable v3000.10.21).

## 6. Safety model

- **Permission modes (CLI/Desktop)**: Normal (read auto, write/exec prompt) → Accept Edits (workspace edits auto) → Smart (fast-model judge auto-approves "clearly safe" shell/fetch/MCP; hardcoded never-auto list: package installs, mutating git, `rm`/`sudo`, destructive cloud CLIs, dotenv/key/git-config/agent-config reads+writes) → Bypass (all auto, aliases `/yolo` `/dangerous`) → Autonomous (only under `--sandbox`) (FACT, src: /cli/reference/permissions, /cli/essential-commands).
- **Rule engine**: deny > ask > allow; scope rules `Read(glob)`/`Write(glob)`/`Exec(cmd glob)`/`web_search`-by-name etc.; layered configs `~/.config/devin/config.json` (user), `.devin/config.json` (project), `.devin/config.local.json` (local); admin team-settings deny/ask rules are **never** overridden by user modes (FACT, src: /cli/reference/permissions).
- **OS sandbox**: `--sandbox` = OS-level isolation — writable paths = workspace + granted `Write()` scopes; `Read()` denies hide paths entirely; fail-closed startup if sandboxing unavailable (Linux requires `bubblewrap`+`socat`; **unsupported on Windows** → hard fail, including ACP-in-IDE); managed loopback network proxy with domain allow/deny lists and `network_mode: full|limited`; `sandbox.excluded` Exec-rules for commands that must escape (e.g. `git` credential access); enterprise enforcement Optional/Required with authoritative domain lists (FACT, src: /cli/sandbox).
- **Secrets**: org / personal / repo-scoped (blueprint env) / session-scoped secrets; types raw, site cookies (base64 Chromium format), TOTP; encrypted at rest; injected as env vars (name-sanitized, dedup counter); usable by Devin but only admin-visible; new secrets only reach *new* sessions (FACT, src: /product-guides/secrets).
- **Enterprise**: AI Guardrails (screen user messages for prompt-injection/exfil/policy), Attribution Filtering (block Devin-written code matching public repos), Security Profiles (reusable network/MCP/git/`gh` restrictions bound to orgs/automations/sessions), OIDC keyless cloud auth, IP access lists, SSO (Okta/Entra/SAML/OIDC) + SCIM, custom RBAC roles, customer-managed AWS KMS keys, dedicated/private-network deployment, IP-allowlisted self-hosted SCM (GitLab 15+/Artifactory) (FACT, src: /enterprise/*, /product-guides/security-profiles, /product-guides/oidc).
- **Cloud VM containment**: each session is a disposable VM; VPN support for private resources; browser-auth profile persisted via blueprint (FACT, src: /onboard-devin/vpn, /work-with-devin/browser-auth).

## 7. Orchestration

- **Managed Devins**: a coordinator session spawns child sessions (prompt, playbook, tags, ACU limits), messages running children, monitors per-child ACU, resolves conflicts, compiles results — each child on its own VM (FACT, src: /work-with-devin/advanced-capabilities).
- **Dynamic Workflows**: deterministic Python orchestration with per-agent structured outputs and hash-keyed resume; agents default to separate VMs (handoff via git branches) or pin to the orchestrator's shared VM (shared working tree incl. uncommitted changes, lower concurrency cap, strict non-overlap required); agents can be pinned to "Devin Lite" cheaper mode (FACT, src: /work-with-devin/dynamic-workflows).
- **CLI subagents**: `run_subagent` tool; profiles `subagent_explore` (read-only + web search; default subagent model = router → SWE-1.6) and `subagent_general` (full tools, parent's model); foreground (inline, prompts pass through) vs background (parallel, unapproved tools auto-denied); custom profile files with pinned `model:`; nesting supported; admin "Default subagent model" can pin or disable subagents org-wide (FACT, src: /cli/subagents).
- **Surfaces**: web app, Slack/Teams (tag-to-session, thread sync), Linear/Jira ticket→PR, API v3, Devin MCP server (external tools manage sessions/playbooks/knowledge), DeepWiki MCP, ACP into JetBrains/Zed/Xcode, Devin Desktop, scheduled sessions + automations (Slack/GitHub/Linear/webhook/schedule triggers), auto-triage persistent agent, voice mode, Data Analyst agent (DANA), Security Swarm, Devin Review (FACT, src: /integrations/*, /work-with-devin/*).
- **Handoff**: `/handoff` packages conversation context + repo + branch + `git diff HEAD` (≤100KB) into a cloud session; open-source `devin-handoff` plugin gives the same to Claude Code/Codex/Cursor; plan-mode exit can hand the plan to a cloud session (FACT, src: /work-with-devin/devin-handoff, /cli/changelog/stable).

## 8. Extensibility

- **Skills**: `SKILL.md` (name/description/`allowed-tools`/`triggers: [user|model]`/`model:`/subagent execution); invoked `/skill-name` or autonomously; project + global paths incl. `.agents` standard and `.claude`/`.cursor` auto-load (FACT, src: /cli/extensibility/skills).
- **Plugins**: bundle skills+rules+hooks+MCP; personal/org/enterprise scopes; team marketplaces; `devin plugins install` understands Claude Code plugin marketplaces (picker for multi-plugin repos) (FACT, src: /cli/extensibility/plugins, /cli/changelog/stable).
- **Hooks**: lifecycle hooks incl. `PreToolUse` receiving `tool_provenance` (originating skill/MCP/config source); hook events documented (src: /cli/extensibility/hooks/*).
- **Commands/macros**: org slash-command templates; playbook `!macros` (FACT, src: /work-with-devin/slash-commands).
- **Config import**: settings import from Cursor, Windsurf, Claude Code, GitHub Copilot, OpenCode, Zed (FACT, src: /cli/reference/configuration/read-config-from).
- **MCP**: STDIO/SSE/HTTP + OAuth login flow (`devin mcp login`, localhost:8765 callback), registry support honoring platform cert store/proxy, plugin-shipped servers (FACT, src: /cli/extensibility/mcp/*, changelog).

## 9. Session & state

- **Cloud sessions**: persist with full progress timeline; sleep after 30 min idle (configurable 5–120 enterprise), zero metering while asleep; wake on message; archivable; session state visible inline in Ask Devin conversations; per-session usage in Session Insights (FACT, src: /admin/billing/usage, /product-guides/session-insights).
- **CLI sessions**: local persistence, `-c`/`--continue`, `-r`/`--resume [id]`, `/ls`, `/continue`, `devin rm` (refused while open elsewhere); local session DB is SQLite (changelog cites upstream SQLite corruption fixes); resume streams stored transcript message-by-message (memory halved); deleted original-directory resume handled (FACT, src: /cli/essential-commands, /cli/changelog/stable).
- **Plans as durable artifacts**: `~/.devin/plans/*.md` persist across sessions and are mentionable (FACT, src: /desktop/cascade/modes).
- **Snapshot state**: session filesystem changes never write back to the snapshot — every session starts clean (FACT, src: /onboard-devin/environment).
- **Debug/export**: `/debug` exports preserve linked foreground/background subagent chains for trajectory viewing (FACT, src: changelog v3000.10.21).
- **Fork**: `sessionFork`-style cloud clone — NOT FOUND explicitly; CLI resume only (searched: CLI reference, docs index).

## 10. Model layer

- **Catalog**: latest Anthropic (`opus`/`sonnet`), OpenAI (`gpt`/`codex`), Google (`gemini`), Cognition `swe` family (`swe-1-6-fast`, SWE-1.6, SWE-2, Fable 5.1) plus open-source DeepSeek/Kimi/GLM; short names resolve to latest family member; per-model reasoning/effort levels (`Alt+T` cycle) and per-family remembered configs incl. Fast variants (FACT, src: /cli/models, /cli/changelog/stable).
- **Adaptive**: Cognition's model router — picks a model per request, billed at fixed promo rates ($0.50/$2.00/$0.10 per 1M input/output/cache-read through 2026-07-07) or ACU-metered on enterprise; enterprise-off by default (FACT, src: /cli/adaptive).
- **Fusion**: lead+sidekick pairing (recommended Fable 5.1 + SWE-2) — frontier model plans/reviews while cheap model implements; each billed at own rate; requires CLI ≥3000.10.20 / Desktop ≥3.10.0, paid plans only (FACT, src: /cli/fusion).
- **Subagent routing**: default subagent model resolved by router → SWE-1.6 variant per plan tier; admin can pin or disable (FACT, src: /cli/subagents).
- **Fallback**: `DEVIN_REFUSAL_FALLBACK` model list retries policy-refused turns; `--model` on `-c`/`-r` switches resumed sessions; enterprise model allowlists via Team Settings; federal deployments get per-group model provisioning (FACT, src: changelog, /cli/enterprise/team-settings, /federal/model-provisioning).
- **BYOK**: arbitrary-provider API keys — NOT FOUND (model access is Cognition-curated; searched: models docs, team settings, configuration reference).

## 11. Notable mechanisms

1. **Blueprint→snapshot environment model**: the whole dev machine is versioned YAML→build→bootable-image; browser login state and even secrets ride along as blueprint attachments — eliminates "works on my agent's machine" drift and makes session startup deterministic (FACT, src: /onboard-devin/environment/blueprints, /work-with-devin/browser-auth).
2. **Action-metered billing (ACU)**: usage accrues by number/complexity of agent actions + VM time, not wall-clock; idle→sleep stops metering; Windows +9% surcharge; per-user/org caps, IdP-group tiers, Devin Coach pre-send prompt-efficiency linter (FACT, src: /admin/billing/usage, /enterprise/features/*).
3. **Deterministic orchestration code**: Dynamic Workflows make the fan-out itself a reviewable, resumable Python program with schema-typed agent outputs — a genuinely different point in the orchestration design space vs. free-form coordinator agents (FACT, src: /work-with-devin/dynamic-workflows).
4. **Fail-closed OS sandbox with live scope growth**: sandbox denies are OS-enforced (paths hidden, not just refused), startup refuses rather than degrading, and mid-session `Write()` grants *expand* the sandbox dynamically — capability-grant UX on top of real isolation (FACT, src: /cli/sandbox, /cli/reference/permissions).
5. **Smart mode's split trust model**: a fast model judges routine actions while a hardcoded category list (installs, mutating git, `rm`, `sudo`, cloud-destructive, credential files) can never auto-pass — model judgment bounded by a fixed deny floor (FACT, src: /cli/reference/permissions).

## 12. Evidence log

- https://docs.devin.ai/llms.txt — full docs map (cloud/CLI/desktop/enterprise/federal/API) — accessed 2026-09-15
- https://docs.devin.ai/onboard-devin/environment — snapshot/session model; one active snapshot per org — accessed 2026-09-15
- https://docs.devin.ai/onboard-devin/environment/blueprints — blueprint=YAML, build, snapshot analogy to Dockerfile/docker build/image — accessed 2026-09-15
- https://docs.devin.ai/product-guides/snapshots — golden snapshots legacy; enterprise blueprint baseline — accessed 2026-09-15
- https://docs.devin.ai/product-guides/creating-playbooks + /using-playbooks — `.devin.md`, `!macro`, version history — accessed 2026-09-15
- https://docs.devin.ai/product-guides/knowledge — trigger-description retrieval, repo pinning, folders, enterprise scope — accessed 2026-09-15
- https://docs.devin.ai/product-guides/secrets — secret scopes/types/env-var injection — accessed 2026-09-15
- https://docs.devin.ai/work-with-devin/ask-devin — repo indexing, advanced code search, plan→session — accessed 2026-09-15
- https://docs.devin.ai/work-with-devin/deepwiki — wiki effort levels/ACU cost, `.devin/wiki.json`, cluster planning — accessed 2026-09-15
- https://docs.devin.ai/work-with-devin/devin-session-tools — shell/IDE/browser/desktop tools, side chats, takeover — accessed 2026-09-15
- https://docs.devin.ai/work-with-devin/advanced-capabilities — managed Devins, child sessions, ACU limits — accessed 2026-09-15
- https://docs.devin.ai/work-with-devin/dynamic-workflows — workflow primitives, separate/shared VM, hash-keyed resume — accessed 2026-09-15
- https://docs.devin.ai/work-with-devin/devin-handoff — `/handoff`, 100KB diff cap, devin-handoff plugin — accessed 2026-09-15
- https://docs.devin.ai/admin/billing/usage — ACU metering, sleep 30min (5–120), Windows +9% — accessed 2026-09-15
- https://docs.devin.ai/cli/index — CLI vs cloud split; install paths — accessed 2026-09-15
- https://docs.devin.ai/cli/essential-commands — REPL/`-p`, `@` files, modes, `/plan` `/ask`, session history — accessed 2026-09-15
- https://docs.devin.ai/cli/reference/permissions — mode table, Smart never-auto list, deny>ask>allow, config layers — accessed 2026-09-15
- https://docs.devin.ai/cli/sandbox — bubblewrap/socat, fail-closed, network proxy, excluded commands, enterprise enforcement — accessed 2026-09-15
- https://docs.devin.ai/cli/subagents — profiles, model routing, foreground/background, admin controls — accessed 2026-09-15
- https://docs.devin.ai/cli/models + /cli/adaptive + /cli/fusion — model catalog, router pricing, lead/sidekick — accessed 2026-09-15
- https://docs.devin.ai/cli/changelog/stable — v3000.10.21 (2026-09-10) details: codex_tools, disabled_tools, compaction threshold, refusal fallback, plan-in-sandbox, SQLite fixes — accessed 2026-09-15
- https://docs.devin.ai/cli/reference/commands — agent profiles/toolsets, `/cloud-sessions`, `/mode` list — accessed 2026-09-15
- https://docs.devin.ai/desktop/cascade/modes + /desktop/devin-local — plan-mode file in `~/.devin|windsurf/plans`, megaplan keywords, shared harness — accessed 2026-09-15
- https://docs.devin.ai/api-reference/overview + /v3/sessions + /common-flows — v3 API, service users, `create_as_user_id`, session JSON — accessed 2026-09-15
- https://docs.devin.ai/cli/extensibility/skills/overview — SKILL.md format, skill paths incl. `.codeium/<channel>` — accessed 2026-09-15
- https://docs.devin.ai/integrations/gh — GitHub app permissions, PR authorship modes, user linking — accessed 2026-09-15
- https://docs.devin.ai/release-notes/2024 — cloud Planning mode + Agency auto-approve — accessed 2026-09-15
- https://cognition.com/blog/windsurf + https://techcrunch.com/2025/07/14/cognition-maker-of-the-ai-coding-agent-devin-acquires-windsurf/ — Windsurf acquisition (2025-07-14), basis for Devin Desktop/CLI lineage — accessed 2026-09-15
- Conflicts/gaps: cloud agent's internal loop/retry structure undocumented; edit diff format not documented; Knowledge retrieval mechanism (embedding vs LLM-judged) undocumented; no arbitrary-BYOK evidence.
