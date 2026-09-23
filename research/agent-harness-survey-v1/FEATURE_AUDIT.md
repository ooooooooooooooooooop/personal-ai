# FEATURE_AUDIT.md — 26 个参考 harness 功能级对照审计

> **Created**: 2026-09-18 · **Status**: COMPLETE — 26/26 harness 全覆盖，缺口清单待用户裁定优先级
> **定位**: 与 `ADOPTION_MATRIX.md`（机制层终态表）互补——本文件按**真实用户功能面**逐项盘点：开屏能干什么、会话中有什么、完成任务有哪些面，对照 Personal AI 实际能力逐条标注。
> **判定图例**: `✅` 已有（用户可用、有实证） · `🟡` 部分（有机制但面不全/语义不同） · `❌` 缺失（用户层面没有） · `⛔` 不适用-拒绝（边界外或有意拒绝，附理由）
> **证据口径**: 对方功能以 `harnesses/<name>.md` 研究文档 + 官方文档为准；我方状态以 `1d75cd0` 冻结锚的代码与测试为准（命令面 = host channel `case` 清单 + `app/ui/app.js` slash/面板；身体能力 = pi/dsh adapter）。
> **注意**: 外部评审已对 UX 基线裁 ACCEPT/FREEZE（锚 1d75cd0）——那是**体验质量**裁决；本文件衡量的是**功能覆盖度**，两者不冲突。

## 0. Personal AI 功能基线（我方现状快照，锚 `1d75cd0`）

**壳/平台**: 桌面 Electron 壳 + 零构建网页 UI（`app/ui`）+ 零依赖 HTTP/SSE 桥（`app/server`）；单用户本地单机；无移动/Web/IDE/headless-CLI 产品面。

**开屏/入口**: 无模型时 setup 引导卡接管空态（provider/密钥/模型选择）；设置页：provider 管理（含自定义 OpenAI 兼容端点）、密钥（`$ENV` 引用不落盘）、推理档、模型列表、workdir 目录浏览；empty-state starters。无逐步 onboarding 向导、无主题切换（固定暗色）、无更新通道。

**输入/composer**: 多行输入、Shift+Enter 换行；运行中队列（排队卡：文本+[立即发送=steer]+[编辑]+[排序]+[×]）；`@`文件引用附着真内容；粘贴/拖拽文本与图片（图片走 `PromptOptions.images`，R9 实证）；`/` slash 菜单 26 条；用户宏 `/macro`（保存模板，`/名字` 调用，`/unmacro` 删）；模型 chip + 推理档 chip。

**会话管理**: 侧栏会话列表（日期分组/搜索/全文命中片段）；新建/切换/重命名/删除/分支 fork/resume；`session_entries`+`session_rewind`（navigateTree 回任一提问点、editorText 回填、分支不删）；`/reset` 双 scope 回退（会话+文件改动一并还原）；`session_compact`（手动压缩+compaction 事件行）；`session_export`（HTML）；`session_stats`（真账含压缩前）；全文搜索 `session_search`。

**执行中控制**: abort；steer（排队消息立即转向）；批准卡（允许一次/允许本会话/拒绝+倒计时+排队数+**截断警示**：`argsTruncated`/`argsTotalChars` 经 PendingAsks→事件→重连 pending_list 全链透传）；`/plan` 只读模式/`/act` 恢复（risk_mode 真机实证）；auto_retry 事件行。

**工具可见性**: 工具卡（动词分类、cmd/diff/输出分块、已知键结构化不再被 JSON pre 覆盖）；思考流式行；消息操作栏（复制/重发/重新生成）；元信息 chip（模型+tok+cost）；处理计时行+子状态；活动组折叠；错误卡+详情折叠；todo 面板实时刷新；job 详情投影（checkpoint command/result/output_tail/events）+取消按钮；审计视图（筛选+展开 payload）；状态行五要素（model/mode/ctx/cost/workdir）；toast；侧栏折叠。

**任务/委派**: durable jobs（跨重启，`job_list`/`job_status`/`job_cancel`——终态保护+win32 taskkill 杀树）；`delegate_task`（跨 agent 委派：预算原子记账+准入门+usage 归属父 run）；update_todos。

**上下文**: 手动+自动 compaction；`@`文件附着；AGENTS.md（pi 原生 ResourceLoader 加载+`/init` 生成）；无向量/embedding 索引（有意，与业界收敛一致）。

**治理/安全**: policy.json 规范锚+sha256+drift fail-closed；7 类风险分类；lattice deny>负能力>ask>allow；PendingAsks 标准通路（审计 GOVERNANCE_ASK/RESOLVED/ADMITTED）；FileOpsGuard 回执（可恢复删除/备份）；写租约（canonical writer+fencing）；委派预算门；审计流。无 OS 级沙箱。

**多身体**: pi/dsh 双身体；body 面板；`body_select` 显式切换+七态 fail-closed handoff（有会话时真切换）；supervisor。

**模型**: `model_list`/`model_set`/`model_status`；`thinking_set`；`provider_add`（OpenAI 兼容）；`auth_set_key`/`auth_clear`（`$ENV` 引用）；`budget_status`+预算门（超限中止）。

**持久化**: instance root 运行态；会话持久化（`<instance>/sessions`）；durable jobs；审计 JSONL。

**扩展**: managed extensions 机制（manifest sha256 装载，当前空）；宏；slash。无 hooks、无 MCP 客户端、无插件市场（有意拒绝）、无 skills 运行时加载（skills/ 是发布仓层不是运行时面）。

**出口**: export HTML；审计导出。无 PR/commit 集成、无 CI/headless 用户面。

---

## 1. PI-Desktop（vastsa/PI-Desktop · Electron 桌面 · LGPL-3.0）

> 本机审计副本 `C:\Desktop\pai-eval\PI-Desktop`；功能清单已在 `app/UI-BACKLOG.md` 逐项登记（250 条 chat 文案全核）。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | Onboarding 清单（配模型/开项目/发第一条） | 🟡 | 有 setup 空态卡+设置页，无清单式向导（BACKLOG C12/R8 未落） |
| 输入 | 待发队列卡（文本+立即发送转向+编辑+排序+删除） | ✅ | B1 R3 已落 |
| 输入 | 占位符双态+快捷提示+运行中发送提示 | ✅ | B2/B3 R3 |
| 输入 | `@`/`/` 自动完成浮层 | ✅ | slash 26 条+@文件附着（B7 R6） |
| 输入 | 粘贴超长文本自动转附件 chip | 🟡 | 文本内联附着已有；"超长自动转附件"语义未做 |
| 输入 | 拖入文件夹添加为项目/参考目录 | ⛔ | 无"项目"概念；workdir 走 set_workdir（B9 判定不做） |
| 会话 | 会话列表（置顶/今天/昨天/7天/14天分组+状态点+hover卡） | ✅ | 置顶独立分组+日期分组+搜索；状态点诚实映射（任务绑定非终态/当前会话 busy→绿点，归档→空心点，完成/未完成不可判定不造数）；hover 卡含 cwd/修改/创建/条数/标记 |
| 会话 | 右键菜单（重命名/置顶/归档/分支/复制ID/打开路径/删除二次确认） | 🟡 | 右键菜单已有（打开/重命名/复制路径/分支/导出/删除）；置顶/归档无 |
| 会话 | Ctrl+K 搜索会话与消息 | ✅ | C2 R6+全文搜索 |
| 执行 | PermissionCard（风险等级+允许一次/本次对话/拒绝+倒计时+排队数） | ✅ | D1 已落+R9 截断透传 |
| 执行 | 处理计时行+子状态（等待模型/压缩中/N秒后重试） | ✅ | A4 R3+compaction/auto_retry 事件行 |
| 可见性 | 思考行（流式+展开）、活动组折叠、工具动词分类、结构化输出块 | ✅ | A1/A5/A6/A7 已落 |
| 可见性 | 失败回合卡 TurnOutcomeCard（可继续） | ✅ | A8 R4 |
| 可见性 | 上下文压缩行、消息元信息 chip、消息操作栏 | ✅ | A10/A3/A2 |
| 上下文 | ContextUsageInspector 环形/条形用量+成本分解点开 | 🟡 | 状态行 ctx/cost 数字有；环形条+分类分解（输入/输出/缓存/推理/工具）未做（D3 R4 登记） |
| 任务 | 委派子智能体拓扑（Task 卡+子进度 2/3） | 🟡 | delegate_task+job 详情有；拓扑树未做（A13 R7） |
| 导航 | 对话 minimap（消息格跳转）、长会话分页加载 | ❌ | A11/A12 R7 未落 |
| 壳 | 侧栏折叠、对话宽度拖拽把手、dark/light+主题市场、无边框 titlebar | 🟡 | 侧栏折叠已落；宽度拖拽/主题/自绘 titlebar 未做 |
| 壳 | 启动闪屏、Toast 通知中心+历史、状态栏连接语义 | 🟡 | toast+状态行已有；闪屏/通知历史中心未做 |
| 壳 | 更新横幅 | ⛔ | 无发布通道（判定不做） |
| 独有 | MCP/插件/Skill 市场 | ⛔ | managed-manifest 治理装载，拒绝市场 |

**缺口小结**: 交互工艺主体已齐；剩余真实缺口 = minimap、长会话分页、委派拓扑、上下文用量分解条、置顶/归档、主题切换、onboarding 向导、闪屏。

---

## 2. Claude Code（Anthropic · CLI/IDE/Desktop/Web/Mobile/Cloud · 闭源）

> `harnesses/claude-code.md`；~44 内置工具、~30 hook 事件、6 档权限模式。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `/doctor` 自检、`/init` 写 CLAUDE.md、`/login` 订阅/API 多路 auth | 🟡 | `/init` 有（写 AGENTS.md）；自检/auth 向导无 |
| 输入 | `@path` 引用、`!`bash 前缀直跑、`#`记忆前缀、图片粘贴、多行 | 🟡 | @文件+图片已有；`!`bash 直跑、`#`速记无 |
| 输入 | slash 命令族（/clear /compact /cost /context /review /security-review /vim /model /permissions /agents /mcp /hooks …） | 🟡 | 26 条覆盖会话/模型/导出等核心；缺 /review、/context 分解、/permissions 编辑面 |
| 会话 | `--resume`/`--continue`、fork、EscEsc rewind 编辑历史消息、/compact 自动+手动 | 🟡 | resume/fork/rewind/compact 全有；rewind 不含"编辑历史消息重发"（我们只有 editorText 回填+分支） |
| 执行 | 权限模式 6 档（default/acceptEdits/plan/auto/dontAsk/bypassPermissions）+ allow/ask/deny `Tool(specifier)` 规则 | ✅ | lattice deny>负能力>ask>allow+risk_mode plan/act；规则语法等价物=policy.json |
| 执行 | `auto` 模式分类器自动批准（后台安全检查） | ❌ | 静态 fail-closed 解析器；LLM 权限分类器是登记候选未做 |
| 执行 | OS 沙箱 Bash（Seatbelt/Bubblewrap/socat+seccomp，域名 egress allowlist，首击提示） | ❌ | 无 OS 级沙箱；只有 policy 门+写租约+workdir 边界 |
| 执行 | 排首消息转向+Esc 中断+双击 Esc rewind | ✅ | steer/abort/rewind 已落 |
| 可见性 | 工具调用 diff 预览、todo 面板（TodoWrite）、任务列表 `/tasks`（含 subagent model/effort） | 🟡 | 工具卡+todo 已落；/tasks 无 subagent 拓扑视角 |
| 上下文 | CLAUDE.md 四层（managed/user/project/local）+`.claude/rules/` glob 规则+`@import` | 🟡 | AGENTS.md 单层加载（pi 原生）；多层合并+glob 规则+import 无 |
| 上下文 | auto memory（自写仓级笔记、跨 worktree、子代理各自维护） | ❌ | 无运行时自写记忆（soul 是认知态层，非同物） |
| 上下文 | ToolSearch 延迟加载工具 schema | ❌ | 工具面小暂无需求；登记候选 |
| 协作 | subagents（.claude/agents md+frontmatter：tools/model/permissionMode/isolation:worktree/background）、内置 Explore/Plan、后台白名单过滤 | 🟡 | delegate_task 跨 agent 委派+预算门；无 frontmatter 自定义、无内置 profile、无后台 subagent 面板 |
| 协作 | agent teams 跨会话消息（SendMessage/ListAgents）、RemoteTrigger 云例程 | ❌ | 无跨会话消息/远程触发 |
| 协作 | EnterWorktree git worktree 隔离 | 🟡 | 委派侧 M13 已落（delegate worktree:true 独立检出，脏保留+审计）；操作员侧 `/worktree`+`job_spawn` 已落（同 decide 链，§28.32）；frontmatter `isolation:worktree` subagent profile 面仍无 |
| 持久化 | CronCreate 会话级定时任务（resume 恢复）、Monitor 后台命令流式回事件 | ❌ | 无定时任务；job 有持久化但非 cron |
| 扩展 | hooks ~30 事件（Pre/PostToolUse、PermissionRequest、PreCompact、SessionStart…）handler=shell/HTTP/MCP/LLM | ❌ | 无 hooks 体系 |
| 扩展 | skills（SKILL.md+`!cmd`动态注入）、plugins+marketplace、MCP 一等、LSP 工具 | ⛔ | skills/plugins 市场=managed-manifest 拒绝；MCP/LSP 客户端无 |
| 平台 | CLI+IDE+Desktop+Web+Mobile+Cloud 同 loop；Agent SDK；`-p` headless | ⛔ | 单桌面 app 面；SDK/headless 是层外能力（host channel 程序化但非用户产品面） |

**缺口小结**: 治理骨架对等甚至更深（lattice+fencing 比 ask/deny 规则严），但**用户功能面**缺口集中在：hooks 事件面、自定义 subagent 定义、worktree 隔离、OS 沙箱、cron/Monitor、多层指令+auto memory、ToolSearch、`!`bash/`#`速记、`/review` 类成品命令。

---

## 3. Cursor（Anysphere · IDE fork + cursor-agent CLI + Cloud Agents · 闭源）

> `harnesses/cursor.md`；Agent/Ask/Plan/custom 模式、checkpoints、Agents Window、Bugbot。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | IDE 导入 VS Code 配置、登录订阅、codebase index 自动建 | 🟡 | 无 IDE；setup 卡对等登录面 |
| 输入 | Agent 面板 composer + inline edit（Cmd+K）+ Tab 补全 + @引用 + 图片 | 🟡 | @文件+图片有；inline edit/Tab 补全是编辑器能力不适用 |
| 会话 | 会话持久化+resume/fork；**per-turn checkpoints 快照文件态可一键回滚**（独立于 git） | 🟡 | rewind（会话态）+fileops 回执（文件态）双 scope；非"每回合自动快照"——`/reset` 手动触发 |
| 执行 | 模式 Agent/Ask/Plan/custom；队列消息转向；question/clarification 工具（agent 结构化提问暂停等答） | 🟡 | plan/act+steer 有；**结构化提问工具无**（我们只有 ask 批准卡，非开放问答） |
| 执行 | Run 策略：Auto-Run+allowlist / Run Everything / 全手动；Auto-Review 标危险命令 | 🟡 | 风险分类+lattice 同构；allowlist 语法/policy 编辑面弱 |
| 执行 | OS 沙箱（Seatbelt/Landlock/seccomp+网络策略） | ❌ | 同上，无 OS 沙箱 |
| 可见性 | diff review/accept/revert 每文件、review UI | 🟡 | 工具卡 diff 展示有；无"逐文件 accept/revert"review 面 |
| 上下文 | `.cursor/rules/*.mdc`（frontmatter globs/alwaysApply）+AGENTS.md+团队 rules | 🟡 | AGENTS.md 有；glob-scoped 规则无 |
| 上下文 | codebase indexing → **已退役**转 Instant Grep 本地 trigram 索引 | ⛔ | 向量索引拒绝方向一致；trigram 本地索引未做（grep 够用层面） |
| 协作 | 内置 subagents（Explore/Bash/Browser）+`.cursor/agents/` 自定义+前后台 | 🟡 | delegate_task；无内置 profile/自定义文件 |
| 协作 | **Agents Window** 多 agent 并行管理面；Cloud agents（VM 隔离+branch/PR+artifacts+Slack/GitHub/Linear/API 触发） | ❌ | 无并行 agent 管理面；云 agent 产品形态不同 ⛔ |
| 协作 | Bugbot PR review 服务 | ⛔ | 无 SCM 集成面 |
| 持久化 | checkpoints/会话历史；shared-transcript 导出 | ✅ | export HTML+会话持久化 |
| 扩展 | rules/hooks.json/skills/plugins/MCP（含 MCP Apps/elicitation） | ⛔ | 同 Claude Code 边界 |
| 模型 | Auto=Cursor Router 路由；Composer/Fast Apply/Tab 专有模型；多厂选择 | 🟡 | 单模型显式选；无路由、无专有 apply 模型 |
| 平台 | IDE+CLI（ACP server）+Cloud | ⛔ | 单桌面面 |

**缺口小结**: 对单机桌面形态不适用的占大头（IDE/云 fleet）；真实可迁移缺口 = **结构化提问工具**、per-turn 自动 checkpoint、自定义 mode 定义、Agents Window 式多任务并行面。

---

## 4. Cline（VS Code ext + CLI + cline-hub daemon + Tauri desktop · Apache-2.0 · SOURCE-READ）

> `harnesses/cline.md`；SDK 化 agent loop、hub-and-spoke 会话权威、in-repo checkpoint refs、agent teams。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `cline auth`/`doctor`、provider 选择（~200 provider 规格目录） | 🟡 | provider_add+setup 卡；无 doctor/目录式浏览 |
| 输入 | Plan/Act 模式切换、auto-approve 逐项开关（读/编辑/命令/MCP 分类） | ✅ | plan/act+风险分类 lattice（比逐项 toggle 更严的默认 deny 方向） |
| 会话 | 任务历史（SQLite sessions.db）、checkpoint 回滚=**git stash refs**（refs/cline/checkpoints/，含 untracked 第三父、事务式 restore 拒分支漂移） | 🟡 | 会话持久化+双 scope rewind；非 git-ref 快照语义，文件回退靠 FileOpsGuard 回执（只覆盖经 guard 的写） |
| 执行 | ask 批准流（diff 预览先于批准）；`submit_and_exit` 完成工具；连续错误限停止 | ✅ | 批准卡+载荷展示；完成语义=无工具调用回合；auto_retry 有，连续错误上限无显式面 |
| 执行 | "proceed while running" 前台命令 detach 成后台 log（PID+start-token 防 PID 复用） | ❌ | job 系统有持久化后台，但无"运行中一键转后台"语义 |
| 可见性 | diff preview+autoApprovePreviewLinger；工具输出结构化；context 进度条 | 🟡 | 工具卡 diff 有；context 进度条无（状态行数字） |
| 上下文 | `.clinerules`/`.cline/rules`+`.cline/cron/*.md`；compaction 0.9 触发/basic+agentic 双策略 | 🟡 | AGENTS.md 有；rules 目录+cron 无；compaction 手动+auto |
| 协作 | `spawn_agent`+**agent teams**（teammate 常驻+mailbox+共享任务库+outcome artifacts，SQLite 持久化 team 状态） | 🟡 | teammate（`delegate_task name=` 常驻+`teammate_msg` 按名投递+mailbox inbox/outbox/events 持久化）+**team 名册/广播**（`team=` 分组、`team_msg` 扇出、`task_list team=` 过滤，§28.33）已落；多对多任务池仍按裁定书 v1 外项推迟 |
| 协作 | **cline-hub**：detached daemon 持会话，CLI/VSCode/desktop/automation 多客户端 attach 同一权威 runtime | ❌ | supervisor 单 app 实例；无多客户端 attach |
| 持久化 | cron（.cline/cron md 规格+SQLite store+schedule 工具）；stale session 对账 | ❌ | 无 cron；session 状态机有但无 stale 对账面 |
| 扩展 | hooks（文件型 TaskStart/PreToolUse…+in-process hook 点，可 appendContext）、plugins（sandbox 隔离装载）、skills 工具、MCP（stdio/sse/http+OAuth）、slash 自定义、remote-config 企业指令 | 🟡 | 全部无对应物；宏/slash 有；MCP/hooks/plugins ❌（plugins 市场拒绝） |
| 模型 | ~200 provider 目录+BYOK+cline 托管 provider+model-tool routing | 🟡 | provider_add OpenAI 兼容+密钥；无目录浏览/托管 provider |
| 平台 | VS Code+CLI TUI+hub daemon+desktop+headless+SDK+ACP | ⛔ | 单桌面面（SDK/hub 多客户端是形态差异） |

**缺口小结**: 真实可迁移缺口 = **agent teams（常驻 teammate+mailbox）**、hub 多客户端、cron、文件型 hooks、"proceed while running"、逐项 auto-approve 配置面。

---

## 5. Devin（Cognition · Cloud VM sessions→PR + Devin CLI/Desktop · 闭源）

> `harnesses/devin.md`；session=独立 VM→PR、blueprint 环境即代码、CLI 5 档权限+OS 沙箱。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | blueprint YAML→build→snapshot（每会话同构已知好机器）；knowledge/playbook 组织级预置 | ⛔ | 环境即代码面向云 VM 舰队；本地单机无对应需求（workdir+AGENTS.md 是最小等价） |
| 输入 | `!macro` playbook 调用、`@`-mention plans、`-p` headless | 🟡 | 宏有（无版本库/团队库）；plans 持久化目录无；headless ⛔ |
| 会话 | 会话持久化+`-c`/`-r` resume+`/ls`+`/continue`+`devin rm`；plans `~/.devin/plans/*.md` 跨会话可引用 | 🟡 | 会话 CRUD+resume 有；plan 是模式不是持久 artifact——**plans 库缺口真实存在** |
| 会话 | `/btw` 只读 side chat（fork 上下文的旁路问答） | ❌ | 无旁路只读问答（fork 是全量分支） |
| 会话 | `/debug` 导出含前后台 subagent 链的 trajectory | 🟡 | export HTML+audit；无 subagent 链视图 |
| 执行 | 权限 5 档（Normal/AcceptEdits/Smart/Bypass/Autonomous）+deny>ask>allow `Tool(glob)` 规则+admin 永不覆盖 | ✅ | lattice+risk_mode+policy.json 同构；admin 层≈规范锚 |
| 执行 | **Smart 模式**：快模型判"明确安全"动作+硬编码 never-auto 清单（装包/git 变更/rm/sudo/凭据文件） | ❌ | 无 LLM 判断层；静态分类器 fail-closed（候选未做） |
| 执行 | `--sandbox` OS 级隔离（写路径=workspace+授权 scope；`Read()` deny 直接隐藏路径；不可用即 fail-closed 拒绝启动；loopback 网络代理域名表） | ❌ | 无 OS 沙箱（win32 更难；我们靠 policy+写租约+workdir 包含校验） |
| 执行 | 长命令自动转后台+background shell ID 可 poll | 🟡 | jobs 是显式持久任务；无"命令自动后台化" |
| 可见性 | 工具名 title-case 化（"Read lines 10-20…"）、大 diff 截断尾 50 行、Progress tab | ✅ | 工具卡动词分类+输出截断同等 |
| 上下文 | AGENTS.md+Rules+`.devin/`+skills 多路径自动装载（含 `.claude`/`.cursor` 兼容） | 🟡 | AGENTS.md 有；多路径兼容装载无 |
| 上下文 | Knowledge（触发描述门控的组织级指令，可按 repo pin，自动从反馈挖掘建议） | 🟡 | soul 认知层不同机制；无"触发式知识条目"用户面 |
| 上下文 | DeepWiki 仓级架构 wiki 自动生成 | ❌ | 无 |
| 协作 | Managed Devins（协调者 session 孵化子 session：prompt/playbook/tags/ACU 限/消息/监控/冲突解决） | 🟡 | delegate_task 单次委派+预算门；无孵化-监控-汇总面板 |
| 协作 | Dynamic Workflows（确定性 Python 编排：`agent()/pipeline()/parallel()`+hash-keyed resume） | ❌ | 无脚本化编排面 |
| 协作 | `/handoff` 打包会话+repo+branch+diff≤100KB 推云 session | 🟡 | 七态 body handoff 是真功能但语义=换身体，非"本地→云" |
| 协作 | Slack/Teams/Linear/Jira/API v3/定时 session/voice/DataAnalyst/SecuritySwarm | ⛔ | 外部集成面=产品形态外 |
| 持久化 | 云 session sleep/wake（30min idle 休眠零计费）、archivable、Session Insights | ⛔ | 本地单机会话持久化已有；休眠计费不适用 |
| 扩展 | skills/plugins（兼容 Claude Code marketplace）/hooks（tool_provenance）/MCP+OAuth/config 导入（Cursor/Windsurf/CC/Copilot/OpenCode/Zed） | 🟡 | config 导入思路可借鉴；其余同边界 |
| 模型 | 目录多厂+SWE 系+Adaptive 路由+Fusion（lead+sidekick 双模型）+按 family 记忆配置 | 🟡 | 多 provider+显式选；无路由/双模型编队 |
| 计费 | ACU 动作计量+idle 停表+配额 | 🟡 | budget_status+预算门（token/成本口径） |

**缺口小结**: 形态外（云 VM/蓝图/集成面）占半；真实可迁移 = **plans 持久化库**、`/btw` 只读旁路、命令自动后台化、Smart 式模型判安全（候选）、subagent 监控面板、config 导入。

---

## 6. ZCode（Z.ai · Electron ADE，GLM-5.3 官方 harness · 闭源 freeware）

> `harnesses/zcode.md`；Goal Mode 证据验收、双 scope rewind、SSH/WSL/Docker 远程、IM bot 通道。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | 桌面 workspace=项目文件夹；Z.ai OAuth/API key/自定义 provider 三路 auth | ✅ | setup 卡+provider_add 对等 |
| 输入 | `@`文件/文件夹/plugin 引用、`#`历史会话链接、`$`skill 调用、长粘贴自动转附件 | 🟡 | @文件+$≈/宏有；@文件夹、#历史链接、长粘贴自动附件化无 |
| 会话 | 任务列表（workspace/分组/时间线视图+搜索+3/7/14/30 天自动归档候选+unarchive/delete+草稿任务） | 🟡 | 列表+搜索+删除有；分组视图/自动归档/草稿无 |
| 会话 | **双 Esc rewind**：conversation-only/conversation+workspace/workspace-only 三 scope+安全 checkpoint 计划（外部改动不覆盖、bash 变更不追踪） | 🟡 | 双 scope rewind 同构（/reset）；无"仅 workspace"scope 与安全计划提示 |
| 会话 | 编辑已发消息=会话+文件回该点；每回合 Undo/Reapply | 🟡 | rewind+fileops；无"编辑已发消息"入口 |
| 会话 | Fork 自任一已完成 assistant 消息（继承历史/模型/思考档/goal 进度） | 🟡 | fork 有；fork 点选择无 |
| 会话 | `/side` `/btw` 临时旁路会话（读主历史为上下文、可用工具、不继承 goal/queue） | ❌ | 无 |
| 执行 | Goal Mode：会话目标+**每轮真实证据验收**（改文件/命令输出/测试，嘴上说不算）+未达标自动下一轮+预算停+跨重开持久 | ❌ | 无 goal 验收回路（最接近=durable job，但无证据判据） |
| 执行 | 执行模式 4 档（Ask before changes/Edit automatically/Plan/Full access）Shift+Tab 循环 | ✅ | plan/act+risk_mode+批准卡同构 |
| 执行 | 权限决定 Allow/Allow session or project/Reject/Always Reject；被阻动作给出理由 | ✅ | 批准卡同选项+截断警示；理由展示有 |
| 执行 | 普通 agent 提问 5 分钟自动继续；权限/计划批准永不自动继续 | 🟡 | 批准卡倒计时有；普通问答自动继续无 |
| 可见性 | 活动工具/后台任务/open-plan 常驻可见；任务中心；`/diff` `/context` `/status` `/activity` | ✅ | 工具卡+todo+job 面板+状态行同构 |
| 上下文 | AGENTS.md（user-global+workspace 两层，文档明说无多级 merge/import） | ✅ | 同档（pi 原生加载） |
| 上下文 | 每项目 memory（turn 后蒸馏 facts 到本地 md，默认关、subagent 不读写、无上浏览 UI） | ❌ | 无运行时蒸馏记忆 |
| 上下文 | `/compact`+自动压缩+`/context` 组成检视+剩余量 UI | 🟡 | compact 有；/context 分解检视无 |
| 上下文 | Repo Wiki（模型在过滤读视图下导航生成架构 wiki；secret 名/gitignored/symlink 全排除；wiki.json 在 user data 不入仓） | ❌ | 无 |
| 协作 | 内置 general-purpose+Explore subagent；`~/.zcode/agents/*.md` 自定义（model/thinking/tools/prompt）；Agent 调用 ~1s 自动后台；`/tasks` 可消息/恢复/停 | 🟡 | delegate_task；自定义 subagent 文件/后台 agent 中心无 |
| 协作 | Automations：定时任务（hourly→cron）+**空闲时免费通道**（分段重排队同会话续跑） | ❌ | 无定时/空闲通道 |
| 协作 | Remote Control（手机浏览器控制已开 workspace：发消息/批权限/看进度）；Bot Channel（微信/飞书 IM 执行） | ⛔ | 移动/IM 远控=形态外 |
| 协作 | Remote Development：SSH/WSL/Docker 目标执行（agent 跑在远端，桌面持账号/UI） | ❌ | 无远程执行目标 |
| 扩展 | skills（SKILL.md+从 CC/Codex/OpenClaw/Augment/Windsurf 导入）/commands md/plugins+marketplace（含预装 CC 市场）/MCP+OAuth/hooks（PreToolUse 可 allow/ask/deny；**项目级 hooks 有意忽略**） | 🟡 | 宏/slash 有；skills 运行时/hooks/MCP/plugins 无；导入兼容思路可借鉴 |
| 模型 | GLM-5.3 旗舰+第三方模型接入+thought Low/High/Max+model.main/model.lite 双角色（lite 跑 subagent）+模型目录自动更新 | 🟡 | thinking_set+provider_add；双角色模型/目录自更新无 |
| 持久化 | 任务中心输出持久（64KiB cap）+可恢复子 session；2MB 滚动诊断日志 | ✅ | jobs 持久化+审计 |

**缺口小结**: 最厚的可迁移缺口 = **Goal Mode 证据验收回路**、`/btw` 旁路、自定义 subagent 文件+后台 agent 任务中心、定时/空闲 automations、编辑已发消息回卷、`/context` 分解、会话自动归档/草稿、模型目录自更新。远程执行/IM/手机 = 形态外。

---

## 7. Trae（ByteDance · IDE + SOLO + 开源 trae-agent CLI · 闭源/MIT）

> `harnesses/trae.md`；IDE Agent↔SOLO 两级自治、#引用族、code index、Task Management 面板。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | IDE 导入+订阅+Code Index Management（≤5000 文件自动建索引） | 🟡 | setup 卡对等；索引无（方向已收敛不做） |
| 输入 | `#`引用族：#Code 符号(LSP)/#File/#Folder/#Workspace(索引)/#Doc(≤1000 文件知识集)/#Problems 诊断/#Web/#Rule/#Past Chats | 🟡 | @文件有；#族多态引用（文件夹/诊断/历史会话/知识集）无 |
| 会话 | IDE 会话持久化+`#Past Chats` 拉旧会话进上下文 | 🟡 | 持久化有；把旧会话**引用进**当前上下文无 |
| 会话 | 快照/restore（DiffView 逐改动 revert+ai-agent/snapshot store） | 🟡 | rewind+fileops 回执；逐改动 revert 面弱 |
| 执行 | Agent 模式可自发 task plan 求确认；SOLO=plan→code→preview→deploy 全管道 | 🟡 | plan/act；无内嵌 preview/deploy 管道 |
| 执行 | 命令策略 4 档（手动/denylist/allowlist/自动）+高危命令即使自动也标记 | ✅ | 风险分类+lattice 同构 |
| 执行 | 沙箱 beta（写限 project+temp+依赖目录；越界给 Skip/Run/加白名单） | ❌ | 无 OS 沙箱 |
| 可见性 | DiffView per-file accept/reject+**Code Review 三模式+AI 复审可把发现弹回"Fix in Chat"** | 🟡 | diff 展示有；review 模式/AI 复审回路无 |
| 上下文 | rules（user+`.trae/rules/*.md` frontmatter globs+AGENTS/CLAUDE 家族）；Apply 模式 Always/文件匹配/智能/手动 | 🟡 | AGENTS.md 有；glob 规则+应用模式无 |
| 上下文 | code index 驱动 folder/workspace 检索；`.trae/.ignore` | ❌ | 无 workspace 级索引检索（grep/read 走 agent 自理） |
| 协作 | 内置 Agent/Builder/Search subagent；自定义 agents（UI 建：prompt+tools+MCP 绑定+"可被其他 agent 调用"）；`.md` subagents 可 @ | 🟡 | delegate_task；自定义 agent builder/可被调用链无 |
| 协作 | SOLO Task Management（分解任务并行/排队+进度面板）；SOLO Builder 预集成 Supabase/Stripe/Vercel/Figma→code | ❌ | 任务分解面板=todo 面板近似但无并行编排；垂直集成 ⛔ |
| 协作 | webview/browser 工具（SOLO 查 DOM/console 验证 UI） | ❌ | agent 无浏览器工具 |
| 持久化 | trae-agent trajectory JSON 全保真回放（eval 级） | 🟡 | audit JSONL+export；非可回放 trajectory 格式 |
| 扩展 | MCP+marketplace+`Builder with MCP` 内置 persona；VS Code 扩展宿主 | 🟡 | MCP 无；市场拒绝 |
| 模型 | 多厂 lineup+TRAE Auto Model 路由+BYOK ~30 预设+任意 OpenAI/Anthropic 端点 | ✅ | provider_add+model_set 同构；Auto 路由无 |

**缺口小结**: 可迁移 = #族多态引用（folder/诊断/历史会话/知识集）、逐改动 revert 面、AI code review 弹回回路、自定义 agent builder、task 分解并行面板、browser/预览验证工具。索引/垂直集成/IDE 面不适用。

---

