# Mini-SWE-Agent

> SWE-bench / SWE-agent team (Princeton & Stanford; authors Kilian A. Lieret, Carlos E. Jimenez et al.) · MIT · Python · First release 2025 (VENDOR-CLAIM) · **Version studied: v2.4.6 (`src/minisweagent/__init__.py`), commit `04d809ceab9df28f9adaed044884180159172930` (main), accessed 2026-09-15.** Note: this is the **v2** line — v1's ~100-line bash-only core lives on the `v1` branch; v2 defaults to the tool-calling interface while keeping the same skeleton.
> Repo: https://github.com/SWE-agent/mini-swe-agent · Docs: https://mini-swe-agent.com
> Epistemic basis: SOURCE-READ (shallow clone of `main`)

## 1. Positioning & design philosophy

The deliberate floor of the corpus: **"what if our agent was 100x simpler and still worked nearly as well?"** (README). Mini-SWE-Agent strips the harness to one agent class (~190 lines), one environment call, and one model call — no tools beyond `bash`, no state machine, no context management, no event bus. Every step appends to a plain `messages` list, so *the trajectory and the LM's context are the same object* (FACT — `agents/default.py:42,69-72`). The design goal is to isolate LM capability from scaffold complexity: it scores >74% on SWE-bench Verified (VENDOR-CLAIM, README) with a harness a single person can read in minutes. Actions run via `subprocess.run`/`docker exec` — stateless, so sandboxing is literally swapping the environment class. The paper uses it as the minimal implementation of nearly every one of its seven subsystems (arXiv:2609.00006 §2.3, §6.2.4).

## 2. Architecture overview

Single process, four polymorphic seams — `Agent`, `Environment`, `Model`, run script — each a duck-typed class pair (`config_class` + kwargs), declared as `Protocol`s in `src/minisweagent/__init__.py` (FACT). Layout:

- `src/minisweagent/agents/` — `default.py` (`DefaultAgent`, the whole loop), `interactive.py` (`InteractiveAgent` adds confirm/yolo/human modes), `utils/prompt_user.py`.
- `src/minisweagent/environments/` — `local.py` (subprocess), `docker.py`, `singularity.py`, `extra/{bubblewrap,contree,swerex_docker,swerex_modal}.py`.
- `src/minisweagent/models/` — `litellm_model.py` (default), `litellm_textbased_model.py`, `litellm_response_model.py`, `openrouter_*`, `portkey_*`, `requesty_model.py`, `extra/roulette.py`, `test_models.py`; `models/utils/` holds the two action parsers (`actions_toolcall.py`, `actions_text.py`), retry, cache-control, multimodal helpers.
- `src/minisweagent/config/` — YAML config packs (`mini.yaml` interactive default, `mini_textbased.yaml`, `default.yaml`, `benchmarks/{swebench,programbench,...}.yaml`).
- `src/minisweagent/run/` — `mini.py` (typer CLI), `hello_world.py` (42-line API example), `benchmarks/` runners, `utilities/inspector.py` (trajectory TUI).

The AGENTS.md in-repo states the design rule: "Every use case should start with a run script, that picks one agent, environment, and model class" — polymorphism instead of configuration frameworks.

## 3. Agent loop

The whole loop (`agents/default.py:88-157`, FACT):

```python
def run(self, task):
    # add system message (rendered system_template) + user message (instance_template w/ task)
    while True:
        try:
            self.step()                       # = execute_actions(query())
        except FormatError / InterruptAgentFlow / Exception:
            # append carried messages; uncaught -> save + re-raise
        finally:
            self.save(self.config.output_path)
        if self.messages[-1].get("role") == "exit":
            break
    return self.messages[-1]["extra"]         # {exit_status, submission}
```

