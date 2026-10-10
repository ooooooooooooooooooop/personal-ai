# 改动换算层设计

> 性质：**换算规格**——定义"从回执到人能判断的结论"这一步做什么。
> 不是界面稿（那是换算产物的呈现形式，由换算结果决定）。
> 前置：[`app-world-model-loop.md`](./app-world-model-loop.md) §5.2（技术基础已查实）、
> [`../app/UI-PRINCIPLES.md`](../app/UI-PRINCIPLES.md)（判据）
> 方法：`codebase-signal-tracing` skill

---

## 0. 为什么要单独有这一层

`app-world-model-loop.md` §5.2 已查实：**四条基础全备**（改了什么 / 改动前是什么 /
哪些危险 / 哪些属同一调用），且同在 `fileops.js` 单一出口。

**但 `fileops.js` 给出的是原料，不是结论。**

现状（`app/ui/app.js:2677–2690`，已查）：

```js
const r = await cmd('fileops_list', { n: 200 });   // 最多 200 条
...
for (const op of ops) { /* 每行一个回执，带 4 个按钮 */ }
```

**改变 40 个文件 = 渲染 40 行 × 4 个按钮。** 这是"看不过来"的具体形态。

另有缺口：`OP_LABEL`（`app.js:2644`）只有 4 项——

```js
const OP_LABEL = { write:'写入', create:'新建', delete:'删除', backup:'备份' };
```

**缺 `purge` / `restore` / `restore-displace`**（§5.2 已查实的完整取值），
会 fallback 显示原始英文。

---

## 1. 换算的三条原则

### 原则 1 · 换算的产物是"结论"，不是"更短的原料"

- ✗ 错误：把 200 条回执折叠成 20 条（**还是原料，只是短了点**）
- ✓ 正确：给出 **"测试 312 → 298 通过"** 这种**人能直接据以判断的陈述**

判据：**这个产物能不能让人在不看代码的前提下决定"撤还是留"？**

### 原则 2 · 换算必须由 AI 做，不能由规则做

**理由在 `governance.yaml`**：`epistemic reliability never derives normative authority`。

- 由**规则**做换算（如"`delete` 一律标红"）→ 规则是写死的，等于把某个人的判断硬编码
- 由 **AI** 做换算 → 它能读懂"这次改动是重构、那个 delete 删的是缓存目录"

**AI 产出建议，不产出决定。**
参照实现：`app/ui/app.js:682–689` 的「顾问参考」(P3 shadow judge)，
注释载明 `it can never flip the verdict; the human still owns the buttons`。

### 原则 3 · 换算的输入必须包含"后果"，不只是"改动"

`op.op` / `preSha` / `backup` 说明**做了什么**；
但人要判断的是**"好没好"**。后者只能来自**结果**：

| 后果类型 | 能否自动算 | 来源 |
|---|---|---|
| 测试通过数变化 | **能** | 跑测试 |
| 构建/启动是否还成功 | **能** | 跑构建 |
| 类型检查错误数 | **能** | 跑 tsc 等 |
| 文件数增减 | **能** | 回执统计 |
| "这个抽象改得对不对" | **不能** | ——**这一层不需要，因为人也判断不了** |

**关键洞察**：人判断"该不该撤"的依据是**"还能不能跑"**，不是"代码变成什么样"。
所以换算的第一要务是**把"能不能跑"算出来**。

---

## 2. 换算层的位置

```
fileops.js  ──[四条基础]──→  换算层  ──[结论]──→  呈现
   (原料)                    (AI 做)            (待定)
```

**换算层属于 `app/`**（§3.5.3：桥只能建在此），不侵入 `fileops.js`、不改 `host/`。

---

## 3. 换算的输出规格（三个层次）

按"人能判断"的程度递进。**默认只给第 1 层。**

### 第 1 层 · 后果摘要（永远给）

**内容**：改动规模 + 后果变化。

**形态**（示意，非终稿）：

```
改动 40 个文件  +847 −612
✓ 测试 312 通过（无变化）
✓ 构建成功
```