## 8. Kiro（AWS · IDE + kiro-cli + Web/Mobile + Crew · 闭源/Crew 开源）

> `harnesses/kiro.md`；spec-driven（EARS requirements→design→tasks DAG）、统一 harness over ACP、Powers 动态加载。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | IDE/CLI/Web/Mobile 同 harness；GitHub/Gmail/BuilderID/IAM 登录 | 🟡 | 单桌面+自有 auth 面 |
| 输入 | `/tangent` 旁路 fork 会话、`/context add <globs>` 钉文件+token 分解、`#[[file:…]]` 引用、queue-steering | 🟡 | steer+@附着有；旁路 fork/钉 globs+分解无 |
| 会话 | 目录域持久化+`--resume`/`--resume-picker`+`/chat new|save|load`（JSON 导出/导入） | ✅ | 会话 CRUD+export HTML 同构 |
| 会话 | **checkpoints：恢复同时回卷文件+会话上下文**；Revert 只回最近回合文件；rewind 可从 checkpoint fork | 🟡 | /reset 双 scope 同构；checkpoint 从任意点 fork 无 |
| 会话 | 会话搜索本地索引（标题/提示+可选回复；工具输出排除） | ✅ | session_search 全文同构 |
| 执行 | 模式：chat/plan(Shift+Tab)/**spec**；Autopilot vs Supervised | 🟡 | plan/act 有；**spec 管道（requirements→design→tasks DAG 并行波）无** |
| 执行 | 权限=capability×effect(deny>ask>allow)×scope（hardcoded→admin→user→workspace→agent→session）；workspace 规则存仓外防注入；复合命令分段匹配 | ✅ | lattice+policy.json+规范锚同构；仓外 workspace 规则思路可借鉴 |
| 执行 | 云 sandbox（per-task 隔离+域名级网络管控+env 注入+销毁） | ⛔ | 云 task 面外 |
| 可见性 | spec 任务面板（tasks.md 依赖图并行波+需求回溯） | 🟡 | todo 面板近似；依赖 DAG/需求回溯无 |
| 上下文 | steering `*.md`（always/fileMatch/manual/auto 四模式）+AGENTS.md+`.kiroignore` | 🟡 | AGENTS.md 有；steering 模式族+kiroignore 无 |
| 上下文 | compaction 保 goals/decisions/task 状态/文件路径/约束+`excludeMessages` 调参 | 🟡 | compact 有；保真策略明细不可见/不可调 |
| 上下文 | `code` 工具（tree-sitter+LSP 结构查询）、`introspect`（Kiro docs 索引）、`tool_search` BM25 延迟载 MCP 工具 | ❌ | 无 LSP/tree-sitter/工具搜索（候选登记） |
| 协作 | 自定义 agents `.kiro/agents/*.{json,md}`（tools/permissions/resources/model/mcpServers/welcomeMessage）+`invoke_subagent` | 🟡 | delegate_task；自定义 agent 定义无 |
| 协作 | 跨 surface session（本地↔云↔IDE 接力）；Web autonomous（sub-agent 按 plan 扇出→PR，`/kiro fix` 评论驱动迭代） | ⛔ | 云/SCM 面外 |
| 协作 | **Crew**（开源常驻 gateway：sessions/语义记忆/cron/heartbeat/monitor/task-runner checkpoints/subagents/lessons 自学/IM 频道/远程 crew/可插拔 backend） | 🟡 | 理念近 Personal AI（常驻+多体）；memory/cron/IM/backend 可插拔的具体件无 |
| 扩展 | hooks（PromptSubmit/AgentStop/PreToolUse/FileCreate…触发，动作=命令或 agent prompt）+**Powers**（Agent Plugins 规范+关键词激活动态加载）+skills+MCP（kiro:// 一键装） | 🟡 | 宏/slash 有；hooks/Powers/skills 运行时/MCP 无 |
| 模型 | Anthropic/OpenAI/开源 lineup+Auto 路由+effort 档+region/tier 门 | 🟡 | 多 provider+thinking_set；Auto 路由无 |
| 持久化 | Crew 持久 sessions/memory/schedules/checkpoints | 🟡 | 会话+jobs 持久；memory/schedule 无 |

**缺口小结**: 可迁移 = **spec 管道（需求→设计→任务 DAG）**、checkpoint-fork、`/tangent` 旁路、steering 文件模式族、`.kiroignore` 语境排除、hooks 事件、Powers 式按需加载、Crew 的常驻 memory/cron/heartbeat 件、自定义 agent 文件。

---

## 9. Aider（社区 · CLI · Apache-2.0 · SOURCE-READ）

> `harnesses/aider.md`；无工具调用的编辑格式多态+git 即安全层+repo-map。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `--model` 直选（LiteLLM 350+ 模型元数据注册表）+`.aider.conf.yml` 分层配置 | 🟡 | provider_add 有；per-model 设置表（edit_format/温度/prefill 等）无 |
| 输入 | 43 个 slash（/add /drop /read-only /lint /test /run /git /undo /diff /map /tokens /ask /code /architect /web /voice /paste /load /save /copy /model …）；文件补全 | 🟡 | 26 slash 覆盖会话族；缺 /add-/drop 显式文件集管理、/lint /test 命令面、/voice、/web |
| 会话 | transcript=`.aider.chat.history.md` 可读可回放（`--restore-chat-history`）；`/save` `/load` 命令脚本 | 🟡 | 会话持久化+导出；无"命令脚本回放" |
| 执行 | **git 自动提交每次编辑→`/undo`=机械 git reset**（aider_commit_hashes 白名单）；`/diff` 聚合本轮全部改动 | ❌ | 无自动提交纪律；我们的 undo=rewind+fileops（语义接近但不动 git） |
| 执行 | reflection 回路（≤3 次：edit 解析失败/lint/test 失败带错误重询）；check_for_file_mentions 反映"要不要加这个文件" | 🟡 | auto_retry 有；lint→fix→test 的结构化反思环无（模型自理） |
| 执行 | shell 块 `confirm_ask`（y/A 全/S 全跳/D 不再问）；--yes-always | ✅ | 批准卡同构（允许一次/本会话/拒绝） |
| 可见性 | repo-map 面板（/map /map-refresh /tokens） | ❌ | 无 repo-map（tree-sitter PageRank 候选未做） |
| 上下文 | repo-map：tree-sitter tags→referencer→definer 图→PageRank 个性化→token 预算二分适配；只读文件契约靠 prompt | ❌ | 无；@附着是手动等价物 |
| 上下文 | ChatSummary 递归减半压缩+weak_model 分担摘要/提交信息/help | 🟡 | compact 有；弱模型分工无 |
| 上下文 | 图片/PDF vision 附着、/web 抓页 | 🟡 | 图片有；PDF/web 抓取无 |
| 协作 | architect 双模型管道（主模型规划→editor 模型改） | ❌ | 无双模型编队（Devin Fusion 同族） |
| 扩展 | 无插件/hook/skill；可配：lint/test 命令、模型设置表、read-only 文件注入 | 🟡 | 宏/lint-test 由 agent 跑命令自理；无 `--lint-cmd` 内建回路 |
| 平台 | CLI REPL+Streamlit GUI+--watch-files（`AI`注释驱动）+--copy-paste 剪贴板驱动网页 chat | ⛔ | watch/copy-paste 是宿主形态外玩法 |

**缺口小结**: 真实可迁移 = **git auto-commit+`/undo`**（改动即提交给机械回滚底气）、**/diff 聚合面**、repo-map（候选已登记）、lint/test 反思环、/web 抓取、双模型 architect。

---

## 10. Codex CLI（OpenAI · Rust TUI + exec + app-server + cloud · Apache-2.0 · SOURCE-READ）

> `harnesses/codex-cli.md`；execpolicy 静态分类、每平台 OS 沙箱、Guardian 复审、rollout JSONL。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | OpenAI 登录/API key；`/init` 写 AGENTS.md | ✅ | /init 有 |
| 输入 | TUI composer：图片附着、`@`文件、`!`shell 直跑？（shell 工具面）、自定义 prompt 文件（~/.codex/prompts） | 🟡 | @/图片/宏有；prompts 目录=宏同构 |
| 会话 | `codex resume/fork/queue/archive`+`resume --last`+列表选择器；rollout JSONL 双 ID（thread/rollout）分叉共存 | ✅ | resume/fork/list/delete 同构 |
| 会话 | TUI 内 `/review`（代码评审模式）/`/diff`/`/status`/`/model`/`/approvals`/`/compact`/`/mention` | 🟡 | 命令面同构；/review 评审模式无 |
| 执行 | approval 模式 UnlessTrusted/OnRequest/Granular/Never × sandbox 策略 ReadOnly/WorkspaceWrite/DangerFullAccess/ExternalSandbox | ✅ | lattice+risk_mode+workdir 边界同构（无 OS 沙箱层） |
| 执行 | **execpolicy** Starlark 规则（allow/prompt/forbidden+match 示例自校验，用户可写 .policy） | ✅ | policy.json 同构且更严（sha256 锚）；用户可写规则面对等 |
| 执行 | **OS 沙箱**：Landlock/Bubblewrap（Linux）/Seatbelt（macOS）/restricted token（Win）；网络单独门 | ❌ | 无 OS 沙箱 |
| 执行 | **Guardian**：独立同步 LLM 复审批准请求（预算限+invalid fail-closed） | ❌ | 无复审模型（LLM 分类器候选） |
| 执行 | 拒绝后 sandbox 升级重试不再问；turn 间 drain pending 输入 | ✅ | steer 队列同构 |
| 可见性 | TUI diff 视图、工具行、上下文剩余探针、update_plan 工具面板 | ✅ | 工具卡/todo/状态行同构 |
| 上下文 | AGENTS.md 向上逐级合并；models.json **prompt-as-data**（每模型指令模板/能力 flag） | 🟡 | AGENTS.md 有；多级合并与 per-model 模板无 |
| 上下文 | 预采样 compaction（压力预测先压再采样）+压缩边界写入 history | ✅ | compact+compaction 事件同构 |
| 协作 | thread-tree 多 agent（父↔子同队列通信+spawn-depth+full/reduced history fork）；multi_agent spawn 工具模型可调 | 🟡 | delegate_task 单向委派；无父子通信/树拓扑 |
| 协作 | `cloud` 托管跑、app-server JSON-RPC 控制面 | ⛔ | 云面外；channel 已是程序化控制面 |
| 持久化 | rollout JSONL append-only+reverse_jsonl_scanner 尾部快读+session_index | ✅ | JSONL 会话持久化同构 |
| 扩展 | hooks 12 事件（SessionStart/PreToolUse/PermissionRequest/SubagentStart/Stop/Interrupt…）+skills crate+plugin install+MCP+`.policy` 用户规则 | 🟡 | hooks/skills/MCP 无（边界）；policy 用户面有 |
| 模型 | models.json 目录（指令模板+tool mode+shell type+能力 flag 按模型）+可远端刷新 | 🟡 | model 选择有；能力声明式 manifest 无 |
| 平台 | TUI+exec headless+SDK+IDE(via app-server)+cloud | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **Guardian 式独立复审**（候选已有）、OS 沙箱（win 受限）、thread-tree 父子通信、`/review` 评审模式、models.json 能力声明、execpolicy 用户规则文件（我们 policy.json 已更近一步但用户编辑面窄）。

---

## 11. Gemini CLI（Google · CLI + a2a-server · Apache-2.0 · SOURCE-READ）

> `harnesses/gemini-cli.md`；扩展即平台（单 manifest 注 MCP/context/tools 排除/hooks/skills/agents/policies/themes）、LLM 判环检测。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | Google OAuth 免费层/API key/Vertex 多路；folder trust 门控 | 🟡 | setup 卡+密钥；folder trust 概念=workdir 边界弱同构 |
| 输入 | slash 族（/chat save/resume /memory /stats /tools /theme /editor …）+`.toml` 自定义命令+图片 | 🟡 | slash+宏同构；命名会话存取（/chat save）≈rename；主题无 |
| 会话 | checkpointing（文件编辑快照恢复 workspace）+`--resume` | 🟡 | rewind+fileops；快照机制不同源 |
| 执行 | approval 模式 PLAN/DEFAULT/AUTO_EDIT/YOLO（**untrusted folder 禁 YOLO/AUTO_EDIT**） | ✅ | risk_mode+lattice 同构；"信任门控高权模式"思路可借鉴 |
| 执行 | policy TOML 规则文件（扩展可带）+confirmation-bus 解耦批准 UI | ✅ | policy.json 同构 |
| 执行 | 沙箱后端族：Docker/Podman/sandbox-exec/gVisor/LXC/Windows-native | ❌ | 无 OS 沙箱 |
| 执行 | **LLM 判环检测**（模式+诊断模型双段，置信度自适应间隔，double-check alias） | ❌ | 无卡死检测（我们只有 abort/超时） |
| 可见性 | scheduler 阶段化（validating→executing→completed/errored） | ✅ | 工具卡生命周期同构 |
| 上下文 | GEMINI.md 层级发现+扩展供给+IDE 诊断/open-file diffs 进 context pipeline | 🟡 | AGENTS.md 有；IDE 贡献者管道不适用 |
| 上下文 | 压缩保最近 30%+tool-response 专用预算+split 点不成孤儿 | 🟡 | compact 有；保真策略细节不可调 |
| 上下文 | jit-context 工具（just-in-time 注入）+memory 工具 | ❌ | 无 |
| 协作 | agentRegistry（built-in codebase-investigator/generalist/browser+扩展供 agent）+A2A server | 🟡 | delegate_task；agent 注册表/A2A 无 |
| 持久化 | `~/.gemini` 会话+checkpoint；压缩作为 history 边界 | ✅ | 同构 |
| 扩展 | **单 manifest 扩展包**（MCP/context/排除工具/settings/themes/planning/hooks/skills/agents/policy）——survey 中最宽装载面 | ⛔ | managed-manifest 拒绝市场方向，但"单 manifest 多功能件"格式可借鉴 |
| 扩展 | hooks 11 事件含 **BeforeModel/AfterModel/BeforeToolSelection**（拦截模型 I/O 与工具供给） | ❌ | 无 hooks |
| 模型 | contentGenerator 抽象+alias（loop-detection-double-check）+限流 fallback 配置 | 🟡 | 显式模型；别名/fallback 无 |
| 平台 | CLI React/Ink+a2a-server+IDE companion | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **LLM 判环检测**、trust-gated 高权模式、BeforeModel 级 hook 点（若做 hooks）、per-model alias/fallback、/chat save 命名存档语义。

---

## 12. OpenCode（Anomaly · TUI/desktop/web + ACP + SDK · MIT · SOURCE-READ）

> `harnesses/opencode.md`；harness-as-server（Effect HttpApi+WS）、~75 provider、shadow-git 快照、plugin SDK。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `opencode` 进 TUI+`opencode run` headless+server 自起+mDNS 发现 | 🟡 | app 形态不同；无 headless 用户面 |
| 输入 | TUI composer：`@`文件、`!`shell 直跑、图片、多行编辑器、自定义 command md（`$1` 参数+@file/@agent 解析） | ✅ | @/图片/宏（宏无 $1 参数与 @agent 解析） |
| 会话 | 会话列表可搜可存档可 share（share 链接）+SQLite parts 持久化+`parentID` 子会话链 | 🟡 | 列表/搜索/分支有；分享链接、父子会话链视图无 |
| 会话 | **shadow-git 快照**（`git write-tree` 每 step+`revert()`/`restore()`+patch parts）→ `/undo` `/redo` | 🟡 | rewind+fileops 双 scope；step 级 write-tree 快照无 |
| 执行 | permission `{permission, pattern, action}` 三元组 last-match-wins+默认 ask 集（外部目录/env 文件/doom_loop）；`always` 持久化+级联拒绝+纠错反馈回模型 | ✅ | lattice+批准卡同构；"拒绝可带纠错反馈"是亮点缺口 |
| 执行 | **tree-sitter 解析 shell 命令**（逐命令节点含替换/子壳；文件变更命令路径解析对项目边界→external_directory ask） | 🟡 | 静态 fail-closed 解析有；tree-sitter 级命令分解无（候选已登记） |
| 执行 | doom_loop：连续 3 次同名同参工具调用→ask | ❌ | 无循环检测 |
| 可见性 | TUI 面板族（files/logs）、工具 pending→running→completed 状态 | ✅ | 工具卡生命周期同构 |
| 上下文 | AGENTS.md/CLAUDE.md 上溯+远端 URL 指令可拉取+`<available_references>` 参考目录 | 🟡 | AGENTS.md 有；远端指令/参考目录无 |
| 上下文 | compaction=隐藏 agent 跑固定节模板（Objective/Details/Work State/Next Move/Files）+溢出后 replay 前一条 user 消息降级 media | 🟡 | compact 有；模板/重放语义内部化 |
| 上下文 | `compaction.prune` 软删旧工具输出（保 ~40k+最新回合+skill 输出） | ❌ | 无选择性剪枝 |
| 协作 | `task` 工具子会话（parentID+权限派生+深度限 1+前后台）+subtask part 持久化跨重启拾取 | 🟡 | delegate_task；子会话链/深度/跨重启拾取语义无 |
| 协作 | server 多客户端（TUI/desktop/web/ACP/SDK 同 server）；pty 路由 | ⛔ | supervisor 单 UI；HTTP/SSE 桥已是最小等价 |
| 扩展 | plugin SDK（hooks：config/event/tool/auth/provider/chat.params/permission.ask 覆盖/shell.env/compaction veto…）+npm 装载 | 🟡 | managed-manifest 拒绝 npm 市场；hook 点集可作设计参照 |
| 扩展 | agents/modes/commands md 文件定义+skills+themes+MCP（OAuth+roots） | 🟡 | 宏/slash 有；agent md/MCP/themes 无 |
| 模型 | models.dev 目录+~20 provider 包懒载+plugin provider+per-model 工具面协变（GPT-5 系给 apply_patch 不给 edit/write） | 🟡 | provider_add 有；目录/per-model 工具面协变无 |
| 平台 | TUI+desktop+web+ACP+SDK+Slack 集成 | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **命令级 tree-sitter 解析**（候选）、doom_loop 检测、always-pattern 持久化+级联拒绝+纠错回模型、step 级快照/undo-redo、subtask 跨重启拾取、per-model 工具面协变、compaction.prune 剪枝。

---

## 13. OpenHands（All Hands AI · web GUI + CLI + resolver + headless · MIT · SOURCE-READ 0.62.0）

> `harnesses/openhands.md`；事件溯源平台：EventStream 是唯一事实，Runtime=每会话 Docker 容器。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | web GUI 会话管理+CLI+headless `-t`+GitHub/GitLab resolver | 🟡 | 单桌面 app；resolver/CI 面外 |
| 输入 | 消息式 UI；confirmation 模式（动作挂 AWAITING_CONFIRMATION） | ✅ | 批准卡同构 |
| 会话 | 事件即会话（每事件 JSON+页缓存）；resume=重放事件流；AgentState 机（RUNNING/FINISHED/STOPPED/AWAITING_*/RATE_LIMITED） | ✅ | 会话持久化+事件审计同构 |
| 执行 | **SecurityAnalyzer** 可插拔（invariant/llm/grayswan）；工具 schema 自带 `security_risk` 模型自评参数；HIGH 必确认 | ❌ | 无独立安全分析器/模型自评（候选：LLM 分类器） |
| 执行 | **每会话 Docker 容器** runtime（FastAPI action server inside） | ❌ | 无容器沙箱 |
| 执行 | StuckDetector 5 启发式（重复 action+obs/重复错/独白/ABAB/上下文错循环）→LoopRecovery 选项 | ❌ | 无卡死检测 |
| 执行 | max_iterations 500+max_budget_per_task 美元上限 | ✅ | budget_status+预算门同构 |
| 可见性 | 事件流全量可检视（event log=API）；观察截断 max_message_chars | ✅ | 审计视图+工具卡同构 |
| 上下文 | **9 种 condenser** 可插拔（conversation_window 默认保 system+首条+动作-观察对）；microagent 触发式知识（keyword triggers→RecallAction） | 🟡 | compact 单策略；microagent=触发式知识条目，无对应面 |
| 协作 | AgentDelegateAction 子 controller 共享事件流（串行委派，父转发+结果回链） | 🟡 | delegate_task 跨 agent（不同 loop 而非同流）；同构度中 |
| 协作 | browsing_agent/readonly_agent/visualbrowsing_agent 多 agent 角色；task_tracker（TASKS.md） | 🟡 | todo 面板≈task_tracker；多角色无 |
| 持久化 | 事件 JSON+agent_state.pkl 每步存；FileStore 可插拔 | ✅ | JSONL 审计+会话持久化同构 |
| 扩展 | microagents md（knowledge/repo/task 三类+`@file`）；MCP（client+挂进沙箱 proxy）；plugins（jupyter/vscode bootstrap）；config.toml per-agent/per-llm | 🟡 | MCP/plugins 无；microagent 触发知识思路可迁移到 briefing |
| 模型 | LiteLLM+llm_registry+router 目录 | 🟡 | provider_add 同构 |

**缺口小结**: 可迁移 = **SecurityAnalyzer/模型自评风险参数**（增强批准卡信息）、StuckDetector 卡死检测、condenser 多策略（保 system+首条+配对）、microagent 触发式知识、delegate 共享事件流（我们已经是跨进程 job——观察面弱于它）。Docker 沙箱重，方向可选。

---

## 14. Goose（AAIF/Block · CLI+Electron desktop+ACP serve · Apache-2.0 · SOURCE-READ）

> `harnesses/goose.md`；MCP 是唯一工具总线（内建件也是 extension）、recipes、cron、Nostr roaming。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `goose configure`+`goose doctor`+`goose session`；desktop 起 serve+bearer 密钥 | 🟡 | setup 卡对等；doctor 自检无 |
| 输入 | slash=recipes+skills 上浮；CLI/desktop 双面 | 🟡 | slash+宏；**recipe（YAML 任务包：instructions+extensions+参数+retry+response schema+deeplink 安装）无** |
| 会话 | SQLite sessions.db（type: user/scheduled/subagent/hidden/terminal/gateway/acp）+usage_ledger+archived_at+auto-title | 🟡 | 会话持久化+统计有；类型分面/自动命名标题/归档无 |
| 执行 | GooseMode 4 档（Auto/Approve/SmartApprove/Chat）+权限规则持久化（AlwaysAllow/NeverAllow/AskBefore） | ✅ | lattice+批准卡+本会话允许同构 |
| 执行 | **SmartApprove=LLM read-only 判官**（不可信 JSON 框架+注入对策，仅否决缓存）+SecurityInspector 正则/分类升级 | ❌ | LLM 判官=候选未做；模式升级=风险分类已有 |
| 执行 | RepetitionInspector 重复调用监视；MAX_TURNS=1000；moim 轮次预算上下文 | 🟡 | 重复检测无；预算门有（成本口径）；turn 预算注入模型无 |
| 执行 | manage_extensions：**模型自己发现/启用 MCP 扩展**（强制批准） | ❌ | 无 MCP 层 |
| 上下文 | AGENTS.md+.goosehints+@file 包含（gitignore 敬意+.git secret 排除）+子目录 hint 跟踪 | 🟡 | AGENTS.md 有；hint 子目录跟踪/secret 排除面弱 |
| 上下文 | 压缩 0.8 阈值+**tool_call 对成批摘要**（10 一组）+unicode-tag 消毒所有 prompt 输入 | 🟡 | compact 有；工具对摘要/unicode 消毒无 |
| 协作 | summon.delegate=子 agent（独立 session+模型+structured output+后台 tasks 池+TTL）；orchestrator 扩展管多会话 | 🟡 | delegate_task；后台池/多会话管理面弱 |
| 协作 | **cron 调度器**（schedule 子命令+manage_schedule 工具+recipe 定时） | ❌ | 无定时任务 |
| 协作 | `goose roam`：Nostr 中继 E2E 加密的设备间 agent 共享 | ⛔ | P2P 形态外 |
| 持久化 | chatrecall=跨会话 SQLite FTS 搜索（关键词）；export_markdown | 🟡 | session_search 全文同构（范围限会话内） |
| 扩展 | skills（agentskills.io）+plugins+hooks（12 事件含 BeforeShellExecution/AfterFileEdit）+MCP 全型 | 🟡 | 同边界 |
| 模型 | ~30 provider（含 claude_code/codex/pi_acp 等**其他 agent 作 provider**）+keyring/OAuth/command_auth | 🟡 | provider_add；"其他 agent 作 provider"=我们 delegate 反向 |
| 平台 | CLI+Electron（ACP over WS+bearer+可选 TLS）+acp stdio+mcp server 模式 | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **recipes（带参数/schema/retry 的任务包，宏的超集）**、cron、SmartApprove LLM 判官（候选）、unicode-tag 消毒（便宜可偷）、chatrecall 跨会话搜索、tool_call 对摘要、自动会话命名、moim 预算提示。

---

## 15. Roo Code（VS Code ext + CLI over IPC · Apache-2.0 · SOURCE-READ）

> `harnesses/roo-code.md`；Cline 分叉走"一切可配"：自定义 modes+Boomerang 委派+shadow-git checkpoints+（唯一）向量索引。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | VS Code 侧栏+provider profiles（多组保存配置）+OpenRouter/Roo Cloud 默认 | 🟡 | setup 卡+provider_add；多 profile 组无 |
| 输入 | @文件/文件夹/问题/终端 mentions；enhance prompt 钮；图片 | 🟡 | @文件+图片有；@folder/@problems/@terminal、prompt 增强钮无 |
| 会话 | task 历史（status/delegatedToId/childIds 链）+token/cost 总计；editMessageAndRegenerate | 🟡 | 列表+stats 有；委派链标记/编辑重生成弱 |
| 会话 | **shadow-git 每 workspace 快照仓**：每工具批一 commit，restore=checkout+diff 视图；enableCheckpoints+timeout 门 | 🟡 | rewind+fileops；shadow-git 自动快照无（同 Cline 旧案） |
| 执行 | **自定义 modes**（slug/roleDefinition/whenToUse/groups[read/edit{fileRegex}/command/mcp]+customInstructions+`.roomodes` 项目级）——能力画像≠批准档 | 🟡 | plan/act 两档固定；**用户自定义 mode（工具组×fileRegex 限制）无** |
| 执行 | AutoApprovalHandler：逐项开关+allowedCommands/deniedCommands **最长前缀匹配 deny-wins**+allowedMaxRequests/MaxCost 上限升级 ask | 🟡 | lattice 更严；用户可写的命令白/黑名单面+配额上限 ask 无 |
| 执行 | 连续错误 3 次→mistake_limit ask；ToolRepetitionDetector 3 次同调用→ask | 🟡 | auto_retry 有；mistake/重复 ask 面无 |
| 可见性 | DiffViewProvider 逐改动批准；工具分组动词；streaming 中即执行（边流边跑） | ✅ | 工具卡+diff 同构 |
| 上下文 | `.roo/rules/`+`.roo/rules-{mode}/`+global；`.rooignore`；customModePrompts 覆盖 | 🟡 | AGENTS.md 有；规则目录/ignore 无 |
| 上下文 | **codebase_search=embedding+Qdrant**（8 embedder 可选）——survey 中唯一向量例 | ⛔ | 向量索引=登记拒绝（方向与 Cursor 退役一致）；lexical grep 够用层 |
| 上下文 | condense：tool_use/result 先摊平成文本再摘要+sliding-window 截旧工具结果 | 🟡 | compact 有；剪枝细节无 |
| 协作 | `new_task` Boomerang：父任务 dispose→子独占→完成回注结果（单存活不变式+元数据修复）；orchestrator mode 只派活 | 🟡 | delegate_task 单次跨 agent；mode 化委派链无 |
| 协作 | `run_slash_command` 工具（agent 自己调 slash）；custom_tool 注册表（experiment） | ❌ | 无 agent 可调 slash/自定义工具 |
| 持久化 | 双 transcript（api_conversation_history+ui_messages）+checkpoint 仓 | ✅ | 持久化+审计同构 |
| 扩展 | modes/规则/MCP（per-mode mcp 组+marketplace）/skills/custom tools/experiments 开关 | 🟡 | 同边界（marketplace 拒绝） |
| 平台 | VS Code ext+CLI（node-ipc 驱动扩展宿主） | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **自定义 mode 定义（工具组×fileRegex）**——我们 risk_mode 是固定档，这是最具体的可迁移缺口；命令白/黑名单+配额 ask；编辑消息重生成；逐改动 diff 批准；mistake/repetition ask。

---

## 16. Crush（Charm · Bubble Tea TUI + crush server · FSL→MIT · SOURCE-READ）

> `harnesses/crush.md`；LSP 一等公民（符号级编辑）、mvdan/sh 内建 shell、`crush server` ~70 REST+SSE。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `crush` TUI/`crush run` headless/`crush server` daemon+`--host` attach | 🟡 | app 形态；headless 无 |
| 输入 | TUI composer+图片+队列（busy 排队+Cancel 覆盖已收不毒后续） | ✅ | 队列+steer 同构且语义更细 |
| 会话 | SQLite 会话（parent_session_id 隐藏子会话）+summary_message_id 截断 resume+项目级 `.crush` 数据目录 | ✅ | 持久化同构 |
| 执行 | 权限服务（skip→allowlist→hook 预批→session auto-approve→grant cache）+GrantPersistent；**deny=StopTurn 直接结束回合** | ✅ | lattice+批准卡同构；"deny 即终局"语义我们更硬 |
| 执行 | **shell 解释器内建硬封禁**（curl/wget/ssh/sudo/包管理/systemctl/crontab…批准不掉）+只读前缀免问 | 🟡 | 风险分类 lattice 有绝对 deny 等价物（负能力）；内建 shell 层无 |
| 执行 | 命令 60s 自动后台化+`job_output`/`job_kill` | 🟡 | jobs 显式后台；自动后台化无 |
| 执行 | StopWhen：上下文接近窗口自动摘要+滑动窗重复工具检测 | 🟡 | compact 有；重复检测无 |
| 可见性 | Bubble Tea 面板（files/logs/dialog）+REFUSED banner+herdr 复用器状态上报 | ✅ | 工具卡+状态行同构（TUI 精美度不对标） |
| 上下文 | contextPaths 族自动装（AGENTS/CLAUDE/GEMINI/crush/.cursorrules/copilot-instructions）+全局+per-agent 覆盖 | 🟡 | AGENTS.md 有；多文件族自动装载无 |
| 上下文 | **LSP 一等**：diagnostics/references/symbols/call_hierarchy/rename/replace_symbol——语义编辑绕开文本匹配，prompt 主动引导优先用 | ❌ | 无 LSP（候选已登记） |
| 协作 | `agent` 工具→task 子 agent（child session+tool 过滤+子代理不触用户 hooks）；`--host` 多客户端；`--channels` MCP-as-channel 入站触发 | 🟡 | delegate_task；多客户端/入站通道无 |
| 持久化 | per-project `.crush` SQLite+datadirlock+8 迁移 | ✅ | instance root 持久化同构 |
| 扩展 | hooks（matcher regex+command+exit49=halt+Claude-Code 输出兼容解析）；skills（内建 embed+skills.Tracker 记录实际读取）；MCP（OAuth2.1 DCR+per-server enabled_tools）；**crushrc=Bash 即配置**（provider/model/mcp/lsp/permissions/hook 内建命令） | 🟡 | hooks/MCP 无；**skills.Tracker"读了哪几个"**思路可借鉴 |
| 模型 | catwalk 目录（ETag+内嵌快照）+fantasy 抽象+providers 配置合并/禁用默认+per-model reasoning/小模型 | 🟡 | provider_add 有；目录/小模型分工无 |
| 平台 | TUI+server REST/SSE（unix sock/npipe/TCP）+headless | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **LSP 工具组**（候选）、命令自动后台化、重复工具检测、多 context 文件族装载、skills 读取追踪、内建 shell 硬封禁层（负能力补强）、`crush server` 式多客户端 REST 面（与我们 HTTP 桥同思路，深度差距=~70 端点 vs 我们 cmd+state）。

---

## 17. Kimi Code（Moonshot · 单二进制 CLI + kap-server + ACP + web/remote-control · MIT · SOURCE-READ）

> `harnesses/kimi-code.md`；DI scope 引擎、KAOS 执行抽象（本地+SSH）、纯 TS bash 解析器。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `kimi login`/`provider`/`doctor`/`migrate`（旧品牌目录迁移）/`upgrade` | 🟡 | setup 卡+provider_add；doctor/迁移路径无 |
| 输入 | TUI+print headless；AskUserQuestion 工具（结构化提问）；NotifyUser | 🟡 | **结构化提问工具无**（同 Cursor 缺口）；用户通知=toast/sys 行近似 |
| 会话 | `kimi session`/`fork`/`export`；wire.jsonl 版本化事件溯源（含 undo 记录+reader 迁移旧格式+per-agent journal） | ✅ | 持久化+导出同构；undo 记录在事件层=rewind 同族 |
| 执行 | 权限模式 manual/yolo/auto+**有序 policy 链**（用户规则→auto→历史批准→dangerous-command-ask→sensitive-file-ask→git 检查→yolo→默认→兜底 ask） | ✅ | lattice+规范锚同构且更严 |
| 执行 | **纯 TS tree-sitter-bash 解析危险命令**（shutdown/diskpart/format/rm -rf/dd/提权/嵌套壳/systemctl）——真解析非正则 | 🟡 | 静态 fail-closed 解析有；命名危险命令族的力度更细（候选已登记） |
| 执行 | max_steps_per_turn 超限出结构化错误+修复指引；背景工具/prompt 门/暂停恢复=状态机显式转换 | 🟡 | abort/steer 有；步数上限+用户可读修复指引无 |
| 可见性 | TaskList/TaskOutput/TaskStop 工具族=后台任务一等 | 🟡 | jobs 有；agent 可自查任务列表的工具面（job_status 有） |
| 上下文 | AGENTS.md+`.kimi-code` 项目目录（AGENTS/skills）+legacy 迁移 | 🟡 | AGENTS.md 有；项目目录约定无 |
| 上下文 | compaction 0.85 阈值+保用户消息/工具组不切+3 次溢出重试 | 🟡 | compact 有 |
| 协作 | 内置 coder/explore/plan profile subagent+**AgentSwarm**+Cron 工具+plan/goal/tower 工具族 | 🟡 | delegate_task；内置 profile/swarm/cron/goal 无 |
| 协作 | **KAOS**：同一工具面可指向 SSH/SFTP 远端（执行环境抽象） | ❌ | 无远程执行目标 |
| 协作 | kap-server REST+WS、`kimi web`（web UI+relay 隧道 remote-control）、kimi-inspect 调试面 | ⛔ | 远程/web 面外；HTTP/SSE 桥是最小等价 |
| 持久化 | state.json+wire.jsonl 双件+minidb（JSON 文档库快照+WAL+全文层） | ✅ | 持久化同构 |
| 扩展 | hooks（CC 兼容协议+exit2=block）+skills（prompt/inline/flow 三型）+plugins marketplace（official/curated+git 源）+MCP+OAuth | 🟡 | 同边界（市场拒绝）；skills 三型分类可借鉴 |
| 模型 | kosong 多 provider+capability-registry+Kimi OAuth | 🟡 | provider_add 同构 |
| 平台 | TUI+print+SDK(node-sdk/klient)+ACP+web+remote-control | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **AskUserQuestion 结构化提问**、NotifyUser、TaskList/Output/Stop 族、max_steps 结构化错误、纯 TS bash 危险命令解析（候选）、skills 分类装载思路、cron 工具。

