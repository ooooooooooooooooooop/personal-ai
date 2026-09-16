# Aider

> Paul Gauthier / Aider-AI (community) · Apache-2.0 · Python · First release 2023 (VENDOR-CLAIM per project history) · **Version studied: v0.86.3.dev (`aider/__init__.py`), commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (main, dated 2026-05-22), accessed 2026-09-15**
> Repo: https://github.com/Aider-AI/aider · Docs: https://aider.chat
> Epistemic basis: SOURCE-READ (shallow clone of `main`; cross-referenced against arXiv:2609.00006)

## 1. Positioning & design philosophy

Aider is the original pair-programming terminal agent, and its bet is *edit-format polymorphism without tools*: rather than expose a tool-calling API surface, aider treats the LLM reply itself as a patch document, parsed by one of 13 registered "coder" strategies (SEARCH/REPLACE blocks, unified diffs, whole-file rewrites, a git-style patch DSL, etc.) selected per model (FACT — `aider/coders/__init__.py`, `aider/coders/base_coder.py:190`). Its second bet is that git is the safety layer: every applied edit is auto-committed (`auto_commit`, `base_coder.py:2375`), making `/undo` a mechanical `git reset` over aider's own commit hashes (`commands.py:553`). There is no agent loop in the modern sense — one user turn is one LLM response plus a bounded *reflection* loop (max 3) that re-queries the model when edits fail to parse, lint fails, or tests fail (FACT — `base_coder.py:924-944`). The paper classifies aider as the corpus's only "reflection-augmented" main loop and notes it has no tool-call loop at all: "a turn ends when the completion stream finishes" (arXiv:2609.00006 §6.3).

## 2. Architecture overview

Single Python process, synchronous, REPL-style (FACT). Entry point `aider/main.py:451 main()` → argparse stack (`aider/args.py`) → builds `InputOutput` (terminal I/O + confirmation prompts, `aider/io.py`), `GitRepo` (`aider/repo.py`), `Model` (`aider/models.py`), then `Coder.create(...)` which iterates `coders.__all__` and instantiates the first class whose `edit_format` class attribute matches (`base_coder.py:124-201`). Modules:

- `aider/coders/` — 14 coder classes, 13 registered edit formats (the `Coder` base class has `edit_format=None` and is not registered). Notable: `editblock_coder.py` (SEARCH/REPLACE, `edit_format="diff"`), `wholefile_coder.py`, `udiff_coder.py`, `patch_coder.py`, `architect_coder.py`, plus `editor_*` variants used as the second stage in architect mode. Three function-calling coders remain in the tree unregistered (one commented out of `coders/__init__.py`, two never imported) — matches the paper's count of exactly 13 registered formats (arXiv:2609.00006 §7.2.9).
- `aider/repomap.py` — the repo-map subsystem (see §5, §11).
- `aider/commands.py` — 43 `cmd_*` slash-command handlers.
- `aider/models.py`, `aider/llm.py`, `aider/sendchat.py` — model layer over LiteLLM.
- `aider/io.py` — prompt_toolkit input, `confirm_ask` permission prompts, chat-history file writer.
- `aider/linter.py`, `aider/history.py`, `aider/repo.py` — lint pipeline, history summarizer, git integration.
- `aider/gui.py` — a Streamlit browser UI wrapping the same `Coder` (`--browser`/`--gui`); `aider/watch.py` — file watcher for `AI`/`AI!`/`AI?` comments; `aider/copypaste.py` — clipboard watcher for driving web-chat UIs.

Process model: one interactive process; background threads exist for cache warming (`base_coder.py:1340-1392`), history summarization (`base_coder.py:1011`), and file watching — but the LLM interaction is a single request/response cycle per turn.

## 3. Agent loop

`Coder.run()` (`base_coder.py:876`) is a human-in-the-loop REPL: `get_input()` (prompt_toolkit, with file completion and `/command` handling) → `run_one(user_message, preproc)` → `send_message()`. Turn structure (FACT — `base_coder.py:1419-1623`):

