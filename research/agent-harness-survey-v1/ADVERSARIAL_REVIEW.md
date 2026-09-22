# ADVERSARIAL_REVIEW.md — 基于 25 家 harness 原始材料的无情重审

**委托原文**：「不要相信任何本地的判断和认知，仅仅使用最原始的 26 家 harness 客观设计及其更新记录，对现有的最终产品进行不留情面的审查」

**审查对象**：运行时产品面 —— `host/`（治理内核）+ `pi/`（身体适配器）+ `app/`（Electron UI + server）+ `dsh/`（插件适配）

**日期**：2026-09-21　**审查人**：Claude（Opus 5）

---

## 0. 纪律声明（什么算证据）

本次审查的证据等级，沿用 survey 的认知标签纪律，并升级为裁决规则：

| 等级 | 含义 | 本次用途 |
|---|---|---|
| **BENCH-FACT** | `harnesses/*.md` 中的 FACT 级事实 + `changelogs/` 原始更新记录 | **唯一基准** |
| BENCH-CLAIM | VENDOR-CLAIM 级（厂商自述） | 降半格使用，需两家以上旁证 |
| BENCH-LEAD | INFERENCE 级 | 仅作线索，不作判决依据 |
| **PROD-PROVEN** | 产品能力，有源代码 file:line 证据，且本次逐行核过 | 唯一算"有" |
| PROD-ABSENT | 找不到证据，或找到的是空壳/死路 | 一律按"没有"判 |

本地文档（`FEATURE_AUDIT.md`、ADOPTION_MATRIX、§28 终裁、anchor/ledger）一律视为**被告证词**，不是证据。被告证词与源代码冲突时，源代码赢；源代码与被告证词一致时，仍只记源代码。

不给疑点利益：「我们有 X」必须有代码证据；「部分有」按缺口记；「UI 有入口而后端死」按没有记；「后端有而 UI 无入口」按"机制存在、产品面未交付"记。

## 0.1 语料层校正（先说基准本身的错）

- **`harnesses/` 目录实有 25 份研究，不是 26 份**（Glob 实测）。委托口径"26 家"与磁盘事实差 1。本审查按实有 25 家逐项进行。
- `changelogs/` 层覆盖 36 个目录（多出 amp/codebuddy/continue/copilot-cli(空)/gptme/jules/kaos/qoder/replit/swe-agent/warp/windsurf/zed），约 900 文件 / 460MB。`_REPORT.md` 如实记录了缺口（GitHub 100 页上限、Cursor 经 Mintlify 缓解、Copilot CLI 无公开源）。这层诚实记录本身符合基准纪律。
- 本地蒸馏物（`_signal-items.jsonl` 8 万行、`_domain-counts.json`）**只作索引**。本次所有有争议的投票均回原始文件复核（方法示例：opencode 的 `sandbox-exec:18` 域计数，回原始记录核实为 git worktree 的命名，不是 OS 沙箱——域计数会撒谎，原文不会）。

## 1. 产品实测清单（Phase B 证据基础）

以下每个条目都经本次逐行阅读源代码确认，不再引用任何本地文档结论：

