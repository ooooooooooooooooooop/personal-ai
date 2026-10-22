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
| worktree 内提交后主仓变 bare：工作区在 `git status` 里"凭空干净"、分支尖端被 `ownership-test` 的 `initial` 覆盖、`git worktree list` 首行显示 `(bare)` | pre-commit 门禁跑的回归测试（`tests/test_canonical_mutation_ownership.py::init_repo`，特征：写 `seed.txt` + commit `initial` + 身份 `ownership-test`）其 git 命令穿透到真实 worktree，写入 `core.bare=true` 并在当前分支造提交。hook 既有的 `unset GIT_INDEX_FILE GIT_PREFIX GIT_DIR GIT_WORK_TREE`（第 28 行）未能覆盖此穿透路径；bare 态下 `git status` 把 fatal 打到 stderr、stdout 为空，会被 `wc -l` 读成"0 项改动"从而掩盖损坏 | 禁忌在 worktree 内直接 `git commit` 而不先验证测试隔离；禁忌用单条 `git status --porcelain \| wc -l` 判断工作区干净（bare 态下它静默返回 0） | `1bbffcd`（污染提交，所在分支已删） | `git rev-parse --is-bare-repository \| grep -qx false && ! git config user.name \| grep -q ownership-test` | 2026-10-22 |
| 提交时一切正常（`git commit` 无任何报错），十几分钟后 `push-ref` 才报 `PUSH_REF_MISSING_COMMIT_RECEIPT`，而回看事件日志只有一条 `SCOPE_VIOLATION` | `cmd_post_commit` 用「整提交 changed ⊆ lock.scope」判外族，与 `cmd_pre_commit`（只看 `GOVERNED_PATH_PREFIXES` 切片）、`push_governed_ref`（`commit_touches_governed_paths`）三者口径不一致。于是「少量受治理内容 + 大量非受治理删除」的提交在 pre-commit 合法通过、在 post-commit 被判越权、COMMITTED 回执写不出来。**git 忽略 post-commit 的退出码**，所以这次拒绝既不阻断提交也不出现在任何提交输出里，唯一后果是回执缺失，直到推送时才以另一个错误码浮现 | 禁忌把 post-commit 的 exit=2 一律当成假阳性（无租约时 `NO_ACTIVE_CANONICAL_WRITER` 是良性的，有租约时 `ABORT_FOREIGN_COMMITTED_PATH` 是真越权，两者码相同）；禁忌在「大删除 + 小改动」的提交后假定回执已写入而不查 `receipts/` | `0812552`（已重写为 `50badf9`，内容 tree 逐字节一致） | `python -m unittest tests.test_canonical_writer_provenance.TestPostCommitGovernedScope -v` | 2026-10-22 |