1. Append user message; `format_messages()` builds `ChatChunks`; `check_tokens()` warns + asks if estimated input exceeds `max_input_tokens` (line 1396).
2. `send()` streams the LiteLLM completion. Retries on LiteLLM exceptions with exponential backoff starting at 0.125 s, capped by `RETRY_TIMEOUT`; `ContextWindowExceededError` marks the turn exhausted (lines 1449-1512).
3. `FinishReasonLength` handling: if the model supports `assistant_prefill`, the partial response is appended as an assistant message with `prefix=True` and generation continues in a `while True` loop (lines 1492-1505) — multi-part response stitching.
4. `KeyboardInterrupt` records "^C KeyboardInterrupt" in history (line 1577).
5. `check_for_file_mentions(content)` — if the reply mentions repo filenames not in chat, sets `reflected_message` asking to add them (line 1561).
6. `apply_updates()` → `get_edits()` (coder-specific parser) → `apply_edits_dry_run` → `prepare_to_edit` → `apply_edits`; a `ValueError` (malformed edit) becomes `reflected_message` with the error text fed back to the model (lines 2296-2336).
7. On successful edits: `auto_commit()` → optional `auto_lint` (`lint_edited`, then `confirm_ask("Attempt to fix lint errors?")` → reflect) → `run_shell_commands()` (LLM-proposed shell blocks, user-confirmed) → optional `auto_test` (`/test` output → reflect).
8. `run_one` re-sends while `reflected_message` is set, capped by `max_reflections = 3` (line 101; stop message at line 939).

Stopping: no tool loop, no max-turn guard beyond the reflection cap; `num_exhausted_context_windows` and `num_malformed_responses` are tracked for diagnostics. INFERENCE: aider's "agentic" power lives entirely in the reflection channel — the model gets at most 3 corrective re-prompts per user turn, each carrying a concrete error string (lint output, test output, or a `SearchReplaceNoExactMatch` did-you-mean report).

## 4. Tool system

There are **no tools** in the function-calling sense in the default configuration (FACT — tools/function-calling coders exist in-tree but are not registered: `wholefile_func_coder.py`, `single_wholefile_func_coder.py` (commented out in `coders/__init__.py:16`), `editblock_func_coder.py` never imported). The model's output channel carries everything:

