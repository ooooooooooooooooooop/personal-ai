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
| Claude Code | 延迟工具加载(ToolSearch)、~30 hook 事件、6 权限模式+auto 分类器、沙箱 bash 分域 egress、worktree 子 agent、SKILL.md、插件清单 | **同构-同类+候选+拒绝** | SKILL.md 格式已采用（`skills/` 20 包）；权限模式≈riskActions+ask 已采用；**worktree 写竞争已封闭**——用写互斥锁替代整棵 worktree（`writelease.js`，粒度更细：同一 workdir 内前/后台写串行化，读不阻塞）；ToolSearch=**拒绝**（工具面治理完整性优先于 token 节省）；hooks 总线 = 候选 |
| Codex CLI | Starlark execpolicy（解析期校验）、Guardian LLM 评审、Seatbelt/seccomp、BM25 tool_search、线程树 spawn | **同构-同类+候选** | policy-as-code 已有（JSON+checksum，职责同类实现不同）；Guardian 式 LLM 评审=**候选**（只能作第二层——治理根必须是确定性规则，LLM 评审不承载安全）；OS 沙箱=候选（进程级沙箱属身体职责，host 不假设 OS 能力） |
| Gemini CLI | 50% 阈值压缩、图蒸馏、跨平台沙箱、A2A、扩展+slash | **已采用** | 压缩经 pi `session.compact()`+`/compact`+compaction_start/end 事件行；slash 指令菜单已落（14 条真命令） |
| OpenCode | log-as-queue、9 段模糊编辑级联、锚定增量摘要、tree-sitter 权限化、并发子会话 | **已采用** | 事件源会话底=pi session tree；steering 队列已接；**tree-sitter 命令解析=已采用**（`command-parse.js`，三处生产调用） |
| Mistral Vibe | 中间件管道、双层压缩、每消息快照、agent profile | **同构-同类** | 每消息快照≈FileOpsGuard 回执+session tree；中间件≈composite guard 管道 |
| Pi | session tree 可动头、steering/followUp、一切皆扩展、fleets | **已采用**（我们筑在 pi 上） | tree→fork/rewind/entries/stats/export 全接；steer 命令已通；managed-manifest 扩展装载 |
| OpenClaw | 网关+pluggable harness registry、scope 授权、ACP spawn、Active Memory、writer-claim fencing | **同构-同类+候选** | harness registry≈多身体 supervisor；writer fencing≈canonical writer 租约+新增 workspace 写锁；Active Memory=**候选**（重新定性：可能的"回合前跨会话主动召回"能力，接 host world-model 层，非运行时记忆替代） |
| Hermes | hardline floor 过 --yolo、预算环 stop-guards、lineage 压缩、SQLite 黑板 swarm | **同构-更强+已采用** | 地板≈负能力+canonical attested policy（比 flag 冻结更强：policy 本身是认证对象）；**预算帽=已采用**（BudgetGovernor，见基线表——token/cost/calls 累计上限 + fail-closed 准入 + append-only 账本） |
| Aider | 每模型编辑格式、lint/test 反思环、递归摘要 | **候选** | 编辑策略属身体内部；lint/test 反思=候选（低成本高价值：`run` 后可接 lint 提示） |
| OpenHands | event-sourced 引擎、可插拔冷凝、agent-server（一切 UI 皆客户端） | **已采用** | HostChannel 即"UI 皆客户端"协议；事件源=pi session tree + host 审计流 |
| Mini-SWE-Agent | 190 行线性环、cost/step 帽、异常即控制流 | **已采用** | 极简环不适合（治理需要管道）；**cost/step 帽已并入 BudgetGovernor**（maxTokensPerSession/maxCostPerSessionUsd/maxCallsPerSession） |
| Goose | 模式格 Auto/Approve/SmartApprove/Chat、LLM 权限法官、goose serve ACP、recipes+hooks | **已采用+候选+暂缓** | 模式格≈riskActions（deny/ask/allow 可视化）；LLM 法官=候选（同 Guardian）；recipes=候选；**ACP=暂缓**（见 Kiro 行） |
| Cline | plan-mode 命令守卫、工具预设(plan/act/minimal/yolo)、hub 守护、refs/checkpoints | **同构-同类+候选** | checkpoints≈session tree+fileops；工具预设/计划模式=候选（映射到 policy 预设集，当前只有单 policy） |
| Roo Code | fileRegex 工具组权限、Boomerang 委托、shadow-git、Qdrant codebase_search | **同构-同类+暂缓** | fileRegex≈per-tool+path 规则；向量搜索=**暂缓**（当前确定性 grep 够用；触发复评条件：实测召回/延迟不达标） |
| Kimi Code | 权限策略链、tree-sitter bash、DI×scope、KAOS fs/process 抽象、klient SDK | **同构-同类** | 策略链≈composite guard；tree-sitter bash=**已采用**（command-parse.js 与本项同族）；KAOS≈身体抽象 |
| Qwen Code | fail-closed 二级 LLM 分类器、code-mode 工具调用、扩展转换器 | **候选+暂缓** | LLM 分类器与 Guardian 并项；**code-mode=暂缓**（修订理由：code mode 不是天然绕过治理——但若引入必须重入统一 tool-call 运行时：注册表、schema、权限、批准、hooks、执行路径缺一不可，否则才是治理绕行；当前收益不足以覆盖重设计成本） |
| Crush | mvdan/sh 内嵌 shell、StopWhen 压缩、~70 端点 REST+SSE、Catwalk provider DB | **同构-同类** | REST+SSE 桥已有（http-bridge）；provider catalog=pi ModelRuntime 已接；内嵌 shell=候选（可替代性收益低） |
| DSH | Cordis 服务组合、waterfall 拦截缝、mounted 沙箱/审批、tools.guard fail-closed、managed registry+aic diff、jobs registry | **同构-同类**（DSH 是我们的一个身体） | managed composition≈canonical instance 渲染；aic diff≈policy checksum+drift；DSH 有界自治→**已泛化为 host 级 BudgetGovernor**（治理随身体可携带主张的兑现点） |
| Cursor | checkpoints、Shadow Workspace、自有小模型 | **已采用+候选** | checkpoints 经 session tree；Shadow Workspace=候选（预览编辑，非必须）；（修订：删除"Cursor 向量索引在退"的表述——无足够证据支撑） |
| Trae | `#` 上下文系统、code index、.md 子 agent、4 级自动运行 | **候选+暂缓** | `@`/`#` 文件引用=**暂缓**（UX 价值实在但当前无阻塞需求；触发复评条件：composer 输入体验实测不足）；code index=同 Roo 暂缓 |
| Kiro | ACP 单 harness 多 surface、specs(EARS)、deny>ask>allow 能力代数、agent hooks | **同构-更强+暂缓** | deny>ask>allow 序已实现且更强（负能力>ask）；**ACP=暂缓**（已评估：身体是 JSONL 进程通道，语义等价 ACP；引标准可获生态互操作但增协议层复杂度——当前无第二个需要 ACP 互操作的外部方，复评触发：出现需接入的第三方 surface） |
| Devin | VM-per-session、secrets scopes、playbooks/`!macros`、planning mode、`/handoff`、ACU 计量、bubblewrap | **已采用+候选** | `/handoff`=七态 handoff（含治理/租约/会话连续性）；secrets scopes≈`$ENV` 密钥引用+auth.json；ACU 计量≈session_stats+**BudgetGovernor**；playbooks/宏=候选；VM/沙箱=身体层职责 |
| WorkBuddy | 授权目录文件访问、skills 兼容、7×24 云任务、connector 隔离、100+ 专家团 | **同构-同类** | 授权目录≈workdir-scoped 身体+set_workdir；7×24≈durable jobs（本地版）；专家团=候选（delegate_task 已具雏形） |
| CodeArts | Agent Team、10M 行代码索引、SSO/审计/席位 | **同构-同类+拒绝** | 审计=我们的全链审计（含治理决策链）；企业 SSO/席位=**拒绝**（单用户产品，非企业控制台） |
| ZCode | Goal Mode 证据核验完成、双 scope rewind、`$` skills/`@` refs、4 执行模式 | **已采用(部分同构)+候选** | rewind 已落（navigateTree 会话树单 scope）；**双 scope 差异诚实标注：文件态回滚侧只有 FileOpsGuard 按回执 restore——无"回合→回执"原子绑定，故只是 partial analogue 而非等价实现**；Goal Mode=候选（prediction binding 的扩展方向） |
| **PI-Desktop** | 多会话编排 UI、权限模式 chip、Codex 单色视觉、composer 队列、PermissionCard、插件/MCP/Skill 市场 | **已采用+拒绝** | 视觉系统+行级工艺+队列+批准卡全扒（R1–R6）；市场=**拒绝**（扩展走 catalog→provenance→review→admission 的 managed-manifest 治理装载，不做第三方商店） |

