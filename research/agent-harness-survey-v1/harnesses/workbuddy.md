# Tencent WorkBuddy (腾讯 WorkBuddy)

> Tencent (CodeBuddy team) · Proprietary freeware · TypeScript/Electron-class desktop (INFERENCE — closed; shares CodeBuddy engine) · First release 2026-03-09 (V1.0.0) · **Version studied: V5.5.6 (released 2026-09-10) · Date accessed 2026-09-15**
> Repo: none (closed) · Product: https://cloud.tencent.com/product/workbuddy · Docs: https://www.workbuddy.cn/docs/workbuddy
> Epistemic basis: DOCS-ONLY

## 1. Positioning & design philosophy

WorkBuddy is Tencent's answer to "OpenClaw for the office": a **local-first desktop work agent for non-engineers** — the pitch is literally "不用写代码，不用部署云端，你的电脑就是服务器" (no code, no cloud deployment, your computer is the server). Where OpenClaw is a developer-configured local agent, WorkBuddy packages the same shape (local file access, skills, MCP, IM-channel remote control) as a consumer-grade desktop product with built-in skills, an expert marketplace, and cloud-hosted assistants (FACT for product claims, VENDOR-CLAIM for marketing, src: cloud.tencent.com/product/workbuddy; workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide). It is explicitly marketed as **OpenClaw-skills compatible** and launched alongside OpenClaw itself getting deep Tencent integration (FACT, src: cloud.tencent.com/developer/article/2552179; ithome.com/0/923/414.htm). It is the sibling of **CodeBuddy** (Tencent's IDE/plugin/CLI coding agent — "WorkBuddy 与编程工具 CodeBuddy 是亲兄弟"): CodeBuddy targets R&D, WorkBuddy targets everyone else, and they share the same underlying engine (FACT that docs cross-reference each other; VENDOR-CLAIM for engine internals, src: cloud.tencent.com/product/workbuddy; Tencent docs).

## 2. Architecture overview

- **Client**: desktop app for Windows 10+ (x64/ARM64) and macOS 10.15+ (Intel/Apple Silicon); download `workbuddy-1.3.x` class installers from `copilot.tencent.com` (FACT, src: workbuddy.cn/docs/workbuddy; copilot.tencent.com/release). iPad/mobile app + WeChat mini-program ("WorkBuddy 小程序") provide thin surfaces.
- **Task model**: a task = a conversation bound to a **workspace folder** on the local disk; the workspace is where artifacts are written and what the agent may read/write by default (FACT, src: /docs/workbuddy/From-Beginner-to-Expert-Guide "每个任务对应一个工作空间（文件夹）").
- **Shared engine with CodeBuddy**: WorkBuddy's docs expose CodeBuddy-style config — `.codebuddy/` project dir (CODEBUDDY.md, rules/, agents/, skills/, commands/), identical permission-mode semantics, SKILL.md format, hooks spec — strong evidence the local runtime is the CodeBuddy agent engine re-skinned for office work (INFERENCE, src: workbuddy.cn/docs/workbuddy/CodeBuddy-CLI/*, /docs/workbuddy/project docs showing `.codebuddy` layout).
- **Cloud layer**: account (WeChat/QQ/phone login), 积分 credit billing, cloud assistant tasks (7×24), project spaces (members/sharing), skills market, expert market, Claw remote bridge to IM platforms (FACT, src: product pages + /Create-Task, /Assistant-Task docs).
- **Remote-control bridge ("Claw/助理")**: a cloud relay links the desktop client to IM platforms (WeCom/企业微信, QQ, Feishu, DingTalk, WeChat channels) — you chat in IM, WorkBuddy executes on your computer; an OpenClaw-style gateway pattern productized (FACT, src: workbuddy.cn/docs/workbuddy/Practice/实践六远程遥控 WorkBuddy; product page "Claw 远程遥控").

## 3. Agent loop

- **Understand → Plan → Act → Deliver**: natural-language task → WorkBuddy "自动分解任务、生成计划，并逐步执行直到交付完整成果" — execution steps are visible live, and the agent self-corrects mid-run ("能自我校验与修正，且交付结果可验收") (VENDOR-CLAIM for autonomy quality; FACT for the visible plan/step/deliver loop, src: cloud.tencent.com/product/workbuddy; /From-Beginner-to-Expert-Guide).
- **Task lifecycle states**: 规划中 (planning) → 进行中 → 已完成/失败/待处理/已归档; interrupt-and-resume mid-task ("任务中断后可通过对话框继续发送指令"); long tasks keep running while you work on others (FACT, src: /From-Beginner-to-Expert-Guide/Function-Description/Create-Task, /Assistant-Task).
- **Queue & interruption**: messages sent while a task runs are queued (排队) and consumed at the next model round; `Esc` interrupts; plan-mode/permission prompts block until answered (FACT, src: Create-Task docs "排队机制"; Permission-Modes).
- **Expert-team loop**: picking an expert team → "团长" (leader) decomposes the task, assigns to member experts, executes in parallel, and the leader integrates results — a hardwired leader/parallel-worker pattern (FACT, src: /Function-Description/Expert-Center "专家团队协作逻辑").
- **Modes**: 工作模式 (Work — file/doc/browser-oriented) vs 编程模式 (Coding — CodeBuddy-grade tools: file edits, terminal, MCP dev); Full Access permission mode is a separate axis (FACT, src: Create-Task "工作模式/编程模式"; Permission-Modes).

