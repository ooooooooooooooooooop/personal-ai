# 二采 findings（逐条全检，novelty 降序推进）

## batch1 (items 0-431)
- [cand] disableAlwaysAllow 全局禁用 always-授权 的开关（cline?）— M146 有持久授权，缺"管理员级总开关"
- [cand] disabledTools 全局禁用原生工具的配置面 — 我方有 modes/lazy，无全局禁用清单
- [cand] onboarding 新用户检测→引导（原审计已知缺口，多源再证）
- [verify] FolderTrustDialog 启动信任弹窗 — M85 workspace trust 已裁状态待核
- [verify] gptme GPTME_PATCH_RECOVERY patch 不匹配恢复 — 我方 edit reflection 回路疑似已覆盖
- [dir] gptme eval behavioral scenario suites ×10+ — 行为评测套件方向（vs 我方 skill 质量门不同面）
- [boundary] read_file audio/video、git askpass 签名、locales、zed/vscode 编辑器特性 — 形态外
- [cand] multi-root workspaces / add-dir 递归（#244 multi-root, #101 /read-only 递归）— M88 已裁?

## batch2 (items 432-716)
- [cand] planner/worker 分模型（GOOSE_PLANNER_MODEL）— M56 族延伸：role 级模型指派（注意外来 modelroutes.js 在途）
- [cand] mcp-config disabled_tools 清单（gptme）— 与 C3 profile 限定同族，per-server 工具禁用面
- [dir] behavioral eval scenario suite（gptme 33+ scenarios）— agent 行为评测套件，非 skill 质量门
- [boundary] zed/vscode 编辑器族（vim/textobject/keymap/language support/formatter/LSP 细节）——非 agent 面
- [verify] EnterWorktree worktree 隔离反复出现 — M-list 裁定?（审计表 ❌"无 worktree 隔离"）

## batch3 (items ~1008-1564)
- [verify] #1499 corrupted permission.yaml panic-vs-allow — 我方 policy/permission 文件损坏时 fail-open 还是 fail-closed？查 decide/policy 加载路径
- [verify] #1383 /config /debug sender ownership — 我方 M132 config_set 是否校验发送者（channel 入站非 owner 可改设置？）
- [cand] #1513 hooks.enabled 总开关设置 — 我方 hooks.js 有无全局开关
- [cand] #1112 bash auto-background threshold 可配置 — shell 超时转后台阈值
- [cand] #1090 hooks tool-call attribution manifest-dir — hook 归因到扩展包
- [dir] #1345 subprocess env 继承（LD_LIBRARY_PATH）— M121 env 注入族佐证
- [cand] #1292 constrained requirement values 带 source provenance — config 值来源溯源（谁设的这个值）
- [verify] #1044 per-DM history limit — channel 历史深度配置
- [boundary] i18n/LSP/vim/debugger/theme/font/terminal 细节族持续大体积出现 — 非 agent 面
- [noise] model 添加/provider 接入族极高频 — 全是上游目录更新

## batch4 (items ~1565-1864)
- [verify] #1663 PowerShell 不可解析 AST 区→强制批准 — 我方 shell 分析对 cmd/ps 未解析命令是否 fail-closed（我们是 Windows 宿主）
- [cand] #1562 --subagent-permission-mode — 子代理权限档（C3 族延伸）
- [cand] #1779 multi-agent spawn model override — delegate_task 是否支持 per-spawn 模型覆盖
- [cand] #1701 continue_loop_on_deny — 拒绝后继续循环策略
- [cand] #1435 MCP reconnect 命令+自动重连 — M130 已做热刷新，断线重连待查
- [cand] #1610 js_repl 晋升 /experimental+启动兼容检查 — M114 佐证（业界也在做）
- [cand] #1046 task favorite 免 clear-all — 小 UI
- [dir] #1833 constrained decoding — provider 层结构化输出
- [verify] #1299 cron announce 去重 guard — 我方 scheduler 通知重复投递?
- [noise] model/provider/LSP/vim/terminal/markdown preview 族仍占绝对大头

## batch5 (items ~1865-2124)
- [verify] #2022 中文本地化 context-overflow 错误识别 — 我方 overflow 检测是否只吃英文 pattern（GLM/DeepSeek 中文报错会漏）
- [cand] #2111 token-budget 文件读取+智能预览 — file_read 大小预算（M140 族）
- [cand] #1985 凭据形 token 渲染成不可复制 — 防误复制密钥 UX（M116 族延伸）
- [dir] #2068 memory promotion shadow-trial（不落地先评估）— M136 advisory 语义业界佐证
- [cand] #2094 平台级 tool descriptor planner — 工具可用性 introspection 面
- [cand] #1927 per-environment shell 变量策略 — M121 env 注入族
- [verify] #2040 进程树 reap POSIX+Windows — 我方 Windows 下孤儿进程回收
- [boundary] forbiddenPaths/云 sandbox/容器族 — 无 OS 沙箱边界裁定维持

## batch6 (items ~2125-2401)
- [verify] #2397 hook 注入内容包 XML 隔离标签 — 我方 hooks.js 注入的上下文是否标 untrusted 边界（M147 已扫 tool_result；hook 注入是另一条注入缝）
- [verify] #2291 auth.json 写入覆盖管理员 ACL — 我方 writeJsonAtomic 是否保留原文件权限
- [cand] #2290 per-sender group tool policies — channel 按发送者工具策略
- [cand] #2215 图片压缩拦截器 2000px 长边 — M137 族（PARTIAL 已有记录）
- [verify] #2377 MCP 孤儿子进程回收 — mcp-ext close() 已 SIGKILL，补查 boot 失败路径是否 leak
- [cand] #2375 optional MCP server 工具发现 grace period — 与 M130 pendingRefresh 同族
- [verify] #2050 cron env 占位符遮罩 secrets — scheduler 的 env 传递是否泄漏

