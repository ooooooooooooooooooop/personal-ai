# host/ — Personal AI neutral control host

Personal AI 的**中立控制宿主**：harness 无关的契约与机制。具体身体（`pi/`、未来的 `x/`）依赖本包，本包绝不依赖任何身体——**方向永远是 body → host**。

与 `soul/`（心智资产）并列但不同：`soul/` 回答"知道什么/如何认知"，`host/` 回答"谁在执行治理与装配"。设计依据 `docs/pi-migration-design.md`。

## 分层

```text
src/core/    契约与机制：contracts、instance(fail-closed)、audit、manifest、loaders、governance kernel
src/app/     中立应用逻辑：createHostCore——被 body 的 bootstrap 调用并注入 engine
tests/       node --test；firewall.test.js 机械执行依赖防火墙
```

## 依赖防火墙（tests/firewall.test.js 强制）

`host/` 全目录禁止出现：

- `import ... '@earendil-works/*'` 或任何具体 harness 包
- `import ... '*/pi/*'` `*/dsh/*'` `*/mcp/*'` `*/skills/*'` —— 任何身体/部件目录
- Pi-specific 类型/事件名

## 运行态边界

- canonical state / instance runtime / source tree 三者物理分离
- `instance_root` 解析进任何 git worktree → fail closed（`core/instance.js`）
- 审计、session 日志、本地配置一律写 instance root，绝不进本目录

```bash
npm test   # 契约 + 防火墙测试（本包零外部依赖）
```