或出问题时：

```
改动 40 个文件  +847 −612
✗ 测试 298 通过（↓14）
✗ 新增失败：test/lease.spec.js（14 个）
```

**判据**：第 1 层必须能独立支撑"撤 / 留"决策。**若能，就不需要第 2、3 层。**

### 第 2 层 · 风险项（少数情况给）

**触发条件**（**两次修正后见 §5.7**）：
① 原按"有无 `backup` 兜底"分级 → **错**（删除进回收站，与 `backup` 无关）。
② 改按"是否滑出 200 件窗口" → **多余**（字段已算好）。
**现依据：直接用 `fileops_list` 的 `recoverable` / `undoable`。**

| 级 | 判据（字段） | 说明 |
|---|---|---|
| **不可回** | `undoable === false` | 产物已不在，且非 tombstone 语义 |
| **可回** | `undoable === true` | `recoverable`（有产物实测存在）或 tombstone（`create` / `write` 无 backup） |

**为什么这是最优解**：`pi/src/adapter/fileops.js:297` 对每条回执做 `existsSync` **实测**，
不是从淘汰顺序反推。**比"滑出窗口"判据更准，且零新增数据源。**

**关键变化**：`create` 从"难回"移到"可回"（tombstone 语义，`:306`）；
`purge` 不再需要作为分级标记物。

**第 2 层只列 `undoable === false` 一类**，其余不出现。

> **"`artifactCap = 200` 是否应可配"已论证为不该配**（§5.7.3）：
> 对用户需求零增益、会引入"AI 能否调低自己回滚窗口"的新风险、
> 且两个方向都更糟（调大→写更慢，调小→更早失去回滚）。
> 真正的缺陷是 `#ops()` 的全量重解析，不是这个上限。

### 第 3 层 · 完整回执（默认不展开）

**就是现有的 `fileops_list` 渲染**——保留，不删，只是不再是默认视图。

**理由**（`UI-PRINCIPLES.md` 原则 1）：完整 diff 是**给作者看的**。
但它是**可追溯性的兜底**，不能因为"人通常不看"就删掉——
按例外 A，出事时人需要能看到全部。

---

## 4. 与现有 UI 的关系

| 现有 | 处置 | 依据 |
|---|---|---|
| `fileops_list({n:200})` 逐行渲染 | **降为第 3 层**，默认不展开 | §3 第 3 层 |
| `OP_LABEL` 缺 3 项 | **补全**（见下） | `app.js:2644` |
| 每行 4 个按钮（差异/恢复/撤调用/回退到此） | **保留**，归入第 3 层 | 出事时的兜底 |
| 「清理历史」「全部停止」（`view-jobs`） | **不动**（不在本文范围） | 属 `app-ux-review-v3.md` |

**`OP_LABEL` 补全对照**（现值 → 应补）：

```js
// 现（app.js:2644）
{ write:'写入', create:'新建', delete:'删除', backup:'备份' }

// 缺（§5.2 已查实的完整取值共 7 项）
purge            → 「清空回收」
restore          → 「恢复」
restore-displace → 「恢复（置换）」
```

**注意**：`restore` / `restore-displace` 是**恢复动作本身**的记录，
与「哪些改动危险」无关——补标签时应让它们**在默认视图里不出现**
（它们是撤销的痕迹，不是待判断的改动）。

**新增的只有第 1、2 层。** 其余是**重排 + 补标签**，不是重写。

---

## 5. 已查实：后果数据源已存在（第七轮查证）

**原 §5 的四项待验证，前三项已查实——结论比预期好。**

### 5.1 后果能否自动算 —— **能，且机制已存在**

`pi/src/adapter/verify.js`（114 行）实现了**完整的 post-write 验证闭环**
（Aider `/lint` `/test` analogue）：