---

## 18. Qwen Code（阿里 · Gemini CLI 深度分叉 · Apache-2.0 · SOURCE-READ）

> `harnesses/qwen-code.md`；AUTO 模式三段（allowlist→两段式 LLM 分类器 fail-closed）、code mode、serve+真沙箱、频道面。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | Qwen OAuth 设备流+API key+~15 provider 预设（阿里 coding plan/Moonshot/DeepSeek/ModelScope/MiniMax/OpenRouter/Z.ai/自定义） | 🟡 | provider_add 有；OAuth 设备流无（密钥够用） |
| 输入 | 交互/headless/ACP 三模式（headless 禁提问）；ask_user_question 仅交互/ACP | 🟡 | 同 Kimi 结构化提问缺口 |
| 会话 | sessions list/resume+**branch checkpoints**（fork 记录进 JSONL，parentSessionId 链重建）+background-agent resume | ✅ | fork+持久化同构 |
| 执行 | 批准模式 PLAN/DEFAULT/AUTO_EDIT/AUTO/YOLO+持久/会话级 deny/ask/allow 规则 | ✅ | lattice+risk_mode 同构 |
| 执行 | **AUTO=两段式 LLM 分类器**（快段 32tok/10s→复核段 4096tok/30s；错误/超时/schema 失败/溢出全 fail-closed）+safe-tool 白名单（**MCP 永不进白名单**） | ❌ | 无 LLM 分类器（登记候选） |
| 执行 | `serve` daemon：多 workspace+**Seatbelt/Docker 真沙箱**+代理/挂载/UID 映射 | ❌ | 无 OS 沙箱/daemon 多租户 |
| 执行 | **code mode**：模型写 ≤128KB JS 在沙箱 runtime 调 `tools.<name>()` | ⛔ | code-mode=登记拒绝（绕开静态分类） |
| 执行 | MAX_TURNS=100 硬帽+`max_session_turns`+loop_detected+**写入前 secret 扫描**（edit/write 结果查凭据） | 🟡 | 步数帽/环检测无；**secret 扫描写前检查=可迁移小件** |
| 可见性 | 丰富事件流（thought/citations/goal state/fallback/retry/chat_compressed） | ✅ | 事件+卡片同构 |
| 上下文 | QWEN_DIR/Qwen memory+imports+`.agents` skills；compression checkpoint 写进 transcript | 🟡 | AGENTS.md 有；memory 子系统无 |
| 上下文 | microcompaction/compactionInputSlimming（工具输出 slimming 服务） | 🟡 | compact 有；细粒度 slimming 无 |
| 协作 | 内置 general-purpose+review-agent subagent（工具受限）；fork/background 强制 YOLO 覆盖（无交互不卡住） | 🟡 | delegate_task；review-agent 专用 profile 无 |
| 协作 | teams/workflows/goals 子系统（journal.jsonl 快照）；`board`/`channel`（Telegram/钉钉/企微面） | 🟡 | goals≈我们 task 面弱；频道/teams 形态外 |
| 持久化 | `.qwen` 全局（settings/oauth/mcp-token/workflows/extensions/chats/checkpoints/**memory**）+项目 `.qwen` journal | ✅ | instance root 同构；memory 目录件无 |
| 扩展 | **extension converters**（吞 Claude Code plugins+Gemini extensions 转自家格式）+git 安装+skills 多层（session/project/user/extension/builtin）+hooks+MCP | 🟡 | 同边界；**converter 思路（吞别家格式）可借鉴于托管装载** |
| 模型 | ContentGenerator 抽象+OpenAI 兼容/Anthropic+Qwen OAuth+回退事件 | 🟡 | provider_add+显式选；fallback 事件无 |

**缺口小结**: 可迁移 = **AUTO 两段式 LLM 分类器**（登记候选的参照实现）、写前 secret 扫描、MAX_TURNS 硬帽+可读终止理由、goals 子系统、review-agent profile、microcompaction、background agent 强制批准覆盖。

---

## 19. Mistral Vibe（Mistral · Textual TUI + vibe-acp · Apache-2.0 · SOURCE-READ）

> `harnesses/mistral-vibe.md`；middleware 管道环、profile 安全标签、tree-sitter 权限分析、rewind 默认 fork。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `vibe --setup` 首跑 onboarding；trusted_folders.toml | 🟡 | setup 卡对等；folder trust 无 |
| 输入 | TUI composer；7 个 profile（ask/plan/accept-edits/auto-approve/smart-approve/explore/lean，各带 SAFE/DESTRUCTIVE/YOLO 标签） | 🟡 | plan/act+批准卡；**profile 族+安全标签面**比我们两档细 |
| 会话 | per-session messages.jsonl+metadata；`vibehistory`；session title 后台生成 | ✅ | 持久化+自动命名缺后者 |
| 会话 | **rewind 默认 fork**（原会话留为 parent 分支）+可选恢复文件快照（checkpoint 围工具调用拍） | 🟡 | rewind+fileops 有；**"rewind 默认 fork 不毁原件"+文件快照围调用拍**语义更强 |
| 执行 | 权限=规则库（tool×scope×wildcard 调用模式）+session 批准重置+只有显式 yes 执行 | ✅ | lattice 同构 |
| 执行 | **bash tree-sitter 权限分析**：给出具体动态构造原因（命令替换/算术展开/子壳/Zsh 展开…），不可静态分析即升级 ask；批准卡带"为什么" | 🟡 | 静态解析有；**把"哪类构造触发 ask"写进批准理由**=可迁移细节 |
| 执行 | **middleware 管道**：turn/price/token 上限+auto-compact+context 警告+read-only 注入全在 before_turn 统一裁决 | 🟡 | 预算门+compact 有；统一 middleware 面是机制差异非功能 |
| 执行 | smart-approve profile=模型分类器门 | ❌ | LLM 分类器候选未做 |
| 可见性 | 工具事件 start/update/end 流式+AgentStats（steps/tokens/cache/按结局计数 agreed/rejected/hook_denied） | 🟡 | 工具卡+stats 有；按结局计数维度无 |
| 上下文 | AGENTS.md+project context（git status/log，`-c core.fsmonitor=`+`--no-optional-locks` 防 fsmonitor 注入）+per-profile md overlay | 🟡 | AGENTS.md 有；**fsmonitor 自防御细节**值得偷 |
| 上下文 | compaction=成功摘要后才改 live 列表（失败不动 transcript）+边界注入 envelope | 🟡 | compact 有；事务性边界细节无 |
| 协作 | `task` 子代理（explore 默认+SUBAGENT 标记+深度帽 1+TaskResult 压缩回传） | 🟡 | delegate_task；深度帽/结果压缩同构弱 |
| 扩展 | hooks（PRE_TOOL/POST_TOOL/POST_AGENT+**兼容 Claude Code/Kimi hook 协议**）+skills（.vibe/.agents 多源+远端 registry）+plugins+**custom Python tools**（config.tool_paths）+MCP（**sampling 支持：server 回调模型**） | 🟡 | 同边界；custom tool 路径装载=managed extension 近似面 |
| 模型 | MISTRAL+GENERIC 双 backend（GENERIC 一套 httpx 五种 api_style）+glob/regex 模型模式 | 🟡 | provider_add 同构 |
| 平台 | TUI+vibe-acp+headless+Rust 统一 harness 灰度缝 | ⛔ | 单桌面面 |

**缺口小结**: 可迁移 = **profile 族+安全标签**、rewind-默认-fork、bash 权限分析带"哪类构造"理由、fsmonitor 自防御、custom tool 装载面、MCP sampling（若做 MCP）、按结局 AgentStats。

---

## 20. OpenClaw（personal-AI gateway · MIT · SOURCE-READ）

> `harnesses/openclaw.md`；gateway/session 面是资产，agent harness 可插拔（内置+codex+copilot）——与我们"多身体"最同构。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | gateway daemon（18789 WS+HTTP 复用）+`openclaw.json`+~30 频道插件 | ⛔ | 网关形态不同（我们是 app）；但"会话/审批/转写归 gateway 所有"=我们 host 同构 |
| 输入 | 频道消息即输入（Telegram/Discord/Slack/Signal/WhatsApp/Matrix/iMessage/IRC/Line/飞书/Teams…）+TUI+web UI+移动 apps | ⛔ | 频道面=产品形态外（自有 UI） |
| 会话 | per-session JSONL+checkpoint jsonl+修复备份+trajectory sidecar+gzip 归档；session catalog 上游链接 | ✅ | 会话持久化+审计同构；trajectory sidecar/压缩归档细节可借鉴 |
| 执行 | exec 批准流（频道原生批准卡+ACP permission relay+配对设备命令权威） | ✅ | 批准卡+PendingAsks 同构 |
| 执行 | **sandbox 后端注册表**（docker/podman/ssh+fs-bridge+mount 计划+noVNC computer use）+cloudPlacement | ❌ | 无沙箱后端（win32 桌面定位下可选性低） |
| 执行 | **writer-claim fencing**（activeWriterRunId 在 SQLite commit 事务内校验——superseded run 写不进转写） | ✅ | 写租约+fencing 同构（已实装） |
| 执行 | **tool-loop 检测 6 种**（generic_repeat/argument_churn/unknown_tool_repeat/poll_no_progress/circuit_breaker/ping_pong）+warning/critical 阈值 | ❌ | 无循环检测（重复缺口第 5 次出现，升级为系统性缺口） |
| 执行 | 不可信内容包 `<<<EXTERNAL_UNTRUSTED_CONTENT id>>>`+检测器 canonicalize 防伪造 | ❌ | 无不可信内容封套（注入卫生缺口） |
| 上下文 | system prompt ~1600 行有序节+**CONTEXT_FILE_ORDER**（agents<soul<identity<user<tools<bootstrap<memory）+缓存边界哨兵 | 🟡 | InstructionEnvelope+AGENTS.md+soul briefing 同构更深；缓存边界工程无 |
| 上下文 | memory_search/memory_get（FTS+向量+embedding cache）+dreaming 固化+active-memory | 🟡 | soul/models 认知态不同机制；**语义记忆检索**无（这是少数向量用得其所的面） |
| 上下文 | context-engine 插件面（assemble/compact/maintain 三相位归插件所有） | ❌ | 无插件化 context 管线 |
| 协作 | sessions_spawn（collect 批量扇出）/sessions_yield/agents_wait/subagents 列表取消 | 🟡 | delegate_task 单发；扇出/等待原语无 |
| 协作 | **harness 注册表**：registerAgentHarness+supports()→priority+fallbackRuntime 无损回退；CLI backends 另族 | ✅ | 多身体 supervisor+handoff 同构（我们身体=完整 harness；它的 harness=执行器插件，粒度不同） |
| 协作 | cron/heartbeat/automations+watched-sessions | ❌ | 无定时/心跳 |
| 持久化 | agent SQLite+会话/投递存贮+session binding 血统（bindingStore 跨 id 轮换） | ✅ | instance root+会话同构 |
| 扩展 | plugin SDK 全面（harness/provider/channel/tool/KV state）+~150 bundled+skills workshop（skill-creator 自建）+hooks+memory 插件+MCP 双向（client+serve 自家工具） | 🟡 | managed 装载同思路；**skill-creator/skill_workshop（agent 自建 skill）**无 |
| 模型 | ~50 provider 插件+auth profiles（order/fingerprint）+fallback 链+compatibleIds 门控 | 🟡 | provider_add+显式选；fallback 链/auth profile 族无 |

**缺口小结**: 可迁移 = **tool-loop 检测器族**、不可信内容封套、secrets "write-only" 工具+egress 哨兵、sessions_spawn/yield/wait 委派原语、cron/heartbeat、memory 语义检索、dreaming 固化、skill-creator、prompt 缓存边界工程。频道/apps 面=形态外。

---

## 21. Hermes Agent（Nous Research · CLI+gateway~20平台+TUI+desktop+ACP+OpenAI 兼容 API · MIT · SOURCE-READ）

> `harnesses/hermes.md`；"agent 应该积累"：后台 review→distill 成 skills/memories、FTS5 跨会话搜索、~60 核心工具、插件注册面极大。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | REPL+~50 子命令+`hermes fallback`+profile（HERMES_HOME 隔离） | 🟡 | setup 卡+命令面板；profile 隔离无 |
| 输入 | 交互/单查询/webhook（webhook 安全工具集剥文件/exec）；`clarify` 工具=结构化澄清 | 🟡 | 结构化提问缺口同上；webhook 入站无 |
| 会话 | SQLite WAL+messages_fts(+**trigram CJK 全文**)+`session_search` 工具（role_filter/around_message_id 展开） | 🟡 | session_search 有；**跨会话 FTS+CJK 分词**无；agent 可自查历史工具无 |
| 会话 | rewind（checkpoint/rewind 模块）+conversation_generations（原地压缩保持 session id） | ✅ | rewind 同构 |
| 执行 | **HARDLINE_PATTERNS**：YOLO 也过不去（递归删根/家目录、fork bomb、写裸设备、mkfs/dd）+quote-mask 防误报 | ✅ | 负能力硬拒同构且我们更强（规范锚校验） |
| 执行 | 批准队列（session/always 按 pattern 持久化）+approval transports 可插拔+上下文探测（cron/无人值守跳过提问） | ✅ | PendingAsks+批准卡同构；上下文感知跳过=我们 risk_mode 等价 |
| 执行 | `execute_code`：模型写 Python 在沙箱跑+经 RPC 桥调工具（token 认证+allowed_tools 白名单+迭代退款） | ⛔ | code-mode 拒绝（同 Qwen） |
| 执行 | `tool_guardrails`：幂等 vs 变异工具集+重复观测→警告/合成结果/受控停机；`repetition_guard` | ❌ | 循环检测无（第 6 次出现） |
| 执行 | IterationBudget（子代理分预算 250+`execute_code` RPC 退款）+run-budget 80% wrap-up 提示 | 🟡 | 预算门+委派同构；按迭代退款/渐进提示细节无 |
| 上下文 | system prompt 三层（stable/context/volatile）+**恢复会话不重跑插件段**（frozen sections 重解析） | 🟡 | InstructionEnvelope 同构；缓存稳定性工程弱于它 |
| 上下文 | 上下文文件拦截注入标记（`_scan_context_content`）+子目录 hint 追加进 tool result（不动 system prompt 保缓存） | 🟡 | AGENTS.md 有；子目录渐进装载+注入扫描无 |
| 上下文 | 双层压缩（85% 卫生+50% 主动）+ContextEngine 插件可整体替换策略 | 🟡 | compact 有；可插拔压缩策略无 |
| 协作 | `delegate_task` 子 agent+async_delegations 台账（stall 簿记+delivery claims）；**Kanban Swarm**：SQLite 黑板（task_comments 带 `[swarm:blackboard]` 前缀）+leader/parallel worker/verifier/synthesizer | 🟡 | delegate_task 同构；**黑板式 swarm+看板工具族**无 |
| 协作 | cron 全栈（scheduler/jobs/delivery_queue/detached worker+blueprint 目录） | ❌ | 无定时任务（反复出现的缺口） |
| 协作 | **browser_* 全套+browser_vault 凭据填充**+computer_use+ha_*（Home Assistant）+kanban_*（12 个）+tts/image_generate | ❌ | browser/computer-use 无（browser 属候选面） |
| 持久化 | `--save_trajectories` JSONL（训练数据面）；memories MEMORY.md/USER.md；auxiliary 模型分工（curator/vision/title/search/compression 各可绑 provider/model） | 🟡 | 持久化同构；trajectory/auxiliary 分工无 |
| 扩展 | **插件注册面最大**：tool/platform/CLI 命令/hook(~20)/middleware/system-prompt 段/skill/redaction/approval transport/context engine/memory provider + scoped providers（image_gen/video_gen/web_search/browser/terminal_env/secret_source/tts/transcription）；pip entry points；skills hub 多源+`skill_manage`（create/patch/delete） | 🟡 | managed 装载同思路但窄；**skill_manage=agent 自建/改 skill** 无 |
| 模型 | ~38 provider 插件+CredentialPool 租约+fallback 链+codex_app_server 传输（把整个 turn 托给外部 runtime） | 🟡 | provider_add+多身体；fallback 链/凭据池无 |

**缺口小结**: 可迁移 = **跨会话 FTS 搜索（含 CJK trigram）+agent 可查的 session_search 工具**、tool_guardrails 幂等/变异集+重复停机、后台 review→skill/memory 蒸馏环、cron 栈、ask_user/clarify 工具、browser 工具族（候选）、trajectory 导出（训练/复盘面）、auxiliary 模型分工、skill_manage 自建、run-budget 渐提示。

---

## 22. WorkBuddy（腾讯 · 桌面办公 agent · 闭源 · DOCS-ONLY）

> `harnesses/workbuddy.md`；"OpenClaw for the office"：与 CodeBuddy 同引擎，本地工作空间任务+IM 远程遥控+专家团队。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | 微信/QQ/手机登录+积分计费；任务绑定**工作空间文件夹**（每个任务一个目录） | 🟡 | 工作区选择同构；账号/计费外 |
| 输入 | `@` 文件/文件夹/项目资产引用；长粘贴自动转附件 | 🟡 | @附着有；@folder/资产库引用无 |
| 会话 | 任务状态机（规划中/进行中/完成/失败/待处理/归档）+排队+Esc 打断+断点续聊 | ✅ | 会话 CRUD+steer+abort 同构；归档生命周期无 |
| 执行 | 默认权限模式逐风险动作问（敏感路径/批量删除/脚本/网络/敏感能力-浏览器、屏幕输入、MCP、connector）；Full Access 本任务全免 | 🟡 | lattice 更严；**按敏感能力类目的授权粒度**无 |
| 执行 | 沙箱执行命令+**删除保护走回收站+改前备份**（Windows） | 🟡 | 文件守护有（fileops 备份/恢复面已有，验证其是否走回收站语义） |
| 执行 | 第三方 skill 注入风险明示（含 OpenClaw 兼容 skill 的供应链警告） | 🟡 | managed manifest 是供给侧管控；用户侧风险提示面弱 |
| 可见性 | 执行步骤可见+成果面板"一键导出"+后台终端输出可查 | 🟡 | 工具卡+导出；**成果/artifact 面板**（产出物聚合视图）无 |
| 上下文 | CODEBUDDY.md 记忆+rules/+agents/+skills/+commands/（`.codebuddy/` 项目目录）；**夜间自动提取个人偏好写入记忆**；资料库（共享参考文件+版本历史） | 🟡 | AGENTS.md+记忆面；**自动记忆提取任务**+资料库无 |
| 协作 | **专家团队**：团长分解→成员并行→团长整合（100+ 预置专家=人设+方法论+工具子集） | 🟡 | delegate_task 单发；团队拓扑/角色市场无 |
| 协作 | 协作空间：任务共享/转交/协作运行；**共享任务里个人 connector 强制禁用**（凭据不泄漏给队友） | ⛔ | 多人协作形态外；但凭据隔离思路值得记 |
| 协作 | 云端助理 7×24 托管+桌面定时任务+**Claw 桥**（企微/QQ/飞书/钉钉/微信消息驱动本地执行） | ⛔ | 云托管/IM 桥形态外 |
| 持久化 | 任务持久化+分享链接+草稿/附件面板 | 🟡 | 持久化有；分享链接无 |
| 扩展 | 20+ 内建 skill（Office 套件/PDF/浏览器自动化/图视生成/邮件）+市场+zip 导入+**"描述需求造技能"**（agent 自写 SKILL.md）+MCP/CLI connector+ima 知识库 | 🟡 | managed 装载；办公类 skill 生态+自建 skill 无 |
| 模型 | 内建多模型切换（Hunyuan/GLM/MiniMax/Kimi/DeepSeek）+快/均衡/极致档+models.json 自定义热重载 | 🟡 | provider_add 有；档预设/热重载面弱 |

**缺口小结**: 可迁移 = **artifact 成果面板**、夜间记忆提取、描述造技能（skill 自写=skill-creator 同族）、任务归档生命周期、@folder 引用、第三方内容风险提示。云托管/IM 桥/协作空间=形态外。

---

## 23. CodeArts Agent / 码道（华为云 · IDE+插件+CLI · 闭源 · DOCS-ONLY）

> `harnesses/codearts-agent.md`；企业优先：托管 codebase 索引（语义+图谱）、SDD 流水线、Agent Team 共享任务池、治理即产品。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | 三形态（码道IDE/插件/CLI `codearts` TUI+`run -p`+`--attach :4096`+`--fork`+`--title`）+`codearts codebase --init`+`agent create/debug`+`stats`+`/self-upgrade` | 🟡 | app+setup 卡；attach/fork/CLI/自升级无 |
| 输入 | 交互 TUI+流式+思考显示+多轮 steer | ✅ | 同构 |
| 会话 | sessions list/resume/fork；IDE Agent Space 工作区 | ✅ | 会话 CRUD+fork（分支 rewind 近似） |
| 执行 | Build（执行）/Plan（只读）双内置 agent+`--permission-mode` | ✅ | plan/act+risk_mode 同构 |
| 执行 | **SDD 流水线**：spec.md(EARS)→design.md→tasks.md→执行，相位间人工确认门+`/sdd-*` 命令族 | ❌ | 无 spec 驱动流水线（Kiro 同型；高价值候选） |
| 执行 | "安全沙箱"（机制未公开）+per-agent 权限隔离（敏感数据/知识库/高危 API/文件资源按 agent 门控） | 🟡 | lattice 更严；per-subagent 权限域无 |
| 上下文 | **托管 codebase 索引**：关键词+语义+图谱检索，个人本地建/团队云端建拉到本地，千万行级（VENDOR-CLAIM）+codebase 检索开关 | 🟡 | grep 词汇检索为主；**托管索引**=与"无向量索引"决策不同的路（企业级语义检索候选，需重新评估产品边界） |
| 上下文 | 知识空间（文档库 agent 可查）+三级 rules（项目/团队/企业，企业规则全员生效） | 🟡 | AGENTS.md 单层；知识空间/多级规则无 |
| 协作 | **Agent Team**：leader 编排+teammate **持久上下文**+双向通信+**共享任务池自主认领**+动态建员+故障自动换人+`/save-team` 模板 | 🟡 | delegate_task 单发；团队池/持久成员无 |
| 协作 | CodeArts MCP 一家伙接 8 个 DevOps 模块（需求/代码托管/流水线/检查/测试/部署/构建/制品）+issue-fix 流 | ⛔ | 垂直 DevOps 集成=生态外；但"一个 MCP 聚合垂直套件"模式可记 |
| 持久化 | 会话+索引对象+usage 统计（per-seat token 配额） | ✅ | 持久化+stats 同构 |
| 扩展 | skills 中心+zip 上传+自定义 agent（console/CLI 建，`agent debug` 看解析后的权限/工具/模型/prompt）+MCP+slash 自定义 | 🟡 | managed 装载同思路；**agent debug（解析后配置检视）**面可借鉴 |
| 模型 | GLM/DeepSeek 内建+企业自注册模型（OpenAI/Anthropic 格式）+**模型白名单+月度 token 配额**+ArkTS-SPARK（OS 专用模型） | 🟡 | provider_add 有；配额/白名单=企业治理面外（单人产品） |
| 治理 | 企业管理面：席位/审计日志/隔离仓/IP 白名单/SSO/隐私模式 | ⛔ | 企业 SSO=登记拒绝；审计日志我们已有（审计视图） |

**缺口小结**: 可迁移 = **SDD 流水线（spec→design→tasks 工件+相位门）**——与 Kiro spec 面同族，产品化最完整的实现参照；`agent debug` 解析后配置检视；托管 codebase 索引需做"是否打破无向量索引边界"的产品决策；Agent Team 任务池是 delegate 演进方向的参照。

---

## 24. DSH（DeepSeek 上游，本仓深度托管身体 · MIXED）

> `harnesses/dsh.md`；Cordis 服务树（~110 服务可挂载/替换），本仓 AIC 控制面持有整个 runtime 组成（pin+sha+managed_rows+critical_plugins+last_known_good）。

| 面 | 对方功能（身体层） | 我方 app 面 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `dsh web`（本仓 launcher pin node+包校验+UI build hash） | ✅ | 经 app 多身体面板接入 |
| 输入 | plan-mode（`plan-mode` 服务+`exit_plan_mode`）+`ask_user_question` 工具+`/goal`/`/compact` 命令 | 🟡 | plan/act 有；**body 的 ask_user 是否接到批准卡=需核实**（ PendingAsks 面向 host 命令；DSH 原生 ask 走 web UI） |
| 会话 | session-persistence-jsonl（zstd 多帧）+session-query-sqlite+projection+telemetry | ✅ | 身体侧持久化；app 会话列表走 host |
| 执行 | `approval`/`permission`/`sandbox`/`sandbox-policy`/`pwsh-sandbox`/`bash-sandbox`/`fs-sandbox`/`fs-observation-policy` 服务族 | 🟡 | **DSH 原生批准/沙箱与本仓 lattice 的关系=身体内部面，app 批准卡不一定截到**（事件接了吗？需核实） |
| 执行 | `repeat-tool-reminder`（重复调用提醒，本仓有 patch 防 undefined） | 🟡 | 身体层有；app 面无循环检测 UI |
| 执行 | `token-meter`/`llm-retry`（retryPolicy：mode/maxRetries/retryableCodes/指数退避 jitter） | ✅ | 身体层 retry；app 面 auto_retry 同构 |
| 上下文 | `agent-instructions`（~/.dsh/AGENTS.md 分层+checksum 管理生成块）+`spill-local`/`spill-policy`+`tool-result-pruner`（本仓 fork：溢出写 artifact+restore 再水化） | ✅ | 同构且本仓加深（pruner fork+context 包首帧注入） |
| 上下文 | `compaction-basic`+`command-compact`+本仓 compaction-convergence fork（checkpoint 感知选区+收敛指纹+三连败断路） | ✅ | 身体层压缩更强（本仓加持） |
| 协作 | `tool-subagent`（spawn/fork+backgroundMode:continuable+per-call provider/model）+`subagent_codex`/`subagent_claude_code` provider（disabled）+`tool-workflow`（worker thread 引擎）+`tool-ralph`（迭代 subagent 驱动 64 轮）+`tool-jobs`（job_output/kill/list） | 🟡 | **身体层能力比 app 面厚**：subagent fork/工作流/ralph/jobs 模型可直达但 app 无对应可视面（job 面板是 host jobs 非 DSH jobs） |
| 协作 | `tool-goal`（create/update/get_goal）+goal-round-driver（多轮自主续走，max_goal_rounds=10） | 🟡 | **goal 多轮自主=身体有，app 无 goal 状态可视/管理面** |
| 持久化 | 事件流+checkpoint-policy | ✅ | 同构 |
| 扩展 | `tool-skill`+`skill-filesystem`（`~/.dsh/skills/` 经 sync_skills.py 从本仓 skills/ 同步）+MCP client patch 行（`mcp__<s>__<t>`+toolCallTimeoutMs）+`ctx.tools.guard()` 单调前置卫+`ctx.on` waterfall（pre-step/request/post-execute/system-prompt-assemble） | 🟡 | skills 经托管同步已通；MCP 经 patch 可达但 app 无配置面；guard=本仓治理挂载点（已用） |
| 模型 | `llm`+`llm-pi-ai`+`llm-deepseek`+provider registry+UNKNOWN_MODEL 准入+workflow-model-preflight-gate | ✅ | 模型准入+预算门同构 |
| 平台 | web app（bundled pin）+remote-web-gateway+dshmarket | 🟡 | web 面是身体的；app=控制面 |

**缺口小结**: DSH 是"身体厚、app 面薄"的典型——**goal 状态/subagent 树/workflow/job 在 DSH 内部跑但 app 不可视**。可迁移 = body 能力→app 投影的桥接面（goal 面板、DSH jobs 接入 job 面板、ask_user→批准卡桥）。这与"缺功能"不同：是**已有能力未投影**。

---

## 25. Pi（Earendil Works · CLI+rpc · MIT · SOURCE-READ）

> `harnesses/pi.md`；最小核+extension-everything；刻意无 MCP/无进程内沙箱；**我方 pi/ 层的上游**。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `pi` TUI+`-p` print+`--mode json`+`--mode rpc`（JSONL 命令通道：prompt/steer/follow_up/abort/new_session/get_state/set_model/set_thinking_level…） | 🟡 | 我方经 body 适配器用 pi；rpc 通道=我们 HTTP 桥同族 |
| 输入 | steer（打断偏置）+follow_up 队列；custom entries（扩展持久化态不入上下文） | ✅ | steer/queue 同构（我们经 host 层实现） |
| 会话 | **session 树**（每条目 parentId+可动叶指针）：fork/clone/`/tree` 导航+branch summary+compaction 写 summary 条目不改历史 | ✅ | navigateTree rewind+分支保留同构（我们在上层借力） |
| 执行 | 工具调用**默认并发**（beforeToolCall 可改参/拦截+terminate 标志批早停） | 🟡 | 身体层并发；app 批准卡对批的呈现需核实 |
| 执行 | 无批准模式梯度——`beforeToolCall`/扩展 `tool_call` 事件拦一切（policy 是扩展定义） | ✅ | 我们补了完整 lattice+批准卡（身体层空白的治理正好是我们加的） |
| 上下文 | AGENTS.md/CLAUDE.md 无论 trust 都装；`.pi/SYSTEM.md`/`APPEND_SYSTEM.md` trust 门控；compaction（reserveTokens 16k+keepRecent 20k+summary 递归合并+readFiles/modifiedFiles 交接+`session_before_compact` 可否决/定制） | ✅ | compact+AGENTS.md 同构；**compact 前钩子可否决**细节可借鉴 |
| 上下文 | trust 体系（project-trust.ts：项目扩展/skills/themes/SYSTEM.md 要 trust；`~/.pi/agent/trust.json` 父目录继承；非交互不弹 ask→untrusted） | 🟡 | 我们有托管装载（更强管控）；**项目级 trust 决策持久化**面弱 |
| 协作 | 无内置 subagent 工具——经扩展+`ctx.sessionManager`（newSession/fork/switchSession）自建 | 🟡 | delegate_task 是我们加的（身体无原生） |
| 协作 | `*Operations` 接口可换远端（SSH/container/micro-VM Gondolin）——执行后端无缝 | ❌ | 无远程执行后端（KAOS 同思路） |
| 持久化 | JSONL v3（header+parentId 树）+SQLite backend 可选；custom entry=扩展状态持久化 | ✅ | 同构 |
| 扩展 | **in-process TS 扩展**（jiti 免构建+事务化装载+~40 生命周期事件+registerTool/Command/Flag/Shortcut/渲染器/provider/UI 组件）+`pi install` 包管理（npm:/git:/local+pi manifest+项目/全局 scope）+skills/prompts/themes 同机器发现 | 🟡 | 我们 managed-extension（manifest+sha）是更严的子集；**事件面~40 个+事务化装载**=扩展深度的参照 |
| 模型 | ~35 provider 生成目录+OAuth 族+`models.json` BYOK+`provider/model:thinking` 解析 | 🟡 | provider_add+thinking_level 同构（经我们 UI） |
| 平台 | TUI+print/json/rpc+server/client 包+SDK | ⛔ | 单桌面面 |

**缺口小结**: 我方上游身体的强项（session 树/rpc/扩展事务化）已被我们在治理层借力。可迁移 = **custom entry（扩展持久化态）**、compact 前否决钩子、project trust 持久化决策、`*Operations` 执行后端抽象（若做远程）、扩展渲染器面（工具卡渲染可由扩展定义）。刻意拒绝项（无 MCP/无沙箱）与我们决策一致。

---

## 26. Mini-SWE-Agent（SWE-bench 团队 · ~190 行核心 · MIT · SOURCE-READ）

> `harnesses/mini-swe-agent.md`；刻意下限：一个 agent 类+一个环境调用+一个模型调用；轨迹=上下文同一对象。

| 面 | 对方功能 | 我方 | 缺口/证据 |
|---|---|---|---|
| 开屏 | `mini -t "task" --yolo`+config spec 代数（`-c` 收路径/内建名/`a.b.c=value` 递归合并） | 🟡 | app 形态不同；config spec 代数思路小 |
| 输入 | 只有 bash 一个工具；v2 工具调用式/v1 文本围栏式双解析器 | ✅ | 我方工具面远超 |
| 会话 | **每步 finally 存轨迹**（崩溃也出完整 traj 结尾合成 exit 消息）；traj.json=训练/调试记录一体 | 🟡 | 会话持久化有；**逐步落盘+崩溃合成终态**=我们 job 日志近似但会话级弱 |
| 执行 | step_limit/cost_limit($3)/wall_time/max_consecutive_format_errors；`confirm` 模式逐命令问+whitelist regex+Ctrl-C 变 UserInterruption **消息进历史**（模型看得见"被打断"） | 🟡 | lattice+预算门同构；**打断作为消息回注历史**细节值得偷（我们 abort 后模型是否看到"用户打断"？） |
| 执行 | 终止=环境侧 stdout 哨兵 `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`——完成是环境事件非工具 | 🟡 | 我们 task_done 工具式；哨兵思路备注 |
| 上下文 | 无——线性历史无压缩，溢出即死 | ✅ | 我方 compact 完整 |
| 协作 | 无 subagent；benchmark runner 驱动多实例 | ✅ | 我方 delegate 超出 |
| 扩展 | 无插件——子类化四个 seam（Agent/Environment/Model/run script） | ✅ | 我方 managed 扩展超出 |
| 模型 | LiteLLM 100+ provider+tenacity 重试 10 次+cost 累计+deterministic test model | ✅ | 同构 |
| 平台 | CLI+库+inspector TUI（轨迹查看器） | 🟡 | inspector=我们审计视图同构 |

**缺口小结**: 刻意下限，几乎全面对标项。可迁移仅两点 = **打断作为消息回注**（用户中断进上下文让模型知情）与**每步落盘崩溃保轨迹**（我们会话/事件流已有等价，验证崩溃路径即可）。价值在于对照：我们多出的每一层都要有理由——审计显示都有（治理/批准/身体管理是其刻意不做的产品面）。

---

## 27. 跨 harness 功能缺口汇总

> 汇总口径：同一功能面在 ≥4 家出现的记为**系统性缺口**（业界共识=该面是 harness 标配）；<4 家记为**单点**；有意不做进拒绝清单。优先级 P0=可靠性/已建能力未投影，P1=主流标配缺面，P2=增强面，P3=长尾/待产品决策。

### 27.1 系统性缺口（≥4 家共有，我方缺失或部分）

| # | 功能面 | 出现方（节选） | 我方状态 | 优先级 |
|---|---|---|---|---|
| G1 | **循环/卡死检测**（重复工具调用→警告/停机/恢复选项） | OpenHands StuckDetector、Goose RepetitionInspector、Roo ToolRepetitionDetector、Crush hasRepeatedToolCalls、Qwen loop_detected、Kimi max_steps、OpenClaw 6 检测器、Hermes tool_guardrails/repetition_guard、DSH repeat-tool-reminder（身体层） | ❌ app/host 面无（DSH 身体层有提醒） | **P0** |
| G2 | **结构化提问工具**（agent 发起选项/开放问暂停等答，非批准） | Cursor question、Claude Code AskUserQuestion、Kimi/Qwen ask_user_question、OpenCode question、Hermes clarify、DSH tool-ask-user、Crush question | ❌ 只有批准卡（二元决策），无自由问答 | **P1** |
| G3 | **定时/调度任务**（cron、scheduled runs、heartbeat） | Goose scheduler+recipe、Qwen cronScheduler、Claude Code CronCreate、Hermes cron 栈、OpenClaw cron/heartbeat、Kimi Cron 工具、WorkBuddy 定时任务、ZCode 空闲任务 | ❌ 无（jobs 是手动长任务非调度） | **P1** |
| G4 | **子代理 profile/拓扑**（内置 Explore/Plan 等画像、自定义 frontmatter agent、委派树可视） | Claude Code .claude/agents、Cursor .cursor/agents、Roo modes+Boomerang、Kimi profiles+AgentSwarm、Qwen builtin-agents、Hermes delegate+swarm、CodeArts Agent Team、WorkBuddy 专家团队、ZCode subagents、DSH tool-subagent | 🟡 delegate_task 单发跨 agent；无画像定义/无拓扑投影/无任务池 | **P1** |
| G5 | **生命周期 hooks**（Pre/PostToolUse、SessionStart、Stop 等用户可配命令） | Claude Code ~30、Kimi 13、Goose 12、Crush matcher hooks、Qwen hooks、Vibe 三型（兼容 CC/Kimi 协议）、OpenHands 无（microagent 代替）、Hermes ~20 | ❌ 无 hooks 面（managed extension 是装载面非事件面） | **P2**（需产品决策：是否与 managed 装载合并） |
| G6 | **跨会话/持久记忆**（自动记忆写入、语义检索、夜间提取） | Claude Code auto memory、Hermes MEMORY/USER.md+auxiliary、OpenClaw memory_search+dreaming、WorkBuddy 夜间提取、Qwen memory/、CodeArts 知识空间 | 🟡 soul 认知态层存在但非运行时自写记忆；session_search 跨会话全文已有 | **P2** |
| G7 | **OS 级沙箱**（Seatbelt/Docker/容器 per-session） | Claude Code、Cursor、OpenHands Docker、Qwen serve、OpenClaw 后端注册表、mini-swe env swap、Hermes 容器后端、CodeArts 沙箱 | ❌ 无（win32 桌面+写租约+policy 门是当前边界） | **P2**（产品决策：WSL2/Job Object 方向待裁） |
| G8 | **web/浏览器工具**（web_search/web_fetch/浏览器自动化） | Hermes browser_*+vault、OpenHands browsing、ZCode 浏览器面板、WorkBuddy Agent Browser、Kiro browser verify、Trae/Kimi/Qwen web 工具、DSH tool-web（身体有 fetch:false） | ❌ app 面无 web 工具；DSH 身体有 search 未启用 fetch | **P1**（web_search 轻量先做；browser 自动化另裁） |
| G9 | **LLM 权限分类器**（smart approve：模型判只读/危险，fail-closed） | Qwen AUTO 两段式、Goose SmartApprove、Vibe smart-approve、Devin Smart、Claude Code auto | ❌ 登记候选未做（静态分类+人工卡是现路径） | **P2** |
| G10 | **MCP 客户端** | Cline/Roo/Goose/OpenCode/Crush/Kimi/Qwen/Vibe/OpenHands/Trae/Kiro/ZCode/Cursor/WorkBuddy/CodeArts（Pi 刻意拒绝、mini 无） | ❌ 无（managed-manifest 空扩展表；Pi 上游同样拒绝 MCP） | **待产品决策**（最大单块缺面；拒绝理由=治理边界 vs 生态接入价值） |
| G11 | **spec/SDD 流水线**（需求→设计→任务工件+相位确认门） | Kiro specs（EARS）、CodeArts SDD、Devin plan→execute、ZCode Goal Mode（证据验收） | ❌ 无工件化规格模式（plan/act 是行为档非工件流） | **P2** |
| G12 | **远程执行目标**（SSH/容器/WSL 后端抽象） | Kimi KAOS、ZCode SSH/WSL/Docker、OpenClaw ssh 后端、Pi *Operations、Devin 云 VM、Hermes 容器后端 | ❌ 无 | **P3**（产品边界：本地单机定位） |

### 27.2 我方特有/近端缺口

| # | 功能面 | 说明 | 优先级 |
|---|---|---|---|
| U1 | **DSH 身体能力未投影** | goal 对象（goal-round-driver 多轮自主）、subagent spawn/fork、workflow、tool-jobs、ask_user_question 均在身体层运转但 app 无可视/无批准卡桥接——**不是缺功能，是已有功能用户看不见** | **P0** |
| U2 | **不可信内容封套** | OpenClaw `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`、OpenHands `<UNTRUSTED_CONTENT>`、Goose unicode-tag 消毒——工具结果/文件内容进上下文无注入标记纪律 | **P1** |
| U3 | **rewind 语义强化** | Vibe rewind 默认 fork（不毁原件）+围调用文件快照；ZCode 双域 rewind；我方 rewind+fileops 是双 scope 手动，无"每回合自动快照+一键双域回滚" | **P2** |
| U4 | **写前 secret 扫描** | Qwen edit/write 结果查凭据后才落盘；Hermes redact.py | **P2** |
| U5 | **自定义 mode/profile** | Roo 工具组×fileRegex、Vibe 安全标签 profile——我方 plan/act 两档固定，用户不能定义"只许读+搜索"之类的画像 | **P2** |
| U6 | **编辑历史消息重发** | Roo editMessageAndRegenerate、Claude Code EscEsc；我方仅 editorText 回填+分支 | **P3** |
| U7 | **artifact 成果面板** | WorkBuddy/ZCode/Devin 产出物聚合视图+一键导出 | **P2** |
| U8 | **打断作为消息回注** | mini-swe UserInterruption 进历史（模型知情"被打断"）；我方 abort 后模型侧不可见 | **P3**（与 G1 合并做） |
| U9 | **命令白/黑名单+配额 ask** | Roo allowedCommands/deniedCommands 最长前缀+maxRequests/MaxCost 上限升级 | **P2**（policy.json 可表达但无用户编辑面） |
| U10 | ** recipes/参数化任务包** | Goose recipe（instructions+extensions+参数+retry+response schema+deeplink）=宏的超集 | **P3** |
| U11 | **LSP 工具组** | Crush 一等公民（rename/replace_symbol 语义编辑）、CodeArts IDE LSP、ZCode | **P2**（登记候选） |
| U12 | **fsmonitor/git 上下文卫生** | Vibe `-c core.fsmonitor=`+`--no-optional-locks` 防恶意仓 hook | **P3**（小件，做 git 上下文时一并） |
| U13 | **自动会话命名/title** | Goose/Hermes/Kimi 后台生成标题 | **P3** |
| U14 | **会话置顶/归档/minimap/分页/主题/通知中心/onboarding 清单** | PI-Desktop 对照（已登记 `app/UI-BACKLOG.md` A11/A12/C12/D3 等） | **P3**（BACKLOG 接管） |
| U15 | **子目录渐进 hint/上下文文件族** | Goose SubdirectoryHintTracker、Hermes subdirectory_hints（追加进 tool result 保缓存）、Crush 多文件族自动装 | **P3** |

### 27.3 不适用-拒绝清单（有意不做，边界理由）

| 面 | 拒绝理由 | 反方证据（若改判需重估） |
|---|---|---|
| 插件/skill **市场**（browse/install 三方包） | managed-manifest 治理装载：一切进运行面的扩展须经校验登记；市场=不可治理供给面 | Roo/Qwen converter 提示"受控转换"是中间路线 |
| **code-mode**（模型写任意代码调工具） | 绕开静态风险分类器，与 lattice 冲突 | Qwen/Hermes 有沙箱 runtime 兜底；我方无沙箱前不碰 |
| 企业面（SSO/席位/审计租户/IP 白名单/计费） | 单用户本地产品 | CodeArts/WorkBuddy 企业版属不同市场 |
| 多渠道 IM/移动/Web/云托管 | 单桌面 app 形态；HTTP/SSE 桥是最小远程等价 | OpenClaw/Hermes/WorkBuddy 的频道面是另一种产品 |
| 向量 codebase 索引（默认开） | 与 Cursor 退役方向一致；grep+LSP（候选）覆盖导航面 | CodeArts 托管索引+Roo 可选 Qdrant 是反例——**留作待裁项不锁死** |
| headless/SDK/CI 产品面 | host channel 已程序化；不包装成用户产品 | Codex exec/Goose run/mini 是开发者面 |

### 27.4 待核实项（审计中发现的实证缺口，实现前需验证）

1. **DSH `ask_user_question` 是否桥到批准卡**——若未桥，DSH 会话里的结构化提问用户看不到（G2 在 DSH 路径上的具体形态）。
2. **DSH 原生 approval/permission 事件**是否进 app 审计/批准面，还是只在 DSH web UI 内闭环。
3. **abort 后 steer 消息是否作为 user 消息进历史**（mini-swe 语义）。
4. **DSH tool-jobs（Map 内存表）与 host durable jobs 的关系**——是否双轨，会否误导。
5. **fileops 备份是否覆盖"改前备份+回收站删除"语义**（WorkBuddy 对照）。

### 27.5 优先级落地建议（待用户裁定后动手）

- **P0（先做，纯补齐可靠性/可见性）**: G1 循环检测（含 U8 打断回注）；U1 DSH 身体能力投影（goal 面板+DSH jobs 接入+ask_user 桥）。
- **P1（主流标配缺面）**: G2 结构化提问；G8 web_search/fetch 工具（轻量先行，browser 自动化另裁）；G3 cron/调度（ Personal AI"主动性"定位的承载面）；G4 subagent profile+拓扑投影；U2 不可信内容封套。
- **P2（增强/决策项）**: G5 hooks、G6 运行时记忆、G7 沙箱方向、G9 LLM 分类器、G11 SDD、U3/U4/U5/U7/U9/U11。
- **P3（长尾）**: G12 远程执行、U6/U10/U12/U13/U14/U15。
- **待用户裁定的产品边界**: MCP 客户端（G10——接生态 vs 治理边界）、向量索引是否解锁（CodeArts/Roo 反例）。

**总判定**: 治理层（lattice/fencing/审计/托管装载）对标甚至超过多数 harness；**缺面集中在"agent 自主性周边"**——循环自愈、结构化提问、定时任务、子代理拓扑、web 工具——这五项是 26 家里最一致的标配，也是"功能都不全"判定的实体内容。

---

## 28. 实施回写（缺口逐项处置复核，锚 `e6a2c30`）

> §1–§26 是审计基线快照（锚 `1d75cd0`），不改动；本节记录缺口清单逐项处置结果。判定口径不变：已有/部分/缺失/不适用-拒绝。证据锚指向我方实现位置。

### 28.1 系统性缺口处置（G1–G12）

| # | 处置内容 | 状态 | 证据锚 |
|---|---|---|---|
| G1 循环/卡死检测 | LoopDetector 连发/乒乓/升级操作员裁决 + 打断回注（U8 并入） | **已有** | `host/src/core/loopwatch.js`；abort 作为消息回注上下文 |
| G2 结构化提问 | ask_user 工具 + PendingAsks 面板 | **已有** | `pi/src/adapter/askuser.js` |
| G3 定时/调度 | ScheduleStore cron + heartbeat 泵（实例级配置、空闲才发、走预算门） | **已有** | `host/src/core/scheduler.js`；pi bootstrap heartbeat |
| G4 子代理 profile/拓扑 | AgentTask mailbox（持久 inbox/outbox/events+seq/ack）+任务中心+拓扑树+scope 认领链+**画像库已有**：`loadAgentProfiles` 读 `.pai/agents`+`<instance>/agents/` frontmatter persona，`delegate_task(profile=…)` 解析 target+前置 preamble；多对多任务池=裁定书 v1 外项（parent↔child），记"不适用-推迟" | **已有** | `host/src/core/tasks.js`、`pi/src/adapter/agentprofiles.js`、`tasktools.js`、UI tasks 树 |
| G5 生命周期 hooks | 双层：workdir `.pai/hooks.json` 四事件**观察面**（agent 可写→永不许 veto，pre_tool 载入即拒）+ 实例私有 `<instance>/hooks.json` **gate 面**（agent 够不到→`pre_tool` 真否决：exit≠0 或 `{"deny"}` JSON→block，`match` 工具前缀过滤，热读，fail-closed） | **已有** | `host/src/core/hooks.js` fireGate、`pi/src/bootstrap/decide.js` preToolGate |
| G6 持久记忆 | SQLite+FTS5 检索+review 蒸馏+pinned 注入（不可信证据边界）+secret 拒写 | **已有** | `host/src/core/memory.js`、`pi/src/adapter/memtools.js` |
| G7 OS 级沙箱 | WSL2 路线落地 | **已有** | `host/src/core/sandbox.js` |
| G8 web/浏览器工具 | web_fetch/web_search + 零依赖 CDP browser 六件套（navigate/read/click/type/eval/screenshot，专属 profile，域名黑名单，截图进 artifact 预览） | **已有** | `pi/src/adapter/web.js`、`pi/src/adapter/browser.js` |
| G9 LLM 权限分类器 | shadow judge 已升级 `PAI_SHADOW_JUDGE_MODE=guard` deny-复核：执行前复审 admitted 调用（deny→block/ask→批准卡/不可达→放行+BYPASS 审计），单向棘轮永不降级 | **已有** | `host/src/core/shadowjudge.js`、`pi/src/bootstrap/decide.js` |
| G10 MCP 客户端 | managed extension 装载 + stdio/http 传输 | **已有** | `pi/src/adapter/` mcp 面 |
| G11 spec/SDD 流水线 | `.pai/specs` 三件套 + 相位门 | **已有** | spec 工具族 |
| G12 远程执行 | 维持拒绝（本地单机边界） | **不适用-拒绝** | §27.3 |

### 28.2 特有/近端缺口处置（U1–U15）

| # | 状态 | 处置/残余 |
|---|---|---|
| U1 DSH 身体投影 | **已有** | 会话通道/审批桥/审计 parity + `session/jobs` 帧进 `job_list` + `session/projection` 帧→goal-line/`get_state.projection`；job_cancel 保持 fail-closed（不伪装能杀 DSH 侧任务） |
| U2 不可信内容封套 | **已有** | `host/src/core/envelopes.js` 不可信封套 + unicode 隐形字符消毒（strict 拒/free-text 剥） |
| U3 rewind 强化 | **已有** | `/undo` 回执组回滚+聚合 `/diff`+`/btw` 只读旁路（M107 外部审查后落实为机制：fork 以 `btw-readonly` posture 构建——decide 层白名单硬拒写/bash/job_spawn/delegate/request_permission/tool_activate/mcp__*，面经 setModeDenied 会话级隐藏不污染 deny-memory）+Vibe"rewind 默认 fork"等价达成且更强：pi `navigateTree` 是**树 rewind**——弃走分支整棵留在会话文件，`session_entries` 列全树用户消息（跨分支），`session_rewind` 可导航回弃走分支任一点；fork 要防的丢时间线问题结构性不存在 |
| U4 写前 secret 扫描 | **已有** | `host/src/core/secrets.js`（写前问/失败关闭） |
| U5 自定义 mode | **已有** | Policy Preset Overlay（只收紧）+mode chip+Settings→模式 校验编辑（`modes_read`/`modes_save`）+`pathAsk`/`pathDeny` path glob 规则——Roo fileRegex×工具组粒度的语义等价（按路径模式对工具组收紧） |
| U6 编辑重发 | **已有** | 消息操作栏"编辑"=rewind 到该 entry+原文回填输入框 |
| U7 artifact 成果面板 | **已有** | 终裁批已落 |
| U8 打断回注 | **已有** | 与 G1 合并落地 |
| U9 命令白/黑名单+配额 ask | **已有** | 分层所有权落地：`.pai/commands.json`（agent 可写，收紧-only denyPrefixes）+ `<instance>/command-allow.json`（操作员私有 allowPrefixes→ask 降 allow）；前缀匹配走 Roo 最长前缀语义；Settings→命令清单 双卡编辑；配额 ask 由预算帽+批准卡覆盖 |
| U10 recipes | **已有** | `.pai/recipes/*.md`+`{{var}}` 参数+`/recipe` 展开 |
| U11 LSP 工具组 | **已有** | 只读面（definition/references/hover/diagnostics） |
| U12 fsmonitor/git 卫生 | **不适用-拒绝** | 运行态从不 shell-out git——Vibe 防的是恶意仓 hook 经 `git status` 触发；我方无此调用面，风险前提不存在 |
| U13 自动会话命名 | **已有** | 首条用户消息自动命名+`/chat` 命名存档+JSONL trajectory 导出 |
| U14 UX 工艺面 | **已有** | 置顶/归档、dark/light 主题、ctx 分解条、minimap、onboarding 向导、委派拓扑树全落 |
| U15 子目录 hint/文件族 | **已有** | steering 文件族+`.paiignore`+SubdirectoryHint 观察（path 工具首触新目录→有界目录 listing 进 observation 流） |

### 28.3 残余决策项——用户裁定（2026-09-20）

| # | 项 | 裁定 | 落地形态 |
|---|---|---|---|
| D1 | 向量 codebase 索引 | **拒绝** | 移入 §27.3 不适用-拒绝：grep+LSP+session_search 覆盖导航面；与 Cursor 退役方向一致 |
| D2 | browser 自动化面 | **做：完整浏览器工具 → 已落地** | `browser_navigate/read/click/type/eval/screenshot` 零依赖 CDP（内置 WebSocket）；专属 browser-profile；不可信封套+`browser_*`→ask+PAI_BROWSER_BLOCKED 域名黑名单 |
| D3 | agent teams 常驻 teammate | **做：v2 常驻池 → 已落地** | `delegate_task(name=…)`→kind:'teammate' 命名持久任务+spawn_spec；`teammate_msg` 按名投递；byName 跨重启可寻址 |
| D4 | Guardian 独立复审 | **做：现在就升 → 已落地** | `PAI_SHADOW_JUDGE_MODE=guard`：判官执行前复核 admitted 调用（deny→block、ask→批准卡、不可达→放行+BYPASS 审计）；单向棘轮，deny 永不降级 |
| D5 | mode 粒度加深 | 自行排期 → **已落地** | pathAsk/pathDeny 即 fileRegex 等价（path glob 规则进 overlay）；Settings→模式 卡列预设+项目 `.pai/modes.json` 校验编辑（`modes_read`/`modes_save`） |
| D6 | 逐改动 revert 面板 | 自行排期 → **已落地** | 变更面板逐回执「差异」按钮行内展开 unified diff（`fileops_diff receiptId` 过滤）+恢复按钮 |

**维持不适用-拒绝**：G12 远程执行、插件市场、code-mode、企业面、多渠道形态、headless 产品面、MCP sampling（v1 外）、向量 codebase 索引（D1 裁定）。

### 28.4 残余消耗批（2026-09-20 续，`7a038ab`/`ece8c24` 之后）

逐家缺口清单的剩余散点——不再按族而是按真实对等物逐项落地：

| 项 | 参考 | 落地 |
|---|---|---|
| `!cmd` 操作员直跑 | Claude Code bang mode | `bash_run` 通道命令→同一 decide 链（ask 弹卡/deny 拦截）→输出暂存注入下条 prompt |
| `#note` 快速记忆 | Claude Code hash mode | `memory_save` 复用族 G 存储 |
| 外部内容提示面 | WorkBuddy 第三方内容风险 | web_*/browser_* 工具卡"外部"徽章 |
| agent 自写技能 | OpenClaw skill-creator / Hermes skill_manage / WorkBuddy 描述造技能 | `skill_save`→`.pai/microagents/<name>.md`（loader 即激活） |
| 持久计划库 | Devin plans | `plan_save`/`plan_list` + `/plans` 载入续跑 |
| goal 面板（pi 侧） | Qwen goals / Trae | `ContinuationGovernor.status()`→`get_state.goals`→状态行"目标 n/m·续k" |
| DSH jobs/goal 投影 | U1 残余 | `session/jobs`+`session/projection` 帧→job_list/goal-line；cancel fail-closed |
| 写后验证反思环 | Aider lint/test 自动跑 | `.pai/verify.json onWrite` 武装——命令经同一分类器+riskActions 裁决，deny/ask 类配置拒装（VERIFY_REFUSED），失败回注 observation 流 |
| browser 预览面板 | Trae | `browser_screenshot` 工具卡内联 PNG 预览（`/api/artifact` 限 exports/） |
| 配置检视面 | CodeArts `agent debug` | `/doctor` 姿态汇总卡（模式/政策指纹/记忆/目标/.pai 面/别名/上下文） |
| 模型能力声明 | Codex models.json | `model_list` 透传注册表 vision/reasoning 能力→菜单徽章 |
| notify_user | Kimi NotifyUser | 单向通知工具（toast+系统行，不挂起回合） |
| 内置 review 模式 | Codex `/review` | 写族 deny+执行族 ask 的内置 overlay preset + `/review` 一键切换并发送审查提示 |
| 长会话分页 | Codex/OpenCode 虚拟滚动 | UI 侧虚拟分页：首渲染最近 50 条+"加载更早"按批上移，协议零改动 |
| 通知历史抽屉 | PI-Desktop notification center | 顶部铃铛+计数徽章+最近 50 条抽屉（toast 转瞬即逝的补全） |