| 模块 | 证据 | 实测结论 |
|---|---|---|
| 治理晶格 | `host/src/core/governance.js`（546 行全读） | 8 层判定序：policy 认证新鲜度→工具规则（精确+最长前缀）→负能力→tree-sitter 命令分类→per-tool ask→指令路径保护（16 条正则，覆盖 AGENTS.md/CLAUDE.md/.cursorrules/.kiro/ 等，**任何模式都 ask**）→prediction 绑定→plan 模式收紧→overlay 收紧 |
| 判定链 | `pi/src/bootstrap/decide.js`（432 行全读） | 不可见 Unicode 清洗（最先）→lazy 工具拦截→内核→回合上限（默认 100，Qwen MAX_TURNS 同类）→.pai/commands.json→错误连停闩→.paiignore→越界读闩（fail-closed）→pre_tool 门钩子（fail-closed）→循环检测→写前泄密扫描（无 ask 时 fail-closed）→长命令作业化→写租约互斥（mcp__* 按变更对待；重分类堵住重定向语法洞）→FileOpsGuard |
| 命令解析 | `pi/src/adapter/command-parse.js`（193 行全读） | 真 tree-sitter-bash（node 原生绑定，wasm 路线探明 ABI 不兼容后弃用）；提取 `$()`/子shell/管道/循环体里的每个命令单元；7 类风险 + 危险环境变量正则（LD_PRELOAD/NODE_OPTIONS/JAVA_TOOL_OPTIONS 等，注释注明源自 zed/Q 阻断表扫描） |
| OS 沙箱 | `host/src/core/sandbox.js`（136 行全读） | **jobs 有，前台工具路径没有**。后端 none/wsl/docker/ssh 均真实实现（wsl 走 `wsl.exe --cd` 真内核边界；docker `--rm` 一次性容器；ssh BatchMode+base64 防引号走私）；不可用后端在进程创建前 fail-closed。文件头自述缺口：「opt-in until a containment story covers the foreground tool path too」 |
| hooks | `host/src/core/hooks.js`（196 行全读） | 8 个观察事件 + 1 个门事件（pre_tool）。workdir 侧 `.pai/hooks.json` 被刻意限定为纯观察（agent 能写，就永远不许它否决自己）；门钩子读 operator 私有的 `<instance>/hooks.json`，每次触发重读（改动即生效），**fail-closed**（超时/spawn 失败=拒绝），exit≠0 或 stdout `{"deny":"..."}` 拒绝；Windows 用 taskkill /T 杀整树 |
| 循环检测 | `host/src/core/loopwatch.js`（161 行全读） | 3 种检测器：连续同签名（warn≥3/block≥5）、严格 A/B 乒乓（warn 6/block 8）、错误连击（3 次→升级，operator 可闩停）；指定的轮询工具豁免 |
| LLM 评审 | `host/src/core/judge.js`（101 行）+ `shadowjudge.js`（180 行） | **刻意分歧**：JudgeAdvisor 永远只是 ASK 卡上的影子意见，「no path from an opinion to a verdict」；ShadowJudge 默认纯遥测，guard 模式只许单向收紧（deny/ask 可拦，allow 不降级；确定性 deny 从不咨询 judge）；judge 不可达=放行+审计，绝不崩开 |
| 预算 | `host/src/core/budget.js`（187 行） | 单调追加账本（rewind 不能撤销已花费）；准入发生在昂贵调用**之前**；账本坏了+配了限额=fail-closed 拒绝 |
| 租约 | `host/src/core/lease.js`（130 行） | SQLite CAS + 单调 generation 作为 fencing token；单语句 upsert + WAL + busy_timeout 给真跨进程原子性 |
| 作业 | `host/src/core/jobs.js`（369 行，前 120 行精读） | 9 态状态机（orchestration_state 永不自动 fail job_state——注释明示该不变量）；recoveryTick 幂等零 LLM：死 worker+有效 checkpoint→RESUME_ATTEMPT；死 worker+无效 checkpoint→WAITING_EVENT+REVIEW_REQUIRED（从不盲目从头重启） |
| 记忆 | `host/src/core/memory.js`（237 行，前 100 行精读） | SQLite+FTS5；**写入前先扫密钥**（记忆会注入上下文，存了密钥=每轮泄漏）；规范化去重；user/project 双作用域（project 行只在其 workdir 内可召回，Claude Code 记忆类比） |
| 调度 | `host/src/core/scheduler.js`（236 行，前 80 行精读） | 持久化调度；错过的触发在下一次启动**只补一次**（停机一周≠补跑 N 次）；上限 50 条；间隔下限 60s；自适应速率部分界限拒绝而非静默忽略 |
| 接续 | `host/src/core/continuation.js`（108 行全读） | ContinuationGovernor 证据门控：complete/continue/blocked；持久账本 `continuation.jsonl`（重启后预算位置不变）；maxContinuations=8、noProgressLimit=3（相同缺口集重复=blocked） |
| 文件操作 | `pi/src/adapter/fileops.js`（261 行，前 120 行精读） | 删除→回收站（永不 rm -f）；写/编辑→字节级备份+sha256 回执；新建文件有 create 墓碑回执（rewind 可撤销创建）；restore 前若目标已有字节则先回收现字节（restore 本身可恢复，ZCode 安全检查点语义） |
| 验证环 | `pi/src/adapter/verify.js`（105 行全读） | Aider lint/test 类比：`.pai/verify.json` 武装后每次写爆发跑一次；**配置文件是 agent 可写的，所以配置命令用与模型工具调用相同的分类器+policy 判定**——自我武装无法走私任何 policy 本来不许的命令 |
| 监视器 | `pi/src/adapter/monitor.js`（80 行全读） | fs.watch 事件唤醒走同一个受治理 promptSink；忙时拒绝（监视器是通知不是队列）；注册项**只能 operator 武装**——agent 不得给自己装闹钟 |
| 循环接线 | `pi/src/adapter/loop.js`（231 行全读） | continuation 证据跨整任务累积；陈旧 agent_end 去重防御；provider fallback 链（审计每一跳、 hops 封顶）；U15 子目录提示（Goose SubdirectoryHintTracker 类比，只提示一次、上限 30 条、走 observation 通道不篡改工具结果） |
| 工具表面 | `pi/src/adapter/surface.js`（140 行全读） | deny→hide 持久化到 deny-memory.json（重启复现同一可见面）；mode overlay 隐藏随会话死亡（与 operator deny 的持久性刻意区分）；M83 lazy 工具（tool_search/tool_activate 认领） |
| 信封 | `host/src/core/envelopes.js`（143 行，前 60 行精读） | InstructionEnvelope（权威，policy 住这里）与 ContextEnvelope（每轮，可被压缩）**两通道刻意不合并**；untrusted-content 规则注入每个指令通道 |
| 交接 | `host/src/core/handoff.js`（157 行，前 70 行精读） | 7 相冷交接状态机；PortableContinuityEnvelope 必填字段校验；5 个 verify 门全部必需不可跳 |
| 询问 | `host/src/core/asks.js`（272 行，前 80 行精读） | 全 fail-closed：timeout=拒绝、abort=拒绝；deny 级联（同 tool:arg 本会话自动拒绝）；always 持久化（OpenCode 类比）；question 类 ask 永不可自我回答 |
| MCP | `pi/extensions/mcp/index.js`（前 80 行精读） | **零依赖 MCP 客户端真实存在**：stdio（换行分隔 JSON-RPC）+ Streamable HTTP；注册为 `mcp__<server>__<tool>` 前缀（治理锚点：policy `mcp__*`、写租约序列化、plan 模式升级）；结果包 `<untrusted>` 标签；连不上的服务器不注册任何工具（deny→hide 一致） |
| 接线 | `pi/src/bootstrap/host.js`（1433 行，关键段精读） | Windows 落子二进制防御（NoDefaultCurrentDirectoryInExePath，Cline 类比）；ambient 上下文每轮重算（git 探测限 1.5s fail-soft）；canonical-writer 租约启动即争（活租约 fail-closed 拒绝双写者）；egress 域名白名单 operator 私有、每次调用重读；委派 profile 走与 microagents 相同的信任门（repo 里埋的 profile 不得操纵子进程环境）；PAI_STEERING_OFF 隔离委派子的 steering 文件 |
| UI 消费面 | `app/ui/app.js`（3641 行，grep 验证） | 79 处命令调用命中：decision_resolve/pending_list/policy_status/lease_status/session_compact/session_rewind（含三作用域）/repo_map/goal_list/schedule_list/fileops_*/verify_run/skills_list/profile_*/risk_mode*/todos_list 等均有真实 UI 消费 |

