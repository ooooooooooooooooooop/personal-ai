# pi 侧世界模型适配器 —— seam 映射与设计

> **本文性质**：pi **身体**的世界模型适配器设计（`pi/src/adapter/world-model.js`）。
> **契约在 [`mind/README.md`](../mind/README.md)**（BCC-1 六协议），
> **回路规格在 [`app-world-model-loop.md`](./app-world-model-loop.md)**。
>
> ⚠️ **归属**：适配器属**身体**，放在 `pi/`。`mind/`（通用层）只定义"必须满足什么"
> 并提供测试台 —— **新增身体不改通用层**。这正是 BCC-1 存在的意义。

## 1. 为什么需要它

`dsh/world-model/world-model.mjs` 是 **DSH 身体**的适配器。app 跑 **pi**，
而 pi 侧没有任何世界模型适配器 → 回路的观察流永远是空的。

**dsh 那条路是关闭的**（`dsh/adapter/index.js:19–21`）：
DSH 没有 post-extension 复合守卫这个 seam，
**而这正是本仓从 dsh 迁到 pi 的原因**。所以只剩"给 pi 写适配器"一条路。

## 2. 契约要求的五个面 → pi 提供的 seam

契约（`simulate_body.mjs` 反推）要求适配器拿到这五面。**逐一核对 pi 的实际 seam：**

| 契约要求 | DSH 提供 | **pi 提供** | 状态 |
|---|---|---|---|
| `on('tools/result')` | cordis `ctx.on` | **`pi.on('turn_end')`** → `event.toolResults[]`（`{toolName, isError, toolCallId}`）+ `event.context`（取 args） | ✅ 可用 |
| `on('session/event')` | cordis `ctx.on` | `pi.on('session_compact' / 'session_compact_failed' / 'model_select' / 'session_before_compact')` | ✅ 可用 |
| `tools.register(tool)` | `ctx.tools.register` | **`customTools` 数组**（bootstrap 组装，`createPiSession({customTools})`） | ✅ 可用（bootstrap 组装） |
| `tools.guard(fn)` | `ctx.tools.guard`（一等插件 API） | **无插件 API** —— 守卫链是 `makeDecide()` 里 9 个具名 `block` 点，在 bootstrap 组装 | ⚠️ **需接线**（见 §3） |
| briefing 挂载 | `systemPrompt.section` | **已在 `host/` 实现** —— `loadSoul()` 读 `<instance>/soul/briefing/briefing.md`，`contextProvider` 每轮注入 | ✅ 无需适配器做 |

**两个重要结论：**

1. **briefing 挂载不用适配器管。** `host/src/core/loaders.js::loadSoul` 已经读它，
   `host/src/app/host.js:67` 已把它放进上下文信封，`renderContext` 每轮渲染。
   **适配器的职责是"产出 canonical"，让 `canonical_compile.py` 能编译出 briefing。**
2. **`preToolGate` 不是给适配器用的。** 它是**操作者私有的否决钩子**
   （`<instance>/hooks.json`，"the agent cannot reach it, so this is a real external gate"，
   `decide.js:318–345`）。适配器**不应该**也不可以挂在它上面。

## 3. 守卫怎么接（唯一需要决定的地方）

pi 的守卫链（`pi/src/bootstrap/decide.js`）是**在 bootstrap 组装**的一串具名检查：

```
command_denylist · unicode_invisible · secret_scan · paiignore · tool_deferred ·
turn_cap · mistake_limit · loop_detect · read_outside / write_outside ·
fileops_backup · workspace_lease · pre_tool_hook
```

**没有给插件注册守卫的 API。** 所以适配器的守卫有两条路：

| 方案 | 做法 | 评价 |
|---|---|---|
| **(a) 新增插件级守卫注册面** | 给 pi 加一个 `registerGuard(fn)` 之类的 seam | 通用性更强，但**是给 pi 加新能力**，且目前只有世界模型一个消费者 |
| **(b) 在 bootstrap 组装并传入**（推荐） | 照 `preToolGate` 的做法：`host.js` 构造守卫 → 传进 `makeDecide` → 作为第 10 个具名 `block` 点 | **与 pi 现有架构一致**（其余守卫都这么组装）；适配器仍是 `pi/src/adapter/` 下的模块 |

**推荐 (b)**，理由：pi 的架构本就是"守卫在 bootstrap 组装"，为单一消费者加一套插件 API
是过度设计。若将来出现第二个需要注册守卫的适配器，再抽 seam。

## 4. 适配器要产出什么

**核心工作量不是"接缝"，是"产出正确形状的事件"**（见 `app-world-model-loop.md` §2.5.7②）。

pi 现在的 `ObservationStore` 行是 `{id, kind, subject, detail, actor, at}` ——
**BCC-1 要求的事件字段一个都没有**。契约要求（`bcc_check.py` 6.2）：

```text
必需字段：event_id / event_type / seq / prev_event / payload / evidence_refs
事件词表：PREDICTION_CREATED · ACTION · RAW_EVIDENCE · OBSERVATION_RECORDED ·
         PREDICTION_EVALUATED · MODEL_UPDATED · GUARD_BLOCKED
硬性判据：seq 单调（非降）· prev_event 串成因果链（= 前一事件的 event_id）
         预测先于评估 · 评估先于更新 · MODEL_UPDATED 必须引用已评估的预测
```

