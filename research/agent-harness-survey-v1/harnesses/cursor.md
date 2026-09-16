# Cursor (Anysphere Cursor IDE + Cursor CLI + Cloud Agents)

> Steward: Anysphere, Inc. · License: Proprietary (closed source) · Impl. language: NOT FOUND — closed source (VS Code fork ⇒ TypeScript/Electron base is a reasonable **INFERENCE**, unconfirmed by docs) · First release: 2023 (public launch) · **Version studied: current production docs (Cursor 2.x line; docs fetched 2026-09-15; per-version evidence cited inline where docs carry dates)**
> Repo: N/A (closed source) · Docs: https://cursor.com/docs · https://cursor.com/help · https://cursor.com/blog
> **Epistemic basis: DOCS-ONLY**

Tag legend: **FACT** = documented behavior · **VENDOR-CLAIM** = marketing statement · **INFERENCE** = derived structure.

## 1. Positioning & design philosophy

Cursor's bet is *an AI-native IDE is a better harness than a plugin*: owning the editor lets the agent see your open files, diffs, terminals, and review UI, and lets Cursor ship proprietary models (Composer, Fast Apply, Tab) inside the loop rather than through an API-only contract (VENDOR-CLAIM, src: https://cursor.com/features, https://cursor.com/docs/agent/overview). The 2.x generation repositions the product around "Agent" as the default interface — chat, planning, background execution, and a multi-agent "Agents Window" — plus a first-class `cursor-agent` CLI and Cloud Agents so the same agentic core runs in the editor, a terminal, and isolated VMs (FACT, src: https://cursor.com/docs/agent/overview, https://cursor.com/docs/cli/overview, https://cursor.com/docs/cloud-agent). Distinctive philosophy visible in docs: explicit *modes* (Agent / Ask / Plan / custom), explicit *run policies* (Auto-Run / Run Everything / Command Allowlist), and first-party subagents — the harness exposes orchestration and safety as user-facing configuration surfaces rather than hidden internals (FACT, src: https://cursor.com/docs/agent/modes, https://cursor.com/docs/agent/security/run-modes, https://cursor.com/docs/subagents).

## 2. Architecture overview

Closed source; no implementation file paths are public. The documented component topology:

