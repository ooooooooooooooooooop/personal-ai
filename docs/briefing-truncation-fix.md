# 缺陷 E — 简报静默截断：修复与覆盖传感器

> 状态：**代码层已修复**（`mind/canonical_compile.py`），真实库**未重编译**。
> 取证日期：2026-10-23 ｜ 前置证据：`docs/c22-accept-evidence.md` §4 E
> 范围：`mind/canonical_compile.py`、`tests/test_canonical_compile.py`

---

## 1. 一句话

`canonical_compile.py` 用 `list(models.items())[:6]` 按**插入序**取前 6 个模型写进简报，而 `u1_accept` 把新模型**追加到末尾**。结果：canonical 有 8 个模型，简报里躺着 3 个 `SUPERSEDED` 的尸体，2 个早已 accepted 的活模型整整五周没进过身体读到的文本。字节预算还空着 2403 字节。

修复后：**12 个模型条目（8 models + 4 competing）全部按状态与新鲜度就位——活模型进 §3，退役的进 §4，零缺失，零静默**。

---

## 2. 症状（真实库，2026-10-23 只读解剖）

库：`C:/Desktop/world-model/pilot/personal-ai/canonical`（`WORLD_MODEL_HOME`）

| 量 | 修复前 | 修复后 |
|---|---|---|
| canonical 模型条目 | 12（models 8 + competing 4） | 12 |
| 其中 `SUPERSEDED` | 4 | 4（不变，只换位置） |
| §3 条目 | **9**，其中 **3 条是尸体**（`H3`/`H2`/`H1`） | **8**，尸体 **0** |
| §4 条目 | 3（仅 1 条退役模型 + 2 条用户纠正） | 6（4 条退役模型 + 2 条用户纠正） |
| 活模型缺失 | **2**（`M-attribution-requirements`、`M-sandbox-admission-gate`） | **0** |
| 简报字节（LF 口径 = 修正后的报告值） | 5789（磁盘 5870，见 §4.5） | 5986（磁盘 5986） |
| `over_target` | false | false（≤ 6 KiB） |

`§4` 里 `H4b-gate-v0_1` 的旧文案是 `SUPERSEDED — SUPERSEDED——predicted-CORE …`（把自由文本 `status` 原样贴在 `SUPERSEDED` 后面），现改为 `SUPERSEDED — predicted-CORE 连续 4 false positive；…`。

**为什么是"静默"而不是"装不下"**：补齐三条缺失条目实测只需 1572 字节（C22 沙箱口径），而旧简报离 8 KiB 硬顶还差 2403 字节。裁剪算法（旧序 `[5,3,4,2,1]`）从未被触发过——它被 `[:6]` 整段绕过了。

**为什么所有监控都没响**：

- `doctor` 的 `compiled_artifacts` 只验**存在 + mtime 新鲜度**，简报"被写过"就算过；
- 加载器 `loadCanonicalState` 忠实返回 `files['briefing.md']`，它读到的文本一直是完整的——**完整地少着三个模型**；
- 身体内部无法区分"这个 prior 不存在"与"这个 prior 没进简报"。通道在场，产出入静默。

---

## 3. 根因（三处同类，不是一处）

| # | 位置 | 形式 | 后果 |
|---|---|---|---|
| E1 | 原 `:119` | `list(models.items())[:6]` | 插入序取前 6，`u1_accept` 追加的新模型永远在第 7 位之后 |
| E2 | 原 `:121` | `list(comp.items())[:4]` | competing 是**另一条独立赛道**，同样按位置截断 |
| E3 | 原 `:139` | `list(cv.items())[:5]` | 值通道同样只有前 5 个席位；D1-B 一旦落地会立刻重蹈 |

外加一处**声明与实现相反**：模块 docstring 写的优先级是 `unresolved > alerts > models > corrections > values`，代码的裁剪序是 `[5,3,4,2,1]`（values → **models** → corrections → alerts），即模型比纠正史先被吃掉。已订正为 `[5,4,3,2,1]`，与声明一致。

---

## 4. 修复

### 4.1 选谁进 §3：状态与新鲜度，不是位置

```python
combined = models + competing_models          # 单一候选池
retired  = [m for m in combined if _is_superseded(m)]
active   = [m for m in combined if not _is_superseded(m)]
active.sort(key=_model_order)                 # (usable 优先, -provenance.ts, 文件序)
```

