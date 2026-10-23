# 提案 kind 契约差距 — 生产端已收敛，消费端没跟上

- 记录时间：2026-10-23
- 判定对象：`mind/u1_accept.py`（唯一 canonical 写入者）与 `dsh/world-model/world-model.mjs` 的 `KIND_BY_CLASS`
- 状态：**D0 已完成**；队列已两批出清（§4.1 化石代 62 + §4.2 `canonical`/`value-update` 22，`proposed` 89 → 5）；D1 未开始，但范围已修订（§7.1：先堵生产端逃逸口，再补消费端通道）
- 触发：D08 的 C22 只能否决、不能采纳。初判为"87 个提案 kind 断裂"，实测后该数字误导
- 本版订正两处：§2 的"切线后 model-update = 0 个"是按文件名 glob 得出的错误结论（改按 `kind` 实测 + 换依据）；§7 的"D1 是 C22 取证真前置"已修正（队列里本就有一条完整 `MODEL_PROPOSAL`，accept 路径今天可行使）

---

## 1. 一句话结论

生产端在 **2026-09-15**（commit `f034133`）就用一张封闭词表 `KIND_BY_CLASS` 把提案 kind 收敛成了 9 个可选值，并把 `world_model` 类对齐到了 `u1_accept` 的消费契约。**消费端此后没有回头**：仍然只认 2 个 kind，而队列里躺着 100 个提案、18 种 kind。

所以这不是"契约从未建立"，是"**契约建立了，另一端没接上，旧世代也没有人收尸**"。二者的工作量差一个数量级。

---

## 2. 证据：时间戳切线

`world-model.mjs:1202-1210` 的 `KIND_BY_CLASS` 是封闭词表，注释里写得很清楚：

> 任意字符串不得成为提案 kind（逃避类属评审），且 world_model 类必须发 u1_accept.py 可消费的 MODEL_PROPOSAL + payload.candidate —— 否则提案永远进不了 apply 通道。

引入时间：`f034133`，2026-09-15。

**切线实测**（真实队列 `canonical/proposals/`，100 个文件）：

| kind | 数量 | 时间跨度 | 状态 |
|---|---:|---|---|
| `model-update` | 64 | 2026-09-12 .. **2026-10-10**（见下方订正） | **withdrawn 62** / accepted 2 |
| `canonical` | 15 | 2026-09-12 .. 2026-09-13 | proposed 15 |
| `value-update` | 7 | 2026-09-12 .. 2026-09-13 | proposed 7 |
| `HYPOTHESIS_STATE_UPDATE` | 2 | 2026-09-13 | proposed 2 |
| `MODEL_PROPOSAL` | 2 | 2026-09-13 | proposed 1 / accepted 1 |
| `governance_u1` | 2 | 2026-09-14 | accepted 2 |
| `schema` | 2 | 2026-09-14 | accepted 1 / withdrawn 1 |
| `config-declaration` | 2 | 2026-10-10 | accepted 2 |
| `declassification` | 1 | 2026-09-13 | approved 1 |
| `HYPOTHESIS_PROPOSAL` | 1 | 2026-09-13 | proposed 1 |
| `STATUS_UPDATE` | 1 | 2026-09-16（用 `created` 字段，无 `timestamp`） | accepted 1 |
| `NOTE_PROPOSAL` | 1 | 2026-09-20 | proposed 1 |

**订正（2026-10-23，执行批量 withdraw 时发现）**：本文初版写"`timestamp >= 2026-09-15` 的 `model-update` = 0 个"。那是**按文件名 `glob('*model-update*.json')` 取的子集**，不是按 `kind` 取的集合 —— 而恰好有一个文件的文件名里不带这个串：

```
2026-10-10-schema-1.2-conformance-backfill.json   kind=model-update
  timestamp=2026-10-10T00:00:00Z  status=accepted
  proposer="claude-code (local agent), per owner standing instruction chain 2026-10-10"
  payload keys: background / changes / evidence_refs / freeze_interaction /
                post_change_validation / rollback / schema_layer_defect_registered / title
```

按 `kind` 实测：**切线之后仍有 1 个 `model-update`**，不是 0。

这**不影响**"生产者已死"的结论，但改变它的依据。原先的依据（时间戳一刀切）是错的，正确的依据有两条，都可机械复核：

