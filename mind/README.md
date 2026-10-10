# mind/ — 认知状态的维护工具链

Personal AI 的**认知运作层**：把证据治理化地落成 canonical 认知状态。

与 `soul/` 配对，但**不同类**：

| 目录 | 回答 | 是什么 |
|---|---|---|
| [`soul/`](../soul/README.md) | 它**信什么** | 可携带的 W/V/U/L 认知**状态**（数据） |
| **`mind/`** | 它**怎么变** | 维护该状态的**工具链**（代码） |

> ⚠️ **边界（读本目录前必读）**
>
> 1. **本目录只放运作机制，不放状态。** 状态在 `soul/`。
> 2. **本目录不属于任何身体。** 所有工具只吃目录路径
>    （`--state` / `--canonical` / `--proposal` / `--out`），不含 harness 概念，
>    **也不出现任何身体的名字**（无默认适配器、无默认 harness 名）。
>    身体接入由**各身体自己的适配器**提供 —— 适配器不在本目录，
>    本目录只定义它们必须共同满足的契约（BCC-1）。
> 3. **本目录的工具在 agent 权限之外。** 宪法约束
>    （`soul/bootstrap/canonical/governance.yaml`）规定
>    `normative_authority_root: owner`、`canonical_write: u1_governed`，
>    且"认知可靠不等于规范权威"——**agent 不得写 canonical**。
>    `u1_accept.py` 是唯一 canonical 写者，因此这一步必须发生在 agent 之外。

## 为什么在这里

`soul/` 的准入规则（`soul/README.md`）只列两类内容：脱敏链产出的衍生物、为公开编写的模板。
**工具链不属于其中任何一类**——它是产出状态的机器，不是状态本身，也不是它的模板。

本仓原先把它放在 `dsh/world-model/`（一个身体适配器的目录下），
这使它与适配器混为一类，读者容易误认为"世界模型属于 dsh"。
**它是 harness 无关的，因此归位到认知层，与 `soul/` 平级。**

## 与 schema 同生命周期

本目录的工具**随 `soul/schema/` 的版本一起演进**
（`migrate_v031.py` 的名字引用的就是 **schema 版本** V0.3.1，不是 harness），
所以它与 `soul/schema/` 必须能一起发布、一起被引用——**但同居一处不等于同类**。

> **不在此写死"几个工具/几个引用 schema"**：这类数字会随文件增减静默过期，
> 而且没有门禁会去核它。要看清单就读下面这块布局，要看"谁碰 schema"就 `grep -l schema mind/*.py`。

## 布局

```
mind/
├── distiller.py           # A：closed episodes → evidence packet → problem object
│                          #    抽象器协议（none/file/template）+ grounding validator
│                          #    → MODEL_PROPOSAL（只写 proposals/，从不写 current.yaml）
├── hypothesis_search.py   # B：problem object → H4（8 算子库 + applicability）
│                          #    统一 worker 契约；--mark 写 HYPOTHESIS_STATE_UPDATE
├── lp_evaluator.py        # Learning Progress 只读评估（closed episodes → metric vector）
│                          #    无 canonical 写权
├── u1_accept.py           # U1 governed apply：唯一 canonical 写者
│                          #    proposal → canonical + rollback 备份 + provisional 状态
├── canonical_compile.py   # 编译 briefing.md（GENERATED，不可手写）+ runtime-state.json 投影
├── instruction_compile.py # 编译 instruction/generated.md（governance → agent 可读形态）
│                          #    两级预算：超 target 报 OVER_TARGET、超 hard cap 才截断并 exit 2
│                          #    段源缺失时显式写 NOT DECLARED，永不静默省略
├── reversibility_compile.py # 把 canonical 里学到的"可逆性"模型编译成门禁可读的 overlay
│                          #    （finding G11：先验保守、学习只放宽、陈旧即整份失效）
├── wm_cycle.py            # 提炼链入口（蒸馏 → 假设 → LP → 编译），**在 u1_accept 之前停下**
│                          #    —— 不自我授权：canonical 写入只能走治理路径
├── migrate_v031.py        # canonical schema 1.0→1.1 迁移/回滚/verify（不 silent drop）
├── distill.py             # 蒸馏入口/编排
├── bcc_check.py           # BCC-1 身体兼容契约测试台（V0.3.1 §10）
│                          #   被测适配器由调用方经 BCC_PLUGIN 指定（无默认）
└── simulate_body.mjs      # 模拟体：以 mock ctx 加载适配器，供契约测试驱动
                           # 本身不含任何身体路径 —— 被测适配器由 harness 经
                           # BCC_PLUGIN 传入（加新身体无需改这个文件）
```

