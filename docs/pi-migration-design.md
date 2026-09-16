# Personal AI → Pi 迁移设计

> 状态：实施基线（R5 评审已收敛：裁决"可实施终态，无需复审"，三处修正已并入本文）。目标不是"换一个 harness"，是**把治理/认知/持久化的所有权从租来的宿主收回自有进程**——Pi 只供 loop 引擎。

## 0. 一句话架构

> **Personal AI-owned Pi Host**：Personal AI 持有 `AgentSession`，Pi 是 loop engine；权威守卫走**显式 hook composition**——`createAgentSession()` 之后捕获 Pi 自装的 `agent.beforeToolCall`（即 extension 桥），包一层 composite：extension 改写 → 重校验 → PAI 终审。不是写成一个普通 extension，也**不能直接赋值该槽位**（会覆盖掉 Pi 自己的桥而不是排在它后面）。

### 0.1 Host 代码形态（R6.5 终裁：同级身体 + 反向 composition root）

位置：发布仓顶层两级并列——`host/`（中立控制面）与 `pi/`（Pi 身体）同级，`dsh/` 为旧身体（角色处置见 §4）。裁决理由：DSH 与 Pi 是两个真实可替换身体（非"未来可能有第二个 adapter"），物理所有权边界本身是 invariant-7 的验收对象。

```text
host/                          # 中立控制宿主——全目录零外部依赖
  package.json + lockfile      # 无依赖；lockfile 记录 package identity
  src/
    core/                      # 契约：contracts/instance(fail-closed)/audit/manifest/loaders/governance kernel
    app/                       # createHostCore——中立应用逻辑，被身体 bootstrap 调用并注入 engine
  tests/                       # 契约测试 + 依赖防火墙

pi/                            # Pi 身体实现（与 dsh/ 同级的 harness 专属层）
  package.json + lockfile      # pin @earendil-works/*@0.85.1；lockfile hash 属 runtime identity
  src/
    adapter/                   # Pi API ↔ host 契约：AgentSession 封装、composite guard 安装
    bootstrap/                 # concrete composition root——唯一同时认识 host+pi 的地方
    chord/                     # M5 组合运行时适配（Chord 也是 concrete runtime，不许进 host/）
  extensions/                  # Pi runtime 加载的 managed extension 包（TCB 准入走 manifest）
  bin/                         # pai-host CLI
  tests/                       # pi 侧边界测试 + S0 spike

dsh/                           # legacy DSH 身体；M7 处置由 M5 证据定（见 §4）
```

**依赖方向恒为 `pi → host`，永远不许 `host → pi`**。关键推论：composition root 在 pi/bootstrap 而非 host/app——host 定义"需要什么"（中立 core），pi 定义"怎么满足并把 host 跑起来"。换 X harness 时 host/ 一字节不改。

**五条架构 invariant（依赖防火墙，`tests/firewall.test.js` 机械执行）**：

1. `host/` 全目录不 import 任何具体 harness/身体/部件（`@earendil-works/*`、`pi/`、`dsh/`、Chord 全禁）
2. `pi/` 出域只允许两条路：`../host/`（中立契约）+ `@earendil-works/*`（pin 引擎）
3. `core` 契约测试在无 Pi/Chord 加载条件下通过（fake harness port）
4. managed manifest 是允许进入 TCB 的 extension/resource 唯一准入来源
5. canonical state / instance runtime / source tree 三者路径与写权限物理分离——`instance_root` 解析进 git worktree 时 **fail closed**

**npm 拆包非前提**：目录边界 + 防火墙测试已使 invariant 机械化；待 host 需独立发布/第三身体出现/测试发布周期分离时再拆。**供应链纪律**：npm install script、动态 extension loading、`pi.exec` 均属 TCB/effect surface，进治理清单。

## 1. 验收判据（identity invariants）

换身体成功 = 七条不变量同时成立，不要求 system prompt 逐字节相同：

| # | 不变量 | 验证方式 |
|---|---|---|
| 1 | Soul continuity：消费同一份 canonical soul，不是复制一份 Pi 专用人格 | 同一 soul/ 目录双端读 |
| 2 | State continuity：memory/goal/prediction/job identity 续读续写、重启恢复 | 跨端续跑同一 job |
| 3 | Governance continuity：policy 语义继续 enforce；手改生成块仍判 drift | aic diff 在 Pi 侧同样检出 |
| 4 | Epistemic continuity：consequential mutation 仍须绑定已持久化 prediction | world-model binding 在新缝上复现 |
| 5 | Durability continuity：Pi 进程被杀后零 LLM `recovery_tick` 能恢复 | kill -9 演练 |
| 6 | Provenance continuity：副作用仍绑 actor/run/tool/prediction，否则记 unattributed | 审计 JSONL 同源同构 |
| 7 | Harness-neutrality：换 harness 改的是 adapter，不是 canonical schema/soul/policy 语义 | 本次迁移本身即测试 |

