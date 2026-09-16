# Cordis 服务分流矩阵 — M5 产物

数据源：`scripts/m5_cordis_scan.py` 扫 `~/.dsh/profiles/web/base-dsh-0.1.1-rc.2`（`.taskflow/m5-inventory.json`，197 包，含 dsh 嵌套 node_modules）。
Chord 验证：`pi/tests/chord-spike.test.js` 3/3（service/facet/replicatedState/RemoteServiceProvider keyed-spawn 全通）。

## 五类语义（R8 收敛后的口径）

| 类 | 含义 | 判据 |
|---|---|---|
| **A 搬** | 机制与 harness 无关，值得搬进 host/ | 纯原语、零插件面耦合 |
| **B 适配** | seam 契约映射到 host contract，实现留 dsh 身体 | 抽象 seam（ctx.*）——PAI 只借契约思想不搬代码 |
| **C→Chord** | 通道/复制态/UI 状态面 → 将来以 Chord service 重建 | 远程/订阅/replicated-state 本质 |
| **D 重写** | 机制有效但缝错了 → 已在/将在 host+pi 新缝上重写 | 功能已被 M1–M4 等价物覆盖 |
| **E 删** | DSH 产品身份/web 产品面/cordis 元框架本身 | PAI 无此需求；留 dsh 身体，不移植 |

## A 搬（机制移植候选，8 项）

| 包 | 机制 | 落点 |
|---|---|---|
| dsh-atomic-write | 原子文件替换（exclusive-create+rename） | host 侧 canonical 写保护可借鉴 |
| dsh-timeout | clampTimeout 原语 | durable job 超时臂 |
| dsh-output-retention | 有界保留原语 | audit/日志裁剪 |
| dsh-compaction-tool-result-pruner | replay-safe 头中尾剪枝（model-free） | M3 compaction 治理增强候选 |
| dsh-token-meter | replay-aware token 计量 | 已并入 TURN_ACCOUNTING（机制已验证） |
| dsh-sandbox-windows-acl | Windows ACL 写受限 spawn | containment 域③ 强化候选 |
| node-addon-landlock-run | Landlock 自限 exec（Linux） | 同上，跨平台沙箱选项 |
| dsh-session-query-sqlite | SQLite FTS5 会话检索后端 | host 记忆检索候选 |

## C→Chord（通道/复制态，11 项）

| 包 | 理由 |
|---|---|
| dsh-client-connection | HTTP-up/WS-down 线协议消费者层 → Chord RemoteServiceBinding |
| dsh-client-runtime | SlotRegistry/SessionRuntime 复制态客户端核 → replicatedState |
| dsh-client-modules | 双面模块系统（node 半+浏览器半）→ Chord facet 双端 |
| dsh-client-hmr / dsh-client-locale | 客户端动态面 → facet |
| dsh-api-gateway / dsh-api-remotes | Typert Remote Host/BFF → Chord remote service endpoint |
| dsh-typert-protocol / dsh-typert-loader / dsh-typert-registry | Typert RPC 元数据面 → wire protocol 层 |
| dsh-session-projection-cache | 持久投影缓存 → replicatedState |

## D 重写（机制有效、缝已换，55 项）

