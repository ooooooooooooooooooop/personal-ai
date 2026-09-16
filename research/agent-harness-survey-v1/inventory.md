# Harness Landscape Inventory (2026-Q3 snapshot)

> Dated census. A public directory tracked **110+ terminal-native coding agents/harnesses** as of 2026-08-13 (src: kendr.org comparison, 2026-08-14). This file records the mainstream tier; the deep-dive corpus is defined in `SCOPE.md` §4.

## Tier A — deep-dive corpus

| Harness | Steward | Interface | Open? | Notes |
|---|---|---|---|---|
| Claude Code | Anthropic | CLI/IDE/Desktop/Web/Mobile/Cloud | Proprietary | Reference extensibility: hooks, skills, subagents, plugins, Agent SDK |
| Codex CLI | OpenAI | CLI/IDE/Cloud | Apache-2.0 (Rust core) | Seatbelt/Landlock/seccomp/Win sandbox; net off by default |
| Gemini CLI | Google | CLI | Apache-2.0 | Largest open vendor surface |
| OpenCode | Anomaly | TUI/desktop | MIT | ~156K stars; 75+ providers; ACP |
| Mistral Vibe | Mistral | CLI/VS Code/JetBrains(Web) | Apache-2.0 | Minimal lab CLI; ACP registry |
| Pi | Earendil (badlogic) | CLI (interactive/print/RPC/SDK) | MIT | Self-extending minimal harness; pi-packages via npm/git |
| OpenClaw | OpenClaw | Gateway daemon + chat channels | OSS | Personal-AI gateway; pluggable agent-harness registry (can host Codex/Copilot runtimes) |
| Hermes | Nous Research | TUI + messaging gateway | MIT | Self-improving loop: skill creation, memory, cron, 6 terminal backends |
| Aider | P. Gauthier | CLI | Apache-2.0 | Original (2023); edit-format reference |
| OpenHands | All Hands AI | CLI/Web/Cloud | MIT | Event-stream agent; formerly OpenDevin |
| Mini-SWE-Agent | Princeton/SWE-bench | CLI | MIT | ~100 LoC minimal pole; SWE-bench-native |
| Goose | Block | Desktop/CLI | Apache-2.0 (Rust) | MCP-first extension model |
| Cline | Cline | VS Code ext | Apache-2.0 | IDE harness reference; Plan/Act |
| Roo Code | Roo Code | VS Code ext | Apache-2.0 | Major Cline fork; custom modes |
| Kimi Code CLI | Moonshot | CLI (single binary) | MIT | ACP+MCP+subagents+hooks; K2.7 default, model-agnostic; succeeds kimi-cli |
| Qwen Code | Alibaba | CLI | Apache-2.0 | Gemini-CLI fork → Qwen |
| Crush | Charm | TUI + `crush serve` | FSL→OSS | Go/Bubble Tea; LSP context; multi-client workspaces |
| DSH | this repo | local harness | Internal | Host harness of this repo; studied from in-repo sources |
| Claude Code | Anthropic | CLI/IDE/Desktop/Web/Cloud | Proprietary | DOCS-ONLY deep-dive |
| Cursor | Anysphere | IDE fork | Proprietary | DOCS-ONLY; codebase indexing exception |
| Trae | ByteDance | IDE + SOLO | Proprietary | DOCS-ONLY |
| Kiro | AWS | IDE + `kiro-cli` | Proprietary | DOCS-ONLY; spec-driven |
| Devin | Cognition | Cloud + CLI | Proprietary | DOCS-ONLY; this session's host |
| WorkBuddy | Tencent | Desktop + cloud | Proprietary | DOCS-ONLY; OpenClaw-compatible skills |
| CodeArts Agent | Huawei Cloud | IDE/plugin/CLI | Proprietary | DOCS-ONLY; codebase indexing; Agent Team |
| ZCode | Z.ai | Desktop ADE | Proprietary | DOCS-ONLY; GLM-5.3 official harness |

## Tier B — mainstream, profiled only

| Harness | Steward | Interface | Open? | One-line |
|---|---|---|---|---|
| Amp | Amp Inc. (ex-Sourcegraph) | CLI/IDE | Proprietary | Multi-agent (oracle/subagents); usage-priced |
| GitHub Copilot CLI | GitHub | CLI/IDE/Actions | Proprietary | Defaults to Claude models; CI-native |
| Factory Droid | Factory AI | CLI/Web | Proprietary | "Droids" autonomous tasks; $1.5B val |
| Command Code | CommandCodeAI | CLI | Proprietary | ex-Langbase; 2026 entrant |
| Kendr Code | Kendr | CLI | Proprietary? | Self-scored 88 on own rubric — verify |
| Windsurf | Cognition | IDE/CLI | Proprietary | Cascade agent; Devin extension |
| Continue | Continue | IDE ext + `cn` CLI | Apache-2.0 | OSS IDE autopilot; config-driven |
| Antigravity `agy` | Google | CLI | Proprietary? | Gemini-native CLI surfaced via Omnigent's roster — verify standalone availability |
| Auggie | Augment Code | CLI | Proprietary | Context-engine-first CLI |
| Omnigent | Databricks | Meta-harness (runner+server) | OSS | First meta-harness: wraps Claude Code/Codex/Cursor/OpenCode/Hermes/Pi/agy in uniform sandboxed sessions; YAML-defined agents; cross-vendor orchestration (Polly); arXiv contrast point |
| SWE-agent | Princeton | Research CLI | MIT | Full framework sibling of Mini-SWE-Agent |
| Zed agent panel | Zed Industries | IDE-native | OSS (editor) | Native agentic editing inside Zed; ACP client host for external harnesses |
| Warp agent mode | Warp | Terminal-native | Proprietary | Agent mode embedded in the terminal itself |
| Jules | Google | Cloud async | Proprietary | Async task agent; GitHub-integrated |
| Replit Agent | Replit | Cloud/IDE | Proprietary | App-builder agent |
| Qoder | Alibaba | IDE | Proprietary | CN-market IDE agent |
| CodeBuddy | Tencent | IDE/plugin/CLI | Proprietary | WorkBuddy's coding sibling; 3 forms |
| gptme | gptme | CLI | OSS | Lightweight CLI agent — verify activity |

## Adjacent categories (out of deep-dive scope)

- **Frameworks/SDKs**: LangGraph, AutoGen, CrewAI, smolagents, OpenAI Agents SDK, Vercel AI SDK — libraries, not runtimes.
- **Eval harnesses**: SWE-bench, Terminal-Bench, lm-evaluation-harness, OSWorld, SWE-rebench — benchmark agents, not agents.
- **Model routers**: LiteLLM, OpenRouter, Ollama — no agent loop.

## Sources

- kendr.org/blog/coding-agent-harness-comparison-2026.html (2026-08-14) — 50-harness rubric; 110+ census claim
- arxiv.org/abs/2609.00006 — 11-system source-code anatomy (2nd ed.)
- wal.sh/research/2026-q2-cli-coding-agents — six-agent surface comparison
- techstackups.com/comparisons/coding-agent-harness-comparison-2026 — nine-agent funding/license table
- cc.bruniaux.com/guide/agent-harness-landscape — 25-harness table
- github.com/mistralai/mistral-vibe, github.com/earendil-works/pi, github.com/NousResearch/hermes-agent, github.com/openclaw/openclaw — primary repos