## batch7 (items ~2402-2678)
- [verify] #2509 exec 检测前做 Unicode 兼容规范化+剥隐形码点 — **我方 decide/shell 分析是否先 NFKC+剥零宽？** 不剥则 `rm` 带零宽/全角字符绕过前缀匹配（A4 的检测面版本，高优先）
- [cand] #2380 compaction 分界符渲染进会话历史 — UI 显示压缩边界（小）
- [dir] #2580/#2111 token-budget 文件读取二次出现 — 文件读取预算成业界收敛模式
- [cand] #2210 tools.profile=messaging — 工具 profile 档（C3 族再佐证）
- [cand] #2135 插件 userConfig 交互式配置字段 — 扩展声明配置面
- [boundary] #2557 BM25+vector 混合检索 — 向量已拒（memory FTS 已有）
- [verify] #2491 auto-compaction 失败（quota）崩溃 — 我方压缩失败路径是否 fail-graceful

## batch8 (items ~2679-2977)
- [cand] #2856 auto-approved cost limits — 按成本上限自动批准（M142 budget 族的治理联动）
- [verify] #2781 config include 的 Windows ACL 审计 — 配置文件权限检查（Windows 下 ACL）
- [dir] #2861/#2215 图片压缩第三次出现 — M137 附件压缩是业界收敛项
- [cand] #2605 附件 reference-vs-upload 选项+持久化去重 — M139 附件持久化族
- [cand] #2499 agentToAgent maxPingPongTurns 上限可配 — delegate 轮数帽
- [verify] #2491 compaction 失败崩溃路径（quota 超限不白屏）

## batch9 (items ~2978-3237)
- [dir] #3172 LLM-judged hook（自然语言触发条件）— hooks 的语义化变体；我方 hooks 是字符串匹配，此为真方向差异（延迟换灵活性）
- [verify] #3164 权限规则重叠/冲突检测（repo-specific vs group prefix）— 我方 policy lattice 有无冲突检测
- [cand] #3136 图片规范化：auto-orient+canonical JPEG overview 返回源尺寸 — M137 的具体规格
- [cand] #3134 shellCommandPrefix — bash 前缀注入（alias 展开），M121 env 族
- [verify] #2590 SQLite WAL 在网盘上要避免 — 我方 session sqlite 落盘位置是否可能撞网盘（Windows 漫游目录）
- [verify] #2593 启动校验"至少一个 primary agent enabled" — 空配置防护
- [cand] #2715 opt-in tool-output pruning — 工具输出裁剪开关（outspool 族的开关面）

## batch10 (items ~3238-3516)
- [dir] #3290 `/learn` 用户发起 skill 创建 — M110 Skill Workshop 业界佐证（OpenCode 同方向）
- [cand] #3323 retrieval-only context_search（外部语料，不自动注入）— B5 的治理安全变体：检索-only 不 auto-recall
- [cand] #3399 命令面板使用历史持久化/frecency — M127 族
- [verify] #3391 UI error boundary 防白屏 — 我方零构建 UI 的渲染崩溃隔离
- [cand] #3395 symlinked skill 目录 — M111 族
- [cand] #3396 scan_symlinks 设置 — A1 族的扫描面佐证
- [verify] #3102 空名 tool call 在 dispatch 前拦截 — 畸形 tool_call 防护
- [dir] #3437 autocompact keep_head 保护任务上下文 — 我方压缩已保 goals/decisions
- [cand] #3289 /output-style 切换器 — 输出风格 mid-session 切换（M144 族）

## batch11 (items ~3517-3787)
- [verify] #3588 TOOL_CONFIRM hooks 跑在 MCP tool.execute 上 — 我方 hooks 对扩展/MCP 工具同样触发？（hooks.js 只挂内置工具则 MCP 是绕行道）
- [cand] #3589 MCP 调用 CircuitBreaker — M130 族的韧性补强
- [verify] #3749 配置快照脱敏误伤 maxTokens 字段 — 我方 secret 扫描白名单精度
- [cand] #3613 subagent model/reasoning/concurrency 配置 — delegate 参数面
- [dir] #3323 retrieval-only corpora（检索不自动注入）再佐证
- [cand] #3670 timer-based auto-approve follow-ups — ask 超时自动批准档（我方 PAI_ASK_TIMEOUT_MS 在途）
- [boundary] #3511 扩展更新加密完整性 — 我方 manifest sha256 已有装载校验

## batch12 (items ~3788-4060) — 信号率继续下降，n≤0.56 以噪声为主
- [verify] #3884 ML-based prompt injection 检测 — 我方 scanForInjection 是 regex 行锚定；ML 模型检测非本仓依赖方向，但记录业界趋势
- [dir] #3796 Jules Suggested Tasks 后台主动扫描仓库 — curator 族佐证（advisory）
- [cand] #3613 subagent model/reasoning/concurrency 配置面 — delegate_task 参数扩展候选
- [verify] #3806 提问回答恢复不重复走 steering — ask 应答幂等