## 收敛判定

**评审 REPAIR_AND_READMIT 两个阻塞项已修复：**

1. **PORTABLE_BOUNDED_AUTONOMY** → `host/src/core/budget.js` + `pi/src/adapter/budgetfetch.js` + `pi/bin/delegate-bridge.js`：四层准入——(a) channel 入口 prompt/steer 快拒（UX 层）；(b) **provider 请求级闸门**：`installBudgetFetch` 包裹 globalThis.fetch，pi-ai provider adapter 在请求时解析 fetch（OpenAI client `options.fetch ?? Shims.getDefaultFetch()`、每请求新建 client）→ 覆盖 assistant/compaction/auto-retry/deferred/内部重试，超限请求得合成 402（非重试 4xx → 拒一次即停）+ `BUDGET_PROVIDER_DENY` 审计。**不变量措辞（评审指定）**：获准的 provider transport 必须证明其真实模型请求经 budget-controlled fetch；不经 fetch 的 transport（未来 WebSocket SDK 等）不被本门覆盖、不准入。(c) **计费=真实请求数**：闸门处 record(calls:1)，usage 事件只记 tokens/cost（`countCall:false` 防双计）。(d) **委派硬预算**（评审唯一剩余 blocker）：`delegate_task` 准入三步——父 scope admit → **enforceability 校验**（仅 `pai-channel.js` 子进程可证有请求级硬门：经 `PAI_BUDGET_MAX_*` env 继承上限、自身 fetch 闸门执行；其他 target 在有限预算会话下 spawn 前即拒 `unenforceable_child_budget`）→ **有界分割+原子记账（commit-on-issue）**：子预算=父剩余 `remaining(scope)`，但下发瞬间**全额原子记入父账本**（`tryCommit` 记账→越界自动退负回滚行，进程内同步序列原子，跨进程竞争由"先记后校验"兜住）→ 并发委派与父自身都不可能花到同一份余额（A 提交后 B/父 admit 即见 breach）→ checkpoint 记 `budget_committed`，子进程退出时 PAI_USAGE 归账**跳过已提交份额**（不重复计费）→ spawn 被拒时 `refund` 负行回滚。**不自动退款未用份额**——利用率换无保留/结算协议的简单性，安全方向为过账。最坏总超支=cap+子自身一次请求。**one-call-overshoot 语义已文档化**。append-only 账本使 rewind 不可回滚已花费；账本损坏+已配置上限=fail-closed。真机证据：stub provider + `maxCallsPerSession:1` → req1 admit+bill → 500 触发 pi 自动重试 → **retry 在 fetch 层被拒**（stub 只见 1 个网络请求，重试零出网字节）→ 审计落 `BUDGET_PROVIDER_DENY`+`BUDGET_DENIED` → `budget_status` breach:max_calls。
2. **DURABLE_JOB_WORKSPACE_ISOLATION** → `pi/src/adapter/writelease.js` + jobs.js + decide.js + session.js + channel.js：mutating durable job 必须持工作区写锁（分类器驱动，hasUnknown/parseError 保守按会写处理）、心跳续期、退出释放、恢复重取、持不住=拒入+FAILED 可见；**前台 mutating 调用持锁贯穿真实执行**（decide acquire `fg:<toolCallId>` → afterToolCall composite finally 释放 → `tool_execution_end`/`agent_end` 双兜底扫残余），非"decide 完就放"；**父死子活崩溃哨兵**：recoveryTick 见 worker 活 → `onAlive` 回调——锁仍属该 job 则领养续期直到 worker 死再放，锁被抢则杀孤+`JOB_ORPHAN_KILLED` 审计防无保护写。真机证据：ping-300 job 持锁（pid 活）→ 第二个 mutating job `refused:true` + FAILED 可见 → kill 持锁者 → 锁释放 → 新 job 准入→COMPLETED。