- **Edit mechanism**: 13 registered formats. The default for most frontier models is `"diff"` (`models.py` sets `edit_format = "diff"` repeatedly in per-model settings, lines ~439-596; `ModelSettings.edit_format` default is `"whole"`, line 131). `EditBlockCoder` parses `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks inside fenced code blocks preceded by a full file path (`editblock_coder.py:386-396`, prompts in `editblock_prompts.py:120-159`). `find_original_update_blocks` tolerates 5-9 marker chars, searches the previous 3 lines for the filename with exact/basename/fuzzy matching against chat files (`find_filename`, lines 538-599), and extracts ```` ```bash ```` blocks as *shell command suggestions* (`editblock_coder.py:452-484`).
- **Match cascade** (`do_replace` → `replace_most_similar_chunk`, lines 134-183): exact line-tuple match → leading-whitespace-flexible match (`replace_part_with_missing_leading_whitespace`, GPT's uniform outdent bug) → spurious leading blank line skip → `...` elision handling (`try_dotdotdots`, splits on `^\s*\.\.\.\n$` and requires each chunk to match uniquely). Notably, fuzzy `replace_closest_edit_distance` (SequenceMatcher ≥0.8) is **dead code** — an unconditional `return` at line 184 precedes it. FACT.
- **udiff format** (`udiff_coder.py`) emits `diff -U0`-style hunks and uses `search_replace.py`'s heavier machinery: `RelativeIndenter` (rewrites leading whitespace as per-line deltas with a `←` outdent marker, choosing a collision-free Unicode codepoint — `search_replace.py:18-104`) plus `diff_match_patch` fuzzy hunk application. The paper calls RelativeIndenter "the most sophisticated solution to indentation-sensitive matching" in the corpus (arXiv:2609.00006 §8.4).
- **Failed edits** produce a structured `ValueError` (`SearchReplaceNoExactMatch` + `find_similar_lines` did-you-mean block + "other N blocks applied, don't re-send them") which becomes the next `reflected_message` (`editblock_coder.py:84-124`).
- **Shell commands**: model-suggested ```` ```bash ```` blocks → `run_shell_commands()` → per-command `confirm_ask(explicit_yes_required=True, group=ConfirmGroup, allow_never=True)` → `run_cmd` subprocess in repo root (`base_coder.py:2434-2485`).
- **MCP**: NOT FOUND (searched `aider/` — no MCP client; the only hits are website asset filenames).
- **Web**: `/web <url>` scrapes a page into context (`commands.py:219`, `aider/scrape.py`, optional Playwright).

## 5. Context management

System prompt assembly in `format_chat_chunks()` (`base_coder.py:1226-1331`), chunk order fixed by `ChatChunks.all_messages()` (`chat_chunks.py:16-26`):

`system → examples → readonly_files → repo (repo-map) → done (history) → chat_files → cur (current turn) → reminder`

- `main_sys` = per-format `main_system` prompt + `system_reminder`, templated with `{fence}`, `{platform}`, `{shell_cmd_prompt}`, `{final_reminders}` (lazy/overeager model quirks, reply-language) — `fmt_system_prompt` (lines 1174-1224). Few-shot `example_messages` are either a separate message pair list or folded into the system message for models flagged `examples_as_sys_msg`; for models without system-prompt support the whole thing ships as `user`/`Ok.` (lines 1266-1274).
- Repo-map message pair ends with assistant "Ok, I won't try and edit those files without asking first." — the read-only contract for files outside the chat is enforced *by prompt*, not by the tool layer (lines 750-761).
- Chat files are injected **in full** with `fence` wrappers (`get_files_content`, line 637); read-only files likewise. Images/PDFs become `image_url` parts for `supports_vision`/`supports_pdf_input` models (lines 807-857).
- **Repo-map** (`repomap.py`): tree-sitter `tags.scm` queries per language extract `def`/`ref` symbol Tags (cached in a `diskcache` SQLite dir `.aider.tags.cache.v4` keyed on mtime; Pygments lexer backfills refs for def-only languages, lines 279-363). A `networkx.MultiDiGraph` links referencer→definer files per identifier, edge weight `sqrt(num_refs) × mul` where mul boosts mentioned idents ×10, snake/kebab/camel names ≥8 chars ×10, penalizes `_`-prefixed ×0.1 and over-defined idents ×0.1, and ×50 when the referencer is a chat file (lines 481-514). `nx.pagerank` with personalization seeded on chat+mentioned files (100/num_nodes); node rank is distributed over out-edges into `ranked_definitions`; a binary search over the top-N prefix fits `max_map_tokens` (default 1024, clamped to [1024, 4096] as `max_input/8`; ×8 when chat has no files) within 15% tolerance (lines 629-706). Rendering uses `TreeContext` (grep_ast) showing definition lines plus enclosing scope lines; lines truncated at 100 chars. Important files (README etc., `special.filter_important_files`) are prepended even if unranked.
- **History compaction**: `ChatSummary` (`history.py`) — when `done_messages` exceeds `max_chat_history_tokens` (default `min(max(max_input/16, 1024), 8192)`, `models.py:358`), a background thread (`summarize_start`, `base_coder.py:1002-1034`) splits history into head+tail, keeps the tail verbatim (~half the budget), LLM-summarizes the head with a dedicated prompt, and recurses ≤3 deep if still over budget (FACT; matches paper §9.3 "recursive halving"). The weaker `weak_model` can be assigned for summarization.
- **Prompt caching**: `add_cache_control_headers` marks breakpoints at end of examples/system, repo, and chat_files chunks (`cache_control: ephemeral`, Anthropic-style; `chat_chunks.py:28-55`); a `warm_cache` daemon pings the endpoint with `max_tokens=1` every ~295 s to keep the cache alive (`base_coder.py:1340-1392`, `AIDER_CACHE_KEEPALIVE_DELAY` override).
- Instruction files: no AGENTS.md loader — NOT FOUND (searched `args.py`, `main.py`, `coders/`); the documented pattern is `--read CONVENTIONS.md` to inject a read-only file (`args.py:736`).
- Retrieval: tree-sitter symbols + PageRank only — deterministic, no embeddings (matches paper's twin-absence finding, arXiv:2609.00006 §13.2).

## 6. Safety model

Thin by design (paper §10.10 groups aider + mini-swe-agent as "minimal safety"):

- **Confirmation prompts** via `io.confirm_ask` (`io.py:807-906`): shell commands require explicit `y` (`explicit_yes_required=True`, `base_coder.py:2456-2462`), with `(A)ll`/`(S)kip all`/`(D)on't ask again` group options (`ConfirmGroup`, `never_prompts` set). `--yes-always` sets `io.yes=True`. Adding files, fixing lint/test errors, opening URLs, proceeding past token limits are all `confirm_ask` gates.
- **File-write boundary is social**: the model is told to ask the user to `/add` files before editing them (system prompt, `editblock_prompts.py:19-21`), and aider enforces chat-file membership only softly — a failed filename resolution falls back to fuzzy-matching against in-chat files, and `check_for_file_mentions` reflects a "did you mean to add this file?" message. FACT: nothing prevents an edit to a non-chat file if parsing resolves a path; the repo-map's assistant reply literally encodes the contract.
- **Git as undo**: auto-commits every successful edit (`auto_commit`, `base_coder.py:2375`); `/undo` resets HEAD only if the last commit hash is in `aider_commit_hashes` (session-scoped allowlist) and files aren't dirty (`commands.py:553+`). Dirty files are committed first via `dirty_commit`/`need_commit_before_edits`.
- **Sandboxing**: none — shell commands run in a subprocess on the host (`run_cmd`, `base_coder.py:2475`). Docker usage docs exist but aren't enforced in code.
- **Secrets**: `.env` is auto-suggested for `.aiderignore`/gitignore (`main.py:166-168`); `.aiderignore` excludes paths from repo scanning (`args.py:422-431`, `repo.py:500+`). No secret scrubbing of transcripts.
- **Destructive ops**: only the confirmation prompts; `/git reset --hard` is suggested in an error message with an explicit "destructive" warning (`commands.py:573-575`).

## 7. Orchestration

- **Subagents**: none in the general sense. The `architect` format is a sequential two-model pipeline: `ArchitectCoder.reply_completed()` asks "Edit the files?", then creates a fresh `editor` coder via `Coder.create(from_coder=self, main_model=editor_model, edit_format=editor_edit_format)` and runs it with the architect's prose as input (`architect_coder.py:11-47`). Chat history is summarized when switching edit formats because old-format assistant messages would confuse the new format (`base_coder.py:161-167`). FACT.
- **Headless/scripting**: `--message`, `--message-file`, `--yes`, `--exit`, `--no-auto-commits` (`main.py:1126-1150`); `Coder.run(with_message=...)`. `python -m aider` entry via `__main__.py`. Also usable as a library (`return_coder=True` from `main()`), though undocumented.
- **Alternate surfaces**: Streamlit GUI (`--browser`/`--gui`, `gui.py` wraps `Coder` with `CaptureIO`); `--watch-files` mode — a `watchfiles` watcher scans repo files for `AI` comments (`AI?` = ask mode, `AI!` = code mode; `watch.py:65-283`); `--copy-paste` mode watches the clipboard so aider can drive a web chat UI (`copypaste.py`, `ClipboardWatcher`); `/voice` for audio input.
- **Wire protocols**: none — no ACP, no JSON-RPC, no daemon mode. NOT FOUND.
- **Parallelism**: none for edits; background threads only for cache warming, summarization, watching.

## 8. Extensibility

No plugin/hook/skill system. What a user can change without forking (FACT):

- **Config layering**: `.aider.conf.yml` (searched in git root, cwd, home; `main.py:464`), `.aider.model.settings.yml` (per-model overrides: edit_format, temperatures, extra params — `main.py:337`), `.aider.model.metadata.json` (context/cost metadata), `.env` files, `~/.aider/oauth-keys.env`, env vars per arg (`args.py` auto-generates `AIDER_*` env names).
- **Model registry extension**: `--model` accepts any LiteLLM name; `register_litellm_models` (`models.py:1112`) loads custom model defs; `.aider.model.settings.yml` can declare new model behaviors (edit format per model is the big lever).
- **Slash commands**: fixed set of 43 `cmd_*` methods (`commands.py`) — `/add /drop /read-only /lint /test /run /git /undo /diff /map /map-refresh /tokens /clear /reset /ask /code /architect /context /web /voice /paste /load /save /copy /copy-context /model(s) /editor-model /weak-model /think-tokens /reasoning-effort /settings /report /editor /help /exit` — not user-extendable.
- **Lint/test hooks**: `--lint-cmd lang:cmd`, `--test-cmd`, `--auto-lint/--auto-test` — the verification loop is user-wired (linter.py also has built-in Python compile+flake8).
- **Read-only context files**: `--read`, `/read-only` — the "memory file" story.
- **Themes/UI**: prompt_toolkit styling options; `rich` markup.

## 9. Session & state

- **Persistence**: append-only Markdown transcript `.aider.chat.history.md` (repo root; `args.py:275`, written by `io.py:1128-1136`) — human-readable, feeds `/load` and `--copy-paste` mode; input history `.aider.input.history` (prompt_toolkit `FileHistory`, `io.py:355`); tags cache `.aider.tags.cache.v{3|4}/` (diskcache).
- **Resume**: `--restore-chat-history` replays `.aider.chat.history.md` into `done_messages` (`main.py:988`); `/load` executes commands from a file; `/save` writes command scripts. FACT: there is no opaque checkpoint format — resume = replay the transcript.
- **Checkpoints/rewind**: git. `commit_before_message` tracks HEAD per turn; `/undo` rewinds aider commits; `/diff` shows the aggregate diff of `aider_commit_hashes`. The chat state itself (in-chat file set, read-only set) is not persisted across runs except via `--restore-chat-history` + re-adding files (INFERENCE from restore path).
- **Cross-session memory**: none beyond the files above; repo-map cache persists symbol tags keyed by mtime.

## 10. Model layer

- **Abstraction**: LiteLLM via a lazy-import shim (`aider/llm.py` `LazyLiteLLM` — comment notes `import litellm` takes 1.5 s, so the module defers until first attribute access; `llm.py:16-40`). `send_completion` → `litellm.completion` (`models.py:985-1036`).
- **Model metadata**: `Model`/`ModelSettings` dataclass (`models.py:132-329`) merges built-in per-model settings with litellm's `model_prices_and_context_window.json` (fetched from the LiteLLM GitHub mirror, `models.py:163`) plus `.aider.model.metadata.json` and `.aider.model.settings.yml` overrides. This registry drives per-model `edit_format` defaults, `use_system_prompt`, `examples_as_sys_msg`, `supports_assistant_prefill`, `reminder` style (sys vs user), `lazy`/`overeager` prompt nudges, token limits. Paper: "a model registry containing per-model metadata for 350+ models" (arXiv:2609.00006 §7.1) — VENDOR-CLAIM-adjacent count, directionally consistent with the settings table size.
- **Three-model topology**: `main_model` (editing), `weak_model` (history summarization, commit messages, `/help` — defaults to a cheaper sibling via `get_weak_model`, `models.py:603`), `editor_model` (second stage of architect mode, `get_editor_model`, line 625). `sanity_check_models` validates API keys at startup and warns about weak/editor model problems (line 1150+).
- **Auth**: env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …), `.env`, `~/.aider/oauth-keys.env`, OpenRouter OAuth flow (`main.py:786-795`), `--api-key provider=key` (`main.py:594-606`). BYOK is the only model.
- **Routing/fallback**: none automatic — user picks `--model`; retries are same-model LiteLLM retries. Prompt caching support is per-model (`add_cache_headers`).
- **Other LLM call sites**: commit-message generation (`repo.py:326 get_commit_message`), history summarizer, URL scraper hinting, `/help` (RAG over bundled docs index — `help.py` uses an embeddings-free retrieval? NOT VERIFIED in depth — `/help` uses a prebuilt index; flagged as a gap).