## 2. 逐子系统裁决（25 家逐项）

### 2.1 安全与权限（safety & permissions）

**基准事实层**（25 家中的最优者）：
- claude-code：OS 沙箱（Seatbelt/Bubblewrap）+ hooks ~30 事件 + per-command allowed_domains（CHANGELOG.txt:37,56,388,633 复核为真）
- codex-cli：每平台 OS 沙箱（Landlock/Seatbelt/restricted token），网络单独门
- devin：fail-closed bubblewrap+socat，路径对 agent 隐藏，Windows 不支持=硬失败，Write() 授权可生长 scope
- qwen-code：serve 守护进程带真 Seatbelt/Docker 沙箱；三层 AUTO 分类器 fail-closed
- openhands：SecurityAnalyzer 可插拔 fail-safe（无分析器=UNKNOWN=确认）
- gemini-cli / openclaw / codebuddy：沙箱后端族
- mistral-vibe / opencode / pi / kimi / zcode / mini-swe：**无 OS 沙箱**（pi 的理由：「partial sandbox would be easy to misunderstand as a security boundary」）

**裁决**：

| 项 | 判定 | 证据 |
|---|---|---|
| 策略判定层（lattice/分类器/指令路径保护/泄密扫描/Unicode 清洗） | **超过基准最优** | §1 治理晶格+判定链。25 家中没有一家把"不可见字符清洗→分类→负能力→指令路径→prediction 绑定→泄密扫描"串成单条 fail-closed 链；qwen-code 的三层 AUTO 是最接近者，但它是 LLM 分类器（我们是确定性优先、LLM 只许收紧） |
| hooks 事件面 | **有，但窄于 claude-code** | 8+1 事件 vs ~30 事件；无 HTTP/MCP handler 类型、无 appendContext 语义。但门钩子的"agent 不可达 operator 私有文件"边界设计是 25 家中对自我否决问题最干净的回答 |
| **前台 OS 沙箱** | **缺口（已自承）** | sandbox.js 头注释自承。基准 8 家有真沙箱（claude-code/codex/gemini/qwen-serve/devin/openhands/openclaw/codebuddy）。我方防线是判定层+写租约+workdir 边界，**对判定层漏过的命令没有第二道墙**——这是全部发现中唯一够格称 P0 的 |
| jobs 沙箱 | 有且真实 | wsl/docker/ssh 三后端 fail-closed，超过 vibe/opencode/pi（它们连 jobs 沙箱也没有） |

