---
name: world-model-runtime
description: 在重要任务上运行完整世界模型闭环的执行协议——恢复持久状态→建立竞争模型→显式预测→真实观察→修订模型→主动取证→决策→持久化。用于多步、高风险、跨会话、存在竞争解释或需要持久世界模型的真实任务，不用于简单一次性任务；加载后由本协议的模式判据自判 OFF/CORE/FULL 形式化深度。
---

# 世界模型运行时

你正在执行一个带持久世界模型的任务。世界模型不是记忆库，是「当前对世界如何运作的最佳压缩 + 主动被测试的对象」。本协议定义九环如何真实执行，不是形式主义清单。

## 模式

**加载条件**（本 skill 何时该被用）与**形式化深度**（OFF/CORE/FULL）是两件事，不要混：

- **加载条件**由本 skill 的 description 表述——"用于多步、高风险、跨会话、存在竞争解释
  或需要持久世界模型的真实任务，不用于简单一次性任务"。
  （`tier: conditional` 的判据就在 description 里，与其余 conditional skill 同一机制。）
- **形式化深度**由本协议**自判**（见下），在本会话开始时声明并写入 working state。

形式化深度：

- **OFF**：简单一次性任务，不启用本协议。
- **CORE**：重要任务基本闭环。必须实质运行：Observation / State / World Model / Prediction / Uncertainty / Action / Model Revision / Persist。
- **FULL**：CORE + 竞争模型、重大不确定性、复杂决策、预测失败或长程任务。追加评估：Active Learning / Value-Decision / Goodhart / Meta。

FULL 中每一环标 `USED / NOT_NEEDED(reason) / UNKNOWN`，允许空环但不允许跳过评估。

> 注：形式化深度**不是开关**——世界模型永远在场，OFF/CORE/FULL 只是仪式深度。
> 另有插件侧的静态 `config.mode`（`dsh/world-model/cordis.patch.yml`），
> 那是**守卫严格度**的部署配置，与本协议的会话内自判不是同一件事。

## 不变量

不变量是**常驻规则**，在 `instruction/generated.md` §3 随指令信封每轮注入 —— 此处不再重复。
（不写条数：条数会随规范件演进而漂，而这里写死的数字会静默过期 —— 以 `instruction/generated.md` §3 为准。）
补充两点它不展开的：

- 不变量 1 的权威依据是 `governance.yaml` 的 `revision_rules[0] = predict-before-change`，
  由门禁**强制执行**。
- 不变量 6 的边界：持久化可审计的事实与引用，**不含私有思维全文** ——
  写 state 时问"这条以后能用来判定我错了没有"。

## 状态层（读写契约）

```text
Canonical SSOT:  <canonicalDir>（config.canonicalDir 或 WORLD_MODEL_HOME 指向的目录；
                 也支持 WORLD_MODEL_REPO + PAI_PILOT 的仓布局 <REPO>/pilot/<PILOT>/canonical）
  current.yaml      当前最佳压缩模型。每条模型条目字段：
                    命题 / 状态(当前最佳|竞争) / 定性置信 / 支持证据ref /
                    反例 / 竞争解释 / 适用范围(Model Coverage) /
                    模型依赖(本结论依赖哪些上游模型) / 未知 / 异常 /
                    区分性观察(若H1为真应见…若H2为真应见…) /
                    更新历史(旧模型→新模型及原因) / 来源
                    另含 Open Predictions / Known Residuals / Open Loops /
                    watermark / evidence refs
  operators.yaml    失效模式→算子表（provisional/validated/superseded）
  open-loops.yaml   未闭合观察口
  history/          重大修订快照

Runtime:  <stateDir>（**身体自己的适配器决定**：DSH 用 ~/.dsh/world-model/，
  pi 用 <instance>/world-model/）
  ledger/YYYY-MM-DD.jsonl   append-only 事件流   ← 契约（mind/distill.py 读）
  runs/<session-id>.jsonl   单会话轨迹           ← 契约（mind/lp_evaluator.py 读）
  current.json      materialized 工作状态        ← 适配器内部，工具链不读

Episode schema（L1 情境记忆，ledger/runs 事件）：
  event_id / schema_version / session_id / task_id / event_type /
  timestamp / actor / subject / scope / happened(一句话,细节引用L0) /
  payload / evidence_refs /
  因果关联: prediction_id / action_id / model_id / supersedes /
  source(provenance) / evaluation_awareness
不要求每种事件全填，但 ID、类型、引用、因果关联必须存在——
要能机械回答「这个观察评价的是哪个预测」「这次更新替代哪个旧模型」。

Prediction schema（门禁绑定用，缺一不可）：
  prediction_id / subject / intended_action(绑定哪类动作) /
  expected_observation / falsifier(什么结果算错) / time_horizon /
  confidence_bucket / evidence_refs / created_at_event_id
禁止万能预测——不绑定具体动作范围的预测不能解锁 mutation。

工具风险分级（机械分级，模型不自报）：
  read / reversible-low / consequential / high-risk / irreversible
CORE 模式只拦 consequential 及以上：无绑定预测→guard 拒绝放行。
临时文件/格式化等 reversible-low 不设门禁。
```

