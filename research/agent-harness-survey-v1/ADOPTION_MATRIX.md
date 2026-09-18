# ADOPTION_MATRIX.md — 逐 harness 取长补短落地矩阵

> 终态标签（逐项标注到**机制**，不靠行级总状态覆盖多个机制）：
> - **[采用]** — 机制已在 Personal AI 落地，附落点与验证证据
> - **[同类]** — 我们的机制覆盖同等职责但实现不同
> - **[更强]** — 我们的机制在职责相同的前提下覆盖更严
> - **[拒绝]** — 不适合本架构/有安全或边界问题，附理由
> - **[采用-限定]** — 机制的某子集已采用，其余部分显式拒绝
>
> 验收口径：所有 [采用] 必须有代码落点 + 测试或真机冒烟证据；[拒绝] 必须有可复核理由。

## 基线：Personal AI 自有机制（先于本次收敛已存在）

| 机制 | 落点 |
|---|---|
| Policy-as-code + checksum 认证 + 运行中 drift fail-closed | `host/src/core/policy.js` — loadPolicy/assertFresh；policy.json 是规范锚，live session 中修改 → 批次终止 |
| 风险分类（benign/mutating/destructive/network/privilege/exec/unknown）+ 每工具规则 + 负能力（保护根禁写） | `host/src/core/governance.js` lattice：deny > 负能力 > ask > allow |
| 治理 ASK 通路（挂起等操作员，fail-closed 无通道拒绝） | `host/src/core/asks.js` + UI 批准卡；审计 `GOVERNANCE_ASK/RESOLVED/ADMITTED` |
| 会话级风险模式预设（plan/act） | `host/src/core/governance.js` modeProvider：plan 下 mutating-capable 调用全升级为 ask，只收紧不放松，会话切换复位；channel `risk_mode`/`risk_mode_set` + UI `/plan` `/act` + chip |
| **Tree-sitter 命令解析**（语法级，非自制 tokenizer） | `pi/src/adapter/command-parse.js` — 生产路径在用：kernel decide + 任务准入 + 前台租约检查三处共用 |
| 文件可恢复变更（删除→回收站、写→字节级备份、**新建→create tombstone**、回执日志、restore 含 un-create） | `pi/src/adapter/fileops.js` FileOpsGuard |
| 长命令→持久任务、审计/溯源、canonical writer 租约 | `host/src/core/jobs.js`、审计链 |
| **累计预算门（可携带自治上限）** | `host/src/core/budget.js` BudgetGovernor：token/cost/calls 上限，append-only 账本（rewind 不可回滚已花费），准入在花钱之前，账本损坏+已配置上限=fail-closed 拒绝 |
| **工作区写互斥锁**（前台×后台写竞争封闭） | `pi/src/adapter/writelease.js` WorkspaceWriteLease：mutating durable job 持锁、心跳续期、退出/恢复释放重取、持不住=拒入+FAILED 可见；前台 mutating 调用在持锁期间被拒（decide 链 `workspace_lease`） |
| 中立宿主协议 HostChannel（~45 命令）+ 多身体 supervisor + 7 态 fail-closed handoff | `host/src/core/channel.js`、`app/server/supervisor.js` |
| 宏/recipes-lite（name→prompt 模板） | `app/server/supervisor.js` `macro_save/list/delete` → 实例 `macros.json`；slash 菜单展开 |
| `@` 文件路径提及/补全 | `files_list` workdir 有界遍历 + composer `@` 补全菜单 |
| 目标证据核验续跑（Goal 类职责的 backend 能力） | `host/src/core/` ContinuationGovernor + EvidenceRequirement + evaluateEvidence → CONTINUATION_STEER/COMPLETE/BLOCKED；普通 pai-channel 默认未接 taskRequirements |
| host 零依赖、禁 import 身体（防火墙测试机械执行） | `host/tests/firewall.test.js` |