| 包 | PAI 等价物 |
|---|---|
| dsh-agent-loop | Pi AgentSession（M1 装配） |
| dsh-agent / dsh-agent-default-model / dsh-agent-tool-presentation | registry capabilities + model_select 审计 |
| dsh-agent-instructions | ContextEnvelope（M1） |
| dsh-system-prompt | InstructionEnvelope（M1） |
| dsh-goal-round-driver / dsh-tool-goal / dsh-command-goal | evidence 门 + ContinuationGovernor（M3） |
| dsh-jobs / dsh-jobs-local / dsh-tool-jobs | JobStore 九态机 + JobExecutor（M4） |
| dsh-compaction / dsh-compaction-basic | session_before_compact 钩子面（M3） |
| dsh-repeat-tool-reminder | no_progress 断路器（M3） |
| dsh-plan-mode | host policy 可表达（M2） |
| dsh-subagent / dsh-subagent-in-process-driver / dsh-subagent-fork-in-process / dsh-subagent-spawn-in-process / dsh-tool-subagent / dsh-tool-subagent-control / dsh-tool-subagent-report | delegate_task durable-job 桥（M4） |
| dsh-workflow / dsh-workflow-worker-thread / dsh-tool-workflow | durable job 编排 + Pi 工具面 |
| dsh-schedule | durable jobs（after/at 提醒=job 类型） |
| dsh-sandbox / dsh-sandbox-local / dsh-sandbox-policy / dsh-bash-sandbox / dsh-pwsh-sandbox | containment.md 三域（M2） |
| dsh-shell / dsh-bash-local / dsh-pwsh-local / dsh-native-command | Pi 原生 bash/powershell 工具 |
| dsh-terminal / dsh-terminal-bash / dsh-tool-bash-persistent / dsh-tool-pwsh-persistent | persistent shell → Pi bash / durable job |
| dsh-tool-bash / dsh-tool-pwsh / dsh-tool-call-timeout-policy | Pi 工具面 + kernel timeout |
| dsh-tool-fs / dsh-tool-fs-search / dsh-tool-str-replace-editor | Pi read/write/edit/glob/grep + fileops（M2） |
| dsh-tool-ask-user / dsh-user-questions | host 人机交互面（M6 渠道） |
| dsh-tool-todo | Pi todo 工具等价 |
| dsh-tool-web / dsh-web / dsh-web-search-deepseek | Pi web 工具等价 |
| dsh-tool-skill / dsh-skill / dsh-skill-filesystem / dsh-skill-badge | Skill 包机制（本仓 skills/） |
| dsh-tool-ralph | Ralph 循环 → continuation 编排 |
| dsh-mcp-client | MCP→customTool 桥（M4 delegate 模式扩展） |
| dsh-session / dsh-session-persistence / dsh-session-persistence-jsonl / dsh-session-checkpoint-policy | Pi SessionManager + host persistence |
| dsh-session-projection / dsh-session-query / dsh-session-stats / dsh-session-reference / dsh-session-title / dsh-session-title-llm / dsh-session-title-first-prompt-llm / dsh-session-telemetry / dsh-session-telemetry-otel / dsh-session-log-export | audit JSONL + host 查询面 |
| dsh-settings / dsh-settings-file | host canonical policy（M2） |
| dsh-credentials / dsh-credentials-local | auth.json + env 插值（M3 验收已用） |
| dsh-authorization / dsh-user-approval / dsh-permission-presets | kernel policy + deny/ask 动作（M2） |
| dsh-invariants | host identity invariants（M1） |
| dsh-llm / dsh-llm-deepseek / dsh-llm-pi-ai / dsh-llm-retry | pi-ai provider 面 |
| dsh-code-runtime / dsh-code-runtime-worker-thread | Pi 工具/executor |
| dsh-spill / dsh-spill-local / dsh-spill-policy | Pi tool result 处理域 |
| dsh-storage / dsh-storage-domain / dsh-storage-json / dsh-attachment / dsh-attachment-local | canonical + instance root 存储（M1） |
| dsh-fs / dsh-fs-local / dsh-file-reference / dsh-file-reference-local | fileops + Pi fs 工具 |
| dsh-subprocess / dsh-subprocess-local | JobExecutor spawn |
| dsh-workspace / dsh-agent-presets | registry + handoff envelope |
| dsh-commands / dsh-command-compact / dsh-command-feedback / dsh-command-goal | 渠道命令面（M6） |
| dsh-message-feedback | audit 侧车 |
| dsh-time-context / dsh-tmux-context | ContextEnvelope 动态字段 |
| dsh-shell-env | executor env 注入 |
| dsh-host-directory-picker* (4 包) | UI 渠道面（M6） |
| dsh-tool-cordis | cordis 自指工具集——cordis 没了它没意义 → 并入 E 处置 |

## E 删（DSH 产品面/元框架，~70 项）

cordis 元框架与启动胶（不属 PAI）：
`cordis` `cordis-plugin-group` `cordis-plugin-loader` `cordis-plugin-hmr` `cordis-plugin-include` `cordis-plugin-timer` `schemastery` `cosmokit` `dsh` `dsh-base` `dsh-app-boot` `dsh-cmdline` `dsh-headless` `dsh-launch-environment` `dsh-persona` `dsh-anonymous-user-id` `dsh-scope` `dsh-host-plugin-inventory` `dsh-cordis-host-runner` `dsh-cordis-client-runner` `dsh-tool-cordis`

Web 产品面（留 dsh 身体，PAI 不移植——R8：web_ui 是 dsh 的 supported 能力，要 UI 选 dsh 即可）：
`dsh-web-frontend` `dsh-web-app` `dsh-host-frontend-static` `dsh-host-webserver` `dsh-client-ui-*`（全部 35 包：conversation/layout/sidebar/settings*/model-selection/tool/trajectory/subagent/jobs/goal/plan/theme/…）

## dsh/ 本仓包（9 自有插件 + 周边，18 项）

| 包 | 类 | 落点 |
|---|---|---|
| dsh/context-pressure-guard 三件套（pressure-guard/token-meter/tool-result-pruner） | D | context 缝 + before_provider_request（M3 计费面已覆盖核心） |
| dsh/autonomous-execution-governor | D | composite guard（M2） |
| dsh/compaction-convergence | D | session_before_compact（M3） |
| dsh/model-switch-controller | D | model_select 审计 + policy（M3） |
| dsh/workflow-model-preflight-gate | D | eligibility/policy（M2） |
| dsh/world-model | **A** | canonical 机制——预测绑定已入 host prediction.js（M2），canonical 同账本不换 |
| dsh/repeat-tool-reminder-patch | D | no_progress 断路器（M3） |
| dsh/subagent-*（prep-exec-gate/splice-summarizer/usage-observer） | D | delegate_task + 父 run 归属（M4） |
| dsh/token-saver | D | spill/pruner 机制（候选 A） |
| dsh/research-lab-adapter / dsh/web-search-adapter | B | 渠道适配留 dsh 身体 |
| dsh/ui | C | UI 状态面 → Chord（M6 评估） |
| dsh/workspace-registry-root-fix | D | registry（M1） |
| dsh/runtime | E | 运行态不进仓 |
| dsh/model-persona | B | soul 面概念（canonical 归属） |

## 统计

| 类 | 数量 | 占比 |
|---|---|---|
| A 搬 | 8 | 4% |
| B 适配 | ~15 | 8% |
| C→Chord | 11 | 6% |
| D 重写 | ~90 | 46% |
| E 删 | ~73 | 37% |

**大头是 D**：Cordis 服务生态的机制价值大都在，但它们的缝（cordis ctx.*）不可带——这正是"换缝不换机制"的实证。E 几乎全是 web 产品面和 cordis 自身——D7 时按此矩阵执行删除/保留。