1. **生产端词表**：`KIND_BY_CLASS` 把 `world_model` 类映射到 `MODEL_PROPOSAL`，此后 `writeProposal('model-update', …)` 在 `.mjs` 里已无调用点 —— 机器路径不再产出这个 kind。
2. **那唯一一条切线后的件是人写的，不是机器产的**：`proposer` 明写 `claude-code (local agent)`，且 **payload 里没有 `candidate`** —— 与 `KIND_BY_CLASS` 承诺的 `MODEL_PROPOSAL + payload.candidate` 形状不同。它是一次 schema 1.2 一致性回填提案，走的是人工授权链，不是 class 映射。

所以正确表述是：**`model-update` 的机器生产者于 2026-09-15 消失；此后仅有的 1 条是人工回填，且已被 accept。** 62 个待处置文件全部落在 2026-09-12 .. 2026-09-14，无一例外。

---

## 3. 四层分类（18 种 kind，互斥且穷尽）

消费端登记表在 `mind/u1_accept.py` 的 `KIND_BUCKETS`，本表是它的散文版。

### 3.1 有 apply 通道（2）

| kind | 落点 |
|---|---|
| `MODEL_PROPOSAL` | `current.yaml` → `world_model.models[id]` |
| `STATUS_UPDATE` | `open-loops.yaml` 白名单字段 |

### 3.2 live 债务 —— 生产者还活着，消费端没有通道（2）

| kind | 生产者 | 为什么危险 |
|---|---|---|
| `value-update` | `world-model.mjs:1236 / :1286 / :1320` | 今天仍会产出，产出来就永远无法落盘 |
| `canonical` | `world-model.mjs:1349` | 同上 |

**这两个是 D1 的真正标的**，也是 C22 采纳取证的前置：即使开了抽象器产出提案，只要落在这一类，照样进不了 apply。

### 3.3 声明了但从未产出（7）

`governance-u0` / `governance-u1` / `lineage-update` / `body-binding` / `gate-policy` / `schema-update` / `declassification`

词表里有，队列里 0 条。属"声明大于实现"，记债不排期。

### 3.4 化石代 —— 生产者已不存在（4）

| kind | 判据 |
|---|---|
| `model-update` | 词表中已无此输出；2026-09-15 后 0 条 |
| `governance_u1` | 词表用的是 `governance-u1`（连字符），队列里是下划线版 |
| `schema` | 词表用的是 `schema-update` |
| `config-declaration` | 词表无此类 |

### 3.5 别家的（3）

`HYPOTHESIS_PROPOSAL` / `HYPOTHESIS_STATE_UPDATE`（`mind/hypothesis_search.py:233,277`）、`NOTE_PROPOSAL`（人工升级件）。归生产者自己裁决，不归 `u1_accept`。

---

## 4. 化石代处置（已决断）

**批量 withdraw，不逐条做语义比对。**

- 元数据统一附 `reason: "fossil_kind_retired_at_2026-09-15_commit_f034133"`；
- 状态只写提案文件，**canonical 零改动**；
- 可逆：`withdraw` 是标准生命周期状态，JSON 里保留完整 decision 记录。

**精度修正**：64 个文件里 **62 个是 `proposed`，2 个已经是 `accepted`**。批量 withdraw 的标的因此是 **62**，不是 64 —— 那 2 条已经被应用过的裁决不能被状态编辑撤销，`u1_accept` 会明确拒绝（见 §5）。

---

## 4.1 执行记录（2026-10-23 已完成）

**方法**：单入口批量。驱动脚本只做循环，每一条状态迁移都作为子进程调用 `mind/u1_accept.py --decision withdraw`，被行使的就是被审计的那条路径，不存在旁路写。

**结果**：

| 指标 | 值 |
|---|---|
| 清单条数 | 62 |
| `changed=true` | 61 |
| `changed=false`（幂等跳过） | 1（金丝雀已先行关闭） |
| 失败 | 0 |
| 写入后的状态 / kind | 全部 `withdrawn` / `model-update` |

**四条不变量，逐条实测**：

1. **canonical 零改动**：`current.yaml` sha256 前后同为 `32658d1b…`；`canonical/` 根目录文件数 18 不变；未新增任何 `history/pre-u1-*` 回滚目录（终止决策不备份 canonical，因为它不写 canonical）。
2. **结构差异仅两处**：62 个文件逐一与执行前备份比对，除 `status` 与新增的 `decision` 外**所有字段逐值相同**（`problems: 0`）；无任何未被允许的新键。
3. **决策元数据一致**：62/62 的 `reason` 均为 `fossil_kind_retired_at_2026-09-15_commit_f034133`，`authority` 均为 `u1-review`，`decision.decision` 均为 `withdraw`，`ts` 齐全，decision 内无多余键。
4. **旁证文件未受牵连**：其余 38 个提案（含 2 个 `accepted` 的 `model-update`）与备份**逐字节相同**。

