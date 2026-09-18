# ADOPTION_MATRIX.md — 逐 harness 取长补短落地矩阵

> 状态定义（评审修订：三分同构强度，不混用）：
> - **已采用** — 机制已在 Personal AI 落地，附落点与验证证据
> - **同构-同类** — 我们的机制覆盖同等职责但实现不同（如 JSON policy ≈ Starlark execpolicy）
> - **同构-更强** — 我们的机制在职责相同的前提下覆盖更严（如 canonical policy + drift 认证 > flag 冻结）
> - **候选** — 值得做但未做，附理由与预计落点
> - **暂缓** — 已评估，证据不足或前置条件未满足，记录复评触发条件
> - **拒绝** — 不适合本架构/有安全或边界问题，附理由
>
> 验收口径：所有"已采用"必须有代码落点 + 测试或真机冒烟证据；候选必须有明确取舍理由。

## 基线：Personal AI 自有机制（先于本次收敛已存在）

| 机制 | 落点 |
|---|---|
| Policy-as-code + checksum 认证 + 运行中 drift fail-closed | `host/src/core/policy.js` — loadPolicy/assertFresh；policy.json 是规范锚，live session 中修改 → 批次终止 |
| 风险分类（benign/mutating/destructive/network/privilege/exec/unknown）+ 每工具规则 + 负能力（保护根禁写） | `host/src/core/governance.js` lattice：deny > 负能力 > ask > allow |
| 治理 ASK 通路（挂起等操作员，fail-closed 无通道拒绝） | `host/src/core/asks.js` + UI 批准卡；审计 `GOVERNANCE_ASK/RESOLVED/ADMITTED` |
| **Tree-sitter 命令解析**（语法级，非自制 tokenizer） | `pi/src/adapter/command-parse.js` — 生产路径在用：kernel decide + 任务准入 + 前台租约检查三处共用 |
| 文件可恢复变更（删除→回收站、写→字节级备份、回执日志、restore） | `pi/src/adapter/fileops.js` FileOpsGuard |
| 长命令→持久任务、审计/溯源、canonical writer 租约 | `host/src/core/jobs.js`、审计链 |
| **累计预算门（可携带自治上限）** | `host/src/core/budget.js` BudgetGovernor：token/cost/calls 上限，append-only 账本（rewind 不可回滚已花费），准入在花钱之前，账本损坏+已配置上限=fail-closed 拒绝 |
| **工作区写互斥锁**（前台×后台写竞争封闭） | `pi/src/adapter/writelease.js` WorkspaceWriteLease：mutating durable job 持锁、心跳续期、退出/恢复释放重取、持不住=拒入+FAILED 可见；前台 mutating 调用在持锁期间被拒（decide 链 `workspace_lease`） |
| 中立宿主协议 HostChannel（~40 命令）+ 多身体 supervisor + 7 态 fail-closed handoff | `host/src/core/channel.js`、`app/server/supervisor.js` |
| host 零依赖、禁 import 身体（防火墙测试机械执行） | `host/tests/firewall.test.js` |

## 逐 harness 矩阵（25 + PI-Desktop）