| 环节 | 实现 |
|---|---|
| 配置 | `.pai/verify.json` → `{ "onWrite": "npm run lint", "timeoutMs": 60000 }` |
| 触发 | 每次成功 write/edit/delete **自动跑一次** |
| **burst 合并** | `BURST_MS = 5000` —— **一次写入突发只跑一次，不是每文件一次** |
| 输出 | `{ ran, ok, code, outputTail }` |
| 操作员手动跑 | `runNow()`（`/verify` 命令，`channel.js:880` `verify_run`） |
| 安全 | 配置**agent-writable**，故命令用**与模型工具调用相同的 shell classifier + policy riskActions** 分类；不可放行的**在 arm 时即拒**（`VERIFY_REFUSED`） |

**burst 合并这条直接对上"改动大"的场景**：改 40 个文件**只跑一次验证**，不是 40 次。

### 5.2 "无测试的项目怎么办" —— **不猜，opt-in**

`verify.js:83`：未配置时返回
`{ ran: false, reason: 'no .pai/verify.json onWrite configured' }`。

**即：不自动从 `package.json` 推断，没配就不跑。**
这比我规格里猜的两条路（推断 / 复用 AI 结果）都好——**它把"该跑什么"交给项目显式声明**。

**推论**：§1 原则 3 的"先算能不能跑"**只在配置了 verifier 的项目成立**。
未配置的项目，第 1 层退化为"改动规模 + 文件增减"。**这是设计上的诚实边界，不是缺陷。**

### 5.3 ★ 意外发现：`verify_fail` 已经进了世界模型

`verify.js:107`：

```js
observations?.record({
  kind: 'verify_fail',
  subject: command.slice(0, 120),
  detail: { exit: r.code, tail: r.output.slice(-2000) },
  actor: 'host',
});
```

而 `host/src/core/observation.js` 的头部注释载明：

> **Observation store — canonical world-model observation lifecycle.**
> Observations are what the body actually observed (tool results, compaction events, runtime facts).
> **They are canonical state**: append-only, **survive compaction and body switches**,
> and the live context provider **re-reads them on every context event**.

**即："改动导致测试挂了"这个后果信号，已经在往世界模型送了。**

### 5.4 缺口的重新校准（重要修正）

`app-world-model-loop.md` 的 G2 判定需按此修正：

| 信号 | 进 observation stream |
|---|---|
| **`verify_fail`（改动导致测试挂）** | **✓ 已进** |
| 人的撤销 / 拒绝 / 中断 | ✗ 未进 |

**准确的表述不是"什么都没接"，而是"接了客观后果，没接人的反应"：**

> 系统能观察到 **"我的改动导致了什么后果"**（测试挂了），
> 但观察不到 **"人对此怎么反应"**（撤了 / 拒绝了 / 叫停了）。

**这正是 §3 第 1 层可行的原因**：
"测试 312 → 298" 的**数据源已在 `observation` 里**，
缺的只是**把 observation 汇总成一句人能读的结论**。

**且 §3 第 1 层与 §3 第 2 层的数据源不同**：

| 层 | 数据源 | 状态 |
|---|---|---|
| 第 1 层 后果摘要 | `observation`（`verify_fail` 等）| **已存在** |
| 第 2 层 风险项 | `fileops` 回执（`op.op` / `backup`）| **已存在** |

**两层的数据都已在磁盘上，都只差换算。**

---

## 5.5 仍待验证

1. ~~**第 2 层的触发条件是否正确**~~ → **原依据被推翻，见 §5.7。**
   "`create` 无 backup = 难回"**不成立**：删除进回收站，可恢复。
   真实的分级依据是 `recoverable` / `undoable` 字段（§5.7.2）。
2. ~~**`purge` 的触发条件**~~ → **已查实：`instance_purge` 碰不到收据（见 `app-world-model-loop.md` §5.7），
   真正的衰减源是 `#sweep`，见 §5.7。**
3. ~~**`observation.recent()` 的取用方式**~~ → **已查实，见 §5.6**。
4. **verifier 未配置时的第 1 层形态** —— §5.2 已确认退化为"改动规模 + 文件增减"，
   **但该退化形态能否支撑撤/留决策，未验证。**