**校验器的自我纠错**：第一版比对脚本把 `decision` 当成"未预期新键"，报了 62 个假阳性。那 62 个文件此前从未被裁决，`decision` 本就应当是新键 —— 是校验器的白名单写漏了，不是数据坏了。修正后 `problems: 0`。**假阳性也要查根因，不能因为"反正是绿的"就跳过。**

**守卫在真实数据上的验证（不是夹具）**：

- 对 `2026-09-14-model-redistill-h123.json`（`accepted`）执行 `withdraw` → `exit=1`，报 "already 'accepted' … reversal is a demotion proposal, not a status edit"，且文件 sha256 **前后逐字节相同**（拒绝发生在任何写入之前）。
- 同一份 62 条清单**整批复跑一次** → `changed=0 / skip=62 / failed=0`。幂等在批量尺度上成立，不重写任何审计 `ts`。

**成本与产出**：`proposed` 从 **89 降到 27**（整队列 100 → 待办 27，出清 62%），`model-update` 在待办队列里彻底消失。契约传感器对出清后的真实队列复跑：7/7 ok。

**证据分层**：真实文件名、逐条日志、备份与哈希清单留在 git 外的私有层（`~/.personal-ai/queue-withdraw-2026-10-23/` 与 `~/.personal-ai/queue-backup/2026-10-23-pre-withdraw/`），本文只放聚合数字与可复核的判定方法。

---

## 4.2 第二批：`canonical` 15 + `value-update` 7（同日，已完成）

清理完 62 具之后剩 27 条 `proposed`，其中 22 条是另外两个史前 kind。逐条普查后确认：**它们不是"等待接入通道的合法数据"，而是两次生产端事故写进队列的产物。**

### 决定性事实：这 22 条连授权都无法被评估

`governance.yaml#u1_evolvable.update_classes.value_model` 规定：

```yaml
allowed_proposers: [operator]
required_authority: "user DURABLE_VALUE_STATEMENT or governance proposal"
rollback_required: true
```

而 22 条记录的顶层字段**统共只有六个**：`kind / payload / schema_version / session_id / status / timestamp`。

- **没有 `proposer`** → `allowed_proposers: [operator]` 无法求值；
- **没有 `update_class`** → 连"它属于哪个演化类"都要靠 kind 反推；
- **没有 `rollback`** → `rollback_required: true` 无从满足。

所以它们**在构造上就不可 apply**，与"payload 是否杂乱"无关。后者只是表象，前者才是根因。

### 形状（补充证据）

15 条 `canonical` 的 payload 是运行时诊断与预测清理记录（`removed_predictions` / `subject+alignment` / `distribution+sample_count` / `summary`），**无一携带 `target` 字段** —— 无法机械推导该写 `current.yaml` 还是别处。

7 条 `value-update` 的 payload 更散：看门狗超时 `selected_value_ms`、策略标记 `preferred_strategy`、观察结论 `selected_value`、操作结果 `decision+outcome`，另 3 条只有 `reason` / `provenance`。**没有一条能与 `current.yaml` 的 `value_model.current_values` 做确定性合并。**

### 执行与校验

| 指标 | 值 |
|---|---|
| 清单 | 22（15 `canonical` + 7 `value-update`） |
| `changed=true` | **22** |
| 失败 | **0** |
| 复跑 | `changed=0 / skip=22 / failed=0` |
| 结构差异 | 仅 `status` + 新增 `decision`（`problems: 0`） |
| 旁证文件 | 78 个未涉及文件与备份**逐字节相同** |
| `current.yaml` | sha256 仍 `32658d1b…`，根文件数 18 不变，无新 `history/pre-u1-*` |

**每个 kind 用各自的 reason**，不做一刀切：`canonical` → `canonical_kind_outside_closed_vocabulary_2026-09-13_generation`；`value-update` → `value_update_no_proposer_no_update_class_payload_not_mergeable_2026-09-13_generation`。事后能按 kind 精确筛出这批处置。

