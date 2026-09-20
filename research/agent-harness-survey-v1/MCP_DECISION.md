# MCP 客户端接入评估（FEATURE_AUDIT G10 待决项）

> 目的：在实现前裁定 MCP 是否进入 Personal AI 产品边界、以什么形态、带什么治理约束。
> 证据基线：26 家 harness 功能审计（`FEATURE_AUDIT.md`）+ 我方受管扩展机制现状。

## 1. 业界事实面（审计证据）

| harness | MCP 形态 | 关键治理细节 |
|---|---|---|
| Cline | 官方 SDK，stdio/SSE/streamableHTTP | 每 server 连接预算 ~6s；OAuth 本地回调；per-tool `{enabled, autoApprove}` 策略表；MCP OAuth token 独立管理 |
| OpenCode | stdio+streamableHTTP+SSE | **每工具调用 `ctx.ask({permission})`**；资源工具 `mcp:<server>:*` 通配 + 10MB blob 上限；**sampling 和 elicitation 显式禁用**（带 issue 链接）；失败 server → disabled 状态；MCP prompts → slash 命令 |
| Claude Code | `.mcp.json` 一等公民 | WaitForMcpServers 门；Elicitation 钩子事件嵌套执行；**plugin 子代理被剥夺 `mcpServers` 字段（安全裁决）** |
| Codex CLI | 一等 MCP crate | 工具经同一 registry 可 Deferred 装载（"tool search" 不炸工具面）；批准/沙箱/网络是 per-tool-call 输入 |
| Roo/Kimi/Qwen/Trae/Kiro/ZCode/Cursor/WorkBuddy/CodeArts/Hermes | 各有客户端 | 多数配 per-server enable + 批准走自家批准面 |

**共性结论**：15+/26 家有 MCP；成熟实现都做三件事——(a) 工具进统一注册表面而非旁路，(b) 每调用过批准/权限面，(c) server 端能力裁剪（禁用 sampling/elicitation）。

## 2. 我方边界约束

- **Pi 上游刻意拒绝 MCP**（设计立场，非技术不可行）。
- 我方治理格：一切工具调用必须走 `tool_call → composite guard → kernel decide → policy/ask → audit`。MCP 工具**若注册为正式工具**则天然继承全链——这是兼容点。
- **结构性漏洞**：MCP server 是独立进程/服务，其内部副作用（文件写、网络出站）在我方 write-lease/fileops/分类器**视野之外**。格只能门"调用"这个动作，门不到 server 内部行为。→ 结论：MCP 调用的默认档位只能是 **ask**（每次调用操作员可见+可拒），配 per-server 开关。
- **managed-manifest 装载面已就绪**：`resolveManagedExtensions` sha256 校验+`noExtensions:true` 零发现——"扩展即 MCP 客户端"路径完全在现有 TCB 准入门内。
- **sampling = 我方预算格的明确禁区**：server 发起的 LLM 调用绕过 budget fetch 门 → 必须禁用（opencode 同款先例）。

## 3. 候选形态

| 方案 | 内容 | 评估 |
|---|---|---|
| A 拒绝 | 维持 Pi 立场 | 放弃生态接入；审计中最大单块缺面不收敛 |
| **B managed 扩展即客户端**（推荐） | 写一个 `mcp-bridge` managed extension：加载时读 `mcp.json`（实例级，非仓内），连 stdio/HTTP server，把远端工具注册为 `mcp__<server>__<tool>` custom tools | 准入=manifest sha256 pin；调用=全治理链；边界外副作用=默认 ask 覆盖；不动 host/，Pi 无 MCP 的立场不动（扩展是 app 侧选择） |
| C host 内建客户端 | host core 写 MCP client | 破坏 host 中立性最小收益；动态工具面需要 pi 运行时装载支持，耦合更深 |
| D DSH-only | 借 dsh `mcp_native: supported` | DSH 无会话通道（U1 核实）——等于把 MCP 面永久外包给另一个产品，用户在我们 app 里仍没有 |

## 4. 推荐方案 B 的治理子集（v1 硬约束）