- `_is_superseded`：`status` 里出现 `SUPERSEDED`，**或**带 `superseded_by`。`status` 是自由文本（库里真实存在 `当前最强解释` 这类中文状态），所以做的是包含匹配而非等值比较。
- `_ts_epoch`：`provenance.ts` → `accepted_at` → `updated_at` → `ts`。**缺失/不可解析 = 最旧（0.0），不是"最新"**——没有时间戳不能换来前排座位。
- `operational_status == 'usable'` 优先：那是身体现在就能拿它行动的意思。

### 4.2 退役不是删除

`SUPERSEDED` 从 §3 移出后**由 §4 承接**，并带上 `superseded_by` 与原因：

```
- H3: SUPERSEDED → H3' — v0.4 redistill——命题对象不变，字面量退 evidence_refs；……
```

如果只从 §3 剔除而不改 §4，等于把"静默截断"换成"静默消失"——同一个病的另一种形态。传感器对这条专门断言了两节不相交且并集 = 全集。

### 4.3 只有字节预算能删条目，且删了要留名

```
- [truncated] 3 entry/entries dropped for the 8KiB cap: H1', H4-mode, gate-v0_2 — full text stays in canonical/
```

裁剪顺序按声明优先级（values → corrections → models → alerts → loops），每段至少保留标题 + 1 条；任何被丢弃的条目都会在**本段末尾**追加一行具名标记。8 KiB 硬顶仍是绝对上限，超顶时保留原有的 `…(hard-capped at 8KiB)` 尾标。

### 4.4 §5 值通道：去 cap，按新鲜度排

值现在没有时间戳，所以排序是"带时间戳的（`updated_at`/`ts`）按新到旧在前，其余保持文件序"——今天等价于空操作，但它把"D1-B 落地后按前 5 个截断"这条路提前堵死了。

### 4.5 E3：预算口径对不上实物

修完之后顺手发现的第四处：`write_text` 在 Windows 上把每个 `\n` 翻成 `\r\n`，于是

```
报告 briefing_bytes: 5986   磁盘实际: 6063
```

差值 77 = 行数。也就是说**硬顶实际是按"少算一行一字节"的数字在守**，一行都不多的余量也能让 8 KiB 越界。已改为写字节（`write_bytes`），报告值与磁盘字节现在相等（传感器 `ArtifactBytes` 盯着这条）。

---

## 5. 覆盖传感器 `tests/test_canonical_compile.py`

19 个测试，`python -m unittest tests.test_canonical_compile -v`。

| 断言 | 防的是什么 |
|---|---|
| 9/9 模型（含 `cand-8975ff9f` 与两个 9 月模型）必须出现在简报 | 原始缺陷本体 |
| §3 恰好 = 非 `SUPERSEDED` 集合；§4 恰好 = 退役集合；两节不相交 | 从"少"变"跑到别处"的伪修复 |
| 未超预算时 `[truncated]` 不得出现 | 假阳性截断标记 |
| 超预算时必须出现具名标记 | 静默截断回归 |
| 超预算时 values 先被吃、models 后被动，corrections 先于 models | 优先级再次反转 |
| usable 优先 / 新时间戳优先 / 无戳排最后 | 排序退化 |
| 7 个值一个不少 | §5 的 `[:5]` 回归 |
| 源码中不得出现对 `models/comp/cv/active/values/retired/open_loops` 的位置切片 | 以新形式复活的 `[:6]` |
| 空 §3 必须显式写 `no active models` | 空段落 = 通道故障不可区分 |
| 写入字节 = 报告字节 | 预算口径再次脱钩 |

外加一条**可选的真实库哨兵**：设置 `PAI_CANONICAL_DIR` 时，直接对挂载库编译并逐模型核对（只读，不写产物）。取证时已对真实库跑过：`OK`，三件产物 sha256 前后不变。

---

## 6. 变异验证（5 个变体，全部杀死）

`mind/canonical_compile.py` 原始 sha256 `fa5dc5868534dae4…`；每个变体注入后跑对应测试、记录指纹、逐字节还原。

