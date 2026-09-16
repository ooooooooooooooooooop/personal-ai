# dsh/ 包处置标 — M5 矩阵执行（M7）

逐包处置类别（语义见 `docs/cordis-disposition.md`）。
**重要**：此表是打标记录，不是删除清单。R8 语义：DSH 仍可在其能力满足任务时被选择——标注 D 表示"机制已由 host/pi 等价物承担"，当 DSH 身体被选中时这些插件照常工作。

| 包 | 类 | 等价物 / 去向 |
|---|---|---|
| context-pressure-guard | D | `context`/`before_provider_request` 缝（M3） |
| token-saver | D | spill/pruner 机制（A 候选） |
| autonomous-execution-governor | D | composite guard（M2） |
| compaction-convergence | D | `session_before_compact`（M3） |
| model-switch-controller | D | `model_select` 审计 + policy（M3） |
| workflow-model-preflight-gate | D | eligibility/policy（M2） |
| repeat-tool-reminder-patch | D | no_progress 断路器（M3） |
| subagent-prep-exec-gate | D | delegate_task guard 链（M4） |
| subagent-splice-summarizer | D | delegate result envelope（M4） |
| subagent-usage-observer | D | parent_run_id 归属（M4） |
| world-model | **A** | canonical 机制；`host/src/core/prediction.js` 已落地 enforcement（M2） |
| context-lifecycle | D | handoff/envelope + session 持久（M1/M3） |
| model-persona | B | soul/persona 概念（canonical 归属） |
| research-lab-adapter | B | 渠道适配——DSH 身体内保留 |
| web-search-adapter | B | 渠道适配——DSH 身体内保留 |
| ui | C | UI 状态面 → Chord replicatedState（M6 边界评估过） |
| workspace-registry-root-fix | D | BodyRegistry（M1） |
| runtime | E | 运行态，不进发布面 |

## 写域让位

DSH 让位**生产控制写域**给 pi（默认身体）。机制保障：
- canonical mutation lock（`scripts/governance/`）跨 harness 单写者——与身体无关
- host `lease.js` 域级 CAS + fencing——pi/将来身体同机制
- 身体选择=策略层：DSH 能力满足任务（web_ui、渠道适配）时仍合法可选，此时其写域由同一 lease 体系裁决——没有"退役即禁写"的硬编码