| Harness | 独特机制（survey §6/§7） | 状态 | 落点 / 理由 |
|---|---|---|---|
| Claude Code | 延迟工具加载(ToolSearch)、~30 hook 事件、6 权限模式+auto 分类器、沙箱 bash 分域 egress、worktree 子 agent、SKILL.md、插件清单 | **同构-同类+拒绝** | SKILL.md 格式已采用（`skills/` 20 包）；权限模式≈riskActions+ask 已采用；**worktree 写竞争已封闭**——用写互斥锁替代整棵 worktree（`writelease.js`，粒度更细：同一 workdir 内前/后台写串行化，读不阻塞）；ToolSearch=**拒绝**（工具面治理完整性优先于 token 节省）；hooks 总线=**拒绝**（用户级任意 shell 回调是绕过 command-parse 分类与写租约的未治理执行面；生命周期通知已由审计事件流覆盖，扩展点走 managed-manifest 装载） |
| Codex CLI | Starlark execpolicy（解析期校验）、Guardian LLM 评审、Seatbelt/seccomp、BM25 tool_search、线程树 spawn | **同构-同类+拒绝** | policy-as-code 已有（JSON+checksum，职责同类实现不同）；Guardian 式 LLM 评审=**拒绝**（治理根必须确定性可证；LLM 评审引入非确定性+每调用延迟/成本，且其唯一有价值方向是宽放——宽放方向恰是错误方向）；OS 沙箱=**拒绝**（进程级隔离属身体/部署层职责，host 中立层不假设 OS 能力；FileOpsGuard 可恢复写+写租约已覆盖其完整性目标）；tool_search=**拒绝**（同 ToolSearch） |
| Gemini CLI | 50% 阈值压缩、图蒸馏、跨平台沙箱、A2A、扩展+slash | **已采用** | 压缩经 pi `session.compact()`+`/compact`+compaction_start/end 事件行；slash 指令菜单已落（14 条真命令） |
| OpenCode | log-as-queue、9 段模糊编辑级联、锚定增量摘要、tree-sitter 权限化、并发子会话 | **已采用** | 事件源会话底=pi session tree；steering 队列已接；**tree-sitter 命令解析=已采用**（`command-parse.js`，三处生产调用） |
| Mistral Vibe | 中间件管道、双层压缩、每消息快照、agent profile | **同构-同类** | 每消息快照≈FileOpsGuard 回执+session tree；中间件≈composite guard 管道 |
| Pi | session tree 可动头、steering/followUp、一切皆扩展、fleets | **已采用**（我们筑在 pi 上） | tree→fork/rewind/entries/stats/export 全接；steer 命令已通；managed-manifest 扩展装载 |
| OpenClaw | 网关+pluggable harness registry、scope 授权、ACP spawn、Active Memory、writer-claim fencing | **同构-同类** | harness registry≈多身体 supervisor；writer fencing≈canonical writer 租约+workspace 写锁；Active Memory=**同构-同类**——`contextEnvelopeExtension` 每回合注入 briefing+openPredictions+observations+memoryDigest（回合前跨会话召回已存在且更强：canonical 状态随 compaction/换身体存活，不是运行时缓存） |
| Hermes | hardline floor 过 --yolo、预算环 stop-guards、lineage 压缩、SQLite 黑板 swarm | **同构-更强+已采用** | 地板≈负能力+canonical attested policy（比 flag 冻结更强：policy 本身是认证对象）；**预算帽=已采用**（BudgetGovernor，见基线表——token/cost/calls 累计上限 + fail-closed 准入 + append-only 账本） |
| Aider | 每模型编辑格式、lint/test 反思环、递归摘要 | **拒绝** | 每模型编辑格式/lint 反思环属身体运行时内部迭代策略——工具输出（含失败/stderr）已回流模型驱动自然迭代；自动 lint 注入是 prompt 工程不是治理机制，且 pi 身体已有自身的编辑格式管理 |
| OpenHands | event-sourced 引擎、可插拔冷凝、agent-server（一切 UI 皆客户端） | **已采用** | HostChannel 即"UI 皆客户端"协议；事件源=pi session tree + host 审计流 |
| Mini-SWE-Agent | 190 行线性环、cost/step 帽、异常即控制流 | **已采用** | 极简环不适合（治理需要管道）；**cost/step 帽已并入 BudgetGovernor**（maxTokensPerSession/maxCostPerSessionUsd/maxCallsPerSession） |
| Goose | 模式格 Auto/Approve/SmartApprove/Chat、LLM 权限法官、goose serve ACP、recipes+hooks | **已采用+拒绝** | 模式格≈riskActions 已采用且本轮补上**会话级模式切换**（`risk_mode` plan/act——kernel modeProvider 把 mutating-capable 调用升级为 ask，只收紧不放松，会话切换自动复位）；recipes=**已采用**（`macro_save/list/delete`+slash 菜单展开，实例级 `macros.json`）；LLM 法官=**拒绝**（同 Codex Guardian）；ACP=**拒绝**（见 Kiro 行） |
| Cline | plan-mode 命令守卫、工具预设(plan/act/minimal/yolo)、hub 守护、refs/checkpoints | **已采用+同构-同类** | checkpoints≈session tree+fileops；**plan/act 模式预设=已采用**——`risk_mode` 会话级模式：plan 下所有 mutating-capable 调用（分类器判 mutating/destructive/exec/network/privilege/unknown + write/edit/delete 工具）升级为操作员 ask，只收紧不放松（deny 不可被模式赦免），chip+`/plan`/`/act`+会话切换复位 |
| Roo Code | fileRegex 工具组权限、Boomerang 委托、shadow-git、Qdrant codebase_search | **同构-同类+拒绝** | fileRegex≈per-tool+path 规则；Boomerang 委托≈delegate_task durable job；向量搜索=**拒绝**（确定性 grep+tree-sitter 命令解析已足覆盖检索面；向量索引引入 embedding 模型依赖+索引同步面+召回不确定性，与"确定性治理"原则冲突） |
| Kimi Code | 权限策略链、tree-sitter bash、DI×scope、KAOS fs/process 抽象、klient SDK | **同构-同类** | 策略链≈composite guard；tree-sitter bash=**已采用**（command-parse.js 与本项同族）；KAOS≈身体抽象 |
| Qwen Code | fail-closed 二级 LLM 分类器、code-mode 工具调用、扩展转换器 | **拒绝** | LLM 分类器=**拒绝**（同 Guardian：非确定性评审不承载安全根）；**code-mode=拒绝**（模型产出代码直接执行 = 绕过 command-parse/写租约/预算门的并行运行时；合法引入须重入统一 tool-call 运行时全套（注册表/schema/权限/批准/审计），成本远超当前收益——不为此开第二执行面） |
| Crush | mvdan/sh 内嵌 shell、StopWhen 压缩、~70 端点 REST+SSE、Catwalk provider DB | **同构-同类+拒绝** | REST+SSE 桥已有（http-bridge）；provider catalog=pi ModelRuntime 已接；内嵌 shell=**拒绝**（引入第二个 shell 解析/执行面与宿主 shell 行为分歧，收益不抵） |
| DSH | Cordis 服务组合、waterfall 拦截缝、mounted 沙箱/审批、tools.guard fail-closed、managed registry+aic diff、jobs registry | **同构-同类**（DSH 是我们的一个身体） | managed composition≈canonical instance 渲染；aic diff≈policy checksum+drift；DSH 有界自治→**已泛化为 host 级 BudgetGovernor**（治理随身体可携带主张的兑现点） |
| Cursor | checkpoints、Shadow Workspace、自有小模型 | **已采用+同构-同类** | checkpoints 经 session tree；Shadow Workspace=**同构-同类**（其目标是"编辑不落地先看效果"的安全预览；FileOpsGuard 写前字节备份+回执 restore 覆盖同等用户安全目标且已被审计链覆盖——可恢复写替代影子预览，方案更轻）；（修订：删除"Cursor 向量索引在退"的表述——无足够证据支撑） |
| Trae | `#` 上下文系统、code index、.md 子 agent、4 级自动运行 | **已采用+拒绝** | `@`/`#` 文件引用=**已采用**（`files_list` workdir 有界遍历 + composer `@` 补全菜单，插入路径由模型经文件工具自取）；code index=**拒绝**（同 Roo 向量索引）；.md 子 agent≈delegate_task |
| Kiro | ACP 单 harness 多 surface、specs(EARS)、deny>ask>allow 能力代数、agent hooks | **同构-更强+拒绝** | deny>ask>allow 序已实现且更强（负能力>ask）；**ACP=拒绝**（身体是 JSONL 进程通道、语义等价；当前无第二个需要互操作的外部方，协议层复杂度无收益——若未来出现外部 surface 可在 adapter 层加 ACP 翻译器，不动 host 契约）；agent hooks=**拒绝**（同 Claude Code hooks：未治理执行面） |
| Devin | VM-per-session、secrets scopes、playbooks/`!macros`、planning mode、`/handoff`、ACU 计量、bubblewrap | **已采用** | `/handoff`=七态 handoff（含治理/租约/会话连续性）；secrets scopes≈`$ENV` 密钥引用+auth.json；ACU 计量≈session_stats+**BudgetGovernor**；**playbooks/宏=已采用**（macro 系统）；planning mode=**已采用**（risk_mode plan）；VM/bubblewrap 沙箱=**拒绝**（同 Codex OS 沙箱：身体/部署层职责） |
| WorkBuddy | 授权目录文件访问、skills 兼容、7×24 云任务、connector 隔离、100+ 专家团 | **同构-同类** | 授权目录≈workdir-scoped 身体+set_workdir；7×24≈durable jobs（本地版）；专家团=**同构-同类**（delegate_task 持久化委派+硬预算下发已覆盖委派原语；预置专家角色属产品内容层，可以 skill 包装载而非 harness 机制） |
| CodeArts | Agent Team、10M 行代码索引、SSO/审计/席位 | **同构-同类+拒绝** | 审计=我们的全链审计（含治理决策链）；企业 SSO/席位=**拒绝**（单用户产品，非企业控制台） |
| ZCode | Goal Mode 证据核验完成、双 scope rewind、`$` skills/`@` refs、4 执行模式 | **已采用+同构-同类** | rewind 已落（navigateTree 会话树）；**双 scope=已采用**——`session_rewind {restoreFiles:true}` 把会话头与文件态绑定回滚：按锚点 entry 时间戳筛选之后的 fileops 回执、从新到旧逐一 restore（`host/src/core/channel.js`）；`@` refs=**已采用**；Goal Mode=**同构-同类**（PredictionStore open→confirmed/refuted 终态转移+bindMutation 绑定溯源=证据核验完成的机制同构；4 执行模式≈risk_mode+riskActions） |
| **PI-Desktop** | 多会话编排 UI、权限模式 chip、Codex 单色视觉、composer 队列、PermissionCard、插件/MCP/Skill 市场 | **已采用+拒绝** | 视觉系统+行级工艺+队列+批准卡全扒（R1–R6）；市场=**拒绝**（扩展走 catalog→provenance→review→admission 的 managed-manifest 治理装载，不做第三方商店） |