### 2.2 工具（tools）

**基准**：openclaw ~40 工具+profile 门控；roo-code ~24 工具+mode 工具组；qwen-code code-mode（模型写 JS 调 tools.<name>，30s）；opencode 模型族工具面（GPT-5 拿 apply_patch）；pi 8 个内建+create*Tool 远程接缝。

**裁决**：
- 我方注册工具实测 40+（§1 接线清单），含 browser CDP 族、委派、作业、任务邮箱、记忆、调度、目标协调、spec、repo_map、web 族、lazy 工具认领——**广度达标**。
- deny→hide 持久化 + mode overlay + lazy 三层表面治理，超过 opencode 的 deny-removes-tool（单层）。
- **缺口**：无 code-mode（qwen-code/hermes/opencode-experimental 三家有）。重审结论：3/25 的少数派，且与我方确定性判定链哲学冲突（让模型写代码调工具=把判定面换成 JS 沙箱面），**维持拒绝，但理由必须是"哲学冲突+少数派"，不是"业界没做"**——业界有三家做了。
- **缺口**：无模型族工具面分化（opencode 给 GPT-5 换工具集）。1/25，可忽略。

### 2.3 记忆与上下文（memory & context）

**基准**：aider repo-map（tree-sitter tags→PageRank→token 预算二分）；roo-code Qdrant 向量索引（opt-in，**全语料唯一真向量代码索引**）；openhands 9 种 condenser；opencode shadow-git 快照+40k 剪枝；openclaw 记忆向量行（仅记忆非代码）+ prompt 前缀缓存工程；claude-code 自动记忆；workbuddy 夜间记忆提取。

**裁决**：

| 项 | 判定 | 证据 |
|---|---|---|
| 持久记忆 | **达标且部分超过** | SQLite+FTS5+写前泄密扫描+双作用域——写前扫密钥这一点 25 家基准中未见第二家 |
| **repo_map** | **明确劣于 aider** | repomap.js 自述「No PageRank, no tree-sitter — the honest v1」：正则提取 10 种声明模式、400 文件/深度 8/12k 字符封顶。aider 是 tree-sitter tags+引用图+PageRank+预算二分。这是被告也认账的差距，**但"够用"的说法没有证据支持——没有任何基准测试证明正则版达到了 PageRank 版的多少成** |
| 向量索引（拒绝项重审） | **拒绝维持** | 25 家中仅 roo-code 一家有真向量代码索引（且 opt-in）；trae 的 code index 机制 NOT FOUND（DOCS-ONLY）；codex **退役**了 codebase indexing 转本地 trigram grep。changelog 层 vector/embedding 命中主要在 continue/zed/qwen-code/openclaw（多为记忆或实验面）。1 家采用+1 家退役，不构成采用压力 |
| compaction | 达标 | 手动+自动+COMPACT_BEFORE/DONE/FAILED 全审计；世界模型投影走 context seam 每轮重注入（loop.js 注释说明为何不选 instruction 突变路线——这个论证是对的） |
| 快照/rewind | **部分超过基准** | 三作用域 rewind（chat/files/both）+fileops 回执撤销+restore 自身可恢复。对比：zcode 双轴独立+外部改动不覆盖（我们 restore 前先回收现字节=同等语义）；vibe fork-rewind 带文件恢复（同等）；opencode/roo-code shadow-git（我们无 git 依赖是刻意，但意味着**非 fileops 通道的外部改动不在 rewind 射程内**——opencode 的 write-tree hash 能感知，我们不能） |