- `query()` (line 130): checks guards — `step_limit` (0=∞), `cost_limit` (default **$3.0**), `wall_time_limit_seconds`, then `self.n_calls += 1; message = self.model.query(self.messages)`. Cost accumulates from `message["extra"]["cost"]`.
- `execute_actions()` (line 154): `[self.env.execute(action) for action in message["extra"]["actions"]]` — v2 supports multiple tool calls per response — then `model.format_observation_messages(...)` appends outputs.
- **Termination is a bash command**: the environment scans each command's stdout; if the first line is `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` and returncode is 0, `env.execute` raises `Submitted` carrying `{"role": "exit", ...}` (`environments/local.py:45-56`). There is no `finish` tool — exit is an environmental side-effect, so it works identically across local/docker/singularity.
- **Format errors**: `FormatError` (raised by action parsing) carries a user-role message rendered from `format_error_template` — the model is told what it did wrong and the loop continues; `max_consecutive_format_errors=3` ends with `RepeatedFormatError` (`default.py:100-114`).
- **Interrupts-as-exceptions**: `InterruptAgentFlow` subclasses (`Submitted`, `LimitsExceeded`, `TimeExceeded`, `UserInterruption`, `FormatError`) all carry `*messages` — control flow *is* message flow (`exceptions.py`). `InterruptAgentFlow` is caught, its messages appended, loop continues/breaks on `role=="exit"`.
- No planning mechanism, no reflection, no retry of the *environment* — LM-call retries live in the model layer (§10). Trajectory saved after **every** step in `finally` — crash-safe by construction.

## 4. Tool system