**测试证据**：host 78 / pi 73+1skip / app 8 全绿；新增 budget.test.js(10，含 tryCommit 恰好顶满/超额回滚/refund 语义/重启持久) + writelease.test.js(5) + budgetfetch.test.js(8) + m8-wiring 集成(3) + channel-facade 预算门(1) + composite-guard 前台持锁(3) + ORPHAN DRILL 领养/杀孤(2) + jobs-executor 委派准入(6，含双花防护/committed 不重复归账)。

**诚实声明的候选**（未做，附理由）：LLM 权限分类器（第二层评审，不承载安全根）、hooks 总线、plan/act 工具预设、`@` 文件引用、recipes/宏、Active Memory（回合前跨会话主动召回）、Shadow Workspace、Goal Mode、内嵌 shell、专家团/Agent Team。
**诚实声明的暂缓**（已评估，附复评触发条件）：ACP（无第二个需互操作的外部方）、code-mode（必须重入统一 tool-call 运行时才不是绕行，当前收益不抵重设计成本）、向量代码索引（确定性 grep 够用，待实测不达标复评）、ToolSearch（工具面治理完整性优先）。
**诚实声明的拒绝**：插件/扩展第三方商店（catalog→provenance→review→admission 治理装载替代）、企业 SSO/席位（单用户产品）。
