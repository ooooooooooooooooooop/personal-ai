# dsh-world-model

Personal AI 世界模型的**机制层**插件（非提示词）。theory V0.3.1 / schema 1.1。

插件是身体上的适配器器官——灵魂（W/V/U/L canonical 状态）harness 无关，
本插件只认 `canonicalDir` / `stateDir` / `bodyId` 三个接口；换 harness = 换适配器。

| 机制 | 实现 |
|---|---|
| `world_model` 工具 | activate/model/predict/observe/evaluate/update/probe/meta/value/input/persist/status/declassify → 真实落盘 |
| RAW_EVIDENCE 捕获 | `tools/result` 机械记录全部工具结果（L0，带 source/channel/tool provenance、event_seq、causal prev_event 链） |
| 硬门禁 | `tools.guard`：CORE/FULL 下 consequential mutation 无绑定预测不放行；已评估/superseded 预测不授权；不可逆模式需 `irreversible:true` |
| Briefing | canonical 编译产物 `briefing.md`（七段、≤8KiB）以 `systemPrompt.section` 挂载——永远在场、每次 assemble 重读、不竞争 user 消息；STALE 检测 |
| INPUT_SEMANTICS | `op:"input"`：EPISTEMIC_CLAIM→W证据 / NORMATIVE_DIRECTIVE→查 governance normative_authorities / AUTHORIZATION / DURABLE_VALUE_STATEMENT→value proposal / PREFERENCE→局部 |
| Body lease | 同一 entity_id 单 canonical writer；lease 不匹配 → LEASE_DENIED；lineage_head 异动 → FORK_DETECTED |
| 状态层 | L1 `~/.dsh/world-model/` 随时写；L2/L3 canonical 只收 `proposals/`（治理路径） |

配套工具（**已迁至 `mind/`**，不在本目录）：

> 本目录**只放 DSH 适配器**（`world-model.mjs` + `cordis.patch.yml` + `package.json`）。
> 维护认知状态的工具链是 **harness 无关**的，按分层归位在 [`mind/`](../../mind/README.md)。
> 二者不同类：适配器绑身体，工具链不绑。

- [`mind/migrate_v031.py`](../../mind/migrate_v031.py) — canonical schema 1.0→1.1 迁移/回滚/verify（不 silent drop）
- [`mind/canonical_compile.py`](../../mind/canonical_compile.py) — 编译 `briefing.md`（GENERATED，不可手写）+ `runtime-state.json` 投影
- [`mind/distiller.py`](../../mind/distiller.py) — A：closed episodes→evidence packet→problem object；抽象器协议（none/file/template）+ grounding validator→MODEL_PROPOSAL
- [`mind/hypothesis_search.py`](../../mind/hypothesis_search.py) — B：problem object→H4（8 算子库+applicability）；统一 worker 契约；`--mark` 写 HYPOTHESIS_STATE_UPDATE
- [`mind/u1_accept.py`](../../mind/u1_accept.py) — U1 governed apply：唯一 canonical 写者；proposal→canonical + rollback 备份 + provisional 状态
- [`mind/lp_evaluator.py`](../../mind/lp_evaluator.py) — Learning Progress 只读评估（closed episodes → metric vector；无 canonical 写权）
- [`mind/bcc_check.py`](../../mind/bcc_check.py) + [`mind/simulate_body.mjs`](../../mind/simulate_body.mjs) — BCC-1 六协议测试（真实插件 vs python 参照体）

端到端（设计目标链路）：episodes→packet→problem→worker 抽象→validator→MODEL_PROPOSAL→H4→判别 probe→HYPOTHESIS_STATE_UPDATE→晋升→U1 accept→canonical→briefing 跨会话生效。

> ⚠️ **诚实注记（2026-09-23 复核）**：原写"已在真实会话验证"。复核本机证据后**无法证实**：
> 全部 DSH 会话（17 目录 / 1.6 GB / 约 160 万行）中世界模型关键词 **0 命中**；
> 适配器装于 2026-09-16，而实质会话全在 09-14 之前。
> **已确认的是**：管道本身 50 项回归测试全过，且测试通过 `simulate_body.mjs`
> 驱动了真实适配器（`python -m unittest tests.test_wm_v031 -v`）。
> **未确认的是**：适配器在真实 harness 里的接线（RAW_EVIDENCE 捕获、
> briefing 挂载为 `systemPrompt.section`、守卫挂到 `tools.guard`）。
> 若"真实会话验证"发生在另一台研究机，请补注出处。

模式：`config.mode` 或 `DSH_WM_MODE` = `off|core|full|strict-off`。
OFF/CORE/FULL 是世界模型的**形式化深度**不是开关——世界模型永远在场。

部署：见 `cordis.patch.yml` 注释。回归：`python -m unittest tests.test_wm_v031 -v`。