## 逐 harness 矩阵（25 + PI-Desktop，每机制逐项终态）

| Harness | 逐机制终态 |
|---|---|
| Claude Code | SKILL.md **[采用]**（`skills/` 20 包）· 6 权限模式+auto 分类器 **[同类]**（riskActions+ask+risk_mode）· worktree 子 agent **[采用]**（写互斥锁封闭同 workdir 写竞争，粒度更细）· ToolSearch **[拒绝]**（当前工具规模无实测 selection/context 压力，不值得增加动态可见面状态）· hooks 总线 **[拒绝]**（不开放任意 shell 回调 bus——未治理执行面；trusted 生命周期扩展由 managed-manifest+Pi events 提供）· bash 分域 egress **[拒绝]**（网络出口控制属身体/部署层）· 插件清单 **[同类]**（managed-manifest 装载） |
| Codex CLI | Starlark execpolicy **[同类]**（JSON policy+checksum）· Guardian LLM 评审 **[拒绝]**（非确定性评审不承载安全根；deterministic classifier 已覆盖需求，二级 judge 收益未超过延迟/成本/非确定性）· Seatbelt/seccomp **[拒绝]**（host-level sandbox 拒绝——OS 隔离属身体/部署层能力；FileOpsGuard 不声称等价替代 sandbox）· BM25 tool_search **[拒绝]**（同 ToolSearch）· 线程树 spawn **[同类]**（session fork + delegate_task） |
| Gemini CLI | 50% 阈值压缩 **[采用]**（`session.compact()`+`/compact`+compaction_start/end 事件）· 图蒸馏 **[拒绝]**（canonical predictions/observations/briefing 独立于压缩存活，无需蒸馏上下文图；摘要由 compact 承担）· 跨平台沙箱 **[拒绝]**（身体/部署层）· A2A **[拒绝]**（同 ACP 裁决：无第二互操作方；未来仅允许 adapter 层翻译）· extensions+slash **[采用]**（slash 菜单+managed-manifest） |
| OpenCode | log-as-queue **[同类]**（事件源 session tree）· 9 段模糊编辑级联 **[拒绝]**（编辑格式策略属身体内部迭代——pi 自管）· 锚定增量摘要 **[同类]**（`compact(instructions)`+tree 保留）· tree-sitter 权限化 **[采用]**（command-parse.js 三处生产调用）· 并发子会话 **[同类]**（delegate_task 持久化委派） |
| Mistral Vibe | 中间件管道 **[同类]**（composite guard）· 双层压缩 **[同类]**（compact+session tree）· 每消息快照 **[同类]**（fileops 回执+session tree）· agent profile **[同类]**（riskActions/toolPolicy per session） |
| Pi | session tree 可动头 **[采用]**（fork/rewind/entries/stats/export 全接）· steering/followUp **[采用]**（steer 命令）· 一切皆扩展 **[采用-限定]**（managed-manifest 治理装载替代自由扩展）· fleets **[同类]**（多身体 supervisor） |
| OpenClaw | 网关+pluggable harness registry **[同类]**（BodySupervisor）· scope 授权 **[同类]**（riskActions）· ACP spawn **[拒绝]**（同 ACP 裁决）· **Active Memory [拒绝]**——query-conditioned memory retrieval（memory_search/memory_get/active-memory/dreaming）未采用；现有同类项=canonical observations+predictions 每回合重注入（覆盖部分职责但非同一机制；contextProvider 未接 memoryDigest，envelopes render 也无该字段）· writer-claim fencing **[同类]**（canonical writer 租约+workspace 写锁） |
| Hermes | hardline floor 过 --yolo **[更强]**（负能力+canonical attested policy——policy 本身是认证对象）· 预算环 stop-guards **[采用]**（BudgetGovernor）· lineage 压缩 **[同类]**（session tree 保留分支+compact 审计）· SQLite 黑板 swarm **[拒绝]**（共享可变黑板是无治理侧信道；委派协作原语已由 delegate_task+canonical store 覆盖） |
| Aider | 每模型编辑格式 **[拒绝]**（身体内部迭代策略）· lint/test 反思环 **[拒绝]**（工具输出含失败/stderr 已回流驱动自然迭代；自动 lint 注入是 prompt 工程非治理机制）· 递归摘要 **[同类]**（compact） |
| OpenHands | event-sourced 引擎 **[同类]**（session tree+审计流）· 可插拔冷凝 **[同类]**（`compact(instructions)`）· agent-server（UI 皆客户端）**[采用]**（HostChannel） |
| Mini-SWE-Agent | 190 行线性环 **[拒绝]**（治理需要管道）· cost/step 帽 **[采用]**（并入 BudgetGovernor maxTokens/maxCost/maxCalls）· 异常即控制流 **[同类]** |
| Goose | 模式格 Auto/Approve/SmartApprove/Chat **[采用]**（risk_mode+riskActions）· LLM 权限法官 **[拒绝]**（同 Guardian 裁决）· goose serve ACP **[拒绝]**（同 ACP 裁决）· **recipes [拒绝]**——完整 recipe（instructions+parameters+extensions+retry+schema+scheduling）是第二套声明式 execution package；Skills+macro+governed jobs 已覆盖复用层；轻量 name→prompt 部分由 macro 系统吸收 · hooks **[拒绝]**（同 hooks 裁决） |
| Cline | plan-mode 命令守卫 **[采用]**（risk_mode plan：mutating-capable 全升级为 ask、只收紧不放松、无通道 fail-closed、会话切换复位）· 工具预设 plan/act/minimal/yolo **[采用]**（riskActions+risk_mode）· hub 守护 **[同类]**（managed review）· refs/checkpoints **[同类]**（session tree+fileops 回执） |
| Roo Code | fileRegex 工具组权限 **[同类]**（per-tool+path 规则）· Boomerang 委托 **[同类]**（delegate_task durable job）· shadow-git **[拒绝]**（影子 VCS 过重——回滚职责已由 fileops 回执+session tree 覆盖，不引入第二套版本控制）· Qdrant codebase_search **[拒绝]**（向量索引裁决：grep/tree-sitter 无实测 recall 缺口，embedding 依赖+索引同步+召回不确定性不值得） |
| Kimi Code | 权限策略链 **[同类]**（composite guard）· tree-sitter bash **[采用]**（command-parse.js 同族）· DI×scope **[同类]** · KAOS fs/process 抽象 **[同类]**（身体抽象）· klient SDK **[同类]** |
| Qwen Code | fail-closed 二级 LLM 分类器 **[拒绝]**（同 Guardian 裁决）· code-mode **[拒绝]**（模型产出代码直接执行=并行运行时绕分类/租约/预算门；只有重入统一 tool-call runtime 才安全，为 token/批处理收益新建 reentrant executor 当前不划算）· 扩展转换器 **[同类]**（managed-manifest） |
| Crush | mvdan/sh 内嵌 shell **[拒绝]**（第二解析/执行面与宿主 shell 行为分歧）· StopWhen 压缩 **[同类]**（compact）· ~70 端点 REST+SSE **[同类]**（http-bridge）· Catwalk provider DB **[同类]**（pi ModelRuntime catalog） |
| DSH | Cordis 服务组合 **[同类]**（canonical instance 渲染）· waterfall 拦截缝 **[同类]**（composite guard）· mounted 沙箱/审批 **[同类]**（负能力+ask）· tools.guard fail-closed **[同类]** · managed registry+aic diff **[同类]**（policy checksum+drift）· jobs registry **[同类]** · 有界自治 **[采用]**（已泛化为 host BudgetGovernor——治理随身体可携带的兑现点）（DSH 是我们的一个身体） |
| Cursor | checkpoints **[同类]**（session tree+fileops）· Shadow Workspace **[同类]**（目标是"编辑不落地先看效果"的安全预览；FileOpsGuard 写前字节备份+回执 restore 覆盖同等用户安全目标且被审计链覆盖——可恢复写替代影子预览，更轻）· codebase index **[拒绝]**（向量索引裁决）· 自有小模型 tab/apply **[拒绝]**（身体内部模型路由职责，非 host 机制） |
| Trae | `#` 上下文系统 **[采用-限定]**——file-path mention/autocomplete 已采用（`files_list`+composer `@` 补全）；**automatic context attachment 拒绝**（不引入确定性附着 resolver；模型经文件工具自取）· code index **[拒绝]**（向量索引裁决）· `.md` 子 agent **[同类]**（delegate_task）· 4 级自动运行+sandbox beta **[同类]**（riskActions+risk_mode）· trajectory recording **[同类]**（审计流） |
| Kiro | ACP **[拒绝]**（ACP 作为 host canonical protocol 被拒绝——终态架构决定；若未来出现第二互操作方，仅允许 adapter 层翻译器，不动 host 契约）· specs(EARS) **[拒绝]**（spec 流水线是规划内容层职责；"未完成不停"核心已由 ContinuationGovernor+EvidenceRequirement 覆盖，不引入 spec DSL）· deny>ask>allow 能力代数 **[更强]**（负能力>ask）· agent hooks **[拒绝]**（同 hooks 裁决）· Kiro Crew 网关 **[同类]**（supervisor） |
| Devin | VM-per-session **[拒绝]**（身体/部署层）· secrets scopes **[同类]**（`$ENV`+auth.json）· playbooks/`!macros` **[采用]**（macro 系统）· planning mode **[采用]**（risk_mode plan）· `/handoff` **[采用]**（七态 handoff）· ACU 计量 **[同类]**（session_stats+BudgetGovernor）· bubblewrap **[拒绝]**（身体/部署层） |
| WorkBuddy | 授权目录文件访问 **[同类]**（workdir-scoped+set_workdir）· skills 兼容 **[采用]**（`skills/`）· 7×24 云任务 **[同类]**（durable jobs 本地版）· connector 隔离 **[同类]**（managed-manifest 装载边界覆盖第三方集成信任面）· 100+ 专家团 **[同类]**（delegate_task 持久化委派+硬预算下发覆盖委派原语；预置专家角色属内容层，可 skill 包装载） |
| CodeArts | Agent Team **[同类]**（delegate_task+skill 包）· 10M 行代码索引 **[拒绝]**（向量索引裁决）· SSO/席位 **[拒绝]**（单用户产品，非企业控制台）· 审计 **[同类]**（全链审计含治理决策链） |
| ZCode | Goal Mode **[同类]**（ContinuationGovernor+EvidenceRequirement+evaluateEvidence→CONTINUATION_STEER/COMPLETE/BLOCKED=目标证据核验续跑；注意：普通 pai-channel 默认未接 taskRequirements，是已有 backend 能力而非 UI 默认模式；PredictionStore 属世界模型溯源，不作此证据）· 双 scope rewind **[采用]**（`session_rewind {restoreFiles:true}`：anchor entry 时间戳 → **uncapped** 回执扫描（listAll 不受 UI 50 条上限）→ 新到旧逐一 undo——backup/delete 回恢复制、**create/write-无备份 tombstone 回收目标**（锚点后新建文件可删）→ 逐项失败进 `failedFiles`+`partial:true`，不静默宣称成功）· `$` skills **[采用]** · `@` refs **[采用-限定]**（同 Trae）· 4 执行模式 **[同类]**（risk_mode+riskActions） |
| **PI-Desktop** | 多会话编排 UI **[采用]** · 权限模式 chip **[采用]** · Codex 单色视觉 **[采用]** · composer 队列 **[采用]** · PermissionCard **[采用]**（R1–R6 全扒）· 插件/MCP/Skill 市场 **[拒绝]**（catalog→provenance→review→admission managed-manifest 装载替代第三方商店） |

