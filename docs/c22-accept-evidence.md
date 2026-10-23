# C22 采纳链路隔离取证

- 日期：2026-10-23
- 范围：`accept → current.yaml → canonical_compile → 加载`，在**隔离沙箱**内执行
- 触发：D08 的 C22 长期挂"未取得证据"。此前的假设是"`--abstractor llm` 未开 + 无 apply 通道"（见 `docs/proposal-kind-contract-gap.md`）；本文件用实跑替换假设
- 结论：**链路是通的，但产物是残的。** 四道关卡里三道 PASS、一道 FAIL —— FAIL 的不是写入，是**传播**

---

## 1. 结论表

| 关卡 | 检查 | 结果 |
|---|---|---|
| G1 | `mind/u1_accept.py --decision accept` 写入 current.yaml | **PASS**（退出码 0，回滚备份逐字节等于前态，`U1_APPLY` 落账，`operational_status: usable`） |
| G2 | `mind/canonical_compile.py` 编译 briefing + runtime-state | **PASS**（退出码 0，`--check` 由 stale=true 转 stale=false） |
| G3 | 宿主 `loadCanonicalState` 读到的 briefing 里有没有这个模型 | **FAIL**（见缺陷 E） |
| G4 | 真实库不变量 | **PASS**（三个产物 sha256 前后一致，真实提案仍为 `proposed`） |

一句话：**写入是真的，编译是真的，模型没到身体里也是真的。**

---

## 2. 方法与不变量

沙箱 = 真实 canonical 目录的完整副本（209 个文件），`PAI_CANONICAL_DIR` 指向副本，全部命令以目录参数显式指定，不读环境默认值。

真实库四道不变量（跑完全链后复核）：

| 产物 | 前 | 后 |
|---|---|---|
| `current.yaml` | `32658d1b…` | `32658d1b…` |
| `briefing.md` | `4be01ea0…` | `4be01ea0…` |
| `runtime-state.json` | `62a4dd40…` | `62a4dd40…` |
| 被用作取证标的的提案 | `status: proposed` | `status: proposed`，无 `decision` 字段 |

真实库未新建任何 `history/pre-u1-20261023-*`。取证标的是一条 2026-09-13 的 `MODEL_PROPOSAL`（`candidate` 字段完整：`proposition / scope / scope_conditions / falsifier / promotion_criteria / supporting / counterexamples / confidence`），是队列里唯一还能被 `KIND_APPLY` 认的提案 —— 用它取证，是为了验证**通道**，不是为了给这条五周前的候选背书。

---

## 3. 逐关卡原始事实

### G1 采纳写入 — PASS

```
{"decision": "accept", "model_id": "cand-8975ff9f", "epistemic_status": "provisional",
 "rollback": ".../history/pre-u1-20261023-145136", "u1_version": "U1-1.2"}
EXIT=0
```

四项落地全部核过：

- 回滚备份 `history/pre-u1-…/current.yaml` 的 sha256 **等于**前态 `32658d1b…`（逐字节，不是"看起来像"）；
- `history/model-updates.jsonl` 新增一行 `kind: U1_APPLY, decision: accept, schema_version: 1.2`；
- `current.yaml` 的 `world_model.models` 由 8 → 9，新条目带 `epistemic_status: provisional`、`operational_status: usable`、`falsifier`、2 条 `evidence_refs`；
- 提案文件 `status: accepted`，`decision` 里带 `applied_model` 与 `rollback`。

### G2 编译 — PASS

`--check` 在 accept 之前报 `stale: {briefing.md: true, runtime-state.json: true}`，编译后报 `false / false`。新鲜度传感器本身是有效的。

`briefing_bytes: 5789`，`over_target: false`，`over_cap: false` —— **记下这三个数，后面要用**。

### G3 加载 — FAIL

用宿主自己的加载器（`host/src/core/loaders.js::loadCanonicalState`，即 `host.js:73-77` 取 `canonical.files['briefing.md']` 的那条路径）读沙箱：

```json
{
  "files_loaded": 210,
  "briefing_bytes": 5870,
  "model_in_briefing": false,
  "model_in_current_yaml": true,
  "model_in_runtime_state": false
}
```

`current.yaml` 里有，`briefing.md` 里没有，`runtime-state.json` 里也没有。而 `runtime-state.json` 本来就不带模型（它是 identity / lineage / authorities 的投影，不是模型载体）。

**结论：身体能读到的模型载体只有 briefing §3，而 §3 里没有这条模型。**

---

## 4. 缺陷 E：简报静默截断（新增，未修）

### 症状

逐模型核对 canonical 的 9 个模型是否出现在简报里：

| 模型 | 在简报中 |
|---|---|
| `H3` / `H2` / `H1` | ✅（三者均为 `status: SUPERSEDED`） |
| `H1'` / `H2'` / `H3'` | ✅ |
| `M-attribution-requirements` | ❌ |
| `M-sandbox-admission-gate` | ❌ |
| `cand-8975ff9f`（本次 accept） | ❌ |

**9 个里只有 6 个进简报，缺的 3 个中 2 个是早已 accepted 的模型，1 个是刚刚 accept 的模型。**