1. **传输**：stdio + streamableHTTP；不接 legacy SSE。
2. **禁用**：sampling、elicitation（opencode 先例 + 预算格硬性要求）。
3. **权限**：kernel `tools` 规则需支持通配 `mcp__*` → 默认 `ask`；server 配置存 `<instance>/mcp.json`（运行态，不入仓）。
4. **不可信封套**：所有 MCP 工具描述与结果按 U2 规则包 `<untrusted>` 标记——server 的 tool description 是注入面。
5. **连接治理**：每 server 连接预算（~6s 超时）+ 失败 → disabled + 审计事件；启动阻塞门（WaitForMcpServers 同型，可关）。
6. **OAuth**：v1 不做；HTTP server 仅 `PAI_MCP_*` env 引用的静态 bearer。
7. **资源/prompts**：v1 只接 tools；resources/prompts 二期。

## 5. 工作量与依赖

- 依赖：pi 可新增 `@modelcontextprotocol/sdk` 依赖（官方 SDK，pin 版本；lockfile 入 runtime identity）。
- 形态：`pi/extensions/mcp-bridge/` 扩展文件 + managed-manifest 登记 sha256；扩展内部 SDK client → 注册 custom tools。
- 预估：扩展本体 + kernel 通配规则 + 测试 = 中件；**难点不在协议而在治理装配**（ask 默认档+标记纪律+server 生命周期清扫）。

## 6. 裁定项（等用户）

- [ ] 接入与否：B（managed 扩展形态）/A（拒绝）/D（DSH-only）
- [ ] 若 B：v1 是否只 stdio（本机 server）——HTTP+远端二期
- [ ] `mcp.json` 配置面：实例级文件 / UI 编辑面 / 都留二期

## 7. v1 落地记录（已实现）

外部终裁批准方案 B。实际形态与第 5 节有两处有意的偏差：

- **零依赖客户端，不引 `@modelcontextprotocol/sdk`**：MCP 协议本体只是 JSON-RPC 2.0 + 两种传输（stdio NDJSON / Streamable HTTP POST），手写客户端 ~300 行且不留依赖面——与本仓 host/pi 零依赖立场一致。`pi/extensions/mcp/index.js` 单文件承载（客户端类 + 工厂），managed-manifest sha256 准入。
- **配置面取 `<cwd>/.pai/mcp.json` → `.mcp.json`（Claude Code/Cursor 惯例）→ `$PAI_MCP_CONFIG` 覆盖**：cwd 相对配置让 server 跟项目走（生态惯例），env 变量覆盖承担实例级指向。

已落地的治理子集（对照第 4 节）：

| 硬约束 | 状态 |
|---|---|
| stdio + streamableHTTP，不接 legacy SSE | ✅（HTTP 应答支持 JSON 与 SSE 帧，server→client GET SSE v1 不支持） |
| sampling/elicitation 禁用 | ✅（capabilities 广告为空 {}） |
| `mcp__*` 通配规则 → 默认 ask | ✅（kernel `#toolRules` 支持 `*` 后缀最长前缀匹配；DEFAULT_POLICY 预置 `mcp__*: ask`；存量 canonical 由 ensureInstance 只做"补缺键"式并合，不动操作员已设规则） |
| 不可信封套 | ✅（text 结果包 `<untrusted mcp_server mcp_tool>`，截断 24k） |
| 连接预算/失败隐藏 | ✅（connect 15s，tools/call 120s+AbortSignal→notifications/cancelled；失败 server 零工具暴露，`/mcp` 命令可见状态） |
| OAuth | 未做（spec.headers 静态值，env 引用由配置者自行负责） |
| resources/prompts | 未做（只接 tools） |

额外治理：`mcp__` 前缀在 decide 链按 mutating-capable 对待——持 workspace 写租约（外部副作用串行化）+ plan 模式自动升级为 ask。测试 `pi/tests/mcp-ext.test.js` 6/6：stdio 往返/abort 取消帧/HTTP JSON+SSE+session-id 回显/扩展注册+untrusted 包裹+失败隐藏/kernel 前缀规则/lease 互斥。
