# pi/ — Pi-specific body implementation

Personal AI 的 Pi 身体：与 `dsh/`（退役中的 DSH 身体）同级的 harness 专属层。设计依据 `docs/pi-migration-design.md`（R6.5 裁决：host 与 pi 同级，`pi → host` 单向依赖）。

## 职责分区

```text
src/adapter/    host 契约 ↔ Pi API 翻译（composite guard 安装、session 封装）
src/bootstrap/  concrete composition root——把 host core + pi adapter 装成活体
src/chord/      Chord 组合运行时适配（M5；chord 也是 concrete runtime，不许进 host/）
extensions/     Pi runtime 加载的 managed extension 包（TCB 准入走 manifest）
bin/            pai-host CLI
tests/          pi 侧测试（S0 spike 在这层）
```

## 依赖纪律

- `pi/` **可以** import `../host/`（消费中立契约）和 `@earendil-works/*`
- `pi/` **禁止** import `dsh/`、`mcp/`、`skills/`、`soul/` 内部实现
- `host/` **禁止** import `pi/`、`@earendil-works/*` 或任何 Pi-specific 类型——由 `host/tests/firewall.test.js` 机械执行

## 运行

```bash
npm install            # pin 0.85.1
npm run doctor         # instance root / manifest / deps 自检
npm test
node bin/pai-host.js start --instance-root <path>
```