5. **★ 新增（第八轮实测）：回路在产品当前身体组合下跑不起来** ——
   见 `app-world-model-loop.md` **§2.5**。实测四个状态目录全空，根因是
   回路实现在 `dsh/` 而 app 生产 profile 使 dsh fail-closed 不合格、只能跑 `pi`，
   `pi` 侧 `loopGovernance` 又默认不装。
   **这不是"未验证"，是"已验证为失效"** —— 列出以便与其余项区分。

**第 1 层实现前：第 3 项已通过（不需要新数据通路），但第 5 项成立意味着读通路建成后无数据可读，
需先解决 P1（让回路运行）。第 2 层实现前，第 1 项已推翻原依据、给出新依据。**

---

## 5.5b ★ 前置条件：两条，不是一条

第八轮实测（`app-world-model-loop.md` §2.5）把前置从一条变成两条：

| # | 前置 | 归属 | 状态 |
|---|---|---|---|
| **P1** | 让 pi 侧真正产出 observation（`app-world-model-loop.md` **§2.5.5** 给出精确修法：删掉 `host.js:882` 的外层三元，非"打开某个开关"） | 机制层 | **未做，且此前未被识别** |
| **P2** | 把人的反应接进回路（本规格的桥） | 本规格主题 | 设计已就绪（§4） |

**P1 不解决时，P2 建好的桥没有对端** —— 读通路会读到空文件。
但 **P2 的设计仍然成立**：桥的两端都需要，先修哪端是排期问题，不是设计问题。

> ⚠️ **P1 修好后不等于"回路跑起来了"**：pi 侧只有"写入 + 注入上下文"这半。
>
> ★ **第十一轮修正**：原写"'从 observation 提炼模型'的另半（`distiller.py` 等）
> **只在 dsh 侧，pi 没有**" —— **这个说法是错的，会误导。**
> 提炼管道**不在 dsh 侧，它是 harness 无关的**（入参全是目录路径：`--state` / `--canonical`）。
> 它读目录、写目录，不关心事件由哪个身体产生。
> **准确说法：管道可以原样复用；pi 缺的是"产出管道能读的事件"的适配器。**
> 详见 `app-world-model-loop.md` §2（概念澄清）与 §2.5.7。

---

## 5.6 第 1 层数据通路已查实：不需要新通路

**问题**：§5.5.3 曾列为"第 1 层能否落地的唯一前提"。

**结论：`app/` 拿得到 observation，且不需要新增任何跨层通路。** 证据链：

### 5.6.1 `ObservationStore` 是自足的

`host/src/core/observation.js` 全文只有 3 个方法：

| 方法 | 作用 |
|---|---|
| `constructor(canonicalDir)` | 建目录 `canonicalDir/observations/`，定 `observations.jsonl` |
| `record({kind,subject,detail,actor})` | 追加一行（**写**） |
| `list()` / `recent(limit)` | 读全量 / 读最近 N（**读**） |

**构造函数只吃一个 `canonicalDir`**，无外部依赖、无跨层引用 —— 这是它能被任意层复用的前提。

### 5.6.2 `app/server` 已经有 `canonicalDir`，且已在用同款模式

`app/server/supervisor.js`：

```js
:173   this.paths = ensureInstance(this.instanceRoot);
:511   const predictions = new PredictionStore(this.paths.canonicalDir);   // ← 同款
```

`PredictionStore` 与 `ObservationStore` 在 `host/src/core/` 下**同目录、同层、同构造签名**。
`supervisor.js` 已经在 `:510–511` 用 `this.paths.canonicalDir` 构造 `PredictionStore`，
**加一行 `new ObservationStore(this.paths.canonicalDir)` 即可，成本是一个 import + 一行。**

### 5.6.3 分层防火墙不禁止 `app → host/src/core`

`host/tests/firewall.test.js` 只约束 **`host/src/` 自己的 import**：

```js
// host/ is the neutral control plane with ZERO external dependencies
// relative imports must resolve inside host/
// bare imports may only be node: builtins
```

