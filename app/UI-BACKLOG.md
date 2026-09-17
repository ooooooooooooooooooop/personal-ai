# app/ui 细节施工单 — 对标 PI-Desktop

来源：`vastsa/PI-Desktop`（本机审计副本 `C:\Desktop\pai-eval\PI-Desktop`，LGPL-3.0 —
只抄交互与视觉决策，不搬代码）。逐项核过其 `features/chat/**`、`styles/*.css`、
`packages/i18n/zh-CN` 全部 250 条 chat 文案，并对照我们事件流的真实数据面
（pi `AgentEvent` + `AssistantMessage.usage/stopReason/errorMessage/thinking`）。

判定列：**可做** = 我们后端已有数据；**需后端** = channel/host 要补命令或事件；
**不做** = 与 Personal AI 边界冲突或依赖 PI-Desktop 独有子系统。

## 状态

- [x] 已落：R1 视觉系统（token/布局/气泡/卡片）、R2 行级工艺（工具行/滚动跟随/悬浮 composer/markdown/侧栏搜索）
- [x] **P0 产品骨架**（本轮，用户纠正后重排优先级——先"能用"再"好看"）：
  - channel 补全：`model_status/model_list/model_set/thinking_set/auth_set_key/auth_clear/provider_add`（含 `$ENV` 密钥引用）+ `session_list/session_new/session_switch/session_rename/session_history`
  - pi 侧：会话持久化到 `<instance>/sessions`（SessionManager.create）、会话切换=进程内 rebuildSession（同 guard/envelope/治理）、模型默认值持久化到 settings、auth.json 走 modelRuntime
  - supervisor：`set_workdir`（持久化 app-config.json + 身体原地重启）+ 切换期间阻断 session/model 写命令
  - UI：侧栏变会话列表（新建任务/搜索/日期分组/点击切换+历史回放）、设置页（提供方/密钥/推理强度/模型列表/自定义 OpenAI 兼容提供方/工作目录浏览）、composer 模型+推理 chip 下拉、无模型时 setup 引导卡接管空态
  - 实测打通：provider_add cpa → env 密钥 → model_set → 真 prompt → gpt-5.6-luna-max 回复 READY（usage 3365）
- [ ] R3–R8 见下（视觉/交互细节轮，按用户反馈排）

---

## A. 对话流（transcript）

| # | 细节 | PI-Desktop 做法 | 判定 | 轮次 |
|---|---|---|---|---|
| A1 | **思考块（Thinking）行** | 与工具行同形：✦ 图标 + "思考" + 一行摘要（灰）+ 展开看全文；流式时名字后脉冲点；`thinking_delta` 实时追加 | 可做（`message.content[].type==='thinking'`） | R3 |
| A2 | **消息 hover 动作栏** | 消息底部 `.message-actions`，hover 浮现：复制 / 重新生成 / 编辑并重发（用户消息）/ 删除 | 复制可做；重新生成=重发上一条用户消息可做；编辑/删除需后端会话改写 → 先只做复制+重新生成 | R3 |
| A3 | **消息元信息 chip** | assistant 消息下 `message-meta`：模型 id chip + "约 N tokens/s" 吞吐 chip | 可做（`message.model` + `usage.output` / 本地计时） | R3 |
| A4 | **回合状态行（processing）** | 运行中在最后一条下显示 "处理中 · 12s"，结束变 "已处理 12s"；子状态：等待模型响应 / 正在开始… / 正在压缩上下文… / 将在 N 秒后重试 | 计时可做；子状态需 loop 事件（`turn_start`/`message_start` 可推断前两个） | R3 |
| A5 | **活动组折叠（ActivityGroup）** | 连续多个工具调用折成一组："运行 · 5 个步骤 · 预览最后一条摘要"，展开为逐行；grid-template-rows 0fr→1fr 动画 | 可做（纯前端聚合） | R4 |
| A6 | **工具动作分类** | 按名字归类 read/list/search/write/edit/run/fetch/delegate/use，每类有专属图标 + 动词（"读取 / 正在读取"）+ 摘要键（path/command/pattern…） | 可做（抄 `getToolAction` 规则表） | R4 |
| A7 | **工具输出结构化块** | 展开体不是一坨 JSON：按类型分块 "命令 / 输出 / 错误输出 / 改动 / 文件 / 匹配"，带 chip "退出码 0 / 3 处匹配 / 已截断" | 部分可做（依赖 pi 工具 `details` 形状，先做 command/stdout/exit 与 diff） | R4 |
| A8 | **失败回合卡（TurnOutcomeCard）** | 回合异常结束：黄边卡 "这次任务需要处理一下 / 这一轮在完成前停下了，但已有内容都还在 · N 个步骤 · [继续]" | 可做（`stopReason` in error/length/aborted） | R4 |
| A9 | **回复错误详情** | `AssistantErrorMessage`：红字摘要 + "显示详情" 折叠（provider / model / 原文）+ 复制详情 | 可做（`errorMessage`） | R4 |
| A10 | **上下文压缩行** | 内联行 "上下文已压缩 · 第 N 次 · 摘要 ≈ N tokens" | 需后端（compaction 审计事件透传为 UI 事件） | R6 |
| A11 | **对话 minimap** | 右侧细条：每条消息一格，hover 显标题，点跳转 | 可做，低优先 | R7 |
| A12 | **显示更早的消息 / 分页** | 长会话按页加载 | 需后端（session 历史分页命令） | R7 |
| A13 | **委派子智能体拓扑** | Task 卡 + 子 agent 进度 "已完成 2/3" | 我们有 `delegate_task` 工具与 bridge usage；先按 A6 归 delegate 类展示，拓扑树后置 | R7 |

