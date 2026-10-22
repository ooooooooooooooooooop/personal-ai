# AGENTS.md — 本仓库浏览与改动导航

这份文件给**进入仓库的代理/协作者**一个最快的心智模型：这里有什么、哪些能碰、哪些绝不能碰、改动会被哪些检查拦截。详细契约见 [`docs/architecture.md`](./docs/architecture.md)。

## 一句话

这是 **Personal AI 公开发布仓**（机制层：Skill 包 + MCP 发行包 + DSH 插件包 + 质量脚手架；认知层：`soul/` 可携带认知状态 + `mind/` 认知维护工具链 + `host/` 可执行控制宿主），**不是运行时工作区**。根目录 top-level 目录属于下列分层之一。

## 分层目录（改动前先认层）

| 层 | 目录 | 可否改动 | 改动要点 |
|---|---|---|---|
| ① Skill 包 | `skills/<name>/` | ✅ | 必须登记在 `skills.json`（**条数以 `skills.json` 为准，不在此写死** —— 写死的数字会随包增减静默过期，而"个数"这类断言没人会去核）；布局统一 `SKILL.md + agents/openai.yaml + examples/*.md` |
| ② MCP 包 | `mcp/<name>/` | ✅ | 登记在 `mcp.json`；自持子目录许可证 |
| ③ DSH 插件包 | `dsh/<name>/` | ✅ | 本地 DSH 用户级插件：源码 + 可移植 `cordis.patch.yml` 片段 + README 一起发布；不设注册表，校验器不核对 manifest，靠链接/markdown 检查兜底；发布内容禁止含本机路径；`dsh/adapter/` 是 PAI 侧 DSH 身体适配器（依赖方向 dsh → host），`dsh/tests/` 为 L4 契约 + L5/L6 切换演练。**包内只放适配器（`mjs`/`js` + `json` + `md` + `yml`）；harness 无关的工具链不放这里** |
| ④ 质量脚手架 | `scripts/` `tests/` `docs/` `_template/` `.github/workflows/`（`skill-quality-gate` 是 ① 中的 Skill 包，位于 `skills/skill-quality-gate/`） | ✅ | 改 `validate_repo.py` 会影响全部上层契约，谨慎 |
| ⑤ 设备运行层 | `.taskflow/` `.grepai/` `.claude/` `node_modules/` 等 | ❌ 禁改/禁提交 | 本地运行态，发布门禁拒绝 |
| ⑥ soul/ | `soul/`（`manifest.json` `schema/` `briefing/` `models/` `bootstrap/`） | ✅ | Personal AI 可携带认知状态：通用 L2/L3 脱敏模型 + schema 契约 + briefing 模板 + adopter 骨架；内容只能来自 declassification 链产物或为公开编写的模板，私有 canonical/L0-L1/未脱敏模型禁入；`manifest.json` 是发布锚。**只放状态，不放运作机制**（机制在 `mind/`） |
| ⑦ mind/ | `mind/` | ✅ | **认知状态的维护工具链**（**完整清单以 `mind/README.md` 为准，不在此写死条数**）：A `distiller` · B `hypothesis_search` · C `lp_evaluator` · D `u1_accept`（唯一 canonical 写者）· 编译 `canonical_compile` / `instruction_compile` · 学到的先验 `reversibility_compile` · 周期入口 `wm_cycle` / `distill` · 迁移 `migrate_v031` · 契约测试台 `bcc_check` + `simulate_body.mjs`。**harness 无关**（入参全是目录路径）；**在 agent 权限之外**（宪法：agent 不得写 canonical）。与 `soul/` 配对但不同类：soul 回答"它信什么"，mind 回答"它怎么变"。运行时协议不在这里，在 `skills/world-model-runtime/` |
| ⑧ host/ | `host/` | ✅ | Personal AI 中立控制宿主（`docs/pi-migration-design.md`）：**零外部依赖**，全目录禁止 import 任何身体/harness（`host/tests/firewall.test.js` 机械执行）；运行态写 instance root 禁入仓 |
| ⑨ pi/ | `pi/` | ✅ | Pi 身体实现：adapter（Pi API ↔ host 契约）+ bootstrap（唯一 composition root）+ managed extensions；依赖方向恒为 `pi → host`；pin `@earendil-works/*@0.85.1`，lockfile 属 runtime identity |
| ⑩ app/ | `app/` | ✅ | Personal AI 自有用户界面层：server（BodySupervisor 多身体组装根 + 零依赖 HTTP/SSE 桥）+ ui（零构建轻量网页，旧版入口 `app/ui/app.js`）+ src（Vite + React 新版前端，入口 `app/src/main.jsx`，组件按 `chat/composer/sidebar/topbar/views` 分域）+ desktop（Electron 壳）；**产品级组装根，可同时知道 pi/dsh 入口**；用户经 `body_select` 显式选身体，有会话时走真七态 handoff；`host/` 依然不 import 任何身体 |