## 状态层（工具读写的位置）

```text
canonical（状态，属 soul 侧）  <canonicalDir>
  current.yaml / operators.yaml / open-loops.yaml / lineage.yaml /
  governance.yaml / sources.yaml / interfaces.yaml
  proposals/   提案（治理路径入口）
  history/     重大修订快照（append-only）

runtime（L1，随时可写）        <stateDir>（调用方指定；本目录不预设路径）
  ledger/YYYY-MM-DD.jsonl   append-only 事件流
  runs/<session-id>.jsonl   单会话轨迹
```

**canonical 只接受 `proposals/` 路径写入，runtime 不得自动改写。**

## 契约：BCC-1

`bcc_check.py` 是 **Body Compatibility Contract** 的一致性测试台（V0.3.1 §10），
六条协议：

| # | 协议 | 含义 |
|---|---|---|
| 6.1 | State Semantics | **同一份 canonical 放在两个 body 目录下 → 投影必须相等** |
| 6.2 | Event Ordering | 真实 ledger 的事件序（`seq` 单调 + `prev_event` 因果链 + 预测先于评估先于更新） |
| 6.3 | Guard Semantics | 真实适配器 vs python 参照体，同一批 fixture。**含别名键抗性**：载荷藏在 `parameters`/`tool_input`/自有键下时仍须被扫描 —— *看不见的载荷 = 绑定绕过面（藏起来 ≠ 不存在）* |
| 6.4 | Tool Identity | body 改名不改变 canonical 身份。**⚠️ 尚未测试** —— 契约侧缺夹具、身体侧缺映射（适配器现在把 `canonical_tool_id` 与 `body_tool_id` **都赋成同一个值**）。报告为 `pass: null`（未测），不计入总判定。所需机制：身体声明 `{身体工具名 → canonical 名}`，适配器两个字段都发，夹具驱动改名后的工具并读 ledger。分类器侧已备好 `resolveToolId(name, aliases)` |
| 6.5 | Persistence | 杀死点下的持久性。**语义判据**（2026-09-23 改）：① 未决预测经 persist 后仍能被适配器自己的 `status` 报告；② 存在只追加的日志（判据 = 前次内容是后次内容的**前缀**，不写死文件名）；③ 日志尾部被写坏后 `status` 仍可用 |
| 6.6 | Schema Compatibility | 1.0 fixture → migrate → verify → rollback 必须字节一致 |

**新增身体时，其适配器必须满足这六条。** 测试台**不绑定任何身体**：
被测适配器由调用方经 `BCC_PLUGIN` **显式传入，没有默认值** ——
通用侧不认识任何具体身体，所以不替调用方选一个。
`simulate_body.mjs` 里同样**没有任何身体路径**，加新身体不需要改它。

```bash
# 跑契约（必须指定被测适配器）
BCC_PLUGIN=<path/to/adapter.mjs> python mind/bcc_check.py
# 仓库级回归会自己指定本仓身体：python -m unittest tests.test_wm_v031
```

**6.3 的别名键抗性由 `exec_extra` 夹具强制**（2026-09-23 补）：
`simulate_body.mjs` 会把场景步骤里的 `exec_extra` **展开**到 execution 上，
模拟"同一意图换了个键名"的形态。只读 `arguments` 的守卫会**放行**本该拒绝的调用 ——
夹具会抓到它。参考实现与真实适配器都通过这三条夹具。

## 回归

```bash
python -m unittest tests.test_wm_v031 -v     # 50 项，覆盖管道 + 契约
```

需要 `yaml`（`canonical_compile.py` 依赖）。托管 Python 无此模块时用系统 Python。

## 运行时协议在哪

**不在本目录。** agent 执行的九环协议在
[`skills/world-model-runtime/`](../skills/world-model-runtime/SKILL.md)（层 ① Skill 包）。
分工：`skills/` 放**协议**（agent 侧），`mind/` 放**治理化落地**（agent 之外）。