## B. Composer

| # | 细节 | PI-Desktop 做法 | 判定 | 轮次 |
|---|---|---|---|---|
| B1 | **待发送队列（queued prompts）** | busy 时发送 → 入队显示在 composer 上方一排卡：文本 + [立即发送(转向)] [编辑] [↑↓] [×] | 可做（前端队列 + `agent_end` 后自动 `prompt`；"立即发送" = `steer`） | R3 |
| B2 | **占位符双态 + 快捷提示** | 空态首页 "随便问问"，会话中 "让 … 帮你做任何事"；下方小灰字 "Shift+Enter 换行 · 点击发送提交" | 可做 | R3 |
| B3 | **运行中发送提示** | busy 时 composer 下方 "发送后续消息 · Ctrl+Enter 立即转向" | 可做 | R3 |
| B4 | **模型选择器** | 工具栏 chip "模型 ▾" → 搜索列表，badge "推理 / 视觉" | 需后端（`model_list` / `set_model` 命令；pi session 有 `setModel`） | R5 |
| B5 | **权限模式 chip** | "每次询问 / 允许编辑 / 全自动" | 对应我们的 **治理 ASK 通路**（见 D1），chip 只读显示 policy 态 | R5 |
| B6 | **推理等级 chip** | "推理等级 ▾" 高/中/低 | 需后端（`set_thinking_level`） | R5 |
| B7 | **@ 文件引用 / / 指令菜单** | 自动完成浮层：↑↓ 选择 · Enter 确认 · Esc 关闭 | `/` 指令可做（body_select、abort、jobs 等应用命令）；`@` 需后端文件搜索 | R6 |
| B8 | **粘贴大段文本存为 @附件** | 超长粘贴自动转附件 chip | 需后端 | 后置 |
| B9 | **拖入文件夹** | "拖入文件夹即可添加为项目 / 作为参考目录" | 我们无"项目"概念 → workdir 切换需后端 | 后置 |

## C. 侧栏 / 导航 / 壳

| # | 细节 | PI-Desktop 做法 | 判定 | 轮次 |
|---|---|---|---|---|
| C1 | **会话列表** | 分组：置顶 / 今天 / 昨天 / 近 7 天 / 近 14 天 / 更早；每行：标题 + 状态点（进行中/已完成/未完成）；hover 卡显示所属空间、更新时间 | 需后端（`session_list/switch/new` 命令 — pi 有 SessionManager 可挂） | R6 |
| C2 | **新建任务 / 搜索** 顶部图标钮 | topbar 右侧 ✎ 与 🔍；`Ctrl+K` 搜索会话与消息 | 新建任务需 C1；搜索先做当前会话内查找 | R6 |
| C3 | **侧栏折叠** | 折叠为 0 宽、topbar 出现展开钮；宽度记忆 | 可做 | R5 |
| C4 | **对话宽度拖拽把手** | 两侧把手拖改 `--chat-content-max-width`，记忆 | 可做 | R5 |
| C5 | **右键菜单（会话行）** | 重命名 / 置顶 / 归档 / 分支 / 复制 ID / 打开路径 / 删除（二次确认） | 依赖 C1 | R6 |
| C6 | **主题** | dark/light + 主题市场；`data-theme` 切换 token | dark/light 可做（token 已按其结构组织） | R5 |
| C7 | **窗口控件 / 无边框 titlebar** | 自绘最小化/最大化/关闭，`-webkit-app-region: drag` | 可做（Electron `frame:false` + `titleBarOverlay`） | R5 |
| C8 | **启动闪屏** | 淡出的 logo splash，遮住 supervisor 起身体那 ~5s | 可做，且我们真需要（body 起得慢） | R3 |
| C9 | **Toast 通知中心** | 右上 toast 栈 + 🔔 历史；"关闭通知" | 可做（替换现在塞进对话流的 sys 行） | R3 |
| C10 | **状态栏** | "就绪 / 部分可用 / 已连接 / 已断开 / 正在重新连接… / 连接已恢复" | 可做（SSE + supervisor 事件已有） | R3 |
| C11 | **更新横幅 / 版本** | 顶部 UpdateBanner | 无更新通道 → 不做 | — |
| C12 | **Onboarding 清单** | 首次运行：配模型 / 打开项目 / 发第一条 | 我们真需要：**凭据 provisioning 向导**（models.json/auth） | R8 |

