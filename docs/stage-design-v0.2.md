# Personal AI 阶段设计与选型报告 v0.2

> 状态：设计基线（基于仓内实测代码与文档，非推测）。
> 输入：`app/`（server + ui + desktop）、`host/`（core + app）、`pi/`（adapter + bootstrap + bin）、
> `docs/pi-migration-design.md`、`docs/pi-migration-impl-plan.md`、`docs/containment.md`、
> `docs/channel-eval.md`、`docs/instance-contract-v1.md`、`app/UI-BACKLOG.md`。
> 目的：回答四个问题——**现在有什么 / 怎么跑起来的 / 下一步该有什么 / 需要什么工具**。

---

## 第一部分 · 现有目录结构

仓库是**公开发布仓**（机制层），不是运行时工作区。九层目录，改动前必须先认层：

| 层 | 目录 | 角色 | 可否改 |
|---|---|---|---|
| ① Skill 包 | `skills/<name>/` ×22 | 认知流程单元，登记在 `skills.json` | ✅ |
| ② MCP 包 | `mcp/`（`agent-switchboard`、`chatgpt-web-bridge`） | 外部能力桥，登记在 `mcp.json` | ✅ |
| ③ DSH 插件包 | `dsh/`（24 项：adapter / bin / runtime / ui / world-model / 16 个功能插件 / tests） | legacy 身体的用户级插件 | ✅ |
| ④ 质量脚手架 | `scripts/`(100 py) `tests/`(47 py) `docs/`(39) `_template/` `.github/workflows/` | 校验器、同步器、发布门禁 | ✅ |
| ⑤ 设备运行层 | `.taskflow/` `.grepai/` `.claude/` `node_modules/` | 本地运行态 | ❌ 禁改禁提交 |
| ⑥ soul/ | `manifest.json` `schema/` `briefing/` `models/` `bootstrap/` | 可携带认知状态（通用脱敏） | ✅ |
| ⑦ host/ | `src/core/`(41 文件) `src/app/` `tests/` | **中立控制宿主，零外部依赖** | ✅ |
| ⑧ pi/ | `src/adapter/`(41) `src/bootstrap/` `src/chord/` `extensions/` `bin/` | Pi 身体实现 | ✅ |
| ⑨ app/ | `server/`(5) `ui/`(3) `desktop/` `tests/`(4) | **自有用户界面层** | ✅ |

**依赖方向是单向的**：`app → pi → host`，`app → dsh`，`pi → host`。
`host/` 全目录禁止 import 任何身体（`@earendil-works/*`、`pi/`、`dsh/`），由
`host/tests/firewall.test.js` 机械执行。推论：**composition root 在 `pi/src/bootstrap/host.js`
（81.6KB，pi 侧最大文件），不在 `host/src/app/`**——`host/` 只回答"需要什么"，`pi/` 回答"怎么装起来"。

---

## 第二部分 · 核心模块与运行逻辑

### 2.1 进程与模块拓扑（实测）