## 4. Tool system

- **Local file tools**: read/write/edit inside the authorized workspace directory — documents, spreadsheets, media; writes go through the artifact/output panel where you "一键导出" results (FACT, src: product page "本地文件读写"; /From-Beginner-to-Expert-Guide).
- **Shell/script execution**: commands run in a sandboxed terminal with per-command confirmation in default mode; background terminal output is inspectable (FACT, src: /Permission-Modes "脚本、命令、网络与敏感能力"; changelog "后台终端输出").
- **Office suite via skills**: the 20+ built-in skills cover Word/Excel/PPT/PDF generation and parsing, browser automation (built-in "Agent Browser" skill + browser panel), image/video generation, email (QQ Mail "我的邮箱" assistant tool), schedule creation, Git ops, code project indexing ("code 项目索引" tool config), document info extraction, image info extraction (FACT, src: product page "内置 20+ Skills"; changelog 5.5.x entries; /Assistant-Tool).
- **Connectors (MCP+CLI)**: "通过连接器（MCP+CLI）支持" external tools; a CLI-tools category connector runs local CLI utilities; browser plugin connector for web control (FACT, src: product page; changelog "CLI 工具 connector").
- **IM send tools**: assistant tasks can send results into WeCom/QQ/微信 conversations via configured channels (FACT, src: /Assistant-Tool "IM 发送").
- **Screen/input control**: computer-use class skills (mouse/keyboard/screen read) exist in the skill set (INFERENCE from skill-permission categories "屏幕与输入控制" in /Permission-Modes).
- **Edit mechanism**: file diffs are shown for review; actual edit format (search-replace vs whole-file) NOT FOUND (searched: full docs set).

## 5. Context management

- **`@` references**: `@` mentions local files/folders and project assets into the prompt; long pasted content becomes an attachment rather than inline text (FACT, src: Create-Task docs).
- **Project instructions**: `.codebuddy/` config — CODEBUDDY.md memory file, `rules/` rule files, `agents/` custom subagents, `skills/`, `commands/` slash commands — project-level overrides user-level; described verbatim in the shared CodeBuddy CLI docs surfaced from workbuddy.cn (FACT, src: /docs/workbuddy/CodeBuddy-CLI/config-files).
- **Personal memory**: nightly job extracts personal preferences/work context from the day's conversations into memory; injected into the system prompt on new tasks; history-retrieval tool for past work (FACT, src: changelog 5.x "记忆能力优化：每晚自动提取当日对话中的个人偏好与工作上下文写入记忆").
- **Project 资料库 (asset library)**: project space members drop reference files (MD/CSV/HTML…) into a shared library the agent reads/writes; version history on assets (FACT, src: /Function-Description/Project "资料库").
- **Skills as context**: enabled skills auto-inject their descriptions into system prompt and load bodies on demand — standard progressive-disclosure skill protocol (FACT, src: /Skills docs).
- **Compaction**: context summarization exists ("压缩历史上下文" changelog entry) but trigger/window details NOT FOUND (searched: changelog, context docs).

## 6. Safety model

- **Two permission modes**: **默认权限** (default) prompts on every risky action — protected/sensitive-path writes, important or bulk file deletion, scripts/commands, network and sensitive capabilities (browser control, screen/input control, MCP tools, connectors, CLI tools); **Full Access** disables almost all confirmations for the current task (FACT, src: /Function-Description/Permission-Modes).
- **Sandbox model**: "命令优先在沙箱环境执行" (commands run sandboxed first); delete protection sends deletes to a safe-delete/recycle path instead of `rm`; existing files are backed up before modification (backup currently Windows-only) (FACT, src: /Permission-Modes "沙箱机制/删除保护/文件备份").
- **Skill supply-chain warnings**: third-party skills get explicit warnings — may contain malicious instructions, prompt-injection, over-collection of private files, account theft, unauthorized paid-API calls; disable promptly if abnormal (FACT, src: /Permission-Modes "第三方技能风险" — notable because they ship OpenClaw-compat skills).
- **Sensitive-content dedup**: same sensitive-file prompt only confirms once (changelog fix).
- **Remote-access security**: 助理/Claw remote commands use "多层次的来源校验机制" (multi-layer origin verification); high-risk operations via IM still require explicit confirmation; account binding by scan/login (FACT, src: product page "远程访问安全保障"; 实践六).
- **Enterprise tier**: audit logging of org actions, unified account/billing via CodeBuddy console, skill governance (blacklist/whitelist, visibility-scope control on market/uploaded skills), security-center policies (FACT, src: /Enterprise related docs "成员管理/审计/安全治理").