## A1 取证收口 — REAL×3，已修（decide.js + governance.js）
- A1a 读侧：`outsideWorkdir` 纯 lexical → 改 realpath-aware（realWorkdir 缓存 + pathInsideRoot 实对实）— 哨兵：in-workdir symlink 触发 read_outside
- A1b 写侧零边界：FILE_MUTATION_TOOLS 曾完全无 workdir 检查 → 新增 write_outside 闸（同 read_outside 闩锁形态，无 operator 通道 fail-closed；multi_edit 逐 path 查）
- A1c shell writeTargets：`> ../out`/`> link/x`（link→.git）逃逸 → classifier 块内加①越界 ask②最深存在祖先 realpath 重查 GIT_INTERNAL_RE/INSTRUCTION_PATH_RES（regex 导出复用不复制）；设备槽（NUL//dev/null）豁免
- 附带修复：catch 吞 AbortError 会放行被中断的 ask → 重抛
- 哨兵：pi/tests/writeboundary.test.js 9/9；pi 全套 270+1skip / host 281 全绿
- #4279 bash 注入检测 → 已覆盖（tree-sitter 递归 $(...)subshell/管道/循环体）

## batch13 (items ~4322-4471, n0.54→0.53)
- [verify] #4366 throttling 误报 context-overflow → 不必要压缩：查我方 compact 触发的错误分类是否区分 rate-limit/5xx vs 真 context-overflow
- [verify] #4430 bash 输出转义序列剥离不全：查我方工具输出是否剥 ANSI/控制字符（app UI 渲染面注入向量）
- [dir] #4351 通道默认拒绝+CommandAuthorized：M112 webhook 落地时入站命令必须携带通道计算的授权位，默认拒绝

## batch14 (items ~4542-4650, n0.53→0.52 — 噪声带)
- [verify] #4585 反斜杠-换行 shell 续行绕过批准解析：tree-sitter-bash 应已把续行归并为一命令，补一条哨兵断言即核销

## batch15 (items ~4651-4766, n0.52→0.50 — 噪声带)
- [verify] #4682 浏览器点击驱动跳转后重跑 blocked-destination 检查：我方 browser 工具的 navigate 闸是否罩点击后的主框导航
- [verify] #4757 跨轮 memory 去重：已注入的 memory 后续轮不重复注入——查 M86 ambient context 是否有跨轮 dedup
- [cand] #4765 pre_compact 钩事件：压缩前注入上下文——hooks 事件面补一项即落地（低成本）
- [verify] #4697 单条坏记录杀死会话列表：我方 sessions list 对撕裂 jsonl 行的容错

## batch16 (items ~4767-4889, n0.50 — 噪声带)
- [cand] #4824 chat.messages.transform 钩族（发模型前变换消息）——hooks 事件面补 message_transform 事件（低成本，CC 兼容面）
- [verify] #4878 delegate 子进程是否继承沙箱/网络姿态（childEnforceable 只管工具面，沙箱继承未查）
- [verify] #4786 delegate task 文本含密钥时直发子进程 prompt——治理面是否该对 foreign target 的 task 文本跑 redactSecrets

## batch17 (items ~4890-5152, n0.50 — 噪声带)
- [verify] #5142 MCP 断连后工具调用重放：仅 idempotent 工具可重放——查我方 McpClient 断线时对 in-flight call 的处理（应为 fail-closed 不自动重放）

## CURSOR: 已审至 compact.txt ~8917/18405——续审从 8918 起
- [verify] #5422 localhost HTTP server Host 头校验（防 DNS rebinding）：我方 app server 是 loopback-only 但 DNS rebinding 可绕过同源——查 server 是否校验 Host

## batch18 (items ~5430-5981, n0.50 — 噪声带)
- [verify] #5936 stdio MCP 进程组清理：我方 client 关闭时是否杀整个进程组（子进程可能留有孙进程→孤儿风暴）
- [verify] #5955 MCP 非文本结果块（resource_link/audio/畸形图片）归一化防毒化会话——查我方 wrapUntrusted 对非 text content 的兜底

## batch19 (items ~5980-7173, n0.50→0.45 — 噪声带)
- [verify] #7088 克隆仓库 workspace 插件隐式自动加载执行代码：查我方 untrusted workdir 下 .pai/extensions/ 是否会被装载执行（hooks 已闸/mcp 已消毒/但 extension 目录呢）
- [verify] #7326 包装命令内嵌载荷：cmd /c / powershell -c / env FOO=x cmd 的 args 是否被 tree-sitter 分析看穿（OpenClaw 专修的同类洞）

## batch20 (items ~7174-9200, n0.45→0.40 — 噪声带)
- [verify] #9070 经 symlink 写穿：批准 edit a.txt 但 a.txt→b.txt（同 workdir）实际写 b.txt——我方 realpath 闸只验 containment 不拒透写，业界做法是拒写穿 symlink