```text
┌─ Electron 主进程 (app/desktop/main.js, 62 行) ────────────────────┐
│  或 纯 Node 开发入口 (app/server/dev.js, 51 行, :4173)             │
│                                                                    │
│  ┌─ BodySupervisor (app/server/supervisor.js, 778 行) ──────────┐ │
│  │  · instance root / workdir / repoRoot / env / catalog        │ │
│  │  · BodyRegistry · DomainLeaseStore · HandoffStore · Audit    │ │
│  │  · spawnBody() → 子进程 JSONL stdin/stdout                    │ │
│  │  · handle(cmd) → 21 个自有命令 + 其余代理给身体                │ │
│  └───────────────────────┬──────────────────────────────────────┘ │
│                          │                                         │
│  ┌─ createHttpBridge (app/server/http-bridge.js, 195 行) ───────┐ │
│  │  POST /cmd │ GET /events (SSE) │ /api/state /api/metrics     │ │
│  │  /api/pick-dir /api/artifact(s) │ GET /* → app/ui 静态文件    │ │
│  │  badOrigin(): Origin 白名单 + Sec-Fetch-Site → 拒跨站 POST    │ │
│  └───────────────────────┬──────────────────────────────────────┘ │
└──────────────────────────┼─────────────────────────────────────────┘
                           │ spawn(process.execPath, pi/bin/pai-channel.js)
                           │         --instance <root> --workdir <dir>
                           ▼
┌─ 身体通道进程 (pi/bin/pai-channel.js, 108 行) ────────────────────┐
│  stdin: 命令 JSONL │ stdout: response / event / audit 三类行        │
│  SIGINT/SIGTERM → dispose + exit 0（主动释放 writer lease）        │
│  win32: NoDefaultCurrentDirectoryInExePath=1（防当前目录植入 exe） │
└──────────────────────────┬─────────────────────────────────────────┘
                           ▼
┌─ pi/src/bootstrap/host.js (81.6KB) — 唯一 concrete composition root ┐
│  createAgentSession() → 捕获 Pi 自装的 agent.beforeToolCall         │
│  → installCompositeGuard() → 包一层：                                │
│      ① Pi extension bridge（managed extensions 可原地改参）          │
│      ② post-mutation schema revalidation（validateToolArguments）    │
│      ③ PAI authoritative decide（GovernanceKernel）                  │
└──────────────────────────┬─────────────────────────────────────────┘
                           ▼
┌─ host/src/app/host.js · createHostCore() (83 行) ─────────────────┐
│  instancePaths → AuditWriter → loadManagedManifest → loadSoul      │
│  → loadCanonicalState → AttestedPolicy → PredictionStore           │
│  → ObservationStore → GovernanceKernel → BodyRegistry              │
│  → DomainLeaseStore → HandoffStore                                 │
│  → instructionEnvelope + contextProvider()（每次 context 事件重读）│
└──────────────────────────┬─────────────────────────────────────────┘
                           ▼
┌─ 实例根 (~/.personal-ai/instance 或 app userData) ────────────────┐
│  audit/<date>.jsonl │ jobs/ │ checkpoints/ │ canonical/policy.json │
│  leases.db (SQLite WAL) │ crashes/ │ sessions/ │ exports/          │
│  ← resolveInstanceRoot() 若解析进 git worktree 直接 fail closed     │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键模块职责（逐文件核对）

**`app/server/supervisor.js` — 多身体组装根。** 默认档案是 `REQUIRED_BODY_CAPABILITIES`
（来自 `pi/src/bootstrap/facts.js`：`final_post_extension_guard` / `durable_jobs` /
`provider_request_audit`，三项皆 `negotiable: false`）。

- `start()` → 确保实例目录 → 加载配置 → 建 registry/lease/handoff/audit →
  发现身体（**只为已安装的身体登记 facts**）→ 按 `facts + eligibility + channel` 选默认身体
  （**从不按声明选**）→ `spawnBody()` → 写 `SUPERVISOR_STARTED` 审计。
- `spawnBody()` — readline 逐行解析 JSONL；`pending` Map 以 `c${++seq}` 关联响应；
  stderr 保留尾部 40 行；EPIPE 守卫；`onExit` → `#recordCrash` + `#maybeRespawn`；
  `body_info` 就绪探针 45s 超时。
- `#maybeRespawn()` — 退避 1s/2s/4s，上限 3 次；存活超 30s 重置预算；
  切身体中 / 已取代 / disposing 时跳过。
- `sendToBody(cmd, timeoutMs=60_000)` — 无活体时返回 `{success:false, error:'no live body'}`
  （**不抛异常**）；`SLOW` 集合（`prompt`/`steer`/`session_compact`）超时 600s。
- **21 个自有命令**（`switch` 清单实测）：
  `supervisor_status` `body_list` `body_current` `body_select` `eligibility_preview`
  `handoff_status` `set_workdir` `workspace_list/add/remove` `files_list` `file_read`
  `session_pin/archive/sweep/purge/list` `macro_list/save/delete`。
  其余（约 130 个）**透传**给身体，切换期间对 `prompt/steer/abort/session_*`/`model_set` 加守卫。

**`app/ui/app.js`（203.7KB）+ `index.html`（33.1KB）+ `style.css`（68.8KB）— 零构建前端。**
无打包器、无框架。核心是 `async function cmd(type, params={})`（第 59 行）→ `POST /cmd`。
实测 UI 共发出 **约 140 个不同命令**，覆盖 6 个视图：
`view-chat` / `view-jobs`（5 个 tab：jobs·schedules·goals·tasks·monitors）/
`view-changes`（receipts·artifacts）/ `view-audit` / `view-bodies` / `view-about` /
`view-settings`（8 张卡：model·appearance·memory·workdir·instance·modes·commands·governance·budget）。