**第二轮复扫**（逐家 ❌/🟡 行对现状重判）追加落地：

| 项 | 参考 | 落地 |
|---|---|---|
| 粘贴超长文本转附件 | Codex composer | paste 事件 text/plain >1500 字符→自动转 text attachment chip（不淹输入框） |
| 对话宽度拖拽 | Codex resize handle | `#chatw-handle` 拖 `--chat-w`（480–1400px 夹取，localStorage 持久） |
| 多路径规则兼容装载 | Devin `.devin/`+`.claude`/`.cursor` 兼容 | `loadSteering` 增读 `.claude/rules`、`.cursor/rules`(.md/.mdc)、`.windsurf/rules`、`.devin/rules`——迁移团队规则零拷贝生效 |
| `/export debug` 调试包 | Devin `/debug` 含 subagent 链 trajectory | 原始轨迹+本会话 spawn 的任务子树（run_scope/parent 链闭包）+事件流+jobs 打包 JSON |
| G5 veto 钩 | Claude Code PreToolUse | `<instance>/hooks.json` gate（操作员私有）——exit≠0/`{"deny"}`→block，match 前缀过滤，fail-closed |
| 三 scope rewind+分叉点 | ZCode EscEsc（chat/files/both）+fork 自任一消息 | `session_rewind {scope:'chat'|'files'|'both'}`（files 不动对话头；restoreFiles 为 both 的旧拼写）+`session_fork {entryId}` 分叉到任一 entry；`/rewind` 两级菜单 |
| 规则应用模式 | Trae/Kiro frontmatter globs+apply | steering frontmatter：`apply: manual`→不注入只进 `<manual-rules>` 索引；`globs:`→注入带 scope 声明属性（按触碰路径真条件注入=v2） |
| restore 不覆盖外部改动 | ZCode 安全 checkpoint 计划 | `FileOpsGuard.restore` 覆盖前先把当前字节回收进 recycle——restore 自身可逆，外部编辑不被销毁 |
| 钉文件进上下文 | CodeArts `/context add` | `.pai/pins.json`+`/pin` `/unpin`——pin 的 path 每轮**活读**进 `<pinned-files>` 段；workdir 内校验+.paiignore 双向赢（add 拒+render 跳） |

**复扫第三批**：