## 收敛判定

**评审 REPAIR_AND_READMIT 两个阻塞项已修复：**

1. **PORTABLE_BOUNDED_AUTONOMY** → `host/src/core/budget.js` + `pi/src/adapter/budgetfetch.js` + `pi/bin/delegate-bridge.js`：四层准入——(a) channel 入口 prompt/steer 快拒（UX 层）；(b) **provider 请求级闸门**：`installBudgetFetch` 包裹 globalThis.fetch，pi-ai provider adapter 在请求时解析 fetch（OpenAI client `options.fetch ?? Shims.getDefaultFetch()`、每请求新建 client）→ 覆盖 assistant/compaction/auto-retry/deferred/内部重试，超限请求得合成 402（非重试 4xx → 拒一次即停）+ `BUDGET_PROVIDER_DENY` 审计。**不变量措辞（评审指定）**：获准的 provider transport 必须证明其真实模型请求经 budget-controlled fetch；不经 fetch 的 transport（未来 WebSocket SDK 等）不被本门覆盖、不准入。(c) **计费=真实请求数**：闸门处 record(calls:1)，usage 事件只记 tokens/cost（`countCall:false` 防双计）。(d) **委派硬预算**（评审唯一剩余 blocker）：`delegate_task` 准入三步——父 scope admit → **enforceability 校验**（仅 `pai-channel.js` 子进程可证有请求级硬门：经 `PAI_BUDGET_MAX_*` env 继承上限、自身 fetch 闸门执行；其他 target 在有限预算会话下 spawn 前即拒 `unenforceable_child_budget`）→ **有界分割+原子记账（commit-on-issue）**：子预算=父剩余 `remaining(scope)`，但下发瞬间**全额原子记入父账本**（`tryCommit` 记账→越界自动退负回滚行，进程内同步序列原子，跨进程竞争由"先记后校验"兜住）→ 并发委派与父自身都不可能花到同一份余额（A 提交后 B/父 admit 即见 breach）→ checkpoint 记 `budget_committed`，子进程退出时 PAI_USAGE 归账**跳过已提交份额**（不重复计费）→ spawn 被拒时 `refund` 负行回滚。**不自动退款未用份额**——利用率换无保留/结算协议的简单性，安全方向为过账。最坏总超支=cap+子自身一次请求。**one-call-overshoot 语义已文档化**。append-only 账本使 rewind 不可回滚已花费；账本损坏+已配置上限=fail-closed。真机证据：stub provider + `maxCallsPerSession:1` → req1 admit+bill → 500 触发 pi 自动重试 → **retry 在 fetch 层被拒**（stub 只见 1 个网络请求，重试零出网字节）→ 审计落 `BUDGET_PROVIDER_DENY`+`BUDGET_DENIED` → `budget_status` breach:max_calls。
2. **DURABLE_JOB_WORKSPACE_ISOLATION** → `pi/src/adapter/writelease.js` + jobs.js + decide.js + session.js + channel.js：mutating durable job 必须持工作区写锁（分类器驱动，hasUnknown/parseError 保守按会写处理）、心跳续期、退出释放、恢复重取、持不住=拒入+FAILED 可见；**前台 mutating 调用持锁贯穿真实执行**（decide acquire `fg:<toolCallId>` → afterToolCall composite finally 释放 → `tool_execution_end`/`agent_end` 双兜底扫残余），非"decide 完就放"；**父死子活崩溃哨兵**：recoveryTick 见 worker 活 → `onAlive` 回调——锁仍属该 job 则领养续期直到 worker 死再放，锁被抢则杀孤+`JOB_ORPHAN_KILLED` 审计防无保护写。真机证据：ping-300 job 持锁（pid 活）→ 第二个 mutating job `refused:true` + FAILED 可见 → kill 持锁者 → 锁释放 → 新 job 准入→COMPLETED。

