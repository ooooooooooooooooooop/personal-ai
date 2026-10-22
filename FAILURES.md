# FAILURES.md — 历史严重事故与禁忌经验清单

> **入选准则（硬门槛，必须同时满足）**：
> 1. **不可从代码类型、Linter 或单次报错直接反推**；
> 2. **单次误踩事故代价 > 1 小时**（如引发状态丢失、死锁或不可逆文件覆写）；
> 3. **必须附带事故当时的 Commit SHA 与真实可跑的退出码验证命令**。
>
> 常规环境怪癖与基础开发规则写进 [`AGENTS.md`](./AGENTS.md)。本文件只追加、一行一条，Agent 在执行不可逆操作前必须阅读核对。

| 事故症状 | 根因与机理 | 禁忌动作 | Commit SHA | 退出码验证命令 | 记录日期 |
|---|---|---|---|---|---|
| DSH 工作区注册表并发写入导致旧配置丢失 | 多进程/身体未持租约时直接读写覆盖 registry.json | 禁忌在未持有 `DomainLeaseStore` 租约时直接执行原子覆写 | `9c8cb85` / `ab0a49c` | `node --import ./host/tests/scrub-env.mjs --test host/tests/lease.test.js` | 2026-09-14 |
| 模型配置对账后运行时实际使用了兜底模型 | 外部用户自定义模型未打 provider 证明标记被安全门禁拦截 | 禁忌在修改模型配置后不通过真实进程探针验证当前生效身份 | `0682ade` | `python -m unittest tests/test_aic_apply.py -k test_dsh_settings_default_model` | 2026-09-03 |
| 跨身体切换时会话状态损坏截断 | 两个写入者并发使用裸 `.tmp` 文件名发生重命名竞态 | 禁忌跳过七态 handoff 的 quiesce/verify 阶段或使用无 PID 后缀的临时文件 | `a4bc65b` / `58da7ae` | `npm --prefix dsh test` | 2026-09-16 |