| 项 | 参考 | 落地 |
|---|---|---|
| mistake-limit 错误连击升级 | Roo `mistake_limit` 连续错误计数 | `LoopDetector.observeResult`——连续工具错误 ≥3（`errorLimit`）→ escalate 操作员卡（允许=继续，拒绝=本轮停）;`stopped` 后 decide 链拒绝一切调用直到新 turn 复位；无 asks 通道 fail-closed 停；错误事件先渲染不卡在卡后 |
| 根级兼容指令文件 | Crush 兼容装载（CLAUDE/GEMINI/cursorrules/copilot） | `loadSteering` 增读 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules`、`.windsurfrules`、`.github/copilot-instructions.md`——同 context-channel 语义，永远只是项目文档不是政策 |
| knowledge 注入审计 | Crush `skills.Tracker` 命中可观测 | `KNOWLEDGE_INJECTED` 审计事件（agents 名单载荷）——已存在并有测试断言 |
| 委派 spawn 深度帽 | Codex thread-tree 深度控制 | `PAI_SPAWN_DEPTH` env 经桥注入子进程，`PAI_MAX_SPAWN_DEPTH`（默认 3）封顶——到顶拒绝返回工具结果（模型可读、可绕行），teammate spawnSpec 记 depth |

**复扫第四批**：

| 项 | 参考 | 落地 |
|---|---|---|
| 兼容 agent 目录 | Cursor `.cursor/agents` / Kiro `.kiro/agents` / CC `.claude/agents` / Devin `.devin/agents` | `loadAgentProfiles` 增读四家兼容目录（同名先到先赢）；无 `target:` 的画像仅在 `PAI_DELEGATE_DEFAULT_TARGET` 设定时载入（他家 in-process 无 target 概念，我方必须指名身体） |
| `/verify` 手动跑 | Aider `/lint` `/test` 命令面 | `verify_run`/`verify_status` 通道 + `/verify` slash——绕过突发节流但**保留 arm-check**（agent 自写 verify.json 仍只能跑政策本就 allow 的类） |
| 陈旧任务对账 | Cline stale session 对账 | `task_list` 对 open 任务 join 绑定 job 终态→`stale:true` 标记（UI 显示"失联"）；teammate 是常驻设计所以只标不关 |
| 会话归档清扫 | ZCode 3/7/14/30 天自动归档候选 | `session_sweep {days=14}` + 抽屉"归档 N 个旧会话"按钮——pinned/已归档跳过，归档可逆不删除 |

**复扫第五批**：

| 项 | 参考 | 落地 |
|---|---|---|
| 指令文件祖先上溯 | Codex/OpenCode AGENTS.md 向上逐级合并 | `loadSteering` 沿 workdir 上溯≤6级收集根级兼容文件，带 `dir=` 标记排在 workdir 文件之后 |
| 更多根级兼容文件 | Goose `.goosehints` / Cline `.clinerules` / Aider `CONVENTIONS.md` | COMPAT_FILES 扩到 9 个 |
| hook 事件族扩展 | Claude Code/Codex/Kiro 生命周期事件族 | `HOOK_EVENTS` 扩到 8 个：增 `tool_start`/`agent_stop`/`compact_start`/`compact_end`（泵上真实事件点，观察面）；`tool_end` 不再挂在 writeLease 分支上 |
| 会话类型分面 | Goose sessions.db type 分面（user/subagent/scheduled） | `session_list` join 任务 run_scope→委派会话标 `subagent`/`teammate`，抽屉标题带 ↳/👥 徽章 |

**复扫第六批**：

| 项 | 参考 | 落地 |
|---|---|---|
| 模型可调任务包 | Roo `run_slash_command`（agent 自调 slash） | `recipe_run` 工具——读 `.pai/recipes/<name>.md`，required 参数缺失报错，`{{k}}` 展开后包 `<recipe>` 不可信标记返回 |
| 批准结局统计 | Vibe AgentStats 按结局计数（agreed/rejected/hook_denied） | `PendingAsks` 每次解析写 `ASK_RESOLVED` 审计行；`agent_stats` 扫审计目录聚合 `asks{allow,always,allow_session,deny,timeout,aborted,question_answered}`；`/stats` 显示批准卡结局行 |

**复扫第七批**：

| 项 | 参考 | 落地 |
|---|---|---|
| 模型请求切模式 | Claude `ExitPlanMode`（模型申请、操作员批准） | `mode_request` 工具（`pi/adapter/modetools.js`）——catalog 含命名 preset；批准卡裁决后走与 mode chip 完全相同的 `applyMode` 审计链；deny/timeout/aborted 一律拒绝 |
| 项目信任门 | Pi project-trust.ts（克隆仓库内容不静默进 prompt） | `host/core/trust.js` + `project_trust_status/set` 通道 + UI 横幅——`.pai/microagents` 触发注入仅在 `<instance>/project-trust.json` 记录该 workdir 信任后激活；信任文件在实例侧（agent 不可写）；UI 按 workdir 提示一次 |
| 产物列表面 | CodeBuddy 成果面板 | `/api/artifacts` 列出 `<instance>/exports/**`（限深4/200条）+ `/api/artifact` 单件下载（路径前缀硬约束，越界404）+ 变更页"产物"区可点击打开 |
| skill 生命周期删除面 | OpenClaw/Hermes skill_manage（save+delete 成对） | `skill_delete` 工具——只删 `.pai/microagents/<name>.md`（slug 校验），`SKILL_DELETED` 审计 |

**复扫第八批**：

| 项 | 参考 | 落地 |
|---|---|---|
| 调度操作员面 | Cline `.cline/cron` 面板（操作员可见可管） | `schedule_list`/`schedule_cancel` 通道 + 任务页"定时任务"区（id/类型/下次/上次/命令/取消）——`schedule_task` 模型的同一 ScheduleStore 真源 |
| provider 连接测试 | Cline `doctor` / 各家"测试连接" | `model_ping` → `rt.getAuth` 解析凭据 + GET `{baseUrl}/models`（8s 超时）→ {ok,httpStatus,ms,authSource}；密钥不出进程；设置页"测试连接"按钮 |
| 长命令后台化（核实行） | Cline "proceed while running" | **已有**——`isLongRunningCommand` 在 decide 链自动转 durable job（自带写租约+预算域+重启恢复），`job_status` 模型轮询；快照行过期 |

**复扫第九批**：

| 项 | 参考 | 落地 |
|---|---|---|
| repo-map 结构大纲 | Aider `/map` + tree-sitter tags→PageRank（288/289）、Cursor Code Index（226）、ZCode Repo Wiki（207）、Trae code index（235）、Kiro `code` 工具（264） | `host/core/repomap.js` 无依赖构建器：源码文件走查 + 按语言正则抽顶层符号（fn/class/iface/type）+ token 预算截断 + .paiignore + subdir 收窄 + 构建器自身路径禁锢；`repo_map` 模型工具 + `/map` 操作员命令同构双面。**PageRank/索引库有意不做**——声明式抽取覆盖"找东西在哪"主诉，依赖/复杂度不合算 |
| 旧会话拉进上下文 | Trae `#Past Chats` / Devin `#`历史链接（228/193） | `session_read` 模型工具——配合 `session_search` 先搜后读；会话目录禁锢（仅 .jsonl）、尾部限界（≤60 条/条≤2000 字符）、`<past_session trust="untrusted">` 封套 |

**仍剩**（递减收益/需真实需求驱动）：Claude Code worktree 隔离（与 writeLease+回执体系重叠，等真实并行需求）、Gemini per-model fallback 链与 trust-gated 高权模式（政策敏感面）、Hermes auxiliary 模型分工（第二路模型开销）、OpenHands 多策略 condenser、Qwen microcompaction、Pi custom-entry/compact-veto（与现有入口/压缩面设计冲突，维持有意不做；project-trust 已按微agent注入面窄化落地见上）、OpenCode tree-sitter 命令解析（新增依赖 vs 现有解析器已覆盖 pipe/subshell/单位提取）。启动闪屏已落（`#splash` 只盖真实连接等待，无假进度）。

### 28.5 第二轮逐行复扫收尾（2026-09）

对全部 26 家快照行逐行过第二遍后，残余 ❌/🟡 全部归两类——**陈旧行**（实现已落，快照锚定 1d75cd0 未动：doom_loop/mistake_limit/cron/microagent/hooks 事件族/MCP/LSP/自定义 modes/命令清单/recipe_run/ask_user/MAX_TURNS/browser 六件/长命令后台化/project-trust/artifact 面板等均有 §28.1–28.4 终态）与**有意边界**。

**最终待拍板项**（每条偏大或触边界，列为决策非缺口）：

| 项 | 参考行 | 卡点 |
|---|---|---|
| 远程执行目标（SSH/WSL/Docker） | ZCode 211、KAOS 506、serve daemon 528 | 执行环境抽象层+信任边界改写 |
| 脚本化编排（Dynamic Workflows / spec DAG 波 / Kanban swarm） | Devin 174、Kiro 258/261、Hermes 616 | 需真实多任务编排需求驱动；mailbox/task 树已备地基 |
| Repo Wiki 全文生成 | ZCode 207 | repo_map 已给骨架；全文 wiki 是生成型产物，可做薄 recipe 但价值存疑 |
| 双模型编队（main+lite / Fusion / architect→editor） | Devin 179、ZCode 213、Aider 292 | 第二路模型常驻开销；既往裁定推迟 |
| LLM 判官变体（SmartApprove/AUTO 两段式） | Goose 420、Qwen 527、Vibe 557 | D4 guard 已落确定性版；LLM 段是增强非缺口 |
| OS 沙箱 / marketplace / 多客户端 attach / headless 产品面 | 114/167/232/312/340/395、146/212/457/509、144/480、363/391/470 | 维持有意拒绝——与本仓"本地受治控面"边界冲突 |

至此功能缺口清单消耗完毕：每个未做项都有显式裁定理由，无遗漏态行。后续方向=上表拍板或外部评审裁决驱动的第三轮。

### 28.6 Update Delta Audit（2026-09-20，窗口 09-15→09-20）

按外部评审建议对 A+/A 级 harness 做 changelog delta，B 级 title-level。每条增量落四态：**同构**（我方已有等价面）/ **变体**（已有但语义不同）/ **候选**（新 candidate gap）/ **边界**（有意拒绝）。

**Claude Code 2.1.252→2.1.278**（~27 版，features 摘录）：

| 增量 | 判定 |
|---|---|
| `/skill-doctor`——列出已加载但未使用的 skill 及其 context 开销 | **候选（薄）**：skill 成本可视面无 |
| `blockReadsOutsideWorkingDirectories` + 首次越界读一次性提示 | **候选（薄，治理）**：pathAsk 管写；读越界无提示面 |
| `bashEditDiffEnabled`——bash 命令造成的文件改动在工具结果回显 diff | **候选（薄）**：fileops 回执有改动记录但 bash 结果不回显 diff |
| `claude plugin eval`（插件评测套件 JSON+HTML） | 边界（marketplace 族延伸；eval harness 本身是独立候选） |
| subagent 结果加 header 标记防冒充 / prompt 隐形 unicode 剥离+展示 | 同构（untrusted 封套 / unicode 消毒） |
| server-side auto-mode 分类器 | LLM 判官族（§28.5 决策项） |
| send-now 键打断当前轮发全部排队 | 同构（steer+立即发送） |
| `omitClaudeMd` agent frontmatter / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` / `maxEffortLevel` 管理帽 | **候选（薄）**：subagent steering 隔离+管理帽三个旋钮各一句话成本 |
| Containment Escape 规则（云元数据凭据/egress 逃逸进 auto 分类） | 同族 secret 扫描；云元数据面本地不适用 |
| claude.ai skill/plugin 云同步、artifact publish/watch、remote-control fork、self-hosted runner、workflow 并发帽、per-command allowed_domains、`--permission-prompts none` | 边界（云同步/远程执行/OS 沙箱/无人值守 headless——均属 §28.5 决策族） |

**Cursor**（Aug 19→Sep 10）：

| 增量 | 判定 |
|---|---|
| **Projects**：常驻 coordinator + 千级 subagent 并行 + 跨机共享 context 文件 + recurring | 决策项（脚本化编排+远程执行族的旗舰形态；验证 GPT 预判的"事件唤醒→长期 coordinator→动态 worker pool"趋势） |
| Self-hosted machines / Team pools 动态伸缩休眠 / 跑在 Lambda·Coder·Daytona·Modal 等 | 决策项（远程执行） |
| `/goal` 长效目标（直到完成） | 同构（ContinuationGovernor 目标状态行+维持循环） |
| Custom mode = 钉住 skill（"always-on skill"） | **变体（薄）**：mode 预设+microagent 常驻可近似；无"一键把 skill 变 mode"转换面 |
| Subscriptions（Slack 频道/PR watch 事件唤醒） | 边界（外部事件源集成；heartbeat+schedule 已覆盖定时族） |
| Origin repos / Vercel publish / 云预览端口转发 | 边界（云托管面） |

**Kiro**（Sep 5→16）：

| 增量 | 判定 |
|---|---|
| session 搜索范围开关（仅 prompts vs prompts+responses） | **候选（薄）**：session_search 范围固定，无 scope 参数 |
| unattended auto-run 2h 墙钟帽（`orchestrator.max_plan_duration_seconds`） | **候选（薄，治理）**：预算帽只有 turns/token，无墙钟维度 |
| IDE durable agent artifacts 侧栏审阅 | 同构（产物面板+/api/artifacts） |
| Crew 按会话选 harness（Claude Code/Codex/KAS） | 同构（body_select 显式切换；remote crew 属边界） |
| knowledge folder 需操作员确认才进库 | 同构（project trust 门——我们刚落） |
| diff 默认折叠为 file chip / 会话列表 sort+filter+group 增强 | 变体（UI 细节族，方向三顺带） |

**OpenHands v1.11→1.20**：

| 增量 | 判定 |
|---|---|
| **agent profile 绑定 secrets 子集 + scope 到指定 MCP server**（v1.19/1.20） | **候选（中）**：delegate profile 有 toolDeny；凭据/连接范围细分无（我方无 MCP，映射为 env 暴露面） |
| skills 显式 allow-list 替换 all-on catalog（v1.16） | **候选（薄）**：skill 加载白名单旋钮 |
| automation 权限分 view/manage + creator escape + run identity | 边界（多用户协作面；单机单用户不适用） |
| LLM profile 保存前 pre-flight 校验 | 同构（model_ping） |
| conversation tags/归档、上下文用量表+手动压缩、per-run 成本日志、起步清单 | 同构（全有） |
| 消息 hover 时间戳、图片点击全尺寸、文件路径可点进 Files | 变体（UI 细节族） |

**OpenCode v1.18.13→31**：多为 provider 兼容修复。可记的：
- PDF 附着按模型声明能力放行（Copilot vision 广告才开）→ **候选（薄）**：capability-gated 附着——models.json 能力声明已落，接上即可
- resumable subagent 失败（task_id 续跑）/ run 中应答子代理权限请求 → 同构（durable task+批准卡）
- `network_error` finish_reason 重试、unknown finish 续流 → 变体（provider 韧性细节）

**Goose v1.50→1.51**：
- **终端铃（turn 完成/待批准提醒，opt-in）** → **候选（薄）**：notify_user 只有视觉 toast，无声音/系统提醒面
- auto-compact 100% 即禁用、recipe validated snapshot、scheduled run 内容过滤 → 同构族（调度+compact 已落）
- CLI 移除 plan mode → 值得注意的反向信号：对方在简化，我方 plan 模式保留合理（审查族已差异化）

**Cline**：Desktop/CLI/SDK 三轨迭代快但多为修复。可记的：
- **图片附着到不支持视觉的模型时显示警告徽标+一键换模型**（v4.1.19）→ **候选（薄）**：能力不符静默降级目前只在结果层兜底，无 UI 前置警示
- `RemoteEnvironmentService` SSH 远程执行 → 决策项（远程执行族第三家入场：Cursor/Cline/ZCode/KAOS）
- **Windows planted-exe 防御**（`NoDefaultCurrentDirectoryInExePath`——workdir 里的 git.exe/rg.exe 不再顶掉真程序）→ **候选（薄，安全）**：我方 Windows bash 执行环境同样面此坑，需核实
- provider-native web search 默认开、mid-stream 瞬态错误≤3 重试（已流出不重试）→ 变体（韧性细节）

**Codex**：releases 全是 alpha tag 无说明（仅版本时钟）；app-server 协议面需专项对照（评审已提示）。

**Aider**（B 级 title 扫描）：窗口内零 release——最新 v0.86.0 发布于 08-17 早于窗口起点；无增量。

**Roo Code**：**2026-05-15 关停、仓库 archive**——降级为历史设计样本，移出更新监控集；后续 Roomote 若研究按新对象准入。

**本轮候选新缺口汇总**（全部薄/中，无边界冲突）：

| # | 项 | 来源 |
|---|---|---|
| N1 | skill-doctor 类：已加载 skill 的使用率/context 开销审计面 | CC 2.1.261 |
| N2 | 读越界一次性提示 + `blockReadsOutsideWorkingDirectories` 旋钮 | CC 2.1.257 |
| N3 | bash 命令文件改动回显 diff（bashEditDiffEnabled） | CC 2.1.269 |
| N4 | subagent 三旋钮：steering 隔离（omitClaudeMd 类）/强制模型/effort 帽 | CC 2.1.271/267/257 |
| N5 | session_search scope 参数（prompts vs +responses） | Kiro 2.21.4 |
| N6 | 任务/计划墙钟时长帽（max_plan_duration） | Kiro Crew 0.6 |
| N7 | skill 加载白名单 | OpenHands 1.16 |
| N8 | capability-gated 附着：PDF 按声明放行 + 图片不符警告徽标 | OpenCode 1.18.17 + Cline 4.1.19 |
| N9 | 完成/待批准声音提醒（opt-in terminal bell） | Goose 1.51 |
| N10 | Windows planted-exe 防御核实（NoDefaultCurrentDirectoryInExePath 等价物） | Cline 4.1.19 |
| N11 | delegate profile 凭据/env 暴露面收窄（secret scope 本地映射） | OpenHands 1.19-20 |

**N1–N11 消耗结果（本批全部落地/证实，无决策滞留）**：

| # | 终态 | 落地证据 |
|---|---|---|
| N1 | ✅ 已有 | `skills_list` 通道命令 + `/skills` UI——per-skill 注入字节成本、本轮命中计数、启用态 |
| N2 | ✅ 已有 | decide 链 `read_outside` 闸门：越界读先问一次，deny 闩锁会话级 block，`allow_session` 免复问，无操作员通道 fail-closed |
| N3 | ✅ 已有 | tool_execution_end 对 bash 族做 git porcelain 前后差集→notify 回显改动文件清单 |
| N4 | ✅ 已有 | profile `model:`/`effort:` 填模板 `{model}`/`{effort}` 槽（操作员模板决定如何消费，零 per-target flag 知识）；`isolate_steering:` → `--steering-off` → `PAI_STEERING_OFF` 专用 flag 盲化子 steering——全部 envCapable/信任门控 |
| N5 | ✅ 已有 | `session_search(scope)` 透传到 facade（prompts vs +responses） |
| N6 | ✅ 已有 | `max_minutes`（工具参数+profile 默认，调用级覆盖 profile 级）→ `timeoutMs` deadline kill，审计区分 timeout 与非零 exit |
| N7 | ✅ 已有 | `<instance>/skill-allow.json` 操作员白名单 + `skill_allow_set` + `/skills allow a,b`；实例私有，仓库文件够不到 |
| N8 | ✅ 已有 | 附着按**当前模型** `input` 模态门控：无 image 模态→图片降级描述符 + notify 警告（此前恒 `images:true`，真 bug）；PDF 维持诚实降级 |
| N9 | ✅ 已有 | 外观卡 opt-in 声音开关 + WebAudio beep：批准卡必响，turn 完成仅窗口不可见时响 |
| N10 | ✅ 已有 | pai-channel 引导即设 `NoDefaultCurrentDirectoryInExePath`——进程级 env 覆盖 jobs/bridge/内置 bash 全 spawn 树 |
| N11 | ✅ 已有 | profile `env:`/`env_deny:` 经 `--env-json` 桥收窄子 env；`PAI_*` 拒穿（执行信道不可谈判），envCapable 信任门控 |

**方向三·评审者视角 UI pass（已落）**：新增「关于」视图（侧栏首位）——它是什么 / 现在能做什么（六族清单）/ 有意不做（边界带理由）/ **运行证据实况 chips**（policy checksum·硬拒工具数、身体数、持久任务+运行中、技能数、定时任务、项目信任态、记忆——全部来自 live facade，不可能比运行时先漂移）；空态加一行直达链接。Kiro 变体项"diff 折叠为 file chip"核实为已覆盖（tool row 默认折叠、diff 在行内）。OpenHands hover 时间戳/图片全尺寸属 UI 细节变体，不入列。

**机制族趋势确认**（供第三遍定向复扫）：事件唤醒→常驻 coordinator→动态 worker 池（Cursor Projects / Kiro Crew）证实为行业收敛方向，我方 mailbox+teammate+schedule 已是地基，编排面仍是 §28.5 决策项；远程执行目标在本窗口新增 Cursor self-hosted+Cline SSH 两票，累计四家了。

**B 级补扫（title-level，窗口 09-15→09-20）**：

| Harness | 窗口增量 | 判定 |
|---|---|---|
| ZCode | 3.14.0（09-19）：**Dynamic Workflows**——单脚本编排多 subagent 协作 + `/workflow` 命令；Office/Coding 模式切换；批准卡"直接授予全权限"；Repo Wiki 修复；手机远控改进 | **编排族第三票**；模式切换/全权限批准=同构；远控=边界 |
| | 3.12.3（09-17）：PDF+媒体预览、per-workspace 插件、受阻操作显示具体原因 | PDF 全量预览 vs 我方诚实降级（N8 族，决策邻近）；受阻原因=同构（structured denial）；插件=边界 |
| Crush | v0.95.0（09-16）：**Plan Mode**（shift+tab）旗舰；压缩后只读 summary 尾部；prompt history 200 帽 | Plan Mode=同构（risk_mode+/plan+mode_request，经批准卡更强）；压缩 perf=变体 |
| Qwen Code | 最新 v0.22.0 @ 08-22——窗口内零 release | — |
| Trae | 09-04 hotfix；09-03 插件市场（个人版）；09-01 Solo+Agent 合并（/goal /plan /spec 内置命令，企业版）——早于窗口起点但晚于首轮快照 | 插件市场=边界；/goal/plan/spec=同构族（goal governor+plan 模式+spec 三件套在产） |
| Hermes | v2026.9.7/9.11（窗口前缘）；v0.21.0 Pantheon（08-31）：**Bot Mode**——命名 agent 社群+群聊互相对话；**cron 带记忆与连续性**（调度 agent 跨 run 学习）；subagent mid-flight steer；agent 驱动内置浏览器；SQLite 多写者修复 | **编排族第四票**；cron 带记忆=族 A 原语②的实锤佐证；mid-flight steer=同构（mailbox inbox→stdin）；浏览器=同构 |
| Devin | 09-16 blog：**Code Scans**——宽泛工程目标→调查→评估发现→PR | **编排族第五票**（goal→coordinator→PR 形态，自家方向）；Desktop Testing=CUA 边界；v3 API RBAC=多用户边界 |
| Codebuddy | 密集 CLI release（v2.97.0 等）+ Hy4 模型 co-design 波 | title 级无新机制族 |
| KAOS | v2.0.x/2.1.1（09-01+）：本地多 agent fleet + SQLite flight recorder + neuroplasticity memory + **预注册可证伪 kill gates** + 58 工具 MCP + 并行 agent | **编排族第六票**；kill gates=验证族同思路（verify+门禁）；余首轮已覆盖 |
| Vibe / PI-Desktop | 无公开 changelog 入口 | 首轮快照即终态 |
| Roo Code | 已关停 archive（前文） | 历史样本 |

**票仓修正**：编排族在本窗口累计 **6 票**（Cursor Projects、Kiro Crew、ZCode Workflows、Hermes Bot Mode、Devin Code Scans、KAOS fleets）——全部 delta 里最强的收敛信号；远程执行 4 票。两族维持 §28.5/§28.7 决策项，证据权重已显著倾斜编排族。

**B 级逐条 itemized delta（全量展开，含踩坑）**：

*ZCode 3.14.0（09-19，窗口内）*：

| 条目 | 判定 |
|---|---|
| Dynamic Workflows：单脚本编排多 subagent + `/workflow` + 输入框入口 | 编排族第三票（决策项已拍板做） |
| Office/Coding 模式切换 | 同构（risk_mode/mode 预设） |
| 自定义快捷键即时生效 | 变体（键位固定；薄） |
| 三步 onboarding 按角色推荐任务/插件 | 变体（tour-card+About 已有；角色推荐薄） |
| 归档任务批量删除 | **候选（薄）**：session_sweep 只归档，无批量删除 |
| 手机远程控制改进 | 边界 |
| Help 菜单 About + Check for Updates | 同构（About 视图已落） |
| 批准卡"直接授予全权限" | 变体（allow_session+always 持久化存在；"全信任"按钮有意不做） |
| Start Plan 独立可用 | 同构（plan 模式独立） |
| 邀请奖励中心 / Plan 领取提醒 | 商业面边界 |
| CUA 调用改进 | 边界（computer use） |
| repo wiki 上传修复 | Repo Wiki 决策项佐证 |
| 远端浏览器 tab/窗口记忆 | 边界（内置浏览器） |
| 空闲任务超限友好提示 | 变体（schedule 语义不同） |
| 工具失败错误正确显示、不残留半成品卡 | 同构（tool 错误行+denial reason） |
| 后台 workflow 运行中的 session 不消失在任务列表 | 踩坑：我方 task_list 持久列全部任务，不复发 |
| workflow 取消/恢复被拒时显示原因 | 同构（structured denial） |

*ZCode 3.12.3（09-17，窗口内）+ 3.11.2（09-04）+ 3.10.2（08-31）*：

| 条目 | 判定 |
|---|---|
| PDF 上传/读取/预览 + 媒体预览 | 变体（N8 诚实降级；全量 PDF 需新依赖，决策邻近项） |
| per-workspace 插件安装 + 更新提醒徽标 | 边界（插件市场族） |
| 受阻操作显示具体原因 | 同构 |
| 侧栏中键关闭/状态记忆/草稿任务可见 | UI 变体 |
| Plan Mode×排队消息交互、编辑消息即时发送不排队 | 变体（steer+队列已落） |
| OpenCode Go provider 模板/provider 模板显示 | provider 兼容 N/A |
| DB 初始化升级流程 | 同构（迁移链） |
| thinking traces 可搜索+默认展开 | 变体（session_search 扫 flat 文本覆盖 thinking） |
| MCP 协议版本可配 | N/A 无 MCP |
| turn 结束执行摘要+时长 | **候选（薄）**：meta chips 有 token/cost，无 turn 时长行 |
| 粘贴长文→附件阈值上调 | 变体 |
| 上下文用量点击可查（触屏） | 同构（statusline contextUsage） |
| 中断流自动重试 | 变体（provider 韧性族，已记） |
| 模型切换不丢上下文 | 踩坑：durable session 不复发 |
| 长命令输出自动截断防 UI 卡 | 踩坑：8k tail 截断已在 |
| 多 skill 目录并列展示 | 踩坑：skills_list 全源聚合，不复发 |
| 用量统计默认 7 天 | 同构（agent_stats） |
| Windows 退出后残留后台进程 | 踩坑：supervisor 回收子进程（job 链 kill 树在产） |
| 文件监听资源占用/搜索中输入/滚动位置/消息宽度/空 thinking/波浪号渲染 | UI 细节变体或 N/A |

*Crush v0.95.0（09-16，窗口内）*：

| 条目 | 判定 |
|---|---|
| **Plan Mode**（shift+tab 旗舰） | 同构（risk_mode plan+/plan+mode_request 批准链） |
| 压缩后只读 summary 尾部（perf） | 变体（compact 族内部优化） |
| prompt history 200 帽 | **候选（薄）**：输入历史无显式帽 |
| `--reasoning-effort` 非交互 flag | 同构（effort 旋钮+profile effort） |
| tool results 紧随调用即发 | 同构（泵逐条 emit） |
| TUI 全量显示 bash 命令 | 同构（bash 命令行可见） |
| OpenAI OAuth 登录族 | provider auth 变体 |
| 展开/折叠保持滚动位置、选中项钉顶、AtBottom 诚实 | UI 变体 |
| 用户消息保留单换行 | 同构（pre-wrap） |
| 会话删除后列表位置保持 | UI 变体 |
| 可配置超时 | 同构（max_minutes/job timeout） |
| 每轮显示路由命中的模型（Hyper） | 变体（statusline 有当前模型） |
| 关闭鼠标支持/exit-banner 样式 | N/A（TUI 专属） |

*Crush v0.93.1（09-09）+ v0.92.x/0.91.x（窗口前缘）*：

| 条目 | 判定 |
|---|---|
| 非视觉模型附着图片被静默丢弃→校验+提示 | 踩坑：N8 能力门控已修同类 bug |
| MCP init 等待有界/错误域隔离/sessionless | N/A 无 MCP |
| discover_models 内存泄漏修复 | N/A |
| LM Studio enricher 保留用户 supports_attachments | 变体（models.json 操作员自持） |
| providers.json 在禁 auto-update 时生效 | 同构 |
| 代码块缩进/复制/闪烁 UI 修复 | UI 变体 |
| sessionless GitHub MCP | N/A |

*Hermes v0.21.0 Pantheon（08-31）+ v2026.9.7/0.21.2（09-07/11，窗口前缘）*：

| 条目 | 判定 |
|---|---|
| **Bot Mode**：命名 agent+头像+群聊，bot 互相对话 | 编排族第四票（决策项已拍板） |
| `hermes peer` bot-to-bot DM（跨 profile、持久可查） | 变体（task inbox/outbox mailbox 同族；跨 profile DM 是 UX 面差异） |
| **cron 带记忆与连续性**：持久 memory+continuity 携带上轮输出+durable notepad+无变化跳过 LLM+输出落 Bot Chat | 编排族原语②实锤（协调器设计输入：scratchpad+continuity+monitor-skip 三件套进设计） |
| `delegate_task` live 编排：列运行中子任务/中途 steer/提前停保留部分结果 | 同构（task_list+mailbox steer+job_cancel 保 events） |
| 子输出 JSON-schema 校验 | 同构（delegate 契约校验） |
| per-delegation cost 进结果 | 同构（child-reported usage 前转） |
| 默认 250 iter/10 并发子任务 | 变体（配置值） |
| **指令文件保护**：AGENTS.md/skills/memory 写必批准 | **候选（薄，治理）**：protectedRoots 只盖 instance 目录，`.pai/**`/AGENTS.md 在宽松模式可静默写——已核实为真缺口 |
| 深度脱敏：terminal 错误/.env 读/checkpoint/ACP 日志 | **候选（薄）**：audit 键名 REDACTED 在产；job stdout/stderr 事件不 scrub |
| Windows 破坏性命令进批准分类 | 同构（commandClassifier+deny 规则） |
| macOS TCC 签名身份持久 | 平台 N/A |
| **全局急停** | **候选（薄）**：只有 per-job job_cancel，无一键全停 |
| session pin/unpin | 同构（supervisor session_pin+置顶排序+sweep 豁免已在产） |
| Ctrl+P 模糊命令面板 | 变体（slash 补全在产） |
| /status 显示推理模式+待批准+上下文 | 同构 |
| 状态栏实时 cache-hit%/延迟/tok-s | 变体（session_stats 有 token/cost，无实时速率） |
| agent 驱动内置浏览器 | 同构（browser 工具族已配置即在产） |
| 6 provider+model_overrides 覆写 context/pricing | 同构（models.json 操作员文件直接可改） |
| SQLite 多写者修复（hosted rooms 分库/dashboard 只读开/注册连接/doctor 拒不安全 checkpoint） | 踩坑：canonical writer lease 预先防同类 |
| FTS 损伤域隔离（索引坏≠会话死） | 变体（memory FTS LIKE fallback；索引重建无） |
| 桌面 session 控件/浏览器注解/rotating 占位符/terminal pets | UI 变体或 N/A |

*Devin（09-16/09-18，窗口内）*：

| 条目 | 判定 |
|---|---|
| **Code Scans**：宽泛工程目标→调查→评估→PR | 编排族第五票（决策项已拍板） |
| Sessions Wake as You Type | N/A（本地会话常驻，无唤醒） |
| 跳过的问题显示为"已跳过" | 同构（ask 超时卡显 resolved+结局） |
| Reboot VM 侧栏动作 | N/A 无 VM |
| 侧栏 agent mode 图标 | 同构（会话类型徽章） |
| session origin 过滤（Slack/Web/API/Jira/Linear） | 变体（来源维度≈会话类型徽章；无多来源） |
| 安全 bug 每次 review 必查 | 变体（verify 族已含安全扫描项） |
| 从目录安装插件 | 同构（skills 目录装载） |
| 插件版本 diff/下载/编辑/直链 | 变体（skill_manage 有删改；版本史无） |
| MCP 连接状态+重连/密钥页面迁移/个人 OAuth | N/A 无 MCP |
| Live Voice Mode | 边界（语音 UX 非范围） |
| Slack/Teams/Jira/Linear/PagerDuty/email 触发与通知 | 边界（外部集成族） |
| 消息复制保留格式/发送快捷键可配 | UI 变体 |
| audit-logs 分页/PR 评论访问闸/Azure DevOps/Perforce 收窄 | 多租户边界 |
| blueprint source git\|database | 同构（文件态配置） |
| 60fps 录屏/机器启动提示/侧栏键盘导航/嵌套组展开 | UI 变体或 N/A |

*KAOS 2.0.x/2.1.x（09-01/02，窗口前缘）*：

| 条目 | 判定 |
|---|---|
| 本地多 agent fleet + "三个 agent 并行 review" | 编排族第六票 |
| **预注册可证伪 kill gates**：延迟门失败→特性默认关+CI 拒发布 | 同构哲学（verify+validate_repo --strict+quality_report 门禁同思路；其"哈希锁定先注册后跑"更形式化） |
| memory write 名/id FK 崩溃修复 | 踩坑：API 形状不同 N/A |
| Claude Code 插件（SessionStart 注入排序记忆+工具调用 journal） | 边界（挂进其他 harness 的集成面） |
| `memory search --format inject --token-cap` | 同构（预算化 context block） |
| agent_sdk 子会话继承用户配置泄漏（MCP/tools 渗入） | 踩坑：N4/N11 隔离旋钮已修同类 |
| OpenAI 式工具丢失→统一 tool_call 协议 | 踩坑：工具协议统一在产 |
| FTS5 语法错误降级 sanitized 查询 | 踩坑：session_search 子串扫描无 FTS 面；memory FTS 有 LIKE fallback |
| 排序确定性 tiebreak（CI flake 修复） | 同构（列表序有 id 兜底） |
| ulid 移除（启动省 216ms）/demo 实测 p95 | perf 纪律变体 |
| sdist 141MB 超 PyPI 帽 | 踩坑：发布边界不同 N/A |
| neuroplasticity memory/Gantt 仪表盘/58 工具 MCP | 变体/边界（MCP 面无） |

*Trae（09-01/03/04，窗口前缘，title 级）*：

| 条目 | 判定 |
|---|---|
| Solo+Agent 合并 + `/goal` `/plan` `/spec` 内置命令（企业版） | 同构（goal governor+plan+spec 三件套） |
| 插件市场个人版 | 边界 |
| 3.3.98 hotfix | N/A |

*Codebuddy v2.153.0（窗口内）*：

| 条目 | 判定 |
|---|---|
| customPassthroughHeaders：逐 turn 头透传+启动前缀白名单+默认关 | 同构哲学（env_deny 同款"收窄默认+显式放行"）；SDK 线面 N/A |
| QA harness（ACP/控制面/MCP/权限流一致性测试） | 同构（host/pi/app 三层测试+契约测） |
| A2A×stream-json 混合模式输出修复 | N/A（协议面不同） |
| 畸形 JSON-RPC→协议错误不再静默执行 | 踩坑：channel 未知命令 reply(false) 不误执行，不复发 |
| 会话 API 200 空体不重试/单次 failover 408 | 变体（provider 韧性细节） |
| 侧栏特性族：Goal/Scheduled Tasks/Channels β/Daemon/Agent Teams/Dynamic Workflows/Remote Control/Bash Sandboxing/Prewarm/Checkpointing/Worktree | 编排+远程族佐证（Goal/Channels/Daemon=编排票；Remote Control/Dev Container=远程票） |

**踩坑对照表（他们修过的 bug × 我方核实）**：

| # | 对方踩坑 | 我方核实结果 |
|---|---|---|
| P1 | 非视觉模型图片静默丢弃（Crush） | ✅ 已防：N8 能力门控+降级警告 |
| P2 | 子会话继承操作员配置（KAOS agent_sdk） | ✅ 已防：N4 isolate_steering+N11 env 收窄 |
| P3 | SQLite 多写者损毁（Hermes 四处） | ✅ 已防：canonical writer lease |
| P4 | FTS 语法崩查询/索引损毁拖死会话（KAOS/Hermes） | ✅ 已防：session_search 子串扫描；memory FTS LIKE fallback |
| P5 | 长输出不截断卡 UI（ZCode/Crush） | ✅ 已防：8k tail 多层截断 |
| P6 | 畸形协议消息被当正常输入执行（Codebuddy） | ✅ 已防：channel 未知命令 reply(false) |
| P7 | 后台任务运行中 session 从任务列表消失（ZCode） | ✅ 不复发：task_list 持久列全部 |
| P8 | 模型切换丢上下文（ZCode） | ✅ 不复发：durable session |
| P9 | Windows 目录 planted-exe 劫持（Cline） | ✅ 已防：N10 NoDefaultCurrentDirectoryInExePath |
| P10 | **agent 静默改写自身指令文件**（Hermes） | ❌ **真缺口**：宽松模式下 `.pai/**`、AGENTS.md、steering/skills 源可静默写 → **M1** |
| P11 | 凭证泄进 job 事件/checkpoint（Hermes 深度脱敏） | 🟡 半防：audit 键名 REDACTED；job stdout/stderr 事件未 scrub → **M5** |
| P12 | 退出残留后台进程（ZCode） | ✅ 已防：supervisor 回收链 |

**本轮新候选缺口（M 系）**：

| # | 项 | 来源 | 量级 |
|---|---|---|---|
| M1 | 指令文件保护写：`.pai/**`、AGENTS.md、steering/skills/microagents 源文件在任何模式下写前必批准 | Hermes P10 | 薄（kernel always-ask path globs） |
| M2 | 全局急停：一键取消全部运行中 job/task+中止当前 turn | Hermes | 薄 |
| M3 | ~~session pin~~ → 核实为已有（supervisor meta+置顶排序+sweep 豁免），非缺口 | Hermes | — |
| M4 | turn 结束执行摘要行（时长+工具数+cost delta） | ZCode | 薄 |
| M5 | job stdout/stderr 事件入库前 secret 扫描 | Hermes P11 | 薄 |
| M6 | 归档会话批量删除（sweep 现只归档） | ZCode | 薄 |
| M7 | 输入历史 200 帽 | Crush | 薄（UI） |
| M8 | monitor-mode schedule：无变化跳过本轮（协调器设计输入） | Hermes cron | 随协调器 |

### 28.7 定向机制复扫（delta 驱动，2026-09-21）

按评审裁定只对 delta 暴露的两个未决机制族做落点级复核，不再全面重扫。已落地族（N1–N11）以测试名为证，不重复论证。

**族 A：常驻 coordinator + 动态 worker 池**（Cursor Projects / Kiro Crew dispatching）

已核实的地基（全部在产）：
- `TaskStore`：durable task + `spawn_spec`（{target, profile, task, depth} 可重生身份）+ 三流信箱（inbox/outbox/events）+ parent 链 + job 绑定
- `ScheduleStore`：durable 调度 + missed-fire catch-up-once + lastJobId 回执
- `delegate_task`+bridge：durable spawn + 预算切片 + 深度帽 + steering 隔离 + env 收窄 + max_minutes deadline
- ContinuationGovernor：会话级目标维持

距 Projects 形态的真实缺口（不是"地基不够"，是三个具体原语）：
1. **跨会话存活的协调者实体**——今天 task 是信箱，背后是父会话的脑子；会话结束就没有进程继续为它决策
2. **目标绑定的周期 tick**——schedule 现在只 fire shell 命令；"按目标决定下一步"的再入循环不存在（最薄路径：schedule 可 fire 一条受治理 prompt，child 持 task 目标+信箱进场）
3. **一任务多 worker 池语义**——今天是 task↔job 一对一；池化=同 task dir 下多个并发 job+按目标退避/退役

判定：维持 §28.5 决策项，但落点已精确——若拍板做，最薄形态=「schedule 能 fire prompt」+「task 可绑多 job」，不需要新抽象层。

**族 B：远程执行目标**（SSH/WSL/Docker，本窗口累计四票）

已核实的接缝：`SandboxProvider.spawnSpec(command, workdir)` 已把 spawn 形状抽象成 argv spec——wsl 后端证明包裹路径可行（`PAI_SANDBOX=wsl` 在产）。

但 SSH 目标 ≠ 加一个 spawnSpec：
- spawnSpec 只管 durable job 的**进程诞生**；fileops/read/write/repo_map/session_read/writeLease/authorizedRoot 全部假设**本地文件系统**
- 真远程面=执行 seam + 远端 workspace 供给/checkout + 远端文件 IO + 跨边界 lease 语义，是执行环境抽象层

判定：维持决策项不动；若未来做，入口是 `sandbox.js` spawnSpec + fileops/observation 的 locality 假设清单，不是重写。

**复扫收尾**：N1–N11 消耗完毕；方向三「关于」视图已落；两个未决族都有精确落点，等拍板。

### 28.8 全量更新日志收录 + 逐条核查（2026-09-21）

**收录层**：`changelogs/` 36 个 harness 目录、~900 文件、~460MB 原始数据（`_REPORT.md` 有逐家覆盖表与缺口诚实记录）。解析层：7,239 个 release（21 家 GitHub releases 全页，各含 tag/date/全文 body）+ 文档站全量页 → 去重降噪后 **80,369 条信号条目**（`items.jsonl`/家），高信号 11 域 16,261 条全量抽出（`_signal-review.txt`）。Copilot CLI 无公开 changelog；codex/zed 受 GitHub 100 页封顶（最旧各到 rust-v0.33α / v0.106，缺口<5%）；amp/replit 主站 JS 壳仅索引。

**方法**：条目→24 能力域关键词桶 + 机制性条目逐条读 + PAI 代码核查。域名桶内同义条目合并计数；机制性条目（cancel/retry/schema/isolate/inject/redact/scope/persist/budget 类）全部人工过眼。

**新增候选缺口清单**（本轮全量扫描产出，编号续 M 系）：

| # | 缺口 | 证据源 | 量级 |
|---|---|---|---|
| M9 | ~~http-bridge POST 无 Origin/Sec-Fetch 校验~~ **✅已落 `ac18d6a`**：Origin 主机白名单（127.0.0.1/localhost/[::1]）+ Sec-Fetch-Site 拒绝 cross-site，POST /cmd 与 /api/pick-dir 双闸 | CodeBuddy 同源漏洞修复（gateway 跨域 + SSE CORS wildcard） | ~~薄·安全~~ done |
| M10 | ~~拒绝记忆~~ **✅已落 `ac18d6a`**：governance #rejections 签名集（tool+stableJson(args) hash），deny 后同签名自动拒不再弹卡；allowlist 仍压过记忆 | codebuddy | ~~薄~~ done |
| M11 | ~~凭证输入不剥不可见字符~~ **✅已落 `ac18d6a`**：auth_set_key 边界剥 BOM/零宽/bidi/NBSP/空白，全不可见即拒存，永不回显 | cline | ~~薄~~ done |
| M12 | ~~前台命令超时→自动转后台~~ **✅已落 `ac18d6a`**：operator bash 120s 超时→进程不死、输出切到 jobs/detached-<pid>.log + SHELL_DETACHED 审计 + 操作员获真实转场提示 | codebuddy | ~~薄~~ done |
| M13 | ~~git worktree 并行工作目录隔离~~ **✅已落 `ac18d6a`**：delegate_task worktree:true → `git worktree add --detach`，干净自动移除、脏保留+JOB_WORKTREE_KEPT 审计，非 git 仓诚实拒绝 | codebuddy/codex/cline | ~~中~~ done |
| M14 | ~~调度输出无投递通道~~ **✅已落 `ac18d6a`**：JobExecutor.onJobFinished（仅 job_type=scheduled）→ scheduled_job_done UI 事件（toast+通知抽屉+transcript 尾+jobs 刷新） | hermes/codebuddy | ~~薄~~ done |
| M15 | ~~级联上下文文件加载~~ **✅已落 `ac18d6a`**：父目录级联此前已在（steering.js ancestor merge）；本批补 `*.local.md` 个人文件最后读+local 标记 | codebuddy | ~~薄~~ done |
| M16 | ~~上下文溢出检测→强制压缩恢复~~ **核查=已有**：pi-agent-core `isContextOverflow`→`prepareOverflowCompaction`→summary.deciding 一次恢复（overflowRecoveryUsed 闸防循环，二次溢出诚实报错） | cline | ~~薄·核查~~ 已有 |
| M17 | ~~turn 级瞬时错误重试~~ **核查=已有**：pi-agent-core `isRetryableAssistantError`→assistant.retry_wait→指数退避（retryPolicy.maxAttempts/baseDelayMs） | cline | ~~中·韧性族~~ 已有 |
| M18 | ~~文档附着族~~ **✅已落 `ac18d6a`（零依赖切片）**：text/code/ipynb 提取真内容入 prompt（ipynb 渲染 cell+输出截断）；pdf/docx 需真解析库→保持诚实描述符，不半解析 | aider | ~~中·需依赖~~ done(部分·docx/pdf 边界) |
| M19 | ~~WebFetch 工具缺失~~ **核查=已有**：`pi/src/adapter/web.js` web_fetch（协议白名单+标记剥离+截断标记）+ web_search | codebuddy 等 | ~~中~~ 已有 |
| M20 | ~~workspace info 注入的 git remote URL 凭证脱敏~~ **核查=不复发**：全仓搜证——workspace 信息从不注入 remote URL（唯一 git 接触是 `git status --porcelain`，只出文件路径） | cline | ~~薄·核查~~ 不复发 |
| M21 | ~~schedule pause/resume + edit~~ **✅已落 `ac18d6a`**：ScheduleStore.setEnabled（resume 重锚防 storm-fire）+ edit 校验；schedule_task pause/resume/edit + schedule_set 通道 + UI 开关 | goose | ~~薄~~ done |
| M22 | ~~Typed Memory~~ **✅已落 `ac18d6a`**：kind 分类（fact/preference/decision/note）+ pin→每轮注入已在；本批补 per-turn 相关性注入（当前用户文本→FTS OR 查询→去重合并 capped，仍走 untrusted `<memory>` 证据块） | codebuddy | ~~中~~ done |

**协调器设计输入**（域证据直接喂给已拍板的协调器）：/loop 每轮模型自选 advance/delay/maintain（codebuddy）、headless 调度不问问题要默认 auto-approve 策略（cline）、调度 run 折叠+run number+来源过滤（cline UI）、monitor-skip 无变化跳 tick（hermes curator）、daemon 重启恢复 active goals（codex）、Cron 带持久记忆（hermes）。

**新踩坑对照**（核查结论）：

| 对方踩坑 | PAI 状态 |
|---|---|
| CodeBuddy 本地 gateway 跨域 POST | ~~复发→M9~~ **已修复 `ac18d6a`** |
| Cline 凭证不可见字符 | ~~复发→M11~~ **已修复 `ac18d6a`** |
| CodeBuddy exec→execFile 注入 | 不复发（spawn 数组形+治理分类命令串） |
| Cline 凭证刷新生效抢 provider 选择 | 待核（轻） |
| CodeBuddy ExitPlanMode 经代理路径绕批准 | 同类已防（decide 单入口）；代理旁路类已记录 |
| CodeBuddy sub-agent 听主 abort 信号误杀 | 不复发（delegate job 分离） |
| CodeBuddy sandbox 不可用 fail-open | 不复发（PAI fail-closed 哲学） |
| Cline hub 广播全量 transcript 内存膨胀 | 不复发（SSE 事件流） |
| CodeBuddy 禁用 skill 模型仍可调 | 不复发（N1 allowlist 门控） |
| Cline repo 内 planted rg.exe/git.exe | 不复发（N10） |
| CodeBuddy 图片路径泄进会话标题 | 待核（轻） |
| Cline 压缩 1024 硬帽压死 reasoning | 待核（压缩预算配置） |
| CodeBuddy 大 tool 结果外部化后回同步内存 | 待核（PAI 截断策略） |
| CodeBuddy MCP /mcp 禁用重启复活 | 待核（PAI MCP 面） |
| Cline MCP 不可达 60s 拖死启动 | 待核（PAI MCP 面） |
| CodeBuddy 批准弹窗 Enter 键串台误批准 | 待核（PAI 批准卡键处理） |

**子 agent 域核查**：abort 不级联 delegate job 是 durable 设计（stop_all 已补全局急停）→ 变体；同 step 多 delegate_task 天然并行（独立 job）→ 同构；sub-agent output 反注入扫描 → PAI 未做，入 M 系核查项。

### 28.9 网页评审裁决批次终表（2026-09-21）

外部评审（chatgpt-web「审计方向顺序建议」会话）对剩余决策项的裁定 + 落地状态：

| 优先级 | 项 | 裁定 | 落地 |
|---|---|---|---|
| P1 | **远程执行**（WSL→Docker→SSH 风险梯度） | GO | **✅ `432566f`**：`job_spawn` 模型工具（command+timeout+sandbox 参数，走 bash 同款治理/allowlist，fg-lease 豁免防自锁）+ SandboxProvider docker（命名容器可强杀）/ssh（b64 传输，BatchMode）/wsl 后端；未知 kind 在 job 记录创建前拒绝；超时杀容器、ssh 孤儿审计 JOB_REMOTE_ORPHAN |
| P2 | **docx/pdf 真解析** | GO（依赖仅进 pi） | **✅ `e0cd7d9`（零依赖版）**：手写最小 zip 阅读器取 word/document.xml + PDF FlateDecode 流文本算子提取；zip 炸弹/流膨胀设帽；加密/图像型/坏文件 yield null → 保持诚实描述符，不冒充理解 |
| P3 | **LLM 判官** | **仅 Shadow/Secondary** | **✅ `74c66b5`**：JudgeAdvisor（注入式 call 缝，host 零依赖）+ PAI_JUDGE=1 显式 opt-in + 审批卡「顾问参考」块 + JUDGE_OPINION 全量审计（意见-人类决定相关数据集）；**永不进授权链**——意见不能翻任何判决，judge 错误→人类照常决定 |
| P4 | 会话分组视图 | GO 低优先 | **核查=已有**：今天/昨天/近7天/更早分组头已渲染（renderSessions+sessionGroup） |
| — | 草稿任务 | **HOLD** | 无真实阻塞证据，不建新 lifecycle |

**评审附带论证已固化**：①LLM judge 不照竞品抄（OpenHands/Cline 的模型自评风险已被公开 issue 证明可绕人工批准）②远程先于判官——远程执行会真实产生值得 judge 研究的问题（同一命令本地 vs 一次性容器 vs SSH 生产机风险是否相同）③FEATURE_AUDIT 此后降级为"外部雷达"，新增能力须回答"解决哪个真实工作阻断"。

**SSH v1 诚实边界**（已写进提交）：无 workspace 同步（远端目录需自含所需）、仅 BatchMode 认证、远程孤儿只能审计不能强杀。

**测试基线**：host 220 / pi 171+1skip / app 18+1skip 全绿。

### 28.10 C 阶段全量评分扫描终表（2026-09-21）

**执行口径**：全量 80,369 条 → 规则评分器逐条打分（动词×能力名词，零遗漏）→ 高分带全量人眼 + 低分带分层抽样。

| 层 | 量 | 覆盖方式 | 产出 |
|---|---|---|---|
| score≥10 | 2,107 条 | **全量人眼过完**（15 域逐批） | M54–M100 候选族 |
| score 8–9 | 2,344 条 | **全量人眼过完** | M101–M147 + 20 项坑核查 |
| score 4–7 | 19,036 条 | 分层抽样 360 条 | 新信号产率 ~1.4%，以坑验证为主 |
| score 0–3 | ~55,000 条 | 词法判定为噪声带（版本号/依赖/CI/样式），抽样确认 | — |

**累计功能缺口候选 M54–M147（94 项）**，按证据强度分档：

**A 档（≥3 源复发或强竞品收敛）**：
- M55 结构化提问 request_user_input/AskUserQuestion/elicitation（codex+Devin SDK+ACP 三源，含 10min 超时+单waiter 路由）
- M56 per-feature 模型路由（zed×2+--weak-model+标题生成映射，共 5+ 源）
- M57 外部密源 Bitwarden/1Password SecretSource/外部 secrets workflow（4 源，含"填密不见密"）
- M63 网络出口域级 allowlist+检查器（CodeBuddy 域哈希+Zed per-host 代理+egress logging 三源）
- M83 工具惰性加载 ToolSearch/Defer()（4 源）
- M84 审批卡内联编辑命令+自然语言改写 wand（2 源强信号）
- M87 事件驱动唤醒 Monitor（crush+Cursor+自动化蓝本，3 源）
- M89 会话导入 Claude Code/Codex/opencode/ChatGPT（4 源，带 provenance+首turn摘要）
- M93 活跃 turn 排队消息+Esc暂停/Ctrl+C弃尾（4 源）
- M100 provider fallback 链+retry+模型目录（全家族最多源）
- M105 工具级 checkpoint→rewind（checkpoint 行指示器+hover 恢复，3 源）
- M38 大输出外置落盘+占位符回取（3 源，已在薄缺口批做 output_tail 但"占位符回取"未做）
- M70 会话树/fork 关系/编辑即分支（5 源）
- M135+ cron 动态调速+错过跳过+心跳唤醒策略（调度族最密复发）

**B 档（双源或强单源）**：
- M54 Ctrl+R 模糊反向搜输入历史（3 源）
- M58 glob 路径穿越保护；M59 /recap 返回摘要；M60 /insights；M61 占位凭证拒绝启动
- M62 运行时提权 request_permissions/request_scope（2 源）
- M64 全量 purge 预览；M65 记忆 project/user scope；M67 全局级 allowlist
- M68 掩码凭证请求流；M69 OS 级通知策略 never/smart/always+声音
- M73 语义向量记忆；M74 记忆原子批量；M75 指标页
- M76 per-agent disallowedTools/permission-mode；M77 子代理实况窗格
- M78 调度绑 live session；M79 missed-job 策略；M80 sandbox.excluded 命令出沙（注意复合命令绕过教训）
- M85 workspace trust 分层（目录/父/递归）+沙箱可写挂载+移除吊销
- M86 ambient context；M88 /add-dir+/undo-add-dir；M90 workflow pause/resume/restart/delete
- M91 结构化表单（Automation Blueprints）；M92 后台会话页；M94 上下文注入预算
- M95 本地模型自动发现（Ollama/DNS-SD）；M96 allowlist 导入导出；M97 已发消息编辑→分支
- M98 bare /loop 自主模式；M99 workers/daemons 页；M101-M147 其余见 findings

**坑核查清单**（代码级 verify 项，优先级高于新功能——全是各家真踩过的雷）：
1. bash 重定向写保护路径是否绕过 M1（命令文本检查 vs 沙箱级路径防护）
2. deny write_file 是否覆盖 apply_patch/edit_file 等价面
3. compaction 是否丢在途 subagent/delegate 结果
4. nohup/& 后台子进程继承 stdio 是否致超时挂起
5. grep/find 参数以 `-` 开头是否被当 flag
6. checkpoint 在大 untracked 目录每 turn 全量 hash 是否卡顿
7. secret redaction 是否误伤合法内容+错误堆栈/metadata 字段是否漏脱敏
8. 调度 delay >2^31-1ms 是否 clamp
9. $HOME/fs-root 是否触发全量索引
10. clipboard bmp/GIF 格式是否归一/保真
11. stale agent_end 跨 turn 复用污染
12. 审批卡 Enter 键在连续卡间串键误批
13. 命令列表非确定性顺序破 prompt cache
14. sign-out 后凭证是否被重导入复活
15. 配置写是否基于过期快照（并发丢字段）
16. CRLF 是否破坏 frontmatter 解析
17. AbortSignal 是否传到工具 execute 层
18. 图片附件字节嗅探是否覆盖声明 MIME（zip 标 image）
19. 审批卡渲染中 Enter 是否可批未加载完的内容
20. apiKeyHelper 类配置是否在信任门之前执行

**扫描方法论诚实边界**：0-3 带（~55k 条）按词法判噪声未逐条人眼；4-7 带 19k 条抽样 360（产率 ~1.4%）外推全量预期还有 ~260 条候选未捞——多为已知族变体。若需真全量，可对 4-7 带再跑一轮聚类后抽簇心。

### 28.11 坑核查 22 项裁决 + A 档实现批次（2026-09-21，commit 05cf07a / f2ad836）

**坑核查终裁**（逐项对真实代码路径验证）：

| 坑 | 裁决 |
|---|---|
| #1 bash 重定向绕过 M1 | **真坑已修**：解析器吐 writeTargets（file_redirect 目的地 + tee/cp/mv/sed -i/dd of= 参数目标），命中指令文件强制 ASK |
| #15 复合命令白名单绕过 | **真坑已修**：`commandAllowlistMatch` 纯函数——逐单元全匹配、expansion 单元不软化、instruction_file 规则豁免（`echo x > AGENTS.md` 不再被 `echo` 前缀吃掉） |
| #14 sign-out 凭证复活 | **真坑已修**：auth_clear 清除后探测 getAuth，env/config 残余如实上报 |
| #4 后台孙进程 stdio 悬挂 | **真坑已修**：exit 边界+250ms 优雅期销毁流，不挂 FD 到孙进程死 |
| #3 compaction 丢 delegate | 不复发——结果落持久化 job store 不落 transcript，结构性免疫 |
| #2 deny 等价面 | 已修（前批 mutatingTools 扩展） |
| ExitPlanMode 绕过 | 不复发——mode_request 强制 operator ask |
| Enter 串键/误批 | 不复发——卡面无 Enter 绑定，批准只认点击 |
| 配置写竞态 | 不复发——fresh read 无缓存快照 |
| CRLF frontmatter | 不复发——全部 `\r?\n` 兼容 |
| checkpoint 全量 hash | 不复发——anchor 制 rewind |
| fail-open 沙箱 | 不复发——fail-closed throw |
| $HOME 索引 | 不复发——workdir 限定+MAX_FILES |
| 调度 delay 溢出 | 不复发——interval 轮询制 |
| 流式误删 | 不复发——全量替换渲染 |
| 重启丢参数/daemon 指纹 | 不复发——spec 重推导/自生子进程 |
| 脱敏过激 | 不复发——锚定模式 |
| AbortSignal/图片 MIME/apiKeyHelper/ripgrep | 不复发或 N/A（无对应面；图片归一记入 M138） |

**登记残余（上游语义待确认）**：stale agent_end 事件污染、MCP 工具列表顺序（均属 pi 上游行为域）。

**A 档 9 族终态**：

| 族 | 终态 |
|---|---|
| M55 结构化提问 | **已有**——ask_user（kind:question，选项+自由文本+拒绝语义） |
| M70/M97 会话树/编辑即分支 | **已有**——session_fork 任一点分叉+编辑重发 rewind+EscEsc scope |
| M63 出口域控 | **落地**——egress-allow.json 域白名单+重定向落点复查 |
| M84 卡内编辑命令 | **落地**——编辑框+{answer,edited}对象答案+截断载荷拒编辑+deny 层仍生效 |
| M89 会话导入 | **落地**——forkFrom 导入+parentSession provenance+[导入]标记+不切换 |
| M87 Monitor 唤醒 | **落地**——MonitorRegistry fs.watch→governed promptSink，busy 拒、事件不排队 |
| M56 per-feature 模型 | **落地**——feature-models.json judge 独立模型 |
| M57 外部密源 | **落地**——auth_set_key 收 op://（op read）/bw://（bw get），引用不落盘 |
| M93 排队弃尾 | **落地**——Esc 中止+1.5s 内再 Esc 弃尾队列（防静默吃消息） |

未动：M83 惰性加载、M100 fallback 链、M105 工具级 checkpoint、M38 占位符回取、M135 动态调速——中重型项留待下批。测试基线 host 226 / pi 174+1skip / app 18+1skip。

### 28.12 B 档薄件批次（2026-09-21，commit 011c3b2）

| 项 | 终态 |
|---|---|
| M134 exec 危险环境变量 | **落地**——command-parse 提取 variable_assignment 名称命中装载/代理类环境变量（LD_PRELOAD、NODE_OPTIONS、JAVA_TOOL_OPTIONS、_JAVA_OPTIONS、MAVEN_OPTS、PERL5OPT、DYLD_*、BASH_ENV、GLIBC_TUNABLES 等）→ `dangerEnv`，治理层对含 dangerEnv 的命令强制 `env_injection` ask，即使命令单元本身 benign |
| M61 占位凭证 | **落地**——auth_set_key 拒 sk-xxx 模板/your-key/changeme/<…>/<8 字符；真前缀（sk-ant-/sk-proj-/ghp_）放行 |
| M62 运行时权限请求 | **落地**——`request_permission` 工具：模型请求 operator 授予某工具会话级免卡；`PendingAsks.grantSession` 仅在卡面批准后生效，deny/timeout/aborted 不授 |
| M96 allowlist 导入导出 | **落地**——`command_allow_export`/`command_allow_import`：allow+deny 双名单合一 .json，路径限定 instance 根 |
| M138 附件字节嗅探 | **落地**——inline 附件 magic bytes 与声明 mime 冲突时以字节为准（MZ 声明 image/png 被降级出视觉面）；未知字节保留声明 |
| M54 Ctrl+R 历史搜索 | **落地**——输入框即查询框，slash 弹层渲染去重历史（新→旧），Enter 回填 Esc 还原草稿 |
| M59 /recap 会话回顾 | **落地**——session_switch 后抽取式一行回顾（首条 prompt + 末条用户 prompt + 消息数 + 更新时间），零模型调用 |

测试基线：host 229 / pi 176+1skip / app 18+1skip。

### 28.13 B 档薄件批次 3–5（2026-09-21，commits 8d007b2 / a56c05d）

| 项 | 终态 |
|---|---|
| M58 glob/路径穿越 | **已有**——自有文件面全限定（file_read realpath+symlink 拒、files_list workdir 内、repomap subdir 拒逃逸）；glob 本体是 pi 上游工具 |
| M60 /insights 用量 | **已有**——agent_stats + /stats（含批准卡结局分布） |
| M61 占位凭证 | **落地**（前批） |
| M62 request_permission | **落地**（前批） |
| M65 记忆 scope | **落地**——project/user 双 scope，project 行只在绑定 workdir 召回/注入；memory_save 默认 project |
| M66 web_fetch SSRF | **落地**——无白名单时链路本地/元数据面（169.254/16、fe80::/10、fd*、::1）一律拒，显式白名单可放；v4-mapped/IPv6 括号归一化防绕过 |
| M69 notify 策略 | **落地**——抽屉头 select always/smart/never；响度闸不吞记录 |
| M72 凭证原子写 | **落地**——writeJsonAtomic(tmp+rename) 覆盖 models.json/model-aliases/debug bundle |
| M74 记忆批量 | **落地**——store.bulk 事务化，mid-batch 拒绝全回滚 |
| M75 系统指标 | **落地**——GET /api/metrics（桥+身体 pid/uptime/RSS/heap）+ /stats 挂行 |
| M79 错过任务 | **落地**——markSkipped + missedWindowMs(4h) 超窗跳过一次，不补火风暴 |
| M85/M88 /add-dir | **已有**——workspace registry add/remove + trust 层按目录闸注入 |
| M95 本地模型发现 | **落地**——models.discover 探测 Ollama/LM Studio/llama.cpp + /discover |
| M96 allowlist 导入导出 | **落地**（前批） |
| M97 消息点击编辑 | **已有**（编辑重发=rewind 分支） |
| M98 bare /loop | **已有**——prompt 调度即裸循环；goal_tick 是自主变体 |
| M134 危险环境变量 | **落地**（前批 env_injection） |
| M138 字节嗅探+BMP | **落地**——magic 重分类 + BI_RGB BMP→PNG 零依赖转码 |

**仍待中重型的**：M64 实际删除动作（预览底子在）、M71 免持久会话、M76 per-agent disallowedTools、M77 子 agent 实况窗格、M80 sandbox.excluded、M81 多 profile、M82 MCP prompts、M83 惰性工具目录、M86 ambient context、M90 workflow 生命周期页、M92 后台会话页、M94 per-agent 上下文预算、M99 workers 页、M100 provider fallback 链、M105 工具级 checkpoint、M38 占位回取、M135 动态调速、M73 向量记忆。

### 28.14 中档批次（2026-09-21，commit 3a200bd）

| 项 | 终态 |
|---|---|
| M105 工具级 checkpoint→rewind | **落地**——fileops 回执携带 toolCallId；`undoCall` 精确撤单调用全部文件变更、`undoFrom` 回退锚点及之后全部变更；UI 变更面板「撤调用」「回退到此」 |
| M100 provider fallback 链 | **落地**——`<instance>/model-fallbacks.json` {chain:[{provider,model}]}；agent_end 检出 stopReason=error 时沿链切换会话模型+steer 重试；每任务链长上限、abort 永不触发、MODEL_FALLBACK 全审计；`model_fallbacks`/`model_fallback_set` 通道命令实时改链 |
| M38 大输出占位符回取 | **落地**——OutputSpool（<instance>/spool，FIFO 50 文件帽）+ tool_result 接缝把 >64KB 文本换成带 handle 的占位符；`output_read(id,offset,limit)` 模型工具分页回取 |
| M83 工具惰性加载 | **落地**——`<instance>/defer-tools.json` {defer:[names]}；ToolSurface.defer 隐藏但不 deny（不落 deny-memory、非治理拒绝）；`tool_search`/`tool_activate` 模型工具；decide 对直猜名字的 deferred 调用拦 `tool_deferred` |

**仍待**：M64 实际删除、M71 免持久会话、M76 per-agent disallowedTools、M77 实况窗格、M80 sandbox.excluded、M81 多 profile、M82 MCP prompts、M86 ambient context、M90/M92/M99 UI 页、M94 per-agent 预算、M135 动态调速、M73 向量记忆（重依赖）。

测试基线：host 233 / pi 186+1skip / app 18+1skip 全绿。

### 28.15 中档批次 2（2026-09-21，commit 5953271）

| 项 | 终态 |
|---|---|
| M76 per-agent disallowedTools | **落地**——可信 profile（operator-private 或受信 workdir）的 tools_deny 注入 delegate 桥 spawn env；不可信仓库 profile 在加载时被剥离，不能塑造执行面 |
| M94 per-agent 上下文预算 | **落地**——profile budget_* 维度与桥 flag 按维合并（取小者）；不可执行预算的目标在 spawn 前拒绝；拒绝时父级已承诺切片退还，不双计 |
| M80 sandbox.excluded | **落地**——ambient sandbox 按命令前缀豁免；显式 per-job sandbox 覆盖豁免；false 哨兵区分「明确不沙箱」与「未配置」，杜绝 ?? 回退复活 ambient provider |
| M86 ambient context | **落地**——context envelope 增 ambient 块（时间/cwd/平台/git 状态），每轮现取、独立于 steering/budget/memory 渲染；纯信息位，不作策略权威 |
| M135 动态调速 | **落地**——min_seconds/max_seconds 声明自适应区间；quiet tick（fingerprint 未变）指数退避至 max（2^streak×base，cap 6 级），真实 fire/恢复重置回 base；部分边界与越界三元组在 add 时拒绝；static 条目不受影响 |

测试基线：host 236 / pi 189+1skip / app 18+1skip 全绿。

**仍待**：M64 实际删除动作、M71 免持久会话、M77 子 agent 实况窗格、M81 多 profile、M82 MCP prompts、M90 workflow 生命周期页、M92 后台会话页、M99 workers 页、M73 向量记忆（重依赖决策）、上游残余（stale agent_end、MCP 顺序）。

### 28.16 中档批次 3（2026-09-21，commit 8846934）

| 项 | 终态 |
|---|---|
| M82 MCP prompts 上浮 | **落地**——prompts/list 在连接时发现，/mcp-&lt;server&gt;-&lt;prompt&gt; 注册为 slash 命令；prompts/get 展开为用户轮（带 [mcp prompt] 溯源前缀）；必填参数 k=v/位置双绑定、缺失诚实报错不发送；managed-manifest 重钉 |
| M64 实际删除动作 | **落地**——instance_purge：exports/spool/sessions（除活动会话文件）+tasks（仅 closed 目录，open/torn 保护）四类可清；audit/jobs/memory/receipts/schedules/allowlists 为治理证据拒绝；默认 dry_run，删除须显式 dry_run:false，INSTANCE_PURGE 审计 |
| M71 免持久会话 | **落地**——session_new {ephemeral:true} → SessionManager.inMemory；不写 sessionDir、不出现在列表、不可恢复/导出；UI /eph 命令 |
| M90 workflow 生命周期 | **落地**——job_restart（终态任务的恢复命令以新 job_id 重跑，血缘记审计）+ job_delete（仅终态，删 DB 行+attempt 产物文件）+ 详情面板重启/删除按钮；活动任务两者皆拒 |
| M92 后台会话页 | **部分 / VARIANT**（外部审查下调）——task 树+mailbox 中心覆盖「后台派遣会话的协调面」，但普通子输出不是完整实况会话时间线；与 Cursor agents 后台会话页是功能变体不是等价物 |
| M77 子agent 实况窗格 | **落地**——task-detail 面板：inbox/outbox/events 合并时间线 + 1.5s 轮询生命周期（openTask 启动 / 任务 closed 或离开 jobs 视图停止，原仅动作后单次刷新未接线，已修）+ 中断/关闭/发消息 |
| M99 workers 页 | **部分 / FUNCTIONAL VARIANT**（外部审查下调）——jobs 页四区（jobs/goals/schedules/tasks）覆盖任务面，但不是 worker/daemon 清单+生命周期管理页（无常驻进程清单、无启停控制） |
| M81 多 profile 实例 | **部分**——instance root + body_select 已给隔离与切换；「同实例内命名 profile（模型/凭证/权限预设包）+ export/import」未做 |

测试基线：host 240 / pi 192+1skip（其中 mcp-ext 7/7、channel 22/22、jobs 7/7 全绿）/ app 18+1skip。

**真剩余**：M73 向量记忆（sqlite-vec 依赖决策，host 零依赖约束下只能挂 pi）、M81 命名 profile 包、上游残余（stale agent_end、MCP 工具顺序）。

### 28.17 中档批次 4（2026-09-21，commit 6254fa0）

| 项 | 终态 |
|---|---|
| M81 命名 profile | **落地**——`<instance>/profiles.json`：profile_save 快照 {model,thinking,mode}，profile_apply 走同一治理 setter 回灌；名称长度上限、缺失 profile/非法 mode 诚实拒绝；PROFILE_* 审计；UI /profile save\|apply\|list\|del |
| M91 结构化参数表单 | **落地**——recipe_run 缺必填参数时经 PendingAsks question 卡逐参数问 operator（Automation Blueprints 形态）；deny/timeout/abort 拒绝展开；无 asks 通道保持原 missing-params 拒绝 |
| stale agent_end 残余 | **落地（防御层）**——agent_end 闩锁化：agent_start 重新武装；无 start 的重复/迟到 agent_end 丢弃+审计 STALE_AGENT_END，不再双触发 continuation/fallback |
| M78 调度绑 live session | **核查已有**——prompt 类调度经 promptSink 进当前会话（PAI 单会话/body 形态下即目标语义） |
| MCP 工具顺序 | **上游残余**——pi 上游 prompt 顺序，PAI 不重排 |

**M54–M147 全部裁定完毕。**唯一未裁项：M73 向量记忆——需 sqlite-vec/embedding 依赖决策（host 零依赖约束下只能挂 pi 侧）。

测试基线：host 240 / pi 193+1skip / app 18+1skip 全绿。

### 28.18 M73 向量记忆终裁（2026-09-21，外部仲裁会话 6aac8432）

**终态：DEFERRED_BY_EVIDENCE**（外部裁决，非实现欠债）

裁决要点：
- 现状 SQLite+FTS5+scope+生命周期评分+注入面已落地；semantic rerank 定位为补召回不是主路
- 无证据 FTS5 已成召回瓶颈（无 failure corpus）；sqlite-vec 稳定版仅 exact KNN，ANN 为 alpha 线
- 语义 miss 的真实驱动是 recall failure rate 不是条目数——「几千条」不是开门条件

**重开契约**：以下任一成立才重开
1. 真实生产 ≥3 个独立「应召回但 FTS5 未召回」案例
2. held-out recall eval 证明 semantic 稳定增益
3. 查询延迟达阈值且词法搜索已证为瓶颈

**重开后路径**：先做 B（embedding API + cosine 线性扫 + RRF 融合 + FTS-only 降级），B 实测延迟不足才准 A（sqlite-vec）。附带约束：embedding 是派生可重建数据不得成为写入前置；远程 embedding 需明确 provider policy（memory 含个人偏好是隐私面）；embedding_model_id/version/dim 必须随存（换模型=向量空间作废）。

**M54–M147 收口：94/94 全部有终态**（落地 / 核查已有 / 部分 / 上游残余 / DEFERRED_BY_EVIDENCE）。

### 28.19 外部复审批次：M101–M114 重裁 + 安全补缺（2026-09-22，外部审查会话 6aac8432）

外部审查在 `e011d5d` 固定 ref 上对 M54–M147 做深审。Batch-3~7 的 12 项安全/接线修复整体冻结（M63/66/71/76/77/80/82/83/89/90/94/96 FROZEN；M92/M99 PARTIAL/VARIANT 为诚实终裁）。本轮新增：

| 项 | 终态 | 证据/修复 |
|---|---|---|
| M116 审批卡 secret 泄漏 | **落地**（修复完成） | `sanitizeAskArgs` 原只做长度截断——args 中的 API key/token 原样进审批卡 DOM + 影子裁判。现在生成点统一脱敏：凭据字段名（key/token/secret/password/credential/authorization 等）整体置 `[REDACTED]`；串内模式（Bearer/sk-*/gh[pousr]_*/github_pat_*/xox*/AKIA*/AIza*/JWT/PEM/KEY=value 赋值）掩码；`argsRedacted` 标志随卡下发，UI 明示"凭据已遮蔽"；执行仍用原始 ctx.args |
| M107 `/btw` 只读旁路 | **落地**（原 FALSE_POSITIVE 修复） | 原裁定"等价达成"为假阳性——fork 构建的是完整 session，只读仅靠操作者意图。现 `buildSession(forkMgr,{posture:'btw-readonly'})`：白名单双闸（decide 硬拒非只读工具 + setModeDenied 会话级隐藏），request_permission/tool_activate 不可达杜绝提权回写；哨兵测试覆盖写/bash/job_spawn/delegate/mcp__* 拒止 |
| M103 孤儿恢复有界化 | **落地**（原 PARTIAL 补全） | `jobs.recovery_count` 持久列（含旧库幂等迁移）；recoveryTick 达到 `maxRecoveries=3` 后不再 respawn，转 WAITING_EVENT+REVIEW_REQUIRED；只计崩溃恢复，人工 restart 不占额度 |
| M104 turn 导航协议 | **REAL / 超集同构**（外部上调） | `session_entries`+`session_rewind{entryId,scope}`+UI 任意 entry picker+navigateTree = prev/next turn 协议严格超集 |
| M102 `/rename` | **REAL** | `app/ui/app.js` → `session_rename` |
| M105 工具级 checkpoint→rewind | **REAL / FROZEN** | `fileOps.undoCall/undoFrom` + 回归测试，前轮已验 |
| M111 skill 根目录热更新 | **PARTIAL / 收窄变体** | `.pai/microagents` 每次 prompt match 实时重载；但非通用 skill runtime root watcher |
| M113 插件安装治理 | **PARTIAL / 准入门径变体** | `noExtensions:true`+manifest 校验路径是供应链准入，非 install→review→rollback 工作流 |
| M101 后台会话 attach/detach | **MISSING** | 无 `session_attach/detach` 面；task/job 协调不等于后台会话挂接 |
| M106 `/context` map+ring | **MISSING** | 有 contextUsage 数字/pins/compact，无 composition map/ring |
| M108 消毒会话分享 | **MISSING** | export 为直接 copy，无 share 专用 sanitizer/token/link |
| M109 选区"Add to chat" | **REAL** | `app/ui` 选区→浮动"＋引用到对话"按钮→`> ` 引用块插入草稿；dom-gate `selQuote` 断言 |
| M110 Skill Workshop | **MISSING** | runtime 无 skill 创建/修改工具面 |
| M112 webhook 入站 | **MISSING** | 无 inbound endpoint/trigger router |
| M114 持久 `js_repl` | **MISSING** | Pi body 无持久 JS REPL（他 harness 的 node_repl 不外借） |