它检查的是 `host/src/` 里有没有人向外伸手（禁止 host 反向依赖 body/harness）。
**它不限制谁能 import `host/`。** 而 `app/server/supervisor.js` 已经 import 了 8 个
`host/src/core/*` 模块（`registry` / `lease` / `handoff` / `prediction` / `policy` /
`eligibility` / `audit` / `paiignore`）—— 第 9 个不构成新先例。

### 5.6.4 现成的同构模板：`audit_tail`

`audit` 的读通路已经跑通，且形态完全一致：

| 环节 | audit | observation（待加） |
|---|---|---|
| facade 定义 | `pi/src/adapter/channel.js:833` `auditFacade` | 同位置加 `observationFacade` |
| facade 注入 | `:860` `audit: auditFacade` | 同位置加 `observations:` |
| 构造函数收字段 | `host/src/core/channel.js:98` `audit = null` | 加 `observations = null` |
| 存字段 | `:104` `this.audit = audit` | 加 `this.observations = observations` |
| 命令分支 | `:254 case 'audit_tail'` | 加 `case 'observations_recent'` |
| UI 调用 | `app/ui/app.js:2291 cmd('audit_tail', …)` | 同款 |

**注**：`auditFacade` 不是 `AuditWriter`。`host/src/core/audit.js` 的 `AuditWriter`
**只有 `write` / `writeOrThrow`，没有 `tail`** —— 读能力是 `pi/src/adapter/channel.js:838`
新写的 facade。**这正是本项要复制的模式：读能力由 facade 现造，不要求 store 自带。**

### 5.6.5 两条路可选，成本差一个量级

| 方案 | 做法 | 成本 | 约束 |
|---|---|---|---|
| **A · app 本地读** | `supervisor.js` import `ObservationStore`，加 `case 'observations_recent'` | **一行 import + 一个 case** | 无。body 死了也能读 |
| **B · 转发给 body** | 走 `:759 default:` → `sendToBody(cmd)` → `pi/src/adapter/channel.js` 加 facade | 6 处改动，见 §5.6.4 表 | **依赖 body 存活**（`sendToBody:367` `if (!active \|\| active.dead) return 'no live body'`） |

**取 A。** 第 1 层是"给人看 AI 干了什么"，**恰恰最需要在 body 挂了/切了之后还能看** ——
B 方案在 body 死时正好失效，方向是反的。且 A 不碰 `pi/`，改动面最小。

### 5.6.6 对 §4 的影响：结论不变，但"数据已在"这一条**被推翻**

§4 原写"只是重排不是重写"。查实后这个判断成立，因为：

- 读取只需构造一个已存在的类
- 不需要 `dsh/`，不需要碰世界模型的写入路径（`u1_accept` 仍是唯一 canonical writer）
- **不触碰任何宪法约束**：只是读，不是写；不新增 authority

> ⚠️ **但原先列的第一条"数据已在 `canonicalDir/observations/observations.jsonl`"
> 已被第八轮实测推翻** —— 本机实例该目录**是空的，文件不存在**。
> 根因见 `app-world-model-loop.md` **§2.5**：回路在产品当前身体组合下跑不起来
> （实现在 `dsh/`，而 app 生产 profile 使 dsh fail-closed 不合格，只能跑 `pi`；
> `pi` 侧 `loopGovernance` 又默认不装）。
>
> **本节的工程结论（读通路不需新建跨层通路、一行即可）仍然有效** ——
> 它回答的是"**能不能读到**"，不回答"**有没有东西可读**"。
> 但第 1 层的落地因此多了一个前置：**P1（让回路真正运行）**，
> 否则建好的读通路读到的永远是空。

### 5.6.7 由此确定的一个设计约束

`ObservationStore.recent(limit)` 的 `limit` 默认 20，且 `list()` 有 `(size, mtimeMs)`
指纹缓存。**第 1 层取数必须走 `recent(n)` 而不是自己 `readFileSync`** ——
否则会绕开缓存，在 append-only 且不断增长的文件上做全量扫描。
（`observation.js:17–23` 的注释专门写了这个教训，来源是 `budget.js` 的先例。）