### 队列终态

`proposed` **89 → 27 → 5**：剩 `MODEL_PROPOSAL` 1（唯一可 apply）、`HYPOTHESIS_PROPOSAL` 1、`HYPOTHESIS_STATE_UPDATE` 2、`NOTE_PROPOSAL` 1 —— 后四者被登记为 `foreign`（归其生产者管），**是否也难以流转，本文未取证**，不冒充已知。

### 没有顺带做的事（重要）

**`canonical` 这个 kind 产生的通道还在。** `world-model.mjs:1349` 的 `case 'persist'` 会把 `input.canonical_proposal` 原样塞进 `writeProposal('canonical', …)` —— 它**不在 `KIND_BY_CLASS` 里**，是封闭词表唯一的逃逸口。今天把 15 条清了，明天仍能产出第 16 条。

同理 `value-update` 的 3 个调用点（`:1236 / :1286 / :1320`）都还在，且都直接把调用方对象铺开当 payload。

**清尸体不等于堵源头。** 源头处置是 D1 的一部分，见 §7.1。

---

## 5. D0 改了什么

`mind/u1_accept.py`（U1-1.1 → U1-1.2）：

1. **顺序修复（真实缺陷）**。原来 `kind` 检查在第 121 行，**抢在 `if args.decision == "reject"` 之前**执行。后果：操作者想关掉一个死尸提案，会被 apply 门禁硬拦在外面 —— 越是不该被应用的东西，越关不掉。现在终止决策（`reject` / `withdraw`）先行，apply 门禁后置。
2. **诊断升级**。`got {kind}` → 按桶给出下一步动作：化石代报停用日期与 `--decision withdraw`，live 债务说明"生产者仍在运行"，幽灵 kind 明说"拒绝猜测"。
3. **新增 `--decision withdraw`**。状态终结通道，只写提案文件。
   - 幂等：重复关闭不改写审计记录（不覆盖 ts / authority）；
   - 拒绝撤销已裁决件：`accepted` / `approved` / `provisional` 不能被 withdraw，反转要靠 demotion 提案；
   - 顺序回归时自诊断：若终止分支被挪到 apply 门禁之后，报 `internal ordering error` 而不是甩锅给 kind。
4. 顺手删掉一处不可达分支：`status = ... else "?"`。reject/withdraw 已提前返回，`"?"` 永远到不了，留着等于埋一个静默坏状态。

**D0 没有做**：没有给 `value-update` / `canonical` 加 apply 通道。canonical 是本项目最贵的一条写入路径，新增写家族必须配独立变异矩阵，单独一笔（D1）。

---

## 6. 防退化契约传感器

`tests/test_proposal_kind_contract.py`（15 条）从 `.mjs` 里**静态提取** `KIND_BY_CLASS`，断言：

- 生产端每一个输出 kind 在消费端都有归属（无幽灵）；
- 真实队列里每一个 kind 都有归属（有队列时；无则 skip，不假装通过）；
- 五个桶两两不相交，并集 == `ALL_KNOWN_KINDS`；
- `KIND_APPLY` 恒等于 `{MODEL_PROPOSAL, STATUS_UPDATE}` —— 这个桶一放宽就是新增 canonical 写入者；
- live 债务与化石代不得混淆（否则批量 withdraw 会误删一个活通道的全部产出）。

提取锚点失效时会显式抛错（`test_extraction_is_not_vacuous` 另外钉住下界），不会因为正则匹配到空集而"虚假全绿"。

### 变异矩阵（实测，非推断）

| 变异 | 结果 |
|---|---|
| 从 `KIND_DEBT_DECLARED` 移除 `governance-u0` | 红：`{'governance-u0'}` is not false |
| 把 apply 门禁挪回终止分支之前（还原 1.1 顺序） | 红 3 条：`internal ordering error: terminal decision 'reject' on kind 'model-update' ...` |
| 把 `value-update` 塞进 `KIND_APPLY` | 红 2 条：桶重叠 + apply 集合被放宽 |

三次变异后均已按原文件还原，**sha256 逐字节一致（`eb2772f8…`）**。

---

## 7. 与 G1 的关系

本文初版写过"C22 拿不到 accept 证据的两层原因：抽象器没开 + `value-update`/`canonical` 无 apply 通道，所以 D1 是 C22 取证的真前置"。**清理完 22 条之后，这个因果链要修正。**

真实情况：

