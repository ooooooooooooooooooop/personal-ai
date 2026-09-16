# Scope: Agent Harness Survey V1

> **Research Track**: `research/agent-harness-survey-v1/`
> **Created**: 2026-09-15
> **Status**: IN PROGRESS
> **Mode**: DESK + SOURCE-CODE RESEARCH ONLY (NO PRODUCTION RUNS, NO PRODUCTION MUTATION)

---

## 1. Question

> What are the mainstream agent harnesses in the wild as of 2026-Q3, and how is each one actually implemented — loop, tools, context management, safety controls, orchestration, and extension surfaces?

The deliverable is a per-harness implementation study (`harnesses/<name>.md`), a landscape census (`inventory.md`), and a cross-harness synthesis (`SURVEY_REPORT.md`).

## 2. Definition (adopted)

Following arXiv:2609.00006 ("Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents", 2nd ed.):

> An agent is a model plus a **harness** — the runtime that couples an LLM to the world through a loop, tools, context management, safety controls, orchestration, and extension surfaces.

In scope: runnable agent runtimes (CLI, IDE extension, desktop, gateway, cloud) that an end user operates.

## 3. Explicitly out of scope (recorded, not silently dropped)

- **Agent frameworks / SDK libraries** — LangGraph, AutoGen, CrewAI, smolagents, OpenAI Agents SDK, Vercel AI SDK. These are libraries embedded *by* a harness, not runtimes an end user operates. Listed in `inventory.md` as an adjacent category.
- **Evaluation harnesses** — SWE-bench, Terminal-Bench, lm-evaluation-harness, OSWorld. These benchmark agents; they are not agents. Listed in `inventory.md` as an adjacent category.
- **Model providers / routers without an agent loop** — LiteLLM, OpenRouter, Ollama.
- The five local harnesses already covered by `docs/phase5-multiharness-report.md` are *in* the survey corpus (they are industry products), but this track studies their **implementation mechanics**, not their local config surface.

## 4. Corpus selection rule

Deep-dive corpus = the eleven systems source-audited by arXiv:2609.00006 plus mainstream systems the user explicitly wants covered. Two study grades:

- **SOURCE-READ** — open source; worker clones and reads the implementation.
- **DOCS-ONLY** — closed source; study assembled from official docs, SDK surfaces, shipped-internals reports, and community documentation. Marked clearly; claims tagged VENDOR-CLAIM where appropriate.

### SOURCE-READ corpus

| # | Harness | Steward | Impl. language | License | Why in corpus |
|---|---------|---------|---------------|---------|---------------|
| 1 | Codex CLI | OpenAI | Rust | Apache-2.0 | Kernel-level sandboxing reference |
| 2 | Gemini CLI | Google | TypeScript | Apache-2.0 | Largest open vendor CLI surface |
| 3 | OpenCode | Anomaly (ex-SST) | TypeScript + Go | MIT | Largest OSS community; provider breadth |
| 4 | Mistral Vibe | Mistral AI | Python | Apache-2.0 | Minimal lab-built CLI, ACP-native |
| 5 | Pi | Earendil (badlogic) | TypeScript monorepo | MIT | Minimal-harness / extension-first design pole |
| 6 | OpenClaw | OpenClaw | TypeScript | OSS | Personal-AI gateway; pluggable agent-harness registry (meta-harness behavior) |
| 7 | Hermes | Nous Research | Python | MIT | Self-improving loop: skill creation, persistent memory, multi-platform gateway |
| 8 | Aider | Paul Gauthier | Python | Apache-2.0 | Original terminal coding agent (2023); edit-format design reference |
| 9 | OpenHands | All Hands AI | Python | MIT | Open autonomous software agent; event-stream architecture |
| 10 | Mini-SWE-Agent | SWE-bench/Princeton | Python | MIT | ~100-line minimal harness pole; benchmark-native |
| 11 | Goose | Block | Rust (+TS desktop) | Apache-2.0 | Desktop+CLI, MCP-first extension model |
| 12 | Cline | Cline | TypeScript (VS Code ext) | Apache-2.0 | IDE-extension harness reference; Plan/Act modes |
| 13 | Roo Code | Roo Code | TypeScript (VS Code ext) | Apache-2.0 | Major Cline fork; modes/custom-role divergence |
| 14 | Kimi Code CLI | Moonshot | TS→single binary | MIT | CN vendor CLI; ACP+MCP+subagents+hooks; successor to kimi-cli |
| 15 | Qwen Code | Alibaba | TypeScript | Apache-2.0 | Gemini-CLI fork adapted to Qwen — fork-divergence data point |
| 16 | Crush | Charm | Go | FSL→OSS | LSP-enhanced context; multi-client `crush serve` workspaces |
| 17 | DSH | this repo's harness | TS/JS | Internal | The host harness of this repository — studied from in-repo sources |

