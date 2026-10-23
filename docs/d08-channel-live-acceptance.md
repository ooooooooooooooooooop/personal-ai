# D08 — 通道与控制面真实链路验收（公开审计摘要）

> 本文件是**公开审计摘要层**：只记录结论、退出码、产物哈希与边界声明。
> 原始事件流、SSE 抓包、磁盘时序采样等**私有真实运行层**证据不入库，
> 存放于 `~/.personal-ai/d08-evidence/`（git 外，绝不出机）。
>
> 记录时间：2026-10-23 · 执行 commit：`7f65aaf`（修复提交 `2222729`）

---

## 1. 范围边界（必须先读）

| 维度 | 声明 |
|---|---|
| **body** | **pi only** |
| 不覆盖 | `dsh` 及任何非 pi 身体 |
| 依据 | `pi/src/bootstrap/facts.js` 的 `REQUIRED_BODY_CAPABILITIES` 保持 `non-negotiable`（本次未提交任何降级） |
| 影响 | 任何"三身体/Harness 全量可用"的表述**都不被本报告支持** |

`facts.js` 曾在工作中被改成可选项，已按决断 `git checkout` 回退。回退后 host 侧 426/426 全绿、pi 主路径零影响 —— 那 3 行只削底线（让 dsh 可选），不修任何缺陷。因此 D08 的可交付范围被物理地限定在 pi。

### 启动三件套（缺一跑不通，属于本报告的复现前提）

1. `PAI_PYTHON` 指向 anaconda python：`canonical_compile` / `instruction_compile` 需要 PyYAML，managed 3.13.12 没有；缺失时报 `ModuleNotFoundError: yaml`。
2. `PAI_CANONICAL_DIR` 指向隔离副本：所有认知写入必须落在副本上，真实库零改动。
3. `app-config.json` 的 `workdir` **覆盖**命令行 `--workdir`（`app/server/supervisor.js:160-161`）。这一点在第一轮测量里直接毁掉了一次 C21-b 的数据。

---

## 2. 结果总表

| 项 | 内容 | 结论 |
|---|---|---|
| C21-a | 真实多步任务：模型规划 → 写文件 → 执行 → 核对 | **PASS** |
| C21-b | 停止路径：`abort` 在 pending ask 挂起态下的语义 | **PASS**（控制面 253ms） |
| C21-b｜副作用 | abort 后 bash 后代子进程未原子切断 | **FAIL — 上游已知边界，挂账**（见 §4 B） |
| C21-c | 退出重启后会话/事项恢复 | **PASS** |
| C22 | 认知生命周期否决路径 | **PASS**（真实库逐字节不变） |
| C22｜采纳路径 | accept → canonical → 编译 → 加载 | **PARTIAL**（2026-10-23 隔离取证：写入 PASS / 编译 PASS / **传播 FAIL**；同日 `docs/briefing-truncation-fix.md` 修复缺陷 E 后，沙箱内传播已 13/13 命中，但真实库产物未重编译，见 §4 E） |

**G1 不结算。** D07.5 与上表全部条目都只是 G1 的必要条件，不是充分条件；C22 采纳链路与缺陷 B 未闭合，G1 维持未结算状态。

---

## 3. 逐项证据

### C21-a 真实多步任务 — PASS

provider `cpa/gpt-6-luna`（relay `127.0.0.1:8317`，`/v1/models` 返回 200）。6 次真实工具调用，产物与独立复算逐字节一致：

| 产物 | 字节 | sha256 |
|---|---|---|
| `plan.md` | 173 | `5a16e507be6a44f5865f1610a264e7e3a0e7bc580b00f049c6713d9b5669a4ac` |
| `compute.js` | 164 | `32a0ba036f3f782a95a90113ddd772e3a4426c1fba577fd06d743193a3a623a2` |
| `result.txt` | 23 | `0c7ee0a7b098292490a8d5092a47c581905a7dfb0cb89b5a04509f82f021fd88` |

独立复算：`node compute.js > .recompute.txt && cmp .recompute.txt result.txt` → 逐字节一致。