**`host/src/core/governance.js`（753 行）— 权威终审位。** `decideToolCall(ctx)` 八步有序链：

1. policy attestation（drift → **terminate**）
2. 显式 tool rule deny
3. negative capabilities（受保护根：audit/jobs/checkpoints）
4. 命令分类（risk class → `riskActions`；外加 instruction_file / git_internal / env_injection 升级）
5. 单工具 ask
5b. 变更类工具的指令文件保护
6. prediction binding（变更须绑已持久化 prediction）
7. 会话风险模式（`plan` 只收紧）
8. 模式预设叠加（只收紧）

晶格序：`terminate > deny > ask > allow`。拒绝带**结构化修复指引** `{rule, expected, actual, repair}`。
`#ask()` 子流程：命令白名单 → **拒绝记忆**（同 call 二次必拒）→ 探针短路 → 无 ask 处理器则 fail-closed
→ 审计 → `sanitizeAskArgs`（密钥脱敏：9 类内联模式 + 赋值式 + 字段名）→ shadow judge（**仅建议，永不翻案**）
→ 操作员 → 卡内编辑 + `#recheckEditedArgs`。

**`host/src/core/channel.js`（53.2KB）— HostChannel，M6 边界。** 头部明文写着：
"UIs and remote consumers talk to **THIS**, never to the body"。
命令面刻意与 `pi --mode rpc` 同构，但**分支语义（`fork`/`clone`/`get_tree`）与 `bash` 直执有意排除**——
前者是 Pi 私有会话树语义，后者走第二域闸（见 `docs/containment.md`）。

**`host/src/core/lease.js`（130 行）— 作用域写者租约。** `node:sqlite` `DatabaseSync`，
WAL + `busy_timeout=1000`，原子 CAS upsert，单调 `generation` 作 **fencing token**。
`assertHeld()` 是**每次 effect 前**的栅栏——旧 owner 复活不能凭旧租约写。
这替代了 DSH 时代的全局独占，允许不相交域并发（`Pi→world-model WRITE` ∥ `DSH→channel ACTIVE`）。

**`host/src/core/handoff.js`（157 行）— 七相冷交接。**
`prepared → quiesced → checkpointed → released → acquired → resumed → verified`（+`failed`）。
`_transition()` 强制 `j === i+1`，跳相直接 throw。`ENVELOPE_REQUIRED` 9 字段，
`VERIFY_CHECKS` 五道门：`policyIdentity` `stateCursor` `provenanceParent` `writerLease` `capabilityCoverage`——
任一非 `true` 即落 `failed` + failures 数组，**回滚或 BLOCKED，不留降级放行**。

**`host/src/core/eligibility.js`（85 行）— 两类缺失严格分开。**
`NON_NEGOTIABLE_INVARIANTS` 六项：`single_writer_lease` `provenance_identity` `prediction_binding`
`policy_attestation` `handoff_boundary` `schema_compatibility`。
- 可协商能力缺失 → `degraded`（合法运行，审计标注真实覆盖）
- 不可协商不变量破坏 → `failClosed`（拒绝）

`selectBody()` 在**所有合格身体**中选**降级缺口最少**者，平票按 `body_id` 字典序确定性打破。
**"默认身体"是机制输出，不是架构宣告**——写 `if body == DSH: reject` 是禁止的。

### 2.3 三域执行面（`docs/containment.md`）

治理的不是"一个工具面"，而是三个性质不同的执行域。混为一谈会让防线自欺：

| 域 | 内容 | 防线 | 覆盖度 |
|---|---|---|---|
| ① 模型工具面 | `agent-loop` 链上一切 tool（内建 + customTools + extension 注册） | composite guard 全链（extension 改写 → 重校验 → PAI 终审） | M1/S0 实测，M2 上线 |
| ② 操作员直执 + RPC | operator CLI、RPC command、switchboard 桥 | 同一 kernel 的 `decideToolCall`，ctx 由调用方构造；**不经 kernel 的直执路径 = 设计缺陷，视为 incident** | 设计中（M4 接线） |
| ③ extension 自身能力 | `pi.exec()`、直接 fs、直接 network | **供应链而非运行时**：`managed-manifest.json` 逐文件 sha256 pin + `noExtensions:true` 关自动发现 | M1 |