## 7. Orchestration

- **Parallel multi-task**: multiple windows/tasks run concurrently; task list shows parallel progress; per-window task isolation (FACT, src: Create-Task "并行处理").
- **Expert teams**: leader expert decomposes → parallel member experts → leader integrates; teams are assembled in the Expert Center (100+ prebuilt experts across product/ops/design/data/legal/etc.) (FACT, src: /Expert-Center).
- **Project spaces (协作空间)**: shared multi-member workspaces bundling 共享说明 (shared instructions), connectors, experts, skills, 资料库 files, and task conversations; tasks can be **shared, handed off (转交), or collaboratively run**; in shared tasks, "个人" (personal-auth) connectors are force-disabled — only shared/public-auth connectors run, so one member's private credentials can't leak into a teammate's session (FACT, src: /Function-Description/Project — an unusually explicit shared-credential boundary).
- **Cloud-persistent tasks**: 云端助理任务 keep running after the client closes — "7×24 云端托管" (FACT, src: product page; /Assistant-Task).
- **Scheduled automation**: scheduled tasks on the desktop for recurring work (changelog "自动化任务" entries).
- **IM remote control**: Claw bridges desktop execution to WeCom/QQ/Feishu/DingTalk/WeChat chats — send a message, the desktop agent works, replies stream back; local client can be offline→task waits? (NOT FOUND whether remote commands queue when desktop is offline; searched: 实践六, product page).
- **CodeBuddy CLI agent teams** (sibling, same engine): team-lead + teammate agents with shared task list and inter-agent mailbox, `delegate mode`, spawn from prompt/JSON file — evidence of the multi-agent substrate WorkBuddy's expert teams presumably reuse (INFERENCE, src: /docs/workbuddy/CodeBuddy-CLI/agent-team).

## 8. Extensibility

- **Skills**: 20+ built-ins; skills market (browse/search/install); **import local skill as .zip** (supports OpenClaw-format skills); "描述需求找技能" (describe-and-find) and "描述需求造技能" (describe-and-create — agent writes a new SKILL.md for you, i.e. skill self-authoring) (FACT, src: /Skills docs; changelog 5.x).
- **OpenClaw compatibility**: OpenClaw skills install directly — the compatibility claim is a headline product feature (FACT for claim, src: product page; press coverage).
- **MCP/connectors**: custom MCP servers configurable; connectors panel merges MCP + CLI tools (FACT, src: product page "MCP 协议"; Create-Task connector section).
- **Custom experts**: define an expert = 人设 (persona) + 方法论 (methodology prompts) + 工具链 (tool/skill subset); publishable to the expert market (FACT, src: /Expert-Center).
- **Slash commands**: `.codebuddy/commands/*.md` custom commands (shared-engine feature; FACT, src: CodeBuddy-CLI config docs on workbuddy.cn).
- **Hooks**: CodeBuddy-engine hooks (PreToolUse etc.; command/prompt/agent/http types) documented in the same docs tree — presumed available (INFERENCE, src: CodeBuddy-CLI hooks docs).
- **ima 知识库 integration**: Tencent's ima knowledge-base product plugs in as a knowledge connector (FACT, src: product/changelog "ima 知识库").

## 9. Session & state

- **Task persistence**: tasks persist per workspace; reopening a workspace restores its task list; archive/restore/delete lifecycle; auto-archive candidates by age; workspace folders renameable (settings write back) (FACT, src: Create-Task/From-Beginner-to-Expert-Guide).
- **Resume**: interrupted tasks resume via the same conversation; queued messages survive restarts (changelog fix "重启后排队消息恢复").
- **Sharing**: share a task via public link (协作者只读 or continue?); task 转交 moves ownership within a project space (FACT, src: /Project docs; changelog "分享对话").
- **Cross-session memory**: personal memory + project 资料库 carry context across sessions; conversation-history search (FACT, src: changelog; /Project).
- **Draft/attachment state**: draft tasks, attachment panel, output artifacts panel with export (FACT, src: Create-Task).
- **Cloud state**: assistant tasks and their schedules live server-side (survive client shutdown); project-space membership/assets server-side (FACT, src: /Assistant-Task, /Project).
- **Session forking / branching**: NOT FOUND (searched: Create-Task, From-Beginner-to-Expert-Guide).