**测试证据**：host 83 / pi 73+1skip / app 10 全绿；budget.test.js(10，含 tryCommit 恰好顶满/超额回滚/refund 语义/重启持久) + writelease.test.js(5) + budgetfetch.test.js(8) + m8-wiring 集成(3) + channel-facade 预算门(1) + composite-guard 前台持锁(3) + ORPHAN DRILL 领养/杀孤(2) + jobs-executor 委派准入(6，含双花防护/committed 不重复归账) + governance plan 模式(3) + channel risk_mode/restoreFiles(2) + supervisor files_list/macro(2)。

**R5 裁决——候选/暂缓清零**（本轮把每个非终态项裁决到 已采用/同构/拒绝）：
- **已采用（新落地）**：plan/act 风险模式预设（Cline/Goose/Devin planning——kernel `modeProvider`+`mutatingTools`，plan 下 mutating-capable 全升级为 ask、只收紧不放松、会话切换复位；UI `/plan`/`/act`+chip）；`@` 文件引用（Trae/ZCode——`files_list` workdir 有界遍历+composer `@` 补全插路径）；宏/recipes/playbooks（Devin/Goose——`macro_save/list/delete`+实例 `macros.json`+slash 展开）；双 scope 回退（ZCode——`session_rewind restoreFiles` 按锚点时间戳把会话头与文件回执绑定回滚）
- **重定级为同构-同类（机制已在，原声称过强或过弱已修正）**：Active Memory=ContextEnvelope 每回合注入 briefing+predictions+observations；Goal Mode=PredictionStore open→confirmed/refuted+bindMutation；Shadow Workspace≈FileOpsGuard 可恢复写；专家团≈delegate_task
- **拒绝（终态，理由见各行）**：LLM 权限评审/分类器（Guardian/Goose法官/Qwen——非确定性不承载安全根）、hooks 总线/agent hooks（未治理任意执行面）、OS 沙箱/VM/bubblewrap（身体/部署层职责，非 host 机制）、ToolSearch/BM25 tool_search（工具面治理完整性优先）、向量代码索引/code index（确定性检索已足+embedding 依赖面）、code-mode（并行运行时=治理绕行面）、ACP（无互操作方，协议复杂度无收益）、内嵌 shell（第二解析面）、插件/扩展第三方商店（managed-manifest 装载替代）、企业 SSO/席位（单用户产品）