测试基线：host 250 / pi 229+1skip 全绿（含 M116/M107/M103 哨兵）。M115 tool-result 媒体可视性、schedule adaptive edit invariant、profile scope drift 仍在审。

### 28.20 外部复审：M115–M124 终裁 + M135/M81 收口（2026-09-22，外部审查会话 6aac8432）

外部审查在 `e011d5d` 上完成 M115–M124 深审并复核 M135/M81 措辞。本轮修复与终裁：

| 项 | 终态 | 证据/修复 |
|---|---|---|
| M135 adaptive 调度 edit 漏验 | **落地**（修复完成） | `edit()` 原不重验 min≤every≤max——可把 base 改出 bracket。现抽共享 `validateAdaptive()` 供 add/edit 同用；edit 对最终态重验、拒绝时记录字节不变；once 态边界休眠保留，once→interval 切回时必过闸（哨兵测试覆盖四态） |
| M115 tool-result 媒体可视性 | **落地**（原 UI CONSUMPTION GAP 修复） | 媒体块此前可到模型但在两个面静默丢失：`session_history` 只抽 text/thinking，`resultText()` 只拼 text 否则 JSON dump。现 history 契约保留受限 `media` 描述符 `{type,mimeType,name}`（不带原始 data/URI，egress 边界不外移）；UI live 结果渲染 `[type mime: name]` 描述符行、replay 在 assistant/toolResult 行输出媒体标签——URI 仅作文本展示绝不自动加载 |
| M81 命名 profile | **PARTIAL / NAMED RUNTIME PRESET**（外部下调） | 实测快照仅 `{model,thinking,mode,savedAt}`——原「凭证/权限/export/import 预设包」口径未实现。凭据值永不入 profiles.json；若日后扩展只存非密引用（auth ref id / policy preset id / model+thinking） |
| M117 ignore 兼容族 | **PARTIAL / COMPAT GAP**（诚实终裁） | `.paiignore` 机制真实，但未实现 `.aiignore`/`.clineignore` 兼容；兼容需单调递增的并集限制 + 正确处理否定语义，未有产品要求前不实装、不凑数 |
| M118 持久 job stdio 生命周期 | **REAL / 限定 durable-job 路径** | `pi/src/adapter/jobs.js` 有真实 child exit/stdin 清理；不外推为全部子进程语义 |
| M119 live 工具输出 | **REAL** | 实况输出有真执行链；与 replay/history 保真分开记录 |
| M120 doctor 诊断子系统 | **PARTIAL / VARIANT** | debug/trajectory export 是近邻变体，非完整 doctor（环境体检+修复建议） |
| M121 会话级 env 注入 | **PARTIAL** | env 注入仅存在于 delegate 子进程路径；无 session-wide env 注入面 |
| M122 shell 环境快照 | **MISSING** | 无 shell env snapshot；普通 env 处理不构成等价 |
| M123 bash spawn hook | **MISSING** | PAI body 无内置 bash spawn-hook 接线 |
| M124 运行时备份导入 | **MISSING** | fileops backup/restore + 离线耐久脚本 ≠ runtime backup import；无外部备份导入面 |