## 执行时序（CORE 必须出现，顺序即验收）

> 常驻形态见 `instruction/generated.md` §6。下面是展开版，多出 STATE_RESTORE / CURRENT_MODEL
> 两环 —— 那是"这轮开始时怎么接上状态"，不是"每次变更怎么做"。

```text
WM_ACTIVATE        声明进入 CORE/FULL 及理由
STATE_RESTORE      先对**自己的输入**持有预期：该收到什么（先验状态、运行规则、行动记录），
                   缺了就显式报"未收到、原因未知"——**不得从记忆里枚举渠道**
                   （清单只能覆盖你想得到的；漏掉的那个才可能是坏的）
                   再读 canonical current.yaml + watermark 后的 ledger → 构造 working state
CURRENT_MODEL      写出当前模型与 Model Coverage（哪些算数、哪些不算）
PREDICTION_CREATED 每条预测：可证伪、绑定将做的 Action、标置信（定性，不伪精确）
ACTION / QUERY     真实工具调用/检查/改动
OBSERVATION_RECORDED  只记录真实回读证据，引用 evidence ref（session id / 文件 / 测试）
PREDICTION_EVALUATED  逐条对照：confirmed / refuted / partial
UPDATE_APPLIED 或 NO_UPDATE  引用具体 Prediction+Observation；失败预测 → residual 标签 +
                   参数修订/结构修订/H4(换问题表征) 三选一明确记录
STATE_PERSISTED    append ledger + 更新 runtime current.json；
                   达到重大变化门槛才写 canonical（见下）
```

## 各环要点

- **Observation**：RAW→OBS 升级需显式关联 prediction_id；只收真实证据，标注来源。
- **Representation**：决定什么值得表示——原始证据不复制进模型，只存引用。
- **World Model**：显式列 Current Model；存在分歧时列 Competing Models（H1/H2/H3），各自带可区分预测。
- **Uncertainty**：定性置信 + 依据；关键不确定应转为主动取证点。
- **Active Learning**（FULL）：当存在能区分竞争模型的查询时，优先做信息增益最高的检查而非最顺手的。
- **Action**：Exploit（已知有效路径）/ Explore（减少关键不确定）/ Probe（探测模型假设）——标类型。
- **Model Revision**：改参数 / 改结构 / H4 换表征；旧模型结论保留，记录被替代原因（不抹历史）。
- **Value/Decision**（FULL）：写下当前目标、决策标准、代理指标风险（Goodhart：优化的是目标还是指标？）。价值更新走 `PROPOSED→provenance→reason→authorization→accepted`，Outcome 不得直接覆写长期价值。
- **Meta**：评估继续思考/取证的价值；收益低则停止并记理由。记录 bottleneck 诊断（information/computation/model/value）。

## Canonical 写入门槛

> 权威依据：`instruction/generated.md` §1（`canonical_write: u1_governed`）与 §5（各类变更流程）。

runtime ledger 随时可写；canonical **只允许 proposal→治理路径写入**，runtime 不得自动改写：失效模式新增/算子升降级、Current Model 实质修订、Open Loop 开关、跨会话需要继承的持久结论，均先落 `proposals/` 待审。普通任务流水不进 canonical。

Learning Progress（可记录，禁止当 reward 优化）：
  按域跟踪 prediction coverage / resolved / exact-partial-failed /
  confidence_bucket / difficulty-novelty(可UNKNOWN) / natural-or-test /
  abstention / specificity。learnable/noise 标记只 provisional，
  不因单次失败定案。只预测容易的事是 Goodhart 自证。

## 会话结束契约

结束前确保：ledger 已 append、current.json 已更新、开放口已登记；下一次新会话 STATE_RESTORE 应能拿到本次全部持久结论——否则本协议未真实运行。