## batch21 (items ~9200-14386, n0.40→0.25 — 长噪声带，逐条过完)
- [verify] shell 包装器内嵌载荷二次确认：cmd /c、powershell -c、env FOO=x cmd 的 args 是否被风险分析看穿（与 #7326 同族复核）
- [verify] 换行注入绕过命令校验（多源复发）：含 \n 的命令被拆成多行执行但只校验首行——我方 tree-sitter 解析应覆盖，补哨兵核销
- [verify] stdio MCP server 进程组级清理（重发项）：client close 只杀父进程留孙进程——与 #5936 合并核销
- [verify] MCP 非文本结果（resource_link/audio/二进制块）归一化——与 #5955 合并核销
- [cand] 克隆仓库下 workspace 插件目录隐式加载执行——与 #7088 合并核销
- [verify] sandbox 内命令触网出 allowlist 时向用户 surface（非静默失败/放行）——我方 egress 面的行为核对
- [verify] checkpoint restore 拒绝回卷"checkpoint 之后又有新提交"的 workspace（防静默丢提交）——我方 restore 前置校验核对
- [cand] PreToolUse hook 携带 tool_provenance（标识调用背后的 skill/MCP server）——hooks payload 增强，低成本
- [verify] auto-compaction state 被判 stale→每轮重复触发摘要调用——我方压缩状态版本校验核对
- [cand] cron 瞬时 rate-limit 后重试而非干等下一槽——M78/schedule 族补强
- [verify] 原子写贯穿 write/edit/凭据/memory/config/jsonl——我方 writeJsonAtomic 覆盖面盘点
- [verify] subagent 上下文压缩后无法 resume——我方 delegate 子会话压缩恢复路径
- [verify] plan/approval 状态中 "session"/"always" 选择对"既跑命令又写文件"的终端命令生效范围
- [verify] 后台会话不适用前台 exec 超时帽——我方后台任务超时语义核对
- [verify] 压缩后仍弹已批准的工具批准请求——批准态与 compaction 交互
- [verify] subagent 输出反注入扫描（专有规则）——我方 wrapUntrusted 是否罩 delegate 返回文本
- [verify] 会话模型/provider 隔离：切模型只影响当前 session 不污染全局配置
- [cand] hook 类型扩展：http（POST URL）/agent（复用 prompt 路径）/LLM-judged——hooks 事件面之外的 hook 形态扩展（与 #3172 合并）
- [verify] hook match 匹配模型实际调用的工具（含 edit/MCP 工具）——与 #3588 合并核销
- [verify] 退出 CLI 时终止 hook 子进程——我方 HookRunner dispose 路径
- [cand] 扩展可 inspect/replace MCP 工具结果再进模型——MCP 结果侧 hook 面（M147 扫描是单向只读，此为可改写面，权力更大需慎重）
- [verify] fork 的会话必须写新 session 文件不写父文件——我方 fork 持久化路径
- [cand] resume 被中断的 turn 不合成 "continue" 假消息——会话恢复语义增强
- [cand] 导入外部 harness 会话（CC/Codex/opencode）首次 resume 时先摘要外部历史——M89 族补强
- [verify] policy 支持 glob pattern→action 对工具输入参数匹配——我方 policy 规则表达力核对
- [noise] n<0.10 长尾（~16000-18405）几乎全是 provider 目录更新/UI 微调/已裁条目重复映射，无新增独立机制

## 复审收口 (2026-09-23)
- 全量 18,405 条去重语料逐条过完（novelty 降序，n0.9→0.0 全谱系）；有效新增判定集中在 n≥0.5 区段，长尾以既有裁定映射+营销噪声为主
- [verify] 类条目合计 ~40 条待逐条核销（多数预期已覆盖，需代码证据关门）
- [cand] 类新增方向收敛为：hooks payload/事件面增强（tool_provenance/pre_compact/message_transform）、hook 形态扩展（http/agent/LLM-judged）、delegate 参数面（per-spawn model/reasoning/concurrency）、MCP 结果侧改写钩（需评估权力边界）、导入外部会话首 resume 摘要、session resume 不合成假消息、每发送者工具策略、按成本上限自动批准、skill/插件来源 provenance 持续面

## batch22 — [verify] 核销（代码证据裁定 2026-09-23）

### ✅ 已覆盖（机制级证据）
| 项 | 证据 |
|---|---|
| #2509 Unicode 规范化 | decide.js `INVISIBLE_UNICODE`：零宽/bidi/BOM/软连字符在 command/path/url 严格键直接 block，自由文本剥离——比 NFKC 更强 |
| #4279/#4585/换行注入 | tree-sitter-bash 递归 $(...)/subshell/管道/循环体；`\n` 为命令分隔符、`\<newline>` 归并续行——结构覆盖 |
| #7326 包装命令 | cmd/powershell/bash/sh/python/node/env 全归 EXEC/UNKNOWN → 走 ask/租约，载荷不透明但 fail-closed 不静默 |
| #3588 hooks 罩 MCP 工具 | decide.js preToolGate.fireGate 在统一 decide 链内，mcp__* 同样过闸 |
| #4765 pre_compact 钩 | compact_start/compact_end 已 fire（channel.js:169-171）；subagent_start/stop + notification 已接线 |
| hook 子进程回收 | HookRunner killTree/close 用 taskkill /T /F 整树杀 + timeout 触发 |
| #2397 hook 输出注入 | 观测钩输出只进 audit；gate 钩 deny 给操作者——不注入上下文，设计规避 |
| #1499 损坏 permission/policy 文件 | loadPolicy JSON.parse 抛→AttestedPolicy 构造抛→kernel 不存在——fail-closed loud；assertFresh 漂移即拒 |
| #4697 坏行容错 | continuation/prediction/observation/tasks/handoff 全部 try{JSON.parse}catch→null——撕裂行不崩 |
| #1299 cron dedup | missed slot 坍缩单次 + markSkipped 窗口 + inflight 串行 tick |
| #4757 memory 跨轮去重 | remember 规范化文本去重（store 级，跨会话生效）；M125 注入形写入拒绝 |
| #2491 压缩失败崩溃 | auto-compact `.catch(()=>{})` + session_compact_failed 事件入 audit——best-effort 不崩 |
| #4366 throttle 误分类 | auto-compact 由 token usage ≥90% 触发，不依赖错误字符串——locale 误报面不存在 |
| #3806 ask 幂等 | AskStore.resolve 二次调用返回 `no pending ask` |
| 压缩后批准存活 | asks 在 host AskStore（transcript 外）——压缩不丢待答 |
| #4824/#4878 delegate 沙箱继承 | childEnforceable 断言制：非 enforceable 目标的 budget/tools_deny/mcp_deny 直接拒 spawn（fail-closed）|
| #2290 子代理权限模式 | agentprofile: toolsDeny/mcpDeny/budget/model/effort/isolateSteering + enforceable 闸 |
| per-spawn model | profile.model + model-routes.json 填 {model}/{effort} 槽 |
| #2040 Windows 进程树 | jobs cancel + hooks killTree 均 taskkill /T /F |
| #5142 MCP 断线重放 | #failAll 拒全部 in-flight，不自动重放——fail-closed |
| #7088 workspace 插件自载 | 扩展仅从 PI_ROOT/extensions + sha256 manifest 装载，noExtensions:true——攻击面不存在 |
| #1383 config_set 归属 | channel 命令是操作者专属面（模型走工具不走 channel）——结构归属 |
| continue-on-deny | block reason 回 tool result，模型可读转向——覆盖 |
| fork 写新文件 | sessionManagers.forkFrom 新建文件 + parentSession provenance 头 |
| 空 toolName | pi 分发层先按注册表校验，未注册工具到不了 decide |