### 2.4 编排（orchestration）

**基准（本次 changelog 原文复核过的投票）**：
- Cursor Projects：协调器→上千 subagent，subagent 在各自 VM（cursor/items.jsonl:9-10,39-40 ✓）
- Kiro Crew 0.6.0：harness 选择（Claude Code/Codex/KAS）+远程 crew+dispatch worker+monitor 循环+2h 计划上限（kiro/items.jsonl:29-42 ✓，比研究时点更强）
- ZCode v3.14.0 动态工作流（zcode/items.jsonl:11-12,31-32 ✓，晚于研究时点——**研究已过时**）
- Hermes Bot Mode v2026.9.11（hermes/items.jsonl ✓）
- KAOS fleet-adapter hooks + Security Audit Swarm（kaos/CHANGELOG.txt:110,491 ✓）
- Devin Dynamic Workflows（确定性 Python `agent(prompt,schema=)`/pipeline/parallel/hash 续跑）+ Managed Devins（devin/items.jsonl ✓；"Code Scans" 标签复核未找到，已改用实质描述）
- openhands delegate=子 controller 共享 stream/metrics/budget

**裁决**：
- 我方有：delegate_task（durable job 化+预算门+任务邮箱+profile 信任门）、goal_coordinator（调度唤醒+证据门控）、task 邮箱族。**单委派链是实的，且委派预算是 25 家中少见的硬门**。
- **缺口（P1）**：无协调器-工人编队。6 家基准已在原始记录中确认该方向（其中 ZCode v3.14.0 晚于我们的研究快照——业界在我们写结论后继续前进）。我方 delegate 是一次性桥，无常驻 worker、无编队级预算/监控、无远程执行面（jobs 的 ssh 沙箱后端只到命令级，不到 agent 级）。
- **这是全部发现中第二严重的**：不是因为"别人有我们没有"，而是 6/25 的投票密度说明**长任务的行业答案正在从"单 agent 硬撑"转向"编队"，而我方 continuation 证据门（8 次封顶）本质上是单 agent 路线的加固**。

### 2.5 会话基底（session substrate）

**基准**：pi session-as-tree（parentId 链+叶指针）；opencode log-as-queue；openhands event-sourced 全量（密钥清洗后持久化）；mini-swe trajectory==context 每步落盘（finally 保证）；zcode 任意 assistant 消息分叉。

**裁决**：
- session 树+分叉+搜索+导出+ephemeral：达标（channel.js session_* 族 + UI 消费实测）。
- 审计流：GOVERNANCE_ASK/HOOK_FIRE/SHADOW_JUDGE/MODEL_FALLBACK/BUDGET_* 等事件种类超过多数基准的可观测面。
- **缺口**：无事件溯源级重放（openhands 可以把整个 session 从事件日志重建）。我方审计是 append-only 记录，不是可执行的事件源。1/25 的重度实现，不补课，但要在文档里停止暗示审计流≈事件溯源。

### 2.6 可扩展性（extensibility）

**基准**：gemini-cli 单 manifest 扩展包（最宽装载面）；qwen-code 转换器吃进 Claude Code 插件+Gemini 扩展；roo-code marketplace；claude-code plugins+marketplace；zed ACP 生态；kiro Powers；vibe 外来 hooks 兼容（Claude Code+Kimi 格式）。

