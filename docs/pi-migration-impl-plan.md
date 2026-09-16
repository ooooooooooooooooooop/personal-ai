# Pi 迁移实施计划（M0→M7 落地版）

配套文档：`pi-migration-design.md`（架构裁决与不变量）。本文是**文件级施工单**——每个里程碑列要建/改的文件、要过的测试、出口标准。

## 0. 施工原则

1. **契约先行**：每个 milestone 先在 `host/src/core/` 落 contract（plain-data 类型 + 接口函数），adapter 在 `pi/src/adapter/` 翻译引擎对象。host 永不 import pi。
2. **无模型可测**：`SessionManager.inMemory()` + 手动调 `agent.beforeToolCall`/`steer` 缝——M0–M2 全部测试不碰真模型 API。真模型冒烟留到 M3 之后单独跑。
3. **每个里程碑的出口 = 测试绿 + 可复核证据**，不是"代码写完"。
4. **spike 不是里程碑**：S0/S-chord/S-rpc 是降低不确定性的探针，进对应里程碑前先跑。
5. 依赖只加 pin 版；新依赖进对应 package.json，lockfile 更新属 runtime identity。

## S0 — composite guard spike（当前，先行探针）

**目的**：在真 `AgentSession` 上证明 `pi/src/adapter/session.js::installCompositeGuard` 的链序假设，不用 mock。

文件：`pi/tests/spike-composite-guard.test.js`

步骤：
1. `createAgentSession({ cwd: <tmp>, agentDir: <tmp>, sessionManager: SessionManager.inMemory(), customTools: [echoTool], tools: [...] })`——model 缺省时若构造失败则传 stub `Model`（d.ts 里 Model 是数据接口，构造期不应调用）。
2. **mutating extension（R9 定案）**：走真实路径——`DefaultResourceLoader({ extensionFactories: [mutator] })`（Pi 0.85.1 官方支持 inline factories，reload 时会加载），不造旁路注入。extension 注册 `tool_call` 处理器，原地改写 `event.input`。
3. 装 composite：`installCompositeGuard(session.agent, { revalidate: <记录调用>, decide: <记录调用> })`。
4. 手动调 `session.agent.beforeToolCall(ctx, signal)`（构造最小 ctx：toolCall/args/assistantMessage/context），断言：
   - extension 改写先于 revalidate 被观察到（改写后的值进 revalidate）；
   - extension 改成**非法参数**时 composite 返回 `{block:true, reason: 'post-mutation schema violation: …'}`；
   - revalidate 过了才进 decide；decide 返回 block 时直通；
   - decide 抛错 → composite 放行还是 fail-closed（**设计决定：decide 异常 = block，记审计**——写进测试）；
   - **（R9 新增）normalized args 回写**：`validateToolArguments` 会 structuredClone→normalize→返回**新对象**而非改原 `event.input`——composite 必须把 validated normalized args 回写到实际执行 args，decide 观察的必须是"真正即将执行"的对象。S0 就要测"改后 normalization 发生且回写生效"（例：字符串 `"1"` 被规范成数字 `1` 时，decide 看到的是 `1`）。
5. 覆盖面：内建 `powershell`、`customTools` 注册的 echo tool、另一个内建（如 `read`）——同一 ctx 形状跑三遍。
6. **seal 检查**：`guard.sealed()` true；模拟"extension reload"（把 `agent.beforeToolCall` 换掉再调 `installCompositeGuard`）后 sealed 仍 true 且链序不变；**新 session 必须重新 install**，旧 guard 句柄对新 session 无效——测试断言。

出口：spike 测试全绿 + 结果写进 `.taskflow/s0-results.md`（含 ctx 真实字段形状——回填 `contracts.js` 的 `ToolCallContext` 注释）。**边界**：inMemory 只用于 S0 缝验证；M1 的 lease/audit/handoff 必须跑真实临时磁盘 + 重启 + 多进程竞争，不许"全是内存测试"。

## M1 — Host 壳 + 一等 contract 面