---

## 5.7 第 2 层分级依据已推翻并重建（两次修正）

**修正一（推翻原依据）**：曾判定"`create` 无 backup = 难回" → **错**，删除进回收站。
**修正二（推翻修正一）**：曾提出"是否滑出 200 件窗口" → **多余**，字段已算好。
**最终依据：直接用 `fileops_list` 的 `recoverable` / `undoable`（§5.7.2）。**

**原依据（§5.5.1）被推翻**：曾判定"`create` 无 backup = 难回"。
实测（`app-world-model-loop.md` §5.8）—— **`delete` 是搬进回收站不是 unlink**：

```js
// pi/src/adapter/fileops.js
:83   const dest = join(this.recycleDir, `${Date.now()}-${receiptId}-${basename(abs)}`);
:84   this.#moveTree(abs, dest);            // ← 搬移，不是删除
:85   this.#log({ receiptId, op:'delete', target: abs, recycledTo: dest, toolCallId });
```

无论文件是"AI 新建的"还是"早就存在的"，**都进回收站，都可 `restore`**。
**"没有 backup"不等于"难回"** —— 可回性由 `recycleDir/` 独立提供，我只看了 `backups/`。

### 5.7.1 真实的衰减源：`#sweep`，硬编码 200 件

`instance_purge` 碰不到收据（白名单只有 `exports/spool/sessions`，且错误文案点名
`receipts` 是 enforcement evidence）。**但 `#sweep` 会**：

```js
:55   /** Evict oldest artifacts beyond the cap; receipted as purge (invisible to undo). */
:63   for (const f of files.slice(0, Math.max(0, files.length - this.artifactCap))) {
:66     this.#log({ op: 'purge', target: f.p, swept: true });
```

- 调用点 `:86 / :110 / :133 / :158 / :172` 覆盖 delete / backup / write / restore 全部分支
  —— **每次文件变更都触发一次淘汰检查**。
- 限额 `:30 constructor(instanceRoot, { artifactCap = 200 })`；
  实例化处唯一：`pi/src/bootstrap/host.js:758`，**没传第二参** → **永远是 200**。
- **硬编码：无配置文件、无环境变量、无命令可改。**
  （对比 `budget` 有 `budget-overrides.json` + `budget_set`，是**可调**的。）

**真实语义**：

> **`backups/` 与 `recycleDir/` 各保留最近 200 件。
> 第 201 次文件变更起，最早的备份被静默删除，
> 该删除本身记为 `op:'purge', swept:true` —— 注释明写 "invisible to undo"。**

### 5.7.2 重建后的分级依据

**第 2 层分级必须是三维，不是二维**：

| 维度 | 取值来源 | 状态 |
|---|---|---|
| ① 改了什么 | `fileops_list` 的 `op` / `target` | 已存在 |
| ② 能不能跑 | `verify_fail`（observation stream） | 已存在 |
| ③ **还能不能撤** | **`fileops_list` 的 `recoverable` / `undoable` 字段** | **已存在，已算好，UI 已在用** |

**③ 不需要任何推断。** 上一稿曾提出"判断是否滑出 200 件窗口"（靠 `op:'purge', swept:true`
的位置推断）—— **这是多余的**。`pi/src/adapter/fileops.js:297` 已经在算：

```js
const recoverable = Boolean(o.recycledTo ?? o.backup) && existsSync(o.recycledTo ?? o.backup);
```

`#listOps()` 对**每一条回执**做 `existsSync` 实测，返回 `recoverable`；
并在 `:306` 另给 `undoable`（含 tombstone 语义：`create` 或 `write` 无 backup 也算可撤）。
**这是直接实测，不是从淘汰顺序反推** —— 比"滑出窗口"判据更准，且零新增数据源。

**且 UI 已经消费了这两个字段**：