### C21-b 停止路径的控制面语义 — PASS

**修复前（真实缺陷 A）**：模型发起 `ask_user`，turn 停在 `await asks.ask()`（寿命 120s > supervisor 的 60s），而 abort facade 先 `await box.s.abort()` 再 `abortPending()` → abort 等不到 ask 解除。

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `abort` 返回耗时 | **60034 ms** | **253 ms** |
| `abort` 结果 | `success=false error='body command timed out'` | `success=true` |
| abort 后事件流 | 69 行 → 185 行（继续增长） | 停止增长，末两条 `agent_end` / `agent_settled` |
| `messageCount` | 18 → 23 | 不再变化 |
| turn 是否真正结束 | **否** | **是** |

修复点在 `pi/src/adapter/channel.js` 的 abort facade：`asks.abortPending()` 先于 `box.s.abort()`。
回归：`pi/tests/abort-releases-asks.test.js` —— 换回旧顺序时 TIMEOUT 红，恢复后绿。

### C21-c 退出重启 — PASS

退出前基线 `messageCount=20`、`contextUsage=1.2791428571428571%`。kill 进程后重新 spawn 真实 pi body：新会话为空、`session_list` 列出旧会话，`session_switch` 切回后两个数值**逐位一致**。`todos` 保持 `in_progress`，会话文件 mtime 未被重启改写。

### C22 认知链路 — 否决 PASS / 采纳阻塞

否决路径（`MODEL_PROPOSAL` + `proposal_decide reject`，367ms）：

`current.yaml` sha256 前后均为
`32658d1b6e0bf5e4aab2f81242dc83e12b9a5b36121caae05e3ca64376cca503` —— 逐字节一致。

**真实库零改动**：真实 canonical 的 `current.yaml` 哈希仍为 `32658d1b…`，被裁决提案在真实库中仍为 `proposed`。副本与真实库的唯一差异就是"被裁决的提案 + 其历史"这两个文件。

采纳路径已于 2026-10-23 在隔离沙箱中取得证据，**判定 PARTIAL**：写入与编译两段真实闭合，但被采纳的模型没有进入身体读到的简报。完整数据见 `docs/c22-accept-evidence.md`，缺陷记为 §4 E。**仍不记为通过。**
同日缺陷 E 修复后（`docs/briefing-truncation-fix.md`），沙箱内传播段已闭合：13/13 条目全部就位，`cand-8975ff9f` 进入 §3。**仍不结算 C22** —— 真实库的 `briefing.md` 还是旧代码产物，产物重生成是 owner 动作，不是代码缺口。

---

## 4. 缺陷账（A – F）

### A. abort 死锁 — 已修复

见 §3 C21-b。提交 `2222729`。

### B. Windows 下 abort 后子进程孤儿化 — 挂账，不在本项目修复

**症状**：abort 控制面已返回 `success`（590ms），但 `bash` 工具派生的后代仍在写盘 —— `side.log` 从 5 行涨到 77 行，两个 `bash.exe loop.sh` 存活，需手动 `taskkill` 才停。

**与此同时的另一面**：事件层证明 bash 工具**确实收到了 abort** —— `tool_execution_end` 的 `result.content[0].text == "Command aborted"`，距 abort 约 1 秒。所以这不是"abort 没传下去"，而是"传下去之后杀不干净"。

**根因（属于锁定依赖 `@earendil-works/pi-coding-agent@0.85.1`，非本项目代码）**：
`dist/core/tools/bash.js:75` 的 `onAbort -> killProcessTree(child.pid)`（监听器在 `:82-86` 挂到 `signal`），
`killProcessTree` 在 win32 上异步 `spawn` `taskkill.exe /F /T /PID <shell pid>`。
在 MSYS2 / Git Bash 环境下，根 shell 往往先于 `taskkill` 的内核遍历退出，`/T` 因根节点失效而够不到已被重挂载的后代。