## 11. Notable mechanisms

1. **Edit-format polymorphism via class registry** — `Coder.create` dispatches on a class-level `edit_format` string; adding a format = subclass `Coder` + a `*Prompts` class + register in `__all__`. The prompt, few-shots, reminder, parser, and failure messages are co-located per format (FACT, `coders/__init__.py`, `base_coder.py:190`). This is a cheap, readable plugin point.
2. **Repo-map = PageRank over a symbol-reference graph** — tree-sitter defs/refs → directed multigraph → personalized PageRank seeded by chat files/mentioned idents → rank redistributed onto definition tags → binary-searched to a token budget → `TreeContext` render with scope headers (`repomap.py:365-706`). Deterministic, cached on mtime, embedding-free.
3. **Reflection channel** — one mechanism (`reflected_message`) serves malformed edits, lint failures, test failures, and file-mention suggestions; capped at 3. The failure messages are engineered prompts ("SearchReplaceNoExactMatch", did-you-mean blocks) — error text *is* the retry prompt (`editblock_coder.py:84-124`).
4. **Assistant-prefill continuation** — on `FinishReasonLength`, aider appends the partial output as an assistant message with `prefix=True` and continues the stream, so models with prefill support (Claude) get effectively unbounded replies (`base_coder.py:1492-1505`).
5. **Cache-warming daemon** — sends `max_tokens=1` requests on a timer to keep provider-side prompt caches hot (`base_coder.py:1357-1390`) — an unusual, pragmatic cost optimization.
6. **Disabled fuzzy matcher** — `replace_closest_edit_distance` is unreachable (unconditional `return`, `editblock_coder.py:184`); exact+whitespace+elision won over fuzzy matching in this format. Worth noting because the *udiff* path does keep `diff_match_patch` fuzz — aider contains both philosophies, per format.