### 根因

`mind/canonical_compile.py:119`：

```python
for mid, m in list(models.items())[:6]:
```

- 取的是 **插入序前 6 条**，不是置信度、不是新鲜度、不是 `epistemic_status`；
- 新模型由 `u1_accept` 追加到末尾 —— **永远落在第 7 位之后，永远进不了简报**；
- 占掉 6 个席位的前 3 条，是 `SUPERSEDED` 的死条目。

### 为什么说是"静默"，而不是"容量不够"

补齐三条缺失条目实测只需 310 + 659 + 603 = **1572 字节**：

| 量 | 字节 |
|---|---|
| 当前简报 | 5789 |
| 补齐 9 条后 | **7361** |
| 声明目标 | 6144（超出，只报 `over_target`，不裁剪） |
| 硬上限 | 8192 ← **仍有余量 831 字节** |

**字节预算从来没有成为约束。** 而且这个文件自身有设计好的优先级裁剪算法（`if len(b) > HARD_CAP` 之后按 `order = [5, 3, 4, 2, 1]` 逐段丢尾），`[:6]` 这个魔数**先于它执行**，把它整个绕过了。

### 为什么第二重传感器也没抓到

宿主 `doctor` 的 `compiled_artifacts` 检查（`host/src/core/doctor.js:101`）只验**存在 + 新鲜**（mtime 与 `current.yaml` / `governance.yaml` 比），不验**内容覆盖**。对完成 accept + 双通道编译的沙箱，它给的是：

```json
{ "status": "pass",
  "detail": "briefing.md + instruction/generated.md compiled and current (no learned overlay — the prior stands)" }
```

而此刻简报正缺 3 个模型。该检查自己的注释写着"a channel that is absent produces silence, not evidence, and silence is not a signal" —— 但**一个在场却在截断的通道，产生的同样是静默**，它照样抓不到。

### 影响

1. **C22 采纳路径的真实判定是 PARTIAL，不是 PASS**：写入闭合、编译闭合、传播不闭合；
2. 任何新 accept 的模型，在该实例存在 ≥6 个模型时，**对运行时永久不可见**，除非手动调序；
3. 世界模型对自己"当前最佳模型"的自述，长期由最老的 6 条主导 —— 这正好与它存在的目的相反。

### 建议（未实施，等授权）

最小改动是让排序承担取舍、让字节预算承担裁剪：按 `epistemic_status` / 最近 `provenance.ts` 排序后取，删掉魔数，交给已有的 `TARGET_MAX` 裁剪循环。另配一条传感器：`current.yaml` 的模型集合与 `briefing.md` 的模型集合之差，必须为空或全部命中显式豁免名单。这两项都在 `mind/`（受治理路径），需独立一笔 + 变异矩阵。

---

## 5. 缺陷 F：apply 路径没有幂等守卫（新增，未修）

D0 给**终止决策**加了幂等（重复 withdraw 不改写审计记录），但**apply 路径没有**。对同一提案连续 accept 两次：

| 观测 | 值 |
|---|---|
| 两次调用退出码 | 0 / 0 |
| `model-updates.jsonl` 中该模型的行数 | **2** |
| 新建回滚目录 | **2** 个 |
| `provenance.ts` | 被第二次的值覆盖（首次采纳时间从 current.yaml 消失） |
| `update_history` | 被覆盖为 "U1 accept: idempotency probe run 2" |

最终状态收敛（模型只一条），但**审计层不收敛**：current.yaml 不再记得它是什么时候第一次被采纳的，只有 ledger 还留着两行。若 ledger 被当作唯一真相，那这两行会被读成"两次独立采纳"。

同样在 `mind/`，同样未修。

---

## 6. 对 D1 的影响

| D1 段 | 变化 |
|---|---|
| D1-A 生产端闸门 | 不变，仍应最先做（不写 canonical） |
| D1-B 消费端 value 通道 | **新增前置**：先解决 E。否则"新值写进 canonical 却传不到身体"会成为 D1-B 的默认结果 —— 通道建成了，但出口是截断的 |
| D1-C 词汇表登记 | 不变 |

顺序因此变成：**E（传播）→ D1-A（源头）→ D1-B（新通道）**。E 是最便宜的（一个排序 + 一条传感器），也是唯一直接决定"采纳有没有意义"的。

---

## 7. 边界声明（未取证的部分）

- 本文件验证的是**加载器层**（`loadCanonicalState` → `canonical.files['briefing.md']`），**不是完整宿主启动**：没有做一次真实 body 会话，也没有观测该 section 进入 system prompt 的最终文本。加载器是 `host.js:77` 的直接上游，但"上游正确"不等于"端到端正确"。
- `instruction/generated.md` 一并编译了（补第二条编译通道的新鲜度），但**没有逐条核对它的内容覆盖**。
- 缺陷 E/F 均**未修改任何代码**，`mind/u1_accept.py` 与 `mind/canonical_compile.py` 保持 `eb2772f8…` / HEAD 原状。
- 真实 canonical 全程只读，四个产物 sha256 前后一致。