## 收敛判定

**评审 REPAIR_AND_READMIT 两个阻塞项已修复：**

1. **PORTABLE_BOUNDED_AUTONOMY** → `host/src/core/budget.js` + `pi/src/adapter/budgetfetch.js` + `pi/bin/delegate-bridge.js`：四层准入——(a) channel 入口 prompt/steer 快拒（UX 层）；(b) **provider 请求级闸门**：`installBudgetFetch` 包裹 globalThis.fetch，pi-ai provider adapter 在请求时解析 fetch → 覆盖 assistant/compaction/auto-retry/deferred/内部重试，超限请求得合成 402 + `BUDGET_PROVIDER_DENY` 审计。**不变量（评审指定）**：获准的 provider transport 必须证明其真实模型请求经 budget-controlled fetch；不经 fetch 的 transport 不被本门覆盖、不准入。(c) **计费=真实请求数**：闸门处 record(calls:1)，usage 事件只记 tokens/cost（`countCall:false` 防双计）。(d) **委派硬预算**：`delegate_task` 准入三步——父 scope admit → **enforceability 校验**（仅 `pai-channel.js` 子进程可证有请求级硬门：经 `PAI_BUDGET_MAX_*` env 继承上限、自身 fetch 闸门执行；其他 target 在有限预算会话下 spawn 前即拒 `unenforceable_child_budget`）→ **有界分割+原子记账（commit-on-issue）**：子预算=父剩余 `remaining(scope)`，下发瞬间**全额原子记入父账本**（`tryCommit` 记账→越界自动退负回滚行）→ 并发委派与父自身都不可能花到同一份余额 → checkpoint 记 `budget_committed`，子进程退出归账**跳过已提交份额** → spawn 被拒时 `refund` 负行回滚。**不自动退款未用份额**——利用率换无结算协议的简单性，安全方向为过账。
2. **DURABLE_JOB_WORKSPACE_ISOLATION** → `pi/src/adapter/writelease.js` + jobs.js + decide.js + session.js + channel.js：mutating durable job 必须持工作区写锁（分类器驱动，hasUnknown/parseError 保守按会写处理）、心跳续期、退出释放、恢复重取、持不住=拒入+FAILED 可见；**前台 mutating 调用持锁贯穿真实执行**（decide acquire `fg:<toolCallId>` → afterToolCall composite finally 释放 → `tool_execution_end`/`agent_end` 双兜底）；**父死子活崩溃哨兵**：recoveryTick 见 worker 活 → `onAlive` 回调——锁仍属该 job 则领养续期直到 worker 死再放，锁被抢则杀孤+`JOB_ORPHAN_KILLED` 审计。真机证据：ping-300 job 持锁（pid 活）→ 第二个 mutating job `refused:true`+FAILED 可见 → kill 持锁者 → 锁释放 → 新 job 准入→COMPLETED。