**所以适配器的最小职责：**

1. **RAW_EVIDENCE 捕获** —— `pi.on('turn_end')` 的每个 `toolResults[]` 落一条带
   `seq`/`prev_event`/`event_id` 的 ledger 事件（**不是**现在的 `{id,kind,...}` 形状）
2. **`world_model` 工具** —— `customTools` 注册，支持
   `activate` / `predict` / `observe` / `evaluate` / `update` / `persist`
3. **守卫** —— 后果性变更无绑定预测则拒绝（含**别名键抗性**，见 `mind/README.md` 6.3）
4. **持久化** —— ledger（append-only）+ `current.json`，落在 `<stateDir>`

**不做**：briefing 编译（那是 `mind/canonical_compile.py`）、canonical 写入
（那是 `mind/u1_accept.py` 的治理路径，**agent 权限之外**）。

## 5. 验收方式（已就绪）

```bash
# 契约：六协议，被测适配器由调用方指定
BCC_PLUGIN=<path/to/pi-adapter.mjs> python mind/bcc_check.py
```

**测试台不绑定任何身体**（`simulate_body.mjs` 里没有任何适配器路径，
`bcc_check.py` 无默认值）—— 这正是为"再加一个身体"准备的。

⚠️ 但注意：`bcc_check.py` 驱动适配器的方式是 **`apply(ctx, opts)` + mock ctx**。

**这决定了适配器的导出形状，而且它有个干净的解法：**

> **适配器"说契约的接口"，身体"提供该接口的实现"。**

即：

```js
// pi/src/adapter/world-model.js —— 只认契约的五面，不认识 pi
export function apply(ctx, { stateDir, canonicalDir, mode, bodyId }) { … }
```

- **契约测试**：`simulate_body.mjs` 提供 **mock ctx** → 直接驱动适配器 ✅
- **真实运行**：pi 侧需要一个**薄薄的 ctx 垫片**，把 pi 的 seam 呈现成契约的五面：

| 契约面 | 垫片映射到 pi |
|---|---|
| `ctx.on('tools/result', fn)` | `pi.on('turn_end')` → 把 `event.toolResults[]` 转成 `fn(exec, result)` |
| `ctx.on('session/event', fn)` | `pi.on('session_compact' / 'model_select' / …)` |
| `ctx.get('agents')` | pi 的会话/代理查询 |
| `ctx.tools.register(tool)` | 推进 `customTools` |
| `ctx.tools.guard(fn)` | **接进 decide 链**（§3(b)：在 bootstrap 组装时把它作为第 10 个 `block` 点） |

**好处**：适配器本体**完全不知道 pi**，可被契约测试直接驱动；
pi 的耦合全集中在那个垫片里。**这也让 §3 的守卫问题变得局部** ——
只有垫片需要在 bootstrap 里构造，适配器本身不需要。

（DSH 侧其实也是这个结构，只是 cordis 的 `ctx` 恰好就长成契约要的样子 ——
因为契约就是从它推出来的。pi 需要显式写这层垫片。）

## 6. 现状与下一步

| 项 | 状态 |
|---|---|
| 契约（BCC-1 六协议 + 测试台） | ✅ 就绪（`mind/`） |
| briefing 挂载 | ✅ 已在 `host/` 实现 |
| RAW_EVIDENCE 源（`turn_end`） | ✅ 可用 |
| 工具注册（`customTools`） | ✅ 可用 |
| 守卫 seam | ✅ 已定：垫片在 bootstrap 接进 decide 链（§3b / §5） |
| 适配器导出形状 | ✅ 已定：`apply(ctx, opts)`（契约形状，不认识 pi） |
| **适配器本体** | ✅ **已写并验收** —— `pi/src/adapter/world-model.js` |
| **ctx 垫片** | ❌ 未写（pi 侧，把 pi seam 呈现成契约五面） |

### ① 已完成：`pi/src/adapter/world-model.js`

**契约验收（`BCC_PLUGIN` 指向它）：**

| 协议 | 结果 |
|---|---|
| 6.1 state_semantics | ✅（需 `--canonical`） |
| 6.2 event_ordering | ✅ 事件序 + 因果链 |
| 6.3 guard_semantics | ✅ **10/10 夹具**（含别名键抗性） |
| 6.4 tool_identity | ⚠️ 未测（诚实标注，非本适配器问题） |
| 6.5 persistence | ✅ 三项语义检查全过 |
| 6.6 schema_compat | ✅ |

**→ 两个适配器（DSH 与 pi）跑同一份契约、同样通过。**
这正是 BCC-1 存在的意义：**新增身体不改通用侧。**

**已纳入仓库回归**：`tests/test_wm_v031.py` 新增
`test_second_body_passes_the_same_contract`（**51 项全过**）。
**测试有效性已实测**：临时禁用 pi 适配器的守卫 → 该测试**失败**；恢复后通过。

##### 实现期间发现并修掉的一个 harness 缺陷

`simulate_body.mjs` 调 `execute` **没有 await**：