### 🔴 真洞确认（待修）
| # | 洞 | 证据 |
|---|---|---|
| G1 | **schedule_task 命令创建零分类**：不在 kernel commandArgs 也不在 decide COMMAND_ARG_KEYS → 创建静默；触发时 hardPolicyGate 只拒 deny/terminate，ask 级（destructive→ask 默认 policy）**无人值班静默执行**。`bash rm -rf` 要 ask，`schedule_task` 排程同一个 `rm -rf` 不 ask——ask 级规避通道 | host.js:376 commandArgs 无 schedule_task；schedule.js:122 preflightCommand→hardPolicyGate:611 ask 级不抛 |
| G2 | **FILE_MUTATION_TOOLS 无 realpath→保护文件重查**：`write link/config`（link→`.git`）lexical 不命中 INSTRUCTION/GIT 正则、realpath 在界内（.git 在 workdir 内）→ 静默放行。shell 路径已修（realTarget 重查）但文件工具没有 | decide.js:250-280 write_outside 只查 containment |
| G3 | **MCP connect 失败泄漏子进程**：stdioTransport spawn 后 initialize 抛 → connect 传播异常，child 永不 close → 孤儿 server | mcp/index.js:193-199 无 try/close |
| G4 | **browser click 后无落地重查**：navigate 有 post-landing 重查+退回，click 只查点击前 host——点击触发跳转 blocked host 时页面已加载（egress 已发生），下一次动作才被拦；read/screenshot 完全无 host 检查 | browser.js:225-236 click 无 post-check；211 read、263 screenshot 无检查 |
| G5 | **DNS rebinding Host 未校验**：POST 有 Origin+SFS 检查，但 GET /events（SSE 全事件流）、/api/state、静态文件无 Host 校验——rebound 页面 EventSource 同源读会话遥测 | http-bridge.js:32-43 只管 POST |
| G6 | **delegate task 文本无密钥扫描**：{task} 插值进 argv + checkpoint 持久化——模型把 secret 写进 task 则落盘+进子进程命令行 | delegate.js:166 commandFor 直插 |
| G7 | **MCP stdio close 不杀进程树**：`child.kill` 单进程，孙进程孤儿（jobs/hooks 已有 taskkill /T 范式，MCP 没有） | mcp/index.js:115 |
| G8 | **MCP 非文本结果不打 untrusted 标**：text 块裹标签，image/resource/audio 原样透传 | mcp/index.js:397 `return c` |

### 📝 记录档（minor/N.A./variant）
- #1435 MCP 断线无 reconnect 面 → cand（/mcp reconnect 低成本）
- #1513 hooks 无全局 enabled 开关——文件存在即开关，记录
- #2040b PowerShell 命令走 bash grammar：怪异 PS 语法→parseError→deny（fail-closed 方向，可误拒但不误放）——记录
- auto-background 是模式表（LONG_RUN regex）非时间阈值，不可调——variant
- SECRET_FIELD_RE 含裸 `key`——ask 卡上字段名 key 一律脱敏（误伤方向安全，cosmetic）
- policy 规则冲突：longest-prefix 胜出无冲突检测——记录
- SQLite WAL 在 instanceRoot（本地路径，operator 选择放网络盘的风险自担）——记录
- checkpoint/git-commit 回卷、UI error boundary、primary-agent enabled、config-include ACL、per-DM 上限、扩展 hook 归属——本仓无对应面或 minor
- #4430 ANSI：UI 全走 textContent（DOM 不解析 ANSI）——XSS 面覆盖；终端直通是正常行为

### 修复计划（G1-G8 → 本轮实施）
G1 kernel commandArgs + decide COMMAND_ARG_KEYS 加 schedule_task（创建时分类=批准时刻）· G2 decide write 闸加 realTarget 重查 · G3 connect try/close · G4 click 落地重查+read/screenshot host 闸 · G5 Host allowlist · G6 task 文本 scanForSecrets→ask · G7 stdio taskkill /T · G8 非文本块加 untrusted 标记