**R5→R6 裁决——候选/暂缓清零 + 评审 8 项修复：**

- **已采用（新落地）**：risk_mode 计划模式（kernel modeProvider+mutatingTools；真机实证：cpa luna 实跑，plan 下 write 被拦成批准卡、批准后文件落盘）；`files_list`+`@` 补全；macro CRUD+slash 展开；**双 scope rewind（R6 补齐）**：uncapped 扫描 + create tombstone 使锚点后新建文件可删 + partial/fail 语义
- **评审修正**：Active Memory 降 **[拒绝]**（映射不成立：memoryDigest 未接 contextProvider 也未被 render；现有同类=observations+predictions 每回合重注入）；Goal Mode 改映射到 ContinuationGovernor+EvidenceRequirement（PredictionStore 是世界模型溯源非任务完成验证）；`@` 降 **[采用-限定]**（路径补全已采用，自动 context 附着拒绝）；Goose recipe 降 **[拒绝]**（macro 只对应 Devin-lite 部分）；LLM reviewer/hooks/ToolSearch/vector/code-mode/OS sandbox/ACP 拒绝理由按评审措辞收窄
- **结构修正**：逐机制终态标注（不再以行级总状态覆盖多机制）；SURVEY_REPORT 同步删除 Cursor "retired/pivot" 无据论断

