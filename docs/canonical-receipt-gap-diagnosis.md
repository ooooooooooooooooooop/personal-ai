# 治理缺口诊断：回执门禁的作用域与 pre-commit 不一致，导致推送被累积性锁死

- 首次诊断：2026-10-22 16:10
- 修订：2026-10-22 16:20（**推翻初版 G1 机理**，见 §9）
- 状态：**已修复**（口径对齐，见 §6）
- 仓库：`C:/Desktop/personal-ai`

---

## 1. 一句话结论

pre-commit 与 push gate 使用了两套不同的"该不该有回执"口径：pre-commit 只对受治理切片（`GOVERNED_PATH_PREFIXES`）索要 lease，非受治理提交走 `CANONICAL_PRE_COMMIT_SKIPPED` **主动放行且不写任何意向**；而 push gate 要求 ahead 区间内**每一个**提交都有 canonical commit receipt。于是**每一次非受治理路径的提交都必然产生一个永远推不出去的僵尸提交**，且该区间校验是累积的 —— 一旦出现，main 的推送永久失败。

---

## 2. 当前实例

19 个 ahead 提交中 16 个有回执，3 个没有：

```
b7059fe  TestUser  2026-10-22 13:33:04  fix(governance): scope canonical lease/receipt gates to governed slices
c2516ab  TestUser  2026-10-22 15:33:13  perf(gate): stop pricing a root doc edit at a full regression
bc4f1e5  TestUser  2026-10-22 15:47:15  docs(facts): record the root-doc gate cost rule   ← HEAD
--- 以上 3 个：无回执 ---
040e03b  TestUser  2026-10-13 11:19:59  fix(app-ui): 首用反馈三处……                    ← 最后一个有回执的提交
```

三个提交触及的路径：

| 提交 | 触及路径 | 是否受治理 |
|---|---|---|
| `b7059fe` | `AGENTS.md`、`FAILURES.md`、`docs/*`、`scripts/governance/canonical_writer.py`、`scripts/personal_ai_sync.py`、`skills/world-model-runtime/SKILL.md` | 否 |
| `c2516ab` | `AGENTS.md`、`scripts/gate_planner.py`、`tests/test_gate_planner.py` | 否 |
| `bc4f1e5` | `AGENTS.md` | 否 |

`GOVERNED_PATH_PREFIXES`（`personal_ai_sync.py:654-658`）**只有三项**：

```python
GOVERNED_PATH_PREFIXES = ("scripts/sync_v2/", "soul/", "mind/")
```

`scripts/governance/` 与 `scripts/personal_ai_sync.py` **被刻意排除**，理由写在 `:650-653` 注释里：门禁自身若受自身约束，"修复门禁"的提交就会被门禁拒绝（bootstrap 自指死锁）；对治理代码的改动改由 pre-commit 的 bootstrap trigger scan 强制 FULL 全量回归来担保。

所以这三个提交**一个受治理路径都没碰**，pre-commit 全部走了 `CANONICAL_PRE_COMMIT_SKIPPED`。它们不是"绕过门禁"，而是**门禁自己主动放行的**。

---

## 3. 三个咬合缺陷

### G1：pre-commit 放行时不写账

`cmd_pre_commit`（`canonical_writer.py:448-490`）在非受治理路径下的行为：

```python
governed = [path for path in staged if pas.is_governed_path(path)]
if not governed:
    print("CANONICAL_PRE_COMMIT_SKIPPED: ...")
    return 0          # 直接放行，不写 COMMIT_INTENT
```

`return 0` 之前**没有** `write_mutation_event` —— 放行这个动作本身不留痕。这是有意取舍（`:454-457` 注释解释放宽是为了消除"纯文档提交被拒"的 A2 认知自锁），副作用是"这个提交被放行了"不可审计。

### G2：post-commit 无法为已放行的提交补账

`cmd_post_commit`（`:493-512`）第一句是 `_load_active_lock(repo, args, require_token=True)`。放行场景下没有活跃租约，`_load_active_lock`（`:107-121`）抛 `NO_ACTIVE_CANONICAL_WRITER`，`_print_error` 返回 2，钩子 `set -euo pipefail` 退出非零。