### DOCS-ONLY corpus (closed source, mainstream)

| # | Harness | Steward | Surface | Why in corpus |
|---|---------|---------|---------|---------------|
| 18 | Claude Code | Anthropic | CLI/IDE/Desktop/Web/Cloud | Market leader; reference extensibility design (SDK + docs + arXiv audit) |
| 19 | Cursor | Anysphere | IDE fork | Largest IDE harness; codebase indexing = notable exception to the no-RAG pattern |
| 20 | Trae | ByteDance | IDE + SOLO | CN/global IDE agent; SOLO autonomous mode |
| 21 | Kiro | AWS | IDE + `kiro-cli` | Spec-driven workflow (requirements/design/tasks); agent hooks |
| 22 | Devin | Cognition | Cloud + CLI | Autonomous cloud engineer; playbook/snapshot model |
| 23 | WorkBuddy | Tencent | Desktop + cloud agents | OpenClaw-like workplace agent; OpenClaw-skills compatible; project-space multi-agent |
| 24 | CodeArts Agent | Huawei Cloud | IDE/plugin/CLI | Enterprise CN harness; Agent Team; large-scale codebase indexing; Agentic DevOps |
| 25 | ZCode | Z.ai (Zhipu) | Desktop ADE + agent | Official GLM-5.3 harness; Goal Mode; bundled `resources/glm` runtime (per unofficial zcode-cli) |

Everything else mainstream goes to `inventory.md` with a profile row (Amp, Copilot CLI, Factory Droid, Command Code, Kendr Code, Windsurf, Continue, Auggie, Omnigent, SWE-agent, Zed agent, Warp, Jules, Replit Agent, CodeBuddy, gptme, …) — breadth is recorded there without pretending implementation depth.

## 5. Method

1. **Collect** the landscape from dated 2026 sources (landscape reports, directories, vendor docs) → `inventory.md`.
2. **Deep-dive** each corpus harness: clone the source repo (or read shipped internals/docs for closed systems), and fill `STUDY_TEMPLATE.md` → `harnesses/<name>.md`.
3. **Synthesize** cross-cutting observations and design-pattern catalog → `SURVEY_REPORT.md`.

Evidence rules:

- Primary sources only: the project's own source tree (cite the HEAD commit hash studied), official docs, the arXiv anatomy paper. Blog/press claims are marked as such.
- Every non-obvious implementation claim carries a source pointer (file path within repo + commit, or URL).
- Tag epistemic status where it matters: `FACT` (read in source) vs `INFERENCE` (derived) vs `VENDOR-CLAIM`.
- Record the version/commit studied — these projects ship weekly; every study is a dated snapshot.
- **Publishing boundary**: no local machine paths, credentials, session IDs, or device state in any artifact. External `https://` links are allowed (repo link-checker only validates relative links).

## 6. Non-goals

- No benchmarking / model-quality comparison (quality changes monthly; this studies mechanism).
- No recommendation of "the best harness" — the report maps design trade-offs, not a leaderboard.
- No mutation of production paths (`registry/`, `skills/`, `mcp/`, `dsh*/`, `soul/`). All artifacts live under this track directory.

## 7. Decision record

- `harness` = agent runtime/coding agent execution shell, consistent with `docs/phase5-multiharness-report.md` usage. Assumption logged per clarify-before-change (reversible interpretation, matches repo evidence).
- Documents in English, matching the `research/cognitive-leverage-pilot-v0` track convention.