## 12. Evidence log

- `aider/coders/base_coder.py` @5dc9490b — main loop, reflection cap, send/retry, chunk assembly, auto-commit/lint/test wiring — accessed 2026-09-15
- `aider/coders/editblock_coder.py`, `editblock_prompts.py`, `search_replace.py`, `udiff_coder.py`, `patch_coder.py`, `architect_coder.py`, `coders/__init__.py` @5dc9490b — edit formats, match cascade, RelativeIndenter, format registry — accessed 2026-09-15
- `aider/repomap.py` @5dc9490b — tags/PageRank/token-fit map — accessed 2026-09-15
- `aider/coders/chat_chunks.py`, `aider/history.py`, `aider/models.py`, `aider/llm.py` @5dc9490b — chunk order, summarizer, model registry, LiteLLM shim — accessed 2026-09-15
- `aider/io.py`, `aider/commands.py`, `aider/repo.py`, `aider/main.py`, `aider/args.py`, `aider/watch.py`, `aider/gui.py`, `aider/copypaste.py` @5dc9490b — confirmations, commands, git safety, entry/config, alt surfaces — accessed 2026-09-15
- https://arxiv.org/abs/2609.00006 (HTML v1) — §6.3 reflection loop, §7.2.9 polymorphic prompts, §8.4 RelativeIndenter/editing genealogy, §9.3 summarization, §10.10 minimal safety — accessed 2026-09-15
- Conflicts/gaps: paper says "13 registered edit formats" — confirmed by counting `coders.__all__` with non-None `edit_format`. `/help` internals (retrieval index in `aider/help.py`, `aider/resources/`) not deeply audited. `analytics.py` telemetry exists but was not audited for contents. Benchmark claims (e.g., polyglot leaderboard) not verified — VENDOR-CLAIM only.
