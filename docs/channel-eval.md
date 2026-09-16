# M6 S-rpc / ACP 渠道评估（spike artifact）

**结论（先行）**：UI/远程通道走 **HostChannel**（`host/src/core/channel.js`，协议面刻意同构 `pi --mode rpc`），Pi 身体内走 **SDK 进程内面**（`AgentSession`），**不引入 ACP 边界**。本文是该评估的留档，支撑 M6 出口"渠道经 RPC/SDK 重建；UI 是 host 的消费者不是 harness 的"。

## 评估对象

| 面 | 位置 | 性质 |
|---|---|---|
| `pi --mode rpc` | `pi-coding-agent/docs/rpc.md`（0.85.1 已核全文） | 子进程 JSONL 协议：stdin 命令 / stdout `response`+事件流，LF 分帧，`id` 关联 |
| AgentSession SDK | `@earendil-works/pi-coding-agent` 进程内 API | `prompt/steer/abort/getState/subscribe` + 全部 extension 事件缝 |
| ACP | Agent Client Protocol（Zed 系编辑器↔agent 协议） | 跨进程 JSON-RPC，面向"编辑器当客户端" |

## `pi --mode rpc` 命令面清点（rpc.md 实测）

- 提示/排队：`prompt`（含 `streamingBehavior: steer|followUp`、images、扩展命令直通）、`steer`、`follow_up`、`abort`、`clear_queue`、`new_session`（含 `parentSession` 谱系）
- 状态：`get_state`、`get_messages`、`get_session_stats`（token/cost/contextUsage）、`export_html`、`get_entries`（since 游标，跨重启续拉）、`get_tree`、`get_last_assistant_text`、`get_fork_messages`
- 模型/思考：`set_model`、`cycle_model`、`get_available_models`、`set_thinking_level`、`cycle_thinking_level`、`get_available_thinking_levels`
- 队列/压缩/重试：`set_steering_mode`、`set_follow_up_mode`、`compact`、`set_auto_compaction`、`set_auto_retry`、`abort_retry`
- 会话/分支：`switch_session`、`fork`、`clone`、`set_session_name`
- 执行：`bash`（`bash_execution_update` 流式事件）、`abort_bash`

## 三个候选接法与裁决

| 方案 | 覆盖度 | 问题 | 裁决 |
|---|---|---|---|
| 直接复用 `pi --mode rpc` 子进程 | 命令面全 | UI 说的是 **harness 的协议**——换身体就要换协议栈，违背 M6 目标"UI 是 host 的消费者"；且 body 专有命令（fork/clone/branch）会把 Pi 会话树语义泄漏给 UI | 否 |
| AgentSession SDK 进程内 | 命令面等价 + extension 事件缝全（`before_provider_request`/`session_before_compact` 等 RPC 面没有） | 仅限 Node 进程内 | **身体侧采用**——adapter 需要事件缝做治理，RPC 子进程拿不到这些钩子 |
| ACP 边界 | 编辑器生态标准 | 多一层 JSON-RPC 转换、session/update 语义与我们的双信封/审计模型不匹配；本仓无编辑器客户端需求 | **不引入**——无消费者即无边界，留待真有编辑器接入再评 |

## 落地形态

- **`host/src/core/channel.js` HostChannel**：命令 `prompt/steer/abort/get_state/job_status/audit_tail`——前四个刻意同构 rpc 面（UI 心智模型一致），后两个是 host 专有面（durable job + 审计，任何身体都必须能答）；事件扇出 `{type:'event'|'audit'}`；命令错误恒 `{success:false}` 信封不抛出。
- **`pi/bin/pai-channel.js`**：JSONL stdio 通道进程，UI/远程端说 HostChannel 协议；换身体时该协议不动，只换 facade 实现。
- **RPC 面未覆盖项**（`fork/clone/get_tree` 等分支语义、`bash` 直执）有意不进 HostChannel：分支是 Pi 私有会话树语义，operator 直执走 `docs/containment.md` 的第二域闸而非模型工具面。

## 复核方式

`host/tests/channel.test.js`（协议行为）+ `pi/tests/channel-facade.test.js`（真 session facade 接线）；协议形状以本文表格为冻结依据。