### ✅ G1-G8 修复收口（哨兵全绿，pi 323+1skip / host 309 / app 4）
| # | 修复位点（生成器源码） | 哨兵证据 |
|---|---|---|
| G1 | `host.js` commandArgs + `decide.js` COMMAND_ARG_KEYS 同步加 `schedule_task:'command'`——创建时分类即批准时刻 | schedule.test.js: `kernel commandArgs classifies schedule_task.command` + `denyPrefix gates schedule_task.command at create` |
| G2 | decide.js write 闸新增 realTarget 发散重查（resolved≠lexical 才重问，不双问 kernel 已裁的同路径） | writeboundary: `write through symlink into .git→git_internal` / `into .pai→instruction_file` / `same-path writes do NOT double-ask` |
| G3 | `connect` catch 内 `transport.close()`——stdio 握手失败不再孤儿 | mcp-ext: `connect failure kills the spawned stdio child`（refusing server，pid 落盘后断言进程死亡） |
| G4 | browser.js click 加 NAV_SETTLE 落地重查+退回 about:blank；read/screenshot 加 currentHost 闸 | browser.test: `click navigates onto blocked host refused+backed out` / `read/screenshot refuse on blocked host` |
| G5 | http-bridge `badHost` 全请求闸（不只 POST）：非字面 loopback Host 一律 403——DNS rebinding 读不到 SSE/状态 | bridge.test: `non-loopback Host refused on every endpoint` |
| G6 | delegate.js task 文本 `scanForSecrets`→命中直拒（argv+checkpoint 双泄漏面） | agentprofiles: `delegate_task refuses task text carrying a credential pattern` |
| G7 | stdio close 改 `taskkill /T /F`（Win）/`SIGKILL`（POSIX）——进程树范式与 jobs/hooks 对齐 | 同 G3 哨兵（child 树清理路径）；关闭路径复用 close() |
| G8 | wrapUntrusted 对非文本块归一：已知类型透传+未知名/畸形块→`unsupported content block dropped` 文本桩，details.droppedBlocks 计数 | mcp-ext: `non-text MCP blocks: known types pass, malformed become stub text` |

残留 cand：#1435 `/mcp` reconnect（v1 低成本项，未实装——记录为候选缺口）

## batch23 — 逐条处置台账收口（2026-09-23）

`_midreview/item-dispositions.tsv` 落地：18,405/18,405 行逐条有处置结论，构成 = **18,037 条早前逐条标注**（compact.txt `<<` 尾注，先前评审轮写入）+ **368 条本轮补判**（早前标注的散布空档，本批逐条过读补齐）。

368 补判分布：cand×14 / dup×13 / verify-closed×2 / variant×1 / boundary×274 / noise×64。新增候选（未在既有批次中实现的）：

- #14 全局禁用 always-授权的管理员开关（batch1 已记，M146 族）
- #16 auto-compact 触发阈值可配置（我方固定 90%）
- #17 requirements.toml allowed_web_search_modes（搜索模式白名单声明）
- #34/#121 安全检测框架（safety-checker/Conseca——verify/hooks 族方向佐证）
- #104 新用户检测→onboarding（batch1 已记缺口）
- #123 ModelPolicy/PolicyCatalog 模型策略目录
- #361 --skip-sanity-check-repo 大仓启动加速档
- #383 /verify 深度验证 lane（verify 族佐证）
- #512 command_aliases 命令别名
- #1116 disable_paste_burst 粘贴突发开关（M129 族）
- #1639 SKILL.toml manifest 变体
- #1705 skipLoopDetection 关闭档
- #3088/#6261 已发消息原位编辑+重答/删除（真实 UI 缺口，归批4 UI 族）
- #4999 CODEX_SECURE_MODE 进程可观测性限制档

补判为 dup/verify-closed 的代表：#420 IP 校验+safeFetch≈M63/M66、#1916 XML 转义≈M147/U5、#329 FolderTrust≈M85、#1498 损坏权限文件 panic≈policy fail-closed（已核销）、#6072 /copy-context≈context_map/export、#97 workboard 编排≈delegate/mailbox、#144 .devinignore≈.paiignore。

台账列：`idx | novelty | cluster | src | verdict | detail | pass`；pass=prior（早前逐条标注）/fill（本轮补判）。

## batch24 — score 8–29 高分带逐条处置（4,263/4,263，2026-09-23 续）

**缺口成因**：`_midreview` 语料 = `_candidates-C-dedup.jsonl` 中 score 4–7 切片（18,405 条）；score 8–29 的 4,263 条此前只有功能级判定、无逐条台账。本批补齐——高分带恰是机制密度最高区（持久 memory、worktree、fork/resume、委派、调度、审批、密钥面），逐条过完。

**方法**（纠正后）：`hiscore-skeleton.tsv` 机械抽取 `idx|score|cluster|src`（JSONL 无 idx，按归一化文本对齐 hiscore.txt 行序）；判定列 `verdict|detail` 由人工按 200 条/批逐条手写进 `verdicts-hi-0..20.tsv`（21 批，零簇级默认）；join 成 `hiscore-dispositions.tsv`（`idx|score|cluster|src|verdict|detail|pass`，pass=manual）。源对齐校验：4,263 行 score 全一致、idx 0–4262 连续无缺零重复。

**处置分布**：dup×1,936（我方已实装/已裁决的同型机制）· boundary×1,414+4=1,418（编辑器/provider/产品面出界）· cand×487（真实机制缺口候选）· noise×257 · variant×165（我方异构实现）· verify×0（6 条已核销转化）。