> 诚实声明（原文）：域③与 DSH 时代同级——"没有更糟，也没有更好"。改进路径是 OS 级
> containment（job object / sandbox），排进 backlog，**不假装已解决**。

### 2.4 数据流方向（四条主干）

```text
① 命令下行
   UI cmd(type,params) → POST /cmd → bridge.badOrigin() 校验
   → supervisor.handle() ─┬─ 21 个自有命令：本地处理
                          └─ 其余：sendToBody() → JSONL stdin → bootstrap → host core / Pi session

② 事件上行（两条独立通道，这是刻意的）
   Pi AgentEvent → bootstrap → stdout {type:'event'} → supervisor readline
                → SSE {type:'event'} → UI 增量渲染（token 级流式）
   审计事件     → AuditWriter → <instance>/audit/<date>.jsonl
                → stdout {type:'audit'} → SSE → UI 审计视图 / 🔔

③ 治理决策流（同步、阻塞）
   tool call → composite guard → kernel.decideToolCall() 八步
   → deny/allow 同步返回 → 执行或阻断
   → ask 则挂起 → 推 ASK 卡给 UI → 操作员决策 → decision_resolve → 恢复/放弃

④ 状态持久化流
   实例根为唯一 SSOT。canonical/policy.json 只由操作员写；
   leases.db 由 lease store 写；handoff/checkpoint 由 handoff store 写；
   sessions/ 由 Pi SessionManager 写。任何角色都不得写他人域。
```

### 2.5 四条关键业务流程

**流程 A · 一次普通提问（含治理闸）**

```text
用户输入 → cmd('prompt',{message}) → bridge → supervisor 切换守卫
→ sendToBody('prompt', 600s) → bootstrap → Pi AgentSession.prompt()
→ 模型返回 tool call → composite guard:
    extension bridge 改参 → validateToolArguments 重校验（normalized 回写）
    → kernel.decideToolCall() 八步
       ├─ allow  → 执行 → 结果回灌模型
       ├─ deny   → 结构化拒绝 + repair 指引 → 模型自我修正
       ├─ ask    → ASK 卡推到 UI → 等待操作员 → 恢复
       └─ terminate → 停整批
→ 文本流式：event → SSE → UI
→ turn 结束 → evidence 评估 → 证据不足则结构化 gap + steer() 续跑
→ audit 落盘
```

**流程 B · 身体热切换（七相真交接，`#hotSwitch`）**

```text
body_select(to) → 校验（未知/未安装/不合格/无通道 → 拒）
  空会话 → 冷切换；有内容 → 热切换：
  1. handoffs.begin            → phase('prepared')
  2. body handoff_prepare(30s)  → 停旧 writer authority
  3. quiesce                    → phase('quiesced')
  4. body handoff_export(15s)   → 产出 PortableContinuityEnvelope
  5. checkpoint                 → phase('checkpointed') + 落 <instance>/checkpoints/
  6. body handoff_release(15s)  → release 边界（顺序不可反，否则双写窗口）
  7. gracefulShutdown() → spawnBody(to)（失败则回滚到 from）
  8. 逐租约重新 acquire + verify → phase('acquired'/'resumed')
  9. verify 五门重算（对真实 store，不信任旧身体自述）：
     policyIdentity / stateCursor / provenanceParent / writerLease / capabilityCoverage
     任一非 true → failed + 回滚
```

**关键设计点**：envelope **只转移 PAI 自有状态**（goalIdentity / canonicalCursor / soulIdentity /
openPredictions / jobCursors / policyIdentity / provenanceChain / source{body,session,run}），
**不复制 harness 隐藏内部状态**。验收标准是 `PAI-owned continuity survives body change`，
**不是** `Pi session 内部态 == DSH session 内部态`。

**流程 C · 崩溃与自愈**

```text
身体进程非正常退出 → onExit
→ #recordCrash：写 BODY_EXITED 审计 + <instance>/crashes/ 报告
   （exit code / signal / uptime / in-flight 调用数 / stderr 尾 4000 字符）
→ #maybeRespawn：退避 1s/2s/4s，上限 3 次；存活 >30s 重置预算
→ 恢复期间无活体命令返回 {success:false, error:'no live body'}（前端显示"已断开/正在重连"）
→ 若为 durable job：recovery_tick 以**零 LLM** 拉起
```

