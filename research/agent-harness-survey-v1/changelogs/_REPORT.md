# 更新日志全量原始收录 — 采集报告

采集日 2026-09-20。目标：26+ 家参考 harness 的完整更新记录原始数据（发布页 HTML / CHANGELOG 全文），
先收录后核查——本目录是**原始数据层**，分类结论写在 `../FEATURE_AUDIT.md` §28.6。

## 收录总览

| Harness | 目录 | 文件数 | 体积 | 覆盖 | 备注 |
|---|---|---|---|---|---|
| Claude Code | `claude-code/` | 1 | 747KB | **全史** | 官方 CHANGELOG.md（v0.x→v2.x 全条目） |
| Codex CLI | `codex-cli/` | 100 | 47MB | ~1000 release | GitHub 分页 100 页封顶；最旧到 rust-v0.33 alpha，基本到底 |
| OpenCode | `opencode/` | 88 | 38MB | **全史** | p88 空页止；最旧 v0.1.x |
| Continue | `continue/` | 83 | 43MB | **全史** | p83 空页止；最旧 v0.9.x |
| Zed | `zed/` | 100 | 49MB | ~1000 release | 100 页封顶；最旧 v0.106（接近项目开源初期） |
| Cline | `cline/` | 43 | 19MB | **全史** | p42 空页止；最旧 v1.x（2024-07 起） |
| Gemini CLI | `gemini-cli/` | 64 | 42MB | **全史** | p63 空页止 |
| Qwen Code | `qwen-code/` | 74 | 44MB | **全史** | p73 空页止；含 Qwen Code 全版本线 |
| Roo Code | `roo-code/` | 30 | 14MB | **全史** | 2026-05 已关停 archive——历史样本 |
| OpenHands | `openhands/` | 15 | 8MB | **全史** | 最旧 0.x |
| Aider | `aider/` | 11 | 4.2MB | **全史** | releases p1-10 + HISTORY.md（2023-06 起） |
| Crush | `crush/` | 19 | 12MB | **全史** | p18 空页止；v0.1x→v0.95 |
| Goose | `goose/` | 16 | 8MB | **全史** | p15 空页止 |
| OpenClaw | `openclaw/` | 26 | 31MB | **全史** | p25 空页止 |
| Pi | `pi/` | 27 | 11MB | **全史** | p26 空页止 |
| gptme | `gptme/` | 13 | 6.5MB | **全史** | |
| kimi-code | `kimi-code/` | 8 | 4MB | **全史** | |
| mini-swe-agent | `mini-swe-agent/` | 7 | 3MB | **全史** | |
| mistral-vibe | `mistral-vibe/` | 10 | 4MB | **全史** | |
| Hermes | `hermes/` | 4 | 3.6MB | releases 页+补丁 | Nous Hermes-agent；Pantheon v0.21 全文 |
| KAOS | `kaos/` | 2 | 321KB | CHANGELOG 全文 | kaos-harness v2.0–2.1.1 |
| SWE-agent | `swe-agent/` | 1 | 617KB | CHANGELOG | 维护低频 |
| CodeBuddy | `codebuddy/` | 330 | 46MB | **全史** | 官方 329 个版本详情页逐页抓（v1.x→v2.153） |
| WorkBuddy | `workbuddy/` | 4 | 282KB | changelog+版本页 | workbuddy.cn 官方 |
| Trae | `trae/` | 2 | 2.3MB | docs 全量页 | docs.trae.ai/changelog 2.1MB（内嵌全部版本数据） |
| Cursor | `cursor/` | 4 | 1.5MB | 部分 | 官网 changelog JS 壳；docs.cursor.com/changelog 539KB 有全量（Mintlify） |
| Kiro | `kiro/` | 1 | 286KB | changelog 页 | kiro.dev changelog（条目较少） |
| Devin | `devin/` | 4 | 5.9MB | changelog+文档 | docs.devin.ai 更新页 |
| CodeArts Agent | `codearts-agent/` | 2 | 274KB | changelog 页 | 华为云官方 changelog |
| Jules | `jules/` | 1 | 107KB | changelog 页 | Google Jules |
| Replit | `replit/` | 1 | 450KB | changelog 页 | replit.com/changelog |
| Warp | `warp/` | 1 | 96KB | changelog 页 | |
| Windsurf | `windsurf/` | 1 | 2.6MB | changelog 页 | |
| Qoder | `qoder/` | 1 | 1.5MB | changelog 页 | |
| ZCode | `zcode/` | 1 | 110KB | changelog 页 | zcode.ai 3.14.0 等 |
| Amp | `amp/` | 1 | 122KB | changelog 页 | |
| Copilot CLI | — | 0 | — | **无公开源** | docs.github.com 无 changelog 页（404×2）；releases 走 GitHub Copilot 主产品 |

**合计**：36 个 harness 目录、约 900 文件、~460MB 原始数据。

## 已知覆盖缺口（诚实记录）

1. **GitHub 100 页分页封顶**：codex-cli / zed 各收到 ~1000 个 release 后服务端 404。zed 最旧 v0.106 已基本到底；codex 最旧 rust-v0.33 alpha，rust 线之前还有极早期 tag 未达（占比 <5%，且为 alpha 噪声）。若需补齐：等 rate limit 重置走 API（`?per_page=100&page=N` 无 100 页限制但 60req/h）。
2. **Cursor**：主站 changelog 是 Next.js JS 壳；docs.cursor.com/changelog（Mintlify）有结构化全量，已收。旧版（2023–2024 早期）可能缺少数条目。
3. **Copilot CLI**：无独立公开 changelog——版本更新挂在 GitHub Copilot 产品 release notes 里，不在本层收录范围。
4. **429 限速**：高频抓取期间 GitHub HTML 页数次 429，重试已补齐；个别页若损坏会在核查阶段重抓。
5. **JS 渲染页**：cursor/trae/kiro 主站为客户端渲染，已改用有服务端渲染的文档镜像或确认内嵌数据。

## 采集方法

- 脚本：`.taskflow/tmp/fetch-changelogs.mjs` / `fetch-codebuddy.mjs` / `fetch-gh-html*.mjs`
- GitHub releases 走 HTML 页（含全文 release notes + tag + 日期），`?page=N` 直到空页或 100 页封顶
- 官方文档站直接 fetch；JS 壳页面取内嵌 `__NEXT_DATA__`/Mintlify payload
- 机器规格：20 核 / 96GB RAM / NVMe——任务为延迟型 HTTP，瓶颈在 GitHub 限额而非硬件