测试基线：host 260 / pi 233+1skip / app 23+1skip 全绿（含 M135-R1 四态哨兵与 M115 媒体描述符哨兵）。

### 28.21 M125–M147 自查终裁 + 安全补缺（2026-09-22，本会话对定义逐条取证）

M125–M147 逐条对照实现面取证（不依赖外部审查）。安全相关缺口当场修复，功能缺失如实降级，不凑数实装。

| 项 | 终态 | 证据/修复 |
|---|---|---|
| M125 memory 注入拒收 | **落地**（修复完成） | `remember()` 原只扫 secret——recall 注入每轮 context，存一句 "ignore all previous instructions" 即成跨会话持久攻击。现 `scanForInjection()` 在写入边界拒收指令覆写/角色劫持形态（角色通道标记行锚定，"file system:" 类普通行文不误杀）；哨兵测拒收+不可 recall+误杀豁免三态（`095c373`） |
| M126 输入框 Ctrl+Z | **REAL** | 草稿级 undo/redo 栈：程序性写入点全插桩（send/steer/slash/历史召回/rewind/引用/starter）+700ms 打字合并快照；Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y；dom-gate `draftUndo`+`draftRedo` 断言 |
| M127 全局命令面板 | **REAL** | `fuzzyScore` 子序列匹配（连续段/前缀/短目标加权）贯通 slash 命令+宏+标签；头部非空时注入 top-6 会话模糊条目（💬 切换到会话）；Ctrl+K 面板+Ctrl+R 历史检索不变 |
| M128 autoscroll 偏好 | **REAL** | `pai.scrollmode` 三档持久化（接近底部时跟随/总是跟随/从不自动滚动）；off 档新消息仅弹 jump-latest；设置-外观下拉生效；dom-gate `scrollPref` 断言 |
| M129 粘贴徽章 | **REAL** | 长粘贴内 `path:line(:col)` 引用识别（40+ 扩展名，全角冒号兼容，去重 cap 8）→附件 chip `📍` 徽章；dom-gate `pasteBadge` 断言 |
| M130 MCP list_changed | **MISSING** | pi/host 源码无 tools/list_changed 接线（venv 命中不算） |
| M131 slash frontmatter mode | **MISSING** | recipe frontmatter 只有 `params:`；microagents 只有 `triggers:`；无 mode 字段触发切模式 |
| M132 /config 会话内设置 | **MISSING** | 无 /config key=value 命令面 |
| M133 web_fetch 超限摘要 | **PARTIAL** | 24K 截断存在；无 >15K 触发 AI 摘要 |
| M136 自治 Curator | **MISSING** | 无 skill 库评分/修剪/合并代理 |
| M137 图片压缩档 | **PARTIAL** | BMP→PNG 零依赖转码存在；无 token-efficient/balanced/high-detail 模型感知分档 |
| M139 附件落盘路径 | **PARTIAL** | path 源附件可读+内联；模型拿不到持久落盘路径供后续编辑/引用 |
| M140 Fast Context 子代理 | **MISSING** | 无专用高速检索代理 |
| M141 apply_patch 拒 Add | **N/A-UPSTREAM** | 本仓无自有 apply_patch 工具（write/edit 为上游 pi-coding-agent 工具，fileops 备援层兜底回滚）；Codex 专属语义不适用 |
| M142 写后 lint | **REAL** | `.pai/verify.json` `{onWrite}` 武装写后反射循环（Aider lint/test 类比），`/verify` 手动触发 |
| M143 跨文件 multi-edit | **MISSING** | 无单调用多区域/跨文件 search_and_replace 工具 |
| M144 unicode_mode | **PARTIAL** | decide.js 有不可见 unicode 剥离（Goose 类比）；无 auto/unicode/ascii 输出降级档 |
| M145 .git 只读 | **落地**（修复完成） | `protectedRoots` 机制存在但从无调用方传 `.git`。现 `GIT_INTERNAL_RE` 双覆盖：文件工具（write/edit/delete mutatingTools 闸）+ shell writeTargets 均升 `git_internal` ask；`.git` 读与 `git status` 等读命令不受影响；哨兵测四态（写拦/读放/普通文件不误伤/git 命令自由） |
| M146 持久 always 授权 | **REAL** | `always` 答 → `{tool,command}` 精确对持久化 `<instance>/always-allow.json` 跨重启生效；截断 args 拒绝持久化；`ASK_ALWAYS_PERSIST` 审计；instance inventory 可查可清 |
| M147 文件读取注入扫描 | **落地**（修复完成） | `injectionHygieneExtension` 挂 `tool_result` seam：read/grep/find/ls/output_read 结果含指令形态文本时前置 hygiene banner（数据非命令）+ `INJECTION_HYGIENE_HIT` 审计；幂等不重复打标；文件读取边界与 memory 写边界（M125）互补成链 |

安全修补位点全部在生成器源码（kernel decide 链 / 扩展 seam / 写入边界），非事后补丁。

### 28.22 MISSING 项补建（2026-09-22，本会话实装 + 哨兵）

28.21 裁出的 6 条 MISSING 中，M130/M131/M132/M140/M143 实装落地；M136 以 advisory-curator 形态落地（评分/提案自动，破坏性动作仍走治理 ask——这是设计语义而非缩水）。

| 项 | 终态 | 证据/实现 |
|---|---|---|
| M130 MCP list_changed | **REAL** | `notifications/tools/list_changed` 推送→`refreshTools` 重列：新工具即时注册，移除工具 tombstone 成诚实 fail-closed 错误（pi API 无 unregisterTool）；`/mcp` 报刷新状态。订阅提前到 connect 后立即挂（boot 期间到达的通知记 pendingRefresh 补刷——不再静默丢）。stdio 推送通道，HTTP 无推送面即不触发。哨兵：v1 注册→call 触发目录翻转→v2 新工具活+被删工具墓碑+存活工具仍可调（`9d4ad70`） |
| M131 slash frontmatter mode | **REAL** | recipe frontmatter `mode:` 触发时经共享 `requestModeSwitch` 走治理 ask 链（与 mode_request 同链：catalog 校验→operator ask→applyMode），拒绝时如实附注不静默。哨兵：合法切换/未知模式/无 ask 通道三态（`9d4ad70`） |
| M132 /config 会话内设置 | **REAL** | channel `config_get`/`config_set` + UI `/config`：key 白名单（model/thinking/mode）分发到现有治理 facade（models.set/setThinking/modes.setMode），非旁路持久化；未知 key 与缺失 facade 均 fail-closed。哨兵：快照读/slash 解析/未知键拒绝/裸 facade 拒绝（`9d4ad70`） |
| M136 自治 Curator | **REAL (advisory)** | `curateLibrary`（host 纯函数）：staleness/thin/triggerless/overlap 评分+merge/prune/keep 提案；`curator_scan` 工具出报告——**提案永不自动执行**，修剪仍走 skill_delete 治理链（破坏性动作走 ask 是该条目的设计内语义）。哨兵：评分扣分项/重叠对合并取新者存活/低分修剪提案/扫描零副作用（curator.test.js） |
| M140 Fast Context 子代理 | **REAL (deterministic variant)** | `fast_context` 工具：单次调用完成 walk+term 打分+行号摘录（文件名命中>>内容命中），有界（20k 文件/512KB/10 层/40 结果上限），只读零副作用，.paiignore 生效，subdir 不可逃逸 workdir。诚实变体：确定性检索替代 LLM 子代理循环（`pi/src/adapter/fastcontext.js`） |
| M143 跨文件 multi-edit | **REAL** | `multi_edit` 工具：`edits[{path,old_string,new_string,replace_all}]` 全量 preflight（存在/唯一/workdir 内/未 ignore）任一失败整批拒绝零写入；应用期每文件经 fileOps.write 备份+同 toolCallId 收据→undoCall 整批回滚；中途失败对已写文件 best-effort restore。decide 链入 FILE_MUTATION_TOOLS（写租约）+U4 密钥预扫覆盖 edits[].new_string（堵批量工具绕过洞）。哨兵 5 态（multiedit.test.js） |

未补建项（保持诚实记录）：M133/137/139/144 维持 PARTIAL 原裁（均有近端实现，差的是各自注明的完整语义）；M141 N/A-UPSTREAM 不变。M126/127/128/129 已于批4 落地为 REAL（见 §28.30）。

### 28.23 A1 边界硬化（2026-09-22，方向二全量复审取证实修）

业界采集复审（Gemini v0.60 NTFS 8.3/symlink 专项）触发的边界自查，确认三处真洞并修复在生成器层（`pi/src/bootstrap/decide.js` + `host/src/core/governance.js` 正则导出）：

| 洞 | 原状态 | 修复 |
|---|---|---|
| 读侧 symlink 逃逸 | `outsideWorkdir` 纯 lexical `resolve()`，`workdir/link→外部` 下 `read link/x` 静默放行 | realpath-aware：realWorkdir 缓存 + 实对实比较，非常驻目标回退 lexical |
| 写侧零边界 | write/edit/delete/multi_edit **完全不在**边界检查面（protectedRoots 只护 instance 内部），`write C:\任意` 无边界闸 | 新增 `write_outside` 闸：read_outside 同构闩锁（一次/会话/拒绝锁定），无 operator 通道 fail-closed；multi_edit 逐 path 查 |
| shell 写目标逃逸 | `writeTargets` 只过 instruction/.git 字符串正则，`> ../out` 或 `> link/x`（link→.git）lexical 看不到真路径 | classifier 块内：①越界 writeTarget 升 ask②最深已存在祖先 realpath 后用导出正则重查（`link/config`→`.git/config` 命中 git_internal）；设备槽（NUL//dev/null）豁免 |

附带修复：writeTarget ask 原先落在 `catch{mutating=true}` 内会吞掉 AbortError 放行被中断调用——改为重抛。

哨兵 `pi/tests/writeboundary.test.js` 9/9：绝对路径越界写/闩锁单次询问/内部写不误伤/读侧 symlink/写侧 symlink 父目录/`> ../`重定向/`.git` symlink 逃逸/multi_edit 越界批拒/设备槽豁免。pi 全套 270+1skip、host 281 全绿。

同批取证排除项：#4279 bash 注入检测**已覆盖**（`command-parse.js` tree-sitter 递归 `$(...)`/subshell/管道/循环体全部进 units 归并风险）。

### 28.24 hooks 事件补齐 + A2 MCP env 消毒（2026-09-22，方向二复审批1续）

**hooks 缺口**（业界 18 家收敛面 vs 我方 8+1 事件）：`fire()` 观测侧不理 `match` 字段（gate 侧才过滤）、无具名子代理事件、无通知事件。修复在生成器层：

| 缺口 | 修复 |
|---|---|
| `match` 前缀过滤仅 gate 生效 | `fire()` 同款过滤（payload.toolName 前缀），观测钩可按工具降噪 |
| 子代理生命周期无具名事件 | `subagent_start`/`subagent_stop`——delegate* 工具执行边界处由父会话派发（子进程自身另有 session_start/end） |
| 通知无事件面 | `notification`——在 channel `emit()` 中枢对 `type:'notify'` 统一派发，覆盖全部通知源 |

**A2 MCP spec.env 注入**（Gemini v0.60 env 同意链对应项，取证为真洞）：`.pai/mcp.json`/`.mcp.json` 在 workdir（agent 一次获批写入可植入），`spec.env` 原样并入 stdio 子进程环境——`NODE_OPTIONS=--require ./payload`、PATH 劫持、LD_PRELOAD、代理改道、`GIT_SSH_COMMAND` 等注入键让看似无害的 `node server.js` 变成绕过 decide 链的静默执行。修复在 spawn 边界（`stdioTransport`）：`ENV_INJECT_RE` 剥离子集→`client.strippedEnv` 记录→`/mcp` 状态明示；操作者环境本身不受影响（信任边界仍是 operator env），合法密钥类 env（GITHUB_TOKEN 等）照常传递。

哨兵：`host/tests/hooks.test.js` +2（match 过滤/新事件载入）、`pi/tests/mcp-ext.test.js` +1（单测剥离面 + spawn 级实证：子进程真实看不到 NODE_OPTIONS、operator env 不受影响、strippedEnv 上报）。

### 28.25 批2：host 核心七项补建（2026-09-23，方向二残余清单实装）

MISSING 终裁表中的 host/会话面七项全部实装，各项均带哨兵回归：

| 项 | 终态 | 证据/实现 |
|---|---|---|
| M101 会话 attach/detach | **REAL** | sessions facade `attach(path)`：open 持久会话 + 实况报告（isStreaming、taskStore 中 run_scope 命中的在跑子任务、尾部回放），语义区别于 resume——重连进行中的会话而非换皮打开。`detach()`：审计 SESSION_DETACHED + 返回流态（jobs/hooks 是进程级不随 UI 走）。channel `session_attach`/`session_detach` 双侧接线。哨兵：detach 报流态+审计（channel-facade.test.js） |
| M106 /context map | **REAL** | facade `contextMap()`：按 role/kind 分段的构成图（count/chars/estTokens≈chars/4 标注为估计）+ `getContextUsage` 权威总量；ring = compact 后存活的尾窗。channel `context_map` 分发。哨兵：分段+权威用量合并（channel-facade.test.js） |
| M108 消毒分享 | **REAL** | facade `share()`：会话 jsonl 逐行 `redactSecrets` + workdir 路径掩码 `[WORKDIR]`（正/反斜杠双形态），头部行带 provenance+脱敏计数；产物写 `sessions/exports/share-*.jsonl`，不自动上传。channel `session_share` 接线。哨兵：secrets+路径掩码落盘实证 |
| M120 doctor | **REAL** | `host/src/core/doctor.js` 可插拔体检注册表 + `doctor` 工具：provider 可达性/HTTP 状态/延迟/auth 配置来源（无凭据材料出进程）、policy/manifest/ignore 完整性项。零依赖可测 |
| M121 会话 env 注入 | **REAL** | `host/src/core/sessionenv.js`：会话级 env overlay——注入向量键（NODE_OPTIONS/PATH/LD_PRELOAD/DYLD_*/GIT_SSH_COMMAND/代理族等）硬拒+审计；overlay 经 `env_set`/`env_unset`/`env_list`（密钥类值掩码）治理面进入，分发到全部自产 spawn 点：jobs executor、HookRunner（scrub 后合入——操作者显式设定的键有意让子进程看到）、verify、delegate profileEnv。哨兵：env_set 拒绝注入键/overlay 真实到达 hook 子进程环境（envtools.test.js spawn 级实证） |
| M122 env 快照 | **REAL** | `env_snapshot` 工具 + `captureEnvSnapshot`：base∪overlay 有效视图、操作者密钥掩码、overlay 键标旗、`redacted` 清单区分 "unset" vs "set-but-hidden"；可选持久化到 `<instance>/env-snapshots/` |
| M124 运行时备份导入导出 | **REAL** | `pi/src/adapter/runtimexfer.js`：`runtime_export` 白名单打包（`.pai/` 选择集 + instance 运行态，**永不含治理配置/会话本体**），manifest 携带逐文件 sha256；`runtime_import` 先验签再落盘——篡改字节/非 bundle/workdir 逃逸一律拒写；导入需 operator ask（无通道 fail-closed）；逐文件走 `FileOpsGuard.write`（备份+收据→可回滚）；`.paiignore` 映射防工作区把 steering 文件塞回治理层。哨兵：export→import 往返/篡改拒收/逃逸拒收/operator 拒绝/无通道拒收（runtime-xfer.test.js） |

修复位点说明：批2 为**新执行路径**（生成器源码），非文档声明；`runtimeXferTools` 因 `fileOps` 初始化时序从数组字面量移到 push（TDZ 回归已在 bootstrap.test.js 复现并修掉）。回归：host 293 / pi 296+1skip 全绿；validate_repo --strict 0 err；quality gate 22 skills PASS；diff --check 干净。

### 28.26 批3：pi 工具面七项补建（2026-09-23，方向二残余清单实装）

| 项 | 终态 | 证据/实现 |
|---|---|---|
| M144 unicode_mode | **REAL** | `host/src/core/charset.js` 零依赖输出归一器：`auto`（默认值不动）/`unicode`/`ascii`（降档：→↦ 等常见符映射 + 非 ASCII 剥离）；在 `HostChannel.#emit()` 事件边界对全部 session 事件文本统一应用；`config_get`/`config_set` 暴露 `unicode_mode`。输入侧既有不可见字符消毒保持不动（decide.js sanitizeArgs）。哨兵：channel.test.js +2（ascii 降档/auto 不动） |
| C2 MCP output_token_limit | **REAL** | `pi/extensions/mcp/index.js`：server 级 `output_token_limit`（按 chars≈token×4 封顶）+ `tool_output_limits` 逐工具覆盖；超限文本截断并带显式 `truncated` 标记，untrusted envelope 完整保留。哨兵：mcp-ext.test.js +1（server 级截断 + 逐工具覆盖胜出） |
| M133 web_fetch 超限摘要 | **REAL** | `webFetchTool` 注入 `summarize` 回调（bootstrap 复用 `judgeCall` 门控 LLM 面——走治理 fetch + 按量计费路由）；body >15K 且截断时先送 ≤60K 前缀给摘要器，产出 `<web_fetch summarized="true">` 包裹摘要；summarizer 缺位/失败回退诚实截断（不出伪摘要）。哨兵：web.test.js +1（摘要路由 + 无 summarizer 回退） |
| M123 bash spawn hook | **REAL** | `bash_run` 走 exec facade 旁路了 session pump 的 hook 派发——在 `exec.run` 补发观测性 `tool_start`/`tool_end`（toolName=bash_run），沿用既有 HookRunner 治理/env 消毒。哨兵：bootstrap.test.js +1（真子进程钩子实证：写盘 marker 验证 PAI_HOOK_EVENT+toolName） |
| M110 Skill Workshop | **REAL** | skilltools 补齐工坊回路：`skill_list`/`skill_read`/`skill_test`——`skill_test` 复用生产匹配谓词 `matchMicroagents()`（host/src/core/microagents.js）做触发器 dry-run，不写第二个解析器；写入仍走既有 skill_save 治理面。哨兵：skilltools.test.js +2（test 命中/不命中、list/read 巡检） |
| M114 持久 js_repl | **REAL** | `jsrepl-worker.js`（持久 node 子进程 + vm context，`globalThis` 作 context——exec 类语义全量 node 全局，stdout/stderr 逐次捕获，JSONL 协议：stdout 仅响应包、诊断走 stderr）+ `jsrepl.js`（工具封装：懒启动/跨调用保态/Promise await/重启清空/输出有界/子进程 env 经 scrubHookEnv 剥密钥）。治理：governance `EXEC_BODY_TOOLS` 导出把 js_repl 归 exec 族（tool allow 不软化 risk class）；decide 列入 mutating 写租约面；host.js 注册+dispose。哨兵：jsrepl.test.js +2（声明持久/异步 await/restart 清空/子进程 env 密钥剥离实证） |
| C3 MCP profile 限定 | **REAL** | 镜像 M76 tools_deny 范式：profile `mcp_deny` 字段（同信任闸——untrusted workdir 剥除）→ delegate `--mcp-deny` 专用桥旗（PAI_* 通道，env-json 永不携带）→ `PAI_MCP_DENY` env → mcp 扩展在连接前过滤 denied server（连握手都不发生），`/mcp` 状态明示 denied 名单；非 pai-channel 目标 fail-closed 拒派（unenforceable_mcp_deny）。哨兵：agentprofiles（信任闸）+jobs-executor（拒派+桥旗实证）+mcp-ext（连接级过滤+/mcp 可见） |

修复位点说明：批3 全部落在**执行路径**（worker/工具/桥旗/扩展装载面），非文档声明；M114 排障中发现并修复两真 bug——裸 vm context 缺 node 全局（改 `globalThis`）+ restart 竞态（旧 child 的 exit 晚到误清新 child pending——exit 处理器只对当前 child 生效）。回归：host 294 / pi 313+1skip 全绿。

### 28.27 复审核销批：G1-G8 真洞实修（2026-09-23，[verify] 项全量核销）

全量语料复审（18,405 条逐条）产出的 ~40 条 `[verify]` 项逐条取得代码级证据后，确认 8 个真洞并全部修复在**执行路径**（非文档/非测试补丁），其余核销为已覆盖/variant/记录档。修复清单：

| # | 洞 | 修复（生成器源码位点） | 哨兵 |
|---|---|---|---|
| G1 | `schedule_task` 不在 kernel `commandArgs` 也不在 decide `COMMAND_ARG_KEYS`——排程 `rm -rf` 静默创建，触发时 hardPolicyGate 只拒 deny 级，**ask 级规避通道** | host.js `commandArgs` + decide.js `COMMAND_ARG_KEYS` 同步加 `schedule_task:'command'`——创建时分类=批准时刻 | schedule.test.js：kernel 分类断言 + denyPrefix 在创建时拦截 |
| G2 | FILE_MUTATION_TOOLS 只查 lexical containment——`write link/config`（link→.git）realpath 在界内但命中保护文件 | decide.js 写闸新增 realTarget 发散重查（resolved≠lexical 才重问，kernel 已裁的同路径不双问） | writeboundary：symlink→.git=git_internal ask / symlink→.pai=instruction_file / 同路径不双问 |
| G3 | MCP connect 失败泄漏 stdio 子进程 | connect catch 内 `transport.close()` | mcp-ext：refusing server 场景断言 pid 落盘后进程死亡 |
| G4 | browser click 无落地重查、read/screenshot 无 host 闸 | click 加 NAV_SETTLE 后落地重查+退回 about:blank；read/screenshot 加 currentHost 闸 | browser.test：click→blocked 退回 / read+screenshot 拒 |
| G5 | http-bridge 只查 POST 的 Origin——GET /events SSE 流无 Host 校验，DNS rebinding 同源读遥测 | `badHost` 全请求闸：非字面 loopback Host 一律 403 | bridge.test：4 端点全拒 + 字面 loopback 通过 |
| G6 | delegate task 文本无密钥扫描——secret 落 argv+checkpoint | task 文本 `scanForSecrets`→命中直拒 | agentprofiles：credential pattern 任务文本拒派 |
| G7 | MCP stdio close 只 kill 单进程，孙进程孤儿 | close 改 `taskkill /T /F`（Win）/`SIGKILL`（POSIX），与 jobs/hooks 进程树范式对齐 | 同 G3（close 路径即清理路径） |
| G8 | MCP 非文本结果块不打 untrusted 标，畸形块原样透传 | wrapUntrusted 归一：已知类型透传、未知/畸形→`unsupported content block dropped` 文本桩+details.droppedBlocks | mcp-ext：4 类混合块断言归一形态 |

核销为**已覆盖**的代表项：换行注入/反斜杠续行（tree-sitter 结构层）、包装命令 EXEC/UNKNOWN fail-closed、Unicode 不可见字符严格键 block、hooks 罩 mcp__*、断线 in-flight 拒、hook 进程树回收、compact/subagent/notification 事件、policy attestation+drift、session fork provenance、torn JSONL 容错、memory 规范化去重+注入拒、browser navigate 落地重查、扩展零发现+sha256 manifest、delegate enforceability/budget 原子预留。记录档：#1435 MCP 无 reconnect 面（v1 候选缺口）、hooks 文件存在即开关、PS 命令走 bash grammar 的 fail-closed 误拒方向。

回归：pi 323+1skip / host 309 / app bridge 4 全绿。

### 28.28 批5：编排族收口（2026-09-23，M112 + B1/B2/B5）

| 项 | 终态 | 证据/实现 |
|---|---|---|
| M112 webhook 入站 | **REAL** | `pi/src/adapter/webhook.js` `WebhookReceiver`：`<instance>/webhooks.json`（operator-private，workdir 不可植）声明 `{enabled, port, bind, endpoints[]}`——**默认拒绝：无配置=监听器根本不起**；端点 shared-secret（`Bearer`/`x-pai-secret`，支持 `secretSha256` 免存原文）timingSafeEqual 比对；仅 loopback bind（显式宽绑会审计 WEBHOOK_BIND_WIDE）；32KB body 帽 + JSON-only + 端点级滑动窗口速率帽（默认30/h，硬帽240）；sink 忙 → 202 诚实拒绝。**CommandAuthorized 语义**：secret 认证的是事件来源不是权限——fired prompt 走正常 channel prompt 路径，每个工具调用仍过 decide 链（meta.webhook 只记溯源）。哨兵：webhook.test.js ×4（无配置不起听/认证+审计面/sha256/速率帽+busy 拒绝） |
| B1 `/scan` map-reduce | **REAL（v1 诚实边界）** | channel `scan_run {goal, subdir?}`：先经 fileOps 预建 `.pai/scans/scan-<ts>.md` 骨架（治理写入路径）→ 结构化 scan prompt 走 promptSink（map：repo_map/fast_context/grep/read 调查、大域可 delegate_task 分片；reduce：findings 落 artifact，file:line 引证，空结果优先于噪声）；`scan_list` 列 artifact。sub-dir 逃逸 lexical+realpath 拒。模型侧无 scan 工具——扫描是决策不是动词。**v1 不做**：自动开 PR（git 域外，越界）。哨兵：bootstrap.test.js +1（stub 落盘+prompt 路由+校验拒绝） |
| B2 文件/事件触发器 | **REAL（已建+本轮补全事件面）** | MonitorRegistry 早已覆盖文件触发（operator-armed fs.watch→governed promptSink、速率帽、durable restore、agent 不可自臂）；本轮 webhook 补齐外部事件触发；scheduler 覆盖时间触发。三个唤醒面全部同走治理 promptSink |
| B5 项目共享上下文 | **REAL（治理变体，#3323 路线）** | project-scope memory（`memory_save scope:project` 绑 workdir + `memory_recall` 检索-only，同 workdir 跨会话共享，untrusted 证据位）+ `.pai/` 知识文件（microagents/plans/recipes 本就在 workdir 跨会话共享）+ `session_share` 脱敏导出。**明示不做**：跨机同步（sync 属 sync 域）、auto-recall 注入（检索-only 是刻意安全边界） |

接线：host.js 起 `webhooks.listen()`（无配置静默 no-op）+ `scan`/`webhooks` facade；pi channel 透传；host channel 加 `webhook_status`/`scan_run`/`scan_list` 三个 case；dispose 链路挂 `webhooks.close()`。`/scan` UI 菜单项归批4（app/ui 外来在途避让）。

回归：pi 相关套件 46/46（含新哨兵 6）、host channel 30/30。

### 28.29 批4 先落 pi/host 侧：M137 图片分档 + M139 附件落盘路径（2026-09-23）

批4 的纯 UI 项（M109 选区入聊 / M126 草稿撤销 / M127 fuzzy 命令面板 / M128 滚动偏好 / M129 粘贴徽章 / C1 会话列表）全部落在 `app/ui/*`——外来会话在途，继续避让。pi/host 侧两项先落地：

| 项 | 终态 | 证据/实现 |
|---|---|---|
| M137 图片压缩档 | **REAL（PNG 域，诚实边界）** | `attachments.js pngDownscale(buf, maxEdge)`：零依赖 PNG 解码（IHDR+IDAT→inflate→5 型 unfilter→RGBA）→ 2×2 box 折半至 ≤maxEdge → filter-0 重编码。config `image_detail`：`high`（默认不动）/`balanced` 1568px/`low` 512px（OpenAI 网格语义）；共享 cell 经 channel `config_set` 写入、附件搬运路径逐 prompt 读取；缩放写 IMAGE_DETAIL_SCALED 审计。**诚实边界**：interlaced/非8bit/非PNG 返回 null 原样透传——不假装会转码 JPEG。哨兵：channel-facade +3（64→32 IHDR 实证 / 已达标不缩 / JPEG 诚实跳过 / config_set 旋钮） |
| M139 附件落盘路径 | **REAL** | path 源附件：`describeAttachment` 加 `path` 属性，模型拿到可编辑/可引用的真路径；inline（粘贴）源：`persistAttachment` 落盘 `<instance>/exports/attachments/` 并在 `<attachment>` 标签通告该路径。**顺手修真 bug**：path 源图片走 native 通道时 `source.data` 是 undefined——`materializeImageSource` 物化字节（BMP path 源照样过 bmpToPng），不可读则诚实降级进 degraded |

回归：pi 335+1skip / host 312 全绿。

### 28.30 高分带逐条台账收口：score 8–29 全量 4,263 条（2026-09-23）

28.10 记录的是信号层（80,369 条）评分口径；去重后候选层为 22,668 条，其中 `_midreview` 批次台账（batch23）只覆盖 score 4–7 的 18,405 条。本节补齐剩余 score 8–29 的 **4,263 条逐条处置**——高分带恰是机制密度最高区，不允许簇级默认。

**方法**：`hiscore-skeleton.tsv` 机械抽取 `idx|score|cluster|src`（候选 JSONL 无 idx，按归一化文本与 `hiscore.txt` 行序对齐）；判定列 `verdict|detail` 人工按 200 条/批逐条手写进 `verdicts-hi-0..20.tsv`（21 批，先读全批原文再写判定，零簇级默认/零"剩余行兜底"）；join 成 **`changelogs/_midreview/hiscore-dispositions.tsv`**（`idx|score|cluster|src|verdict|detail|pass`，pass=manual）。机械校验：4,263 行 idx 0–4262 连续、零重复、verdict/detail 全非空、score 与源一致。

**处置分布**：dup×1,936（我方已实装/已裁决同型）· boundary×1,418 · cand×487 · noise×257 · variant×165 · verify×0。

**6 条 verify 落码核销**：#248 memory 召回 untrusted 标（`memory.js:297`，dup）；#981 globs 锚 workdir（`decide.js:84`，dup）；#1249 家目录索引面不存在（`fastcontext.js` workdir 限定，dup——更强）；#915 repo 内 exe 影子化批准命令（`jobs.js:505` shell:true + cmd.exe cwd 搜索，**cand**）；#1277 revert 不清 agent 建的空目录（**cand**）；#1284 fork 无容量闸（**cand**）。

**全量对账闭环**：item-dispositions.tsv 18,405（score 4–7）+ hiscore-dispositions.tsv 4,263（score 8–29）= **22,668 条去重候选逐条处置完备**，上溯 80,369 信号 / 89,544 原始 / 35 家 harness 采集链不断层。

### 28.31 批4 UI 侧落地：M109/M126/M127/M128/M129/C1 六项（2026-09-23）

`app/ui` 外来改动入库后基线已净，批4 的六个 UI 项落地（代码 `app/ui/app.js`+`index.html`+`style.css`，C1 数据位 `pi/src/bootstrap/host.js`）：