**但 git 此时早已完成提交**，钩子失败只打印警告、不回滚。于是提交落库、回执不存在。post-commit 压根没走到写 `COMMIT_WITHOUT_INTENT` 事件那一行（`:504-512`），**连失败事件都没有**。

治理侧对这类失败完全观测不到：事后只能逐提交比对回执才能发现，而这恰好是 push gate 在做的事。**第一次发现问题的时机被推迟到了推送那一刻**，此时 19 个提交已经压在一起。这是本缺口最危险的性质：零痕迹、延迟暴露。

### G3：push gate 的账本口径未同步收敛，且校验累积

`_ahead_commits_have_receipts`（修复前 `:313-316`）对 `origin/main..HEAD` 的**每一个**提交无条件要求回执；`_push_once`（`:338-340`）只要缺失列表非空就抛 `PUSH_MISSING_COMMIT_RECEIPT`。

区间是累积的：僵尸提交只要还在区间内，后续提交只会让区间变长，**不会让缺失消失**。所以不是"这一次推不上去"，而是"从这个提交起，main 永久不可推送"，直到口径对齐或重写历史。

**这就是 `b7059fe` 自身造成的矛盾**：它把 pre-commit 的门槛按受治理切片收敛了（提交信息也写着 "scope canonical lease/receipt gates to governed slices"），却没同步修改 push gate 的口径。两个门禁从此各记一套账。

---

## 4. 为什么三条推送路径全部被堵

| 路径 | 修复前结果 | 卡点 |
|---|---|---|
| `git push origin main` | `PUSH_AUTHORIZATION_REQUIRED: raw push is not a governed mutation` | `canonical_writer.py:551-556` |
| `canonical_writer.py push` | `PUSH_AUTHORIZATION_DIRTY_WORKTREE`（工作区脏），清干净后还会撞 `PUSH_MISSING_COMMIT_RECEIPT` | `:320-321`、`:338-340` |
| `canonical_writer.py push-ref` | `PUSH_REF_MISSING_COMMIT_RECEIPT` | `personal_ai_sync.py:1426-1430` |

第三条最可惜：它的 docstring 明确写着 **"Dirty worktree state is irrelevant: the pushed object is the immutable commit addressed by source_ref"**（`:1415-1416`）—— 它天生为"脏工作区下推送不可变提交"设计，是当时唯一不需要用户 stash 工作的通道，却被同一条回执规则堵死。

---

## 5. 影响面

| 能力 | 修复前 | 修复后 |
|---|---|---|
| 本地提交 | 可用，但每次非受治理提交都在新增僵尸提交 | 同左（见 §7 遗留） |
| 推送 | **不可用**（三路全堵） | 可用 |
| 跨设备同步 | 受影响（复用同一套回执校验） | 恢复 |
| 发布 / PR 合入 | 不可用 | 恢复 |
| 治理侧可观测性 | **失效**（放行与失败都不留痕） | 待改进（见 §7） |

---

## 6. 已实施的修复：口径对齐

原则：**门禁不应要求它自己没有要求过的东西**。让 G3 认 G1 的账本口径，而不是反过来让 G1 去满足 G3。

### 6.1 新增共享判定（`personal_ai_sync.py`，`_owned_commit_receipt` 之前）

```python
def commit_touches_governed_paths(repo: Path, commit: str) -> bool:
    paths = _commit_affected_files(repo, commit)
    if not paths:
        return True          # 读不到路径 → 按受治理处理（fail-closed）
    return any(is_governed_path(path) for path in paths)
```

fail-closed 是刻意的：无法判定不等于无需担保。

### 6.2 `_push_once` 的回执门禁（`canonical_writer.py`）

`_ahead_commits_have_receipts` 改为逐提交先判定作用域：非受治理提交跳过回执要求并计数，触及受治理的提交仍强制回执。输出改为 `all ahead commits governed (N checked); M non-governed commit(s) not subject to receipt requirement`，避免"全部受治理"与"若干豁免"并列的矛盾表述。

