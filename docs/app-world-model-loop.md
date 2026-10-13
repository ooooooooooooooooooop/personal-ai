# app 层介入世界模型的回路规格

> ★ **先澄清一个概念（第十一轮修正）**：**世界模型不是插件，也不是某个身体的机制。**
> 世界模型 = W/V/U/L canonical 状态 + V0.3.1 理论 + schema，**harness 无关**。
> `dsh/world-model/` 只是 **dsh 身体上的适配器**；提炼管道（`distiller.py` 等）
> **也是 harness 无关的**（入参全是目录路径）。**换身体 = 换适配器，管道与状态不动。**
>
> ⚠️ **用词注（第十二轮）**：本规格此前多处写的"harness 无关的**机制**"是**措辞错误** ——
> 在本仓主流用法里 **机制 = 身体适配器**（`soul/README.md:3–4` 明写），
> 按定义就绑身体。准确说法是"harness 无关的**工具链**"。
> 且这个词在本仓是**歧义**的（`host/README.md:3` 用了相反的意思），详见 §2.5.7③e。
> 详见 [§2](#2-世界模型的进化回路设计中的对象需接入)。

> ⚠️ **读本文前先读 [§2.5](#25--前提失效这条回路在产品当前组合下跑不起来第八轮真实实例实测)。**
> 第八轮在真实实例上实测发现：**这条回路在本产品当前身体组合下从未运行过，且跑不起来**
> —— 因为**适配器**在 `dsh/`，而 app 的生产 profile 使 dsh fail-closed 不合格，只能跑 `pi`；
> `pi` 侧又没有对应适配器（其 `loopGovernance` 机制默认不装）。
> **§2 描述的是"设计中的回路"，不是运行中的事实。**
> 该发现把前置条件从一条变成两条（P1 让回路跑起来、P2 接入人的反应）。

> 性质：**回路规格**（定义系统要观察什么、观察怎么回流），不是界面设计稿。
> 所有"界面该长什么样"的判断在此**故意留空**——那应由观察数据决定，而非预先写死。
> 前置阅读：[`dsh/world-model/README.md`](../dsh/world-model/README.md)、[`soul/README.md`](../soul/README.md)、
> [`soul/briefing/template.md`](../soul/briefing/template.md)、[`soul/bootstrap/canonical/governance.yaml`](../soul/bootstrap/canonical/governance.yaml)
> 判据：`app/UI-PRINCIPLES.md`（该文件本身也受本文 §6 的可修正约束）

---

## 0. 出发点：三次被同一逻辑推翻

本规格的立项理由不是"界面不好用"，是**三轮设计判断被同一条逻辑连续推翻**：

| 轮次 | 判断 | 推翻理由 |
|---|---|---|
| 一 | 把 `后台任务`/`安全日志` 提到导航最前 | 那两页装的是引擎内部流水，不是人的处境 |
| 二 | 把 diff / 回执摊到结果旁，由人判断 | **改动大时人看不过来** |
| 三 | 筛出"值得看的"少数改动 | **筛出来人还是看不懂** |

共同错误：**把"技术上可得的东西"当成了"人需要的东西"**。
diff 可得、日志可得、回执可得 —— 可得 ≠ 该看。

推得的结论：

> **不给技术原料，给原料的换算结果。**
> 换算 = 可代劳（AI 读懂 diff、跑测试、判断"算不算推进"）
> 判断 = 不可代劳（"红了 → 撤"、"活没干完 → 让它继续"）

而这**恰好就是本项目世界模型已经在做的事**。本文的任务不是发明，是**把 app 层接进既有回路**。

> **§5.2 已查实：这条结论的技术基础完全具备。**
> 知道改了什么（`diff()`）、知道改动前是什么（`preSha` + `backup`）、
> 知道哪些危险（`op.op` + 有无 backup 兜底）、知道哪些属同一调用（`toolCallId`）——
> 四条全备，且同在 `fileops.js` 单一出口。**缺的从来不是数据，是换算。**

---

## 1. 已查证的现状（事实，非推测）

| # | 查证项 | 方法 | 结论 |
|---|---|---|---|
| 1 | `app/ui` 是否知道世界模型 | `grep 'world.model\|world_model\|soul\|briefing' app/ui/app.js` | **0 命中** |
| 2 | `app/server` 是否透出 | `grep -rn` 于 `app/server/` | **0 命中** |
| 3 | 通路卡在哪 | 读 `app/server/supervisor.js` | **卡在 supervisor**：已 `import { PredictionStore }`，第 511–516 行已调用 `openPredictions()`，但**仅用于 handoff 校验**，不透出 |
| 4 | `host/` 层 | `grep` 于 `host/src/` | **契约齐备**：`core/prediction.js`、`core/observation.js`、`core/governance.js`、`core/steering.js:5` 明确"of the world-model projection" |
| 5 | `RAW_EVIDENCE` 覆盖范围 | 读 `world-model.mjs:781–796` | 仅挂 `ctx.on('tools/result')` —— **只抓 AI 的工具结果** |
| 6 | 权威表 | 读 `soul/bootstrap/canonical/governance.yaml` | `owner` 持 4 scope：`task_goal` / `project_goal` / `execution_permission` / `durable_value` |

### 1.1 三条宪法级约束（来自 `governance.yaml`，不可绕过）

```
u0_constitutional:
  normative_authority_root: owner
  canonical_write: u1_governed
  revision_rules:
    - predict-before-change
    - no post-change self-grant of authority
    - no retroactive legitimization
normative_authorities:
  owner:
    scopes: [task_goal, project_goal, execution_permission, durable_value]
  note: epistemic reliability never derives normative authority
```

**最后那句注释是本文最重要的约束**：

> **认知可靠性永远不推导出规范权威。**

它判定了前几轮讨论中一类想法的死刑：**"AI 判断得更准，所以可以替人决定"——不成立。** 即使 AI 对风险的估计完全正确（epistemic reliability 高），也**不能因此获得决定权**（normative authority）。权威结构性地属于 `owner`。

三条 `revision_rules` 与既有实现一一对应：

| 规则 | 机制层对应 |
|---|---|
| `predict-before-change` | `tools.guard`：consequential mutation 无绑定预测不放行 |
| `no post-change self-grant of authority` | 即"闯祸方不能自评该不该回滚" |
| `no retroactive legitimization` | **事后追认无效**——补上了此前讨论遗漏的一条 |

---

## 2. 世界模型的进化回路（**设计中的对象**，需接入）

> ★★ **概念先澄清（第十一轮修正）：世界模型不是插件。**
>
> 本规格此前反复把"世界模型"与"`dsh/world-model/` 这个插件"混为一谈，**这是错的**。
> 按该目录自己的 README（`:5–6`）：
>
> > 插件是身体上的**适配器器官** —— 灵魂（W/V/U/L canonical 状态）**harness 无关**，
> > 本插件只认 `canonicalDir` / `stateDir` / `bodyId` 三个接口；**换 harness = 换适配器**。
>
> | 层 | 是什么 | 是否绑 harness |
> |---|---|---|
> | **世界模型** | W/V/U/L canonical 状态 + V0.3.1 理论 + schema | **不绑**（`soul/` 是发布锚，实例态在 `canonicalDir`） |
> | **提炼管道** | `distiller.py` / `hypothesis_search.py` / `lp_evaluator.py` / `u1_accept.py` / `canonical_compile.py` | **不绑** —— 已核实：入参全是目录路径（`--state` / `--canonical` / `--proposal` / `--out`），无任何 harness 依赖 |
> | **`world-model.mjs`** | DSH 身体上的**适配器**（事件捕获 / 守卫 / 租约 / briefing 挂载 / `world_model` 工具） | **绑 dsh** |
>
> **推论（重要）**：**管道无需移植。** 它读目录、写目录，不关心事件由哪个身体产生。
> 换身体只需换适配器 —— 这正是设计意图。

> ⚠️ **本节描述的是 dsh 适配器的设计**。第八轮实测（§2.5）证明它在产品当前组合下**从未运行**。
> 读本节时请把"既有"理解为"已被设计出来"，不是"正在运行"。
>
> ⚠️ **且下面的流程图会误导人**：它画成一条自动循环，但**中间那段提炼链是全手动的**
> —— 适配器从不调用 Python，没有任何自动化会去执行 `distiller.py` 等
> （证据见 §2.5.8③）。**把它读成"一条需要人逐步驱动的流水线"，不是"自动回路"。**

```
工具结果 ──RAW_EVIDENCE(L0, 机械捕获, 不过滤) ──────────┐
                                                    ↓
用户输入 ──INPUT_SEMANTICS 分类(V0.3.1 §6) ──→ W/V/U 候选
                                                    ↓
   distiller.py    : closed episodes → evidence packet → problem object
                     → 抽象器协议 → grounding validator → MODEL_PROPOSAL
                                                    ↓
   hypothesis_search.py : problem object → H4(8 算子库 + applicability)
                          → 统一 worker 契约 → 判别 probe → HYPOTHESIS_STATE_UPDATE
                                                    ↓
   lp_evaluator.py : Learning Progress 只读评估（closed episodes → metric vector）
                     无 canonical 写权
                                                    ↓
   u1_accept.py    : U1 governed apply —— 唯一 canonical 写者
                     proposal → canonical + rollback 备份 + provisional 状态
                                                    ↓
   canonical_compile.py : → briefing.md（七段, ≤8KiB, GENERATED 不可手写）
                                                    ↓
   挂载 systemPrompt.section ── 永远在场、每次 assemble 重读、跨 compaction 存活
```

### 2.1 `INPUT_SEMANTICS` 已有分类（V0.3.1 §6）

| semantic_type | 去向 | 持久化 |
|---|---|---|
| `EPISTEMIC_CLAIM` 对世界的断言 | → W 证据 | L0/L1 |
| `NORMATIVE_DIRECTIVE` 要求持久约束的规则 | → **查 `governance.normative_authorities`** | proposal |
| `AUTHORIZATION` 一次性行动许可 | → 仅本会话记录 | **不持久化** |
| `DURABLE_VALUE_STATEMENT` 持久价值 | → value proposal | 治理路径 |
| `PREFERENCE` 本地偏好 | → 局部 | 不持久化 |

> `NORMATIVE_DIRECTIVE` 的 `source_id` 与 `scope` **必须**取自 `governance.yaml normative_authorities` 已注册值（如 `owner/task_goal`），自造词汇会被拒。

### 2.2 briefing 七段结构与其裁剪优先级

| 段 | 标题 | 来源 |
|---|---|---|
| 0 | Identity | entity_id / lineage / freeze |
| 1 | **Unresolved First** | 未决预测、open loops —— **先放未决项** |
| 2 | Reliability Alerts | 已知残差、可靠性告警 |
| 3 | Current Best Models | 当前最优 + support refs + 最强反证 + **falsifier/revision trigger** |
| 4 | Corrections & Superseded | 纠正史与被取代模型 |
| 5 | Task-Relevant Values / Constraints | 任务相关价值/约束 |
| 6 | Retrieval Pointers | 检索指针（指向 canonical，不复制内容） |

**溢出裁剪保留顺序**：

```
unresolved > alerts > task-relevant models > corrections > values > settled
```

第 3 段的 `falsifier` 是**结构性要求**：每条当前最优模型必须带推翻钥匙。这直接支持 §6。

---

## 2.5 ★ 前提失效：这条回路在产品当前组合下**跑不起来**（第八轮，真实实例实测）

**这一节推翻本规格此前的一个隐含前提。§2 描述的回路是"需接入的对象"，
但实测发现：它在本产品当前的身体组合下从未运行过，且当前组合下跑不起来。**

### 2.5.1 实测：四个状态目录全空

在本机真实实例（`~/.personal-ai/instance`，`runtime.json` 显示 app 于
`2026-09-22T06:53` 启动过）实测：

| 位置 | 应有内容 | 实测 |
|---|---|---|
| `instance/canonical/observations/` | `observations.jsonl` | **目录存在，无文件** |
| `instance/canonical/predictions/` | 开放预测 | **空** |
| `~/.personal-ai/world-model/canonical/{history,proposals}` | 模型提案/历史 | **空** |
| `~/.dsh/world-model/{ledger,runs}` | 世界模型 ledger/runs | **只有 `.probe`** |

`.probe` 是 `dsh/world-model/world-model.mjs:540–541` 在插件初始化时写的
**可写性检查**（`:534` 注释：stateDir 不可写 = 审计基础设施失效 → fail closed）。
**即：插件初始化过，但一个事件都没记录。**

`backups/` 与 `recycle/` 也是空的（0 件），`fileops.jsonl` 不存在，
`.pai/verify.json` 不存在。

### 2.5.2 根因：**适配器**只在 dsh 侧，而 app 只能跑 **pi 身体**

> 用词修正（第十一轮）：下文的"回路"应读作"**适配器**"。
> 世界模型本身与管道都 harness 无关（§2 澄清），**缺的是 pi 侧的适配器**。

这是**结构性的**，不是配置疏忽。完整证据链：

**① dsh 侧适配器已存在且已启用。**
`dsh/world-model/` 内含 `world-model.mjs`（适配器）+ `distiller.py` 等（harness 无关管道）。
适配器**已装好且已启用**：`~/.dsh/profiles/web/plugins/dsh-world-model/` 存在，
`~/.dsh/profiles/web/cordis.patch.yml:54–57`：

```yaml
- id: dsh-world-model
  name: ./plugins/dsh-world-model/world-model.mjs
  config:
    mode: core
```

**② 但 app 跑的是 pi。**
`instance/runtime.json` → `adapter_id: "pi"`。
`app/server/bodies.js:48` → pi 身体入口 = `pi/bin/pai-channel.js`。

**③ dsh 身体在 app 的生产 profile 下**不可选**（fail-closed）。**
`pi/src/bootstrap/facts.js:45–49` 定义生产必备能力，三项**均 `negotiable: false`**：

```js
export const REQUIRED_BODY_CAPABILITIES = [
  { capability: 'final_post_extension_guard', negotiable: false },
  { capability: 'durable_jobs',               negotiable: false },
  { capability: 'provider_request_audit',     negotiable: false },
];
```

而 `instance/registry.json` 中 dsh 自报：

```
final_post_extension_guard: "unsupported"
known_limitations: { "final_post_extension_guard":
  "no post-extension composite guard; tasks requiring it fail-closed on this body" }
```

`host/src/core/eligibility.js:38–57`：`negotiable === false` 的缺失 → `failClosed.push(...)`
→ `eligible: failClosed.length === 0` = **false**。头注释明写：
> `failClosed — non-negotiable correctness invariant can't hold. Refuse.`
> `NEVER "degraded but allowed".`

**所以 dsh 是 fail-closed 不合格，pi 是唯一合格身体。**
（pi: `final_post_extension_guard: supported`。）

**④ pi 自己的回路机制**默认不装**。**
pi 侧对应物是 `loopGovernanceExtension`（`pi/src/adapter/loop.js`），
它才是携带 `predictions` / `observations` 的那一环。但：

> 注：这里说"默认不装"是**现象**。**精确的机制诊断见 §2.5.5** ——
> 根因不是"某个开关该开"，而是**外层条件作用域过宽**：
> 它把两件"无前提也该做"的事（`observations` / `predictions`）
> 捆在了两件"有前提才做"的事（`continuation` / `fallbacks`）上。

`pi/src/bootstrap/host.js:882`：
```js
loopGovernance: (taskRequirements.length || fallbackCfg.chain.length) ? {…} : null
```

- `:270` `taskRequirements = []`（默认空）
- `:359` `fallbackCfg = { chain: [] }`，且 `instance/model-fallbacks.json` **不存在**
- `pi/bin/pai-channel.js:56` 生产入口调 `startHost({instanceRoot, workdir, delegationCommand})`
  —— **没有传 `taskRequirements`**

→ `(0 || 0) ? {…} : null` → **`loopGovernance = null`**。

`pi/src/adapter/index.js:170–171`：
```js
...(audit && loopGovernance
  ? [loopGovernanceExtension({ ...loopGovernance, contextEnvelope, audit, workdir })]
  : []),
```
→ **扩展根本不安装。**

**⑤ 结论**：

> **进化回路装在 dsh 身体里，而 dsh 在 app 的生产 profile 下 fail-closed 不合格；
> app 只能跑 pi，而 pi 的回路机制默认不装。
> 所以：本产品当前状态下，进化回路在两个身体上都没有运行。**

### 2.5.3 这对本规格的影响（必须修正的三处）

| 此前表述 | 修正 |
|---|---|
| §5.3 "数据已在 `canonicalDir/observations/observations.jsonl`（append-only、跨 compaction、跨 body）" | **读通路存在（结论仍成立），但文件不存在 —— 没有数据可读。** "桥的对面有东西"这个前提不成立 |
| §3.5.7 "客观后果（`verify_fail`）已在 observation stream 里" | **仅在 verifier 配置时成立**（`.pai/verify.json`），而本机不存在该文件 → 实际从未产生过一条 |
| §2 "世界模型既有的进化回路（需接入的对象）" | **应改为"设计中的回路"** —— 它是 dsh 身体的设计，不是运行中的事实 |

### 2.5.4 因此前置条件从一条变成两条

原规格的前提是"回路在跑，只缺人的那一半"（§3 G2）。**实测不成立。**
现在有**两个独立前置**：

| # | 前置 | 性质 |
|---|---|---|
| **P1** | **让 pi 侧真正产出 observation**（§2.5.5 给出精确修法） | 机制层，一行改动 |
| **P2** | **把人的反应接进回路**（§4 的桥） | 本规格的主题 |

**P1 不解决时，P2 做的桥没有对端。**
但 P2 的设计（§4）**仍然成立** —— 它是"桥"，桥的两端都需要，先修哪端是排期问题不是设计问题。

### 2.5.5 P1 的精确诊断：不是"默认开启"，是**外层条件作用域过宽**

> 本节修正 §2.5.2④ 里"默认开启"这个不准确的说法。**"默认开启"暗示"把这个功能打开"，
> 但实际情况是：开关把两件"无前提也该做"的事，捆在了两件"有前提才做"的事上。**

**① 那个条件本来在回答什么问题。**

`bootstrap/host.js:882` 的 `(taskRequirements.length || fallbackCfg.chain.length)` 回答的是
"**有没有活给 continuation governor 或 fallback chain 干**"。这两件确实有前提：

- `continuation` 需要 `taskRequirements`（`:884` `new ContinuationGovernor({ requirements: taskRequirements })`）
- `fallbacks` 需要 `fallbackCfg.chain`

**这两个前提是合理的。**

**② 但扩展装了四件事，另外两件不需要任何前提。**

`pi/src/adapter/loop.js`：

| 参数 | 用途 | 前提 |
|---|---|---|
| `continuation` | 治理式续跑 | 需要 `taskRequirements` ✓ |
| `fallbacks` | provider 降级链 | 需要 `fallbackCfg.chain` ✓ |
| **`observations`** | **`:127` `observations?.record({kind:'tool_result'})` —— 每个工具结果都进 observation stream，在 `turn_end` 里，每轮都跑** | **无** |
| **`predictions`** | **`:219` `predictions ? predictions.openPredictions() : []`** | **无** |

**这两件与"有没有 task requirements / fallback 链"毫无关系。**
其中 `:127` 正是 §5.3 读通路所依赖的**唯一写入点**。

**③ 四件事在扩展内部全都做了空值守卫 —— 扩展不需要那个开关。**

```js
:154   if (continuation) { … }
:167   const chain = fallbacks?.chain ?? [];
:168   if (!chain.length || …) return;          // 空链直接返回
:219   const open = predictions ? predictions.openPredictions() : [];
:127   observations?.record({ … })              // 可空
:135   if (observations && PATH_TOOLS.has(…))
:227   observations: observations ? observations.list().length : 0
```

**扩展是照着"四个参数任意子集都可能为空"写的。**

**④ 而且外层两个条件，内层各自都已经处理了 —— 外层纯属多余。**

- `continuation` 那半：`:884` **已经有内层守卫** `taskRequirements.length ? new ContinuationGovernor({…}) : null`
- `fallbacks` 那半：`:168` **空链直接 return**

> **即：`(A.length || B.length) ? { 四件事 } : null` 里，A 和 B 各自都已在内层处理。
> 外层唯一的效果，是把四个功能一起关掉。**

**⑤ 三种修法，推荐度不同。**

| 方案 | 做法 | 评价 |
|---|---|---|
| **(a) 删掉外层三元** | `loopGovernance: { continuation: taskRequirements.length ? … : null, predictions, observations, fallbacks }` | **推荐。一行删除，逻辑上正确**（扩展已防御性编写） |
| (b) 收窄条件 | 让 `predictions`/`observations` 无条件传入，条件只包 `continuation`/`fallbacks` | 与 (a) 等价 —— 因为内层守卫已存在 |
| (c) 生产入口传 `taskRequirements` | 改 `pai-channel.js` 传个非空值 | **最差**。把"让观察流跑起来"挂在语义无关的参数上，**等于用一个假前提去满足真需求** |

**⑥ 但必须说清一个边界：修好这个 ≠ 回路跑起来了。**

| | pi 侧 | dsh 侧 |
|---|---|---|
| observation 写入 | `loop.js:127`（`tool_result`） | `world-model.mjs:783`（`RAW_EVIDENCE`） |
| observation 消费 | `envelopes.js:135` → **注入模型上下文**（`recent(20)`） | `distiller.py` → `MODEL_PROPOSAL` → `hypothesis_search.py` → `lp_evaluator.py` → `u1_accept.py` → `canonical_compile.py` → `briefing.md` |
| **提炼 / 进化** | **无** | **有** |

**pi 侧只有"写入 + 注入上下文"这半。**
（已核对：pi 侧的 `distill` 是 `memoryStore.distill()`，**记忆**蒸馏，与世界模型的 `distiller.py` 无关。）

**所以修 (a) 之后**：pi 开始产出 `observations.jsonl`（§5.3 读通路的数据源有了），
**但"从数据提炼模型"的那半仍在 dsh 侧，pi 没有。**
本规格的桥（P2）要接的是**人的反应**，接进 pi 侧的 observation stream —— 这条通了。
但若目标是"完整的自动进化"，还缺 distiller 那一半在 pi 侧的对应物 —— **那是另一件事，不在本规格内。**

**⑦ 附带发现一处不一致（小）。**

`loop.js:101` 用的是 `observations.record(`（**无 `?.`**），而 `:127` 用的是 `observations?.record(`。
`:101` 在 `hintDir` 内，`hintDir` 只在 `:135` 的 `if (observations && …)` 下被调用，
**当前安全**。但这不一致 —— 若将来有人从别处调 `hintDir`，会抛。

### 2.5.6 一处需要确认的能力声明矛盾

`registry.json` 为 **pi** 声明 `loop_observability: "supported"`，
但 §2.5.2④ 证明生产组合下 `loopGovernanceExtension` 不安装。

**两种可能，未查**：
- (a) `loop_observability` 指的是别的观测面（如 audit / 事件流），与 `loopGovernanceExtension` 无关
- (b) 该能力声明在生产组合下**名不副实**

**这是未查证项，不得据 (b) 下结论。** 但它值得单列 ——
若为 (b)，则"注册表声明 supported 而实际不装"是一类更普遍的缺陷
（能力声明与实际装配脱钩），影响面大于本规格。

### 2.5.7 路线三的真实规模 —— **不是"移植管道"，是"给 pi 写适配器"**

> ★ **第十一轮修正**：本节原标题写"把提炼半移植到 pi / 不是移植，是四件事"。
> **前提错了。** 管道无需移植（§2 澄清：管道入参全是目录路径，harness 无关）。
> 真实工作量是**一个适配器**，不是四件事。

**结论：管道原样不动；缺的是 pi 侧的适配器 —— 它要产出管道能读的事件。
而 pi 侧目前产不出这种事件（缺三层，见②）。**
（原写"分解为四个子任务"—— 第十一轮修正为**两个**，见③。）

#### ① distiller 的输入是什么（已查实）

`distiller.py:84–105` `iter_closed_events()` 读 `stateDir/{runs,ledger}/*.jsonl`，
只取 `event_type` 属于特定词表的事件（`:57–68`）：

```
PREDICTION_CREATED / PREDICTION_EVALUATED / RAW_EVIDENCE / OBSERVATION_RECORDED /
TOOL_RESULT / INPUT_ROUTED / MODEL_CREATED / MODEL_UPDATED / META_DECISION /
VALUE_DECISION / PROBE_PLANNED
```

`build_packets()`（`:146–150`）把它们按 `signature_of()` 分组，
**要求 ≥2 组独立证据才形成一个 packet**，且 `MODEL_OUTPUT` 回声"计数但不作支撑"。

**核心：它吃的是"预测的生命周期"**（`PREDICTION_CREATED` + `PREDICTION_EVALUATED`），
不是"工具调用流水"。

#### ② pi 侧缺三层（已查实）

| 缺什么 | 证据 |
|---|---|
| **没有创建预测的入口** | pi **没有 `world_model` 工具**（`grep world_model pi/` 零命中）。`PredictionStore.open()` / `close()` **全仓无调用者**（只有 `openPredictions()` 读）。→ 这就是 `canonical/predictions/` 为空的原因：**不是被关掉，是根本没有写入方** |
| **数据形状不匹配** | pi 的预测存成对象索引（`predictions/index.json`，`{id,claim,status,horizon,confidence,actor,tags,createdAt,closedAt,outcome,bindingCount}`）；distiller 读的是**事件流**，需要 `event_type` / `event_id` / `seq` / `prev_event`（因果链）/ `access`（访问等级）/ `layer`（L0/L1）/ `schema_version` / `theory_version`。pi 的 `ObservationStore` 只有 `{id,kind,subject,detail,actor,at}` —— **上述字段一个都没有** |
| **报错指向不存在的工具** | `host/src/core/governance.js:456` 的 repair 文案：`open a prediction via the world-model surface and pass predictionId` —— 而该 surface 在 pi 上**不存在** |

注：预测门禁仅在 `rules.requiresPrediction === true` 或调用方传了 `args.predictionId` 时触发
（`:450`）。`soul/` 里未配置 `requiresPrediction`，故当前不触发。
**但这是潜在的坑**：模型一旦传 `predictionId`，门禁就要求该预测存在，而它无法存在。

#### ③ 子任务（**第十一轮修正：原写"四个"，其中"移植管道"一项是错的**）

> ★ **修正说明**：原表第 3 项写"移植管道 ≈1500 行 Python → JS"。
> **这是错的** —— 管道**已经 harness 无关**（入参全是目录路径），**无需移植**。
> 原第 4 项"保住宪法约束"也**不是移植任务** —— 约束由管道自己持有，
> 只要还跑同一份 Python，约束自动保持。

| # | 子任务 | 动什么 | 规模 |
|---|---|---|---|
| **1** | **给 pi 一个世界模型工具面**（让模型能创建/评估预测） | 模型可见的工具集 | 中。**是产品决定**——改变模型能用哪些工具 |
| **2** | **让 pi 产出管道能读的事件**：补 envelope（因果链 `seq`/`prev_event`、`access` 分级与污点传播、`layer`、`schema_version`） | 现有观察/预测存储 | **大。这是真正的全部工作量** |
| ~~3~~ | ~~移植管道~~ | —— | **不存在。管道不动，原样跑** |
| ~~4~~ | ~~保住宪法约束~~ | —— | **不需要单独做。跑同一份 `u1_accept.py` 即自动保持** |

**即：路线三的真实工作量 = 写一个 pi 侧适配器（产出正确形状的事件）。
管道、宪法约束、提炼逻辑全部复用现有实现。**

#### ③c ★ 关键：pi 适配器要满足什么，**已有正式规格** —— BCC-1

> 第十二轮追问"既然是无关的工具链为什么要放里面"，查证后得到一个更好的答案：
> **它不是"碰巧无关的工具链"，而是"一份带正式跨身体契约的机制包"。**

`dsh/world-model/` 里有一个此前未被本规格注意的文件：**`bcc_check.py`**，
其文件头自述（`:2`）：

> `bcc_check.py — BCC-1 Body Compatibility Contract test harness (V0.3.1 §10)`
> `- body B: a python reference implementation of the same contract`

**BCC = Body Compatibility Contract（身体兼容契约）。**
它定义六条协议（`bcc_check.py` 的六个分节）：

| # | 协议 | 含义 |
|---|---|---|
| **6.1** | **State Semantics** | **同一份 canonical 放在两个 body 目录下 → 投影必须相等** |
| 6.2 | Event Ordering | 真实 ledger 的事件序 |
| 6.3 | Guard Semantics | 真实插件 vs python 参照体，同一批 fixture |
| 6.4 | Tool Identity | body 改名不改变 canonical 身份 |
| 6.5 | Persistence | 杀死点（kill points）下的持久性 |
| 6.6 | Schema Compatibility | 1.0 fixture → migrate → verify → rollback 必须字节一致 |

**6.1 就是"多身体等价性"本身。** 所以：

> **"harness 无关"不是代码的偶然性质，而是 V0.3.1 §10 里一条正式的、
> 带参照实现与一致性测试的契约。**

**这解释了"为什么 Python 放在里面"**：这个包不是"一个 DSH 插件"，
而是**「世界模型机制 + 它的 DSH 适配器 + 契约参照实现」**。
三者被**同一份契约与同一份数据格式**绑在一起，与 harness 无关。
部署时只取 `.mjs`（`cordis.patch.yml:4`：*"把 `world-model.mjs` 复制到
`<profile>/plugins/`"*），Python 留在仓库由操作者运行 —— 这也与实测吻合
（profile 里只有 `.mjs` + `package.json`，见 §2.5.8①）。

**因此路线三的性质再次改变（变得更好）：**

| 此前说法 | 修正 |
|---|---|
| "给 pi 写一个适配器"（开放设计问题，需自己定义事件形状） | **不是开放问题。pi 适配器要满足什么，BCC-1 六协议已经写好了。** |

**→ 正确的下一步不是"设计 pi 适配器"，而是"读 BCC-1（V0.3.1 §10）并按它实现"，
然后跑 `bcc_check.py` 验证 pi 侧满足六协议。**

**仍存的诚实保留**：`bcc_check.py` 验证的是**插件**对契约的满足，
以及插件 vs 参照体的一致性；它**不直接验证"管道能否消费非 DSH 产出的 ledger"**。
后一条由 6.1/6.2 的语义**蕴含**，但本轮未见直接的测试证据。
**所以"管道可原样复用"仍是推断，只是从"代码看起来可以"升级为"契约要求它必须可以"。**

#### ③d ★★ 用户追问"应该只有 DSH 适配器才放进 dsh 文件夹吧 / 是不是设计本身有问题"

**实测结论：放置确实不符合本仓自己的约定；但根因是"分类法缺一层"，不是放置随手放错。
而它有一个真实的、可命名的代价 —— 且本轮已亲历。**

**证据一：`world-model` 是 17 个包中唯一含 `.py` 的**

| 包 | 顶层文件类型 |
|---|---|
| 其余 **16** 个 `dsh/*` 包 | 只有 `mjs`/`js` + `json` + `md` + `yml` |
| **`world-model`** | **多出 `py`** |

其余包严格符合 `AGENTS.md:15` 的层 ③ 定义（插件源码 + `cordis.patch.yml` + README）。
**`world-model` 是唯一例外。**

**证据二：`soul/` 里没有任何可执行代码**

`soul/` 全部是 `.yaml` / `.json` / `.md` / `.jsonl` ——
它是**状态 + schema + 模板 + 引导骨架**，不是放代码的地方。

**所以分类法里没有它的位置：**

| 层 | 定义 | 管道能放吗 |
|---|---|---|
| ③ `dsh/<name>/` | DSH 用户级插件 | ✘ 管道不是 DSH 插件 |
| ⑥ `soul/` | 可携带认知状态（无代码） | ✘ 不是状态，是代码 |
| ⑦ `host/` | 中立控制宿主，**零依赖、禁 import 任何身体** | ✘ 它是 Python，且不是控制宿主 |

**→ 结论：这是分类法的缺口（没有"harness 无关的机制"这一层），
作者只能把它放在主要消费者旁边。所以不是随手放错，但确实是"无处可放"的将就。**

**而它的代价是真实且可命名的：**

1. **误导读者** —— 本轮已亲历：我从"它在 `dsh/` 下"推出"世界模型属于 dsh"，
   **连错三轮**。这不是假设性风险，是已发生的事实。
2. **`AGENTS.md` 无法描述它** —— 没有名字的东西无法被规则约束，
   所以它既没被评审（§2.5.8②），也没被校验器覆盖。
3. **★ 会造成"身体到身体"的依赖** —— 若 pi（另一身体）需要这条管道，
   就得从 `pi/` 去引用 `dsh/`。而本仓架构**刻意避免身体间依赖**：
   `host/` 被机械禁止 import 任何身体（`firewall.test.js`），身体只依赖 `host/`。
   **`pi → dsh` 会破坏这个方向**，且这正是路线三会造成的后果。

**这是本节最重要的产出**：路线三不只是"写个适配器"，
它会**把一个潜藏的层违反变成实际的层违反**。所以在动手前，需要先回答
"这条管道住在哪里" —— 否则等于在错误的层上再加一个消费者。

**可选的修法（**属治理决定，本规格不预设**）**：

| 方案 | 说明 |
|---|---|
| **(a) 给机制一个独立的家** | 例如新增一个 body 无关的顶层层（与 `soul/` 平级：soul 放状态，机制放代码），`dsh/` 与 `pi/` 各自只留适配器 |
| (b) 把管道并入 `soul/` | 让 `soul/` 从"只有状态"变成"状态 + 维护状态的工具"。**但这改变了 `soul/` 的既有定义**（目前明写无代码） |
| (c) 维持现状 + 只补文档 | 在 `AGENTS.md` 层 ③ 加一行说明"部分包附带 harness 无关工具链"。**最便宜，但不解决第 3 条代价** |

**(a) 与 (b) 是结构决定，需你或维护者定；(c) 只是止血。**
**本规格的立场：这个决定应发生在写 pi 适配器之前**，因为适配器放哪取决于管道住哪。

#### ③e ★ "机制"这个词，仓库自己用了两个相反的意思

用户问"机制是什么东西"。查证后发现**这个词在本仓是歧义的**，
而这正是本轮多次混淆的根源之一。

| 出处 | 原文 | "机制"指 |
|---|---|---|
| `AGENTS.md:7` | "机制层：Skill 包 + MCP 发行包 + **DSH 插件包** + 质量脚手架" | **绑身体的封装层** |
| `soul/README.md:3–4` | "与机制层（`dsh/world-model/` 等插件/skills/MCP）配对 —— **机制是身体适配器**，soul 是可随身体迁移的 W/V/U/L 认知状态" | **身体适配器**（明确） |
| `host/README.md:3` | "Personal AI 的中立控制宿主：**harness 无关的契约与机制**" | **harness 无关**（相反） |

**主流用法是前两者**：机制 = **身体适配器**，与"认知（soul，可迁移状态）"配对。
**`host/README.md` 的用法是反向的。**

**→ 本规格此前的措辞"harness 无关的机制"跟的是少数派用法，
在主流定义下是自相矛盾的**（机制按定义就是绑身体的）。应改为
"harness 无关的**工具链**"。这是本规格的措辞错误，已在 §2 澄清块修正。

**用主流定义重新表述路线三的结构问题：**

| | 是什么 | 管道算吗 |
|---|---|---|
| **机制** | 身体适配器（插件/skills/MCP） | ✘ 管道不绑身体 |
| **认知（soul）** | 可随身体迁移的 W/V/U/L 状态 | ✘ 管道是代码，不是状态 |
| **？** | **维护认知状态的工具链** | ✔ **但这一格不存在** |

**→ 分类法缺的那一层，在仓库自己的词汇里可以这样命名：
"维护认知状态的工具链" —— 它既不是机制（适配器），也不是认知（状态）。**

#### ③f ★ 而这个代价**已经在文档里发生了**（不是路线三才引入的）

`soul/README.md:39`（采用者使用，第 3 步）：

> 3. 跑 **`dsh/world-model/canonical_compile.py`** `--canonical <dir>` 生成首个 briefing

**认知层（`soul/`）的采用流程，直接叫采用者去跑一个身体插件目录里的脚本。**

**即：反向跨层引用已经写进了公开文档**，不是路线三才产生的新风险。
（严格说这是文档指令而非代码 import，但效果相同：布局迫使跨层伸手。）

**所以 §2.5.7③d 里"路线三会创造第一个身体间依赖"要修正为：**
**这类反向引用已经存在；路线三只会把它从"文档里的一个指令"变成"代码里的一个依赖"。**

#### ③g ★★ 概念决定（第十二轮，用户两次纠正后）

**用户纠正一**：这不是工程问题，是**概念设计**问题。
**用户纠正二**：判据是"**它属于 soul 吗**"——不属于就不能放，与实现成本无关。

**我此前的错误**：我用了"开一段例外比加一层便宜"作为理由。
**这是拿实现成本去裁定概念归属 —— 判据错了。** 下面按概念重答。

##### 一、它属于 soul 吗？—— **不属于**

`soul/` 的自我定义（`soul/README.md`）：

| 出处 | 原文 |
|---|---|
| `:1` | "soul/ — Personal AI **可携带认知状态**" |
| `:3–4` | "机制是身体适配器，**soul 是可随身体迁移的 W/V/U/L 认知状态**" |
| `:9–12` | "本目录每个文件都是经 declassification 链产出的**衍生物**……或本来就是**为公开编写的模板**" |

**soul 的定义 = 可携带的认知状态（内容）。**
而它的准入规则只列了两类：**脱敏衍生物**、**公开编写的模板**。

**管道是"产出这个状态的机器"，不是这个状态本身，也不是它的模板。**

> ⚠️ 我此前说"开一段例外"—— **那是把定义当成了可以绕过的障碍。**
> 那条规则不是官僚门槛，它**就是"soul 是什么"的陈述**。
> 给 soul 开例外放代码，等于**改掉 soul 的定义去容纳一个不属于它的东西**。
> 这是本末倒置。

**故：不属于，所以不能放。到此为止，与成本无关。**

##### 二、那它是什么？—— 认知层缺的第三个功能位

`AGENTS.md:7` 把仓库分成两层，**认知层现有两个成员**：

> 认知层：`soul/` **可携带认知状态** + `host/` **可执行控制宿主**

于是三个功能位是这样的：

| 功能位 | 内容 | 回答的问题 | 现有成员 |
|---|---|---|---|
| **状态** | 可携带的认知内容 | 它**信什么** | `soul/` |
| **控制** | 执行门禁、租约、交接 | 它**许什么** | `host/` |
| **更新** | 由证据产生认知的处理逻辑 | 它**怎么变** | **（缺）** |

**管道就是第三格：「更新」。** 它既不是状态（不是 soul），也不是控制
（不做门禁/租约/交接），更不是适配器（不绑身体）。

**所以缺的不是"往哪塞"，是分类法本身少一格。**

> 我此前把"新增一层"当作"更贵的方案"而否掉 —— **同一个错误（用成本裁定概念）。**
> 如果它是独立的一格，那么**分类法必须为它命名**，这才是正解。

##### 三、这一格的判据（供命名与归位使用）

- **不绑身体**：入参全是目录路径；8 个工具提到 `dsh` 的只有 2 处且都是默认值
  （`bcc_check.py:41` 找 node 的默认路径；`migrate_v031.py:283–284,383–384` 骨架默认值）
- **不是状态**：它是可执行代码，soul 的准入规则不含代码
- **不是控制**：不做门禁、不持租约、不做交接
- **与 schema 同生命周期**：`migrate_v031.py` 以 **schema 版本**命名；8 个工具中 7 个引用 `schema`

**最后一条给出归位原则**：**这一格与 schema 同版本演进，所以它与
`soul/schema/` 必须能一起发布、一起被引用 —— 但同居一处不等于同类。**

##### 四、结论

| 问题 | 答案 |
|---|---|
| 它属于 soul 吗？ | **不属于。** |
| 所以能放 soul 吗？ | **不能。** |
| 那放哪？ | **需要一个新格：认知层的「更新」功能位。** |
| 我此前的决定 | **作废**（用了错误判据）。 |

**本规格不再就"叫什么名字/放哪个目录"给出方案** ——
那是**这个仓库的概念设计决定**，应由你（或维护者）在承认"缺一格"之后定义。
本规格只负责把判据摆清楚：**不绑身体、不是状态、不是控制、与 schema 同生命周期。**
#### ③b 这也修正了"两份实现会漂移"的担忧 —— 该担忧不成立

原 §2.5.7⑤ 担心"pi 移植一份 + dsh 保留一份 = 同一套宪法约束两处实现，会漂移"。

**修正后不存在这个问题**：正确的架构是**两个适配器 + 一份管道**，
不是"两份实现"。这正是 README 的设计意图（"换 harness = 换适配器"）。
**唯一实现是管道（Python），适配器是每身体一份且不持有约束逻辑。**

#### ④ 路线一不是路线三的替代，是它的第 1 步

**路线一（删掉 `host.js:882` 外层三元）产出的 observation stream，正是子任务 2 的起点。**
所以二者不冲突：**可以先做路线一，立刻开始攒数据，同时设计后三步。**

#### ⑤ 一个必须提前定的事：两份实现会漂移

若 pi 侧移植一份、dsh 侧保留一份，则**同一套宪法约束（唯一写者、规范权威、proposal 路径）
有两处实现**。约束在两处漂移 = 治理不一致，且很难测出来。
**建议：先定"谁是 SSOT"** —— 要么 pi 侧成为唯一实现（dsh 侧改为薄适配），
要么反过来。**不要两份并行维护。**

#### ⑥ 一个与 README 的矛盾（需存疑，未解）

`dsh/world-model/README.md:28` 称端到端"**已在真实会话验证**"
（episodes→packet→problem→worker 抽象→validator→MODEL_PROPOSAL→H4→probe→
HYPOTHESIS_STATE_UPDATE→晋升→U1 accept→canonical→briefing 跨会话生效）。

**第十轮实测：这句话在本机无法证实。但"跑通"要分两层看，两层结论不同。**

#### 第一层：作为独立程序 + 模拟体 —— **是，跑通了**

`python -m unittest tests.test_wm_v031 -v` → **50 个测试全过**（14 秒）。
覆盖：distiller fixture A–H、治理租约（唯一写者 / fork 检测 / U0 不可写）、
hypothesis_search（冲突包→problem object、H4 算子）、input semantics
（epistemic→W、外来规范源被拒、preference 不持久化）、LP 只读隔离、
迁移（字节级回滚）、回归（守卫拦截未绑定变更、跨会话预测合并）。

**且测试确实驱动了真实插件** —— `tests/test_wm_v031.py:85` 通过
`subprocess.run([NODE, ..., "simulate_body.mjs", scen])` 跑真实 `world-model.mjs`，
`:875` `bcc_check.check_all(None, with_node=True)` 跑 BCC-1 六协议。
**所以插件本身能工作，管道健全。**

> 依赖注记：测试需要 `yaml`（`canonical_compile.py:28` 导入）。
> 托管 Python 3.13.12 无此模块，需用系统 Python 或先装 `pyyaml`。

#### 第二层：作为插件在真实 DSH 会话里端到端 —— **本机零证据**

实测方法与结果：

| 检查 | 结果 |
|---|---|
| 全部 DSH 会话扫描（逐帧解压 `.jsonl.zstd`） | **17 个会话目录 / 1.6 GB / 约 160 万行 → 世界模型关键词 0 命中** |
| 插件安装时间 | `cordis.patch.yml` 与插件目录均为 **2026-09-16 11:38** |
| 实质会话的时间范围 | **2026-08-18 – 09-14** —— **全部早于插件安装** |
| 装后唯一的会话 | `--C-Desktop-personal-ai--`（09-18），**解压后仅 4 行**（会话头 + 描述） |
| 插件自身状态 | `ledger/`、`runs/` 仅 `.probe`；**无 `body-state.json`**（它只在状态变更时创建） |
| canonical | `{history,proposals}` 空 |
| pilot/研究机路径 | `WORLD_MODEL_HOME` 未设；`~/personal-ai-state`（legacy pilot 路径）**不存在** |

> **技术注记（否则会得出错误结论）**：DSH 会话是**多帧 zstd**（一个文件内 409 帧）。
> Node 的 `zstdDecompressSync` 只解**第一帧** —— 直接用它会得到"每文件 1 行"的假象。
> 正确做法：按 magic `28 B5 2F FD` 切帧后逐帧解压。
> 本结论是用正确方法复算过的。

#### 结论：README 那句可能指别的机器，但**集成层确实未被真实会话验证过**

两种可能，本机无法区分：
- (a) 验证发生在**另一台"研究机"** —— 代码明确预留了这个概念
  （`world-model.mjs:361`：`研究机用 WORLD_MODEL_HOME 显式指向 pilot`）
- (b) 验证即指第一层的模拟体测试，README 的"真实会话"表述过强

**无论哪种，对路线三的关键含义是：**

> **50 个测试 + `simulate_body.mjs` 覆盖的是"管道"和"插件对协议"，
> 不覆盖"插件在真实 harness 里的接线"** —— 即
> `RAW_EVIDENCE` 从真实 `tools/result` 捕获、`briefing.md` 挂载为
> `systemPrompt.section`、守卫挂到真实 `tools.guard`。
> **这些集成点在模拟体里是被模拟的，不是被验证的。**

**而路线三要写的适配器，正是这个集成层**（对应 `world-model.mjs` 那 1391 行的位置）。
所以：**移植前应先在 dsh 侧跑一次真实会话**，
否则等于把"未验证的集成层"翻译成第二份"未验证的集成层" —— 风险翻倍且更难定位。

**这不否定路线三，只是给出正确的第一步：先在 dsh 侧跑通一次真实会话，拿到真实
`ledger/` 与 `canonical/proposals/`，再决定移植。**

### 2.5.8 插件从哪来 + ★ "自动进化"这个前提需要修正

**用户问"哪来的插件"。查证结果如下，并由此暴露一个比来源更重要的事实。**

#### ① 文件来源：本仓库，逐字节相同

已装插件目录 `~/.dsh/profiles/web/plugins/dsh-world-model/` 只有**两个文件**：

| 文件 | 大小 | mtime |
|---|---|---|
| `world-model.mjs` | 96934 | 2026-09-15 20:22 |
| `package.json` | 283 | 2026-09-14 07:55 |

与仓库 `dsh/world-model/` 下同名文件 **sha256 完全相同**
（`ae2fae6115a42d7a5afaa47fa995b206fc7cd54cc348dc7e7cebebddd4471c3d`）。

**即：它是本仓库 `dsh/world-model/world-model.mjs` 的一份拷贝。**

**但仓库里有 12 个文件，只拷了 2 个** —— Python 管道（`distiller.py` / `u1_accept.py` /
`canonical_compile.py` / `hypothesis_search.py` / `lp_evaluator.py` / `migrate_v031.py` /
`bcc_check.py`）**一个都没装进 profile**。

mtime 特征：文件保留 09-15 20:22，而**目录**是 09-16 11:38
→ 这是一次**保留 mtime 的拷贝**（`shutil.copy2` 行为），
仓库的 `skills/dsh-config-sync/scripts/sync_dsh_config.py` 正是用 `shutil.copy2`。
**但该 skill 未提及 world-model，故无法确证是它所为。**

#### ② 注册是**本地手改的，且未回流到仓库**

| 位置 | 是否含 world-model |
|---|---|
| 实际 profile `~/.dsh/profiles/web/cordis.patch.yml` | **含**（`:54–57`，`mode: core`） |
| 仓库骨架 `dsh-config/profiles/web/cordis.patch.yml` | **不含** |
| 仓库骨架 `dsh-config/profiles/web/plugins/` | **不含** |

**所以：这次注册是一次本地动作，仓库里没有任何东西能复现它。**

值得注意：仓库骨架那份 patch 里**有明确的登记纪律** ——
它记录了 2026-08-28 的一次审计，对四个未注册插件写下
"KEEP-inactive — they have no repo-side source and may be WIP;
**do not register without a deliberate behavior-change review**"。
**即：插件注册本应有评审并回流到骨架，而 world-model 的注册没有。**
它是一次本地实验，不是产品部署。

#### ③ ★ 更重要的事实：插件**不调用** Python —— 管道是全手动的

已装插件的 import 只有四个：

```js
node:fs / node:path / node:os / node:crypto
```

**没有 `child_process`，没有 `spawn`，没有网络。**
全仓 grep `distiller.py` / `u1_accept.py` / `canonical_compile.py` 的调用方：
**只有文档、注释、以及本规格自己 —— 没有任何自动化调用它们。**

插件里提到 Python 的地方全是**注释和提示文案**，例如
`world-model.mjs:760` 的告警字符串：
> `canonical newer than compiled artifacts — re-run canonical_compile.py`

**"re-run" 是给操作者看的 —— 由人手动去跑。**

**因此本规格的一个核心前提必须修正：**

| 原表述 | 修正 |
|---|---|
| §2 把 `RAW_EVIDENCE → distiller.py → … → briefing.md` 画成一条**回路**（暗示自动循环） | **不是自动回路。** 插件只做：捕获 `RAW_EVIDENCE` → `ledger/`、执行守卫、持有租约、挂载 briefing。**中间那段提炼链（distiller → hypothesis_search → lp_evaluator → u1_accept → canonical_compile）此前无入口、只能逐步手跑 —— 那是缺入口，不是设计。** |

**这解释了一个此前无法解释的现象**：无论插件跑没跑，`canonical/proposals/` 都必然是空的
—— 因为**没有任何自动化会去写它**。

**对 §4 规格的影响（重要且正面）**：

原本"人"在回路里的角色是"提供反应"（§3 G2）。现在要加上第二个角色：
**"手动驱动提炼链"**。这两件事都是"机器做不了、必须人做"的。
所以 app 层要承载的**不止是"桥"**，还可能包括**"把这条手动链变成一个可触发的动作"**。

**这不改变 §4 的设计方向（app 是呈现 + 授权接口 + 桥），但扩大了它的必要范围。**
具体该不该做、做成什么形态，**属于新的设计问题，本轮不预设结论。**

---

### 2.5.9 ★★★ 回路的**运行时协议**存在，但它的入口条件指向一个不存在的 Gate

**用户允许新增格后，继续查证时发现了一件比此前所有断点都更上游的事。**

#### ① 回路的运行时协议已经写好了 —— 在 `skills/world-model-runtime/`

`README.md:63` 与 `skills.json` 都登记了这个 skill，其 `SKILL.md` 定义**九环执行协议**：

```
WM_ACTIVATE → STATE_RESTORE → CURRENT_MODEL → PREDICTION_CREATED →
ACTION/QUERY → OBSERVATION_RECORDED → PREDICTION_EVALUATED →
UPDATE_APPLIED/NO_UPDATE → STATE_PERSISTED
```

**且它是写给 agent 执行的**（`SKILL.md:8`："**你正在执行**一个带持久世界模型的任务"）。
它还完整定义了 Episode schema 与 Prediction schema —— **正是提炼管道所读的事件词表**。

**→ 这修正了第十一轮"管道是全手动的"这一说法**：
更准确的说法是 —— **回路由 agent 按此协议驱动**，Python 工具链负责把产物治理化落地。
"手动"指的是"没有自动化调度"，不是"没有协议"。

#### ② ★ 但这个 skill 声明它由 `AGENTS.md World Model Gate` 判定后加载 —— **该 Gate 不存在**（已修复）

| 检查 | 结果 |
|---|---|
| `skills.json` 登记 | `world-model-runtime`，`"tier": "conditional"`，描述含"由 **AGENTS World Model Gate** 判 OFF/CORE/FULL 加载" |
| `AGENTS.md` 中 "World Model Gate" 出现次数 | **0**（AGENTS.md 里的 "Gate" 全指**发布门禁**，与此无关） |
| 全仓提及该 Gate 的文件 | **4 处引用 / 0 处定义**：`SKILL.md` frontmatter、`SKILL.md` 模式段、`agents/openai.yaml` 的 `default_prompt`、`skills.json` |

**→ `tier: conditional` 的加载条件永不被满足 → 该 skill 按自身声明的规则永不加载。**

##### ②b 根因诊断（第十三轮补）：**把"加载条件"与"运行模式"混成了一件事**

引用的四处都在说"**判 OFF/CORE/FULL 后加载**"。但这是两件不同的事：

| | 是什么 | 该在哪 |
|---|---|---|
| **加载条件** | 这个 skill 该不该被用 | **`description`**（条件加载发生在加载之前，判据必须不加载就能读） |
| **运行模式** | 用了之后做多深（OFF/CORE/FULL = **仪式深度**，不是开关） | skill 正文的模式段，**加载后自判** |

**混写的后果**：判据被挂到一个"判模式"的外部 Gate 上，而那个 Gate 从未写出来 ——
于是加载条件变成一个悬空指针。

##### ②c 另一层缺陷：`conditional` 这个 tier **本来就没有语义定义**

`docs/skill-contract.md` 只列了 `tier` 的**取值**（core/conditional/optional），
**没有定义 `conditional` 意味着什么、判据该写在哪**；
`validate_repo.py:347` 也只校验取值合法性，**不校验所声明的条件是否可解**。

**所以悬空引用不会被任何门禁发现。** 这不是一个 skill 的笔误，是**契约本身的空缺**。

##### ②d 已修复（本轮）

| 文件 | 改动 |
|---|---|
| `skills/world-model-runtime/SKILL.md` | frontmatter 去掉 Gate 引用，保留"用于…/不用于…"；模式段改为**两件事分开写**（加载条件在 description，形式化深度自判），并加注区分插件侧静态 `config.mode` |
| `skills/world-model-runtime/agents/openai.yaml` | `default_prompt` 去掉"按 Gate 判定" |
| `skills.json` | 描述与 `SKILL.md` 对齐（补回被截断的"用于…/不用于…"，去掉 Gate 引用） |
| `README.md:63` | skill 表该行去掉"按 Gate 判定" |
| `docs/skill-contract.md` | **新增 `tier` 语义段**：定义三档含义 + **规定 `conditional` 的判据必须写在 description 且自足可判** + 把本次事故作为反面例子 + 明确"加载条件 ≠ 运行模式" |

**修复后**：全仓 "World Model Gate" / "Gate 判定" 引用 **0 处**；
`validate_repo.py --strict` errors=0；skill 质量门禁 PASS；世界模型回归 50 OK。

#### ③ 于是"回路从未运行"有**四个独立断点，分布在四层**

此前逐个找到，现在可以并列：

| # | 层 | 断点 | 位置 |
|---|---|---|---|
| **1** | **运行时协议入口** | ~~skill 的加载条件指向不存在的 Gate~~ → **✅ 已修复（§2.5.9②d）** | `skills.json` ↔ `AGENTS.md`（缺） |
| 2 | 适配器 | `world-model.mjs` 装在 dsh profile，实例却跑 pi；pi 侧无适配器 | `~/.dsh/profiles/web/` ↔ `runtime.json`（**见 §2.5.9⑦：只剩这一条，且它不是二选一**） |
| **3** | **pi 侧观察写入** | ~~`loopGovernance` 因三元条件恒为 null，扩展不安装~~ → **✅ 已修复（§2.5.9⑤）** | `bootstrap/host.js:882` |
| 4 | 治理化提炼 | 无任何自动化调用（协议未加载 → 无人驱动） | `mind/*.py` |

**#1 是最上游的**：它是整个协议的入口条件。
**#4 其实是 #1 的后果** —— 协议不加载，自然没人驱动工具链。

#### ⑤ ★ 断点 #3 的修复（第十四轮续）

**改法：删掉 `pi/src/bootstrap/host.js` 的外层三元，让扩展无条件安装。**
内层的 `continuation` 守卫（`taskRequirements.length ? … : null`）与 `fallbacks` 的
`if (!chain.length) return` 已经各自处理了那两件有前提的事。

**改前的行为核实**（确认删掉是安全的，不是想当然）：

| 参数 | 无前提时的行为 |
|---|---|
| `continuation` | 内层守卫 → `null`；扩展里 `if (continuation)` 跳过 |
| `fallbacks` | `fallbacks?.chain ?? []` → 空 → `if (!chain.length …) return` |
| `predictions` | `predictions ? predictions.openPredictions() : []`（空值安全） |
| `observations` | `observations?.record(…)` / `if (observations && …)`（空值安全） |

**装上后会开启什么**（逐 hook 核实，不是只看目标那一处）：

| hook | 无 continuation/fallback 时的实际行为 |
|---|---|
| `turn_end` | **记录 `tool_result` 观察**（目标）+ U15 子目录提示 + 累积 transcript |
| `agent_start` | 重置 transcript / 重新武装 latch（纯内存） |
| `agent_end` | 内层守卫后**直接返回**，无副作用 |
| `session_before_compact` / `session_compact` / `session_compact_failed` / `model_select` | **只写审计**（`COMPACT_BEFORE`/`COMPACT_DONE`/`COMPACT_FAILED`/`MODEL_SELECT`） |

**即：开启的是"观察记录 + 审计可见性"，没有行为副作用。**

**顺带修的一处可观测性**：`startHost` 此前只把扩展**数量**写进 `HOST_STARTED` 审计
（`extensions_loaded`），数量无法区分"装了但四件事都在"与"根本没装"。
现把 `extensionsResult` 加入返回对象，使调用方与测试能**按名字**断言。

**回归测试（已验证它真能拦住回归）**：
`pi/tests/bootstrap.test.js` 新增
"loop governance is installed without taskRequirements or a fallback chain" ——
在生产形态（不传 `taskRequirements`、无 `model-fallbacks.json`）下启动 host，
断言扩展列表含 `pai-loop-governance`。

> 该断言写对之前踩了一个坑：`extensionsResult.extensions` 的条目用 **`path`** 标识，
> 内联 factory 注册为 **`<inline:pai-loop-governance>`**（没有 `name` 字段）。
> 首次按 `name` 断言得到空数组，误判为"扩展没装"。
>
> **测试有效性已实测**：临时把旧三元放回去 → 该测试**失败**；恢复后通过。
> （不做这一步的话，"测试通过"可能只是断言写松了。）

**验证结果**：`bootstrap` 14/14、`loop-governance` 8/8、`m8-wiring` 32/32、
`channel-facade` 33/33 全过；`validate_repo.py --strict` errors=0。

**修复过程中又暴露三件事（都已处理，记录以免重犯）：**

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| **a** | 边界测试报 `host.js: not installed` | `pi/tests/boundary.test.js` 的 import 扫描正则**不跳过注释**，我写的注释里 `from "not installed"` 被当成说明符 | 改写注释避开该字面形状，并在注释里留提示。**自查法：用测试的正则扫一遍刚改的文件** |
| **b** | `paths.test.js` 的符号链接用例失败 | 本沙箱的文件系统垫片让 `symlinkSync` **静默无效**（不抛异常、链接不存在），而该用例的守卫只 `try/catch` 防抛异常 | 守卫补 `lstatSync(link).isSymbolicLink()` 检查。**判定归属：该测试只 import `paths.js`（未改），不引用 `host.js`** |
| **c** | `validate_repo.py --strict` 因**记忆文件**报 2 个"链接缺失" | 校验器的本地链接正则（匹配 markdown 的方括号加圆括号形式）扫全部 `*.md` 且**不跳过代码围栏**；我在记忆里引用的那条正则里，"右方括号紧接左圆括号"的字符组合被当成了伪链接。且 `.workbuddy-ai/` **未跟踪却未被 `EXCLUDED_DIRS` 排除** | 把 `.workbuddy-ai` 加入 `EXCLUDED_DIRS`（与 `.claude`/`.grepai`/`.taskflow`/`Users` 同类：本地、未发布）。**发布门禁不应取决于未提交的本地文件**。另注：本表自身也踩了同一个坑（写正则字面量会造伪链接），已改写为描述式 |

**另发现一处既有偶发失败（非本次引入）**：
`bootstrap.test.js` 的首个用例偶发报
`asynchronous activity after the test ended` + SQLite `statement has been finalized`。
**已用干净 HEAD 版对照实测：干净版同样 5 次中 1 次失败** → **既有竞态**，与本轮改动无关。
（对照时注意：`git checkout` 会一并丢弃工作区里**既有的未提交改动**，须先备份。）

#### ⑥ ★ 修复 #3 之后暴露的下游问题：观察流的热路径读取（已修）

**修好 #3 意味着观察流开始写入 —— 于是它喂的那条读取路径第一次真正生效。查证后发现它有真实的规模问题。**

**读取路径**：`host/src/app/host.js:69` 的 `contextProvider()` 调 `observations.recent(20)`；
而 `contextProvider` 被作为**函数**传给 `contextEnvelopeExtension`，
后者在**每次 `context` seam** 调用它（`pi/src/adapter/index.js:88–95`）→ **每轮一次**。

**而 `recent()` 原本是 `list().slice(-20)`，`list()` 全量 `readFileSync` + 逐行 `JSON.parse`。**
文件每轮都因新观察而变大 → `(size, mtimeMs)` 指纹**每轮都失配** → **每轮一次 O(整文件) 的同步读取**。

**实测（构造真实行格式，测量 cache miss 下的 `recent(20)`）：**

| 行数 | 文件 | 原耗时 | 修复后 |
|---|---|---|---|
| 1,000 | 120 KB | 1.3 ms | **0.8 ms** |
| 5,000 | 601 KB | 3.1 ms | **0.8 ms** |
| 20,000 | 2.4 MB | 24.6 ms | **0.7 ms** |
| 100,000 | 12 MB | 66.2 ms | **1.1 ms** |
| 300,000 | 36 MB | **189.8 ms** | **3.5 ms** |

**原实现是超线性的，且 `readFileSync` 同步阻塞事件循环 —— 每轮一次。**
在 30 万行时是每轮 ~190ms 的全局停顿。

**修法：`recent()` 改为尾部窗口读**（只读文件末尾一个有界窗口，丢弃起始处的半行；
行大小无契约上限，故窗口不足时按 4 倍扩张）。
**`list()` 刻意保持全量扫描** —— 它是"总数"路径（`loop.js:227` 的压缩审计取 `.length`），
冷路径且需要精确计数。

> 作者其实**已意识到**这个危险：`observation.js` 的注释写着
> "the context provider calls recent() EVERY turn, and the loop extension records
> one row per tool result — an uncached full-file scan per turn turns a long-lived
> instance into a synchronous read of an ever-larger JSONL on the hot path"，
> 并加了指纹缓存作为缓解。**但缓存在"每轮都变"的实际情形下每轮都失配**，
> 所以缓解不完整 —— 本次补上尾部读。

**回归测试**（`host/tests/observation.test.js` 新增 3 项）：
大文件下 `recent()` 的正确性（覆盖"窗口起点落在行中间"）、
行大于初始窗口时的窗口扩张、缺文件/空文件与 `list()` 仍报精确总数。

> **测试有效性已实测**：临时去掉窗口扩张逻辑 → "grows the window" 用例**失败**；恢复后通过。

**验证**：`host` 全套 315 项 / 314 过 / 1 失败 ——
失败项为 `M144 unicode_mode`（符号渲染，本环境 `auto` 解析为 ascii），
**该测试文件不 import 观察模块，与本改动无关**（既有环境失败）。

#### ⑦ ★★ 断点 #2 不是"二选一"：其中一条路已被设计关闭（第十六轮续）

此前把 #2 写成"需产品决定：让 dsh 可选，还是给 pi 补适配器"。
**查证后发现两条路并不对称 —— 第一条是关闭的。**

**为什么 dsh 走不通**：`dsh/adapter/index.js` 的能力表写着

```js
final_post_extension_guard: 'unsupported', // no post-extension guard — migration's reason
```

且该文件头部说明写得更直接：

> What this adapter does NOT do: pretend DSH has a post-extension composite guard
> (it doesn't — **that gap is why the migration exists**).
> Tasks that require `final_post_extension_guard` non-negotiably fail-closed on dsh.

**即：DSH 没有 post-extension 复合守卫这个 seam，
而这正是本仓从 dsh 迁到 pi 的原因。** 该能力由 app 以 `negotiable: false` 硬要求
（`pi/src/bootstrap/facts.js:46`），所以 dsh 侧 fail-closed。

**"让 dsh 可选"= 让 DSH 具备一个它没有的 seam** ——
那要改上游 `@deepseek-ai/dsh`（第三方 npm 包），**不在本仓能力范围内**；
而且等于回退这次迁移的**理由本身**。

**→ 结论：不是二选一。#2 的可行解只有一条 —— 给 pi 补适配器。**

**而这条路的目标是明确的、不需要设计的**：BCC-1 六协议（§2.5.7③c）已经规定了
"一个适配器必须满足什么"。而且**测试台已经就绪**：
`mind/bcc_check.py` + `mind/simulate_body.mjs`（§2.5.10 已把它改成 body 无关、
被测适配器经 `BCC_PLUGIN` 传入）—— 正是为"再加一个身体"准备的。

**本规格不在此设计 pi 适配器**（那是实现工作，且需先读 BCC-1 原文 V0.3.1 §10）。
本节只把"这条路要满足什么、用什么验"钉住。

#### ⑧ ★ 找不到 BCC-1 原文 —— 但发现契约本身有个缺口（已补）

**"去找 BCC-1 正式条文"这条路走不通**：V0.3.1 理论文档**不在本仓**。
仓库只引用它的节号（§7 briefing / §9 LP / §10 BCC-1），文档本体应在私有 pilot 仓
（`soul/README.md` 说明公开仓内容来自私有 canonical 的脱敏链衍生物）。

**但 `mind/bcc_check.py` 就是契约的可执行定义** —— 它才是决定通过与否的东西。
于是改做一件更有用的事：**从测试台反推"pi 适配器必须满足什么"**。

##### 适配器接口（从 `simulate_body.mjs` 反推，可复核）

```js
export function apply(ctx, { stateDir, canonicalDir, mode, bodyId })
```
`ctx` 必须提供：

| 面 | 签名 | 用途 |
|---|---|---|
| `ctx.on('tools/result', fn)` | `fn(exec, result)`，`exec = {name, agent:{session:{id}}, arguments}` | RAW_EVIDENCE 捕获 |
| `ctx.on('session/event', fn)` | `fn({id}, {type})` | 会话事件 |
| `ctx.get('agents')` | 服务查找 | 代理/会话查询 |
| `ctx.tools.register(tool)` | `tool.execute(input, exec)` → `{prediction_id?}` | `world_model` 工具面 |
| `ctx.tools.guard(fn)` | `fn(exec)` → `undefined`=放行 / 字符串=拒绝 | 后果性变更门禁 |

**六协议的判据**（摘要，详见 `mind/README.md`）：
6.1 同一 canonical 在两个 body 目录下投影相等；6.2 `seq` 单调 + `prev_event` 因果链 +
预测先于评估先于更新（事件词表：`PREDICTION_CREATED`/`ACTION`/`RAW_EVIDENCE`/
`OBSERVATION_RECORDED`/`PREDICTION_EVALUATED`/`MODEL_UPDATED`/`GUARD_BLOCKED`）；
6.3 守卫语义与参照体一致；6.4 改名不改身份；6.5 杀死点持久性；6.6 schema 迁移字节一致。

##### ★ 发现的缺口：守卫的**别名键抗性**未被契约强制

`dsh/world-model/world-model.mjs:1258–1263` 实现了别名键抗性，注释写得很清楚：

> 参数面别名：全部已知键都合并进扫描（`??` 链会在 `arguments:{}` 时短路，
> 让 `parameters`/`tool_input` 的载荷完全不可见）；自有非结构属性同样展平
> ——**看不见的载荷 = 绑定绕过面（藏起来 ≠ 不存在）**。

`simulate_body.mjs:56` 也**支持**注入别名键（`exec_extra`，注释同样说明用途）。

**但 `bcc_check.py` 没有任何夹具用它，文档也没有记载这条要求。**
→ **一个"只读 `arguments`"的守卫能通过全部六协议**，而它是可被绕过的。

**已补（三条件）**：
1. `guard_reference` 接受 `exec_extra`，扫描整个载荷池（不再只读 `args`）
2. 新增三条别名夹具：藏在 `parameters` / `tool_input` / 自有键下的不可逆载荷
3. `check_all` 把 `exec_extra` 同时传给参照体与场景步骤
   （`simulate_body.mjs` 会把它**展开**到 execution 上，模拟"同一意图换个键名"）

**验证**：
- 修复后 10 条夹具全过（**参照体与真实适配器结论一致**）
- **夹具有效性已实测**：临时把参照体退回"别名盲" → `guard_semantics` **PASS: False**，
  两条 deny 夹具失败（`ref=permit` 而 `plugin=deny`）→ **证明改之前"别名盲"确实能通过**
- `tests/test_wm_v031.py` 的调用同步更新（调用方已搜全：仅 2 处）

**`mind/README.md` 的 BCC-1 表已把 6.3 补上这条要求**，并说明由 `exec_extra` 夹具强制。

#### ⑨ ★★ 用户追问："通用文档为什么要写特有适配" —— 通用层里残留的身体名（已清）

用户指出的是**同一个病、深了一层**：上一轮把工具链**代码**从 `dsh/` 搬到了 `mind/`，
但 `mind/`（通用、harness 无关的那一层）里**还留着具体身体的名字**。
通用层不该出现身体的名字 —— 否则"谁属于谁"又会被名字误导。

**排查出的三类，处理不同：**

| 类别 | 位置 | 处置 |
|---|---|---|
| **违反：默认值** | `bcc_check.py` 的 `ADAPTER_UNDER_TEST` **默认指向 dsh 适配器** | 改为**调用时解析 + 无默认**（`adapter_under_test()`），并让调用方声明被测适配器 |
| **违反：默认值写进状态** | `migrate_v031.py` 把 `body_id:"dsh-local"` / `harness_type:"dsh"` **写进生成的 canonical** | 参数化（`--body-id` / `--harness-type`），默认 `unset` |
| **违反：硬编码路径** | `bcc_check.py` 的 node 查找回退写死 `~/.dsh/runtime` | 改为 `BCC_NODE` / `BCC_RUNTIME_ROOT`（通用侧不预设任何身体的安装布局） |
| **合理：历史** | `mind/README.md` 讲"原先把它放在 `dsh/world-model/`" | **保留** —— 那是这一层存在的理由 |

> `migrate_v031.py` 那处比文档提及更严重：它把身体名**写进了 canonical 状态**。
> 而 BCC-1 **6.1 明确要求投影时剥掉 `body_id`** —— 说明这个字段本就是按身体变化的，
> 通用工具不该替调用方固化一个值。

**改完后的验证：**

| 检查 | 结果 |
|---|---|
| `mind/` 里 `dsh` 出现处 | **仅剩 README 的迁移历史那 2 行**（合理） |
| `migrate` 默认输出 | `body_id: unset` / `harness_type: unset`；lineage 里**无 `dsh`** |
| `migrate` 可指定 | `body_id='pi-main', harness_type='pi'` 生效 |
| 世界模型回归 | **50 OK**（测试进程自己设 `BCC_PLUGIN` —— 它才是命名身体的一方） |
| `validate_repo.py --strict` | errors=0 |
| skill 门禁 | PASS (22) |

##### 顺带修掉两个"跳过被当成通过"的缺陷

改完后跑测试台发现：**不指定适配器时，被跳过的检查会报成 PASS。**

| # | 缺陷 | 根因 |
|---|---|---|
| **a** | `event_ordering` 跳过时报 `pass: True` | 空 ledger 让 `not errs and mono and linked` **空洞成立** |
| **b** | 总 `PASS` 在全跳过时可能为 `True` | `all([])` 空洞成立（`pass: None` 被过滤后剩空集） |
| **c** | `persistence` 跳过时报 `pass: False` | 调了 `run_plugin_body` 但**忽略返回值**，文件不存在即判失败 |

**a/c 是既有的**（`node not found` 时同样触发），只是这次才被看见。

**修法**：三值语义 —— `pass: True`=测过且过 / `False`=测过且失败 / **`None`=没测**；
聚合要求**至少一项真正跑过**，并把跳过项列进 `results["skipped"]`
（`PASS: true` 旁边四个静默跳过，会被读成"契约全验证过了"）。

#### ⑩ ★★ pi 适配器**不放通用层** —— 归属与依赖方向（用户追问后补）

**用户追问**："什么叫往上加 pi 适配器，通用侧为什么要加特定适配？"

**问得对。** 本规格此前只写"pi 侧适配器"，**从未写清它放哪**；
我口头说的"往上加"更是错的 —— 那等于往通用层塞一个特定身体的东西，
正是上一节（§2.5.9⑨）刚清掉的那个病。

**正确的归属：**

| 层 | 内容 | 知道具体身体吗 |
|---|---|---|
| **`mind/`** | **契约（BCC-1）+ 测试台 + 工具链** | **不知道** —— 无适配器、无身体名、无默认 |
| `dsh/world-model/` | **DSH 适配器**（`world-model.mjs` + `cordis.patch.yml` + `package.json` + README） | 只知道自己 |
| **`pi/src/adapter/world-model.js`** | **pi 适配器（待写）** —— 放在 pi 身体自己的适配器目录 | 只知道自己 |

**即：每个身体把自己的适配器放在自己的身体目录里。**
`mind/` 只定义"它们必须共同满足什么"，并提供验它的测试台。

**依赖方向（已实测）：适配器与工具链共享的是「数据格式」，不是代码。**
`dsh/world-model/world-model.mjs` 的 import 清单**只有 node 内置**
（`node:fs` / `node:path` / `node:os` / `node:crypto`），
**不 import `mind/` 任何东西** —— 全文唯一提到 `mind/` 的是一句提示文案。
pi 适配器同理：用 pi 自己的 seam + node 内置，不需要也不应该 import `mind/`。

**所以正确的说法是**："给 pi 写一个适配器，放在 `pi/`"，
而不是"往通用层加适配器"。通用层不因新增身体而改变 ——
**这正是 BCC-1 存在的意义：新增身体不改通用侧。**

#### ⑪ ★ 触发链的最后一厘米：wm_cycle 的 canonical 指向（2026-10-13 实测修复）

断点 #1–#3 修复、pi 适配器接线之后，投产前实测又发现触发链的**最后一厘米是断的**：

`world-model-shim.js` 在复发触发时调度
`wm_cycle.py --instance <root>`，而 wm_cycle 此前把 canonical **写死推导为**
`<instance>/canonical`。但挂载部署下（`WORLD_MODEL_HOME` / `PAI_CANONICAL_DIR`）
**实例根里的 `canonical/` 是另一个目录**（本机实测：9 月残留的空壳，
policy.json 停在 09-21，observations/predictions 全空）。
后果：复发真的发生时，cycle 会**对着空壳编译** ——
briefing 写进没人读的目录、proposals 落错地方，且全程无报错。

**修复（三处）**：

1. `mind/wm_cycle.py` 增加 `--canonical`（缺省保持旧推导，兼容未挂载实例；
   报告里新增 `canonical` 字段让指向可审计）；
2. shim 的调度命令改为 `--instance "<root>" --canonical "<resolved canonicalDir>"`
   （引号必须：shell 执行，挂载路径可含空格）；
3. `host/src/core/doctor.js` 的 FALLBACK sweep 建议串同步带 `--canonical`。

测试：`tests/test_wm_v031.py::TestWmCycle` 新增挂载/缺省两例；
`pi/tests/world-model-shim-schedule.test.js` 用**带空格**的挂载路径钉住命令形状。

**同次实测的另两条记录**（非代码问题，未改动）：

- 真实 canonical 的 `briefing.md`/`runtime-state.json` 是 10-10 手工冒烟 stub
  （`# BRIEF / - M1`、`"compiled_at":"t"`）；`canonical_compile --check` 的 mtime
  新鲜度判据**认不出手写 stub**（stub 比 yaml 新即报 fresh）——不影响功能：
  wm_cycle 每轮**无条件**重编译，stub 会在首次真实 cycle 被真编译覆盖。
- `runtime-state` 真编译投影显示 `active_body: dsh-local`（2026-09-13 绑定），
  而产品已迁 pi —— **body binding 的治理流程（BCC-1 PASS → BODY_RELEASED →
  epoch+1）从未落到 canonical**。这是 operator 治理动作，不在本规格代劳范围。

#### ④ 这对"新格"的意义：功能位的两侧

现在"更新"这一格看得更清楚了 —— 它有**两侧**：

| 侧 | 是什么 | 归属 |
|---|---|---|
| **协议侧** | agent 执行的九环协议 | **已在正确位置**：`skills/world-model-runtime/`（层 ① Skill 包） |
| **治理侧** | agent 权限之外的工具链（唯一写者、只读评估、投影、迁移） | **错位在 `dsh/world-model/`** ← 待迁 |

**为什么工具链必须在 agent 权限之外**：宪法约束 `normative_authority_root: owner` +
`epistemic reliability never derives normative authority` ——
**agent 不得写 canonical**，所以治理化的 canonical 落地必须发生在 agent 之外。
**这正是这一格存在的理由，也是它与 `skills/` 的分界线。**

**→ 结论不变，但理由更硬了：新格 = 认知层的「治理化更新」侧。
`skills/` 放协议（agent 侧），新格放治理化落地（agent 之外）。**

---

### 2.5.10 ★★ 新格的决定（用户："你自己决定"）

#### 判据（从 §2.5.7③g 的边界推出，非从语感挑）

1. **harness 无关**（否则它属于 `dsh/`/`pi/`）
2. **不是状态**（否则它属于 `soul/`）
3. **不是控制**（否则它属于 `host/` —— 不做门禁/租约/交接）
4. **在 agent 权限之外**（宪法：`normative_authority_root: owner`；
   "认知可靠不等于规范权威" → **agent 不得写 canonical**）
5. **与 schema 同生命周期**（`migrate_v031.py` 以 schema 版本命名）

#### 决定

| 项 | 决定 |
|---|---|
| **名字** | **`mind/`** |
| **与 `soul/` 的关系** | **`soul/` 是状态（它是什么），`mind/` 是运作（它怎么变）** |
| **层** | 认知层第三个成员（`soul/` 状态 · `host/` 控制 · `mind/` 更新） |
| **内容** | 8 个工具 + BCC-1 契约测试台（`bcc_check.py` / `simulate_body.mjs`） |
| **`dsh/world-model/` 之后** | 只剩适配器（`world-model.mjs` + `cordis.patch.yml` + `package.json` + `README.md`），回到 16/17 约定 |

**为什么选 `mind/` 而不是其他候选：**

| 候选 | 否决理由 |
|---|---|
| `world-model/` | **误称** —— schema 顶层把 `world_model` 与 `value_model` 并列，而工具链处理 W/V/U/L 全部；且与 `dsh/world-model/` 撞名 |
| `steward/` | 在本仓（一个 agent 仓库）里"steward"**会被读成一个 agent 角色**，而不是机器。这是比"名字不够准"更糟的误读 |
| `canonical/` | 与**实例运行态** `instance/canonical/` 同名 —— 仓库放机制、实例放状态，同名两义 |
| `curator/` | 已被占用（`host/src/core/curator.js`，微 agent 库策展） |
| 新增更抽象的名字（如 `engine/`） | 通用词，无法传达"它维护的是认知状态" |

**选 `mind/` 的核心理由**：它与 `soul/` 构成**状态 / 运作**这一对，
**而这正是此前不可见、导致连错三轮的那条边界**。名字本身就在说这条边界。

**已知风险（诚实记录）**：`mind` 在口语中有时包含"信念"，可能被读成含状态。
README 需一句话钉死：**状态在 `soul/`，`mind/` 只放运作机制。**

**名字是可逆的，边界才是实质。** 若你要换名，改的是字符串；边界不变。

#### 落地清单（**未执行** —— 触及治理文档）

1. 新建 `mind/`，移入 8 个 `.py` + `simulate_body.mjs`
2. `dsh/world-model/` 只留适配器四件
3. 改 `tests/test_wm_v031.py` 的 `PKG`
4. 改 `soul/README.md:39` 的路径（现叫采用者去跑 `dsh/world-model/canonical_compile.py`）
5. `AGENTS.md`：七层表加 `mind/`，并说明它属于认知层的"更新"功能位
6. `docs/architecture.md:3` 的"机制层 + soul/ 认知层"要补上第三个功能位
7. 跑门禁：`validate_repo.py --strict`、`unittest tests.test_wm_v031`

---

## 3. 缺口：三条，均为"回路断开"

### 缺口 G1 · 认知状态到不了人眼前

**事实**：`app/ui`、`app/server` 对世界模型零命中；`supervisor.js` 持有 `PredictionStore`、已读 `openPredictions()`，但只服务 handoff。

**后果**：

- briefing 第 1 段 **Unresolved First** ——裁剪优先级**最高**的内容——在界面上不可见。
- 人不看 `unresolved`，就无法回答"我要不要介入"。
- 而按 §1.1，"要不要介入"的权威**只属于 owner**。**权威在人这边，事实却到不了人眼前。**

**性质**：这是**回路断点**，不是缺功能。

### 缺口 G2 · 人的反应未在回路中 —— **已确证，但需按 §3.5.7 + §5.5 两次校准**

**严重度**：G1/G2/G3 中**最高**。G1 是"数据在手里没送出去"，G2 是"数据根本没被记录"。

**追踪链与证据**见下方详述。一句话结论：

> **用户点"撤销"，系统只知道"文件变回去了"，不知道"用户否决了 AI 的一次改动"。**

**为什么它最严重**：

- `RAW_EVIDENCE` 捕获的是 **AI 的动作**；`distiller.py` 从 closed episodes 提炼
  `MODEL_PROPOSAL`，靠的就是**事件流里的模式**。
- **"用户撤销"是判断 AI 做对了没有的唯一硬信号**——AI 自评不算（`no post-change
  self-grant of authority` 已禁止）。
- 信号丢失的后果：**系统能看见自己做了什么，看不见自己做得对不对。**

> ⚠️ **§3.5.7 校准**：上述"看不见自己做得对不对"需收窄——
> **客观后果（`verify_fail`）的写入通路已在 observation stream 里**，
> 缺的是**人的反应**。准确说法见 §3.5.7。
>
> ⚠️ **§2.5 三次校准（第八轮实测）**：该通路**存在但从未被触发过** ——
> `verify.js` 只在 **verifier 失败**时 `record`，而 verifier 需要 `.pai/verify.json`，
> 本机不存在该文件；且 observation stream 本身在 pi 身体下未接通（§2.5.2）。
> **准确表述：不是"客观后果已经在回路里"，而是"客观后果有一条已写好的写入语句，
> 但前置条件从未满足，所以从未产生过一条记录"。**

> ⚠️ **§5.5 二次校准（第六轮）**：批准类反应（`ASK_RESOLVED`）**并非"根本没被记录"——
> 它已被写入、已聚合、已到 UI**，只是在 `/stats` 里被降级成一行脚注且丢了 `rule` 字段。
> 所以 G2 内部要再分两类：
>
> | 人的反应 | 状态 |
> |---|---|
> | **批准 / 拒绝**（`ASK_RESOLVED`） | 已记录、已聚合、已到 UI，**末端呈现被丢弃**（§5.5） |
> | **中止**（`abort`） | 有 body 侧注解，**host 侧零留痕**（§5.4） |
> | **纠偏**（`steer`） | **连注解都没有**（§5.6） |
> | **撤销**（undo/restore） | **完全不在回路**（G2 原判断成立） |
>
> **"数据根本没被记录"这个说法对『撤销』成立，对『批准』不成立。**

**接入成本低的理由**：`pi/src/adapter/fileops.js:225` 附近注释载明
`the ENTIRE undo surface — restore/undoFrom/diff all parse through here`——
**整个撤销面从单一出口走，是一个单点。**

#### G2 证据 · 完整追踪链

**事实**：`RAW_EVIDENCE` 仅挂 `ctx.on('tools/result')`（`world-model.mjs:781–796`），捕获的是**工具结果**。

**已查证：人对结果的全部反馈，在整个回路之外。** 完整追踪链：

```
app/ui 点「恢复」
  → cmd('fileops_restore')
    → supervisor.handle()        # supervisor.js:757 default 分支，无显式 case → 原样透传
      → body
        → host/src/core/channel.js:677   case 'fileops_restore'
          → this.fileops.restore(receiptId)
            → pi/src/adapter/fileops.js:144    ← 终点
```

**终点处无任何世界模型触达**：`grep 'world|observe|emit' pi/src/adapter/fileops.js` **零命中**。撤销只做两件事——改文件、写本地 `#log` 操作回执。

**且 `channel.js:677` 的 case 分支无 audit、无上游上报**：`grep audit` 配合 `restore|undo|rewind` **零命中**。

**推论**：用户点"撤销"，系统只知道"文件变回去了"，**不知道"用户否决了 AI 的一次改动"**。

**未查证（不下结论）**：授权路径（ASK 批准/拒绝）是否同样断链。本轮只追了撤销路径；
`asks` facade 与 `governance.decideToolCall()` 的关系**未查**，需单独追踪。

### 缺口 G3 · 进化的方向无法被人干预

**事实**：`u1_accept.py` 是唯一 canonical 写者，走治理路径（proposal → validation → accept → rollback-capable）。

**缺口**：若界面上无法看到"当前有哪些已接受的规则/模型"，人就**无法干预进化方向**。

**而按 `no post-change self-grant of authority`**：进化本身不能自授权。**人必须能看见并叫停。**

---

## 3.5 根因：两条总线没有桥（G1/G2/G3 的共同成因）

G2 查证后进一步追授权路径（`decision_resolve`），发现了三条缺口背后的**同一个根因**。

### 3.5.1 授权路径追踪链

```
app/ui 点「拒绝」
  → cmd('decision_resolve', { askId, answer:'deny' })
    → host/src/core/channel.js:969   case 'decision_resolve'
      → this.asks.resolve(askId, answer)
        → pi/src/bootstrap/decide.js          ← 人的决定在此被处理
          → core.audit.write({ kind: '..._RESOLVED', answer })
            → host/src/core/audit.js
              ✗ grep 'world|RAW_EVIDENCE|observe' → 零命中
```

`decide.js` 确实记录了人的决定（`LOOP_DETECT_RESOLVED` / `SECRET_SCAN_RESOLVED` /
`WRITE_OUTSIDE_RESOLVED` / `COMMAND_DENYLIST_BLOCK` 等，见 `decide.js:236–484`），
**但只写进 host 的 audit，不触达世界模型。**

| | 撤销路径（G2） | 授权路径 |
|---|---|---|
| 有无留痕 | ✗ 连 audit 都没有 | ✓ 写进 `core.audit` |
| 触达世界模型 | ✗ | ✗ |
| 断点位置 | `channel.js:677` | `audit.js`（不向 world-model 发声） |

### 3.5.2 根因

世界模型**只订阅两个事件源**（`world-model.mjs:783, 830`）：

```js
ctx.on('tools/result', ...)    // AI 的工具结果
ctx.on('session/event', ...)   // 仅 turn/start | step/start | user/message 触发，
                               // 且仅用于注入 briefing
```

**没有第三个订阅面。** 而 `audit.write(...)` 走的是 **host 的 audit 通道**，
世界模型监听的是 **DSH 的 event bus**。

**两条总线互不相通**：`host/src/core/audit.js` 零命中 `world`；
`world-model.mjs` 里的 `auditOk`（:536, :889）只是它**自身写盘状态**的标志，不是读 host audit。

### 3.5.3 为什么这是架构性的，不是"忘了接"

按 `AGENTS.md` 分层硬约束：

- `host/` **禁止 import 任何身体/harness**（`host/tests/firewall.test.js` 机械执行）
- `dsh/world-model/` 是 **DSH 侧插件**，依赖方向 `dsh → host`

**两者本来就该隔离**——所以"audit 不通 world-model"不是缺陷，
**是分层约束的必然结果**。桥不能建在 host，也不能建在 dsh。

**桥只能建在允许同时知道两边的地方。** `AGENTS.md` 已指明：

> `app/`：**产品级组装根，可同时知道 pi/dsh 入口**

### 3.5.4 三个缺口的真实性质（修正）

| 缺口 | 原判定 | 修正后 |
|---|---|---|
| G1 未决预测到不了人眼前 | "回路断点" | **总线是通的，只是没往上传**——数据已在 supervisor 内存（`openPredictions()`） |
| G2 撤销不在回路 | "最严重" | **两条总线都没进**——纯粹未记录。仍是最严重 |
| G3 进化方向无法干预 | "缺呈现" | audit 有记录，但世界模型不知道 → **同属总线不通** |

**统一表述：核心问题是 host 的 audit 总线与 DSH 的 world-model event bus 之间没有桥，
而这座桥按分层约束只能位于 `app/`。**

### 3.5.5 中止 / 插话 / 急停三条路径（第四轮追踪）

**重要修正**：授权路径**比我上一轮的判断要好**——存在一条**已被消费的聚合链**。

#### 已存在的好东西：`ASK_RESOLVED` 结局分桶

`host/src/core/asks.js:168` 在每次批准/拒绝时写入：

```js
this.audit?.write?.({ kind: 'ASK_RESOLVED', toolName,
  data: { rule: rec.rule ?? 'ask', kind: rec.kind, answer: ans,
          edited: edited ? Object.keys(edited) : null } });
```

**注意 `rule` 字段**——它就是 `governance.decideToolCall()` 判定所用的规则名。
**即：每次人做决定，都带着"是哪条规则触发的"被记录。**

而 `pi/src/bootstrap/host.js:1331–1350` **已经在消费这条 trail**，按结局分桶：

```js
// Vibe AgentStats outcome buckets — approval answers counted by结局
// from the ASK_RESOLVED audit trail (survives session reloads)
const asks = { allow:0, allow_session:0, always:0, deny:0, timeout:0,
               aborted:0, question_answered:0 };
```

**意义**：`allow_session` / `always` 与人反复批准的规则名匹配起来，
**就是"哪些操作该沉淀成规则"的数据基础**——§0 想要的"从事实里长出来"，
**素材已经在磁盘上了，只差送进世界模型。**

#### 三条路径的留痕对照

| 路径 | 入口 | 留痕 | 世界模型 |
|---|---|---|---|
| **批准 / 拒绝** | `asks.js:168` | **✓ `ASK_RESOLVED`**（带 `rule`/`kind`/`answer`）**且已被聚合消费** | ✗ |
| **急停 `stop_all`** | `channel.js:207` | **✓ `STOP_ALL`** | ✗ |
| **中止 `abort`** | `channel.js:187–189` | **✗ 无** | ✗ |
| **插话 `steer`** | `channel.js:186` | **✗ 无** | ✗ |

**`channel.js` 全文件仅一处 audit 写入（`STOP_ALL`，:207）** ——已核。

#### 三条结论

1. **`abort` / `steer` 连 audit 都没有** —— 与 G2 撤销同类，**需先补记录**。
2. **最讽刺的错配**：`stop_all`（最剧烈的全局急停）**有记录**；
   `abort`（最常用的中止）**没有**。**记录粒度与操作频率反相关。**
3. **取舍建议**：优先桥接 `ASK_RESOLVED`（**数据已在磁盘、已带规则名、已有聚合**），
   而非先补 `abort`/`steer` 的记录（需从零建）。

### 3.5.6 `abort` 的深入追踪：一个"只给模型看、不给系统看"的信号

**修正 §3.5.5 的结论 3**——`abort` 并非"什么都没有"，而是**有信号但投错了地方**。

#### 事实

`pi/src/adapter/channel.js:290–306`，`abort` 的真实实现：

```js
abort: async () => {
  await box.s.abort?.();
  asks?.abortPending?.();
  // Interrupt annotation: stopReason 'aborted' is metadata the model never
  // sees in its prompt. A non-display custom message enters the next turn's
  // context, so a continued run knows the interruption was the operator's —
  // other abort paths (budget breach, session switch, handoff) deliberately
  // bypass this facade and leave no such note.
  await box.s.sendCustomMessage?.({
    customType: 'pai.user_interrupt',
    content: 'The user interrupted this run. Treat the interrupted turn as
              partially complete — resume from the current state instead of
              restarting the work.',
    display: false,
  }, { triggerTurn: false, deliverAs: 'nextTurn' });
}
```

#### 三个关键点

1. **信号存在且语义纯净。** 注释明确：**只有"用户主动中断"走这条 facade**；
   `budget breach` / `session switch` / `handoff` **刻意绕过**，不留此标注。
   → **即：`pai.user_interrupt` 是人意志 vs 系统动作的分界，无污染。**

2. **但它只进模型上下文，不进证据流。** 全文 grep `pai.user_interrupt` **仅 1 处命中**
   （`channel.js:302`，即写入方）——**没有任何消费方**。
   `deliverAs: 'nextTurn'` + `display: false` 意味着它进的是**下一轮 prompt**，
   **转瞬即逝、会被 compaction 挤掉**，不落任何持久面。

3. **世界模型也拿不到它。** `session/event` 仅认 `turn/start` / `step/start` /
   `user/message` 三种（`world-model.mjs:838`），且 `briefedSessions.has(sid)` 时
   **直接 return**（每会话仅处理一次）。`customType` 不产生这三类事件。

#### 结论修正

| 路径 | 修正前 | 修正后 |
|---|---|---|
| `abort` | "连 audit 都没有" | **有信号（`pai.user_interrupt`），但只投给模型，不投给系统** |

**这比"什么都没记"更值得注意**：说明系统**已经意识到**中断是需要被理解的语义
（所以给模型写了注释），却**没有把它当成可学习的证据**。

**代价**：`user_interrupt` 是判断"AI 是否跑偏"的最强信号之一
（比事后撤销更即时、更明确）。当前它每轮被消费一次就被丢弃。

**桥接成本**：**低**——写入点单一（`channel.js:302`），只需在 `app/` 侧同时把
该事件送入 world-model 的观察面，无需改动既有逻辑。

### 3.5.7 重要校准：客观后果已在回路中

**第七轮查证发现一处此前漏掉的事实，必须校准 G2 的表述。**

`pi/src/adapter/verify.js:107`：

```js
observations?.record({
  kind: 'verify_fail',
  subject: command.slice(0, 120),
  detail: { exit: r.code, tail: r.output.slice(-2000) },
  actor: 'host',
});
```

而 `host/src/core/observation.js` 头部注释载明：

> **Observation store — canonical world-model observation lifecycle.**
> Observations are what the body actually observed (tool results, compaction events,
> runtime facts). **They are canonical state**: append-only, **survive compaction and
> body switches**, and the live context provider **re-reads them on every context event**.

**即："改动导致测试挂了"这个客观后果，已经在往世界模型送。**

#### 校准后的准确二分

| 信号 | 进 observation stream |
|---|---|
| **`verify_fail`（改动导致测试挂）** | **✓ 已进** |
| 人的撤销 / 拒绝 / 中断 | ✗ 未进 |

**准确表述**（替换 G2 原先的"看不见自己做得对不对"）：

> 系统能观察到 **"我的改动导致了什么后果"**（测试挂了），
> 但观察不到 **"人对此怎么反应"**（撤了 / 拒绝了 / 叫停了）。

**这是"接了客观后果，没接人的反应"，不是"什么都没接"。**

#### 这个校准的影响

1. **G2 的范围收窄**：缺的不是全部反馈，是**人的那一半**。
2. **换算层变得可行**（见 [`change-digest-spec.md`](./change-digest-spec.md)）：
   "测试 312 → 298" 的**数据源已在 `observation` 里**，
   缺的只是**把 observation 汇总成一句人能读的结论**。
3. **两个方向互补**：
   - `observation` 回答 **"客观发生了什么"**（已有）
   - `ASK_RESOLVED` / `pai.user_interrupt` 回答 **"人怎么反应"**（待桥接）

---

## 4. 规格：app 层在回路中的位置

### 4.1 定位

> **app 层不是世界模型的编辑器，是世界模型与 owner 之间的呈现与授权接口。**

这不是"界面设计"，是**职责边界**（**§3.5 给出了架构层面的理由：桥只能在此**）：

| 职责 | 归属 | 依据 |
|---|---|---|
| 观察事实（工具结果、行为信号） | 机制层自动捕获 | `RAW_EVIDENCE` |
| 换算（从事实推出"发生了什么"） | AI | §0 结论 |
| **判断（要不要介入、授不授权）** | **owner** | §1.1 `normative_authority_root: owner` |
| 呈现（把事实送到 owner 眼前） | **app 层 —— 本文范围** | G1 |
| 记录 owner 的判断 | app 层 → 回路 | G2 |
| **桥接 audit 总线 ↔ world-model event bus** | **app 层（唯一合法位置）** | §3.5.3 |
| 执行进化（接受规则/模型） | `u1_accept.py`，受 owner 约束 | §2 |

### 4.2 由此推出的两条设计约束（约束，非界面方案）

**约束 A · app 层不得代 owner 判断。**
可由 §1.1 那句注释直接推出。推论：任何"AI 建议 + 一键采纳"的形态，若把判断权移交给 AI 的判断结果，均违反 `normative_authorities`。**可以呈现 AI 的判断，不能以它替代人的判断。**

> **已有实现可参照**：`app/ui/app.js:682–689` 的"顾问参考"（P3 shadow judge）——
> 代码注释载明 `it can never flip the verdict; the human still owns the buttons`。
> **这是约束 A 在界面层的正确实现，应作为后续所有同类设计的范式。**


**约束 B · app 层的输出必须是"投影"，不是"账本"。**
带 §0 的教训 + briefing 第 6 段（Retrieval Pointers：指向 canonical，不复制内容）。推论：app 层呈现的是**编译后的认知状态**，不是 ledger / 回执 / diff 的原始堆积。

### 4.3 需要接入的三条数据（顺序即优先级）

按 briefing 裁剪优先级（`unresolved > alerts > ...`）排列：

| 序 | 数据 | 来源 | 现状 |
|---|---|---|---|
| 1 | **未决预测 / open loops** | `supervisor.js` 已有的 `openPredictions()` | ✅ 已透出（`world_model_status` → 设置页世界模型卡） |
| 2 | **可靠性告警 / 残差** | `runtime-state.json` 编译投影 | ✅ 已透出（2026-10-12：简报 §1/§2 解析为一等行，告警黄色标识；epoch pill 来自 runtime-state.json） |
| 3 | **当前最优模型 + falsifier** | `briefing.md` 段 3 | ✅ 已透出（2026-10-12：§3 逐模型行 + 推翻条件行；原文收进 `<details>` 兜底，解析失败不藏源） |

**第 1 条成本最低**——数据已经在 supervisor 内存里，只差一层透出。（三条现全部落地，UI 解析器只认
`canonical_compile.py` 的固定七段格式；格式演进时解析器随之更新，未识别的内容始终可从原文 `<details>` 读到。）

### 4.4 需要新建的一条回路（G2）—— 已明确为"架桥"

**目标**：把 owner 的行为反馈纳入观察。**§3.5 已给出架构位置：桥在 `app/`。**

**必须走的两条既有通道（不得新造）**：

| 要记录的事 | 通道 | 依据 |
|---|---|---|
| 人的行为信号（撤销/拒绝/打断） | **`RAW_EVIDENCE` 等价物**——机械捕获，不过滤 | `world-model.mjs:781–796` 既有范式 |
| 人表达的持久约束（"以后都别这样"） | **`INPUT_SEMANTICS`** → `NORMATIVE_DIRECTIVE` | V0.3.1 §6 |
| 人的一次性许可 | `AUTHORIZATION`（**不持久化**） | V0.3.1 §6 |
| 人的偏好 | `PREFERENCE`（**不持久化**） | V0.3.1 §6 |

**硬约束**：

- **不得**新造 `semantic_type`。可用类型仅 V0.3.1 §6 已定义的五种。
- `NORMATIVE_DIRECTIVE` 的 `source_id` 与 `scope` **必须**取自
  `governance.yaml normative_authorities` 已注册值（`owner` 的四个 scope），自造词汇会被拒。
- **不得**把行为反馈直接写成 canonical —— 必须走 proposal 路径（`u1_accept.py`）。
- **不得**事后追认（`no retroactive legitimization`）。
- 桥**不得**建在 `host/` 或 `dsh/`（违反分层约束，§3.5.3）。

**新发现的证据点（G2 的接入单点，四处，按优先级）—— 成本列已按第六轮查证修正**：

| 序 | 位置 | 现状 | 成本（已查实） |
|---|---|---|---|
| **1** | **`host/src/core/asks.js:168` → `pi/src/bootstrap/host.js:1335` → `channel.js:584` → `app.js:3239`** | **全链路已通**：写入 → 聚合 → 命令 → UI | **最低（比原估计更低）**——**通路全部存在**，只需修 3 个呈现缺陷（§5.5） |
| **2** | **`pi/src/adapter/channel.js:300–306`** | 语义纯净（仅用户主动中断），但**host 侧零留痕** | **低**——`emit`/`core.observations` 同闭包，**加一行**（§5.4） |
| 3 | `host/src/core/channel.js:207` | `STOP_ALL` 已写 audit | 低——只差桥接 |
| 4 | `pi/src/adapter/fileops.js:225`、`channel.js:289`（撤销、steer） | **无任何留痕**；`steer` 仅 1 行（§5.6） | **高——需先补记录**（但补法与第 2 项同款） |

**结论（修正后）：第 1 项不再是"只差送进 world-model"，而是"连送都不用送 —— 末端丢在地上"。**
优先修 `ASK_RESOLVED` 的呈现缺陷（补触发条件 + 保留 `rule` + 提到常驻），
其次按第 2 项的"加一行"模式补 `abort` / `steer`。

`ASK_RESOLVED` 是 §0 所要"从事实里长出来"的现成素材——
`rule` 字段直接给出"哪条规则触发了这次询问"，
与人反复选择 `allow_session`/`always` 的记录一交叉，
**就是"这些操作该沉淀成规则"的直接证据。**

`pai.user_interrupt` 则补上另一半——**"AI 跑偏了、我当场叫停"**，
且写入方已用注释声明**只有人的中断才会产生它**（预算超限/切会话/handoff 均绕过），
**天然无污染。**

---

## 5. 未查证事项（明确标注，不写入结论）

1. ~~**`observation.recent()` 是否对 `app/` 可见**~~ → **已查实：可见，且无需新通路。**
   见 §5.3。**这是本轮"继续"的核心结论。**
2. ~~**`pai.user_interrupt` 能否无损桥接**~~ → **已查实：不能"旁路取到"，但加一行即可补齐。** 见 §5.4。
3. ~~**`ASK_RESOLVED` 聚合的暴露路径**~~ → **已查实：已暴露到 UI，只是被埋在一行脚注里。** 见 §5.5。
4. ~~**`steer` 是否有同类标注**~~ → **已查实：完全没有。连 `abort` 的标注也没有。** 见 §5.6。
5. ~~**`purge` 的触发条件**~~ → **已查实：`instance_purge` 不可碰收据；真正的时效衰减来自 `#sweep`。** 见 §5.7。
6. ~~**`create` → `delete` 链路**~~ → **已查实：进回收站，可恢复。"`create` 无 backup = 难回"不成立。** 见 §5.8。

**六项全部查实完毕。其中四项推翻了我原先的判断（三项往好的方向，一项往坏的方向）。**

> 原第 5 项"改动前后状态能否自动比对"**已查实**（§5.2），故移除。
> 原第 1 项"`observation.recent()` 是否对 `app/` 可见"**已查实**（§5.3，第六轮）。
> 原第 2/3/4/5 项**已查实**（§5.4–§5.7，第六轮续）。
> 原第 6 项**已查实**（§5.8，第六轮续）。

---

### 5.3 `app/` 能否读到 observation —— 已查实（第六轮）

**结论：能，且不需要新增跨层通路。** 这是换算层第 1 层唯一的落地前提，现已通过。

**证据 1 —— `ObservationStore` 自足。**
`host/src/core/observation.js` 全文三方法（`record` / `list` / `recent`），
**构造函数只吃一个 `canonicalDir`**，零外部依赖。

**证据 2 —— `app/server` 已有 `canonicalDir`，且在用同款构造。**
`app/server/supervisor.js:173 this.paths = ensureInstance(...)`，
`:511 const predictions = new PredictionStore(this.paths.canonicalDir)`。
`PredictionStore` 与 `ObservationStore` 同目录、同层、同构造签名 ——
**加 `new ObservationStore(this.paths.canonicalDir)` 是一行。**

**证据 3 —— 分层防火墙不禁止。**
`host/tests/firewall.test.js` 只约束 `host/src/` 自己的 import（禁止 host 反向伸手）。
它不管谁 import `host/`。而 `app/server/supervisor.js` **已 import 8 个
`host/src/core/*`**（registry/lease/handoff/prediction/policy/eligibility/audit/paiignore），
第 9 个不是新先例。

**证据 4 —— 有现成的同构模板 `audit_tail`。**
读通路六环节已跑通一遍：

| 环节 | audit（已存在） | observation（待加） |
|---|---|---|
| facade 定义 | `pi/src/adapter/channel.js:833` | 同位置 |
| facade 注入 | `:860 audit: auditFacade` | 同位置 |
| 构造函数收字段 | `host/src/core/channel.js:98` | 加 `observations = null` |
| 存字段 | `:104 this.audit = audit` | 加一行 |
| 命令分支 | `:254 case 'audit_tail'` | 加 `case 'observations_recent'` |

**关键观察**：`host/src/core/audit.js` 的 `AuditWriter` **只有 `write`/`writeOrThrow`，
没有 `tail`** —— 读能力是 `pi/src/adapter/channel.js:838` 新写的 facade。
**所以"store 不自带读方法"不是障碍，读能力由 facade 现造。**

**两条路，成本差一个量级：**

| 方案 | 做法 | 成本 | 致命约束 |
|---|---|---|---|
| **A · app 本地读** | `supervisor.js` import + 一个 case | 一行 + 一个 case | 无 |
| B · 转发 body | 走 `:759 default:` → `sendToBody` | 6 处 | **body 死了就失效**（`sendToBody:367` 返回 `no live body`） |

**取 A。** 第 1 层的语义是"给人看 AI 干了什么"，**恰恰最需要在 body 挂了之后还能看**；
B 在 body 死时正好失效，方向是反的。且 A 不碰 `pi/`。

**对 §4 的影响**：约束 B"输出必须是投影不是账本"不变；但"只是重排不是重写"
**比原先估计更有利** —— 读取只需构造一个已存在的类，
**不碰 `u1_accept`（唯一 canonical writer），不新增任何 authority**，宪法约束全部不触及。

> ⚠️ **第八轮实测修正**：本节结论"**读通路已存在**"成立，但**该文件当前不存在**
> —— 本机实例 `canonical/observations/` 是空目录，一个观察都没记录过。
> 原因见 **§2.5**：回路在产品当前身体组合下跑不起来。
> **所以"桥的对面已有数据"这个前提不成立** —— 读通路要建，但建成后需要 §2.5 的 P1 先解决才有东西可读。
> **本节的工程结论（不需新跨层通路、一行即可）仍然有效**，它只回答"能不能读到"，
> 不回答"有没有东西可读"。

**由此确定一个实现约束**：必须走 `recent(n)`，**不得自己 `readFileSync`** ——
`observation.js:17–23` 专门写了这个教训（来源 `budget.js` 先例）：`list()` 有
`(size, mtimeMs)` 指纹缓存，绕开它会在 append-only 且持续增长的文件上做全量扫描。

---

### 5.4 `pai.user_interrupt` 能否桥接（第六轮续）

**结论：不能"旁路取到"，因为 host 根本看不见这条消息；但补一行即可。**

**为什么看不见**：`sendCustomMessage` 全仓**只有一个调用点**（`pi/src/adapter/channel.js:301`），
**且全仓没有定义** —— 它是 `box.s`（Pi session 对象）上的 SDK 方法。
消息被投进**body 自己的内部队列**，收件人是**模型**，`display: false`。

**关键**：`abort` 里这一整段（`:300–306`）**既不 `emit` 也不 `audit` 也不 `record`** ——
它直接调 SDK，host 侧零留痕。所以"旁路取到"在架构上不成立：
**host 没有这条消息的副本，也就没有可旁路的东西。**

**但补救是零成本的**：`emit`（`:48`）和 `core`（含 `core.observations`）**都在同一个闭包里**。
`core` 就是 `createHostCore()` 的返回对象，其 `return { …, observations }`（`host/src/app/host.js:79`）
已确认含 `observations`。所以在现有 try/catch 之后加：

```js
core.observations?.record({
  kind: 'user_interrupt', subject: 'abort', actor: 'operator',
  detail: { sessionId: box.s.sessionId ?? null },
});
```

**一行，不碰 `sendCustomMessage`，不改变模型上下文**（observation 只进 host 侧读路径）。
§3.5.6 说的"写入了但无消费方"由此升级为"**写入点+消费点同处一个闭包，缺的只是这一行**"。

### 5.5 `ASK_RESOLVED` 聚合的暴露路径（第六轮续）

**结论：已经端到端暴露了 —— 三项都在。** 这是本轮最意外的发现。

完整通路（**每一环都已存在**）：

| 环 | 位置 | 内容 |
|---|---|---|
| 写入 | `host/src/core/asks.js:168` | `ASK_RESOLVED { rule, kind, answer, edited }` |
| 聚合 | `pi/src/bootstrap/host.js:1335–1349` | 读全 audit，分桶成 `{allow, allow_session, always, deny, timeout, aborted, question_answered}` |
| 命令 | `host/src/core/channel.js:584` | `case 'agent_stats'` → `this.sessions.agentStats()` |
| UI | `app/ui/app.js:3239` | `await cmd('agent_stats')` |

**所以 §3 G2"人的反应没进回路"要收窄为**：
**信号已经进了 UI，但被降级成 `/stats` 里的一行脚注**（`app.js:3243–3244`），
且有三个具体缺陷：

1. **触发条件漏项**：`(a.allow || a.deny || a.timeout || a.always)` ——
   **`allow_session` 和 `question_answered` 不在触发条件里**，
   于是"只点了『本会话放行』"或"只回答过问题"时会整行不显示。
2. **`rule` 字段被丢弃**：`host.js:1344–1345` 只读 `e.data.answer`，
   `asks.js:168` 写的 `rule`（治理规则名）**在聚合时被扔掉**。
   于是"哪条规则被反复拒绝"这个最有用的信息**在聚合层就没了**。
3. **一次性**：`/stats` 是 slash 命令，**不是常驻呈现**。要看到必须主动敲命令。

**这改变了 G2 的修复性质**：不是"要新建通路"，而是"**信号已在管道里，只是末端被丢在地上**"。
修复 = 补触发条件 + 保留 `rule` + 把呈现从"敲命令"提到常驻。**成本远低于原估计。**

### 5.6 `steer` 的标注（第六轮续）

**结论：完全没有。连 `abort` 那套标注也没有。**

对比同一个 facade 里的两个方法：

```js
:289   steer: (message) => { admitSpend(); return box.s.steer(message); },
:290   abort: async () => {
         await box.s.abort?.();
         asks?.abortPending?.();
         try { await box.s.sendCustomMessage?.({ … pai.user_interrupt … }); } catch {}
       },
```

`steer` 是**1 行，仅 `admitSpend` + 转发**，无 `audit`、无 `observation`、无注解、无注释。
`abort` 是 **17 行**，带 annotion、带 `asks?.abortPending?.()` 清理、带说明注释。

**这个不对称本身就是证据**：`abort` 被认真对待过（作者写了注释解释为什么其他 abort 路径要绕过），
`steer` 没有。而**steer 恰恰是"人在中途纠偏"—— 是最该被世界模型看见的人的反应之一。**
按 §5.4 同样的一行补法即可补齐。

### 5.7 `purge` 的触发条件（第六轮续）

**结论：收据（回滚依据）在结构上不可被清理。§5.5.2 的"时效衰减"担忧不成立。**

`purge` 有两个不同含义，要分开：

| 名字 | 位置 | 作用 |
|---|---|---|
| `session_purge` | `app/server/supervisor.js:710` | 永久删除**已归档会话**（`app.js:1382` 要求 `archived && !pinned`） |
| `instance_purge` | `pi/src/adapter/channel.js:1003` | 清理实例产物，**默认 `dry_run: true`** |

`instance_purge` 对收据有三重保护（`channel.js:1003–1027`）：

1. **白名单**：`PURGEABLE = new Set(['exports','spool','sessions'])` —— 只有三类可清。
2. **显式拒斥**：非白名单直接返回错误，且错误文案**点名 receipts**：
   > `audit/jobs/memory/receipts/schedules/allowlists are enforcement evidence`
3. **分类表独立确认**：`cats` 里有 `receipts: /receipts[\\/]|fileops[\\/]/`，
   即 receipts **被识别为一个类别**，但**不在 `PURGEABLE` 里** → 结构性排除。

另外 `const files = catFiles(category).filter((f) => f.path !== live)` ——
**活跃会话文件永远排除**；写 `INSTANCE_PURGE` audit 事件。

**所以 §5.9 第 4 行"`delete` 可恢复"的可靠性边界是"结构保证"而非"时效保证"** ——
不随实例运行时长衰减。第 2 层分级**不需要**叠加时效维度。

### 5.8 `create` → `delete` 链路 + 真正的时效衰减源（第六轮续）

**两个结论，一个推翻我的判断，一个找到我找错了方向的东西。**

#### 5.8.1 结论一：`create` → `delete` 进回收站，"难回"不成立（原判断被推翻）

`pi/src/adapter/fileops.js` `delete()`：

```js
:83   const dest = join(this.recycleDir, `${Date.now()}-${receiptId}-${basename(abs)}`);
:84   this.#moveTree(abs, dest);
:85   this.#log({ receiptId, op:'delete', target: abs, recycledTo: dest, toolCallId });
```

**删除就是把文件"搬进回收站"，不是 unlink。** 无论该文件是"AI 新建的"还是"早就存在的"，
**都进回收站，都可 `restore`**。

`restore()` 的注释（`:138–143`）也确认了另一半：
> Creation tombstones (`op 'create'`, or `'write'` with no backup artifact) undo by
> **recycling the target** — the file did not exist pre-mutation, so undo means it
> should not exist afterwards either.

即**新建 → 删除**这条链，回退方式是"把新建的文件再删一次（进回收站）"。

**所以 `change-digest-spec.md` §5.5.1 的分级依据"`create` 无 backup = 难回"不成立。**
`create` 的 tombstone 确实没有 `backup`（`:103 backup: null, preSha: null`），
但**"没有 backup"不等于"难回"** —— 它的可回性来自 **`delete` 的 `recycledTo`**，不是来自 `backup`。

> **这是本轮我犯的一个推理错误**：我把"receipt 里 `backup` 字段为 null"直接读成
> "不可恢复"。实际的可恢复性由**两个独立机制**（`backups/` 与 `recycleDir/`）分别提供，
> 我只看了前者。

#### 5.8.2 结论二：真正的时效衰减来自 `#sweep`，且限额是硬编码的 200

`instance_purge` 碰不到收据（§5.7），**但 `#sweep` 会**：

```js
:55   /** Evict oldest artifacts beyond the cap; receipted as purge (invisible to undo). */
:56   #sweep(dirPath) {
:63     for (const f of files.slice(0, Math.max(0, files.length - this.artifactCap))) {
:65       rmSync(f.p, { recursive: true, force: true });
:66       this.#log({ op: 'purge', target: f.p, swept: true });
```

调用点（`:86` / `:110` / `:133` / `:158` / `:172`）覆盖 delete、backup、write、restore 全部分支 ——
**每一次文件变更都会触发一次淘汰检查。**

**限额**：`pi/src/adapter/fileops.js:30 constructor(instanceRoot, { artifactCap = 200 })`。
实例化处只有一个：`pi/src/bootstrap/host.js:758 const fileOps = new FileOpsGuard(core.paths.root);`
—— **没传第二个参数，所以 `artifactCap` 永远是默认的 200。**

**且 200 是硬编码默认值：没有配置文件、没有环境变量、没有命令可改。**
（对比 `budget` 有 `budget-overrides.json` + `budget_set` 命令，是**可调**的。）

**所以真实语义是**：

> **每个 store 各保留最近 200 个产物（`backups/` 与 `recycleDir/` 各 200）。
> 第 201 次文件变更起，最早的备份/回收件被静默删除，
> 且该删除本身被记为 `op:'purge', swept:true` —— 注释明写 "invisible to undo"。**

#### 5.8.3 这对规格意味着什么

**§5.5.2 的担忧方向是对的，机制找错了。**

| | 原判断 | 查实后 |
|---|---|---|
| 衰减源 | `purge` 清空回收站 | **`#sweep` 按 200 上限淘汰** |
| 是否可控 | —— | **不可控**（硬编码，无配置面） |
| 是否可观测 | —— | **部分可观测**：`op:'purge'` 收据在 `fileops_list` 里 |
| 影响 | §3 第 2 层分级需叠加时效维度 | **不需要** —— 见下 |

**曾据此提出"第 2 层需增加变更计数维度、靠 purge 收据位置推断"——该提议随后被推翻。**
`pi/src/adapter/fileops.js:297` 已经在算：

```js
const recoverable = Boolean(o.recycledTo ?? o.backup) && existsSync(o.recycledTo ?? o.backup);
```

**对每条回执做 `existsSync` 实测**（不是从淘汰顺序反推），并在 `:306` 另给 `undoable`。
且 UI 已在消费（`app.js:2734` / `3279` / `3323`）。
**所以第 2 层不需要新增维度，直接用现成字段。**

**"`artifactCap` 是否应可配" —— 结论：不该配**（详见 `change-digest-spec.md` §5.7.3）：

1. **对用户需求零增益**：`recoverable` 是实时实测，无论上限多少，UI 答案永远正确。
2. **引入新风险**：若 AI 能写此值 → **AI 可调低自己的回滚窗口，抹掉自己改动的证据**。
   这与 `instance_purge` 拒绝 `receipts` 并称其为 **enforcement evidence** 是同一类防护。
   → 只能 operator-owned，绝不可 agent-writable。
3. **两个方向都更糟**：调大 → `#sweep` 更慢（它在**每次变更**时对每个产物 `readdirSync`+`statSync`）；
   调小 → 更早失去回滚。
4. **长程任务治不了**：窗口是**全局永久**的，长任务会把自己早期的改动挤出窗口。
   调大只是推迟；正确修法是作用域（按任务/会话）。

**真正的无界项不是产物，是索引**：
`backups/` + `recycle/` 有上限（各 200 件），而 `fileops.jsonl` **无上限、无轮转、无大小限制**
（`:34`, `:312`），且 `#ops()`（`:237–244`）**每次全量 `readFileSync` + 逐行 `JSON.parse`**，
`list`/`listAll`/`diff`/`undoCall`/`undoFrom` 全部经由它。

**修法项目里已有先例**：`host/src/core/observation.js:45–57` 用 `(size, mtimeMs)` 指纹缓存
避免在 append-only 文件上全量扫描（注释专门写了这个教训）。
**`FileOpsGuard.#ops()` 有完全相同的问题，却没有缓存。**

**对 `change-digest-spec.md` 的修正（已落盘）**：

1. §5.5.1 的分级依据（`create` 无 backup）**错误** → 已删。
2. §3 第 2 层**不需要新增"变更计数"维度** → 直接用 `recoverable`/`undoable`。
3. §5.5.2 的"purge 触发条件"已改写为 `#sweep`（`instance_purge` 不相关）。
4. `artifactCap` 可配 → **已论证为不该配**（§5.7.3）。

### 5.9 已查证事项汇总

| 环节 | 位置 | 触达 world-model | 触达 audit / 其他留痕 |
|---|---|---|---|
| UI 撤销按钮 | `app/ui/app.js` `fileops_restore` | ✗ | ✗ |
| supervisor 透传 | `supervisor.js:757` default 分支 | ✗ | ✗ |
| host channel 撤销 | `host/src/core/channel.js:677` | ✗ | ✗ |
| body fileops 撤销 | `pi/src/adapter/fileops.js:144` | ✗（`grep world\|observe\|emit` 零命中） | ✗ |
| UI 授权按钮 | `app/ui/app.js:759,795` `decision_resolve` | ✗ | — |
| host channel 授权 | `host/src/core/channel.js:969` | ✗ | — |
| **asks 授权落账** | **`host/src/core/asks.js:168`** | ✗ | **✓ `ASK_RESOLVED`**（含 `rule`/`kind`/`answer`/`edited`） |
| **`ASK_RESOLVED` 聚合** | **`pi/src/bootstrap/host.js:1331–1350`** | ✗ | ✓（读 audit 分桶为 `asks`） |
| body decide 授权 | `pi/src/bootstrap/decide.js:236–484` | ✗ | **✓**（`_RESOLVED` 系列） |
| host channel 急停 | `host/src/core/channel.js:207` | ✗ | **✓ `STOP_ALL`** |
| **abort 中断标注** | **`pi/src/adapter/channel.js:290–306`** | ✗ | **△ `pai.user_interrupt`——只进模型下一轮 prompt，无消费方** |
| host channel 中止 | `host/src/core/channel.js:187–189` | ✗ | ✗ |
| host channel 插话 | `host/src/core/channel.js:186` | ✗ | **✗（body 侧 `box.s.steer` 是否另有标注未查）** |
| audit 自身 | `host/src/core/audit.js` | ✗（零命中） | — |
| world-model 订阅面 | `world-model.mjs:783, 830` | 仅 `tools/result` + `session/event`（后者每会话仅处理一次） | — |

### 5.10 改动可追溯性（第五轮查证）—— §0 主张的技术基础

§0 提出"给换算结果而非原料"。**其可行性依赖"改动能否被自动换算"，本轮查实：可以。**

| 需要的基础 | 实现 | 证据 |
|---|---|---|
| 知道改了什么 | **`diff()` 产出 unified diff** | `fileops.js:266–291` |
| 知道改动前是什么 | **`preSha`（sha256）+ `backup`（实际备份文件路径）** | `fileops.js:106, 109, 126, 132` |
| 知道哪些改动危险 | **`op.op` 可分级** | 取值见下 |
| 知道哪些属同一次调用 | **每条回执带 `toolCallId`** | `fileops.js:85, 103, 109, 132` |

**`op.op` 完整取值**（`fileops.js`）：

```
purge · delete · create · backup · write · restore · restore-displace
```

**分级依据的正确形式**：不是"改动大小"（此前的直觉，已撤回），
而是 **"有无 backup 兜底"**——

- `delete`（`recycledTo` 回收站）/ `purge`（清空回收站）—— **真正丢东西**
- `create`（tombstone，无 backup）/ `write` / `backup` —— **有 backup 可回**
- `restore` / `restore-displace` —— 恢复动作本身

**删除确实在追踪范围内**（推翻此前猜测）：`fileops.js:85`
`this.#log({ receiptId, op:'delete', target: abs, recycledTo: dest, toolCallId })`
—— 可恢复删除，移到回收站并记录位置。`diff()` 对 delete 单独处理
（`recycled bytes → empty`，`fileops.js:280`）。

> 此前从 `fileops_diff` 兜底串 `'无差异（产物已不在）'` 推断"删除可能追不到"——
> **该推断错误**：兜底针对的是**备份/回收文件本身被清理后**的情况，不是删除操作本身。

**结论：四条基础全备，且同在 `fileops.js` 单一出口。**
**缺的从来不是数据，是把 `diff()` 结果换算成人能判断的形态。**

---

## 6. 本规格自身的可修正性

按 briefing 第 3 段要求（每条认知带 `falsifier`），本规格同样标注推翻条件：

| 主张 | Falsifier（推翻条件） |
|---|---|
| §0 "给换算结果而非原料" | ~~若取证发现用户在**大改动时确实会逐行读 diff 并据此决策**~~ → **§5.2 已查实技术基础具备，转入"待验证效果"**。新的 falsifier：若换算后的结论（如"测试 312→298"）实测仍不足以支撑人的撤/留决策，则该结论不成立 |
| §3 G1 "unresolved 到不了人眼前" | 若发现另有通路（如 AI 主动复述）已覆盖，则 G1 降级 |
| §3 G2 "用户反馈不在回路" | ~~若 `app/server` 已把用户操作路由进 `INPUT_SEMANTICS`~~ → **已查证不成立（§3.5 有追踪链）**。新的 falsifier：若发现 audit 与世界模型之间另有未查的桥，则 §3.5.2 根因判断需修正 |
| §3.5.3 "桥只能建在 app/" | 若 `AGENTS.md` 的分层约束调整（如允许 dsh 读 host audit），则桥的位置应重算 |
| §4.1 "app 层是呈现与授权接口" | 若机制层已有更合适的呈现位（如 briefing 已覆盖），则 app 层职责应再缩 |
| §4.2 约束 A / B | 若 `governance.yaml` 的 `normative_authorities` 结构调整，约束随之重算 |
| §4.4 "四处接入单点" | 若实测发现路径不止这四处（如另有绕过 channel 的直连），则"单点"判断不成立。~~`rule` 字段是否可靠~~ → **已查实（§5.5）：`rule` 在写入处完整，但在聚合处被丢弃（`host.js:1344` 只读 `answer`）—— 不是字段不可靠，是聚合层没保留** |
| ~~§3.5.5 "abort/steer 无留痕"~~ | ~~若另有留痕~~ → **已全部查实：`abort` 有 body 侧注解但 host 侧零留痕（§5.4）；`steer` 连注解都没有（§5.6）** |
| §3.5.6 "`pai.user_interrupt` 无消费方" | 若发现消费方在 `pi/` 之外（如 harness 层），则该判断需修正。本轮 grep 范围为 `.js/.mjs/.py` 且排除 `node_modules`/`.taskflow` |
| ~~§5.2 "分级依据是有无 backup 兜底"~~ | ~~若 `purge` 频繁清空回收站~~ → **已查实推翻（§5.8）：`instance_purge` 不可碰收据，`#sweep` 才是衰减源且限额硬编码 200**。→ 后又二次推翻：**判据改为直接用 `recoverable`/`undoable`**（`change-digest-spec.md` §5.7.2） |
| **§2.5 "回路在当前组合下跑不起来"** | 若发现 app 另有一条不走 `bodies.js` 的 dsh 启动路径（如 dev 模式直启 dsh），则"只能跑 pi"不成立。**本轮只查了 `app/server/bodies.js` 与 `instance/runtime.json`** |
| **§2.5.2③ "dsh fail-closed 不合格"** | 若 `REQUIRED_BODY_CAPABILITIES` 被放宽（如 `final_post_extension_guard` 改为 negotiable），或 dsh 补上该能力，则 dsh 变为可选，结论重算 |
| **§2.5.6 "能力声明与实际装配可能脱钩"** | 若查明 `loop_observability` 指代的是 audit/事件流而非 `loopGovernanceExtension`，则 (a) 成立、(b) 不成立，该矛盾消解 |
| **§2.5.5 "外层条件作用域过宽，删掉即可"** | 若发现外层三元另有未查的作用（如防止无 continuation/fallback 时扩展产生副作用），则"多余"判断不成立。**本轮已核 `loop.js` 四个参数全部空值守卫（`:154/:167–168/:219/:127/:135/:227`），但未做运行时验证** |
| **§2.5.5⑥ "pi 侧无提炼半"** | 若发现 pi 侧另有消费 observation 做提炼的路径（本轮 grep 只覆盖 `pi/`+`host/` 的 `.js/.mjs`，排除了 `node_modules`/`tests`），则该边界判断需修正 |
| **§2.5.7② "pi 无预测写入方"** | 若发现预测经 `world_model` 之外的其他面创建（如某个未被 grep 覆盖的 `.mjs`/`.py` 入口），则"根本没有写入方"不成立。**本轮 grep 覆盖 `pi/`+`host/`+`app/`+`dsh/` 的 `.js`/`.mjs`** |
| ~~§2.5.7⑥ "README 与实测矛盾"~~ | ~~若能找到 dsh 侧真实会话跑通的日志/状态~~ → **已查实（第十轮）：本机 1.6GB/160 万行/17 会话 0 命中；插件装于 9-16，实质会话全在 9-14 前；装后唯一会话 4 行。** 管道本身 50 测试全过（含通过 `simulate_body.mjs` 驱动真实插件）。**结论：集成层未被真实会话验证。** 剩余不可判定项：是否在另一台"研究机"验证过（本机无 `WORLD_MODEL_HOME`、无 legacy pilot 路径） |
| **§2.5.7⑤ "两份实现会漂移"** | 若决定 pi 侧只做"事件产生 + 读"，把提炼留在 dsh（即不移植管道），则不存在两份实现，该风险消失 |

**本规格不是结论，是待验证的假设集。** 每一条都等着事实来确认或推翻。
**已查实的结论（G2、§3.5、§2.5）从"假设"转为"事实"，但仍保留 falsifier——事实也可能被更强的证据推翻。**