| 项 | 实现 | 证据 |
|---|---|---|
| M109 选区入聊 | transcript 内选区→跟随浮动"＋引用到对话"按钮（mouseup/Shift+键触发，scroll/点击别处/选区塌缩即隐）→ `> ` 引用块插入草稿尾部并聚焦 | dom-gate `selQuote` |
| M126 草稿撤销 | 自实现草稿 undo/redo 栈（cap 200）：程序性写入点全插桩（send/steer/execSlash×3/pickHist/cancelHistSearch/历史召回/starter/rewind/选区引用）+输入 700ms 合并快照；Ctrl+Z 撤销/Ctrl+Shift+Z 或 Ctrl+Y 重做；draftKey 切换时栈随草稿重置 | dom-gate `draftUndo`+`draftRedo` |
| M127 fuzzy 面板 | `fuzzyScore` 子序列匹配（连续段加权+前缀奖+短目标偏好）替换前缀过滤；命中域=命令+中文标签+宏；头部非空时注入 top-6 会话模糊条目（💬 徽章"切换到会话"→switchSession）；Ctrl+K 面板入口不变 | dom-gate `fuzzyScore`+`slashSession` |
| M128 滚动偏好 | `localStorage pai.scrollmode` 三档：`near`（原行为）/`always`（追加即钉底）/`off`（不自动滚，新消息仍弹 jump-latest）；设置-外观"滚动跟随"下拉持久化 | dom-gate `scrollPref` |
| M129 粘贴徽章 | 长粘贴文本内 `path:line(:col)` 引用识别（~50 扩展名、全角冒号、去重 cap 8）→附件 chip `📍 file:line +N` 徽章（title 全列表） | dom-gate `pasteBadge` |
| C1 会话列表 | 置顶独立"📌 置顶"分组（不再只是组内排序）；状态点诚实映射——任务绑定非终态会话或当前会话 busy→绿脉冲点，归档→空心点，**完成/未完成不可廉价判定不造数**；hover 卡（400ms 延迟）含标题/条数/类型标记/修改/创建/cwd；数据位：facade `sessions.list` 对非终态 run_scope 任务打 `live` | dom-gate `sessPinnedGroup`+`sessDot`+`sessCard`；pi `sessionlist-live.test.js` |

回归：app 26/26（dom-gate 六面+八项新断言全绿，axe 无 serious）；pi 368/372（4 skip）全绿；stylelint+html-validate 净。

### 28.32 648 清单逐条核销 #1：dedup-h #2 worktree 侧栏创建（2026-09-23）

**行**：`dedup-h	2	shell-tools	worktree: sidebar worktree creation`（zed release：侧栏 new-thread 按钮直接开新 worktree）。

**判定**：**IMPLEMENTED（变体语义对齐）**——能力本体（git worktree 独立检出跑任务）M13 已有（`delegate_task worktree:true`）；本行补的是**操作员入口面**：侧栏按钮 → 在独立 worktree 起一条干活线程。落法不复制 harness 的 UI 形状，而是把同一能力挂到治理链同侧：

| 层 | 落点 | 证据 |
|---|---|---|
| channel | `host/src/core/channel.js` `job_spawn` 操作员命令（{command, worktree?, timeout_ms?}） | host 346/346 |
| decide | `pi/src/bootstrap/decide.js`：修复**既有缺陷**——job_spawn 被 :483 豁免 fg 租约后，:484 命令重分类又置回 mutating → :562 照拿 fg 锁 → job 自己的 `job:` 锁必撞；改法=mutating 判定保留（写目标/protected 重检仍生效）但 job_spawn 永不拿 fg 锁 | bootstrap e2e 覆盖 mutating 命令 spawn |
| exec facade | `pi/src/bootstrap/host.js` `runJob`：与模型 job_spawn **同一 currentDecide 链**（denyPrefix/riskActions/写目标全生效），spawn 后 OPERATOR_JOB_SPAWN 审计；拒绝/阻塞分路径审计 | `OPERATOR_JOB_SPAWN`/`OPERATOR_JOB_BLOCK` 审计断言 |
| UI | `app/ui/app.js` `/worktree <命令>` 斜杠命令 → `job_spawn{worktree:true}` → 成功跳 jobs 视图 | dom-gate `worktreeCmd` |
| 执行器 | `JobExecutor.spawnCommandJob` 复用：`git worktree add --detach`，干净自动移除/脏保留 `JOB_WORKTREE_KEPT`/非 git 诚实拒绝/restart spec 携带 worktree 位 | `pi/tests/jobs-executor.test.js` M13 |

**回归证据**：pi 369 测 365 过 4 skip（新 e2e `operator job_spawn`：真 git 仓→worktree 标记文件落在 detached checkout、主检出零污染、denyPrefix 拒绝零副作用、审计齐全）；host 346/346；app 26/26（dom-gate `worktreeCmd`）；lint 双净；`git diff --check` 净。

**核销**：candidates-open #2 → `candidates-resolved.tsv` #1。

### 28.33 648 清单逐条核销 #2：dedup-h #6 Team 多代理任务分派+消息传递（2026-09-23）

**行**：`dedup-h	6	orchestration	Team: multi-agent task assignment + message passing`（TeamCreate/TeamDelete 类工具组建多 agent 协作）。

**判定**：**IMPLEMENTED（名册层）**——消息传递/常驻 teammate/邮箱/拓扑此前已落（D3/G4）；本行补的是缺的"队"实体层：名册分组 + 广播投递。落法仍走 mailbox 原语，不引入并行任务池仲裁（裁定书 v1 外项维持推迟）：

| 面 | 落点 | 证据 |
|---|---|---|
| 名册 | `TaskStore.create({team})` → task.json 持久 `team` 字段；`byTeam()` 只回 open 成员（closed 自动离队，大小写不敏感） | host `team roster` 测试（含重开 store 持久性断言） |
| 分派 | `delegate_task(team=…)` 参数 → 任务挂名册（可独立或与 `name=` 并用） | delegate.js schema+create 透传 |
| 广播 | 新工具 `team_msg{team,message}` → 对名册内每个 open 成员各投一封 inbox（行内带 `team` 标记）+每成员记 `team_msg` event；全员被拒则 isError | `team_msg broadcasts…` 测试：2/2 送达、跨队零污染、closed 跳过 |
| 名册查询 | `task_list{team?}` 过滤 + 行含 name/team | `task_list filters by team` 测试 |

**语义差异（诚实记录）**：无显式 TeamCreate/TeamDelete 生命周期对象——队以标签隐式存在（有 open 成员即在）；队删除=成员逐个 closed。多对多任务池仲裁仍属推迟项。

### 28.34 648 清单逐条核销 #3：dedup-h #7 Session Insights 会话剖析（2026-09-23）

**行**：`dedup-h	7	sessions-history	session-insights: usage analysis feature`（Devin Session Insights：分析会话、分解发生了什么、给 actionable tips）。

**判定**：**IMPLEMENTED（确定性变体）**——落法是**无模型**剖析面：分解+建议全部可追溯回解析出的事实，不用 LLM 生成"看起来像洞察"的文本。

| 面 | 落点 | 证据 |
|---|---|---|
| 分解 | `sessions.insights(path)`：roles/entryTypes/blockTypes 直方图 + 工具调用/错误计数 + tokens/cost + 时长 + top5 工具 | pi `session_insights` e2e：合成会话全字段断言 |
| 建议 | 纯规则：工具出错 TopN→排查提示、错误块>3→复盘提示、用户消息>50→存档提示、cost>$1→预算提示、空会话→截断提示 | 同上 tips 断言 |
| 边界 | 路径限定 sessionDir（realpath resolve 前缀），越界/不存在/不可读→诚实 error 返回 | 越界断言 `outside session dir` |
| 通道/UI | channel `session_insights{path}`；UI `/insights [path]`（默认当前会话文件）渲染分解+tips | channel 30/30 + dom-gate 复用 |

### 28.35 648 清单逐条核销 #4：dedup-h #12 自定义 session-id（2026-09-23）

**行**：`dedup-h	12	shell-tools	custom session-id flag (--create-with-session-id)`（创建任务时指定 UUID 会话 ID，ID 校验为 UUID）。

**判定**：**IMPLEMENTED**——引擎 `NewSessionOptions.id` 本就支持注入（`SessionManager.create(cwd,dir,{id})`），缺口全在操作员面与校验：

| 面 | 落点 | 证据 |
|---|---|---|
| 透传 | `sessionManagers.create` 转发 options → 引擎 `assertValidSessionId` | pi adapter index.js |
| 校验 | 操作员面收严格 UUID（8-4-4-4-12 hex）——比引擎的宽松字符集更贴合"validated as UUID"语义；非法→创建前拒绝 | `session_new id` e2e |
| 碰撞 | **双层**：同实例 pinned-id 集（会话文件懒写，文件名/头扫描拦不住未落盘双胞胎）+ 持久会话头 `id` 扫描；命中→`already exists` 拒绝不覆盖 | e2e：未落盘同 id 拒 + 持久头同 id 拒 |
| 通道/UI | `session_new{id?}` 透传（ephemeral 分支不变）；UI `/newid <uuid>` | channel + slash |

**回归**：pi e2e 21/21（本文件模式跑通）；host channel 30/30。

### 28.36 648 清单逐条核销 #5：dedup-h #19 project purge 预览+批量清理（2026-09-23）

**行**：`dedup-h	19	approval-gate	project purge: preview+remove sessions/tasks/history bulk cleanup`。

**判定**：**IMPLEMENTED（tasks 补齐 + UI 面）**——M64 骨架已覆盖 inventory 预览 + purge dry-run/确认/证据类拒绝；本行补齐两处缺口：

| 面 | 落点 | 证据 |
|---|---|---|
| tasks 类 | 加入 PURGEABLE——closed 任务目录=历史可清；**open 邮箱=活通道整目录保护**（任一流命中即全目录豁免）；torn task.json 按安全侧保留 | pi channel-facade `instance_purge tasks`：closed 删/open+torn 存/dry-run 预览正确 |
| "history" 边界 | audit/jobs/memory/receipts/schedules/allowlists **有意不可清**——治理证据，拒绝信息明写理由（非缺失，是边界） | host M64 测试沿用 |
| UI 面 | `/purge [cat]`：无参→instance_inventory 分类计数渲染；有参→dry-run 预览→confirm→实删 | slash 表新增 |

**回归**：channel-facade 34/34（含新用例）；channel.js 语法/ESM 净。

### 28.37 648 清单逐条核销 #6：dedup-h #33 AskUserForStructuredInput schema→表单（2026-09-23）

**行**：`dedup-h	33	ui-ux	AskUserForStructuredInput: schema→UI表单ask`（模型给 schema → UI 渲表单 → 回结构化对象）。

**判定**：**IMPLEMENTED**——`kind:'form'` 加入 ask 契约三层：

| 层 | 落点 | 证据 |
|---|---|---|
| 契约 | PendingAsks `kind:'form'`：与 question 同族（无 session-allow/无 deny 级联/超时拒绝诚实返回）；fields 描述符净化（≤12 字段、类型白名单、select 强制 options）随 governance_ask 事件出 | host `form kind` 测试全断言 |
| 校验 | `resolve()` form 分支**宿主侧重校**（required/number/boolean/select 域/8000 字符帽）——UI 只是渲染器；对象答案**不**走 `{answer,edited}` 解包，按值对象原样回模型 | 越域/缺必填/类型错→拒绝且 ask 保持挂起 |
| 工具 | `ask_structured{title,fields}`：schema 入校即拒（重复 key/未知类型/select 无 options）；答案 `details.answer`=值对象 | pi askuser.test.js 三用例 |
| UI | ask 卡 form 分支：按 schema 渲 text/textarea/number/checkbox/select+必填星+description title → 收集值对象 → decision_resolve | `.ask-field` CSS + 渲染分支 |

**语义差异**：超时/中断=诚实未答（非自动默认）；表单值不写审计明细（只记 `answered:keys`——表单可含敏感输入）。

### 28.38 648 清单逐条核销 #7：dedup-h #38 remote-mcp oauthResource RFC8707（2026-09-23）

**行**：`dedup-h	38	mcp-tools	remote-mcp: oauthResource RFC8707 override field`（远程 MCP 服务器 OAuth 的 RFC8707 resource 指示符覆盖字段）。

**判定**：**IMPLEMENTED**——HTTP 传输加 `spec.oauth` client_credentials 授予：

| 面 | 落点 | 证据 |
|---|---|---|
| 覆盖字段 | `spec.oauth.resource` → token 请求 `resource=` 原样发出；缺省=服务器 URL（RFC8707 资源的规范 URI） | `resource override` 测试断言 token POST body |
| 校验 | `validateOAuthSpec` 连接期 fail-closed：tokenUrl 必须 http(s) 且 http 仅 loopback（携 client_secret 禁明文外发）；resource 必须绝对 URI 且无 fragment（RFC8707 §2）；`headers.authorization` 与 oauth 并存=歧义凭据拒绝；类型全检 | `malformed specs fail closed` 7 组断言 |
| 令牌管理 | form-encoded client_credentials；token_type 必须 bearer；expires_in-60s 提前刷新；401 → invalidate + 单次重试；令牌只进 Authorization 头，`/mcp` 只见 `oauth client_credentials (resource: …)` 描述符 | `401 re-auths once` 测试 |
| 边界 | authorization_code/PKCE 需浏览器回调——明示越界；静态 bearer 仍走 `spec.headers` | 头注释 |

**注**：候选描述混入了"等连接中 MCP 服务器"的另一特征（wait-for-connect）——那是连接行为，本行按 oauthResource 字段核销；等待语义已在 connect 超时链覆盖。

### 28.39 648 清单逐条核销 #8：dedup-h #43 delegate-modes Fork 模式（2026-09-23）

**行**：`dedup-h	43	orchestration	delegate-modes: Agent tool Fork mode(省略type→后台fork)`（省略 subagent_type → 自动后台 fork 继承父代理）。

**判定**：**IMPLEMENTED**——`delegate_task` 省略 `target` 且省略 `profile` → **fork 模式**：`target` 解析为 `'pai'`（pai-channel 同体子代理=继承父体配置的后台持久任务；fork 继承代理配置而非 transcript）。`details.mode` 盖 `'fork'|'delegate'` 供归因；返回文本显式标 `(fork)`。

| 面 | 证据 |
|---|---|
| 默认链 | `!target → 'pai'`——与显式 `target:'pai'` 走完全相同的模板插值/enforceable 断言/预算切片路径，无旁路 |
| 可观测 | `details.mode` + 文本 `(fork)` + 工具描述明示"Omit both for FORK mode" |
| 测试 | jobs-executor `M43`：省略→`mode:'fork'`/`target:'pai'`/commandFor 收到 'pai'；显式 target 仍 `mode:'delegate'` |

**边界**：fork=同体配置继承（opencode 语义），非 transcript 分叉——后者是会话层 `session fork`（已有 `/fork`）。

### 28.40 648 清单逐条核销 #9：dedup-h #56 tool def prepareArguments 钩子（2026-09-23）

**行**：`dedup-h	56	file-edit	tool def prepareArguments hook（参数归一化钩子）`（工具定义级参数归一化钩子，原始参数→schema 校验前整形）。

**判定**：**ALREADY COVERED（引擎契约）**——pin 的 `@earendil-works/pi-coding-agent@0.85.1` 自带该机制：

| 面 | 证据 |
|---|---|
| 契约 | `ToolDefinition.prepareArguments?: (args:unknown)=>Static<TParams>`（types.d.ts:362）——"compatibility shim to prepare raw tool call arguments **before schema validation**"，正是候选语义 |
| 执行序 | `prepareArguments → validateToolArguments → beforeToolCall → execute`（session.js 头注，对 agent-loop.js:410-449 核实）——归一化输出必经 schema 校验，安全序 |
| 生产用例 | 内建 `edit` 用 `prepareEditArguments`：字符串 edits→数组、legacy oldText/newText→edits[]（bundle chunk-JVUZSMYM.js） |
| 我方路径 | `defineTool`/`createToolDefinitionFromAgentTool`/`wrapToolDefinition` 均转发该字段——我们 customTools 声明即生效 |
| 活证据 | 新测试 `M56`：customTool 声明 `prepareArguments` → 注册进 `_state.tools` 仍为函数且可调用归一化 |

无新增代码必要；补一条回归哨兵防字段被静默丢弃。

### 28.41 648 清单逐条核销 #10：dedup-h #63 plugins 贡献面（2026-09-23）

**行**：`dedup-h	63	orchestration	plugins贡献rules/hooks/MCP/subagents — 扩展面`（插件可贡献规则/钩子/MCP/子代理四类表面）。

**判定**：**IMPLEMENTED**（补最后一片）——四类贡献面盘点：

| 面 | 状态 | 机制 |
|---|---|---|
| rules | ✅ 既有 | `pi.on('context')` 扩展注入上下文消息（adapter/index.js:88 自用）+ `.pai/microagents` steering 触发知识 |
| hooks | ✅ 既有 | `pi.on(...)` 30+ 事件：tool_call/tool_result/session_*/turn_*/provider 请求前后/agent_* 全挂点 |
| MCP | ✅ 既有 | `pi/extensions/mcp` 托管扩展把 MCP 服务器桥进工具/斜杠命令面（M82/M130/C2/A2） |
| subagents | ✅ **本轮补** | `pi/extensions/<name>/agents/*.md` 经 `loadAgentProfiles.extraDirs` 纳入 frontmatter persona 加载——扩展代码本就是操作员装的 release 码（envCapable 全能力）；追加序末位，**永不遮蔽** operator/workdir 同名 profile（first-write-wins） |

测试：`M63`——插件 dir 贡献 persona、同名 operator 胜、envCapable 字段透传。

### 28.42 648 清单逐条核销 #11：dedup-h #74 session export markdown/quarto（2026-09-23）

**行**：`dedup-h	74	sessions-history	session export命令(markdown/html/quarto全量导出)`（会话导出命令，markdown/html/quarto 全量）。

**判定**：**IMPLEMENTED**——`session_export` format 家族补齐：

| format | 状态 | 产物 |
|---|---|---|
| html | ✅ 既有 | 引擎 `exportToHtml`（渲染版） |
| jsonl | ✅ 既有 | 原始轨迹复制 |
| debug | ✅ 既有 | 会话+AgentTask 子树+jobs 调试包 |
| markdown/md | ✅ **本轮** | `sessionToMarkdown`：全量转录——YAML-less markdown，每消息 `## Role — ISO时间`，text/thinking/toolCall(fenced json args)/tool_result(fenced,4k cap)/attachment 全块；torn tail 容错 |
| quarto | ✅ **本轮** | 同生成器出 `.qmd`：YAML frontmatter（title/date/`format: html`）可直接 `quarto render` |

**修复**：`HostChannel session_export` 的 format 白名单原只放行 jsonl/debug——新格式放行；ephemeral 会话拒导（M71）对全部格式生效。

测试：channel-facade `markdown/quarto` 用例——角色/时间戳/文本/thinking/工具调用/结果块/quarto frontmatter 全断言 + torn 行容错。

### 28.43 648 清单逐条核销 #12：dedup-h #91 teammate idle awareness（2026-09-23）

**行**：`dedup-h	91	orchestration	Team: teammate idle awareness(查询队友实时状态)`（查询队友实时状态）。

**判定**：**IMPLEMENTED**——presence 从真实信号推导，不声称：

| presence | 判据 |
|---|---|
| `busy` | open + 绑定 job 处于非终态（RUNNING/QUEUED/…） |
| `idle` | open + job 终态/无绑定（纯 mailbox 任务也算 idle） |
| `offline` | state≠open——closed 覆盖一切，即便 job 还挂着 |

- `task_list` 每行新增 `presence`/`job_state`/`last_activity`（outbox+events 最新行时间戳=子代理真实最近发声）
- 新工具 `task_status{task_id|name}`：单成员实时卡——name 走 `byName` 队友池解析
- bootstrap 注入 `jobState: jobStore.getJob(...)`——presence 与 durable job 真态同源

测试：`M91-presence`——busy/queued/idle/unbound/offline 五态 + name/id 寻址 + not-found + last_activity 随子输出更新。

### 28.44 648 清单逐条核销 #13：dedup-h #100 plugins 注册 slash commands + dispatch tools（2026-09-23）

**行**：`dedup-h	100	shell-tools	plugins注册slash commands+dispatch tools — 扩展命令面`（插件注册斜杠命令+分发工具）。

**判定**：**ALREADY COVERED**——引擎 `pi.registerCommand`/`pi.registerTool` 契约 + 生产在用 + 测试实锤：

| 面 | 证据 |
|---|---|
| 静态命令 | mcp 扩展 `pi.registerCommand('mcp', …)`；lsp `registerCommand('lsp', …)` |
| 动态命令 | M82：MCP prompt 自动注册 `/mcp-<srv>-<prompt>` 斜杠命令族——`pi.commands.get('mcp-fake-greet')` 测试断言注册+handler 分发到 `getPrompt`→`sendUserMessage` |
| 工具注册 | mcp 扩展每服务器 `registerTool`（`mcp__srv__tool` 动态族+list_changed 热更新）+ lsp 六工具 |
| 测试锚 | mcp-ext.test.js：`prompts register as slash commands`、`prompt-only server`、`tools-only server`、M130 hot-refresh |

无新增代码必要。

### 28.45 648 清单逐条核销 #14：dedup-h #109 hooks before_tool_call requireApproval（2026-09-23）

**行**：`dedup-h	109	approval-gate	hooks: before_tool_call async requireApproval(钩→ask升级)`（pre_tool 钩可异步要求操作员批准）。

**判定**：**IMPLEMENTED**——gate 钩第三种结局：

| 结局 | 语义 |
|---|---|
| `{"deny":"…"}`/exit≠0 | 拒绝（既有） |
| exit 0 | 放行（既有） |
| `{"requireApproval":"question"}` | **新增**：suspend 在 `asks.ask()` 真审批卡上——allow/allow_session/always 放行，deny/timeout 拒绝；无 asks 通道 fail-closed |

**信任边界保持**：钩只能**升级**，永远没有 approve 分支（operator-private `<instance>/hooks.json` gate 专属；workdir 观察面钩仍无 veto 权）。后台 job 重启路径无交互上下文→升级=诚实拒绝（操作员手动重启即裁决）。

测试：hooks `requireApproval` 结构化输出（deny 缺位/问题透传）；m8-wiring `M109`——批准放行/deny 拒绝/无通道 fail-closed + HOOK_ESCALATE 双审计事件。

### 28.46 648 清单逐条核销 #15：dedup-h #131 remote-mcp Settings OAuth 授权流（2026-09-23）

**行**：`dedup-h	131	remote-cloud	remote-mcp: Settings OAuth授权流`（远程 MCP 的 OAuth 授权码流）。

**判定**：**IMPLEMENTED**——authorization_code + PKCE 交互流（#38 的 client_credentials 是机对机，本行是人授权）：

| 面 | 落点 |
|---|---|
| spec | `oauth.authorizationUrl` 存在 → `flow:'authorization_code'`；`redirectUri` 默认 `urn:ietf:wg:oauth:2.0:oob`（粘贴回流，无浏览器自动化依赖）；校验同 tokenUrl（https/loopback http、无 fragment） |
| 起 | `/mcp-auth <server>`：PKCE verifier+S256 challenge+state，组 authorize URL（response_type/client_id/redirect_uri/scope/**resource**（RFC8707 override 复用））→ 通知操作员开链接、10 分钟有效 |
| 收 | `/mcp-auth-done <server> <code>`：`grant_type=authorization_code`+code_verifier 换 token → 用户私有库 `~/.personal-ai/mcp-oauth.json`（0600，`PAI_MCP_TOKEN_STORE` 覆盖）——**令牌永不进 workdir** |
| 用 | `oauthStoredTokens`：连接按 serverName 读库；过期走 `refresh_token` 授予原地续期；无令牌→`MCP_UNAUTHORIZED` 诚实错误点名 `/mcp-auth <name>`；`/mcp` 状态只显示 flow 描述符 |

测试：PKCE 全链（authorize URL 全参数/code_verifier 交换/库存取/refresh 续期/Bearer 上行）+ 未授权诚实拒绝。

### 28.47 648 清单逐条核销 #16：dedup-h #143 模型可调用内置 slash 命令（2026-09-23）

**行**：`dedup-h	143	shell-tools	model-invoked内置slash commands(/clear/model/config/resume)`。

**判定**：**IMPLEMENTED**——`session_command` 工具：模型发 `command_request` 事件 → 操作员面排队 → 回合结束后走与操作员 `/clear /model /config /resume` **同一代码路径**执行。

| 面 | 落点 |
|---|---|
| 模型面 | `pi/src/adapter/sessioncmd.js`：白名单 {clear,model,resume,config}，越名拒；无操作员面挂接时 fail-closed 明说；arg 上界 300 字符 |
| 排队语义 | `app.js` `sessionCmdQueue`：busy 或有排队提示词时**不执行**（(name,arg) 去重、保序）；`agent_end` 且提示词队空才泄放——模型拆不了自己所在的回合 |
| 执行面 | `runSessionCommand`：clear→`/clear` run；config→`/config` run（查看/key=value）；model→`model_set`（`provider/model` 或别名，空参弹操作员同款菜单）；resume→session_list 按 id/name/firstMessage 匹配→`switchSession`（无匹配诚实报找不到） |
| 可见性 | 每次泄放先落 `模型请求执行 /<cmd>` 系统行——操作员能看到模型请求了什么 |

测试：`sessioncmd.test.js` 5 例（事件形/白名单/四面/无面 fail-closed/arg 上界）；dom-gate `cmdQueuedWhileBusy`（busy 中只排队不执行）+ `cmdConfig`（agent_end 泄放走 config_get）+ `cmdResume`/`cmdResumeMiss`（真切 s2/无匹配诚实报）+ `cmdModel`。修 fixture 一个真缺陷：`get_state` 不反映 session_switch 后的当前文件（真实身体会报切换后的会话——fixture 原先恒定报 s1）。

### 28.48 648 清单逐条核销 #17：dedup-h #146 delegate-params frontmatter model 字段（2026-09-23）

**行**：`dedup-h	146	skills-plugins	delegate-params: skill/command/subagent frontmatter model字段`（三类 frontmatter 的 model 覆盖字段）。

**判定**：**IMPLEMENTED**——三面对账：

| 面 | 判定 | 落点 |
|---|---|---|
| subagent profile | 已覆盖 | `agentprofiles.js` `model:` frontmatter → `commandFor` opts（信任门：workdir profile 剥离，operator/扩展 profile 生效）——M94 测试在案 |
| command（recipe） | **新增** | recipe frontmatter `model: provider/model|别名` → `requestModelSwitch`：操作员 ask 卡批准 → `channel.handle(model_set)` 走操作员同路径；拒绝/无通道/无分发全部诚实回报，recipe 本体仍展开 |
| skill（microagent 知识块） | 有意拒绝 | 知识注入发生在 prompt 组装时——该回合模型早已绑定，`model:` 对注入块是伪语义；不给死字段 |

**边界**：recipe 文件是不可信 workdir 内容——能**请求**换模型（走 ask），永远不能**强制**换。`mode:`/`model:` 可同存于一份 frontmatter，各自独立审批。

测试：`modetools.test.js` requestModelSwitch 6 断言（ask→model_set 命令形/别名形/deny 不分发/无通道/无分发/失败透传）；`skilltools.test.js` #146 用例（frontmatter 解析/RECIPE_MODEL 审计/拒绝诚实/无通道/note 叠加/双字段同存）。

### 28.49 648 清单逐条核销 #18：dedup-h #154 approval prompt 内 "Edit command" 微调后批准（2026-09-23）

**行**：`dedup-h	154	approval-gate	approval prompt内"Edit command"微调后批准`。

**判定**：**ALREADY_COVERED**——编辑后批准链四层全在（M84 批次落地）：

| 层 | 证据 |
|---|---|
| UI | ask 卡 `编辑命令` 按钮→textarea（app.js:765-785）；批准发送 `{answer, edited:{command}}`（app.js:897-902） |
| 通道 | `decision_resolve` 透传对象回答（channel.js:1021） |
| 宿主 resolve | `PendingAsks.resolve` 校验：edited 键必须已在卡 args 中（无注入）、仅 allow 族可带 edited、截断负载禁编辑（asks.js:285-303）；`always` 持久化的是 **edited** 命令（asks.js:167-170） |
| 治理执行 | `governance.decideToolCall`：`Object.assign(ctx.args, edited)`——活引用，工具执行的是操作员改过的文本（governance.js:230-262）；M84 硬策略重检（deny/terminate/unparseable 照拒）；双端 hash 审计 `GOVERNANCE_ASK_EDITED` |

测试在案：governance.test.js M84×3 + in-card edit 落 ctx.args；asks.test.js 对象回答/拒编/截断拒 3 例。本轮实测 59/59 绿。

### 28.50 648 清单逐条核销 #19：dedup-h #165 remote-mcp 网关代理 OAuth 令牌交换（2026-09-23）

**行**：`dedup-h	165	mcp-tools	remote-mcp: gateway proxy OAuth token exchange`。

**判定**：**IMPLEMENTED**——`oauth.exchange` 子规格：取到的令牌降级为 **subject token**，POST 到网关交换端点换上游 bearer（RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange`）。

| 面 | 落点 |
|---|---|
| spec | `oauth.exchange:{url,audience?,resource?}`；url 同 tokenUrl 校验（https/loopback http）；resource 绝对 URI 禁 fragment |
| 交换 | `subject_token`+`subject_token_type`+`client_id`(+`client_secret`)+`audience`/`resource` → gateway → exchanged bearer 缓存至自身 expiresAt |
| 401 | 上游 401 只废**交换令牌**——subject token 仍有效，重试仅重新交换不重新授权 |
| 双流兼容 | client_credentials subject / authorization_code 用户令牌均可进交换（`oauthExchangedTokens` 包装任意 token source） |
| 可见性 | `client.oauth`/`/mcp` 描述为 `... + gateway token-exchange`，令牌永不进输出 |

测试：真实双端点 rig——token 端断言 client_credentials、exchange 端断言 RFC8693 全字段（subject_token=tok-1/audience/resource/client_id）、上游请求全带 `Bearer gw-tok-*`；malformed exchange spec×4 fail-closed。manifest sha256 同步更新。

### 28.51 648 清单逐条核销 #20：dedup-h #167 mcp add 位置参数 URL（claude code 兼容语法）（2026-09-23）

**行**：`dedup-h	167	mcp-tools	remote-mcp: mcp add positional URL(claude code兼容语法)`。

**判定**：**IMPLEMENTED**——`/mcp-add` 命令：

| 面 | 落点 |
|---|---|
| 语法 | `/mcp-add <name> <http(s)-url> [--header "K: V"]*` 与 `/mcp-add <name> <command> [args…] [--env K=V]*`；name kebab-case；**引号感知分词**（`--header "X-Team: ops"` 完整成词） |
| 持久化 | 写入已解析的配置文件（`$PAI_MCP_CONFIG`/`.pai/mcp.json`/`.mcp.json`），无配置文件时落 `.pai/mcp.json`；尊重文件既有键型（mcpServers/servers）；tmp+rename 原子写；重复名/deny 名/畸形 spec 拒 |
| 热连接 | 提炼 `connectOne`——boot 循环与 /mcp-add 共用同一路径（通知订阅/独立族发现/pending refresh/failed 标记） |
| 诚实面 | 连接失败仍持久化（配置是操作员的）+ 明说 FAILED 看 /mcp；成功报 tools/prompts 数 |

测试：mcp-add 用例覆盖 URL 持久化+live 工具注册+header 透传、stdio command/args/env 形、重复/deny/usage 拒、失败仍持久化。manifest sha256 同步。修一处真实 bug：天真 whitespace 分词会把带引号 header 切碎成非法 header 名导致连接必败——已改引号感知。

### 28.52 648 清单逐条核销 #23：dedup-h #181 媒体跨 provider 自动回退（2026-09-23）

**行**：`dedup-h	181	models-routing	provider-failover: media跨provider自动fallback`。

**判定**：**IMPLEMENTED**——prompt 通道的能力闸门升级：图片附件撞上纯文本模型时，先走操作员回退链找视觉模型，找不到才降级描述符。

- `pi/src/adapter/channel.js` prompt 改 async；`caps.images===false` 且有图片 → 遍历 `fallbacks.chain`（`modelRuntime.getModel` 查 `input` 含 `'image'`）→ `setModel` 成功则重分区、图片原生携带、`MEDIA_FALLBACK` 审计 + 操作员通知；链上无视觉项/`setModel` 失败 → 原降级路径不变
- 位点：生成器源码（prompt 管线），非事后补丁
- 测试：channel-facade `media fallback`——视觉命中切换+原生携带+审计+通知；无命中保持诚实降级

### 28.53 648 清单逐条核销 #24–25：dedup-h #197 session-insights（ALREADY_COVERED）+ dedup-h #202 session_directory 扩展事件（IMPLEMENTED）（2026-09-23）

**#197** `session-insights: session分析+knowledge管理`：**ALREADY_COVERED**——session_insights（#7 本轮落地）给逐会话分解+确定性建议；knowledge 管理/裁剪 = skills_list（skill-doctor 统计）+ skill_allow_set + skill_save/delete + skill_test（M110 workshop），trust-gated 注入。

**#202** `hook-events: session_directory extension event(自定义session目录)`：**IMPLEMENTED**——

- `host/src/core/hooks.js`：`session_directory` 进 `GATE_EVENTS`（**绝不进 HOOK_EVENTS**——agent 可达的可观察配置重定向 transcript = 自助外泄通道）；新 `fireValue` 方法（gate-only 查询事件：跑首个配置的 hook，解析末行 stdout JSON；配置却失败→抛错由调用方裁决）
- `pi/src/bootstrap/host.js`：gate runner 提前到 sessionDir 之前；`fireValue('session_directory')` 返回 `{directory}` → 校验绝对路径/长度/NUL → mkdir -p → `SESSION_DIRECTORY` 审计（source: hook|default）；hook 配置却失败 → **拒绝启动**（静默回默认目录会把会话撒到两处）
- 测试：bootstrap `session_directory` 重定向（session_new 落定制目录+审计）+ 坏 hook fail-closed；host 349 全绿