## 2. Pi 缝对照表（0.85.1 已验证签名）

| Personal AI 机制 | DSH 上的缝 | Pi 上的缝 | 备注 |
|---|---|---|---|
| 权威 guard（fail-closed + 审计） | `ctx.tools.guard()` | **capture-and-compose `agent.beforeToolCall`**：`createAgentSession()` 后捕获 `_installAgentToolHooks()` 装好的 extension 桥 → composite 内先跑原桥 → 对改写后 args **重跑 schema 校验** → PAI 终审 → `{block, reason, terminate}` | 已核实：`AgentSession` 占用唯一 `beforeToolCall` 槽位做 extension 桥（`agent-session.js:224`），直接赋值=覆盖桥而非排在后；执行序 `prepareArguments → validateToolArguments → beforeToolCall → execute`（`agent-loop.js:410-449`），extension 改的是**已校验过的** args。**每次新 AgentSession/session 替换后重新 seal 并断言 composite identity** |
| 参数治理/预审 | guard 内 arg 分析 | extension `tool_call` 事件：`event.input` 原地可改（与待执行 `args` **同一对象引用**），加载序 middleware，**改后不重校验** | extension 自身属 TCB——受管 manifest 约束；终审前由 composite 补 post-mutation revalidation |
| 结果治理（diagnostics 回注/软删） | waterfall 后处理 | `tool_result` 事件可改 result；Agent 级 `afterToolCall` 可 override content/isError | LSP diagnostics 回注从这里进 |
| goal 证据化完成判定 | goal-round-driver（loop 外） | **turn 证据评估器 + `shouldStopAfterTurn` + governed continuation queue**：证据不足 → 写结构化缺口 → `agent.steer()` 续跑 → 返回 false；超预算/loop-breaker 触发 → 进受治理终态不再自旋 | `shouldStopAfterTurn` 只能提前停——返回 false 后拉 steering，空则自然退出（`agent-loop.js:154-168`），单独返回 false **不能**强制续跑；续跑必须走 steer 队列，顺带把 loop-breaker 接进同一机制 |
| 预算/loop-breaker | governor 插件 | `beforeToolCall` 计数 + `subscribe` 事件 + `abort()` + `terminate` | 子代理计费可做：subagent 也走同一 Agent hook 链 |
| 压缩治理 | compaction-convergence overlay | `session_before_compact`（可取消/自定义，`reason: manual/threshold/overflow`，`willRetry`） | 事件级 veto 比 overlay 干净 |
| 上下文工程 | pressure-guard preflight | **`context` 事件**（每次 LLM 调用前可改 messages）+ `transformContext`（Agent 级） | preflight admission 的直接对应 |
| 前缀缓存工程 | 不可得（上游黑盒） | **`before_provider_request`/`before_provider_headers`** 可见请求载荷 | 首次可验证缓存边界 |
| 模型切换 | model-switch-controller 插件 | `model_select`/`thinking_level_select` 事件 + `prepareNextTurn` 可换 model/thinkingLevel | 原生缝 |
| steering/中断 | patch + 队列 | `steer()`/`followUp()` 双队列 + QueueMode | 原生 |
| 会话树/fork | in-process subagent_fork | `session_before_fork`/`session_before_tree`（可取消）+ SessionManager 树 | 原生 what-if 分支 |
| 用户输入变换 | — | `input` 事件（action: transform）| 新增能力 |
| 资源发现控制 | — | `resources_discover` 事件 | 控制 AGENTS.md 等注入面 |
| 工作区信任 | — | `project_trust` 事件 | 原生信任门 |
| 工具面收放 | 不可得 | `createAgentSession({tools, excludeTools, customTools, noTools})` + `tool_call` deny→可配合 surface 管理 | deny→工具隐身可实现 |
| 文件变更串行/可逆 | — | `withFileMutationQueue` + 自建 backup/recycle 包装 | 删→回收站可做 |
| 大输出截断 | pruner + restore() | 内建 `truncate`（lines/bytes）+ output-accumulator | 平移 |

来源：`pi-pkg/earendil-works-pi-agent-core-0.85.1/package/dist/agent.d.ts`、`types.d.ts`、`sdk.d.ts`、`extensions/types.d.ts`。

## 3. Cordis 分流（五类判据）

