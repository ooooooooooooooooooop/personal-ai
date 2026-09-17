# ADOPTION_MATRIX.md — 逐 harness 取长补短落地矩阵

> 状态定义：
> - **已采用** — 机制已在 Personal AI 落地，附落点与验证证据
> - **已有同构** — 我们原有机制已覆盖同等职责（不重复抄）
> - **候选** — 值得做但未做，附理由与预计落点
> - **拒绝** — 不适合本架构/有安全或边界问题，附理由
>
> 验收口径：所有"已采用"必须有代码落点 + 测试或真机冒烟证据；候选必须有明确取舍理由。

## 基线：Personal AI 自有机制（先于本次收敛已存在）

| 机制 | 落点 |
|---|---|
| Policy-as-code + checksum 认证 + 运行中 drift fail-closed | `host/src/core/policy.js` — loadPolicy/assertFresh；policy.json 是规范锚，live session 中修改 → 批次终止 |
| 风险分类（benign/mutating/destructive/network/privilege/exec/unknown）+ 每工具规则 + 负能力（保护根禁写） | `host/src/core/governance.js` lattice：deny > 负能力 > ask > allow |
| 治理 ASK 通路（挂起等操作员，fail-closed 无通道拒绝） | `host/src/core/asks.js` + UI 批准卡；审计 `GOVERNANCE_ASK/RESOLVED/ADMITTED` |
| 文件可恢复变更（删除→回收站、写→字节级备份、回执日志、restore） | `pi/src/adapter/fileops.js` FileOpsGuard |
| 长命令→持久任务、审计/溯源、canonical writer 租约 | `host/src/jobs/*`、审计链 |
| 中立宿主协议 HostChannel（~38 命令）+ 多身体 supervisor + 7 态 fail-closed handoff | `host/src/core/channel.js`、`app/server/supervisor.js` |
| host 零依赖、禁 import 身体（防火墙测试机械执行） | `host/tests/firewall.test.js` |

## 逐 harness 矩阵（25 + PI-Desktop）

