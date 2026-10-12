# TECH_DEBT — 已登记技术债（冻结期不处理）

| ID | 登记日期 | 内容 | 归属阶段 |
|---|---|---|---|
| AIC_OPAQUE_PATH_VISIBILITY | 2026-08-28 | ~~cordis !!js opaque 无枚举机制~~ → **已关闭（Migration #7）**：`collect_opaque_paths()` 显式枚举 + `dsh.yaml opaque_paths` 契约登记（reason+owner），新增未登记 opaque 即 drift。实测 2 条：`[tool-bash].disabled`、`[tool-pwsh].disabled`。 | 已关闭 2026-08-28 |
| ADMISSION_GAP | 2026-08-28 | ~~实际在用但未准入：luna/flash/fable目标/sol~~ → **已关闭（2026-10-12 投产前审查裁决）**：准入流程对本项目不适用——测试阶段随意用模型即可，正式版本由用户接入自己的模型；不存在需要治理准入的"内部模型清单"。4 份 gov-20260828-* proposal 按 rejected 结案。 | 已关闭 2026-10-12 |
| NOVEL_REPO_DURABILITY | 2026-08-28 | ~~novel-main 3 个未推送 commit 含脱敏前私有基础设施名~~ → **已关闭（2026-09-01 已执行 §9 方案，2026-10-12 复核确证）**：novel 仓历史已重写为单一脱敏根 commit（9e1d89b）并推送 public remote；远端其后正常演进（origin/main=9ef8811，本地为其祖先，无未推送内容）。全 16 commit 审计：Antigravity/token 形/个人绝对路径 0 命中，agent-broker 仅 .gitignore 忽略项。repos RPO 恢复由 check_repos 常态监控。 | 已关闭 2026-10-12 |
| SWITCHBOARD_CODEX_PATH_STALE | 2026-08-28 | ~~broker codex_path 漂移~~ → **已关闭（Phase5 Runtime Closure）**：解析链=config（失效自动 exists() 跳过）→ ~/.codex/config.toml CODEX_CLI_PATH marker → PATH；已用 switchboard 自身 resolver 结果修复 live config，并经 queue_cli_request 物理验证（req 0571670a，11s，codex_cli:gpt-5.6-luna）。 | 已关闭 2026-08-28 |
| BACKUP_KEY_CUSTODY | 2026-08-28 | Gen2 key 单副本于 Disk 0；Gen3 envelope 架构 READY、实现 DEFERRED、等待 custody root（评审文档在备份报告目录 BACKUP_KEY_ARCHITECTURE_REVIEW.md）。 | GEN3_KEY_CUSTODY_MIGRATION（未来单独启动） |