| 位置 | 用法 |
|---|---|
| `app/ui/app.js:2734` | `if (op.undoable)` → 渲染「恢复」/「撤销新建」按钮 |
| `app/ui/app.js:3279` | `/undo` 按 `undoable` 过滤候选 |
| `app/ui/app.js:3323` | `/restore` 按 `recoverable` 过滤候选 |

**所以第 2 层要做的只是"把已有的字段搬进默认视图"** —— 不是新建判据，是改变呈现位置。

**由此，"200 是否应可配"这个问题被消解**（详见 §5.7.3）。

### 5.7.3 "让 `artifactCap` 可配"会怎么样 —— 结论：不该配

**四条后果，逐条都是负的或零。**

#### ① 对"用户想知道能不能撤"这个需求，增益为零

`recoverable` 是**实时实测**（`:297` 的 `existsSync`），不是快照。
所以**无论上限是 200 还是 20000，UI 给出的答案永远正确**。

可配只改变"**哪些**能撤"，不改变"**能不能知道**哪些能撤"。
而后者才是用户的需求 —— **它今天就已经满足了，不需要任何配置。**

#### ② 可配会引入一个必须回答的新问题：谁能配

如果 AI 能写这个值 → **AI 可以调低自己的回滚窗口 → 抹掉自己改动的证据**。
这正是本项目已经在防的一类：`instance_purge` 明确拒绝 `receipts`，
错误文案称其为 **enforcement evidence**（`pi/src/adapter/channel.js:1008–1010`）。

所以 `artifactCap` **只能 operator-owned，绝不可 agent-writable**。
项目里确有模板（`budget-overrides.json` / `command-allow.json` / `heartbeat.json`
都是 "OPERATOR-owned `<instance>/…`, never the agent-writable workdir"）——
**但这意味着为一个（按①）不服务用户需求的旋钮，新增一个配置文件 + 一层优先级。**

#### ③ 真正的成本不是磁盘，是读放大 —— 而可配两个方向都更糟

构造函数注释说理由是磁盘（"Unbounded growth would eventually fill the disk"）。
**但看被限的是什么、无界的是什么：**

| | 状态 | 量级 |
|---|---|---|
| `backups/` + `recycle/` | **有上限**（各 200 件） | 文件副本，几百件是小体积 |
| `fileops.jsonl`（**索引**） | **无上限、无轮转、无大小限制**（`:34`, `:312`） | 每次变更追加一行，永久增长 |

而 `#ops()`（`:237–244`）**每次都全量 `readFileSync` + 逐行 `JSON.parse`**，
`list` / `listAll` / `diff` / `undoCall` / `undoFrom` **全部经由它**。

**即：被限的是便宜的东西，无界的是索引，且索引每次读都全量重解析。**

再看调大上限的代价：`#sweep` 对每个产物做 `readdirSync` + `statSync`，
而它在**每次文件变更时都跑**（`:86 / :110 / :133 / :158 / :172`）。
**调大 → 每次写入更慢；调小 → 更早失去回滚。两个方向都不是用户想要的。**

#### ④ 长程任务：可配治不了真正的病

窗口是**全局永久**的，不是按任务的。**一个长任务做超过 200 次变更，
会把它自己早期的改动挤出窗口** —— 任务中途，AI 早先的工作就静默变成不可撤。

调大上限只是推迟，不解决。**正确修法是作用域**（按任务/会话），
或"仍被未结束任务引用的产物不淘汰"。

> 这与用户此前对 budget 上限的判断同形：**"设上限"这件事本身可能就不该做成一个需要我填数字的表单。**
> 同一个结论在这里第二次出现。

#### 该做的三件事（按 价值÷成本 排序）

1. **不做可配。** 第 2 层直接用 `recoverable` / `undoable`（已算好、已被 UI 消费，§5.7.2）。
2. **修真正的无界项：`#ops()` 的全量重解析。**
   修法不是"加个上限"，而是**增量读** —— 项目里已有先例：
   `host/src/core/observation.js:45–57` 用 `(size, mtimeMs)` 指纹缓存避免
   在 append-only 文件上做全量扫描，注释里还专门写了这个教训。
   **`FileOpsGuard.#ops()` 有完全相同的问题，却没有缓存。**