硬判据：**凡代码直接依赖 `ctx.*`、Cordis service injection、`cordisInspect`、DSH profile 路径、DSH 事件序 → 不算"零改动可带"**（算法可留，可移植性已丢）。

| 类 | 判据 | 去向 |
|---|---|---|
| A 纯核 | 不 import DSH/Cordis；I/O 显式；状态在外部 store | 原样带走 |
| B 核+适配 | 逻辑独立但外围用 ctx/Service/Event | 抽核 + 写 adapter |
| C 组合运行时 | 价值在 registry/RPC/replicated state/插件组合 | **优先评估 Chord**（已验证：facets/keyed services/replicated state/remote sources/Go 式 context，独立包不依赖 Pi） |
| D Pi-native | 依赖 tool/session/compaction/turn/provider 语义 | 按 §2 的缝重写 |
| E DSH 补丁 | 只为 DSH 生命周期/loader bug/版本兼容存在 | 删除 |

### 首过插件级判定

**零改动（A）**：durable_jobs 九态机 + recovery_tick + Task Scheduler；aic canonical/checksum/policy 语义；soul/；agent-switchboard 核心。

**自有 9 插件（→ D，换缝重写）**：pressure-guard 三件套（token-meter/agent-loop/tool-result-pruner）→ `context`/`before_provider_request`/`tool_result` 缝；autonomous-execution-governor → Agent 级 `beforeToolCall`+`subscribe`；compaction-convergence → `session_before_compact`；context-lifecycle → context/compact 事件；model-switch-controller → `prepareNextTurn`/`model_select`；workflow-model-preflight-gate → `beforeToolCall`；world-model → 绑定逻辑留，enforcement 移 Agent 缝。

**DSH 内置 42 包**：绝大部分属 E/D（loop/session/tool/llm/approval/compaction 全部 Pi 替代或弃）；少数 A 级候选：`dsh-atomic-write`、`dsh-home-paths`（纯逻辑工具）；`dshmarket`、`dsh-web-frontend`、`dsh-brand`、`dsh-typert-protocol`、`dsh-client-ui-conversation` → E/M6 自建。

**服务级依赖矩阵待产**：迁移第一轮跑脚本扫 `extends Service`/Service key/`inject(` 产出逐服务矩阵（当前只到插件粒度）。

## 4. 里程碑（M0→M7，依赖拓扑）

| 序 | 内容 | 依赖理由 |
|---|---|---|
| M0 冻结基线 | pin Pi 0.85.1（`pi-pkg/` 已取 tarball）；DSH 停新功能；记录 active plugins/config | 防双边漂移 |
| M1 Pi Host 壳 | `createAgentSession` 宿主 + canonical state loader + soul loader + runtime identity + audit writer + 受管 extension manifest + **Host 一等 contract 面**（BodyRegistry/CapabilityContract/DomainLease/HandoffContract/PortableContinuityEnvelope/ProvenanceBoundary，首版 cold handoff） | 一切挂在自有 trust boundary；handoff 是控制面核心生命周期，不等 M4 |
| M2 治理核 | **composite `beforeToolCall`**（原 extension 桥 → post-mutation 重校验 → PAI 终审；每 session 重 seal）+ negative capabilities + generated-policy attestation + prediction-bound mutation + extension TCB 策略 + tree-sitter bash 解析 + hardline 地板 | 先定谁能做什么 |
| M3 loop/认知面 | turn 证据评估器 + `shouldStopAfterTurn` + steer 续跑队列（goal 证据门）+ compaction 治理 + world-model + prediction/observation 生命周期 + context/turn 计费 | 验证能否进入细粒度 loop 缝 |
| M4 持久/编排面 | durable_jobs 接 Pi executor + lease/checkpoint + recovery_tick + switchboard 适配（Pi 无 MCP→扩展/RPC 桥）+ 子代理计费归属 | 依赖 M1/M2 的可靠 identity |
| M5 Cordis 分流 | 逐服务按 §3 五类执行 | 运行时+治理接口已稳 |
| M6 UI/渠道面 | Web/渠道经 RPC/SDK 边界重建 | 不必复制 DSH Web 内核 |
| M7 切换与处置 | Pi 成为选择策略的**默认身体**（当前唯一全能力覆盖，偶然事实非特权）；DSH 默认让位生产写域；恢复演练 + identity invariants 验收；`dsh/` 处置由 M5 证据定 | 默认值可改，角色可重选；禁并发双写同域 |

**身体选择模型（R7+R8 收敛：`Body facts → Task requirements → Eligibility → Selection policy`，不是 `Body identity → 架构预设地位 → 是否允许运行`）**：