| 文件 | 内容 |
|---|---|
| `host/src/core/registry.js` | **BodyRegistry**：注册/查询身体事实（body_id, adapter_version, verified_capabilities 逐维, governance_coverage, handoff_capabilities, supported_effect_domains, last_verified_at）。持久化到 `<instance>/registry.json`。 |
| `host/src/core/lease.js` | **DomainLease 台账**（R9 blocker）：scoped write/effect lease，语义必须冻结为 `claim(domain,owner,generation)`/`renew`/`release`/`takeover_expired`——**原子 CAS + owner identity + expiry/heartbeat + 单调 fencing token + stale owner 可判定 + 旧 owner 复活不能凭旧 lease 写**（每次 effect 前核 generation）。若现有 durable_jobs atomic lease 已满足则**复用不重造**。落 `<instance>/leases.json` 或复用其存储。 |
| `host/src/core/handoff.js` | **HandoffContract + PortableContinuityEnvelope**：`prepare→quiesce→checkpoint→release/acquire→resume→verify` 状态机；首版 cold handoff（旧身体进程已死也能 resume——envelope 落 `<instance>/checkpoints/`）。context 翻译在 adapter 侧，contract 只定义 envelope 形状。 |
| `host/src/core/identity.js` | runtime identity：host+adapter 版本、两边 lockfile sha256、session/run id、start 时间 → `<instance>/runtime.json`，audit 事件引用它。 |
| `host/src/core/audit.js` | 补成真实 JSONL writer（append-only，`<instance>/audit/<date>.jsonl`，事件带 runId/actor/toolName/predictionId/governance_coverage 标注）。 |
| `host/src/core/loaders.js` | soul loader 升级：解析 `soul/manifest.json` 契约（不是裸目录递归）；canonical loader 同。 |
| `host/src/core/envelopes.js` | **（R9 blocker）InstructionEnvelope 与 ContextEnvelope 是两个 contract**：Instruction=soul identity+generated policy block+governance instructions+checksum/provenance（→ system prompt/managed instruction 面）；Context=dynamic state briefing/memory/open predictions/observations（→ transformContext/context 缝）。混用会在 M2 attestation 和 M3 compaction 返工。 |
| `host/src/core/eligibility.js` | `eligible(body, taskRequirements)`：capability 满足 + 不可协商不变量成立；FAIL_CLOSED vs DEGRADED 判定在这。 |
| `pi/src/adapter/session.js` | 真实 `createPiSession`：InstructionEnvelope→system/managed instruction 面，ContextEnvelope→`transformContext`/`context` 缝；挂 `before_provider_request`/`before_provider_headers` 审计探针（**redaction 先行**：headers/payload 里的 Authorization/API key/用户文本必须 redact 或 hash 后才能进 audit JSONL——M1 就定义 redaction policy）；`sessionStartEvent` 记 provenance。 |
| `pi/src/bootstrap/host.js` | 装配升级：registry 登记 pi 身体 + capability 声明、lease 台账接入、identity 落盘。 |
| `pi/src/extensions/loader.js` | managed manifest 执行器：按 manifest 顺序+sha256 校验筛出 extension 文件 → 喂给 resourceLoader/agentDir；hash 不符 fail-closed。 |

测试：
- `host/tests/`：registry/lease/handoff/eligibility 各一组；**L2 fake adapter 契约套件**（一个 `FakeBody` 实现 host contract，跑同租约/handoff 测试）。
- `pi/tests/`：M1 集成——`createPiSession` 真跑通 + manifest hash 校验 + identity 落盘断言。
- 出口：L1（防火墙）L2（fake adapter）L3（pi adapter）全绿；`pai-host doctor` 报 registry/identity/audit 正常。

## M2 — 治理核

| 文件 | 内容 |
|---|---|
| `host/src/core/governance.js` | 真实 GovernanceKernel：negative capabilities（配置层不可表示的禁项）、policy 表、决策记录进 audit。 |
| `host/src/core/policy.js` | generated-policy attestation：checksum 比对 canonical 治理块，drift → FAIL_CLOSED（对应不可协商不变量 ④）。 |
| `host/src/core/prediction.js` | prediction 存取接口（读写 canonical state，绑 mutation）。 |
| `pi/src/adapter/revalidate.js` | **真实 schema 重校验**：`validateToolArguments` 在 `@earendil-works/pi-ai/utils/validation`（`./utils/*` 是公开 export）——**pi/package.json 必须加 `pi-ai@0.85.1` 直接依赖**，不偷用 transitive。注意它 structuredClone→normalize→返回新对象：composite 要把 validated normalized args **回写执行对象**，decide 看的是最终执行形态。 |
| `pi/src/adapter/command-parse.js` | shell 命令真解析。**依赖决策**：`web-tree-sitter`(wasm) + tree-sitter-bash grammar wasm——Windows 免编译；node-tree-sitter 原生绑定只在 wasm 路径不通时考虑。解析 `$(…)`、子shell、管道为命令单元喂 policy。 |
| `pi/src/adapter/surface.js` | deny→hide 两条分开：**初始压制**用 `createAgentSession` 的 `excludeTools`；**运行中 deny→hide** 用 extension runtime 的 `setActiveTools` + `<instance>/deny-memory.json` 持久化（`excludeTools` 是构造期 denylist 不是动态机制）。deny→terminate：`{block, terminate:true}`。 |
| `pi/src/adapter/errors.js` | Kimi 式结构化 deny：reason 带 repair 指引（"参数 schema 要求 X，你给了 Y"）。 |
| `pi/src/adapter/fileops.js` | write/edit/delete 包装：删→回收站（`<instance>/recycle/`）、改前备份（`<instance>/backups/`）；走 `withFileMutationQueue` 串行化。 |
| `docs/containment.md` | 三域执行面成文：模型工具（guard 管）/操作员直执+RPC bash（host gate 或禁）/extension `pi.exec`+直接 fs/network（TCB，manifest+attestation+containment）。 |

