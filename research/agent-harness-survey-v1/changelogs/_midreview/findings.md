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
