# 好用度客观记账 — 设计契约（预注册）

2026-10-12 仓主裁定（投产前审查决定 6）：

> 这个记账要记录在本地而不能发布；这个记账要客观记录而不能记录主观信息；
> 这个记录要提前设计好怎么评价有没有更好用，后面再根据记录的客观信息客观评价。

本文档是**预注册（pre-registration）**：指标、窗口、判定规则在收集数据之前写死。
以后改规则 = 新版本预注册（新 schema 版本号），旧数据按旧规则评估，不得回溯改判。

## 1. 三条硬约束的机械落实

| 约束 | 落实 |
|---|---|
| 本地专用不发布 | ledger 只写 instance root（默认 `~/.personal-ai/usability/`）；`ledger_dir()` 拒绝任何 git 仓库内的路径（向上逐级查 `.git`）；ledger 内容永不存在于任何 repo，发布门禁天然看不见它 |
| 客观记录 | ledger 行 schema `USABILITY_SESSION_V1` 只有计数/时长/SHA-256 哈希；`validate_row()` 白名单校验，任何自由文本键 fail-closed 拒绝。消息内容、会话 ID、错误文本一律不进 ledger（ID 与错误签名只存哈希） |
| 预注册评估 | §3 的窗口、指标、阈值、判定规则写死在代码常量里；`evaluate()` 只读客观行机械出 verdict |

## 2. 记什么（每会话一行，全部机械可数）

从会话 JSONL（`.jsonl` / `.jsonl.zstd`）提取，不读语义、不做主观判断：

| 指标 | 定义（机械规则） | 对应"好用"维度 |
|---|---|---|
| `user_turns` | 用户消息条数 | 同样的任务需要教几遍 |
| `tool_errors` / `tool_calls` | 工具调用失败/总数 | 执行可靠性 |
| `repeat_user_msgs` | 用户消息归一化后与**本会话更早**消息完全重复（≥10 字符防"嗯/好"误报，中文信息密度高） | 重述 = 没被理解 |
| `large_pastes` | 用户单条消息 ≥40 行 | 人工状态转写（网页 GPT → Agent 搬运）代理信号 |
| `first_response_latency_s` | 首条用户消息 → 首条 agent 回复 | 等待 |
| `session_duration_s` | 会话首尾时间戳差 | 任务耗时 |
| `error_signatures` | (工具名+错误类) 的哈希集合 | 跨会话重复犯错的原料 |

事件 type → 分类的映射（`_DEFAULT_TYPE_MAP`）是**结构元数据配置**，不含内容；
未知 type 计入 `unknown_events`，映射校准时只看 type 直方图，不读内容。

## 3. 怎么评价"有没有更好用"（固定规则）

- **窗口**：滚动 28 天 vs 前一个 28 天。
- **样本门槛**：每个窗口 ≥20 个会话，否则 `INSUFFICIENT_DATA`（小样本不出结论）。
- **核心指标**（越小越好，6 项）：median user_turns、tool_error_rate、
  repeat_user_msg_rate、large_paste_rate、median first_response_latency、
  repeat_error_recurrences（同一错误签名在窗口内被 ≥2 个会话命中）。
- **判定**：6 项中 ≥4 项改善 ≥10% 且无一项退化 ≥10% → `BETTER`；
  镜像 → `WORSE`；其余 → `MIXED`。
- 评估报告写 `<instance>/usability/reports/eval-<date>.json`，同样只含聚合数字。

## 4. 用法

```bash
python scripts/usability/usability_ledger.py ingest --sessions-dir ~/.dsh/sessions --harness dsh
python scripts/usability/usability_ledger.py status
python scripts/usability/usability_ledger.py evaluate
```

## 5. 边界与诚实声明

- 这是**代理指标**集合，不声称度量"满意度"；它度量的是可机械观察的摩擦信号。
  结论永远读作"这些客观摩擦在减少/增加"，不读作"用户更喜欢了"。
- `large_pastes` 是人工转写的代理（也可能是一次性贴日志，属正常）；单指标不判刑，
  判定只看 6 项整体方向。
- app 层（自有 UI）会话的 ingest 是预留扩展点，v1 只覆盖 DSH 会话 JSONL。