- **Body Registry（事实面）**：`body_id / adapter_version / verified_capabilities（按维度：final_post_extension_guard、canonical_prediction_binding、loop_observability、web_ui、channels…）/ governance_coverage / handoff_capabilities / supported_effect_domains / last_verified_at`。DSH=DEGRADED 是逐维能力描述，不是笼统"二等身体"标签。
- **Selector Policy（可变决策面）**：`default_body`（当前=pi，仅因当前全能力覆盖——策略结果非架构特权）+ 任务/身体偏好 + 成本/延迟偏好 + required governance level + fallback 规则。`Primary/Auxiliary/Retired` 是策略状态，不是身体本体属性。
- **Eligibility**：`eligible(body,task) = body.capabilities 满足 task.required_capabilities AND 所有不可协商不变量可成立`。Host 写 `if required_capability not satisfied: reject`，永不写 `if body == DSH: reject`。
- **两类缺失分开处理**：可降级能力（事后计费、粗 observability、UI 差异…）→ 选则标 `DEGRADED` + 审计真实覆盖，合法运行；不可协商正确性不变量（①同域已有 active writer lease ②无法建立 actor/run/body provenance ③契约要求 prediction binding 而路径无法 enforce 且无 Host 外置补足 ④policy drift 无法证明加载版本 ⑤handoff 未完成而身体接管同域 ⑥schema/version 不兼容致不可解释状态）→ **FAIL_CLOSED**，不允许 `DEGRADED_BUT_ALLOWED`。原则：**架构不因"不喜欢某身体"拒绝，只因"具体执行无法保持系统不变量"拒绝**；用户想放宽质量型要求可降低 task contract，但不可借换 selector 解除 correctness invariant。
- **作用域 lease 替代全局独占**：选择身体 = 取得 scoped execution/write lease（scope: task / capability / canonical domain / effect domain）。不同身体可并发运行于不相交域（`Pi→world-model WRITE` ∥ `DSH→channel ACTIVE` ∥ `DSH→world-model READ`），只禁竞写同域。
- **Handoff 是 Host 一等 contract**（M1 起定义，首版 cold handoff）：`prepare → quiesce → checkpoint → release/acquire → resume → verify`。quiesce 停的是**旧 writer authority**（旧 session 可 SUSPENDED/READ_ONLY/ARCHIVED，不必关死）；checkpoint 产出 **Portable Continuity Envelope**（只转移 PAI 自有的 goal identity / canonical cursor / soul+version / open predictions / job cursors / policy identity / provenance chain / 必要 context projection / source body-session-run identity——**不复制 harness 隐藏内部状态**）；release→host 记边界→acquire 顺序不可反（否则双写窗口）；resume 时 **context 翻译是 adapter 责任**，host core 不理解 Pi/DSH session 格式；verify 在新身体首次 mutation 前核 policy/state cursor/provenance parent/writer lease/capability coverage，失败回滚或 BLOCKED。
- **不要求"无损迁移会话"**：验收标准是 `Personal AI-owned continuity survives body change`，不是 `Pi session 内部态 == DSH session 内部态`。

**DSH 终态（R7：三处置由 M5 证据决定，不预判）**：

| 处置 | 条件 | 形态 |
|---|---|---|
| RETIRED | 剩余能力全是 E 类/已有 Pi 等价/维护成本>独有价值 | 删除 `dsh/` |
| AUXILIARY | 有 Pi 给不了的独有外围能力（web UI、渠道等） | 经 Host-defined port 提供能力；不拥有共享 canonical 写权 |
| 可选身体（DEGRADED 标注） | 能力过滤后仍 eligible 的任务类 | 普通候选，与其他身体同规则 |

**invariant-7 验收阶梯**：L1 core 无 harness import → L2 fake adapter contract tests → L3 Pi adapter PASS → L4 DSH adapter 在其声明能力范围内 PASS → L5 同一真实任务跨身体切换且 canonical schema/soul/policy 语义不变 → L6 切换后 state/job/provenance 连续。**写者纪律**：同一 canonical 域同一时刻一个 writer lease owner；handoff 未完成的域新身体不得写。

## 5. 借鉴机制落点（survey → milestone → 缝）

