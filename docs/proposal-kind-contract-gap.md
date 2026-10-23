# 提案 kind 契约差距 — 生产端已收敛，消费端没跟上

- 记录时间：2026-10-23
- 判定对象：`mind/u1_accept.py`（唯一 canonical 写入者）与 `dsh/world-model/world-model.mjs` 的 `KIND_BY_CLASS`
- 状态：**D0 已完成**（诊断与登记，无行为扩张）；D1（补 apply 通道）未开始
- 触发：D08 的 C22 只能否决、不能采纳。初判为"87 个提案 kind 断裂"，实测后该数字误导

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
| `model-update` | 64 | 2026-09-12 .. **2026-09-13T16:30Z** | proposed 62 / accepted 2 |
| `canonical` | 15 | 2026-09-12 .. 2026-09-13 | proposed 15 |
| `value-update` | 7 | 2026-09-12 .. 2026-09-13 | proposed 7 |
| `HYPOTHESIS_STATE_UPDATE` | 2 | 2026-09-13 | proposed 2 |
| `MODEL_PROPOSAL` | 2 | 2026-09-13 | proposed 1 / accepted 1 |
| `governance_u1` | 2 | 2026-09-14 | accepted 2 |
| `schema` | 2 | 2026-09-14 | accepted 1 / withdrawn 1 |
| `config-declaration` | 2 | 2026-10-10 | accepted 2 |
| `declassification` | 1 | 2026-09-13 | approved 1 |
| `HYPOTHESIS_PROPOSAL` | 1 | 2026-09-13 | proposed 1 |
| `STATUS_UPDATE` | 1 | 2026-09-16 | accepted 1 |
| `NOTE_PROPOSAL` | 1 | 2026-09-20 | proposed 1 |

关键数字：**`timestamp >= 2026-09-15` 的 `model-update` 提案 = 0 个。**

换句话说，`model-update` 的生产者在词表落地的那一刻就消失了。剩下 64 个文件是上一个世代的遗物，不是"待转换的新数据"。

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

C22 拿不到 accept 证据有两层原因，此前只记了第一层：

1. `--abstractor llm` 未常态开启 —— **产品决策**，已决断维持关闭，只在 D1 隔离沙箱里单次取证；
2. `value-update` / `canonical` 无 apply 通道 —— **纯代码缺陷**，不依赖任何产品决策。

第 2 层未闭合之前，即使开了抽象器，也只有 `MODEL_PROPOSAL` 一类能真正落盘。**所以 D1 是 C22 取证的真前置，而不是可选项。**

---

## 8. 复现

```bash
# 契约传感器（无队列也可跑，队列项会 skip）
python -m unittest tests.test_proposal_kind_contract -v

# 对真实队列校准覆盖（只读）
PAI_CANONICAL_DIR=<canonical> python -m unittest \
  tests.test_proposal_kind_contract.TestProducerCoverage -v

# 时间戳切线
python - <<'PY'
import json,glob
rows=[(json.load(open(f,encoding='utf-8')).get('timestamp',''),f)
      for f in glob.glob('<canonical>/proposals/*model-update*.json')]
print('after 2026-09-15:', sum(1 for t,_ in rows if t>='2026-09-15'))
PY
# 期望输出: after 2026-09-15: 0
```