## 验收表——26 harness 全终态

| # | Harness | 终态 | 打勾依据 |
|---|---|---|---|
| 1 | Pi | ✅ 已采用 | session tree/steering/事件源/compact 全接（我们筑在 pi 上） |
| 2 | PI-Desktop | ✅ 已采用+拒绝 | 视觉/队列/PermissionCard/行级工艺已扒；市场=拒绝 |
| 3 | Claude Code | ✅ 同构-同类+拒绝 | SKILL.md/权限模式/worktree 封闭采用；ToolSearch/hooks=拒绝 |
| 4 | Codex CLI | ✅ 同构-同类+拒绝 | policy-as-code 同类；LLM 评审/OS 沙箱/tool_search=拒绝 |
| 5 | Gemini CLI | ✅ 已采用 | compact+slash+compaction 事件全接 |
| 6 | OpenCode | ✅ 已采用 | 事件源会话底+steering+tree-sitter 命令解析采用 |
| 7 | Mistral Vibe | ✅ 同构-同类 | 快照≈FileOpsGuard 回执；中间件≈composite guard |
| 8 | OpenClaw | ✅ 同构-同类 | registry/fencing 同类；Active Memory=ContextEnvelope 同类 |
| 9 | Hermes | ✅ 同构-更强+已采用 | 地板<认证 policy；预算帽=BudgetGovernor |
| 10 | Aider | ✅ 拒绝 | 编辑格式/反思环属身体内部迭代策略 |
| 11 | OpenHands | ✅ 已采用 | HostChannel=UI 皆客户端；事件源=session tree |
| 12 | Mini-SWE-Agent | ✅ 已采用 | cost/step 帽并入 BudgetGovernor |
| 13 | Goose | ✅ 已采用+拒绝 | 模式格+risk_mode+recipes 采用；LLM 法官/ACP=拒绝 |
| 14 | Cline | ✅ 已采用 | plan/act 模式预设=risk_mode 落地 |
| 15 | Roo Code | ✅ 同构-同类+拒绝 | fileRegex/委托同类；向量搜索=拒绝 |
| 16 | Kimi Code | ✅ 同构-同类 | 策略链/tree-sitter/KAOS 同类 |
| 17 | Qwen Code | ✅ 拒绝 | LLM 分类器/code-mode 均拒绝 |
| 18 | Crush | ✅ 同构-同类+拒绝 | REST+SSE/provider catalog 同类；内嵌 shell=拒绝 |
| 19 | DSH | ✅ 同构-同类 | DSH 是我们的身体；有界自治已泛化到 host |
| 20 | Cursor | ✅ 已采用+同构-同类 | checkpoints 经 session tree；Shadow Workspace≈可恢复写 |
| 21 | Trae | ✅ 已采用+拒绝 | `@` 引用已落；code index=拒绝 |
| 22 | Kiro | ✅ 同构-更强+拒绝 | deny>ask>allow 已更强；ACP/agent hooks=拒绝 |
| 23 | Devin | ✅ 已采用+拒绝 | handoff/secrets/ACU/宏/planning 采用；VM 沙箱=拒绝 |
| 24 | WorkBuddy | ✅ 同构-同类 | 授权目录/云任务/专家团委派同类 |
| 25 | CodeArts | ✅ 同构-同类+拒绝 | 审计同类；企业 SSO/席位=拒绝 |
| 26 | ZCode | ✅ 已采用+同构-同类 | rewind+restoreFiles 双 scope、`@` 引用采用；Goal Mode=PredictionStore 同类 |

**候选：0 · 暂缓：0 · 悬空项：0** —— 每行均到终态。