| 变体 | 注入的缺陷 | 测试反应 | 指纹 |
|---|---|---|---|
| M1 | 在候选池上恢复 `[:6]`（原始缺陷） | FAIL | `["H1'","H2'","H3'"] != [... 6 项]` |
| M2 | 取消 `SUPERSEDED` 分流 | FAIL | `[] != ['H1','H2','H3']`（§4 空、§3 被污染） |
| M3 | 删除具名截断标记 | FAIL | `'[truncated]' not found` |
| M4 | §5 恢复 `[:5]` | FAIL | `'- v5:' not found` |
| M5 | 裁剪序退回 `[5,3,4,2,1]` | FAIL | `['M-0'] != ['M-0','M-1','M-2','M-3']` |

还原后 sha256 = `fa5dc5868534dae4…`（逐字节一致）。矩阵脚本：`.taskflow/tmp/mutate_e.py`（运行态，不入库）。

---

## 7. 隔离复证（C22 沙箱，`accept → compile → load`）

沙箱：`~/.personal-ai/c22-evidence/sandbox-canonical`（真实库副本 + `cand-8975ff9f` 已 accept）。用宿主自己的加载器（`host/src/core/loaders.js::loadCanonicalState`，即 `host.js:73-77` 取 `canonical.files['briefing.md']` 的路径）读编译产物：

| | 旧编译器 | 新编译器 |
|---|---|---|
| 简报字节 | 5789 | 6588 |
| `cand-8975ff9f` 在简报中 | **否** | **是（§3）** |
| §3 覆盖 | 6/9 | 9/9 |
| §4 | 1 条尸体 | 4 条退役 |
| 缺失 | 3 | **0** |
| `[truncated]` | — | 无（未超 8 KiB） |

旧编译器下这份简报与真实库**逐字节相同**（`4be01ea0…`）——accept 改了 `current.yaml`、编译报成功、产物却一个字节没动。这就是"通道在场、产出静默"的完整形状。

新编译器下 9 模型沙箱 6588 字节：`over_target: true`（超 6 KiB 目标 444 字节）、`over_cap: false`。目标值是软的，裁剪只在超硬顶时启动，所以**没有任何条目被丢**。真实库 8 模型口径 5986 字节，`over_target: false`。

---

## 8. 边界声明（不许被读成更多）

1. **真实库没有重编译。** 真实库的 `briefing.md` 仍是 2026-10-23 10:53 由**旧代码**生成的产物（`4be01ea0…`），身体现在读到的仍然是缺 2 个模型的版本。修复的是编译器，不是已生成的产物。要让修复进入身体，必须显式执行：
   ```bash
   python mind/canonical_compile.py --canonical C:/Desktop/world-model/pilot/personal-ai/canonical
   ```
   我没有替 owner 做这个动作：它是真实实例的产物重生成，且会让 `briefing.md` 从 CRLF 变为 LF（见 §4.5）。**C22 因此仍不结算**。
2. **只到加载器层。** 复证止于"加载器返回的 `files['briefing.md']` 含全部模型"，未做完整宿主启动、未观测该段进入 system prompt 的最终文本。
3. **`SUPERSEDED` 判据仍是文本匹配。** `status` 是自由文本，我按"包含 `SUPERSEDED` 或带 `superseded_by`"判定。若未来有模型用别的词表达退役（如 `RETIRED`），它会留在 §3——这是可知的边界，不是已解决的语义。
4. **§1/§2 的位置上限也一并去掉了**（原 `open_loops[:6]`、`residuals[:4]`）。真实库当前 open loops = 0、residuals = 2，行为无变化；去掉是为了不再有"按位置静默丢条目"的第三、第四处。`weak[:4]`、`correction_history[:4]`、`evidence_refs[:3]` 属于**字段内截断**，保留原样。
5. **目标值仍是软的。** 6 KiB 超了不会触发裁剪，只有 8 KiB 会。这一点没改，属既有设计。
6. **D1-A / D1-B / 缺陷 F 一律未动。**

---

## 9. 复现

```bash
# 传感器
python -m unittest tests.test_canonical_compile -v

# 真实库只读哨兵（不写产物）
PAI_CANONICAL_DIR='C:\Desktop\world-model\pilot\personal-ai\canonical' \
  python -m unittest tests.test_canonical_compile.LiveCanonical -v

# 隔离沙箱全链
cp -r <canonical> <sandbox>
python mind/canonical_compile.py --canonical <sandbox>
node ~/.personal-ai/c22-evidence/load-probe/e-probe.mjs <sandbox>
```