```js
const out = registeredTool?.execute(...);   // 可能是 Promise
if (out?.prediction_id) lastPid = out.prediction_id;
```

异步适配器（cordis 与 pi 都会 await `execute`）在这里返回 Promise →
`out.prediction_id` 恒为 `undefined` → `__last__` 永不解析 →
后续依赖该 id 的 op 静默作用在占位符上。
**表现像是"适配器坏了"，实际是测试台驱动不了异步适配器。** 已改为 `await`。

##### 两处必须做对才通过的设计点

1. **预测是适配器级、且启动时恢复** —— 预测是 canonical 状态（跨会话/切换存活）。
   若只放内存，新进程就不知道哪些预测还开着 → **门禁会放行上一个进程要求过预测的变更**
   （这正是 6.5 "杀死点"要防的）。现在 `current.json` 存**完整记录**而非仅 id
   （只有 id 无法重建绑定所需的 `intended_action`）。
2. **工具身份用身体声明** —— `TOOL_IDENTITIES`（`pi/src/adapter/world-model.js`）是
   **安全声明**，不是配置：未声明的工具会落到 fail-safe
   （后果性 + 默认不可逆）。表里只放有把握的条目；`multi_edit` **刻意不覆盖**
   （它是多文件编辑，共享分类器已判为不可逆，收窄它是安全决定）。

### ③ 已完成：ctx 垫片 + bootstrap 接线

**`pi/src/adapter/world-model-shim.js`** —— 把 pi 的 seam 呈现成契约五面：

| 契约面 | 垫片映射到 pi |
|---|---|
| `ctx.on('tools/result', fn)` | `pi.on('turn_end')` → 每个 `event.toolResults[]` 调 `fn(exec, result)` |
| `ctx.on('session/event', fn)` | `pi.on('session_compact' / 'session_compact_failed' / 'model_select')` |
| `ctx.get(service)` | 适配器不需要（返回 null） |
| `ctx.tools.register(tool)` | 收集 → 推进 `customTools` |
| `ctx.tools.guard(fn)` | 收集 → 由 decide 链调用 |

**★ 为什么不能在 `apply()` 时直接挂 handler**：pi 的 session 当时还不存在，
而且它会在 `session_new` / `session_switch` 时**重建**。
所以垫片**缓冲**注册，并暴露一个**扩展工厂**，在**每个新 session** 上挂载
—— 与其余 `pai-*` 扩展同一机制。

**三处接线改动（均 additive）**：

| 文件 | 改动 |
|---|---|
| `pi/src/adapter/index.js` | `createPiSession` 新增 `extraExtensions = []`，展开进 `extensionFactories` |
| `pi/src/bootstrap/host.js` | 创建垫片（在 `customTools` 注册**之前**）→ 工具进 `customTools`、工厂进 `extraExtensions`、守卫传给 `makeDecide` |
| `pi/src/bootstrap/decide.js` | `makeDecide` 新增 `worldModelGuard`，作为链上一个具名 `block` 点（在操作者 `pre_tool` 钩子**之前**：它确定且在进程内，而钩子可能起进程） |

**状态位置**：`stateDir = <instance>/world-model`（**身体自己的实例目录**，
不是 DSH 的 `~/.dsh/world-model/`）；`mode` 默认 `off`（记 ledger、不设门禁
—— 世界模型永远在场，OFF/CORE/FULL 只是仪式深度）。

**测试**（`pi/tests/bootstrap.test.js`，16/16）：

- `BCC-1: the world-model adapter is wired into the live session` ——
  扩展挂上、`world_model` 工具注册、状态目录创建
- `BCC-1: the world-model guard denies an unbound consequential mutation` ——
  经**垫片**（与 decide 链同一条路径）驱动守卫：core 下未绑定 → 拒；
  off 下 → 放行；read 工具 → 从不拦；无名工具 → fail closed

**踩到的坑**：垫片创建最初放在 `preToolGate` 之后，而 `customTools.push` 在它之前
→ `ReferenceError: Cannot access 'worldModel' before initialization`（TDZ），
`bootstrap.test.js` 12 项失败。**创建位置必须在第一个使用点之前**。

### 全部完成

| 项 | 状态 |
|---|---|
| ① 适配器本体 | ✅ 已写、契约验收通过 |
| ② 契约测试台验收 | ✅ 两个适配器均 PASS |
| ③ ctx 垫片 + bootstrap 接线 | ✅ 已接、有测试 |

**回路现在具备"能跑"的条件**：会话事件 → 观察 → 预测 → 门禁 → ledger → `mind/` 工具链。

---

## 8. ★★★ 端到端验证（真实 provider）

**前面所有验证都是"部件级"**：适配器过契约、接线有单测、守卫会拒。
**但没有一个证明回路在真实会话里产出证据。** 本轮用真实 provider
（本地 cpa 代理，`openai-completions`）补上。

### 证据 ①：真实会话 → ledger 里有 RAW_EVIDENCE

`pi/tests/world-model-e2e.test.js`（`PAI_WM_E2E=1` 时启用，同 `acceptance.test.js` 惯例）
驱动一次真实 turn（让模型用 `bash` 跑一条命令），然后**读 ledger**：

