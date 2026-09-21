# chatgpt-web-bridge（vendored）

这个包通过专用 Chrome profile 和 CDP 驱动已登录的 ChatGPT Web，对外提供：

- OpenAI 兼容 REST（默认 `:8080`）；
- MCP stdio（单个 agent 会话使用）；
- MCP SSE（共享 daemon 使用，默认 `:8090`）。

网页端只接收和返回文本，永远没有本地 shell、文件系统或项目执行权限。四种使用模式、Project/会话绑定和证据纪律见 [`skills/chatgpt-web-bridge/SKILL.md`](../../skills/chatgpt-web-bridge/SKILL.md)。

上游基线：<https://github.com/Octo-Lex/ChatGPT-Web2API>（本仓库记录的 vendored commit 为 `497527d`）。本地差异见 [VENDORED.md](./VENDORED.md)；正在运行的实例是否加载了当前源码，以运行时元数据和实际进程为准。

## 安装和选择通道（Windows）

维护或升级后的分层验收、实际浏览器不发送检查和 MCP stdio 检查见
[ACCEPTANCE.md](./ACCEPTANCE.md)。新进程验收不能代替已有宿主连接的版本核验。

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

### stdio：随 agent 会话启动

推荐 MCP 客户端配置：

```json
"chatgpt-web": {
  "command": "<venv>\\Scripts\\chatgpt-web2api-mcp.exe"
}
```

stdio 进程由 MCP 客户端启动、回收和重连。首次调用可能启动 Chrome；只需在专用 profile 中登录一次。stdio 出现断线时，重新建立 MCP 连接并重新读取运行时状态；不要为 stdio 实例运行 `start.ps1`、寻找共享 daemon 或重启一个并不存在的后台服务。

### SSE：多个客户端共享 daemon

```powershell
.\start.ps1
```

然后注册：

```json
{"type":"sse","url":"http://127.0.0.1:8090/sse"}
```

SSE daemon 共享 Chrome、限流器和会话池。用 `start.ps1` 或 `chatgpt-web2api ensure` 管理它；是否需要重启要依据健康检查和运行时元数据（例如 `restart_required`），不要因为一次调用慢就盲目重启。Chrome 与 daemon 的生命周期可以不同，重启 daemon 不等于重新登录。

两种通道都需要已登录的 ChatGPT Web。`W2A_VENV` 可指向仓库外的虚拟环境；凭据和 profile 不应写入发布仓。

## 调用结果和恢复

当前构建提供只读 `runtime_info`，不占用浏览器 slot；它返回启动/磁盘 source fingerprint、`started_at`、capabilities 和 `restart_required`。若 `list_tools` 中没有它，当前连接仍是旧实例，不能据源码推断修复已经生效。

调用返回的内容优先于后续核查。处理顺序如下：

1. 先消费结构化结果、内联内容、`conversation_id`、状态、delivery receipt 和客户端暴露的 `out_file`/overflow 指针；指向文件的结果只读取一次。
2. 收据明确表示已投递时，保存收据并继续处理该结果，不重复发送或立即读取整段历史。提交收据或 `reply_persisted=true` 证明提交/assistant 节点存在，不单独证明回合已经终态完成；tail 仍是 `in_progress` 时只读等待。
3. 超时、取消、断线或 transport error 只说明客户端没有拿到完整结果；它们不是“未发送”的证明。恢复前先让当前调用结束，再用同一 `conversation_id` 做一次有目的的状态/tail 读取。
4. `wait_reply` 或 tail 读报告 `in_progress`/`generating` 时，网页端仍在工作，只读等待即可；不要发送“继续”或其他催促。桥侧读超时也不改变这一点。
5. 只有桥明确报告终态失败、且没有进行中的生成时，才考虑用户允许的同会话重试。尾部是 user、收据为 false/null 或结果为空，单独都不足以证明可以重发。

长历史使用 backend `get_conversation` 的分页，或传绝对路径 `out_file`，并消费 `total`、`has_more`、`messages_written`、`reason` 和 `partial` 等字段。`partial=true`/`paging_supported=false` 是渲染 tab 的局部 tail，没有绝对 offset/total/has_more；不要继续递增 offset 把它当分页。DOM 的 `total` 只是渲染下界。`empty`、`not_found` 与 `fetch_failed` 的含义不同；不要把它们都转成“会话没了”。