测试：composite 全链路（合法/被 extension 改坏/被 guard 否/terminate）；命令解析单测（`rm -rf $(x)` 类样本集）；deny-memory 持久化断言；文件备份断言。出口：M2 套件绿 + containment.md 评审过。

## M3 — loop/认知面

- `host/src/core/evidence.js`：TurnEvidence 评估器（任务要求 → 证据清单核对）。
- `host/src/core/continuation.js`：受治理续跑队列（evidence 不足 → 结构化 gap 落盘 + `steer()` 注入 + `shouldStopAfterTurn` 返 false；loop-breaker/预算接同一机制；超预算/重复无进展 → BLOCKED 终态）。
- `pi/src/adapter/`：挂 `shouldStopAfterTurn`/`prepareNextTurn`/`session_before_compact`/`model_select`。
- world-model/prediction/observation 生命周期进 compaction（overflow retry 保 world-model）。
- context/turn 计费：`before_provider_request` 记录 + 前缀缓存不变量断言。
- 出口：evidence 门测试（mock 不足证据 → 断言 steer 被调 + gap 落盘）；compaction 钩子断言；**（R9 修正）M3 出口前必须跑通至少一个真实 provider/model 的 production-path acceptance**——`prompt→context→provider→tool→guard→result→continuation/stop→persistence` 全链真跑。M4 只能建在这个 acceptance PASS 之上（否则后续 durable/subagent 故障无法归因）。

## M4 — 持久/编排面

- `host/src/core/jobs.js`：durable_jobs 九态机 adapter-facing 接口；`pi/src/adapter/jobs.js` 接 Pi executor；lease/checkpoint/recovery_tick 复用现有 canonical 实现。
- switchboard 桥：Pi 无 MCP → 用 RPC command + customTools 包出委派工具；子代理 tool call 走同一 composite 链，usage/cost 按 run identity 归父。
- 长命令 job 化：decide 里预判长命令 → 转 durable job 而非同步 bash。
- 出口：杀 Pi 进程 → 重启 recovery_tick 拉起 job 的演练测试。

## M5 — Cordis 分流 + Chord spike

- 脚本扫 `~/.dsh` 服务树产逐服务矩阵（`extends Service`/service key/inject 粒度）。
- S-chord spike：Chord facet/service/replicated-state 最小验证。
- 五类处置执行 + `dsh/` 各包打标。
- 出口：matrix 落 `docs/cordis-disposition.md`；每服务有去向。

## M6 — UI/渠道面

- S-rpc spike：`pi --mode rpc` 事件面 + ACP 边界评估。
- 渠道经 RPC/SDK 重建；UI 是 host 的消费者不是 harness 的。

## M7 — 切换演练

- Pi 默认身体跑生产；DSH 让位写域；恢复演练（kill→cold handoff resume→verify）；identity invariants L1–L6 验收；`dsh/` 处置按 M5 矩阵执行。

## 风险登记（施工期盯）

| 风险 | 缓解 |
|---|---|
| Pi 内部 API 漂移（我们依赖 `_installAgentToolHooks` 行为） | pin 0.85.1 + spike 每升级重跑 + `guard.sealed()` 运行时断言 |
| 模型鉴权：无 auth.json 时 createAgentSession 可能拒构造 | S0 先试裸构造；不行传 stub Model / modelRuntime |
| web-tree-sitter wasm 在 Node ESM 下的加载坑 | M2 开工先做 10 行验证脚本再决定 |
| extension 目录的 hash 校验被 resourceLoader 缓存绕过 | loader.js 每次重读文件校验，不信 Pi 侧缓存 |
| host 侧悄悄长出 pi 认知 | 防火墙测试每层 milestone 跑，进 CI 门禁 |