## 硬约束（改目录结构的红线）

1. **Skill 统一收在 `skills/<name>/` 下**。`scripts/validate_repo.py::discover_skill_dirs()` 识别 `skills/` 子目录里含 `SKILL.md` 的目录（为兼容也认可根目录平铺的旧包）。新增 Skill 放进 `skills/` 并登记到 `skills.json` 的 `path`（`./skills/<name>`）；两处不同步会让 `--strict` 判 FAIL。
2. **两个注册表必须与目录一致**：`skills.json` ↔ `skills/*`；`mcp.json` ↔ `mcp/*`。校验器逐一核对。
3. **发布门禁**：`git diff --check`、`python scripts/validate_repo.py --strict`、`python skills/skill-quality-gate/scripts/quality_report.py --root . --strict`、仓库回归、MCP 回归全绿才可合并。
4. **测试不得继承部署挂载**：`host` / `pi` / `dsh` 三个套件的 `test` 脚本都带
   `--import ./tests/scrub-env.mjs`（`pi` / `dsh` 复用 `host` 那一份，不复制）。**这不是"让测试变绿"**：
   本机若有 `WORLD_MODEL_HOME`（这正是挂载 canonical 的**文档写法**），未隔离的测试会把
   `canonicalDir` 解析到**真实 canonical**，任何启动时的编译/写入都会落到受治理状态里。
   新增测试套件照此办理。删掉它 → 会出现一整片红（`WORLD_MODEL_HOME is set…` 或 attestation 失败），
   而那只是征兆，**根因是测试在动真数据**。

## Project Facts 与禁忌检查（真实物理底座）

架构事实与传感器基准见 [`docs/project-facts-spec.md`](./docs/project-facts-spec.md)。
- **不可逆操作前核对**：在执行涉及写库、修改注册表、跨身体切换或删除持久数据等不可逆操作前，**必须先阅读 [`FAILURES.md`](./FAILURES.md)**，核对相关已知禁忌并运行对应的退出码验证命令。
- **事故即记账（观察窗口的观测器）**：一旦发生 `FAILURES.md` 未覆盖、且代价 > 1 小时或不可逆的事故，**当场追加一行**（症状 | 根因 | 禁忌动作 | 验证命令 | commit SHA）。此义务不可省：没人记录，两周观察期必然得到「零条」，那是观测缺失，不是假设被证伪。
- **承载物与门禁成本**：本节的 `AGENTS.md` 与 [`FAILURES.md`](./FAILURES.md) 已在 `scripts/gate_planner.py::KNOWN_PLAIN_FILES` 登记为根级普通文档，其改动只走 DELTA 计价；未登记的其他根级文件（`README.md` / `CONTRIBUTING.md` / `BOOTSTRAP.md`）仍按 `unknown:` 判 FULL 全量回归。**新增根级事实文档时须同步登记，否则维护它等于每次付 13 分钟门禁**（`b7059fe` 与 `c2516ab` 两次实测：787s / 807s）。
- **环境怪癖（沙箱 temp-root）**：Windows ACL 下 temp-root 若位于 workspace 内，子进程创建会被预检直接拒绝并返回空输出；此时缺输出并不代表二进制不存在，严禁盲目尝试重装。
- **环境怪癖（提交解释器）**：`.githooks/pre-commit` 与 `.githooks/post-commit` 里 `PY="${PYTHON:-python3}"` 只验证解释器可启动，**不验证依赖是否齐全**。系统默认 python 常缺 `pyyaml`，会让回归出现数十个 `No module named 'yaml'` 假失败。提交前显式指定：`PYTHON=<装有 pyyaml 的解释器> git commit ...`（本机为 anaconda 的 python.exe）。