**流程 D · 首次运行 provisioning**

```text
启动 → splash（遮住身体启动 ~5s）
→ get_state → model_status
   ├─ 有模型 → 进入对话
   └─ 无模型 → #setup-card 接管空态：
        选 provider → 填 key（支持 $ENV 引用）→ save → ping → fetch models
        → model_set → 真 prompt
→ 无身体 → 引导 npm --prefix pi install
```

---

## 第三部分 · 本阶段应具备的功能设计

### 3.1 定位判断：本阶段是"可用产品化收口"，不是新架构

**依据（实测，非推测）**：

1. UI 已能发出 ~140 个命令，后端 21+130 个命令面基本覆盖；
2. M0–M7 迁移里程碑在代码上**已全部落地**（composite guard、kernel 八步、
   七相交接、SQLite 租约、eligibility/selectBody、HostChannel、app 层身体面板）；
3. `app/UI-BACKLOG.md` 状态行：R1–R7 **全部 ✅**，仅剩 **R8 的 C12 provisioning 向导 ⬜**；
4. 有真实验收记录（`provider_add cpa → env 密钥 → model_set → 真 prompt →
   gpt-5.6-luna-max 回复 READY，usage 3365`）。

**结论**：本阶段的真实缺口不是"缺功能"，而是**四类收口**——
① 首次用户体验断裂；② 长会话/大仓库的规模不确定性；③ 三域执行面里域②③尚未闭环；
④ 前端零构建在 200KB 单文件上的可维护性拐点。

### 3.2 核心功能模块设计

#### 模块 A · Provisioning 向导（C12，唯一明确的未完成项）

**现状**：`#setup-card` 已覆盖引导主干（provider 选择 / key 输入 / save / ping /
fetch-models），但它是**单点卡片**，不是分步向导；instance 与身体探测、失败回退、
环境变量引用（`$ENV`）的可用性提示都没有串成一条可验证路径。

**应具备**：

| 步骤 | 内容 | 判定依据 | 失败回退 |
|---|---|---|---|
| A1 实例 | 显示 `instanceRoot`、`instance_id`、schema 版本；若解析进 git worktree 明确报错 | `supervisor_status` + `instance.yaml` | 引导改 `PERSONAL_AI_HOME` |
| A2 身体 | 探测 `pi`/`dsh` 安装状态 + `install_hint`（`npm --prefix pi install`） | `body_list.installed` | 提供一键复制安装命令 |
| A3 提供方 | 预置 provider + 自定义 OpenAI 兼容（`provider_add`） | `model_status` / `model_list` | 保留原配置不覆盖 |
| A4 凭据 | key 明文输入或 `$ENV` 引用；**写后不回显**（`auth_set_key` 协议即此语义） | `model_ping` 实探 | 清残留（`auth_clear`） |
| A5 模型 | `provider_models_fetch` → 选择 → `model_set` → `thinking_set` | `model_status` | 回 A4 |
| A6 首跑验证 | 真发一条 prompt，断言拿到响应 + usage 非零 | `agent_stats` usage | 展示真实 error 原文 |
| A7 工作目录 | `set_workdir` + workspace 列表 | `workspace_list` | 默认 Documents |

**设计要点**：每一步**可跳过、可回退、可重入**（用户中途关窗不得留下半配置态）；
状态持久化到 app-config，重启后续接；**任何密钥都不进 UI 状态树**，只保留"已配置"布尔量。

#### 模块 B · 长会话与大仓库的规模确定性

**现状风险**：`app.js` 单文件 203.7KB；`files_list` 虽已做 500 条递归上限 + 返回 200 条，
但 UI 侧渲染、会话历史、审计列表的规模行为**未见压测证据**。

**应具备**：
- 会话历史：`HISTORY_PAGE=50` 已有，补"总条数 + 已加载数"显式指示；
- 审计列表：加时间窗 + kind 过滤（`D4` 已列），并做**万行级 lazy 渲染**断言；
- 文件树：`files_list` 补"已截断 + 总数"元信息，避免用户误以为目录为空；
- 对话 minimap（`A11` 已落地）在 1000+ 消息下的刻度抽稀。