```text
ledger: 1 事件 @ <instance>/world-model/ledger/2026-09-23.jsonl
  seq=  1  RAW_EVIDENCE  layer=L0  prev=null  id=cfafc96d  tool=bash/bash  subject=bash
runs 目录: 1 行
```

断言：ledger 非空、`RAW_EVIDENCE` 存在、`seq` 单调、`prev_event` 串成因果链、
`layer=L0`、工具身份存在、`runs/<session>.jsonl` 同步写入。**全部通过。**

### 证据 ②：守卫在**真实 decide 链**上拦截

`PAI_WORLD_MODEL_MODE=core` + 让模型写文件（不先预测）：

```text
审计种类: … TOOL_CALL_ADMITTED×3, WORLD_MODEL_BLOCK×3, MISTAKE_LIMIT×10 …
首条拦截原因:
  [world-model] BLOCKED: write is a consequential action in core mode.
  Call world_model(op:"predict") with intended_action naming this tool and its target arguments.
note.txt 存在: False
```

**门禁真的拦住了，文件没有被写出来。** 且 `MISTAKE_LIMIT`（循环检测）也介入 ——
多层防线协同工作。

### ★★ 端到端抓到一个部件级测试抓不到的 bug

真实运行时里 `world_model` **每次调用都失败**：

```text
Cannot read properties of undefined (reading 'properties')
```

**根因：契约的工具接口与 pi 的工具接口不同。**

| | 契约（`simulate_body.mjs`） | pi 运行时 |
|---|---|---|
| 参数 schema | 不需要 | **必须** `parameters`（运行时读 `.parameters.properties` 描述给模型） |
| `execute` 签名 | `execute(input, exec)` | `execute(toolCallId, params)` |
| 返回值 | `{prediction_id}` | `{content:[{type:'text',…}], isError?}` |

**修法在垫片**（它本就负责呈现 pi 的形状）：包一层 ——
`parameters` 透传，`execute(toolCallId, params)` 内部调适配器的
`execute(params, {agent:{session:{id}}})`，再把结果包成 content block。
**适配器保持契约形状、两边都不认识。**

同时给适配器补了**契约级的参数 schema** `WM_PARAMETERS`
（op 枚举与字段名都是契约词表，不属于任何身体）。

**这个 bug 只可能被真实运行发现** —— 契约测试直接调 `execute`，
绕过了运行时的 schema 校验与签名约定。

**已加测试** `BCC-1: the shim exposes the tool in PI's shape, not the contract's`
（`bootstrap.test.js`，17 项）：断言 `parameters.properties.op` 存在、
`execute(toolCallId, params)` 返回 content block、未知 op 报 `isError` 而非抛出。

### 端到端验证结果

| 项 | 结果 |
|---|---|
| 真实 turn → ledger RAW_EVIDENCE | ✅ |
| 事件序 + 因果链 + L0 + 工具身份 | ✅ |
| `world_model` 工具真实调用 | ✅ 返回 `{ok:true, mode:'core', body_id:'pi', bcc:'BCC-1'}` |
| 守卫在真实链上拦截后果性变更 | ✅ 3 次拦截，文件未写出 |
| `bootstrap.test.js` | **17/17**（偶发文件级竞态频率 1/5，与基线一致） |

---

## 7. ★★ 动手前的阻断发现：适配器里有一大块是**身体无关**的

**准备写 ① 时量了一下参照实现，发现"适配器"其实不是纯粹的适配器。**

### 实测数据

| 项 | 值 |
|---|---|
| `dsh/world-model/world-model.mjs` 总行数 | **1392** |
| `apply(ctx, config)` 起始行 | **358** |
| **前 357 行里 `ctx` 出现次数** | **0** |
| 前 357 行里 `dsh` 出现次数 | 2（插件 `name` 导出、一个工具名别名） |
| 其中不可逆检测一块（词典 + `scanTokens` + `isIrreversibleArgs` + …） | **约 200 行** |

**即：前 357 行从不接触 `ctx` —— 它们是身体无关的机制**，
包括那 200 行**安全关键**的不可逆命令识别（包装器 / 解释器 / 破坏性命令词典 /
转义载荷 / 命令替换 / fork bomb / 管道穿包装 / unicode 归一 / 全位置签名扫描）。

### 而契约对这块的覆盖极弱

**BCC-1 的 10 条守卫夹具里，唯一的不可逆模式是 `rm -rf`。**
上面那 200 行里的其余路径（`sudo` 包装、`bash -c` 载荷、`$'\x72\x6d'` 转义、
`$(cmd)` 替换、fork bomb、`curl x | sudo sh`、全角破折号归一……）**契约一条都不测**。

### 于是问题成立

- **pi 适配器不能 import DSH 适配器**（那是身体到身体依赖，架构禁止）
- 所以那 357 行（含 200 行安全逻辑）**只能复制一份**
- 而契约**没有能力**让两份保持同步 —— 它只测 `rm -rf`

**→ 结果是：两份安全关键逻辑，靠一个只覆盖一个模式的契约约束。**
这正是 `app-world-model-loop.md` §2.5.7③b 说"漂移担忧不成立"时**没有覆盖到的那一半** ——
它论证的是**管道**（`mind/`，单一实现，不复制），
但**适配器里的机制**当时没被算进去。