**测试证据**：host 84 / pi 74+1skip / app 10 全绿；含 budget.test.js(13) + writelease.test.js(5) + budgetfetch.test.js(8) + 委派准入(6) + plan 模式(3) + risk_mode/restoreFiles(3) + files_list/macro(2) + FileOpsGuard tombstone/listAll(1) + ORPHAN DRILL(2) + 前台持锁(3)。

## 验收表——26 harness 全终态

| # | Harness | 终态 | 打勾依据 |
|---|---|---|---|
| 1 | Pi | ✅ | session tree/steering/扩展/fleets 逐项标注 |
| 2 | PI-Desktop | ✅ | 视觉/队列/PermissionCard 采用；市场拒绝 |
| 3 | Claude Code | ✅ | SKILL/权限/worktree 采用；ToolSearch/hooks/egress 拒绝 |
| 4 | Codex CLI | ✅ | execpolicy/spawn 同类；Guardian/seccomp/tool_search 拒绝 |
| 5 | Gemini CLI | ✅ | 压缩/slash 采用；图蒸馏/沙箱/A2A 拒绝 |
| 6 | OpenCode | ✅ | tree-sitter 采用；事件源/摘要/子会话同类；编辑级联拒绝 |
| 7 | Mistral Vibe | ✅ | 四项全同类 |
| 8 | OpenClaw | ✅ | registry/fencing/scope 同类；Active Memory/ACP 拒绝 |
| 9 | Hermes | ✅ | 地板更强；预算采用；lineage 同类；黑板拒绝 |
| 10 | Aider | ✅ | 编辑格式/反思环拒绝；递归摘要同类 |
| 11 | OpenHands | ✅ | agent-server 采用；事件源/冷凝同类 |
| 12 | Mini-SWE-Agent | ✅ | cost 帽采用；线性环拒绝 |
| 13 | Goose | ✅ | 模式格采用；法官/ACP/recipes/hooks 拒绝 |
| 14 | Cline | ✅ | plan/act+预设采用；hub/checkpoints 同类 |
| 15 | Roo Code | ✅ | fileRegex/委托同类；shadow-git/向量搜索拒绝 |
| 16 | Kimi Code | ✅ | 策略链/DI/KAOS 同类；tree-sitter 采用 |
| 17 | Qwen Code | ✅ | LLM 分类器/code-mode 拒绝；转换器同类 |
| 18 | Crush | ✅ | REST/provider 同类；内嵌 shell 拒绝 |
| 19 | DSH | ✅ | 全项同类（我们的身体）；有界自治已泛化 |
| 20 | Cursor | ✅ | checkpoints/Shadow 同类；code index/自有模型拒绝 |
| 21 | Trae | ✅ | `@` 采用-限定；code index 拒绝；子agent/自动运行/trajectory 同类 |
| 22 | Kiro | ✅ | 能力代数更强；ACP/EARS/hooks 拒绝；Crew 同类 |
| 23 | Devin | ✅ | handoff/secrets/宏/planning/ACU 采用或同类；VM/bubblewrap 拒绝 |
| 24 | WorkBuddy | ✅ | 授权目录/云任务/connector/专家团同类；skills 采用 |
| 25 | CodeArts | ✅ | Agent Team/审计同类；10M 索引/SSO 拒绝 |
| 26 | ZCode | ✅ | 双 scope rewind 完整采用；Goal Mode 同类（正确映射）；`@` 限定；4 模式同类 |

**候选：0 · 暂缓：0 · 悬空机制：0** —— 逐机制终态，非仅行级。