### 6.3 `push-ref` 通道（`personal_ai_sync.py`）

```python
if commit_touches_governed_paths(repo, commit) and not _owned_commit_receipt(repo, commit, receipt_root):
    raise MutationOwnershipError("PUSH_REF_MISSING_COMMIT_RECEIPT", ...)
```

两条通道现在共用同一判定函数，口径不会再次分叉。

### 6.4 验证（只读，未提交、未建锁、未写 canonical）

| 用例 | 预期 | 实测 |
|---|---|---|
| `b7059fe` / `c2516ab` / `bc4f1e5` | 非受治理 → 豁免 | `governed=False`，门禁放行 |
| `6a6bbfc`（触及受治理路径） | 受治理 → 必须有回执 | `governed=True`，`receipt=True` 通过 |
| `2c72248`（`mind/`） | 受治理 → 必须有回执 | `governed=True`，`receipt=True` 通过 |
| 反向用例：`2c72248` + 空 receipt 目录 | 必须被拒 | `governed=True`、`receipt=False` → **拒绝，门禁存活** |
| `bc4f1e5`（仅 `AGENTS.md`） | 非受治理 | `governed=False` |

反向用例是关键：它证明门禁没有被"豁免"稀释成无条件放行。

---

## 7. 尚未解决的遗留

1. **放行不留痕（G1 的可观测性）**：pre-commit 的 SKIP 分支仍不写事件。建议补一条轻量 `COMMIT_SKIPPED_NO_LEASE` 事件，让"哪些提交被放行、为什么"可审计。
2. **真正的裸 `git commit --no-verify`** 仍能完全绕过钩子，产出无回执提交。若该提交触及受治理路径，仍会锁死推送 —— 此时确实需要受审计的补录入口（`adopt-receipt` 一类后补签机制），当前未实现。
3. `_local_ahead_commits`（`personal_ai_sync.py:1894-1896`）把远端写死成 `origin/{branch}`，而 `_push_once` 的 remote 来自 `args.remote`。remote 不是 `origin` 时区间判断会失真。当前实例不受影响（remote 即 origin）。
4. 豁免计数包含"本来就有回执的非受治理提交"，只影响日志措辞精度，不影响判定。

---

## 8. 复现与验证命令

```bash
# 1) 逐提交查看作用域与回执覆盖
for c in $(git rev-list origin/main..main); do
  printf '%s  ' "$(git rev-parse --short $c)"
  git diff-tree --root --no-commit-id --name-only -r $c | head -1
done

# 2) 治理侧零痕迹证据（修复前应看到最新记录停在 2026-10-13）
ls -1t ~/.dsh/.personal-ai-mutation/events/*.json | head -1
ls -1t ~/.dsh/.personal-ai-mutation/receipts/*.json | head -1

# 3) 门禁判定（只读）
python .workbuddy/verify_receipt_gate.py
```

---

## 9. 修订说明（为什么推翻了初版）

初版把根因写成"裸 `git commit` 能产出无回执提交（G1）"，暗示是提交方绕过门禁。核实 `GOVERNED_PATH_PREFIXES` 与三个提交的实际改动路径后发现：**这三个提交没有一个触及受治理路径，pre-commit 是主动放行的**。真正的缺陷是"放行方与收账方口径不一致"，而非"提交方绕过"。

这个区别决定了修法方向。按初版判断会去新增补录入口并收紧 pre-commit，那会同时做两件错事：用补录去追认本不需要回执的提交，以及把"纯文档提交被拒"的 A2 认知自锁重新引回来。正确做法是让收账方认放行方的口径。

附带发现：`PUSH_FORBIDDEN_PATHS`（`personal_ai_sync.py:668`）已把 `skills/weekly-work-summary/` 列为禁推路径 —— 该口径与"本机专用工作流不进发布集"一致，也侧面验证了分支收敛时刻意不并入该 skill 的判断。