## D. 治理 / Personal AI 独有面（PI-Desktop 没有，但它的容器可复用）

| # | 细节 | 借用容器 | 判定 | 轮次 |
|---|---|---|---|---|
| D1 | **治理询问卡（ASK 决策）** | 借 `PermissionCard`：dock 内浮卡 "允许 <tool> 运行吗？· 风险 高/中/低 · [允许一次] [允许本次对话] [拒绝] · 若 N 秒内未响应将自动拒绝 · 还有 N 个请求在排队" | 需后端（`governance_ask` 事件 + `approve/deny` 命令 — 已在 pending 清单） | R5 |
| D2 | **身体切换进度** | 现有 2px 进度条 + 七相卡 → 补每相耗时、失败相高亮、回滚提示 | 可做 | R4 |
| D3 | **上下文用量条** | 借 `ContextUsageInspector`：composer 内环形/条形 "已用 N / 窗口 N"，点开：输入/输出/缓存读写/推理/工具上下文/本轮合计/**成本** | 可做（`usage` 累计 + `cost.total`；窗口大小需 model 信息） | R4 |
| D4 | **审计视图升级** | 借设置页列表样式：按 kind 分色、可筛选（治理/租约/切换/计费）、展开看 payload | 可做 | R6 |
| D5 | **任务视图升级** | 状态点 + 相对时间 + 展开看 job payload/历史；running 脉冲 | 可做 | R6 |
| D6 | **身体卡：能力矩阵对比** | 借 MCP 市场卡：两身体并排，同一能力横向对齐，差异高亮 | 可做 | R7 |
| D7 | **租约/写者状态** | 侧栏底部小徽章 "canonical-writer · pi:b74f… · 续期 3s 前" | 需后端（`lease_status` 命令） | R7 |

## 不做（边界）

- 插件市场 / MCP 市场 / Skill 市场：PI-Desktop 的 host-core 子系统，与 Personal AI host 职能重叠 → 不引入
- 项目（Project）概念与 PR / 定时任务页：后置到有真实需求
- 更新检查横幅：无发布通道

---

## 轮次计划

| 轮 | 内容 | 后端改动 |
|---|---|---|
| R3 | A1 思考行 · A2 复制/重新生成 · A3 元信息 chip · A4 处理计时 · B1 待发队列 · B2/B3 占位与提示 · C8 闪屏 · C9 toast · C10 状态语义 | 无 |
| R4 | A5 活动组 · A6 动作分类 · A7 结构化输出 · A8 失败卡 · A9 错误详情 · D2 切换卡 · D3 用量条 | 无 |
| R5 | B4 模型选择 · B6 推理等级 · B5 权限 chip · **D1 治理询问卡** · C3 折叠 · C4 宽度 · C6 主题 · C7 无边框 | channel: `model_list/set_model/set_thinking`；host: `governance_ask` 事件 + `approve/deny` |
| R6 | C1 会话列表 · C2 新建/搜索 · C5 右键菜单 · B7 `/` 指令 · A10 压缩行 · D4/D5 审计任务升级 | channel: `session_list/new/switch/rename`；compaction 事件透传 |
| R7 | A11 minimap · A12 分页 · A13 委派拓扑 · D6 能力矩阵 · D7 租约徽章 | `lease_status`；session 分页 |
| R8 | C12 provisioning 向导（凭据 / instance / 身体探测） | app 层向导流程 |