**verify 核销结果**（均落到执行面代码）：
- #248 召回 memory untrusted 标记 → **dup**：`host/src/core/memory.js:297` 召回行进 untrusted `<memory>` 块 + `envelopes.js` 常驻 untrusted-content-policy
- #981 relative globs 锚定 → **dup**：`pi/src/bootstrap/decide.js:84` `resolve(workdir,p)` 锚 workdir 非启动 cwd
- #1249 $HOME/fs-root 不建索引 → **dup（更强）**：`pi/src/adapter/fastcontext.js:43-93` 本就 workdir 限定 + subdir containment + realpath fail-closed，家目录索引面不存在
- #915 path-shadowing（repo 内 git.exe 影子化批准命令）→ **cand**：`jobs.js:505` `shell:true` 下 cmd.exe 先搜 cwd；待加 `NoDefaultCurrentDirectoryInExePath` 或绝对 PATH 解析
- #1277 revert 删 agent 创建的空目录 → **cand**：fileops receipt-undo 回收创建文件，但 `mkdirSync recursive` 建的空目录残留
- #1284 oversized 父会话 fork 砖化 → **cand**：`forkFrom` 无 size/entry 容量闸

**cand 487 条高分候选的代表性机制族**（全量在 hiscore-dispositions.tsv 逐条）：token 预算闸（rollout budgets+abort）、事件驱动唤醒（sched-wake）、自适应 /loop、per-contact 模型路由、forked-context 委派、subagent 分级参数面、审批持久化（granular Always-Allow）、工作区快照回滚、会话归档/倒带、跨工作区会话、共享 task lists、三态目标评估、plugin 安装治理闸（operator install policy）、MCP OAuth 2.1 PKCE + OSV 扫描、per-thread MCP 激活、manifest modelCatalog 契约、skill 评审工坊（proposals+rollback）、消息级元数据透视、reasoning 快捷键、未信源前缀剥离。

**全量对账闭环**：低分带 item-dispositions.tsv 18,405 + 高分带 hiscore-dispositions.tsv 4,263 = **22,668 条去重候选全数有逐条处置**，对应 80,369 信号条目 / 89,544 原始条目 / 35 家 harness 的完整采集链。

## batch25 — 高分带 verify→cand 三项落地修复（2026-09-23）

batch24 核销转化的 3 个真缺口已在**执行路径**修复（非文档/非测试补丁），各带哨兵：

| # | 缺口 | 修复位点（生成器源码） | 哨兵证据 |
|---|---|---|---|
| #915 | repo 内 git.exe/rg.exe 影子化已批准命令（cmd.exe cwd 先搜） | `pi/src/bootstrap/host.js` 进程级 + `pi/src/adapter/jobs.js` spawn 点双写 `NoDefaultCurrentDirectoryInExePath=1`——覆盖 cmd.exe shell:true 解析与 argv spawn 的父进程 CreateProcess 两个面 | jobs-executor: `spawned children carry NoDefaultCurrentDirectoryInExePath`（子进程回显 SHADOWENV=1） |
| #1277 | revert 不清 agent `mkdir -p` 建的空目录 | `fileops.js` write() 记 receipt `dirsCreated`（workdir 内含域、最深优先）；tombstone restore 对仍空目录 `rmdirSync` 回收（非递归=竞态 fail-safe）；`FileOpsGuard` 新增 `workdir` 构造参，host.js 接线 | fileops: `tombstone restore reaps agent-created empty dirs, keeps dirs holding user content` |
| #1284 | `forkFrom` 无容量闸，超大父会话砖化 thread | `host.js` `assertForkableSource`（64MB cap + FORK_REFUSED 审计）挂在 `fork` 与 `importSession` 双入口 | bootstrap: `session_fork refuses an oversized source transcript`（cap+1B 拒绝且无残留目标文件） |

回归：受影响三套件 72/72 全绿。全套 pi 跑中出现 2 个**外来引入**失败（boundary 扫描误捕外来注释字面量 `from "not installed"`；外来 loopGovernance 无条件安装改动导致 teardown EPERM）——归因外来在途，非本批。

## batch26 — 人工复核工作清单 sigwork 24,484 条逐条处置（2026-09-23）

**语料**：`sigwork.txt` = 第一轮规则收割后剩余的 24,484 条人工复核工作清单（flag 桶全量——unmatched/fix-mech/feat-mech/docs+mech 等无法规则化定判的行）。本批把该清单**逐条过完**，无抽样、无跳过。

**方法**：122 个 `vs-*.tsv` 批次账本（vs-0..vs-121），每批 200 行（末批 84 行），每行 `id⇥verdict⇥detail` 手写判定；每批写完即对源区间做 id 集合校验（missing/extra 必须全空）。全程修正 5 处笔误（53794→53798、49591→49600、74858→74859、53505→53515、60205→60206）+ 2 处错档归位（vs-0 的 11445→11444、vs-9 的 35601→35603）+ 补漏 4 行（54871、68544、13377、11027）——全部即时修正并复验。

**产物**：`sigwork-dispositions.tsv`（`id|class|flag|verdict|detail|pass`，pass=manual，24,484 行 + 表头），由 vs-* 批次账本 join sigwork 源列生成；全量校验 missing=[]/extra=[]/cross-file-dup=[]。

