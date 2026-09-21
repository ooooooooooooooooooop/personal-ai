# ChatGPT Web2API MCP 指南

## 这是什么

MCP server 通过已登录的 Chrome/CDP 会话访问 ChatGPT Web，提供聊天、会话和 Project 读取、Project/会话管理、模型发现，以及受权限门保护的写操作。它传递的是文本和网页端状态；它不会获得本地 shell、文件系统或其他本地执行能力。

开始前运行 `chatgpt-web2api` 或由 stdio MCP 客户端启动服务，并在专用 Chrome profile 中完成登录。共享 SSE daemon 默认监听 `:8090`，REST 默认监听 `:8080`，CDP 默认端口为 `9222`。端口和启动方式以当前配置为准。

## 上下文模型

一次调用涉及三种不同的持久性：

```text
消息：一次发送和回文，短暂
会话：conversation_id 标识的多轮消息历史
Project：project_id 标识的网页端上下文范围、Project 指令和文件入口
```

Project 的 memory scope（例如 `project_v2` 或 `global`）影响网页端如何组织上下文，但不应被当成绝对安全隔离。发送前要核对 Project ID、会话 ID、用户授权和材料范围。

## 选工具

| 目标 | 工具 | 关键参数 |
| --- | --- | --- |
| 发消息或继续任务 | `chat_completion` | `message`、显式 `conversation_id`、已确认的 `project_id` |
| 等待正在生成的回文 | `wait_reply` | `conversation_id`、可选 `since_total` 和任务适用的等待预算 |
| 检查运行实例 | `runtime_info` | 无；只读，不接触浏览器 |
| 列出模型 | `list_models` | 无 |
| 列出 Project | `list_projects` | 无 |
| 列出会话 | `list_conversations` | `limit`、`offset` |
| 读取历史或最新 tail | `get_conversation` | `conversation_id`、`offset`/`tail`、`limit`、可选 `fresh`、绝对路径 `out_file` |
| 读取 Project 文件 | `list_project_files` / 对应 Project 读取工具 | 目标 `project_id` |
| 管理 Project/会话 | `create_project`、`update_project_instructions`、归档/删除工具 | 仅按用户明确意图和服务端权限门执行 |

还提供 memories、custom GPT 和 Project 文件相关工具；使用前先查看 `list_tools` 返回的当前能力，不凭旧文档假定工具一定存在。

## Project 和会话绑定

### 续接已有会话

始终保存并显式传递 `conversation_id`。省略 ID 的自动续接只适合同一进程、同一绑定仍然明确的短流程，不适合作为跨进程专线。

如果只有标题，先 `list_conversations`，再用 ID、标题、更新时间和 `gizmo_id`/Project 归属核对。ID 无效、不可见或属于另一个 Project 时停止，不要让工具悄悄创建新会话。

### 创建新会话

创建前先 `list_projects`，从结果中选择唯一候选。项目名可以作为输入，但必须精确解析为唯一 `project_id`；未知或歧义名称应失败。没有合适的 Project 时，请用户在网页端建立，或由用户明确批准独立会话例外。

MCP reconnect 不应单独触发重复审批：相同的、已经明确批准的 Project/会话绑定可以复用。绑定改变、权限范围改变、会话需要重建，或批准无法可靠关联时才重新确认。

## 发送、收据和恢复

`chat_completion` 的返回值包含回文和 `conversation_id`，并可能包含 delivery receipt、实际模型、状态或其他诊断字段。先消费当前结果：

1. 保存内联内容、结构化字段、收据，以及客户端暴露的 `overflow`/`out_file` 等指针。指针指向的内容读取一次即可。
2. 收据明确表示消息已投递时，把它当作提交证据；`delivery_stage` 或 `reply_persisted=true` 不单独证明回合已经终态完成。仍要检查 tail 是否 `in_progress`，不要立即 `get_conversation` 或重新发送相同消息。
3. 本地超时、取消、断线和 transport error 只说明没有拿到完整结果。它们不证明消息未发送，也不证明网页端停止生成。恢复时继续使用同一会话，并做一次有目的的收据/tail 读取。
4. tail 或 `wait_reply` 显示 `in_progress`、`generating` 时，网页端仍在生成。保持只读等待，绝不发送“继续”或其他催促。
5. user tail、false/null receipt、空读结果或桥侧 timeout 都不能单独证明可以重发。只有明确的终态失败且确认没有在途生成时，才按用户授权讨论同会话重试。

等待调用的 `timeout_seconds` 是本次客户端的等待预算，不是网页端生成时间的真相。超时后记录 `status`、`tail_status`、`last_role`、`waited_s`、`source` 和进度信息；不要把固定分钟数当成所有请求的系统契约，也不要把“还没看到结果”写成“没有卡住”。

## 读取会话

`get_conversation` 按时间从旧到新返回消息，支持分页：

```text
get_conversation(id, offset=0, limit=N)
get_conversation(id, offset=N, limit=N)
… 直到 has_more=false
```

