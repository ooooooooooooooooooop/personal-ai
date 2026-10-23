# 模型与引擎验收矩阵（PRD F08 / §3.3 / M0 出口物）

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-10-14 |
| 上游 | [`personal-ai-desktop-mvp-prd.md`](./personal-ai-desktop-mvp-prd.md) F08、§3.3、§10 M0 |
| 规则 | **界面存在选项 ≠ 支持。** 每个组合按四个维度分别判定，任何一格没有真实证据就标「未验证」；不允许用模拟身体、绑定字段或元数据替代真实连续性结论 |

## 1. 判定维度与证据等级

| 维度 | 含义 | 什么算证据 |
| --- | --- | --- |
| 可配置 | UI/配置面能设置该组合 | 配置路径存在（弱证据，单独不构成支持） |
| 适格 | eligibility/能力声明允许 | `eligible()` 判定 + fail-closed 理由 |
| 真实执行通过 | 该组合完成过真实消息往返或真实任务 | 验收回执（版本、输入、结果、证据位置）；合成夹具结果单独标记 |
| 连续性已验证 | 重启/切换后目标、认知、治理与执行身份保持 | 真实路径演练记录；fixture 契约测试只算「契约验证」 |

证据等级：**L0 真实路径回执 > L1 真实使用但未留回执 > L2 契约/fixture 测试 > L3 代码路径存在**。L3 单独出现时结论只能是「未验证」。

## 2. 引擎（身体）矩阵

基线版本：app 0.1.0 · pi 身体 pin `@earendil-works/*@0.85.1`（lockfile 即 runtime identity）· host 契约以 `host/tests/` 为准。

| 引擎 | 可配置 | 适格 | 真实执行通过 | 连续性已验证 | 限制与证据 |
| --- | --- | --- | --- | --- | --- |
| **pi** | ✅（默认身体） | ✅ 三项必备能力 `negotiable:false` 全 supported（`pi/src/bootstrap/facts.js`） | ✅ L0：`scripts/` 冒烟（mock provider）+ 日常使用；2026-10-14 prompt 幂等真实路径演练（`.taskflow/smoke-prompt-ledger.mjs`，重复发送零额外 provider 调用） | 🟡 部分：重启/会话恢复有契约测试（L2）；跨身体 handoff 仅 fixture 双侧（L2）——**真实 pi↔x 切换演练未做** | 唯一适格身体 |
| **dsh** | ✅（代码在） | ❌ **fail-closed**：`final_post_extension_guard: unsupported`，`negotiable:false` → 不合格（`dsh/adapter/index.js` 注释：该缺口正是迁移理由） | —（不适格故不验收） | — | **如实拒绝**，不显示成可用；恢复条件 = dsh 获得 post-extension 复合守卫（上游包能力，非本仓可加） |

## 3. 模型接口矩阵（pi 身体上）

「可配置」= 设置页接口类型下拉存在；适格 = pi SDK 声明支持。**真实执行通过**与**连续性**两列，除已标注外一律未验证。

| 接口类型 | 可配置 | 真实执行通过 | 备注 |
| --- | --- | --- | --- |
| openai-completions（OpenAI 兼容，含 DeepSeek 等） | ✅ | 🟡 L0/L1：mock provider 冒烟全链路（2026-10-14 `smoke-prompt-ledger`）；真实 provider 日常使用（L1，未留验收回执） | 主用路径 |
| openai-responses | ✅ | 未验证 | |
| anthropic-messages | ✅ | 未验证 | |
| google-generative-ai | ✅ | 未验证 | |
| mistral-conversations | ✅ | 未验证 | |
| azure-openai-responses | ✅ | 未验证 | |
| bedrock-converse-stream | ✅ | 未验证 | |
| openai-codex-responses | ✅ | 未验证 | |

历史参考（**不构成本版证据**）：`docs/dsh-model-capability-reconciliation-report.md` 与 `docs/dsh-model-capability-live-validation.json` 是 dsh 时代的路由能力核对（2026-09-02），身体不同，结论不可迁移。

## 4. 切换组合（连续性）

| 组合 | 状态 | 证据 |
| --- | --- | --- |
| 重启续接（同身体同会话） | 🟡 L2 契约测试 + L1 日常使用 | `host/tests/continuation.test.js`、会话持久化；跨日真实验收（A04）未留回执 |
| pi → pi 会话切换 | 🟡 L2 | `session_switch` 契约测试 |
| pi ↔ dsh | ❌ 关闭 | dsh 不适格，fail-closed 拒绝（这是正确答案，不是缺口） |
| 模型热切换（同身体） | 🟡 L1/L2 | `model_set` 真实路径 2026-10-13 修复后可用；切换中状态与身份回执有 UI；**切换后认知连续性（briefing 仍挂载）未演练** |

## 5. 升级一格的最小动作（每格怎么从「未验证」变成「已验证」）

| 目标格 | 动作 | 出口 |
| --- | --- | --- |
| 某接口类型 真实执行通过 | 配该 provider，发一条真实消息，核对 model_status 显示与实际执行一致（A01） | 回执记入本表（版本+日期+结果） |
| 模型热切换 连续性 | 切换后发一条消息，确认认知卡 briefing 仍在、治理策略校验码不变 | A12 演练记录 |
| 跨身体 handoff | 等第二个适格身体出现再评；当前无对象 | — |

## 6. 维护规则

- 每格结论绑定版本与日期；升级证据必须是 L0/L1，L2 只能佐证不能定案。
- 新增 provider 或身体默认全部「未验证」，验收后逐格升级。
- 本表是 M0 出口的一部分；效力结论（G2）不依赖本表，本表只回答「哪些组合被声明支持」。