### 方向（建议，未执行）

**把身体无关的那部分抽到身体无关的地方。** 候选：**`host/src/core/`** ——

| 理由 | 依据 |
|---|---|
| 它本来就是"harness 无关的契约与机制"（JS、**零外部依赖**） | `host/README.md:3` |
| **它已经装着世界模型的运行时存储** | `host/src/core/prediction.js`（自述"Prediction store — canonical world-model lifecycle"）、`host/src/core/observation.js` |
| 抽出去之后**每个适配器变薄**：只剩"把身体 seam 映射成契约五面" | 这才是"适配器"该有的样子 |

**抽出去之后 DSH 适配器自己也会变小** —— 它现在 1392 行，是因为**机制与 DSH 缝合在了一起**。

### 我因此**没有**动手写

写 ① 就得复制那 200 行安全逻辑。**在没定"它该住哪"之前复制，等于把漂移问题固化下来。**
所以本轮停在"量清楚 + 给出方向"，**没有写任何重复的安全逻辑**。

**需要的决定**：身体无关的适配器机制（事件词表 / 预测生命周期 / 守卫语义 /
不可逆分类）是否抽到 `host/src/core/`（或别处）。**定了它，① 才有正确的写法。**

### 已执行（本轮）

**决定：抽到 `host/src/core/`。** 判据用"它知道某个具体身体吗" ——
分类器**不知道**：输入是**契约级的工具名**与载荷，词典是命令词。

**已抽出的第一块：不可逆分类** → **`host/src/core/irreversible.js`**（281 行，26 个导出）。

| 验证 | 方法 | 结果 |
|---|---|---|
| **忠实性** | 逐行比对抽取块 vs 原文（去掉 `export ` 前缀） | **差异 0 行**（逐字节一致） |
| **自足性** | 检查是否引用块外定义的名字（`SCHEMA_VERSION`/`BRIEF_HARD_CAP`/…） | **无真实引用** → 自足 |
| 零依赖 | `host/tests/firewall.test.js` | **2/2 通过** |
| 行为 | `host/tests/irreversible.test.js`（新增 9 项） | **9/9 通过** |
| `host` 全套 | — | **323/324**（唯一失败是既有环境项 M144） |

> **先说一个我踩的坑**：我最初写了个"行为等价探针"——用真实适配器的守卫当基准，
> 逐载荷对比抽取模块的判断，得到 **24/24 一致**。**但那是空洞的**：
> 基准用的是工具 `exec`，而 `exec` 在 `IRREVERSIBLE_BY_DEFAULT` 里 →
> 守卫恒为 deny，两边都恒定，一致毫无意义。
> 换成 `edit`（后果性但非默认不可逆）后出现 3 处分歧 —— 而分歧其实来自
> **绑定**（适配器要求预测绑定到**参数**，不只是工具名），不是分类差异。
> **最终采用静态验证（逐行 0 差异 + 自足性检查）**，它比行为探针更强也更简单。
> **教训：构造出来的"一致"要先问基准是否非恒定。**

**同时发现一处刻意的宽检测**（已钉进测试，避免它在生产里被当成 bug）：
`flattenStrings` 会展平**对象的键**（防 `{rm:'-rf /'}` 形态），而 `command` 本身在
`DANGER_SUBS` 里 → **`{command: 'git status'}` 这类载荷会被判为不可逆**
（键名 `command` + 值里的 host 工具词 `git`）。
这是作者声明的偏向（误报只要求预测加 `irreversible:true`，安全方向），
**收窄它 = 往不安全方向走，需要独立决定** —— 所以只钉住、不改。

### 尚未抽出（下一步）

本轮只抽了**不可逆分类**这一块（安全关键、且最明确身体无关）。其余待定：

| 候选 | 是否身体无关 | 备注 |
|---|---|---|
| 事件词表 / `emit`（`seq`+`prev_event`+信封字段） | 是 | 但它在 `apply` 内部，与 seam 交织 |
| 预测生命周期（`P-` id、open/evaluated 状态） | 是 | `host/src/core/prediction.js` **已经在做这件事** —— 可能只需适配器改用它，而不是再抽一份 |
| `world_model` 工具的 op 语义 | 是 | `WM_PARAMETERS`（`world-model.mjs:300–357`）本身就是契约级参数表 |

> ⚠️ **`prediction.js` 那条要特别看**：`host/src/core/prediction.js` 自述是
> "Prediction store — canonical world-model lifecycle"，**它已经在 host/ 里做预测存储了**。
> 那么 DSH 适配器**自己又实现了一套**预测存储（`P-` id、open/evaluated）。
> **这可能是一个更大的重复** —— 待核实后再决定，不要凭猜测动。

### 核实结果：不是"重复"，是**三套并存的预测模型**，且其中一套从未被驱动

**预测在三个地方，三种 schema，互不相通：**