| 机制 | 出处 | 落点 |
|---|---|---|
| goal 完成证据化（文件改动/测试输出才算完） | ZCode Goal Mode | M3：turn 证据评估器 + `shouldStopAfterTurn` + `steer()` 受治理续跑队列 |
| 子代理计入父预算 | Hermes IterationBudget | M4：所有 tool call 走同一 hook 链，按 run identity 归属 |
| bash/pwsh 真解析（含 `$(…)`/子shell） | OpenCode/Kimi tree-sitter | M2：`tool_call` 预审解析命令 AST |
| 静态命令分类（allow/prompt/forbidden） | Codex execpolicy | M2：解析结果喂 policy 引擎 |
| deny→工具从可见面移除 | OpenCode | M2：`excludeTools`/surface 管理配合 deny 记忆 |
| deny→StopTurn（不让模型打转） | Crush | M2：`{block:true, terminate:true}` |
| 结构化错误带修复指引 | Kimi `max_steps_exceeded` | M2：block reason 写"怎么解禁" |
| LSP diagnostics 改后回注 | OpenCode/Crush | M3：`tool_result`/`afterToolCall` 改 result |
| 删除→回收站 + 改前备份 | WorkBuddy | M2：`tool_call` 改写 `write`/`edit` 前先备份 |
| 前缀缓存工程（稳定 system prompt/小时级日期） | OpenClaw/Goose/Hermes | M1：`before_provider_request` 审计 + system-prompt 装配控制 |
| code-mode（模型写 JS 调多工具） | Qwen | M4+：`customTools` 注册 `run_code` |
| 项目级 hooks 不信任（供应链防） | ZCode | M2：`resources_discover`/`project_trust` 缝上拦 |
| 会话树 what-if 分支 | Pi 原生 | 直接获得 |
| 长命令自动转后台+轮询 | Devin/Crush | M4：`tool_call` 改写 bash 调用 → job 化 |
| 流内工具执行 | Roo | 不采用——半边状态风险大于延迟收益 |

## 6. 风险与开放问题

### 6.1 effect surface：三个执行域（Agent guard ≠ complete mediation）

| 执行域 | 例子 | 治理方式 |
|---|---|---|
| 模型工具调用 | bash/edit/write/customTools | extension `tool_call` 预审 → composite 重校验 → PAI 终审 |
| 操作员直接执行 | `!` 前缀命令、RPC `bash` 命令（`rpc-mode.js:441`） | Host command gate；governed 模式下禁用该入口 |
| extension 内部副作用 | `pi.exec()` 起子进程、直接 Node fs/network | **显式无中介 TCB**——靠受管 manifest + attestation + 进程级 containment，tool guard 管不到 |

> 状态声明纪律：任何文档/面板不得把 Agent guard 写成 "complete mediation"——mediation map 上 extension 内副作用标 UNMEDIATED-TCB。

### 6.2 风险

1. **extension=TCB**：`tool_call` 改参不重校验且与执行参数同引用 → composite 补 post-mutation schema validation + 受管 manifest + 加载序约束。
2. **无 OS 沙箱照旧**：Pi 刻意不做进程内沙箱；bash/pwsh 的 OS 兜底（容器/bwrap 等价物）属独立 containment track，不在本设计内但 M2 的命令分类是它的前置。
3. **switchboard 无 MCP**：Pi 无 MCP——委派适配走 RPC/customTools 桥，M4 验证。
4. **Chord 未担保**：同构但语义未逐一对齐（keyed service/replicated state/remote boundary 与 Cordis 的差异在 M5 前做一次 spike）。
5. **DSH 双写窗口**：M5-M6 期间最容易出现两体同写——能力级单写者规则必须在 M1 就立台账。

### 6.3 已核实项与 spike 顺序

已核实（本轮源码）：`session_before_compact` 事件给出 preparation/branchEntries/customInstructions/reason(manual\|threshold\|overflow)/willRetry/signal，handler 可 cancel 或提供完整 `CompactionResult` 替代默认压缩；subagent 官方形态=独立 `pi` 子进程独立 context window（已有 turns/token/cost/context usage tracking）；RPC 面覆盖 prompt/steer/follow-up/model/thinking/compaction/bash/session-tree——SDK 宿主架构下 RPC 非 M1 根依赖，留 M4/M6 验。

| 序 | Spike | 要回答的问题 |
|---|---|---|
| S0（M1 首做） | **Authoritative guard composition** | composite（extension 改写→重校验→PAI 终审）能否稳定形成；builtin/customTools/powershell 是否全覆盖；extension reload / session 替换后 seal 是否仍成立 |
| S1 | **Goal continuation + compaction** | 证据不足能否 steer 强制续跑且受 loop-breaker 控制；compact 在 overflow retry 下能否保住 world-model 不变量 |
| S2 | **Subagent** | 治理/model/soul 如何传播；parent-child provenance、usage/cost、abort 归属 |
| S3 | **RPC surface** | 外部 UI/channel/switchboard 所需命令与事件完整性（M4/M6 前置） |
