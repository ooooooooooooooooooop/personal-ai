# chatgpt-web-bridge（vendored）

Long conversation pages are exported automatically as complete UTF-8 Markdown.
The MCP result contains out_file, file_bytes and file_sha256; read that file in
bounded chunks. Use offset plus limit=1 to export a single message, or specify
out_file explicitly. max_inline_bytes=0 preserves unlimited inline JSON for
programmatic clients. A partial DOM fallback remains marked partial even when
exported. REST is not required for reads through an already healthy MCP server.

On Windows, ensure starts hidden daemons through the native WMI process broker,
including a breakaway request for the provider's own job. Their parent is independent
of the tool task, including hosts with nested jobs that cannot be escaped directly.
The caller's environment is transferred over stdin, not exposed in command arguments.
Broker failure is reported without falling back to a task-owned background process.


ChatGPT 网页版桥：用专用 Chrome profile + CDP 驱动已登录的 ChatGPT Web，
对外暴露 OpenAI 兼容 REST（`:8080`）与 MCP SSE（`:8090`）双通道。
网页端只有文本——永远不拿本地工具。

- 上游：<https://github.com/Octo-Lex/ChatGPT-Web2API> @ `497527d`（MIT）
- 本机补丁与差异说明：[VENDORED.md](./VENDORED.md)
- 使用协议（四种模式/会话定位/纪律）：[`skills/chatgpt-web-bridge`](../../skills/chatgpt-web-bridge/SKILL.md)

## 安装与启动（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1   # venv + pip install -e . + 推荐 config
```

MCP 注册——**推荐 stdio**（harness 会话生灭绑定，不用时零后台进程；首个工具调用
自动拉起 Chrome，冷启动选举锁防重复拉起）：

```json
"chatgpt-web": { "command": "<venv>/Scripts/chatgpt-web2api-mcp.exe" }
```

共享 daemon 备选：`.\start.ps1`（Chrome + REST:8080 + SSE:8090），注册
`{"type":"sse","url":"http://127.0.0.1:8090/sse"}`。任一模式首次使用前在弹出的
Chrome 里登录 ChatGPT 一次（profile 持久）。

## 本补丁层要点

- conv-affinity：一会话一 tab，`/c/{id}` tab 跨进程收养，不导航不关闭
- `Target.createTarget` 全部 `background:true`——不抢前台焦点
- `request_pace.py`：账号级跨进程节流（send≥30s / read≥8s / 429→冷却300s）。
  冷却分级：发送路径限流弹窗 → `cooldown_until`（读写全停）；读路径
  `/backend-api/conversation*` 的 429 → `read_cooldown_until`（只停读——
  上游该限流器是端点级的，发送不受影响）
- 会话读去重：`wait_reply`/`get_conversation` 的轮询按读间隔合并
  （in-flight join + TTL=read_interval 缓存），核查类读绕过缓存取真值
- `resolve_project_id`：project_id 可传项目名，未知/歧义直接报错
- 上游修复：临时路由误采、zh 占位文本过早完成判定
- composer 多行插入：会话页 `Input.insertText` 遇 `\n` 只落首段（2026-09-14
  ChatGPT 前端更新后实证），改用 `execCommand('insertText')` 走编辑器自身的
  插入路径

排障速查：
- `Composer text verification failed`：插入文本与读回不一致——多为换行截断
  或会话残留的未发送草稿；发送失败后桥会自动清 composer 草稿（2026-09-15
  起），仍见此错先 `get_conversation` 核实尾部再重发
- `wait_reply` 只在 tail assistant 终态（非 `in_progress`）报 `replied`；
  timeout 看 `tail_status`——`in_progress` = 网页端还在生成，再 wait 别催促
- `no driver slot available` / health `degraded` + `driver_connected:false`：
  重跑 `start.ps1`，内部通过 `ensure` 检查 REST 和真实 MCP 握手。恢复只终止
  身份核验通过的故障监听进程；venv launcher/子进程同名属正常现象，禁止据此清理。
  `healthy + ready:true + usage_state:unused` 表示连接正常但未使用；健康范围是传输层，
  不代表网页一定加载成功。锁文件存在不表示 OS 锁仍被持有，不按文件名删除锁
- Windows 的会话归属、生成标记及 tab 登记共用只读的 Win32 存活查询；
  禁用 `os.kill(pid, 0)` 作为 Windows 存活探针，避免发送控制事件或终止进程。
- 所有调用一起变慢/挂住：先看 `~/.chatgpt-web2api/request_pace.json`——
  `cooldown_until` 未过期 = 账号级冷却（读写都等）；`read_cooldown_until`
  未过期 = 只读端点被限（读等、发送不受影响）。谁触发的看 daemon 日志
  `~/.chatgpt-web2api/diagnostics/mcp-sse-8090.log`（REST 在
  `rest-8080.log`）里的 `account/read-path throttle recorded (source=…)`；
  `lease released … held=` 给出每次调用占槽时长

## 中断后的发送恢复

MCP `chat_completion` / `chat_with_gpt` 可带稳定的 `operation_id`；REST
`POST /v1/chat/completions` 可用同名字段或 `Idempotency-Key` 请求头。每个逻辑发送
使用一个 ID，确认、超时和重连重试沿用该 ID；下一条有意发送才使用新 ID。

记录存于运行目录 `~/.chatgpt-web2api/send_receipts.sqlite3`，不保存正文或凭据。
点击前先持久化；取消只结束观察，不撤销网页提交。重复调用返回已有发送状态，
不重发。同一 ID 换正文或目标返回冲突；未带 ID 的旧客户端也不能自动重发相同的
未决请求。流式 REST 在响应头 `X-Operation-ID` 提供 ID，非流式响应附 `send_receipt`。

- `get_send_status(operation_id=...)` 或 `GET /v1/send-status?operation_id=...`
  只读本地记录，Chrome 不在线也能查询；省略 ID 返回最近记录。
- 加 `refresh:true`（REST 为 `refresh=true`）按已记录的会话和消息 UUID 核对网页持久化。
- `not_sent` 才能原 ID 重试；`delivery_unknown` / `dispatched` 表示结果未确认，
  `delivered` 表示用户消息已落盘，`completed` 表示该消息的终态回复已落盘。
  `reply_received` 是本地收到回复，仍需核对持久化。`not_found` 不证明未发送。

新建聊天只在目标 URL、文档、应用和输入框均就绪后继续；仅对无草稿、无生成的
“重试”错误页进行一次恢复。错误附失败阶段及脱敏网络状态；明确 challenge/401/
403/429 不循环刷新，不因此重启健康服务。

License: MIT（见 `LICENSE`）。