## 10. Model layer

- **Built-in multi-model switching**: switchable per task among **Hunyuan (Hy3), GLM (5.2/5.1/5v-Turbo), MiniMax (M3/m2.7), Kimi (K3/K2.7-Code/K2.6), DeepSeek (V4-Flash/V4-Pro)** — the advertised set is Hunyuan/DeepSeek/GLM/Kimi/MiniMax (FACT, src: changelog 5.x model entries; press ithome.com/0/923/414.htm).
- **Tier presets**: 快速/均衡/极致 (fast/balanced/max) performance tiers map to model+effort combos; per-task reasoning-strength and context-length controls (changelog "上下文长度设置", "思考强度") (FACT, src: changelog).
- **Custom models**: local `models.json` (or settings UI) registers OpenAI-compatible/custom endpoints; API keys stored locally only; config hot-reloads without restart (FACT, src: changelog "自定义模型 models.json / 热重载"; /From-Beginner-to-Expert-Guide 自定义模型).
- **Billing**: free tier + 积分 credits; Token Plan option routes usage to a token plan (FACT, src: changelog "Token Plan"; product page pricing).
- **Sub-model assignment**: whether expert-team members can run different models — NOT FOUND (searched: Expert-Center docs).

## 11. Notable mechanisms

1. **OpenClaw-compat as a distribution strategy**: rather than inventing a skill format, WorkBuddy adopted OpenClaw's — instantly inheriting a community skill ecosystem — then wrapped it in GUI install/describe-to-create flows and added prompt-injection warnings for third-party skills (FACT, src: product page; /Permission-Modes).
2. **The Claw bridge**: a consumer productization of OpenClaw's gateway pattern — persistent IM channels (WeCom/QQ/Feishu/DingTalk/WeChat) remote-drive the desktop with multi-layer source verification, so "send a WeCom message → agent works on your PC → artifacts stream back" (FACT, src: 实践六; product page).
3. **Shared-credential isolation in project spaces**: personal-auth connectors are forcibly disabled in shared/collaborative tasks — a concrete, documented mitigation for credential leakage across collaborators that most agent products leave implicit (FACT, src: /Project docs).
4. **Engine sharing with a coding agent**: the office agent and the IDE/CLI coding agent (CodeBuddy) are explicitly one engine — WorkBuddy's "编程模式" toggles into the coding toolset; evidence that Tencent treats "work agent" and "coding agent" as UX layers over one harness (INFERENCE supported by shared `.codebuddy` config/permission/docs).
5. **Leader-integrator expert teams**: fixed decomposition→parallel→integration topology as a product object (named teams, leader role), not just an emergent prompt pattern (FACT, src: /Expert-Center).

## 12. Evidence log

- https://cloud.tencent.com/product/workbuddy — product overview: local-first positioning, 20+ skills, MCP, experts, cloud tasks, IM integrations, "CodeBuddy 亲兄弟" — accessed 2026-09-15
- https://www.tencentcloud.com/zh/products/workbuddy — international product page (EN/中文) — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy — docs root/download/platforms — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Create-Task — task model, workspace folders, work/coding modes, queue/Esc, parallel tasks, models — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes — default vs Full Access, sandbox, delete protection, file backup (Windows), third-party skill risks — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Expert-Center — 100+ experts, team leader decomposition/parallel/integration — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project — project spaces: shared instructions/connectors/experts/skills/资料库; task share/handoff/collab; personal-connector disable — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Practice/实践六远程遥控 WorkBuddy — Claw IM remote control flow — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Assistant-Task + Assistant-Tool — cloud 7×24 tasks, IM-send/email tools — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/changelog (5.5.6, 2026-09-10) — models.json custom models, nightly memory extraction, context-length controls, compression, background terminals — accessed 2026-09-15
- https://www.workbuddy.cn/docs/workbuddy/CodeBuddy-CLI/* (config-files, hooks, agent-team, skills) — shared-engine config model `.codebuddy/`, permission semantics, agent teams — accessed 2026-09-15 (sibling-architecture evidence, not proof of internal identity)
- https://cloud.tencent.com/developer/article/2552179 — Tencent Cloud Dev Community launch coverage (OpenClaw-compatible, Hunyuan/DeepSeek/GLM/Kimi/MiniMax switching) — accessed 2026-09-15
- https://www.ithome.com/0/923/414.htm — IT之家 launch report (2026-03): positioning, model list, OpenClaw compatibility — accessed 2026-09-15
- Conflicts/gaps: internal loop/retry/compaction mechanics undocumented; edit diff format undocumented; expert-team per-member model assignment undocumented; offline-queueing of IM commands undocumented; exact boundary between WorkBuddy client and CodeBuddy engine is inferred from shared config/docs, not verified binaries.