`killProcessTree` / `killTrackedDetachedChildren` 在 `dist/utils/shell.d.ts` 里有声明，但**不在包入口**：
实测包入口 151 个导出中两者均不存在，且 `package.json` 的 `exports` 只放行 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，深路径导入同样被挡。所以本项目层既拿不到 pid，也调不到这个函数。

**处置决断：挂账 + 上游 issue，不自建 PID 表。**
理由：（1）`child.pid` 被封在第三方工具闭包里，要抓它只能全局 monkey-patch `child_process.spawn`，属于在宿主层对全局进程派生做影子记账，破坏性极高；（2）Windows 上要 100% 解决必须依赖 Job Object，普通进程树杀伤在时序上必然存在该竞态；（3）为了掩盖一个已知缺陷去发明一套自制引擎，违反本项目的核心公理。

判定依据（可复跑）：

```bash
cd pi && node -e "import('@earendil-works/pi-coding-agent').then(m=>console.log(Object.keys(m).length,'killProcessTree' in m))"
# 输出: 151 false
```

**边界声明**：C21-b 的**调度与控制面中止语义通过（253ms）**；孤儿孙进程的彻底回收受限于上游 Windows 进程树异步机制，留待上游修复。**不影响非 Windows 平台，也不影响正常生命周期内的进程退出。**

条目已落 `FAILURES.md`（第 7 条）。

### C. 工具级错误被写成 `isError: false` — 已修复

`agent-loop.js:477` 用"是否抛异常"判定 `isError`，而 `pi/src/` 有 **104 处**以 `{content, isError:true}` **正常返回**（不抛）。于是工具明明报了错，事件与 transcript 都记成成功 —— 不仅错误被吞，还会误导 LLM 反复重试。

修复点定在 `afterToolCall`（`agent-loop.js:512`），因为它是**唯一能同时纠正事件与 transcript 的缝**（两者都在其后构建），而且 `pi/src/adapter/session.js` 里原有的 `afterToolCall` 只在持有 writeLease 时才安装 —— 现在改为**无条件安装**，语义只升不降：

```js
if (!ctx?.result?.isError) return out;
return { ...(out ?? {}), isError: true };
```

回归：`pi/tests/tool-error-normalization.test.js` 两条 —— 一条守"错误必须冒头"（撤归一化 → `expected: true / actual: false`），一条守反向"成功不得被标错"。

过程中有过一次我自己的坏变异：只删判定行却留下 `isError:true`，变成"恒报错"，被第二条用例抓出。变异必须整体撤销、不能只撤一半。

### D. 提案 kind 契约断裂 — 部分闭合（D0 已做，D1 未做）

`mind/u1_accept.py` 只接受 `MODEL_PROPOSAL` / `STATUS_UPDATE`，而队列 100 个提案里只有 3 个属于这两类；其余 13 种 kind（`model-update` 64 个、`canonical` 15 个、`value-update` 7 个 ……）裁决必然失败。这不是测试问题，是契约本身没覆盖真实分布。

后续：`0893737` 修掉终止决策被 apply 门禁挡住、补上 `withdraw` 并登记 kind 契约；`bc526c5` / `fd0f4d4` 把 84 条不可 apply 的历史提案批量封存（`proposed` 89 → 5）。剩余 5 条中 4 条是 `foreign`，未取证。详见 `docs/proposal-kind-contract-gap.md`。

### E. 采纳成功的模型对运行时不可见 — 代码已修复，产物未重编译

C22 隔离取证（`docs/c22-accept-evidence.md`）暴露：`mind/canonical_compile.py:119` 用 `list(models.items())[:6]` 按**插入序**截断简报模型区，而 `u1_accept` 把新模型追加到末尾。结果是 **9 个 canonical 模型只有 6 个进简报，缺失的 3 个里 2 个是早已 accepted 的、1 个是刚 accept 的**。

字节预算从未成为约束：旧简报离 8192 硬顶还差 2403 字节；文件自身设计的按优先级裁剪算法被这个魔数整段绕过。宿主 `doctor` 的 `compiled_artifacts` 只验存在与新鲜度，对"在场但截断"的通道无感，对此状态报 `pass`。