| # | 存储 | 位置 | id | 关键字段 | 状态机 | 谁写 | 谁读 |
|---|---|---|---|---|---|---|---|
| **1** | `host/src/core/prediction.js` | `<canonical>/predictions/index.json` | `pred-<uuid12>` | `claim` / `horizon` / `confidence` | `open → confirmed\|refuted` | **生产零调用**（见下） | pi 的 `loop.js`、上下文信封、`supervisor.js` |
| **2** | DSH 适配器自带 | `<stateDir>/current.json` | `P-<uuid8>` | `intended_action` / `expected_observation` / `falsifier` / `irreversible` | `open → evaluated` | 适配器 | **守卫**（绑定判定） |
| **3** | canonical | `current.yaml` 的 `world_model.open_predictions` | — | — | — | 治理路径（`u1_accept.py`） | `canonical_compile.py`（编进 briefing） |

**★ 关键事实：`PredictionStore.open()` 在生产代码里零调用者。**
全部调用点都在测试与 fixture 里（`host/tests/prediction.test.js`、`governance.test.js`、
`pi/tests/fixtures/m7-life1.js`、`dsh/tests/switch-rehearsal.test.js`）。
生产侧只有**读取**（`openPredictions()`）。

→ **所以第 1 套永远是空的** → 模型上下文里的 `<open-predictions>` 块**永远不渲染**。

> 这一点本规格此前已记录（§2.5.7② 附近："`PredictionStore.open()` / `close()` 全仓无调用者……
> 不是被关掉，是根本没有写入方"）。**本轮核实：结论成立，且它同时说明——
> 第 1 套是"设计好的、被测试覆盖的、但生产中从未被驱动的"存储**，
> 与本次会话反复遇到的模式同类（`world-model-runtime` 的加载门、
> `loopGovernance` 的三元条件，都是"实现了、测过了、没人用"）。

**为什么适配器没用第 1 套**：它**不能** —— DSH 插件是**单文件部署**，不能 import `host/`。
**pi 适配器可以**（`pi → host` 是允许的方向）。

##### ★★ 但这里撞上一个契约问题：**BCC-1 6.5 写死了 DSH 适配器的存储形状**

```python
cur = state / "current.json"
kp["open_prediction_survives_persist"] = cur.exists() and "P-" in cur.read_text()
kp["ledger_append_only"] = any(state.glob("ledger/*.jsonl"))
```

**它检查的是具体文件名与 id 前缀，不是语义。** 后果：

- 一个把预测存到 `host/` 第 1 套（`predictions/index.json`、`pred-`）的适配器 ——
  **语义完全正确，却会 6.5 失败**
- **即：6.5 把某一个身体的实现细节固化进了"身体无关契约"。**

这与 §2.5.9⑧ 发现的 6.4 是桩（硬编码 `True`）**同类**：
**六协议里并非每条都是语义的** —— 6.3 的别名缺口（已补）、6.4 是桩、6.5 泄漏实现。

**修法：已执行。** 6.5 改为**语义判据**，不再提任何文件名或 id 前缀：

| 检查 | 语义判据 |
|---|---|
| `open_prediction_survives_persist` | `predict` 返回的 id 出现在适配器自己的 `status` 输出里（问适配器，不读文件） |
| `append_only_log_exists` | 存在某文件，其**前次内容是后次内容的前缀**且变长 —— 只追加的定义，对状态目录整体判定，不写死路径 |
| `torn_tail_tolerated` | 把上一步识别出的追加日志尾部写坏后，`status` 仍成功且仍报告该预测 |

**顺带发现第三个问题**：原 `corrupt_tail_identified` 是**同义反复** ——
它追加一行非法 JSON，然后断言"非法 JSON 解析不了"，`ok_tail` 恒为 `True`，
**完全没有测适配器**。已替换为上面的 `torn_tail_tolerated`。

**验证**：DSH 适配器三项全过（`PASS: true`）；世界模型回归 **50 OK**；
`validate_repo.py --strict` errors=0；skill 门禁 PASS (22)。

##### 对本设计的影响

| 问题 | 结论 |
|---|---|
| pi 适配器该用哪套预测存储？ | **`host/` 的第 1 套** —— 它才接得到模型上下文，且 `pi → host` 允许 |
| 那 6.5 怎么办？ | **必须先修 6.5**（改成语义判据），否则正确的设计会被契约误判为失败 |
| 顺序 | **修 6.5 → 再写适配器**。这与 §7 的结论一致：契约先对，实现才有正确写法 |


### BCC-1 6.4：从"假通过"改为"未测"（本轮）

**原实现**：`results["tool_identity"] = {"pass": True, ...}` —— **无条件 True，没有任何检查**。
一个从未被验证的协议被报成绿色。

**为什么它不是"补个夹具"就能修好的** —— 机制端到端都不存在：

| 侧 | 现状 |
|---|---|
| **契约侧** | 缺夹具：需要驱动一个"改名后的工具结果"并读回事件的 `canonical_tool_id` |
| **身体侧** | 适配器发的是 `{canonical_tool_id: exec.name, body_tool_id: exec.name}` —— **两个字段同一个值**，等于没有映射 |
| **映射本身** | 需要身体声明 `{身体工具名 → canonical 名}` |

**已做的第一步（分类器侧）**：`host/src/core/irreversible.js` 新增
**`resolveToolId(name, aliases)`** —— 身体声明自己的工具身份，分类器据此解析。
**additive，无别名时行为完全不变**（有测试钉住）。