**裁决**：
- 我方：managed extensions（manifest sha256 装载）+ 宏/slash + 自著 skills（microagents/plans 信任门）+ MCP 零依赖客户端（`pi/extensions/mcp/index.js` 实测存在）。
- **市场方向维持拒绝**：roo/claude-code/gemini 的市场是供应链面；zcode 甚至刻意忽略项目级 hooks（同一理由）。我方信任门（isTrusted）回答了同一问题。**拒绝成立，且有一家基准（zcode）用工程决策投了同方向的票**。
- **ACP 缺口（P2）**：基准 ACP 采用者约 9 家（zed/gemini-cli/vibe/openclaw/opencode?/devin Canvas/kiro/qoder/codebuddy 方向）。changelog 层 ACP 命中 3733 次/43 文件——这是**生态互操作投票**，密度远超向量索引。我方 HostChannel 是私有协议，桌面单面。拒绝理由（M6 边界：UI 是 host 的消费者）对内成立，但**对外互操作的代价在 changelog 投票密度里有客观证据，不能再说"业界也没收敛"**。
- dsh 侧：compaction 事件已映射（channel.js:216-220），session_compact/entries 未投影且**如实标注 fail-closed 不造假**（channel.js:25 注释）——这个诚实标注本身符合纪律，记为正面。

### 2.7 Agent 循环（agent loop）

**基准**：mini-swe exit-via-stdout 哨兵+interrupts-as-exceptions+每步 finally 落盘；vibe middleware 管线（STOP/INJECT/COMPACT/CONTINUE 六件）；openclaw 双层循环+6 种 tool-loop 法医学；opencode MAX_STEPS 只劝不杀+doom_loop 3→ask；openhands 5 启发式卡住检测；qwen MAX_TURNS=100 硬顶。

**裁决**：
- 我方：回合上限（PAI_MAX_TOOL_CALLS=100）+continuation 证据门（maxContinuations=8/noProgressLimit=3）+loopwatch 3 检测器+错误连停闩+stale agent_end 防御。
- **loop 法医学：3/6**。OpenClaw 的 generic_repeat/argument_churn/unknown_tool_repeat/known_poll_no_progress/global_circuit_breaker/ping_pong 六种里，我方覆盖同签名重复（≈generic_repeat）、乒乓、错误连击；**缺 argument_churn（同工具不同参数原地打转）、unknown_tool_repeat、global_circuit_breaker**。其中 argument_churn 是最常见的真实翻车模式，值得补。
- 「只劝不杀」（opencode MAX_STEPS）vs 我方硬顶：硬顶+operator 升级通路在治理语义上更严，不算缺口。

### 2.8 LLM 集成（LLM integration）

**裁决**：provider fallback 链（审计每跳+hops 封顶+同任务只消耗一次）+模型 ping 连通性测试（C12）+TURN_ACCOUNTING/前缀缓存破坏检测（providerAuditExtension）+egress 域名门。**fallback 链超过多数基准**（多数 CLI 失败即终）；缓存工程弱于 openclaw（其 SYSTEM_PROMPT_CACHE_BOUNDARY 可重定位区域，我们只有破坏检测没有主动布局）。

### 2.9 界面（interface）

- 桌面单面 vs 基准的多面（gemini 6 面、openclaw ~30 频道插件、zcode 手机遥控/微信/飞书）：**形态差异，不是缺陷**——但 changelog 层频道方向的投票密度（openclaw 一家 releases.jsonl 93 条命中 ACP/频道族）说明"agent 触达面"是业界主战场之一，我方单面是刻意边界，文档应停止用"桌面优先"粉饰，直接写"单面，无频道战略"。
- UI 消费面实测良好（§1），但发现四处**后端有、UI 无入口**：`budget_status`、`instance_inventory`、`monitor_add/list`、`handoff_prepare/export/release`（仅 supervisor 内部用 handoff_prepare）。按纪律记为"机制存在、产品面未交付"。

## 3. 与 FEATURE_AUDIT 的冲突清单（不改写旧文档，仅在此标注）