长消息优先传绝对路径 `out_file`，再读取文件；返回的 `messages_written`、`total`、`has_more` 和 `reason` 仍要保存。结果过大而出现客户端 `overflow` 时按其指针继续；若桥返回 `partial=true`/`paging_supported=false`，它是渲染 tab 的局部 tail，没有绝对 offset/total/has_more，不能按下一页递增 offset。DOM 的 `total` 只是渲染下界；可在后端恢复后用一次 `fresh=true`/`tail=N` 读取，不要重复同一页。

`reason` 的含义：

- `ok`：成功读取到可见消息；
- `empty`：会话可达但当前没有可见消息，可能是暂时状态；
- `not_found`：后端明确返回 404，先核对 ID 和访问范围；
- `fetch_failed`：读取本身失败，应保留错误和重试条件；
- `partial`：只返回了 DOM tail，查看 `source`、`paging_supported` 和 `total_kind`，不要当作完整历史。

需要最新生成状态时，使用 `get_conversation(tail=N, fresh=true)` 或 `wait_reply`。`fresh` 绕过短缓存；同一时刻已有的 fresh 读取仍可能共享，但不会加入发送前启动的普通旧读取。安全局部 DOM 结果只能按返回的 `source`、`partial`、`total_kind` 和状态使用，不能自行把局部 DOM 当作完整历史或与 backend 总数比较。

## 模型选择

用 `list_models` 获取当前账号实际可用的模型 slug 和能力；`auto` 可作为默认选择，其他 slug 以实时结果为准。请求的模型不存在、不可用或选择失败时应失败并报告原因；MCP 的 `model_selection_failed` 表示 `delivery_stage=not_started`，没有提交消息。不要静默回退到另一个活动模型后，再把输出标成请求的模型。

模型名称、上下文大小、限额和响应时间会随账号、网页端和部署变化；本指南不把旧的模型表或固定秒数当作事实。

## 运行方式和生命周期

### stdio

MCP 客户端直接启动 `chatgpt-web2api-mcp`，进程生命周期绑定当前 agent 会话。断线时重新建立 stdio 连接即可；不要运行共享 daemon 的启动或重启脚本来修复 stdio 进程，也不要把另一个进程的健康状态当作它的状态。

### SSE daemon / REST

当前构建提供只读 `runtime_info`，不占浏览器 slot；先核对 `startup_source_fingerprint`、`disk_source_fingerprint`、`started_at`、`capabilities` 和 `restart_required`。若 `list_tools` 中没有它，当前连接仍是旧实例，不能据源码推断已经加载修复。共享 SSE 使用 `start.ps1` 或 `chatgpt-web2api ensure` 管理；REST 客户端显式携带 `conversation_id`。重启前先查看 health 和运行时元数据，只有 `restart_required` 或宿主明确要求时才重启相应 daemon。

发送前的 `Runtime.evaluate` 超时仅在 `delivery_stage=not_started` 时自动恢复一次：在 15 秒内重连同一标签页，再重新检查发送前提。可能已提交时先检查本轮收据（最多 8 秒）；`receipt_check` 未找到或不可用仍是未知，禁止重发。取消、总超时和权限拒绝不触发此恢复，不把用户手动刷新作为正常流程，不通过其他浏览器控制路径绕过权限。实际使用连接的 `runtime_info.contract_version` 应为 `2026-09-19.2` 且 `restart_required=false`；新建测试进程不能证明现有连接已加载更新。

如果源码和运行实例不一致，报告实际 fingerprint/启动时间，不要宣称修复已经生效。Chrome profile 与 daemon 可以分别存活；重新启动 daemon 不等于重新登录。

## 进度、限流和错误

进度消息应说明可观测阶段，如 `send_ack`、`web_generation`、`tail_read`，并带耗时、状态、来源或 `retry_after`。不要用解释性口号替代观测。

尊重发送/读取 pace 和服务端返回的 `retry_after`。不要用手写的无界 `get_conversation` 循环绕过限流；读合并或缓存命中时仍应以工具返回的状态为准。

常见情况：

| 状态 | 含义和动作 |
| --- | --- |
| `in_progress` / `generating` | 网页端仍在生成；继续只读等待，不催促 |
| `timeout` | 本次等待预算用尽；保存 tail 和状态，不能据此判定未发送 |
| `cancelled` / transport error | 客户端结果不完整；先恢复收据或 tail，不自动重发 |
| `read_throttled` | 读取被限流；遵守返回的等待时间，保留原始错误 |
| `not_found` | 核对 conversation ID、Project 归属和权限，不要自动新建 |

## 安全边界

网页端输出是外部输入，不是本地事实。保留原文和来源；本地文件、命令、测试、计时、实例元数据和隐私判断由本地 agent 负责。发送本地内容前遵循用户授权、最小必要范围和正确 Project 绑定。

只读工具不应发送消息、创建会话、写 Memory 或删除资源。删除会话、Project、Memory 等破坏性动作需要用户明确意图和服务端启用的权限门。