| Harness | 独特机制（survey §6/§7） | 状态 | 落点 / 理由 |
|---|---|---|---|
| Claude Code | 延迟工具加载(ToolSearch)、~30 hook 事件、6 权限模式+auto 分类器、沙箱 bash 分域 egress、worktree 子 agent、SKILL.md、插件清单 | **已有同构+候选** | SKILL.md 格式已采用（`skills/` 20 包）；权限模式≈riskActions+ask 已采用；ToolSearch 延迟加载、hooks 总线 = **候选**（R7）；worktree 隔离=候选（delegate 目前共享 workdir） |
| Codex CLI | Starlark execpolicy（解析期校验）、Guardian LLM 评审、Seatbelt/seccomp、BM25 tool_search、线程树 spawn | **已有同构+候选** | policy-as-code 已有（JSON+checksum，非 Starlark）；Guardian 式 LLM 分类器=**候选**（当前分类器是语法解析——静态、确定性、fail-closed，LLM 评审可作第二层）；OS 沙箱=候选（当前治理在工具层，进程级沙箱属身体职责） |
| Gemini CLI | 50% 阈值压缩、图蒸馏、跨平台沙箱、A2A、扩展+slash | **已采用** | 压缩经 pi `session.compact()`+`/compact`+compaction_start/end 事件行；slash 指令菜单已落（10 条真命令） |
| OpenCode | log-as-queue、9 段模糊编辑级联、锚定增量摘要、tree-sitter 权限化、并发子会话 | **已采用+候选** | 事件源会话底=pi session tree（fork/rewind/resume 全免费）；steering 队列已接；tree-sitter 命令解析=**候选**（现有解析器是自制 tokenizer，树级精度更高但增量价值中等） |
| Mistral Vibe | 中间件管道、双层压缩、每消息快照、agent profile | **已有同构** | 每消息快照≈FileOpsGuard 回执+session tree；中间件≈composite guard 管道 |
| Pi | session tree 可动头、steering/followUp、一切皆扩展、fleets | **已采用**（我们筑在 pi 上） | tree→fork/rewind/entries/stats/export 全接；steer 命令已通；managed-manifest 扩展装载 |
| OpenClaw | 网关+pluggable harness registry、scope 授权、ACP spawn、Active Memory、writer-claim fencing | **已有同构+候选** | harness registry≈多身体 supervisor；writer fencing≈canonical writer 租约（commit 事务内核验）；Active Memory=**候选**（跨会话召回，接 host world-model 层） |
| Hermes | hardline floor 过 --yolo、预算环 stop-guards、lineage 压缩、SQLite 黑板 swarm | **已有同构+候选** | 地板≈负能力+canonical policy（运行时不可关闭，比"flag 冻结"更强：policy 本身就是 attested）；预算/步数帽=**候选**（kernel 有 turn 计数，缺显式预算上限） |
| Aider | 每模型编辑格式、lint/test 反思环、递归摘要 | **候选** | 编辑策略属身体内部；lint/test 反思=候选（低成本高价值：`run` 后可接 lint 提示） |
| OpenHands | event-sourced 引擎、可插拔冷凝、agent-server（一切 UI 皆客户端） | **已采用** | HostChannel 即"UI 皆客户端"协议；事件源=pi session tree + host 审计流 |
| Mini-SWE-Agent | 190 行线性环、cost/step 帽、异常即控制流 | **候选** | 极简环不适合我们（治理需要管道）；cost/step 帽并入 Hermes 预算项 |
| Goose | 模式格 Auto/Approve/SmartApprove/Chat、LLM 权限法官、goose serve ACP、recipes+hooks | **已采用+候选** | 模式格≈riskActions（deny/ask/allow 已可视化在治理姿态卡）；LLM 法官=同 Guardian 候选；recipes=**候选**（slash 宏的下一步：可命名命令序列） |
| Cline | plan-mode 命令守卫、工具预设(plan/act/minimal/yolo)、hub 守护、refs/checkpoints | **已有同构+候选** | checkpoints≈session tree+fileops（已完成）；工具预设/计划模式=**候选**（映射到 policy 预设集，当前只有单 policy） |
| Roo Code | fileRegex 工具组权限、Boomerang 委托、shadow-git、Qdrant codebase_search | **已有同构+候选** | fileRegex≈我们 per-tool+path 规则（policy toolPolicy 有 path 粒度）；向量搜索=**拒绝**（survey §7.1：终端 harness 收敛到确定性 grep，Cursor 自己都在退） |
| Kimi Code | 权限策略链、tree-sitter bash、DI×scope、KAOS fs/process 抽象、klient SDK | **已有同构** | 策略链≈composite guard；KAOS≈身体抽象（我们的答案更彻底：host 中立 + 身体可换） |
| Qwen Code | fail-closed 二级 LLM 分类器、code-mode 工具调用、扩展转换器 | **候选** | LLM 分类器与 Guardian 并项；code-mode（模型写 JS 调 tools）=候选（V8 代码调用省 token 但绕开静态分类，治理上要重新设计准入） |
| Crush | mvdan/sh 内嵌 shell、StopWhen 压缩、~70 端点 REST+SSE、Catwalk provider DB | **已有同构** | REST+SSE 桥已有（http-bridge）；provider catalog=pi ModelRuntime 已接；内嵌 shell=候选（可替代性收益低） |
| DSH | Cordis 服务组合、waterfall 拦截缝、mounted 沙箱/审批、tools.guard fail-closed、managed registry+aic diff、jobs registry | **已有同构**（DSH 是我们的一个身体） | managed composition≈我们的 canonical instance 渲染；aic diff≈policy checksum+drift |
| Cursor | checkpoints、Shadow Workspace、自有小模型 | **已采用** | checkpoints 经 session tree；Shadow Workspace=候选（预览编辑，非必须） |
| Trae | `#` 上下文系统、code index、.md 子 agent、4 级自动运行 | **候选** | `@`/`#` 文件引用=候选（composer @ 菜单读 workdir 文件清单，UX 价值实在）；code index=同 Roo 拒绝 |
| Kiro | ACP 单 harness 多 surface、specs(EARS)、deny>ask>allow 能力代数、agent hooks | **已有同构+候选** | deny>ask>allow 序=我们 lattice 已实现且更强（负能力>ask）；ACP=**候选**（身体是 JSONL 进程通道，语义等价 ACP；引 ACP 标准可获生态互操作，但增协议层复杂度） |
| Devin | VM-per-session、secrets scopes、playbooks/`!macros`、planning mode、`/handoff`、ACU 计量、bubblewrap | **已采用+候选** | `/handoff`=我们七态 handoff（比 diff cap 版更强：含治理/租约/会话连续性）；secrets scopes≈`$ENV` 密钥引用+auth.json；ACU 计量≈session_stats 真账已接 UI；playbooks/宏=**候选**（slash 宏）；VM/沙箱=身体层职责 |
| WorkBuddy | 授权目录文件访问、skills 兼容、7×24 云任务、connector 隔离、100+ 专家团 | **已有同构** | 授权目录≈workdir-scoped 身体+set_workdir；7×24≈durable jobs（本地版）；专家团=候选（delegate_task 已具雏形） |
| CodeArts | Agent Team、10M 行代码索引、SSO/审计/席位 | **已有同构+拒绝** | 审计=我们的全链审计（更强：含治理决策链）；企业 SSO/席位=**拒绝**（单用户产品，非企业控制台） |
| ZCode | Goal Mode 证据核验完成、双 scope rewind、`$` skills/`@` refs、4 执行模式 | **已采用+候选** | rewind 已落（navigateTree 单 scope，双 scope 差异=文件态回滚——FileOpsGuard restore 已覆盖文件侧）；Goal Mode=**候选**（证据核验完成≈我们 prediction binding 的扩展） |
| **PI-Desktop** | 多会话编排 UI、权限模式 chip、Codex 单色视觉、composer 队列、PermissionCard、插件/MCP/Skill 市场 | **已采用+拒绝** | 视觉系统+行级工艺+队列+批准卡全扒（R1–R6）；市场=**拒绝**（我们的扩展是 managed-manifest 治理装载，不做第三方商店——边界问题） |

## 收敛判定（待网页 GPT 验收）

**本轮实质新增**（`965afda`）：session_compact / session_entries / session_rewind / session_stats / session_export / fileops_list / fileops_restore / policy_status 八命令 + UI 全接（`/compact` `/rewind` `/export` `/restore` slash、compaction/auto-retry/session-info 事件行、真实统计 chip、治理姿态卡）。

**真机证据**：entries 出锚点（entryId+text）→ rewind 返 editorText 且 head 移动（history 0 = 正确定义）→ stats 真账（2u/4a/2tool）→ export 落 HTML 文件 → policy_status 返 riskActions+checksum。

**诚实声明的候选**（未做，附理由）：LLM 权限分类器（第二层评审）、tree-sitter 命令解析、hooks 总线、ToolSearch 延迟加载、plan/act 工具预设、worktree 子 agent 隔离、`@` 文件引用、recipes/宏、预算帽、Active Memory 跨会话召回、ACP 标准化。
**诚实声明的拒绝**：向量代码索引、插件市场、企业 SSO/席位、第三方扩展商店、code-mode（绕开静态分类需重设计）。