**处置分布**：noise×13,101（发布头/日期/贡献者/文档碎片/编辑器内部/dep-bump/CI/test 内部）· dup×8,007（我方已实装同型机制：批准门、沙箱、MCP、AGENTS.md 加载、会话恢复、权限档等）· boundary×3,310（编辑器/IDE/协作/平台面出界但内容真实）· cand×65（新候选机制）· variant×1。

**对账更新**：本批 24,484 条属 **flag 桶**（规则无法定判的行），与早前 noflag 自动处置（~33,217 条）、低分带 18,405、高分带 4,263 合计覆盖全部 **80,369 信号条目**逐条处置——上溯 89,544 原始 / 35 家 harness。链路上每层都可从台账反查到原始行。

## batch27 — 全量主台账 signal-dispositions.tsv（80,369/80,369，2026-09-23）

batch26 的 "~33,217 noflag 自动处置" 当时是估算口径；本批物化并复核了完整链路：

**三层处置来源**（互斥、并集=全量）：

| 层 | 行数 | verdict 来源 | pass 标记 |
|---|---|---|---|
| flag 桶（规则无法定判） | 24,484 | sigwork-dispositions.tsv 逐条人工 | `manual` |
| 规则自动处置（非 flag 且非 dedup 成员） | 31,495 | sig-classify 规则逐条定判（含 cdet 规则标签） | `rule` |
| dedup 成员继承（低分带成员） | 20,032 | item-dispositions.tsv 簇处置逐字继承 | `dedup-l` |
| dedup 成员继承（高分带成员） | 4,358 | hiscore-dispositions.tsv 簇处置逐字继承 | `dedup-h` |

**产物**：`signal-dispositions.tsv`（`id|harness|dom|kind|verdict|detail|pass`，80,369 行 + 表头），id 与 `_items.json`/`_signal-items.jsonl`/`sig-skel` 行序逐字段对齐（misaligned=0）。

**全量 verdict 分布**：noise×41,072 · annotated×19,656（dedup 簇级注解处置，detail 为该簇注解本体）· dup×10,094 · boundary×8,795 · cand×576 · variant×174 · verify-closed×2。

**对账修正**：
- `_signal-items.jsonl` 实为 **80,369 行**（早前 80,368 系末行计数误差），与 `_items.json`、`sig-skel` 三源一致。
- 去重候选台账口径：item-dispositions 18,405 数据行 + hiscore-dispositions 4,263 数据行 = 22,668（早前 18,406/4,264 系含表头行数）。
- 继承完整性：24,390 条 dedup 成员的 detail 100% 能在对应带台账中逐字命中；`inh.v` 非 `annotated` 者即簇 verdict 本身。

## batch28 — 未落实候选独立清单 candidates-open.tsv（648 条，2026-09-23 修订×2）

初版只收了台账 `cand` verdict（566）——**漏了 findings.md 散文层的 cand/verify/dir 标记**（那些条目在台账里是 `annotated` 簇级处置，cand 判定散记在各 batch 小节）。第二版又踩了 id 空间错位：findings `#idx` 是 compact/item-dispositions 行号空间，却拿去跟 dedup 偏移基址去重，误丢 6 条（1112/1985/2135/2215/2375/3323），并有 #3613 双记。修订后七段全收：

| 来源 | 条数 | id 口径 |
|---|---|---|
| dedup-h（hiscore-dispositions cand） | 487 | `_candidates-C-dedup.jsonl` 行号 0–4262 |
| dedup-l（item-dispositions cand） | 14 | 同上，行号 4263+ |
| manual（sigwork-dispositions cand） | 65 | 信号 id |
| findings-cand（各 batch `[cand] #idx`，全 36 唯一 id） | 36 | compact.txt 内嵌行号；其台账 verdict 均为 `annotated`（散文层判定未被台账回写） |
| findings-cand-inline（无 # 散文候选） | 13 | 无（onboarding 一条因 U14 已落剔除） |
| findings-verify（`[verify]` 未核销） | 20 | compact.txt 内嵌行号；batch22 已核销 18 条不在列 |
| findings-dir（`[dir]` 方向观察） | 13 | compact.txt 内嵌行号或散文 |

合计 **648 条**。G1–G12 / U1–U15 / D1–D6 经 §28 回写全部关闭（已有或有意拒绝），verify-closed（#915/#1277/#1284）已修复——均不在列。

## batch29 — 648 逐条实施核销开始：#2 worktree 侧栏创建（2026-09-23）

用户指令"开始逐条实施"。核销账规则：**`candidates-open.tsv` 保持 648 行冻结**（发布口径/审计分母，anchor v7 锁定）；逐条核销走 **`candidates-resolved.tsv`**（src/id/grp/detail/resolution/evidence/resolved_at/batch），决议四值 = IMPLEMENTED / ALREADY-COVERED / VARIANT / REJECTED(理由)。剩余开放数 = 648 − resolved 行数，两条台账可对账不重不漏。

**#1 dedup-h#2 → IMPLEMENTED**：侧栏开 worktree 的对等面 = `/worktree <cmd>`（app）→ channel `job_spawn{worktree:true}`（host）→ `exec.runJob` 走与模型 job_spawn **同一 currentDecide 链**（pi host.js）→ `JobExecutor` detached checkout（M13 执行器复用）。顺修一个既有真洞：decide.js job_spawn 的 fg 租约死锁（:483 豁免被 :484 重分类抵消，任何 mutating job_spawn 必撞自己调用方的锁）——模型路径同病，修复后保留 mutating 重检只豁免取锁。证据见 FEATURE_AUDIT §28.32。