1. **accept 路径今天就能行使。** 队列里躺着一条完整的 `MODEL_PROPOSAL`（`cand-8975ff9f`），`payload.candidate` 的键集齐全（`candidate_id` / `proposition` / `scope` / `falsifier` / `promotion_criteria` / `supporting` …），`u1_accept` 的 `KIND_APPLY` 直接认它。**它不需要 D1。**
2. **D1 解决的不是"C22 能不能 accept"，而是"`value_model` 家族有没有通道"。** 把两者绑在一起，会让一个纯代码缺陷去承担一个已经可以独立执行的取证任务。
3. **真正缺的证据是下游那一段**：`accept → current.yaml 写入 → canonical_compile → 加载`，这一段至今没有任何真实运行证据 —— 不是因为无通道，是因为**没跑过**。
4. 但那条待裁决件本身也是 2026-09-13 的化石代产物。**拿它做取证必须用隔离副本**，绝不能在真实库里把一个五周前的 candidate 写进 `current.yaml`。取证价值在"链路跑通"，不在"这条模型值不值得进库"。

**因此优先级调整为**：C22-accept 隔离取证（不阻塞任何人）> D1 生产端闸门（不写 canonical）> D1 消费端 value 通道（写 canonical，最贵，最后做）。

---

## 7.1 D1 的范围修订（本轮普查的直接产出）

原计划"D1 = 给 `value-update`/`canonical` 补 apply 通道"。普查后认为**这个方向错了一半**：给一个 payload 无定形的 kind 写 apply，等于为脏数据建引擎。

正确的切法：

**D1-A 生产端闸门（先做，不碰 canonical）**

`writeProposal(kind, …)` 今天接受**任意字符串 kind**，只有 `:1212` 那一处调用经过 `KIND_BY_CLASS`。其余 5 个调用点（`value-update` ×3、`declassification`、`canonical`）直接传字面量 —— `canonical` 就是这么溜进来的。

- 把词表闸门移进 `writeProposal` 本身：kind ∉ `KIND_BY_CLASS.values()` → fail closed（`BAD_UPDATE_CLASS`）；
- `case 'persist'` 的 `input.canonical_proposal` 原样落盘必须停止：要么按类型化 kind 发，要么只落事件不发提案；
- `value-update` 三个分支必须发出**可合并的增量形状**（`target` / `key` / `value` / `proposer`），发不出来就只落事件（`VALUE_DECISION` / `INPUT_ROUTED` 已经在记审计了，提案是冗余的）。

这一笔不改任何 canonical 状态，可以用纯单元测试 + 现有 `.mjs` 测试矩阵闭环。

**D1-B 消费端 value 通道（后做，写 canonical）**

- 目标：`current.yaml#value_model.current_values` 的原子更新（带 rollback 备份、幂等、key 白名单）；
- 前置：D1-A 已把记录形状规范化，否则没有可消费的输入；
- 必配独立变异矩阵（与 §6 同标准）。

**D1-C 词表一致性（顺手，但要单独一笔）**

`canonical` 现在仍登记在 `KIND_DEBT_LIVE`（"生产者还活着、只缺通道"）。既然已判定它是词表逃逸口，这个分桶名就不诚实了。等 D1-A 落地、逃逸口关闭之后，应把它移出 live 债务桶 —— 那是改 `mind/u1_accept.py` 的登记表 + 对应断言，属受治理路径，单独一笔。

---

## 8. 复现

```bash
# 契约传感器（无队列也可跑，队列项会 skip）
python -m unittest tests.test_proposal_kind_contract -v

# 对真实队列校准覆盖（只读）
PAI_CANONICAL_DIR=<canonical> python -m unittest \
  tests.test_proposal_kind_contract.TestProducerCoverage -v

# 时间戳切线（必须按 kind 过滤，不能按文件名 glob —— 见 §2 订正）
python - <<'PY'
import json,glob
rows=[(json.load(open(f,encoding='utf-8')).get('timestamp',''),
       json.load(open(f,encoding='utf-8')).get('kind'),f)
      for f in glob.glob('<canonical>/proposals/*.json')]
rows=[r for r in rows if r[1]=='model-update']
print('model-update by kind:', len(rows))
print('after 2026-09-15:', [r for r in rows if r[0]>='2026-09-15'])
PY
# 期望: 64 条, 且切线后恰好 1 条（2026-10-10 的人工回填，非 class 映射产物）
```