**验收**：给出可复现的规模基线（N 条消息 / N 个文件 / N 行审计 → 首屏与交互延迟）。

#### 模块 C · 域②③执行面闭环

**这是本阶段**唯一**涉及架构正确性的方向**，也是 `docs/containment.md` 自认的欠账。

- **域②（操作员直执 + RPC）**：`decideToolCall` 已存在，但"直执入口"仍是设计态。
  应落地一个**统一 CLI 闸**：凡非模型路径的执行（含 `bash_run` 命令、未来的 RPC command）
  一律构造 ctx 后过 kernel，并在审计里标注 `actor: operator` 与 `via: <entry>`。
  **判断标准**：仓库里不存在绕过 kernel 的直接执行路径。
- **域③（extension TCB）**：manifest sha256 pin + `noExtensions:true` 已是供应链防线。
  本阶段应至少给出**一份 TCB 清单文档**（哪些进程/文件属于 TCB、改动它们的后果是什么），
  并把 OS containment（job object / sandbox）作为**有明确缺口描述的 backlog 项**保留，
  不写成"已解决"。

#### 模块 D · 前端可维护性收口

**现状**：零构建是**有意的架构选择**（无打包器、无框架、可直接 diff）。
但 `app.js` 203.7KB 单文件已到拐点——继续加功能会显著抬高改动风险。

**应具备**（**不引入打包器**，只做源码组织）：
- 拆成 ES module 多文件（`ui/modules/*.js`），靠原生 `<script type="module">` 加载；
  浏览器与 Electron 都天然支持，**构建步骤仍为零**；
- 边界按视图切：`transcript` / `composer` / `jobs` / `settings` / `governance` / `transport`；
- 保留 `cmd()` 为唯一传输出口（单一 API 面不扩散）。

**为什么不做成 SPA 框架**：引入 React/Vue 会让 `app/ui` 与 `host/` 的中立契约不对称，
且违背"零构建"作为 runtime identity 一部分的现状。**如实记录拐点，但不越界重构**。

#### 模块 E · 观察性补强

**现状**：`/api/metrics` 已有 bridge pid/uptime/rss/heap + body pid/alive/pending；
`supervisor_status.version` 已有 `{bootCommit, repoCommit, stale}`。

**应具备**：
- `stale` 为真时在 UI 显式提示"运行版本落后于源码"（这是发布仓与运行态分离后的必然现象）；
- 加**交接耗时直方图**（七相各相耗时，`D2` 已列"补每相耗时"）；
- 加**治理决策计数**（allow/deny/ask/terminate 分桶，按 kind），让"治理在工作"可被看见。

### 3.3 模块交互关系

```text
                    ┌─────────────────────────┐
                    │  A Provisioning 向导     │
                    │  （写 app-config / auth）│
                    └───────┬─────────────────┘
                            │ 产出：可用模型 + 身体 + workdir
                            ▼
┌──────────────┐   cmd()   ┌──────────────┐  JSONL   ┌────────────────┐
│  D 前端模块   │ ────────► │  Supervisor  │ ───────► │  body bootstrap │
│  （拆 module）│ ◄──────── │  （21+代理）  │ ◄─────── │  （composite）  │
└──────┬───────┘    SSE    └──────┬───────┘  events  └───────┬────────┘
       │                          │                          │
       │ 渲染                      │ 读                       │ decideToolCall
       ▼                          ▼                          ▼
┌──────────────┐          ┌──────────────┐          ┌────────────────┐
│ B 规模确定性  │          │ 实例根 SSOT   │          │ C 域②③ 闸      │
│ （分页/懒渲染）│          │ audit/leases │          │ （operator/RPC）│
└──────────────┘          └──────┬───────┘          └────────┬───────┘
                                 │                           │
                                 └────────► E 观察性 ◄────────┘
                                    （metrics / 直方图 / 计数）
```

**依赖纪律**：A 只写 app-config 与 auth；B/D 只读不写；C 走 kernel 不造第二套政策；
E 只读聚合不改状态。**没有任何模块可以直接写 canonical。**

### 3.4 数据流向（本阶段新增/变化部分）