- **Editor shell** — VS Code-derived IDE ("fork" is the widely reported fact; the docs describe Code OSS-derived editor features but do not state the fork in current pages — INFERENCE on base, FACT on capabilities). AI surfaces: Agent panel, inline edit (Cmd/Ctrl+K), Tab autocomplete, Agents Window, review/checkpoint UI (src: https://cursor.com/docs/agent/overview, https://cursor.com/help/ai-features/tab).
- **Agent runtime** — the loop that streams model calls, executes built-in tools (file/search/edit/shell/web/browser/subagents), applies permission policy, and emits diffs/checkpoints. Location/format: NOT FOUND (closed source).
- **CLI** — `cursor-agent`, a terminal front end to the same agent stack, plus an ACP server mode for embedding in other editors (FACT, src: https://cursor.com/docs/cli/overview, https://cursor.com/docs/cli/acp).
- **Cloud agent fleet** — per-task isolated VMs with a dev-environment image, separate git branch, web/mobile/Slack/GitHub/Linear entry points, artifacts and remote-desktop-style control (FACT, src: https://cursor.com/docs/cloud-agent).
- **Supporting services** — codebase indexing/search backend, model router ("Cursor Router" powering Auto), Bugbot PR-review service, MCP client layer (FACT, src: https://cursor.com/docs/cursor-router, https://cursor.com/docs/bugbot, https://cursor.com/docs/mcp, https://cursor.com/blog/fast-regex-search, https://cursor.com/blog/secure-codebase-indexing).
- **Configuration surface** — `.cursor/rules/*.mdc`, `.cursor/agents/`, `.cursor/hooks.json`, `.cursor/mcp.json`, `AGENTS.md`, skills/plugins directories; team-level rules and admin controls (FACT, src: https://cursor.com/docs/rules, https://cursor.com/docs/subagents, https://cursor.com/docs/hooks, https://cursor.com/docs/mcp, https://cursor.com/docs/skills).

## 3. Agent loop

- **Modes** — Agent mode (default: plans, runs tools, edits), Ask mode (read-only Q&A), Plan mode (research + a written plan gated before implementation), and custom/user-defined modes (FACT, src: https://cursor.com/docs/agent/modes).
- **Turn structure** — iterative model→tool-call→observation loop: the agent searches/reads files, proposes edits as reviewable diffs, runs terminal commands (subject to run policy), optionally browses/searches the web, and continues until it decides the task is done or needs input. A dedicated "question/clarification" tool lets the agent pause for structured answers mid-run (FACT, src: https://cursor.com/docs/agent/overview).
- **Steering mid-run** — users can queue messages while the agent is running; queued input is consumed to steer the in-flight agent rather than waiting for a clean stop (FACT, src: https://cursor.com/docs/agent/overview — "queued messages"; CLI parallels).
- **Plan → Execute** — Plan mode produces an explicit plan artifact the user edits/approves before Agent mode executes; `/goal`-style long-horizon framing exists in the CLI/docs (FACT, src: https://cursor.com/docs/agent/modes, https://cursor.com/docs/cli/overview).
- **Stopping/recovery** — checkpoints snapshot file state per agent turn so the user can restore; the agent can be interrupted and resumed. Max-turn/token guard internals: NOT FOUND (searched: docs agent pages, CLI reference).
- **Background execution** — a task can be handed to a cloud agent that keeps working in a VM and reports back (branch + PR + artifacts); local subagents can also run in background (FACT, src: https://cursor.com/docs/cloud-agent, https://cursor.com/docs/subagents).

## 4. Tool system

Documented built-in tool inventory (FACT, src: https://cursor.com/docs/agent/overview, https://cursor.com/docs/subagents):

| Category | Tools |
|---|---|
| Discovery | file search / fast regex code search ("Instant Grep"), file reading, directory listing |
| Editing | apply-edit / write tools producing reviewable diffs (powered server-side by the Fast Apply model — see §10) |
| Execution | integrated terminal/shell commands (permissioned; sandboxable) |
| Web | web search + fetch, browser tool |
| Media | image generation tool |
| Interaction | question/clarification tool; subagent dispatch (Explore, Bash, Browser, custom) |

- **Edit mechanism** — edits surface as diffs with review/accept/revert; Cursor operates a dedicated *Fast Apply* model that merges a model's intended change into the current file (specialized "apply" model, blog-documented) — i.e., sketch-and-merge rather than raw diff text (FACT on product behavior + the existence of a dedicated apply model; src: https://cursor.com/blog/instant-apply).
- **MCP** — full client: `stdio`, SSE, and Streamable HTTP transports; supports tools, prompts, resources, roots, elicitation, and "MCP Apps"; configured via `.cursor/mcp.json` (project) and user config (FACT, src: https://cursor.com/docs/mcp).
- **Tool gating** — per-tool/per-command permission through run modes and allowlist (see §6); hooks can observe/block tool calls (FACT, src: https://cursor.com/docs/agent/security/run-modes, https://cursor.com/docs/hooks).
- **Tool-result size handling / truncation internals** — NOT FOUND (searched: tools docs, blog).

## 5. Context management

- **Instruction layering** — rules from `.cursor/rules/*.mdc` (frontmatter: `description`, `globs`, `alwaysApply`), user rules, team rules, and `AGENTS.md`; agent-attached and manually-attached rules combine into the system context (FACT, src: https://cursor.com/docs/rules).
- **Retrieval — the embedding story, versioned** *(this is the notable exception the survey tracks)*:
  - *Historical (documented Jan 2026)*: Cursor built a semantic codebase index — syntactic chunking → embedding model → vectors stored server-side under encryption; a Merkle tree over file contents kept the index in sync efficiently (FACT for that era, src: https://cursor.com/blog/secure-codebase-indexing).
  - *Current (documented 2026)*: an official blog details "Instant Grep" — a local trigram/inverted-index regex engine the agent uses for code search; a July 2026 staff response on the Cursor forum says the dedicated semantic-index path was being retired in favor of local Instant Grep plus ordinary file reads (FACT for that era, src: https://cursor.com/blog/fast-regex-search, https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899).
  - **INFERENCE**: Cursor has *moved toward* the industry norm of deterministic retrieval (grep/index + reads) for the default agent path; whether embeddings survive for specific features (e.g., Docs/Ask) at snapshot date is not documented — treat "Cursor = vector RAG" as historical, not current.
- **Subagent context isolation** — Explore/Bash/Browser subagents run in their own context windows and return digested results, keeping the parent context clean (FACT, src: https://cursor.com/docs/subagents).
- **Compaction/summarization** — long conversations are summarized ("summarization" referenced across docs); exact trigger/format NOT FOUND (searched: context docs).
- **Tab** — a separate autocomplete context pipeline (copilot-style inline suggestions) with its own model(s); shares repo context signals but is not the agent loop (FACT, src: https://cursor.com/help/ai-features/tab).

## 6. Safety model

- **Run modes** (FACT, src: https://cursor.com/docs/agent/security/run-modes):
  - *Auto-Run off* → every shell command requires approval.
  - *Auto-Run + allowlist* → commands matching the allowlist run automatically; everything else prompts. Auto-review flags risky commands for confirmation.
  - *Run Everything* → no prompts; intended to be paired with the sandbox.
- **OS-level sandbox** — shell sandboxing uses **macOS Seatbelt** and **Linux Landlock/seccomp** with protected paths and a configurable network policy; protects against destructive filesystem writes and exfiltration while allowing build/test commands (FACT on the documented mechanisms, src: https://cursor.com/docs/agent/security/run-modes). Windows sandbox status: NOT FOUND in the cited page.
- **Deletion/external-file guards** — protections around file deletion and edits outside the workspace are documented as safety behaviors (FACT, src: run-modes/security docs above).
- **Cloud agents** — execute inside isolated VMs on separate branches; blast radius is the VM, not the laptop (FACT, src: https://cursor.com/docs/cloud-agent).
- **Prompt-injection posture** — docs acknowledge treating tool/web output as untrusted input with guardrails; specific mitigations NOT FOUND beyond run-mode gating (searched: security pages).
- **Privacy Mode** — a documented setting that prevents storing code on Cursor servers (affects features that need remote processing) (FACT, src: https://cursor.com/security + help privacy pages).

## 7. Orchestration

- **Subagents** — built-in Explore (codebase research), Bash (noisy shell work), Browser (web tasks) plus user-defined subagents in `.cursor/agents/`; they run foreground or background with isolated context and return summaries (FACT, src: https://cursor.com/docs/subagents).
- **Agents Window** — a dedicated surface for launching/monitoring multiple agents (local + cloud) in parallel (FACT, src: https://cursor.com/docs/agent/agents-window).
- **Cloud agents** — one VM per task; triggered from IDE, web, mobile, Slack, GitHub, Linear, or an API; produce branches/PRs and artifacts; support MCP inside the environment (FACT, src: https://cursor.com/docs/cloud-agent).
- **Wire protocols** — `cursor-agent` CLI speaks **ACP** (Agent Client Protocol) so other editors/hosts can drive Cursor's agent over JSON-RPC stdio; MCP for tools (FACT, src: https://cursor.com/docs/cli/acp, https://cursor.com/docs/mcp).
- **Bugbot** — a separate PR-review agent (GitHub app): automatic or manual triggers, posts comments and CI status checks, can hand fixes back to cloud agents (FACT, src: https://cursor.com/docs/bugbot).
- **Headless/CI** — CLI non-interactive modes for scripting/CI (FACT, src: https://cursor.com/docs/cli/overview).

## 8. Extensibility

- **Rules** — `.cursor/rules/*.mdc` + `AGENTS.md` + user/team rules (FACT, src: https://cursor.com/docs/rules).
- **Custom subagents** — `.cursor/agents/` definitions with their own prompts/tool sets (FACT, src: https://cursor.com/docs/subagents).
- **Hooks** — `.cursor/hooks.json` lifecycle hooks that can observe, block, or modify loop stages (e.g., before/after tool execution) (FACT, src: https://cursor.com/docs/hooks).
- **Skills & plugins** — packaged skill bundles and a plugin mechanism for reusable agent capabilities (FACT, src: https://cursor.com/docs/skills).
- **MCP** — arbitrary external tools/data via the three transports (FACT, src: https://cursor.com/docs/mcp).
- **Custom modes/keybindings** — user-defined agent modes (FACT, src: https://cursor.com/docs/agent/modes).
- Themes/extension ecosystem inherit from the VS Code base (INFERENCE; extension marketplace differences are a known fork caveat, not covered in agent docs).

## 9. Session & state

- **Checkpoints** — automatic per-turn file snapshots (separate from Git) with one-click restore; checkpoints record the pre-edit file state so an agent turn can be rolled back (FACT, src: https://cursor.com/docs/agent/overview — checkpoints; restore flow).
- **Sessions** — chat/agent sessions persist locally and can be resumed/forked; CLI sessions resumable; shared-transcript export exists (FACT, src: CLI docs + help pages).
- **Persistence format/location** — NOT FOUND (searched: docs; closed source — internal store not documented).
- **Cross-session memory** — "memories"/learned-context features appear in help material; formal spec NOT FOUND (searched: docs index).

## 10. Model layer

- **Frontier models** — user-selectable OpenAI/Anthropic/Google/xAI models for Agent/Ask/Plan (FACT, src: https://cursor.com/docs/models).
- **Auto / Cursor Router** — "Auto" routes each task to an optimal model via Cursor Router (task-based routing; the router is Cursor's own system) (FACT + VENDOR-CLAIM on "optimal", src: https://cursor.com/docs/cursor-router).
- **Proprietary models** — **Composer** (Cursor's agentic coding model; Composer 2.5 documented), **Fast Apply** (specialized apply/merge model), and **Tab** autocomplete models (FACT, src: https://cursor.com/docs/models/cursor-composer-2-5, https://cursor.com/blog/instant-apply, https://cursor.com/help/ai-features/tab).
- **Auth** — subscription-based; API-key/BYOK options exist for some models (documented in help); enterprise/team management documented (FACT, src: https://cursor.com/help, https://cursor.com/docs).
- **Fallback behavior** — router internals/failure fallbacks NOT FOUND (searched: router doc).

## 11. Notable mechanisms

1. **Retrieval pivot worth studying** — the documented arc *server-side vector index (Merkle-synced, encrypted) → local trigram regex index ("Instant Grep") + agentic file reads* is the clearest public evidence of a major vendor converging on deterministic retrieval; treat per-date claims carefully (src: https://cursor.com/blog/secure-codebase-indexing, https://cursor.com/blog/fast-regex-search, https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899).
2. **Dedicated apply model** — Fast Apply: a purpose-trained model that merges intended edits into files quickly/robustly, decoupling "what to change" (frontier model) from "how to apply it" (src: https://cursor.com/blog/instant-apply).
3. **Permissioned shell with real sandboxing** — allowlist + Auto-Review + Seatbelt/Landlock-seccomp makes "Run Everything" survivable locally; one of the few consumer IDEs documenting OS-level sandboxing (src: https://cursor.com/docs/agent/security/run-modes).
4. **Context-isolated subagents as a first-class feature** — Explore/Bash/Browser keep noisy work out of the parent window; user-definable via `.cursor/agents/` (src: https://cursor.com/docs/subagents).
5. **Checkpoints decoupled from Git** — per-turn snapshots mean undo doesn't require commits; pairs with queued-message steering for long runs (src: https://cursor.com/docs/agent/overview).

## 12. Evidence log

- https://cursor.com/docs/agent/overview — agent modes, tools incl. clarification tool, queued messages, checkpoints — accessed 2026-09-15
- https://cursor.com/docs/agent/modes — Agent/Ask/Plan/custom modes — accessed 2026-09-15
- https://cursor.com/docs/agent/security/run-modes — run modes, allowlist, Auto-Review, Seatbelt/Landlock-seccomp sandbox, network policy — accessed 2026-09-15
- https://cursor.com/docs/subagents — built-in + custom subagents, background/foreground, isolated context — accessed 2026-09-15
- https://cursor.com/docs/rules — .mdc rules, alwaysApply/globs/description, AGENTS.md, user/team rules — accessed 2026-09-15
- https://cursor.com/docs/hooks — hooks.json lifecycle interception — accessed 2026-09-15
- https://cursor.com/docs/mcp — transports, prompts/resources/roots/elicitation, MCP Apps — accessed 2026-09-15
- https://cursor.com/docs/skills — skills/plugins — accessed 2026-09-15
- https://cursor.com/docs/cli/overview + https://cursor.com/docs/cli/acp — CLI and ACP server mode — accessed 2026-09-15
- https://cursor.com/docs/agent/agents-window — multi-agent management surface — accessed 2026-09-15
- https://cursor.com/docs/cloud-agent — isolated-VM cloud agents, multi-surface triggers, artifacts — accessed 2026-09-15
- https://cursor.com/docs/bugbot — PR review agent — accessed 2026-09-15
- https://cursor.com/docs/cursor-router — Auto model routing — accessed 2026-09-15
- https://cursor.com/docs/models/cursor-composer-2-5 — proprietary Composer model — accessed 2026-09-15
- https://cursor.com/blog/instant-apply — Fast Apply model — accessed 2026-09-15
- https://cursor.com/blog/secure-codebase-indexing — historical embeddings index + Merkle sync — accessed 2026-09-15
- https://cursor.com/blog/fast-regex-search — Instant Grep local index — accessed 2026-09-15
- https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899 — staff statement on retiring semantic index path — accessed 2026-09-15
- https://cursor.com/help/ai-features/tab — Tab autocomplete — accessed 2026-09-15

**Conflicts / gaps / unverified**: embedding-vs-deterministic retrieval is time-dependent (documented above); implementation language/process layout NOT FOUND (closed source); max-turn guards, context-window budgets, tool-output truncation, checkpoint storage format, Windows sandbox coverage, and memory-file semantics NOT FOUND in official docs. Any behavior inferred from UI screenshots/community posts is marked INFERENCE or excluded.
