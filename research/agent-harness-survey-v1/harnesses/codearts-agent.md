# Huawei Cloud CodeArts Agent (码道 / CodeArts 智能体)

> Huawei Cloud (CodeArts product line) · Proprietary · Implementation language NOT FOUND (closed; CLI is a distributed binary, likely Go/Rust/TS — unverified) · Public launch 2026 (产品页 "全新发布"; docs versioned 2026-07-30) · **Version studied: Agent Space user manual + productdesc docs as of date accessed 2026-09-15**
> Repo: none (closed) · Product: https://www.huaweicloud.com/intl/zh-cn/product/codearts/ai.html · Docs: https://support.huaweicloud.com/usermanual-space/ + https://support.huaweicloud.com/productdesc-codeartsagent/
> Epistemic basis: DOCS-ONLY

## 1. Positioning & design philosophy

CodeArts Agent (中文名 **码道**) is Huawei Cloud's enterprise-first agent harness. Its stated differentiator is being "更懂企业研发" — it sells the agent *plus the scaffolding around it*: three delivery forms (AI IDE "码道IDE", IDE plugin for VS Code/JetBrains, CLI/TUI "码道CLI"), a **codebase indexing service that claims 千万行级 (10-million-line) support**, a spec-driven development pipeline, and deep wiring into the CodeArts DevOps suite (requirements → repo → pipeline → check → test → deploy → artifact) (VENDOR-CLAIM, src: huaweicloud.com product page; productdesc-codeartsagent/codeartsagent_01.html). The design bet visible in the docs: enterprises won't adopt agents that free-read their code without **governance** — so indexing visibility, seat quotas, model allowlists, SSO, IP whitelists and audit logs are first-class product surfaces, not afterthoughts (INFERENCE from the size of the 企业管理 console surface).

## 2. Architecture overview

- **Three client forms** (FACT, src: productdesc "产品形态"):
  - **码道IDE (CodeArts IDE)** — standalone AI IDE (VS Code-derived, INFERENCE from "类 VS Code 界面"/extension gallery references) hosting chat + **Agent Space** mode;
  - **IDE plugin** — same agent inside VS Code / JetBrains;
  - **码道CLI (codearts CLI)** — terminal agent with interactive TUI (`codearts`), one-shot (`codearts run "…"` / `-p`), session management (`codearts sessions`), server/attach mode (`codearts run --attach http://localhost:4096`, `--fork`, `--title`), codebase commands (`codearts codebase --init/--update`), agent authoring (`codearts agent create`, `codearts debug agent`), usage stats (`codearts stats`), self-update (`/self-upgrade` ≥2.5.0). Output formats: text/json/stream-json; `--verbose`, `--tools`, `--permission-mode`.
- **Agent Space** — an agent-centered interaction mode in the IDE for **multi-agent collaboration + cloud/terminal integration**: task-oriented workspaces where Agent Teams run (FACT, src: usermanual-space/codeartsagent_space_0000.html).
- **Cloud planes**: (a) **企业管理 console** — members/teams, seat quotas, model config, usage/token governance, security center, audit logs; (b) **智能体设置 console** — agents, skills, rules, knowledge spaces, codebase indexes; (c) **CodeBase indexing service** — Git/GitHub/Repo-source code indexes (team/enterprise scope) downloadable to clients (FACT, src: productdesc 产品功能; usermanual "智能体设置" pages).
- **Process model**: CLI `run --attach` implies a long-lived local server process the TUI/CLI attaches to (port 4096 default) — the agent loop appears to live in a local daemon, IDE plugin and TUI being front-ends (INFERENCE from `--attach`/`--fork` CLI surface, src: CLI docs in usermanual).

## 3. Agent loop

- **Two development paradigms** (FACT, src: productdesc; "编码模式" docs):
  - **Vibe-Coding / 探索模式 (Explore)**: conversational, agent improvises within permissions — for prototypes and quick tasks.
  - **Spec-Driven Development (规范模式 / SDD)**: structured pipeline 需求规格(spec.md, EARS-notation requirements) → 设计(design.md) → 任务分解(tasks.md) → 执行, with manual confirmation gates between phases; `/sdd-spec` `/sdd-design` `/sdd-tasks` style commands drive it (FACT for the pipeline + artifacts; phase gate names per docs).