| 数据 | 方向 | 载体 | 变化 |
|---|---|---|---|
| 向导进度 | UI → app-config | `config_set` | 新增，可重入 |
| 凭据 | UI → body → auth.json | `auth_set_key` | 已有；补 `$ENV` 可用性提示 |
| 规模元信息 | body → UI | `files_list` / `session_history` 返回体 | 补 `{returned,total,truncated}` |
| 直执决策 | operator/RPC → kernel → audit | `decideToolCall` + audit `actor` | 本阶段接线 |
| 交接耗时 | handoff store → UI | `handoff_status` | 补每相耗时 |
| 决策计数 | audit jsonl → UI | `audit_tail` 聚合 | 新增只读聚合 |

### 3.5 关键业务流程（本阶段需要新建的）

**流程 E · 首次运行全向导（A1→A7）** —— 见 3.2 模块 A，带每步失败回退。
**流程 F · 运行版本落后提示** —— `supervisor_status.version.stale === true` → UI 提示，
引导用户按 `BOOTSTRAP.md` 重新执行安装/更新（**不由 agent 自动改 git**，遵守 §0 铁律）。
**流程 G · 操作员直执过闸** —— operator 发起 → 构造 ctx → `decideToolCall` → 审计标 `actor:operator`。
**流程 H · 交接失败回滚** —— verify 五门任一失败 → `failed` + 回滚到 `from` 身体 + UI 明示失败相 + 原因。

---

## 第四部分 · Skill 与工具选型建议

### 4.1 结论先行

本仓已有 **22 个 Skill**（`skills.json` 双档案：core 8 / full 22）与 **2 个 MCP**
（`agent-switchboard`、`chatgpt-web-bridge`）。**本阶段不需要新增运行时依赖**——
`host/` 零依赖是硬约束，`app/` 保持零构建是现状选择。
需要补的是**开发期工具**与**少量 Skill 增量**。

### 4.2 选型表（逐项：用途 / 适用场景 / 集成方式）

#### 已具备，本阶段直接复用（不要重复造）

| 工具 | 用途 | 适用场景 | 集成方式 |
|---|---|---|---|
| `skill-quality-gate` | Skill 门禁 | 任何 Skill 改动后 | `python skills/skill-quality-gate/scripts/quality_report.py --root . --strict` |
| `systematic-optimization` | 优化闭环 | 本阶段四类收口逐项推进 | 作为本阶段主流程 Skill |
| `personal-ai-operations-review` | 运维审查 | 收口后回顾 | 会话内 prompt 调用 |
| `execution-discipline` | 执行纪律 | 跨域改动 | 会话内 prompt 调用 |
| `agent-switchboard` (MCP) | 多 agent 编排 | 委派/并行子任务 | 已在 `mcp.json`；注意其许可证是**修改版非 MIT** |
| `review/validate_repo.py` | 结构 + 注册表 + 许可证 + 链接 + 运行态边界 | 每次改动后 | `python scripts/validate_repo.py --strict` |

#### 建议新增（开发期，不进运行时）

| # | 工具 | 用途 | 适用场景 | 集成方式 | 为什么值得 |
|---|---|---|---|---|---|
| 1 | **样式/HTML 静态检查**（`stylelint` + `html-validate`） | 校验 `app/ui/style.css`(68.8KB) 与 `index.html`(33.1KB) | UI 每次改动 | **已在 `app/devDependencies` 且 `app/node_modules` 已装**；只需加 npm script 并接入 CI | 零新增依赖，直接兑现 |
| 2 | **可访问性扫描**（`axe-core`） | 对话流 + ASK 卡的可访问性 | ASK 卡/表单改动 | 已装；驱动方式见下 | 治理 ASK 卡是**安全关键 UI**，可访问性缺陷会直接导致误批 |
| 3 | **可访问性驱动**（`playwright` 或 CDP） | 跑 axe + 真实交互回归 | `app/ui` 集成测试 | `scripts/browser_e2e_cdp.js` 已有 CDP 骨架，可扩展；**注意本机 agent-browser 不支持 Windows**，需走 CDP/Playwright 路线 | 补 `app/tests/` 只有 DOM 级断言（`ui-dom.test.js` 3.8KB）的空缺 |
| 4 | **ArkType / Zod** | 运行时 schema 校验 | app-config、`/cmd` 入参、向导步骤边界 | **不引入到 host/（零依赖铁律）**；仅 `app/server` 可用 | 向导步骤多、入参形状多，手写校验易漏 |
| 5 | **ES module 拆分**（原生，无依赖） | `app.js` 200KB 拐点 | 模块 D | `<script type="module">` + 相对路径 import | 零构建不变，风险可控 |

