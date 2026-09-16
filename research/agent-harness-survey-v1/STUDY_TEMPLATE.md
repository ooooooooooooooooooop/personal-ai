# Per-Harness Study Template

Copy this skeleton into `harnesses/<name>.md`. Fill every section; write `N/A` or `NOT FOUND (searched: <where>)` rather than leaving a section empty. Cite sources inline as `(src: <repo path>@<commit | URL>)`.

---

```markdown
# <Harness Name>

> Steward · License · Impl. language · First release · **Version studied: <tag/commit, date accessed 2026-09-15>**
> Repo: <url> · Docs: <url>
> Epistemic basis: SOURCE-READ | DOCS-ONLY | MIXED

## 1. Positioning & design philosophy
One paragraph: what bet does this harness make that others don't?

## 2. Architecture overview
Process model, major modules, entry points, where the agent loop lives (file paths).

## 3. Agent loop
Turn structure, stopping conditions, planning mechanism (or its deliberate absence),
retry/recovery behavior, max-turn/token guards.

## 4. Tool system
Built-in tool inventory, edit/patch mechanism (diff format? whole-file? search-replace?),
tool-result size handling, MCP client support, tool gating/permissions per tool.

## 5. Context management
System prompt composition (what blocks, in what order), memory/instruction files
(AGENTS.md etc.), context compaction/summarization strategy, retrieval approach
(grep/glob/AST/embeddings — note the paper's finding that nobody uses embeddings).

## 6. Safety model
Permission modes, approval flow, sandboxing (OS-level? container? none?),
network policy, secret handling, destructive-op guards.

## 7. Orchestration
Subagents/spawning, parallelism, headless/SDK/CI modes, wire protocols
(ACP, JSON-RPC, HTTP…), multi-surface story (CLI/IDE/desktop/web/cloud).

## 8. Extensibility
Hooks, skills, plugins, custom commands, themes — what can a user add without forking?

## 9. Session & state
Persistence format/location, resume/fork, checkpoints/rewind, transcript model,
cross-session memory if any.

## 10. Model layer
Provider abstraction, supported providers count/quality, auth model,
model routing/fallback, BYOK story.

## 11. Notable mechanisms
2-5 implementation details unique or unusually well-done here — the things
worth stealing.

## 12. Evidence log
- <url or repo-path@commit> — what it supported — accessed 2026-09-15
- Conflicts / gaps / unverified claims
```
