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
| 会话 | 会话列表（置顶/今天/昨天/7天/14天分组+状态点+hover卡） | 🟡 | 日期分组+搜索已有；置顶/归档/状态点/hover 详情未做 |
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
| 协作 | EnterWorktree git worktree 隔离 | ❌ | 无 worktree 隔离 |
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
| 协作 | `spawn_agent`+**agent teams**（teammate 常驻+mailbox+共享任务库+outcome artifacts，SQLite 持久化 team 状态） | 🟡 | delegate_task 一次性委派；无常驻 teammate/mailbox/共享任务库 |
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
| U3 rewind 强化 | **已有** | `/undo` 回执组回滚+聚合 `/diff`+`/btw` 只读分叉+Vibe"rewind 默认 fork"等价达成且更强：pi `navigateTree` 是**树 rewind**——弃走分支整棵留在会话文件，`session_entries` 列全树用户消息（跨分支），`session_rewind` 可导航回弃走分支任一点；fork 要防的丢时间线问题结构性不存在 |
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

**仍剩**（递减收益/需真实需求驱动）：Claude Code worktree 隔离（与 writeLease+回执体系重叠，等真实并行需求）、Gemini per-model fallback 链与 trust-gated 高权模式（政策敏感面）、Hermes auxiliary 模型分工（第二路模型开销）、OpenHands 多策略 condenser、Qwen microcompaction、Pi custom-entry/compact-veto/project-trust（veto 钩子与观察面设计冲突，维持有意不做）、OpenCode tree-sitter 命令解析（新增依赖 vs 现有解析器已覆盖 pipe/subshell/单位提取）。启动闪屏已落（`#splash` 只盖真实连接等待，无假进度）。