> **关于第 4 项**：若坚持 `host/` 与 `app/` 都不加依赖，替代方案是**扩展仓内既有的
> 手写校验模式**（`validate_repo.py` 已是这个路子）。**建议先不引入**，
> 等向导步骤超过 10 个再评估——**过早引入 schema 库会让"零依赖"叙事出现裂缝**。

#### 明确不做（并说明理由）

| 工具 | 不做理由 |
|---|---|
| Figma / 设计稿插件 | 本阶段是功能收口，不是视觉重构；且仓内无设计源文件 |
| 打包器（Vite/webpack/esbuild） | 零构建是现状架构选择，引入会改变 runtime identity 与可 diff 性 |
| UI 框架（React/Vue） | 会让 `app/ui` 与 `host/` 中立契约不对称；收益不抵重构风险 |
| OS 级 sandbox（job object） | 需要平台特定实现，且 `docs/containment.md` 已如实标注为 backlog；**本阶段只做缺口文档，不假装解决** |
| 更新检查通道 | 无发布通道（`UI-BACKLOG.md` 已判"不做"） |
| 视频/3D/多模态生成 | 本产品不支持该类能力生成，不在本阶段范围 |

### 4.3 按模块映射的工具组合

| 模块 | 主要工具 | 验证方式 |
|---|---|---|
| A 向导 | 复用现有 8 张设置卡 + `provider_add`/`auth_set_key`/`model_set` | 端到端真跑一条 prompt，断言 usage 非零 |
| B 规模 | `files_list`/`session_history` 返回体补元信息 | 压测脚本给出延迟基线 |
| C 域②③ | 复用 `decideToolCall`；新增 CLI 闸 | 断言仓库内不存在绕过 kernel 的执行路径 |
| D 前端 | 原生 ES module + `stylelint` + `html-validate` | `npm --prefix app test` + 样式/HTML 检查 |
| E 观察性 | 复用 `/api/metrics` + `audit_tail` | 计数与直方图有人工可读输出 |

---

## 第五部分 · 风险与开放问题

| 风险 | 证据 | 缓解 |
|---|---|---|
| **Pi 内部 API 漂移** | 依赖 `_installAgentToolHooks` 行为 | pin `0.85.1` + 每次升级重跑 S0 spike + `guard.sealed()` 运行时断言（仓内已列） |
| **域②仍未接线** | `docs/containment.md` 自述"设计中" | 本阶段模块 C；未接线前不得声称"完整中介" |
| **域③本质未改善** | 原文自述"与 DSH 时代同级" | 保留 backlog，文档写明缺口；**不写成已解决** |
| **`app.js` 200KB 拐点** | 单文件 203.7KB | 模块 D：原生 ESM 拆分，零构建不变 |
| **发布仓与运行态分离** | `supervisor_status.version.stale` 字段即为此设计 | 流程 F：UI 显式提示，人工按 `BOOTSTRAP.md` 更新 |
| **agent-browser 本机不可用** | 环境钩子明确"不支持 Windows" | 走 `scripts/browser_e2e_cdp.js` 的 CDP 路线或 Playwright |
| **向导半配置态** | 现有 `#setup-card` 是单点卡 | 模块 A 设计要点：每步可跳过/回退/重入，配置原子落盘 |

---

## 附：本阶段验收清单（可机械执行）

```bash
git diff --check
python scripts/validate_repo.py --strict
python skills/skill-quality-gate/scripts/quality_report.py --root . --strict
python -m unittest discover -s tests -v
python -m unittest discover -s mcp/agent-switchboard/tests -v
npm --prefix host test      # 零依赖防火墙
npm --prefix pi test        # pi 侧边界
npm --prefix dsh test       # L4 契约 + L5/L6 切换演练
npm --prefix app test       # supervisor/bridge（fixture 身体真切换）
```

追加（本阶段新增）：
- 向导流程：A1→A7 每步失败回退可复现；
- 规模基线：给出 N 消息 / N 文件 / N 审计行的延迟数字；
- 域②闸：断言不存在绕过 `decideToolCall` 的执行路径；
- 版本落后：`stale=true` 时 UI 提示可触发。