- **Built-in agents**: CLI ships `Build` (default execution agent) and `Plan` (read-only planning) agents; IDE exposes an agent panel with selectable agents (FACT, src: CLI usage docs "内置 Build/Plan").
- **Turn structure**: prompt → agent dialog with streaming steps, tool calls visible, thinking display, session status; multi-turn steering; queued messages? NOT FOUND explicitly (searched: usermanual-space, CLI docs).
- **Plan/permission split**: Plan mode is a read-only research profile; switching to Build executes. Whether plan approval is a hard gate per-file — partially documented; NOT FOUND beyond "Plan 只读" (searched: CLI permission docs).
- **Retry/compaction internals**: NOT FOUND (closed source; docs describe behavior only).

## 4. Tool system

- **Core tools**: file read/write/edit, terminal/exec, search — inferred from the permission system which gates 文件/命令/网络 scopes (INFERENCE, src: 权限配置 docs).
- **LSP integration**: IDE/plugin exposes language-server-powered diagnostics, definitions, references for Java/TS/Go etc. — code intelligence rides the IDE's LSP rather than pure text search (FACT, src: productdesc "LSP").
- **MCP tools**: MCP servers attach extra tools; Huawei ships a **CodeArts MCP server** exposing 8 DevOps modules: 需求管理(requirements), 代码托管(repo), 流水线(pipeline), 代码检查(check), 测试计划(test plan), 部署(deploy), 编译构建(build), 制品仓库(artifact) — streamableHttp + stdio transports (FACT, src: usermanual-codeartsagent/codeartsagent_ug_0010.html).
- **Codebase index tool**: agent can query the indexed codebase (semantic+keyword+graph retrieval) — toggleable per task ("codebase 检索开关"); index auto-downloaded into TUI workspace on start (FACT, src: productdesc "Codebase"; CLI docs).
- **Other agents as tools**: unit-test agent, web QA agent, doc-generation; custom agents callable (FACT, src: productdesc 功能列表).
- **Edit mechanism**: apply format (search-replace vs patch vs whole-file) NOT FOUND (searched: CLI docs, usermanual).

## 5. Context management

- **Codebase indexing — the headline mechanism**: cloud-side index built from Git/GitHub/Repo sources over **Java / JavaScript / TypeScript / Go** codebases, claiming **千万行级 (10M+ LOC)** capacity and **"关键词、语义、图谱多维" (keyword + semantic + graph) retrieval**; index file quotas by tier (个人 5k files / 团队 50k / 企业 100k); personal indexes can be built locally, team/enterprise indexes are cloud-built and pulled down; `codearts codebase --init/--update` drives incremental updates (FACT for documented behavior, VENDOR-CLAIM for 10M-line claim, src: productdesc "智能代码索引"/"Codebase"; CLI docs). **This is a documented counterexample to the survey's "mainstream agents avoid RAG" observation** — CodeArts ships a managed retrieval index as a core feature, though its slice (semantic search over symbols/files feeding the agent) is narrower than classic vector-RAG-over-everything.
- **Knowledge spaces (知识库)**: enterprise document spaces (Markdown/docs upload; 5GB personal-ish / 20GB enterprise quotas) queryable by the agent — a second, doc-oriented retrieval plane (FACT, src: productdesc "知识空间" quotas).
- **Rules**: three-level rules — project (`.md` rule files in repo config dir), team, enterprise — injected as behavior constraints; rules are governance-scoped (enterprise rules apply to all members) (FACT, src: 智能体设置 "规则" docs).
- **Skills**: SKILL.md-format skills; skills center with market + custom upload (.zip); per-agent skill binding (FACT, src: 智能体设置 "技能").
- **Session memory**: cross-session memory — NOT FOUND (docs cover rules/knowledge/index, not auto-memory; searched: 智能体设置, CLI docs).
- **AGENTS.md-family file**: project instruction file convention — docs reference rules md files; exact filename (CODEARTS.md vs AGENTS.md) NOT FOUND (searched: CLI config docs — unclear).

## 6. Safety model

- **安全沙箱**: docs advertise a "安全沙箱" containing agent file/command effects (VENDOR-CLAIM level of detail — mechanism, e.g. OS sandbox vs path-scoping, not specified; src: productdesc 安全).
- **Permission isolation**: per-agent/subagent permission scoping — sensitive data, private knowledge bases, high-risk APIs, file resources can be permission-gated per agent; CLI `--permission-mode` flag mirrors modes (FACT, src: usermanual-space "权限隔离"; CLI flags).
- **Enterprise security center**: isolated repos (隔离仓), IP whitelists (IP 白名单), SSO (SSO 单点登录), privacy mode for trials ("隐私模式"), encrypted transmission, audit/operation logs (审计日志/操作日志) (FACT, src: productdesc "企业管理"/"安全中心").
- **Data boundary**: docs state code files stay local and transmission is encrypted; index content upload policy (what exactly leaves to cloud indexing) partially documented — index build happens cloud-side for team/enterprise (FACT/INFERENCE mix, src: productdesc 数据安全).
- **Human-in-loop**: SDD phases require manual confirmation; permission prompts gate risky ops in Explore mode (FACT, src: SDD docs).