## 改动后检查（按改动范围精准执行，禁止无脑全跑）

### 1. 模块级局部检查（日常开发只跑改动层，严禁跨层空耗）

- **仅改动 `app/`（前端 UI、组件与工作台）：**
  ```bash
  npm --prefix app run lint                         # UI 样式与 HTML 校验
  npm --prefix app test                             # supervisor + 离屏 Electron DOM/Axe 门禁
  ```
- **仅改动 `host/`（中立控制宿主）：**
  ```bash
  npm --prefix host test                            # host 契约与零依赖防火墙
  ```
- **仅改动 `dsh/`（DSH 身体适配器）：**
  ```bash
  npm --prefix dsh test                             # L4 契约与 L5/L6 切换演练
  ```
- **仅改动 `pi/`（Pi 身体适配器，改了它才跑它）：**
  ```bash
  npm --prefix pi test                              # pi 侧边界与底层能力回归（耗时较长）
  ```
- **仅改动 `skills/`：**
  ```bash
  python skills/skill-quality-gate/scripts/quality_report.py --root . --strict
  ```
- **改动了结构、注册表或基础脚手架：**
  ```bash
  python scripts/validate_repo.py --strict
  git diff --check
  ```

### 2. 发布合入门禁（仅在整仓发版或 PR 合并前全量执行）

```bash
python scripts/validate_repo.py --strict
python skills/skill-quality-gate/scripts/quality_report.py --root . --strict
python -m unittest discover -s tests -v
npm --prefix host test
npm --prefix pi test
npm --prefix dsh test
npm --prefix app test
npm --prefix app run lint
git diff --check
```

## 本地缓存与运行态（当前仓库的"大块头"）

- `mcp/agent-switchboard/_sdk_probe_deps/` 曾放 Claude Agent SDK 缓存（约 360MB，含打包的 claude.exe）。**已移到** `~/.cache/agent-switchboard-sdk/`，`claude_sdk_backend.py` 从那里探测（可用 `AGENT_BROKER_CLAUDE_SDK_DEPS` 覆盖）。仓库不应再出现这种大体积缓存目录。
- 任何 `state.sqlite`、`.jsonl`、`.log`、用户路径、会话/任务 ID、模型/认证信息都是运行时态，**禁止**由 `mcp.json` 或 CI 校验放行到发布集。

## 本地经验与跨设备复用入口（新会话/新设备先读这里）

本仓库既是浏览导航，也是**本地特有经验的事实源**。新会话或新设备上第一个会话，先按此索引直达，不重复发明：

| 文档 | 用途 |
|---|---|
| [`BOOTSTRAP.md`](./BOOTSTRAP.md) | **唯一入口种子**：新设备/新会话把一句"读取 BOOTSTRAP.md，自主配置这台电脑"交给 Agent 即可，安装/更新/恢复/同步意图全部固化在内 |
| [`docs/sync-ongoing.md`](./docs/sync-ongoing.md) | **优化→同步闭环 SOP**：日常优化流程、跨设备首次/增量同步、各层 SSOT 归属 |
| [`docs/publishing.md`](./docs/publishing.md) | 可发布性矩阵（哪些包能进哪些市场）+ 发布检查清单 |
| [`docs/local-experience-and-cross-device-reuse.md`](./docs/local-experience-and-cross-device-reuse.md) | 本地特有经验全景总结（治理/插件/技能/证据链）+ 业界做法对照 |

跨设备同步工具：`scripts/sync_skills.py`（技能栈）、`skills/dsh-config-sync`（配置骨架，含 `--template` 路径适配）、`scripts/publish_check.py` / `scripts/run_skill_evals.py`（发布与质量门禁）。凭据纪律：同步/发布永远只带环境变量名引用，`.credentials.yaml` 与运行态绝不出包。
