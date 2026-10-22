# Personal AI 发布仓

> 定位：**Personal AI 公开发布仓**——`mechanisms`（Skill/MCP/DSH 插件 = 身体适配器与执行机制）+ `soul/`（可携带认知状态：通用 L2/L3 模型 + schema 契约 + briefing 模板 + adopter 骨架）。每次发布 = 一次认知模型更新，由 `soul/manifest.json` 锚定。私有 canonical/L0-L1/未脱敏模型永远不进本仓。

> **用一句话配置这台电脑（唯一入口）** — 把下面这句原样发给本机 Agent：
>
> **读取 <https://github.com/ooooooooooooooooooop/personal-ai/blob/main/BOOTSTRAP.md>，自主配置这台电脑**
>
> 安装 / 更新 / 恢复 / 同步的全部意图都固化在 [BOOTSTRAP.md](./BOOTSTRAP.md)：没装 Skill 会自动 bootstrap 并恢复全量环境，已安装会自动判定同步方向；用户无需知道任何 Skill 名、Git 命令或同步细节。

面向本地 Agent 工作流的可复现仓库。机制层发布三类项目，认知层发布 `soul/`：

- **Skills**：Agent 读取的流程、规则与确定性辅助脚本。
- **MCP servers**：提供实际工具调用能力的本地服务。
- **DSH 插件**：本地 DSH（DeepSeek Harness）用户级插件源码与跨设备安装说明。
- **soul/**：Personal AI 可携带认知状态（通用 L2/L3 脱敏模型 + canonical schema + briefing 契约 + adopter bootstrap 骨架），见 [soul/README.md](./soul/README.md)。

本地运行状态、私有记忆、会话记录、机器路径、配置文件和生成物不属于发布内容。

## MCP servers

| MCP | 简介 | 平台 | 许可证 |
|---|---|---|---|
| [chatgpt-web-bridge](./mcp/chatgpt-web-bridge) | ChatGPT 网页版桥：专用 Chrome profile + CDP 驱动，REST(:8080) 与 MCP SSE(:8090) 双通道；conv-affinity 单会话单 tab、账号级跨进程节流 | Windows | MIT |

MCP 的机器可读登记信息位于 [mcp.json](./mcp.json)。

### 安装 MCP

```powershell
git clone https://github.com/ooooooooooooooooooop/personal-ai.git
Set-Location .\personal-ai\mcp\chatgpt-web-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装器会登记本机 MCP host，因此应在确认目标设备后显式运行。它不会复制当前设备的 `state.sqlite`、会话或模型设置。

## Skills

| Skill | 简介 | 层级 |
|---|---|---|
| [simulate-elite-experts](./skills/simulate-elite-experts) | 模拟顶级专家视角，交叉质询并综合复杂决策 | 可选 |
| [unified-taskflow](./skills/unified-taskflow) | 管理真正复杂的多阶段任务，追踪锚点、检查点与验收 | 条件启用 |
| [decision-gates](./skills/decision-gates) | 为决策层加装五道防偏闸门：原始证据锚、对抗审计、一致性校验、成本比对与防御自检 | 可选 |
| [clarify-before-change](./skills/clarify-before-change) | 在修改前澄清范围、风险、假设与验收标准 | 核心 |
| [task-mode-router](./skills/task-mode-router) | 按任务规模与风险选择执行深度 | 核心 |
| [natural-rewrite](./skills/natural-rewrite) | 在保持事实、语气和含义的前提下自然改写文本 | 可选 |
| [minimal-implementation](./skills/minimal-implementation) | 以最小正确改动完成任务并提供可复核证据 | 核心 |
| [skill-repository-maintainer](./skills/skill-repository-maintainer) | 审计、验证并安全同步 Skill 包 | 核心 |
| [environment-bootstrap](./skills/environment-bootstrap) | 恢复 Codex Skill 环境并校验文件哈希 | 核心 |
| [skill-quality-gate](./skills/skill-quality-gate) | 评估 Skill 的触发边界、输出契约与回归质量 | 核心 |
| [execution-discipline](./skills/execution-discipline) | 在长程会话中强制五条执行纪律：零轮询、门禁自修、窄探针、委派探查与进度回报 | 核心 |
| [find-session](./skills/find-session) | 按对话标题或正文关键词快速定位 DSH 历史会话并读取内容/token 统计 | 可选 |
| [subagent-execution-governance](./skills/subagent-execution-governance) | 子代理契约型治理：探查/实现分离、契约快照含负空间、三级有界读取、行动门槛与结构化 BLOCKED，附会话纪律体检脚本 | 条件 |
| [dsh-config-sync](./skills/dsh-config-sync) | 把 DSH 用户配置打包成脱敏骨架并在设备间安全同步恢复，校验哈希且不含凭据 | 可选 |
| [systematic-optimization](./skills/systematic-optimization) | 系统化问题解决与优化流程（领域无关）：量化→列问题→根因→结构性方案→借鉴→取舍→实施→验证→度量 | 可选 |
| [evolution-proposal](./skills/evolution-proposal) | 把 evolution-inbox 审计异常转化为可评审的进化提案：证据驱动、分级处理、人工批准后固化 | 可选 |
| [publish-and-reuse](./skills/publish-and-reuse) | 完整发布与跨设备复现一体化流程：一键发布门禁（`scripts/publish_all.py`）、三平面同步、新设备安装/更新 SOP | 核心 |
| [research-lab](./skills/research-lab) | 把模型比较等可证伪问题转化为可恢复、可复现且证据可追溯的研究 | 可选 |
| [personal-ai-operations-review](./skills/personal-ai-operations-review) | 对进入运维态的 Personal AI 基础设施做只读复查，区分 NO ACTION/REVIEW/ACTION REQUIRED/EXTERNAL BLOCKER，不为变绿静默改 canonical | 可选 |
| [chatgpt-web-bridge](./skills/chatgpt-web-bridge) | 经 chatgpt-web 的 MCP/REST 桥接入已登录的 ChatGPT 网页版：推进/指挥循环/对等协作/只读拉取四种模式，conversation_id 专线续接 | 可选 |
| [world-model-runtime](./skills/world-model-runtime) | 在重要任务上运行持久世界模型闭环，自判 OFF/CORE/FULL 形式化深度 | 条件启用 |

Skill 安装 profile 定义在 [skills.json](./skills.json)。

### 安装 Skill

```bash
npx skills add https://github.com/ooooooooooooooooooop/personal-ai --skill <skill-name>
```

## DSH 插件

本地 DSH（DeepSeek Harness）用户级插件，随仓库发布源码与安装说明。

| 插件 | 简介 | 目标 profile |
|---|---|---|
| [token-saver](./dsh/token-saver) | 子代理 fork 不再全量复制父会话，注入「摘要 + 最近 1 轮」控上下文 | 任意已安装 profile |
| [subagent-usage-observer](./dsh/subagent-usage-observer) | 从子代理会话日志查询模型、token、工具与保守状态判定 | 任意已安装 profile |
| [subagent-splice-summarizer](./dsh/subagent-splice-summarizer) | 有损压缩超长子代理文本报告，同时保留非文本块 | 任意已安装 profile |
| [model-persona](./dsh/model-persona) | 按当前 agent 的具体模型自动注入官方来源的行为 steering（防过度思考/过度工程/跑偏） | 任意已安装 profile |

DSH 插件不设注册表；包内 `README.md` 提供跨设备安装步骤，发布内容不含本机路径。

## 仓库结构

根目录按下列分类组织。第 ①–⑩ 类随仓库发布；设备运行层**永远仅存在于本地，不进入发布**。

```text
# ① Skill 包（统一收在 skills/ 下，受 skills.json + validate_repo.py 契约约束）
skills/<name>/           # 每目录一个 Skill 包，含 SKILL.md，必须登记在 skills.json（path=./skills/<name>）
                         # 布局统一：SKILL.md + agents/openai.yaml + examples/*.md

# ② MCP 源码发行包
mcp/<server-name>/       # 可独立验证的第三方/修改版 MCP 包，自持子目录许可证
                         # 登记在 mcp.json（入口、版本、平台、上游基线）

# ③ DSH 插件包
dsh/<plugin-name>/       # 本地 DSH 用户级插件：插件源码 + 可移植 cordis.patch.yml 片段 + README
                         # 不设注册表；发布内容禁止含本机路径/运行态

# ④ 质量与发布脚手架
scripts/                 # 仓库级校验（validate_repo.py）与 Skill 同步（sync_skills.py）
tests/                   # 仓库级回归测试
docs/                    # 架构与发布规则（architecture.md / skill-contract.md / sync-and-release.md）
.github/workflows/       # CI：严格校验 + Skill 门禁 + markdown/py 语法 + 回归测试
_template/               # 新建包的模板种子（validate_repo 显式排除，非 Skill）

# ⑤ soul/ — Personal AI 可携带认知状态
soul/manifest.json       # 发布锚：soul_version/schema_version/模型清单/release{tag,content_commit,payload_digest}
soul/schema/             # canonical 结构契约（对应 mind/migrate_v031.py 强制字段集）
soul/briefing/           # briefing 编译输出契约（7 段 + 容量/裁剪规则；mind/canonical_compile.py 是唯一生成者）
soul/models/{l2,l3}/     # 通用脱敏认知模型（declassification 链产物）
soul/bootstrap/          # adopter 起点包：canonical 骨架 + 仅初始化用种子
                         # 边界：内容只能来自 declassification 链或公开模板；私有 canonical/L0-L1 禁入
                         # 边界：只放状态，不放运作机制（机制在 mind/）

# ⑥ mind/ — 认知状态的维护工具链（harness 无关；在 agent 权限之外）
mind/distiller.py        # closed episodes → evidence packet → MODEL_PROPOSAL
mind/hypothesis_search.py# problem object → H4 算子库 → 判别 probe
mind/u1_accept.py        # U1 governed apply：唯一 canonical 写者（proposal → canonical）
mind/canonical_compile.py# 编译 briefing.md（GENERATED，不可手写）+ runtime-state.json 投影
mind/lp_evaluator.py     # Learning Progress 只读评估（无 canonical 写权）
mind/migrate_v031.py     # canonical schema 1.0→1.1 迁移/回滚/verify
mind/bcc_check.py        # BCC-1 身体兼容契约测试台（+ simulate_body.mjs 模拟体）
                         # 边界：不属于任何身体；状态在 soul/，本目录只放"它怎么变"

# ⑦ host/ — 中立控制宿主
host/src/core/           # 契约与机制：contracts/instance/audit/manifest/loaders/governance kernel
host/src/app/            # createHostCore() 组装
                         # 边界：零外部依赖；全目录禁止 import 任何身体（firewall.test.js 机械执行）

# ⑧ pi/ — Pi 身体实现
pi/src/adapter/          # Pi API ↔ host 契约
pi/src/bootstrap/        # 唯一 composition root（host.js）
pi/bin/                  # pai-channel.js（app 生成的身体入口）
                         # 边界：依赖方向恒为 pi → host

# ⑨ app/ — 自有用户界面层
app/server/              # BodySupervisor 多身体组装根 + 零依赖 HTTP/SSE 桥
app/ui/                  # 零构建网页（对话 + 身体面板）
app/desktop/             # Electron 壳
                         # 边界：产品级组装根，可同时知道 pi/dsh 入口

# ⑩ 其他被跟踪的顶层目录（不在 AGENTS.md 的分层表中，性质待归位）
dsh-config/              # DSH 配置骨架（跨设备同步用；profiles/patches 的仓库侧副本）
registry/                # 架构契约与登记（governance-policy / capabilities / execution-profiles 等 yaml）
research/                # 研究产出（agent-harness-survey-v1 / cognitive-leverage-pilot-v0）

# ⑪ 设备运行层（本地，永不发布；见 .gitignore）
.taskflow/  .grepai/  .claude/  node_modules/  state.sqlite  会话 JSONL  日志  用户配置  生成报告
artifacts/  output/  Users/  __pycache__/   # 生成物/运行态，已 gitignore
```

> ⚠️ **本节与 `AGENTS.md` 的分层表不完全一致**：AGENTS.md 有 10 层（含设备运行层），
> 且未收录上面第 ⑩ 类的三个目录。**权威定义见 [`AGENTS.md`](./AGENTS.md)**；
> 本节待与之一并对齐。

- **Skill 统一收在 `skills/` 下**：`scripts/validate_repo.py` 的 `discover_skill_dirs()` 识别 `skills/` 子目录里含 `SKILL.md` 的目录（为兼容也认可根目录平铺的旧包）。新增 Skill 放进 `skills/` 并登记到 `skills.json`，两处须同步。
- `skill-quality-gate` 同时是质量门禁脚本，但它本身是 ① 中的一个 Skill 包，位于 `skills/skill-quality-gate/`。
- 详尽的层级、状态边界、许可证边界与发布门禁见 [`docs/architecture.md`](./docs/architecture.md)。

## 验证

```bash
python scripts/validate_repo.py --strict
python skills/skill-quality-gate/scripts/quality_report.py --root . --strict
python -m unittest discover -s tests -v
```

## 许可证

- 仓库自有内容与 Skills：根目录 [MIT](./LICENSE)。