**为什么 6.4 不是学术问题**：分类器对**未知工具**一律 fail-safe 为
"后果性 + 默认不可逆"。实测 pi 的自有工具：

| pi 工具 | 在词典里？ | → 后果性 / 默认不可逆 |
|---|---|---|
| `memory_save` | 否（fail-safe） | true / **true** |
| `js_repl` | 否（fail-safe） | true / **true** |
| `job_spawn` | 否（fail-safe） | true / **true** |
| `env_set` | 否（fail-safe） | true / **true** |
| `edit` / `write` | 是 | true / false ✅ |
| `read` | 是 | false / false ✅ |

**即：没有 6.4，pi 的每个自有工具调用都会被要求带 `irreversible: true` 的预测** ——
安全但不可用。**6.4 是"让守卫在新身体上可用"的机制**，不是形式条款。

**顺带发现：两个词典互相矛盾，且只有一个名字撞车。**

`multiedit` 同时出现在 `IRREVERSIBLE_BY_DEFAULT` 与 `REVERSIBLE_EDIT_TOOLS` 里
（**交集仅此一个**）。`isIrreversibleByDefault` 先查第一个分支 → **静默按不可逆处理**，
与 `REVERSIBLE_EDIT_TOOLS` 的注释（"VCS 下可回滚，保持检测层"）相矛盾。
**安全方向是对的（不可逆），所以只钉住不改** —— 收窄它是安全决定，不是清理。
已加测试 `KNOWN contradiction` 让它可见。

### BCC-1 六协议现状

| # | 状态 |
|---|---|
| 6.1 / 6.2 / 6.3 / 6.6 | 语义 ✅ |
| 6.4 | **未测**（`pass: null`，机制端到端缺失）⚠️ |
| 6.5 | 语义 ✅（本轮前一轮改为语义判据） |

**总判定不再把未测项算作通过**（`pass: null` 被排除，且列入 `skipped`）。

---

## 9. ★★★ 顺带修好的两条**编译产物通道**（briefing / policy）

追查"协议该不该是 skill"时，发现 **harness 层两条产物通道是断的**。

### 共同的形状：编译器与读取者看不同的目录

实例布局（`host/src/core/instance.js`）：`soulDir = <root>/soul`、`canonicalDir = <root>/canonical`。

| 产物 | 谁声明 | 编译器 → 落点 | 读取者 | 现状 |
|---|---|---|---|---|
| **briefing** | `soul/manifest.json`（sections/caps/**compiler**/template） | `mind/canonical_compile.py` → **`<canonical>/briefing.md`** | `loadSoul` 读 **`<soul>/briefing/briefing.md`** | ❌ **断** |
| **policy** | （无） | **（无生成器）** | `host.js` 读 `<canonical>/instruction/generated.md` | ❌ **空** |

**briefing 的断法**：编译器写 canonical，加载器读 soul —— **没人搬运**，
而 soul 里只有 `briefing/template.md`（**输出契约**，不是产物）。
→ **模型拿到的 briefing 一直是空的。**

### 已修：briefing 从它的编译器写入的地方读

- `host/src/app/host.js`：`briefing: canonical.files['briefing.md'] ?? ''`
  （原来 `soul.briefing`）
- `host/src/core/loaders.js`：**删掉 `loadSoul` 的 `briefing` 字段** ——
  soul 携带的是 briefing 的**契约**（`manifest.briefing`），不是产物；
  一个去找产物的字段只能永远返回 null，而回退到 `template.md`
  会把**输出契约当成 briefing** 交给模型。

### 端到端验证（真实 provider）

`pi/tests/briefing-channel-e2e.test.js`（`PAI_WM_E2E=1`，同惯例）：

1. 实例的 canonical 里放一个**只存在于 briefing.md** 的 token
   （`entity_id: ENT-BRIEFING-PROBE-7F3A`）
2. 跑 `mind/canonical_compile.py` → 产出 `<canonical>/briefing.md`（含该 token）
3. 起真实 host，问模型："你上下文里的 `<briefing>` 说的 entity_id 是什么？逐字回答；
   没有 briefing 就回答 NO_BRIEFING"
4. **只取 assistant 自己的文本**（用户提示里也有 NO_BRIEFING，不能算）

```text
简报 token 出现在模型回复里: true
模型回复片段: ENT-BRIEFING-PROBE-7F3A
回复含 NO_BRIEFING: false
```

**模型逐字复述了只有 briefing 里才有的 token → 通道真的通了。**

> ⚠️ **验证方法本身也修了两次**：第一版把用户消息也算进"回复"（于是
> `NO_BRIEFING` 恒真、结论不可信）；第二版仍混入 user 角色。
> 最终按 `message.role === 'assistant'` 过滤 —— **判据必须只来自被考察的一方。**

### 尚未修：policy 的空槽

`instruction/generated.md` 仍无人生成（`policy.json` 是**机器可读**权威，已 attest；
`generated.md` 是**agent 可读**形态）。补它需要：
`soul/instruction/` 模板（含运行纪律，世界模型协议是其中一部分）+ `mind/` 生成器。
**这是内容决定（policy 里该写什么），本轮未做。**

### 验证