等待时的进度要报告可观测事实：阶段、已等待秒数、来源、状态、最后角色和 retry 时间。不要用“没卡住”“正常慢”这类解释性文案，也不要把固定分钟数写成所有请求都适用的系统契约。

## 本地差异摘要

- conversation affinity：显式 `conversation_id` 绑定对应 tab；读项目/列表等 utility 操作不应擅自导航聊天 tab。
- 后台 CDP target：自动化 tab 尽量不抢前台焦点。
- 跨进程 pace 和读合并：发送、读取和限流按实例/账号策略协调；按工具返回的 `retry_after` 行动，不自行猛轮询。
- Project 名称解析：未知或歧义名称失败，避免消息落到错误 Project。
- 长文本和部分读：支持分页、`tail`、`fresh=true`、`out_file`，以及由工具明确标记来源和 `partial` 的安全局部结果；partial 结果不能伪装成完整分页。
- 模型选择：以当前 `list_models` 与运行时能力为准；不可用或选择失败应报告失败，不能把回退模型伪装成请求模型。

## 排障速查

| 现象 | 处理 |
| --- | --- |
| 调用有返回值、文件路径或溢出标记 | 先读取/保存返回内容；不要再发同一消息确认 |
| 调用超时、被取消或断线 | 视为状态未知；不要自动重发。恢复连接后，用原会话和一次 tail/收据核对 |
| `wait_reply` 返回 `in_progress`/`generating` | 保持只读等待；绝不发送催促 |
| 读结果 `empty` | 查看 `reason`、来源和时间；可能是可达但暂时没有可见内容 |
| 读路径被限流 | 遵守 `retry_after`，不要用重复读绕过 pace；保留原始错误 |
| stdio 连接丢失 | 重新建立 stdio MCP 连接；不运行 daemon 重启脚本 |
| SSE/REST daemon 不可用 | 调用 `runtime_info`（若 `list_tools` 不显示则为旧实例），查看 health 和 `restart_required`，再选择 `ensure`/`start.ps1` |
| composer 校验失败 | 保留错误和会话 ID，避免堆叠重发；只使用桥当前公开的发送/清理路径或由用户在网页端处理草稿 |

## 安全边界

只读工具不应触发发送、创建会话、写 Memory 或删除。删除会话、Project、Memory 等动作由服务端权限门控制，并且仍需要用户明确意图。发送本地材料前检查目标 Project、敏感字段和最小必要范围；网页端结论必须保留来源，不能替代本地文件和命令证据。

相关运行时文档：[guide.md](./src/chatgpt_web2api/guide.md)。

License: MIT（见 [LICENSE](./LICENSE)）。

## 本次恢复与读取补充

长页默认自动导出完整 UTF-8 Markdown，返回 `out_file`、`file_bytes`、`file_sha256`。
按行或字符切片读文件至末尾；`max_inline_bytes=0` 保留程序化完整 JSON。
DOM 部分结果继续保留 `partial` 和不可分页标记。SSE 读取不依赖 REST 是否运行。

发送使用稳定 `operation_id`（REST 也接受 `Idempotency-Key`）。中断后先查
`get_send_status`，仅 `not_sent` 允许原 ID 重试；未知或已提交状态不重发。
记录持久化到运行目录的 SQLite，不存消息正文。只读回执查询不要求 Chrome 在线。

同一 daemon、session、目标且未被接管/释放时，空闲和 CDP driver 回收不撤销绑定确认；
30 分钟仅用于其他发送方的占用提示。`send_seq=0` 和 `WinError 10054` 不能证明身份变化，
应核对前后 `session_key`。新连接仍需重新绑定；已有明确、有效且覆盖同一目标的用户授权可继续使用。

Windows daemon 通过原生 WMI 进程代理隐藏启动，脱离调用任务及其 Job；环境变量通过 stdin
传递给启动助手。创建失败明确报错，不退回任务所属进程。恢复只停止可执行文件、命令行、
创建时间和监听归属均核验的故障进程；venv launcher 与子进程同名属正常。
新页导航在 URL、文档、应用、输入框就绪后才继续；权限拒绝和限流不通过反复刷新规避。