## 7. Orchestration

- **Agent Team (Agent Space's flagship mechanism)** — "Leader 编排 + Teammate 自主执行" (FACT, src: usermanual-space/codeartsagent_space_0003.html):
  - **Team Leader** decomposes the goal, assigns tasks to members, monitors progress, coordinates, and can **dynamically create new agents** mid-run; leader can adjust roles/scenes;
  - **Teammates** have **persistent independent contexts** (member context survives across tasks), **communicate bidirectionally** (member↔leader and member↔member messaging), share a **common task pool** and can **autonomously claim tasks** from it;
  - Docs explicitly differentiate Agent Team from ordinary subagents: persistent context, peer communication, shared task pool, dynamic membership, **automatic failure recovery/member replacement**;
  - Teams are definable/savable (`/save-team` creates reusable team templates; scenes like "frontend+backend+tester" presets).
- **Subagents**: built-in subagent list + custom agents (created in console or `codearts agent create`; `codearts debug agent` shows an agent's resolved permissions/tools/model/prompt) (FACT, src: usermanual-space; CLI docs).
- **Parallel tasks**: multiple tasks/agents run in parallel within Agent Space; task list + to-dos are first-class objects (FACT, src: usermanual-space_0000).
- **DevOps orchestration**: CodeArts MCP gives the agent the full ALM pipeline; documented "Issue Fix Flow" — pick a requirement/issue → create branch → fix → run checks → open MR → comment back to the issue (FACT, src: usermanual-space issue-fix flow docs).
- **Hooks**: lifecycle hooks (e.g. pre/post tool) exist in IDE/plugin config (FACT, src: 智能体设置/插件 docs — event list partially documented).
- **Scheduling/cloud execution**: automations/scheduled agents — NOT FOUND (searched: usermanual-space index, productdesc).

## 8. Extensibility

- **Skills center**: marketplace + custom skills via `.zip` upload (SKILL.md convention); org-level skill visibility control (FACT, src: 智能体设置 "技能管理").
- **Rules center**: team/enterprise rules published to members; project rules in repo (FACT, src: "规则管理").
- **Custom agents**: console UI + `codearts agent create` CLI flow; agents carry own prompt/model/tools/permissions — debuggable via `codearts debug agent` (FACT, src: CLI docs; 智能体设置 "智能体管理").
- **MCP**: arbitrary stdio/streamableHttp servers; CodeArts MCP as first-party; per-workspace config (FACT, src: codeartsagent_ug_0010).
- **Slash commands**: custom commands supported (CLI `/` menu extensible; SDD ships `/sdd-*` builtins) (FACT, src: CLI docs).
- **Model extension**: enterprise custom models registered in console (provider MaaS-style; OpenAI Chat Completions or Anthropic Messages API formats) and selectable in client (FACT, src: 企业管理 "模型配置"; productdesc).
- **Plugin/extension points for harness itself**: none public — NOT FOUND (searched: full doc set).

## 9. Session & state

- **Sessions**: `codearts sessions` lists/manages; `--fork` forks a session; `--attach` attaches to a running agent server; `--title` names; sessions resumable (FACT, src: CLI usage docs).
- **Agent Space state**: teams, task pools, member contexts persist per workspace; saved team templates reusable (FACT, src: usermanual-space_0003).
- **Indexes**: cloud-side index objects with per-tier file caps; incremental update; local TUI pulls index snapshot (FACT, src: Codebase docs).
- **Usage records**: `codearts stats` per-project/tool/model usage; console-level per-seat token consumption (FACT, src: CLI docs; 企业管理 "用量管理").
- **Knowledge/rules/agents**: server-side config objects, synced to clients (FACT, src: 智能体设置).
- **Rewind/undo checkpoints**: NOT FOUND (searched: CLI + IDE docs).

## 10. Model layer

- **Built-in lineup**: **GLM-4.7, GLM-5, GLM-5.1, DeepSeek-V3.2, and GLM-4.7-ArkTS-SPARK** — the last being a HarmonyOS/ArkTS-specialized variant (FACT, src: productdesc "模型"; 模型列表 docs).
- **Enterprise custom models**: console-registered models (MaaS providers, Huawei Cloud ModelArts-adjacent), API format OpenAI Chat Completions or Anthropic Messages; per-model **monthly token quotas**; model allowlists per org (FACT, src: 企业管理 "模型配置/额度").
- **Seat/tier gating**: 体验版 (trial) / 基础版 / 专业版 tiers; token budgets ~40M/150M per seat-month by tier; 企业版 planned (FACT, src: productdesc 版本规格/价格).
- **Routing**: fixed per-request model selection by user/agent — no auto-router documented (NOT FOUND, searched: model docs).
- **HarmonyOS specialization**: ArkTS-SPARK model + HarmonyOS-specific subagents/skills — the only surveyed harness with an OS-vendor-tuned coding model (FACT, src: productdesc "HarmonyOS"/ArkTS entries).

## 11. Notable mechanisms

1. **Managed codebase index as core context** (the survey's no-RAG counterexample): team/enterprise codebases are centrally indexed with keyword+semantic+graph retrieval and quota-tiered capacity (up to claimed 10M LOC); the TUI auto-downloads the org index — context comes from a governed shared index, not just live grep. Retrieval quality/mechanism beyond the marketing triad is undocumented (FACT/VENDOR-CLAIM, src: productdesc Codebase).
2. **Agent Team's shared task pool**: teammates autonomously *claim* tasks from a shared pool and keep persistent context across assignments — closer to an org-of-workers model (mailbox + task market) than a spawn-and-return subagent tree (FACT, src: usermanual-space_0003).
3. **SDD as a first-class mode**: 需求(EARS)→设计→任务→执行 with artifact files and phase gates productizes spec-driven development inside the harness rather than as a prompt convention (FACT, src: SDD docs).
4. **`--attach` daemon architecture**: the CLI exposes attach/fork over a local agent server (default :4096) — the harness is a resident service with thin front-ends, unusual among terminal agents (INFERENCE from CLI surface, src: CLI docs).
5. **Governance-as-product**: seat quotas, per-model monthly token caps, isolated repos, IP whitelists, SSO, and audit logs are marketed features — the control plane is the differentiator (FACT, src: productdesc 企业管理).
6. **CodeArts MCP**: a single MCP server fronting 8 DevOps modules turns the whole Huawei ALM suite into agent tools — deep vertical integration a standalone CLI can't replicate (FACT, src: codeartsagent_ug_0010).

## 12. Evidence log

- https://www.huaweicloud.com/intl/zh-cn/product/codearts/ai.html — product page: three forms, 码道 naming, DevOps positioning — accessed 2026-09-15
- https://support.huaweicloud.com/productdesc-codeartsagent/codeartsagent_01.html — 产品概述: forms, feature list (LSP, index, knowledge, skills, rules), 10M-line indexing claim, version tiers/quotas — accessed 2026-09-15
- https://support.huaweicloud.com/usermanual-space/codeartsagent_space_0000.html — Agent Space overview: multi-agent collaboration, task list, parallel tasks — accessed 2026-09-15
- https://support.huaweicloud.com/usermanual-space/codeartsagent_space_0003.html — Agent Team: leader orchestration, persistent teammate context, bidirectional comms, shared task pool, dynamic membership, failure recovery — accessed 2026-09-15
- https://support.huaweicloud.com/intl/zh-cn/usermanual-codeartsagent/codeartsagent_ug_0010.html — MCP guide incl. CodeArts MCP 8 modules — accessed 2026-09-15
- https://support.huaweicloud.com/usermanual-codeartsagent/ (CLI usage, codebase, agent create/debug, sessions/stats/self-upgrade, SDD commands, permission modes) — accessed 2026-09-15
- 智能体设置 docs (support.huaweicloud.com console guide) — agents/skills/rules/knowledge/codebase admin objects — accessed 2026-09-15
- 企业管理 docs — seats, model config, token quotas, security center (isolated repos, IP whitelist, SSO), audit/operation logs — accessed 2026-09-15
- Conflicts/gaps: implementation language/process internals not public; edit format, compaction, memory, exact retrieval architecture beyond "semantic+graph", and `--attach` protocol details NOT FOUND; 10M-line claim is vendor-asserted, not independently verified.