- **Inventory**: exactly one tool — `bash` (`models/utils/actions_toolcall.py:11-27`, a `{"command": str}` function). v2 default `LitellmModel._query` passes `tools=[BASH_TOOL]` (`litellm_model.py:69`). File editing = `cat <<'EOF' > file` per the prompt's "Useful command examples" (`config/mini.yaml`).
- **Two action parsers**: (a) `parse_toolcall_actions` — validates each tool call is `bash` with a `command` arg, else `FormatError` ("Unknown tool", "Missing 'command'"); (b) `parse_regex_actions` (`actions_text.py:15-40`) — the v1 style: regex-extract fenced blocks (```` ```mswea_bash_command ````), require **exactly 1** action per response. v2 permits ≥1 tool call; the text variant stays single-action.
- **Observation format**: Jinja `observation_template` → `<exception>/<returncode>/<output>` wrapper (`litellm_model.py:40-43`), emitted as `role="tool"` message with `tool_call_id` when tool-called, `role="user"` otherwise (`actions_toolcall.py:91-113`).
- **Tool-result size**: no truncation in the harness — NOT FOUND (searched `agents/`, `models/utils/`; output is passed through raw; the prompt warns nothing about limits. The model's own context window is the only bound — deliberate per §1).
- **MCP**: NOT FOUND. No MCP client, no tool registry beyond the bash constant.
- **Permissions**: none in `DefaultAgent`; see `InteractiveAgent` (§6).

## 5. Context management

- **System prompt**: a Jinja2 `system_template` + `instance_template` in YAML, rendered **once** at `run()` start with `StrictUndefined` — variables merged from agent config, `env.get_template_vars()` (`platform.uname()` fields + env vars + cwd), `model.get_template_vars()` (config), live stats (`n_model_calls`, `model_cost`, `elapsed_seconds`), and `task` (`default.py:52-67`). The paper notes the default template even carries OS-specific hints like `sed -i ''` on macOS (arXiv:2609.00006 §7.2.10).
- **History**: *none* — "a completely linear history; every step just appends" (README). The `messages` list grows unboundedly; there is no summarization, compaction, or windowing (FACT — no such code exists). Prompts warn that env vars/cwd don't persist between actions (each action is a fresh subshell), so the model is taught `cd ... && ...` prefixes instead of a stateful shell.
- **Memory/instruction files**: none built in — NOT FOUND (AGENTS.md loading, memory dirs: absent; the repo's own AGENTS.md is for human contributors, not the agent).
- **Retrieval**: none — the model greps the repo itself through bash. Matches the paper's no-embeddings observation.
- **Context overflow**: `ContextWindowExceededError` is an *abort* exception (`litellm_model.py:54`) — the run dies rather than compacting. The only mitigation is template-level.

## 6. Safety model

Deliberately minimal (paper §10.10: "only resource limits… plus an opt-in interactive confirm mode"):

- **Resource limits**: `step_limit`, `cost_limit` ($3 default), `wall_time_limit_seconds`, `max_consecutive_format_errors` — all in `AgentConfig` (`default.py:26-33`), checked pre-query.
- **Execution safety = environment choice**: `LocalEnvironment` runs `subprocess.Popen(shell=True)` on the host with a 30 s default timeout and process-group kill on timeout (`local.py:72-92` — `start_new_session`/`os.killpg` on POSIX, `process.kill` elsewhere). No sandboxing, no command filtering, no network policy in the harness itself; `DockerEnvironment` runs `docker run -d … sleep 2h` then `docker exec -w cwd <interpreter> <command>` per action (`docker.py:101-141`), `cleanup()` stops/removes the container. Singularity/bubblewrap/swerex/modal variants provide the actual isolation stories.
- **Interactive gating** (`agents/interactive.py`): `mode ∈ {human, confirm, yolo}` — `confirm` (default) prompts before executing LM commands; `whitelist_actions` regexes auto-approve; `confirm_exit` asks before accepting `Submitted`; Ctrl-C during `step()` becomes a `UserInterruption` message injected into history (the model *sees* "Interrupted by user: …"); when limits hit, the user is prompted to raise them — but only if stdin is a TTY (`_stdin_is_interactive`, lines 80-107; unattended runs exit cleanly).
- **Secrets/destructive ops**: none — no scrubbing, no guarded-ops list. NOT FOUND.

## 7. Orchestration

- **Subagents/parallelism**: none — single-threaded, single-agent. NOT FOUND.
- **Headless/CI**: `mini -t "task" --yolo` (`run/mini.py` typer CLI; `--exit-immediately` skips the finish prompt); benchmark runners (`run/benchmarks/swebench.py`, `programbench.py`) drive many instances with `batch_progress` utilities; `DefaultAgent` used directly as a Python API (`hello_world.py` is the canonical 42-line example).
- **Wire protocols**: none — no server, no ACP, no JSON-RPC. The interface *is* the Python call.
- **Multi-surface**: CLI + library + trajectory inspector TUI (`run/utilities/inspector.py`, textual `inspector.tcss`). No IDE/desktop/web surface.
- **Config-as-orchestration**: `-c` config specs accept file paths, builtin names, or `key=value` pairs recursively merged (`config/__init__.py:56` `get_config_from_spec`; `mini.py:63-92`), so `mini -c mini.yaml -c agent.mode=yolo -c model.model_name=...` composes behavior without code.

## 8. Extensibility

- **Subclass the seams**: everything is overridable — `query()`/`step()`/`execute_actions()`/`add_messages()` are the documented extension points (e.g. `InteractiveAgent` overrides `execute_actions` to insert confirmation *and* preserves partial outputs in `finally`, `interactive.py:124-139`). Custom classes are referenced by name: `--agent-class`, `--model-class`, `--environment-class` resolve dotted paths or builtin shorthands (`mini.py:57-59`, `get_agent/get_model/get_environment`).
- **Config packs**: YAML files in `config/` (builtin + `benchmarks/`) define system/instance templates, limits, model kwargs — the "prompt is config" philosophy.
- **Global config**: `~/.config/mini-swe-agent/.env` (platformdirs; `MSWEA_GLOBAL_CONFIG_DIR` override) loaded via dotenv at import; `mini-extra config set KEY VALUE` writes API keys (`__init__.py:25-38`, `run/utilities/config.py`).
- No hooks, no plugins, no skills, no slash-command registry beyond mode switches (`/y /c /u /m /h`). NOT FOUND — extension = subclass or a new run script, per the repo AGENTS.md.

## 9. Session & state

- **Persistence**: `output_path` (default `~/.config/mini-swe-agent/last_mini_run.traj.json`) written **every step** (`default.py:120-121` — `finally: self.save(...)`); format `trajectory_format: "mini-swe-agent-1.1"` — JSON with `info.model_stats` (instance_cost, api_calls), `info.config` (agent/env/model configs + class paths), `mini_version`, `exit_status`, `submission`, and the full `messages` array where each message's `extra` carries raw model response, actions, cost, timestamps, `raw_output`, `returncode` (`default.py:159-190`).
- **Resume/fork**: none — runs are one-shot; a traj file is an artifact for the inspector, not a resumable checkpoint. NOT FOUND (searched `agents/`, `run/`).
- **Cross-session memory**: none.

## 10. Model layer

- **Abstraction**: LiteLLM (`litellm_model.py:66 litellm.completion`) — 100+ providers by inheritance (VENDOR-CLAIM count from LiteLLM docs; mechanism FACT). Custom model registry JSON via `LITELLM_MODEL_REGISTRY_PATH` → `litellm.utils.register_model` (lines 32-33, 61-62).
- **Variants** (all `Model` protocol-compatible): `litellm` (tool-call, `/chat/completions`), `litellm_response` (`/responses` endpoint), `litellm_textbased` (regex actions, for models without FC), `openrouter`, `portkey`, `requesty`, `extra/roulette` (multi-model roulette for evals), `test_models` (deterministic replay model for tests — `test_models.py`).
- **Retries**: `tenacity.Retrying` — `stop_after_attempt(10)` (env `MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT`), exponential wait 4→60 s, abort (no retry) on `UnsupportedParamsError`, `NotFoundError`, `PermissionDeniedError`, `ContextWindowExceededError`, `AuthenticationError`, `KeyboardInterrupt` (`models/utils/retry.py`, `litellm_model.py:50-57,82-84`).
- **Cost**: `litellm.cost_calculator.completion_cost` per call; unknown models raise unless `cost_tracking: "ignore_errors"` / `MSWEA_COST_TRACKING` (lines 108-126); `GLOBAL_MODEL_STATS` aggregates.
- **Provider niceties**: `set_cache_control` marks the last message `cache_control: ephemeral` when configured (`default_end` mode); `_reorder_anthropic_thinking_blocks` keeps Anthropic interleaved thinking valid across turns; `multimodal_regex` can expand image paths in outputs into image content parts (`openai_multimodal.py`).
- **Auth**: env vars via global `.env`; `AuthenticationError` message extended with "set your API key with `mini-extra config set`" (line 72-74). BYOK only; no routing/fallback (that's `roulette` model's job).

## 11. Notable mechanisms

1. **Exit-via-stdout sentinel** — task completion is a first line of bash output equal to `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` with rc=0, detected in the *environment* (`local.py:45-56`, same code in `docker.py:138-148`). Submission works on any shell, needs no tool plumbing, and double-loads as the harness's stop signal. Steal this: environment-level exit detection decouples "agent done" from any specific tool interface.
2. **Control flow = exceptions carrying messages** — `InterruptAgentFlow(*messages)` unifies submission, limits, format errors, and user interruptions: whatever interrupts the loop already contains the messages to append (`exceptions.py`, `default.py:96-124`). The agent loop reads top-to-bottom with zero hidden state.
3. **Trajectory == context** — because history is linear and every message (incl. `extra` with raw response, cost, returncode) is the same object the LM saw, the saved `.traj.json` is simultaneously the training/eval record and the debugging transcript. No projection layer needed.
4. **`finally: save()` per step** — crash mid-run still yields a complete trajectory ending in an `exit` message synthesized by `handle_uncaught_exception` (role "exit", `exit_status=<ExceptionClass>`, traceback) — a research-harness property production harnesses often lack.
5. **Stateless subshell discipline** — no persistent shell; the prompt explicitly teaches `VAR=x cd dir && cmd` composition (`mini.yaml` "Directory or environment variable changes are not persistent"). This makes `docker exec`-style sandboxing a drop-in and removes a whole class of stateful-shell bugs; the README calls it "a big deal" for stability.
6. **Config spec algebra** — `-c` accepts paths, builtin names, *and* `a.b.c=value` literals merged recursively (`config/__init__.py:31-64`); every knob is reachable from CLI without code.

## 12. Evidence log

- `src/minisweagent/agents/default.py`, `agents/interactive.py`, `exceptions.py` @04d809ce — loop, limits, interrupt-as-message control flow, confirm modes — accessed 2026-09-15
- `src/minisweagent/environments/local.py`, `environments/docker.py` @04d809ce — subprocess/exec execution, submit sentinel, timeouts — accessed 2026-09-15
- `src/minisweagent/models/litellm_model.py`, `models/utils/{actions_toolcall,actions_text,retry,cache_control,anthropic_utils,openai_multimodal}.py` @04d809ce — tool def, parsers, retries, cost — accessed 2026-09-15
- `src/minisweagent/config/mini.yaml`, `mini_textbased.yaml`, `config/__init__.py`, `run/mini.py`, `run/hello_world.py`, `__init__.py` @04d809ce — templates, config resolution, CLI surface, protocols — accessed 2026-09-15
- `README.md`, in-repo `AGENTS.md` @04d809ce — design philosophy, v2 note, SWE-bench claims (VENDOR-CLAIM) — accessed 2026-09-15
- https://arxiv.org/abs/2609.00006 (HTML v1) — §6.2.4 minimal linear loop (paper's Listing 1 matches `default.py` modulo renames), §7.2.10 one-shot templates, §9.2 linear history, §10.10 minimal safety — accessed 2026-09-15
- Conflicts/gaps: paper studied v2.4.5 (Jul 2026); I studied v2.4.6 — core identical, config wording may differ slightly. SWE-bench ">74%" is VENDOR-CLAIM (README), not re-measured. `environments/extra/*` (bubblewrap, contree, swerex_*) and `models/extra/roulette.py` read by signature only. Full SWE-agent comparison left at passing-reference level per assignment.