| # | FEATURE_AUDIT 所述 | 源代码实测 | 冲突性质 |
|---|---|---|---|
| C1 | §35「无 hooks、无 MCP 客户端」（及 §95/§146/§268/§321 多处重复） | `host/src/core/hooks.js`（8+1 事件 fail-closed 门）与 `pi/extensions/mcp/index.js`（stdio+HTTP 客户端）**均已存在** | 旧文档**过时**，产品比它所述强 |
| C2 | §288-289「无 repo-map」 | `host/src/core/repomap.js` + `repo_map` 工具+UI 入口均存在（但弱于 aider） | 旧文档过时，但新实现仍是"honest v1"，**不可反向夸大为达标** |
| C3 | §99「缺 cron/Monitor」 | `scheduler.js`+`monitor.js`+`schedule_list/monitor_*` 命令存在（UI 仅 schedule_list 有入口） | 旧文档过时 |
| C4 | §35「managed extensions 当前空」 | mcp 扩展已装载 | 旧文档过时 |
| C5 | §27/§85/§167/§232/§312/§340 等处「无 OS 沙箱」 | 前台仍无（缺口成立），但 **jobs 沙箱（wsl/docker/ssh）已存在**，旧文档未记 | 各打五十大板：缺口真，记录不全 |
| C6 | §117 向量索引「拒绝方向一致」 | 本次重审确认：roo-code 唯一真采用+codex 退役，拒绝**维持** | 无冲突，但旧文档未提 roo-code 这个反例的存在 |
| C7 | 旧文档多处暗示审计流≈可观测性完备 | 无事件溯源级重放（openhands 标准） | 措辞冲突：应在旧文档停止该暗示（本次不改写，仅标注） |

## 4. 发现排序（无情版）

- **P0-1 前台工具路径无 OS 沙箱**。8 家基准有真沙箱。我方全部防线是判定层单层：一旦 tree-sitter 分类+晶格+泄密扫描的组合被绕过（新型混淆、解释器内嵌、分类表未覆盖的命令名），**写租约和 FileOpsGuard 都是事后机制，挡不住进程级破坏**。代码头注释已自承。win32 上没有 Seatbelt/Landlock 等价物是事实，但 devin 在 Windows 上的答案是"硬失败"，我们的答案是"放行+审计"——这个取舍必须在产品文档里明说，不能藏在头注释里。
- **P1-1 无协调器-工人编队**。6 家 changelog 投票（含晚于研究快照的 ZCode v3.14.0），方向明确。我方 continuation 证据门是单 agent 路线的精美加固，但业界在用编队回答长任务。
- **P1-2 repo_map 是正则 v1，且没有任何证据表明它够用**。aider 的 PageRank 版是基准最优；「honest v1」的诚实值得肯定，但诚实不是够用的证据。要么补 tree-sitter+排序，要么做一次对照实验给出"够用"的数据。
- **P2-1 ACP 缺席**。~9 家采用、changelog 3733 次命中。对内边界成立，对外互操作代价有客观投票证据。
- **P2-2 loop 法医学缺 argument_churn/unknown_tool_repeat/global_circuit_breaker**（OpenClaw 6 种中的 3 种）。argument_churn 优先。
- **P2-3 四处后端命令无 UI 入口**（budget_status/instance_inventory/monitor_*/handoff_*）。机制白做了一半。
- **P3-1 前缀缓存只有破坏检测，没有主动布局**（openclaw 有 cache boundary 工程）。
- **P3-2 审计流非事件溯源**，文档措辞需收敛。

## 5. 被告证词复核结论

本地文档（FEATURE_AUDIT 等）的总体方向——「治理骨架对等甚至更深，功能面有缺口」——**在源代码层面成立**，且本次发现它在 hooks/MCP/repomap/cron 四项上**低估了产品**（文档过时方向对被告不利，即被告比自己说的更强）。但「没有 OS 沙箱所以靠判定层等价防护」这一类暗示，在 8 家基准的 OS 沙箱事实面前不成立：判定层与 OS 沙箱不是等价物，是不同层。所有把"单层更深"表述为"与多层等效"的句子，都是被告证词里需要打折的部分。

**审查完毕。基准：25 份研究（实有数）+ 36 目录原始更新记录；产品：23 个核心文件逐行精读 + 2 个 UI 大文件 grep 验证。本文档与 FEATURE_AUDIT.md 并存，冲突以本文件 §3 清单为准。**