**2026-10-23 修复**（`docs/briefing-truncation-fix.md`）：按位置取模型改为按状态与新鲜度排序（`usable` 优先 → `provenance.ts` 倒序），`SUPERSEDED` 移入 §4 而非删除；只有字节预算能删条目，且必须留下具名 `[truncated]` 标记；§5 的 `[:5]` 同步去掉；裁剪序与 docstring 声明的优先级对齐（原代码是反的）；写入由 `write_text` 改 `write_bytes`（Windows 下 CRLF 转换让报告的 5986 与磁盘的 6063 差了 77 字节，等于硬顶按少算的账在守）。19 个覆盖传感器 + 5 个变异变体全杀。

**仍未闭合的部分**：真实库 `briefing.md` 没有重编译，身体现在读到的仍是旧产物（`4be01ea0…`，缺 2 个模型）。修复的是编译器，不是产物。C22 因此**仍记为 PARTIAL** —— 隔离沙箱内 `accept → compile → load` 已 13/13 全命中（旧编译器下 accept 改了 `current.yaml`、编译报成功、简报一个字节没动），但真实实例要等 owner 显式重生成。

### F. apply 路径无幂等守卫 — 未修复

同一提案连续 `accept` 两次：两次退出码均 0，`model-updates.jsonl` 落 2 行 `U1_APPLY`，新建 2 个回滚目录，`current.yaml` 里该模型的 `provenance.ts` 与 `update_history` 被第二次覆盖 —— 首次采纳时间只剩 ledger 记得。D0 只给终止决策加了幂等，apply 没有。

---

## 5. 证据分层与校验

| 层 | 位置 | 是否入库 |
|---|---|---|
| 私有真实运行层 | `~/.personal-ai/d08-evidence/run-20261023-1030/`、`run-20261023-1120-fix/` | 否（git 外） |
| 公开审计摘要层 | 本文件 | 是 |

私有层关键文件的 sha256（供出机前校验）：

```
c3051d14fc71c6ce0d3923d7646c4511da99d18e47414da0c8bceac8dc6e44e1  events-c21b-deadlock.sse
b268d9b948106984ccc0530db8c4de2015a51ec74184d0650146818533c8b373  events-c21b-side2.sse
85214b295a019751fec4b9edba25f93cd5df168425f33ccdb54e800562a985b6  events-c21b-sideeffect.sse
9884a70664e108776b1e7fb26c21e430410155adf0fb9f6c11e2bdccc232e93c  events-c21a.sse
84cfe4820365257a31bf1cd38ea68d6b3e852524283d84661d83af99e3908a1c  c22-canonical-baseline.txt
```

### 作废的数据（保留以便追溯）

第一次 B 测量在 `C:/tmp/d08-work` 进行时，出现 `run.log` 无来源生成又消失、且无对应 bash 工具事件的情况 —— 该次数据**整次作废**，B 的全部结论只采自干净目录 `C:/tmp/d08-work2`。

### 并发抖动（非本次改动引起）

pi 的 ORPHAN DRILL、host 的 lease E4 在全量并发下会红，孤立连跑 3/3 绿。记为并发抖动，不计入缺陷。

---

## 6. 认知事件链

```
prompt ──► 模型规划 ──► tool_execution_start ──► (bash|write|read) ──► tool_execution_end
                                                              │
                                              ┌───────────────┴────────────────┐
                                         result.isError                 result ok
                                              │                              │
                                    afterToolCall 归一化              afterToolCall 直通
                                              │                              │
                                    event.isError=true              event.isError=false
                                              └───────────────┬────────────────┘
                                                              ▼
                                                        transcript 落盘
                                                              ▼
                                        [C22] proposal_decide ──► reject ──► canonical 不变
                                                              └─► accept ──► 编译 ──► 加载
                                                                            （未取证）
```

`afterToolCall` 位于 event / transcript 构建之前，这是缺陷 C 唯一的正确修复位置。