| 项 | 结果 |
|---|---|
| 简报通道端到端（真实 provider） | ✅ 模型复述出 token |
| `host` 全套 | 326/327（既有 M144 环境项） |
| `bootstrap.test.js` | 18/18 |
| 世界模型回归 | OK |
| `validate_repo.py --strict` | errors=0 |
| skill 门禁 | PASS (22) |


---

## 10. 提炼链的入口：`mind/wm_cycle.py`

**先纠正一句本规格此前写过的话。** 它曾把提炼链描述成"**由人手动逐步执行**"。
那是**把缺失当成了设计** —— 没有任何地方设计成人工，只是**没有入口**。

### 边界：自动化到提案为止

| 步骤 | 产出 | 可自动化？ |
|---|---|---|
| `lp_evaluator` | 学习指标 | ✅ |
| `distiller` | **`proposals/` only — never current.yaml**（自述） | ✅ |
| `canonical_compile` / `instruction_compile` | 两个编译产物 | ✅ |
| **`u1_accept`** | **canonical** | ❌ **治理行为**（`canonical_write: u1_governed`） |

**`wm_cycle.py` 跑完前三步，在 `u1_accept` 之前停下**，并在报告里写明停在哪儿、为什么。

> **一个自己接受自己提案的循环，就是自我授权** —— 而 `revision_rules` 禁止它
> （`no post-change self-grant of authority`）。
> 所以"自动化提炼链"的正确含义是**自动化到提案**，不是自动化到 canonical。

### 用法

```bash
python mind/wm_cycle.py --instance <instanceRoot> [--abstractor none|llm|file]
```

- `--abstractor none`（默认）→ distiller **ABSTAIN**。
  **这是真实结果，不是失败** —— 没有抽象器它不会凭空造模型。报告里明说这一点。
- `--dry-run` 只打印将执行的命令，不写任何东西（有测试）。

### 触发：信号是**重复**，不是单次事件，也不是时钟

**我在这里错了两次，第二次错得更根本。**

**第一次**：我定成"每小时跑一次"，理由是"调度器已经存在"
—— 伸手去拿手边有的东西，而不是去接正确的信号。

**第二次**：我改成"**一次证伪应当触发学习**"。**这也不对，而且错得更深。**

`world-model/theory/sources/02_解释贝叶斯更新`：

```
预测 Y=100   现实 Y=63
→ 一次失败可能只是噪声。

预测   现实
100     63
110     69
120     74
130     81
→ 出现了一个非常有价值的东西：残差结构。
   现实 - 模型预测 并不是随机噪声，而存在规律。
   这时候聪明的系统不应该继续说"再调一下参数"，
   而应该启动 MODEL FAILURE。
```

以及「世界模型里真正应该保存什么」——只存具备这些性质的：

**稳定性**（不是一次偶然现象）· **可迁移性**（不只适用于一次具体事件）·
结构性 · 区分性 · 行动相关性 · 可校准性

> "2026年9月9日某人晚上22:31说了一句话" —— **这通常不应该直接成为世界模型。**

**所以：一次证伪是噪声。触发模型修订的是「残差结构」—— 同一类失败反复出现、残差有规律。**

两种更简单的触发都是错的：

| 错误触发 | 为什么错 |
|---|---|
| "一次证伪" | **在噪声上触发** —— 单次失败不构成结构证据。这正是理论说的「过度抽象」失败模式（`一次失败 → "这个行业不行"`） |
| "时钟" | **在什么都不上触发**，且漏掉了要点：重要的是**重现**，不是流逝的时间 |

### 实际接法

**适配器按"同类"计次，只在同类重现时请求一次复查。**

阈值**没有默认值，是声明式的**：理论给了判据（"重复才是信号"）但**没给数字**，
而 adapter-pilot-evaluation-rubric §四 B-P1 明说「**不为 rubric 发明伪精确数字**」。
所以运行时读 `<canonicalDir>/learning-trigger.json` 的 `refutation_threshold`：

- **未声明 ⇒ 不触发**，并报告缺口（对应 rubric §七「未操作化前一律 UNMEASURED」）
- 该文件属 canonical，**由试点经 U1 治理路径声明，运行时永不写**

（此前这里是"默认 3"—— 那个 3 是本仓自己拍的，已移除。）

**它请求的是「复查」，不是「修订」** —— 是否真有结构，是 `distiller.py` 的判断
（它按 signature 分组、检查 independence）。**所以一次只有噪声的运行，会正确地什么都不产出。**

策略（"同类反复失败值得一看"）是 harness 级，住在适配器；
机制（这个身体怎么跑一次循环）是身体级，住在垫片背后的可选面 `ctx.learning`。

### 编译产物的触发：读路径依赖（这一半确实是定时的）

| 半段 | 性质 | 触发 |
|---|---|---|
| **compile**（briefing/policy） | **读路径依赖**：产物必须在会话读它之前就位 | 理想是宿主启动时；**但 `host/` 是零依赖 JS，不该获得 Python 依赖**，所以搭车在同一次运行上 |
| **distill**（proposals） | 重复驱动（见上） | 搭车 |

中间的空档由 doctor 的 `compiled_artifacts` 检查兜住。