3. **若确实要暴露上限**，只能作为 operator-owned 配置（绝不可 agent 写），
   且优先做"**接近边界时告知**"而不是"让用户填数字"。

---

## 6. 本规格的可修正性

| 主张 | Falsifier |
|---|---|
| §1 原则 1 "给结论非原料" | 若实测发现人看到"测试 312→298"仍无法判断，则结论形态需重新设计 |
| §1 原则 3 "先算能不能跑" | ~~若项目普遍无测试/构建~~ → **§5.2 已查实为 opt-in（`.pai/verify.json`），非普遍缺陷**。新 falsifier：若实测项目极少配置 verifier，则第 1 层退化为常态而非例外，原则 3 需重写 |
| §3 第 2 层分级 | ~~若 §5.5.1 验证出 `create`→`delete` 也进回收站，则分级依据需重算~~ → **已验证确实进回收站（§5.7），原依据已推翻并重建为"是否滑出 200 件窗口"**。新 falsifier：若实测发现 200 件上限在实践中极少触及（如典型任务只改几十个文件），则该维度可降为次要，分级可退回二维 |
| §3 第 3 层保留完整回执 | 若实测发现完整回执从未被展开过，则按 `UI-PRINCIPLES.md` 原则 1 应删除而非保留 |
| §4 "只是重排不是重写" | ~~若第 1 层需要新的数据通路~~ → **§5.6 已查实：`app/` 拿得到 observation，只需一个 import + 一个 case，两条路都是"重排"级改动** |
| §5.3 "objective 后果已接、人的反应未接" | ~~人的反应都不在~~ → **§5.6 已查实：批准类反应已到 UI（末端被丢弃）**。新 falsifier：若发现该 `/stats` 行从未被用户看到过，则"已到 UI"不产生实际价值，结论应退回"未接" |
| §5.6.5 "取方案 A（app 本地读）" | 若实测发现 `app/` 读到的 observation 语义不足（如缺 body 归属），则需回到方案 B |
| ~~§5.7.2 "purge 收据可作窗口边界判据"~~ | ~~若 purge 收据被列表截断~~ → **该判据已被推翻（§5.7.2 修正二）：不需要推断，`recoverable`/`undoable` 已实测算好**。新 falsifier：若 `existsSync` 在跨卷/符号链接下不可靠（`#moveTree:45–53` 专门处理过 EXDEV），则 `recoverable` 可能误报 |
| §5.7.3 "`artifactCap` 不该可配" | 若实测发现典型长任务频繁超过 200 次文件变更，则"窗口足够大"的前提不成立，可配（或按任务作用域）的必要性上升 |
| §5.7.3 "真正缺陷是 `#ops()` 全量重解析" | 若实测发现 `fileops.jsonl` 在实践中很小（如每会话仅数十条），则读放大不构成实际成本，该结论降级为"理论问题"。**本轮实测：本机实例 `fileops.jsonl` 根本不存在（0 次文件变更回执），故无法据实测量级 —— 该 falsifier 仍未决** |
| **§5.5b "P1 未解决则桥无对端"** | 若发现 app 另有不走 `bodies.js` 的 dsh 启动路径，则 P1 可能已部分满足。**本轮只查了 `app/server/bodies.js` 与 `instance/runtime.json`** |
| **§5.6.6 "读通路仍值得先建"** | 若 P1 短期无法解决，则先建读通路是空转；此时应调整优先级，先做 §5.7.3 的 `#ops()` 缓存等不依赖回路运行的项 |

**本规格是假设集，不是结论。§5.5 第 4 项未验证前不得实现第 1 层的退化形态。
第 2 层的分级依据已重建（§5.7）。第 1 层的数据通路已查实可建（§5.6），
但 **§5.5b 的 P1（回路实际未运行）必须先解决，否则读通路读到的永远是空**。**
