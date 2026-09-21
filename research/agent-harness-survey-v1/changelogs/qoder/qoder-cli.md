> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Qoder CLI Release Notes

> Release history for Qoder CLI.

This page lists the release history for Qoder CLI, with the newest version first.

<div id="1158-2026-09-19" />

<Update label="September 19, 2026" description="CLI 1.1.58">
  ### Stability Improvements

  - Fixed several issues and improved stability
</Update>

<div id="1157-2026-09-19" />

<Update label="September 19, 2026" description="CLI 1.1.57">
  ### Hardened Automatic Git Checks

  - Fixed a security issue where internal Git calls could execute commands configured in a repository.
</Update>

<div id="1156-2026-09-18" />

<Update label="September 18, 2026" description="CLI 1.1.56">
  ### Auto Mode, Sites, and Bash Improvements

  - Improved Auto mode: when the auto-approval component is temporarily unavailable, it now falls back to user confirmation and shows the reason
  - Added support for setting site environment variables via the `/sites` management panel
  - Added a warning for overly long AGENTS.md content
  - Fixed an error that occurred during auto compaction
  - Improved Bash command execution so configuration and plugin PATH are reliably passed through, with clearer bounded diagnostics for execution, snapshot, and output failures
</Update>

<div id="1155-2026-09-17" />

<Update label="September 17, 2026" description="CLI 1.1.55">
  ### Improved Configuration Handling and Skill Discovery

  - Fixed concurrent configuration updates in Qoder CLI overwriting each other
  - Improved skill discovery logic in the Skill tool
  - Model requests now apply the model catalog’s default reasoning effort when no effort is configured, while preserving explicit settings and disabled reasoning.
</Update>

<div id="1154-2026-09-16" />

<Update label="September 16, 2026" description="CLI 1.1.54">
  ### Sites Publishing and Management with More Reliable Sessions

  - Added Sites publishing and management, allowing websites to be created and published with natural language and viewed and managed in `/sites`
  - Improved handling of compaction failures
  - Improved Spinner to show Hook execution status event name and progress
</Update>

<div id="1153-2026-09-15" />

<Update label="September 15, 2026" description="CLI 1.1.53">
  ### Improved session name display and history browsing interactions

  - Custom session names now appear on the input border, update immediately after renaming, and are restored when resuming or branching a session.
  - Updated /btw history browsing with Shift+Arrow, \[, ], and Tab shortcuts, contextual scroll hints, and protection against Shift+Tab accidentally changing the permission mode.
</Update>

<div id="1152-2026-09-14" />

<Update label="September 14, 2026" description="CLI 1.1.52">
  ### Improved the rename and btw commands

  - Type `/rename` to auto-generate a session name based on the current conversation; manually entered names are automatically sanitized and length-limited
  - `/btw` now keeps Q\&A records within the current session and supports continuous follow-up questions; entering `/btw` again without a question reopens the latest answer, with options to browse, scroll, copy, or clear the records
</Update>

<div id="1151-2026-09-12" />

<Update label="September 12, 2026" description="CLI 1.1.51">
  ### Enhanced MCP connectivity and Chinese tool support

  - Added support for connecting to MCP services via the Qoder MCP gateway
  - Added support for recognizing and using Chinese MCP tools
</Update>

<div id="1150-2026-09-11" />

<Update label="September 11, 2026" description="CLI 1.1.50">
  ### Enhanced /model configuration and fixed preview and session resume issues

  - Fixed the layout issue in the long content preview of the AskUser tool
  - Personal edition users can now centrally configure and manage BYOK models with custom URL endpoints from the Custom page in `/model`
  - Fixed being unable to resume history sessions when the Git repository is located at the Windows filesystem root
  - Improved `/model` to support adjusting the model's thinking effort and context window, with all changes saved in a single confirmation
</Update>

<div id="1149-2026-09-10" />

<Update label="September 10, 2026" description="CLI 1.1.49">
  ### New video generation tool with performance and reliability improvements

  - Fixed an issue in Windows Git Bash where a ShellSnapshot timeout could cause the first Bash command and the entire session to hang permanently
  - Improved auto-compaction speed
  - Improved the validation that requires reading a file before editing it
  - Fixed date awareness becoming stale in long sessions spanning multiple days
  - Added a video generation tool supporting text-to-video, first-frame-to-video, and reference-image-to-video; tasks run in the background and are automatically downloaded locally with a notification on completion
</Update>

<div id="1148-2026-09-09" />

<Update label="September 9, 2026" description="CLI 1.1.48">
  ### Clearer Permission Denial Feedback and Support Model Call Limits

  - Improved the experience when a tool permission request is denied, adding clearer explanations that are easier to understand and follow
  - Added support for setting a per-request limit on the number of model calls in TUI sessions
</Update>

<div id="1147-2026-09-08" />

<Update label="September 8, 2026" description="CLI 1.1.47">
  ### Faster Startup and More Flexible Model Selection

  - Added the `/output-style` command to select an output style for the current project in the interactive interface
  - Added support for applying a model only to the current session with `s` in the `/model` selector
  - Upgraded the bundled runtime to Bun 1.4.2, improving startup speed, idle CPU usage, and steady-state RSS consumption
  - Fixed special nested commands being incorrectly intercepted
  - Fixed a file descriptor leak when a shell command fails to start after its output file has been opened.
</Update>

<div id="1146-2026-09-07" />

<Update label="September 7, 2026" description="CLI 1.1.46">
  ### Interactive Workflows and Chinese TUI Support

  - Improved the workflow execution flow
  - Added support for setting the TUI interface to Simplified Chinese through `/settings`
  - Fixed path resolution errors when authorizing directories outside the workspace in Windows sessions
  - Improved GLM context limit handling by automatically compacting history messages and retrying when conversations are too long
</Update>

<div id="1145-2026-09-05" />

<Update label="September 5, 2026" description="CLI 1.1.45">
  ### Performance Optimization

  - Optimized performance issues
</Update>

<div id="1144-2026-09-05" />

<Update label="September 5, 2026" description="CLI 1.1.44">
  ### Stability Fixes

  - Fixed stability issues
</Update>

<div id="1143-2026-09-04" />

<Update label="September 4, 2026" description="CLI 1.1.43">
  ### Remote Cloud Execution and Path Handling Fixes

  - Fixed valid special paths being incorrectly blocked as UNC paths
  - Fixed cloud task connection issues when created with '--remote'
</Update>

<div id="1142-2026-09-03" />

<Update label="September 3, 2026" description="CLI 1.1.42">
  ### Performance and Reliability Improvements

  - Improved responsiveness and reduced CPU usage when resuming large sessions and rendering long streaming output
  - Limited transcript loading in the session picker to improve performance with large session histories
  - Fixed persisted scheduled tasks failing to run after session changes or when multiple sessions are open in the same project
  - Labeled scheduled tasks owned by the current session in the `OWNER` column
  - Increased the default `/goal` maximum interaction turn limit from 20 to 100
  - Limited subagent spawning to one nested level by default
  - Quest Skills can only be manually triggered by the user via the `/quest` command
</Update>

<div id="1141-2026-09-02" />

<Update label="September 2, 2026" description="CLI 1.1.41">
  ### Stability Improvements

  - Bug fixes and stability improvements
</Update>

<div id="1140-2026-09-01" />

<Update label="September 1, 2026" description="CLI 1.1.40">
  ### Permission Mode Behavior Adjustments

  - Adjusted permission validation behavior in Auto mode
</Update>

<div id="1139-2026-09-01" />

<Update label="September 1, 2026" description="CLI 1.1.39">
  ### External Providers and Reliability Improvements

  - Supported correct Notification hook triggering during authorization prompts
  - Fixed startup progress appearing in the session feed and canceled compaction leaving its progress indicator visible
  - Fixed transcript lookup when Windows path casing differs
  - Improved recovery after model output reaches the maximum token limit
</Update>

<div id="1138-2026-08-31" />

<Update label="August 31, 2026" description="CLI 1.1.38">
  ### MCP Authentication and Compaction Fixes

  - Fixed MCP authentication expiration not being recognized correctly, and improved the pending-authentication hints in `/mcp`
  - Fixed automatic compaction failing on oversized images
</Update>

<div id="1137-2026-08-30" />

<Update label="August 30, 2026" description="CLI 1.1.37">
  ### Permission System Fixes

  - ACP sessions now offer the same selectable permission modes as the TUI
  - Fixed several known permission issues
</Update>

<div id="1136-2026-08-29" />

<Update label="August 29, 2026" description="CLI 1.1.36">
  ### Permission System Consistency Overhaul

  - The permission modes available over ACP now match those in the TUI
  - Fixed several known permission issues
</Update>

<div id="1135-2026-08-29" />

<Update label="August 29, 2026" description="CLI 1.1.35">
  ### Terminal Setup and Input Experience Improvements

  - Added the `/terminal-setup` command in the TUI: it automatically detects and configures the terminal's multiline input capability
  - Improved inline command hints and completions
  - Improved startup time
</Update>

<div id="1134-2026-08-29" />

<Update label="August 28, 2026" description="CLI 1.1.34">
  ### Stability Improvements

  - Bug fixes and stability improvements
</Update>

<div id="1133-2026-08-28" />

<Update label="August 28, 2026" description="CLI 1.1.33">
  ### Skills Command Improvements and Context Accuracy

  - Improved the `skills` command: `-s` and `--scope` are now consistently supported, and `project` can be used for the project-level scope
  - Fixed `skills install`, `skills link`, `skills uninstall`, `skills enable`, and `skills disable` giving no feedback after running
  - Improved the accuracy of usage statistics and categorization in `/context`
  - Improved the usability of running `/compact` manually after switching models
  - Fixed custom models (BYOK) being unable to handle images
</Update>

<div id="1132-2026-08-27" />

<Update label="August 27, 2026" description="CLI 1.1.32">
  ### UltraCode Mode and Startup Speedup

  - Added UltraCode mode: Workflow multi-agent orchestration can be triggered with the `/effort ultracode` command or the `ultracode` keyword
  - Fixed automatic compaction failing
  - Improved the parallel tool execution experience: tools in the same parallel batch now show their status as soon as they finish
</Update>

<div id="1131-2026-08-26" />

<Update label="August 26, 2026" description="CLI 1.1.31">
  ### Auto-Compaction Accounting and Subagent Limits

  - Fixed auto-compaction not being triggered
  - Added a concurrency limit for subagents, configurable via the `QODER_CLI_MAX_CONCURRENT_SUBAGENTS` environment variable
</Update>

<div id="1130-2026-08-25" />

<Update label="August 25, 2026" description="CLI 1.1.30">
  ### Permission Coverage and Search Defaults

  - Fixed directories configured with read deny rules still being searchable
  - Fixed WebFetch deny/ask rules not taking effect
  - Fixed settings.skills.disabled not applying to built-in bundled skills
  - Fixed --max-turns not taking effect
  - Fixed missing @-file completions and corrected case-sensitivity semantics
</Update>

<div id="1129-2026-08-24" />

<Update label="August 24, 2026" description="CLI 1.1.29">
  ### History Rewind After Compaction

  - Fixed being unable to fork and rewind history messages after compaction
</Update>

<div id="1128-2026-08-21" />

<Update label="August 21, 2026" description="CLI 1.1.28">
  ### Skills Auto-loading for Added Directories and MCP Approval Fix

  - Added automatic loading of skills in a directory added with `/add-dir`
  - Fixed MCP tool calls being approved without a prompt in `acceptEdits` mode
</Update>

<div id="1127-2026-08-20" />

<Update label="August 20, 2026" description="CLI 1.1.27">
  ### Auto Mode Upgrade and Spell Checking

  - Added an optional `spellcheck` setting that underlines misspelled English words as you type in the composer
  - Improved the Auto mode classifier with a two-stage classification strategy, increasing classification speed and accuracy
  - Improved the `/mcp` and `/skills` layout: entries are shown one per row, with descriptions displayed at the bottom, so more entries fit on screen
  - Fixed the Auto mode classifier silently rejecting all subsequent authorizations after a certain number of consecutive rejections of dangerous actions
  - Fixed the skills list being injected twice after resuming from a compaction
  - Fixed uninstalled plugins being reinstalled by automatic plugin updates
  - Fixed the failure message for an invalid PAT so it names the environment variable it came from and the priority that applied
  - Fixed MCP tool result metadata and tool status display being lost
</Update>

<div id="1126-2026-08-19" />

<Update label="August 19, 2026" description="CLI 1.1.26">
  ### Goal Command, Tab Completion, and Worktree Improvements

  - Added support for setting goals directly with `/goal <objective>`
  - Improved slash-command Tab completion
  - Improved session saving, restoration, and lifecycle management
</Update>

<div id="1125-2026-08-18" />

<Update label="August 18, 2026" description="CLI 1.1.25">
  ### Session Mentions, Settings Redesign, and Login Fixes

  - Added @-mention of other live sessions in the composer, so you can reference a peer session alongside files and agents
  - Improved the /settings layout: settings are shown one per row, with descriptions displayed at the bottom, so more settings fit on screen
  - Changed /goal to no longer bind to Auto mode
  - Fixed a stream truncated during the model's thinking phase not being retried, which interrupted the task
  - Fixed login being blocked for a long time by a credential lock held by another process, and leftover locks are now recovered automatically with a retryable prompt
</Update>

<div id="1124-2026-08-17" />

<Update label="August 17, 2026" description="CLI 1.1.24">
  ### Tool Call and Session Resume Fixes

  - Fixed compatibility issues with streaming tool call events on some models, improving the stability of parallel tool calls
  - Fixed session resume taking too long in some worktree scenarios
</Update>

<div id="1123-2026-08-15" />

<Update label="August 15, 2026" description="CLI 1.1.23">
  ### Tool-Call Compatibility and Display Improvements

  - Improved compatibility with some model service APIs, fixing some tool calls being skipped when tool\_call\_id values were reused
  - Improved handling of host names containing non-ASCII characters, such as Chinese host names, with more accurate error messages
  - Improved the TaskStop tool call card display, making the task stop status easier to read
</Update>

<div id="1122-2026-08-14" />

<Update label="August 14, 2026" description="CLI 1.1.22">
  ### Command Guardrails and Tool-Call Reliability

  - Added parsing of wrapper commands such as xargs and watch in the Bash tool, so the real command is correctly identified and intercepted
  - Fixed pkill -f possibly killing the CLI's own process in interactive sessions on Linux
  - Fixed tool calls that take no arguments failing to execute in certain interruption scenarios under interleaved thinking, such as some MCP tools
  - Fixed reasoning steps arriving out of order and losing their mapping in streaming output with interleaved thinking and parallel tool calls
  - Fixed /goal set failing when the objective description contains command-line options
  - Fixed scheduled upgrades still running after auto update was turned off
</Update>

<div id="1121-2026-08-13" />

<Update label="August 13, 2026" description="CLI 1.1.21">
  ### Plan Confirmations, Cross-Session Messages, and Long-Task Reliability

  - Restored the confirmation dialog when entering and exiting Plan mode under auto and yolo modes
  - Cross-session messages now show the sender and the message body inline
  - Fixed shell task output files growing without limit, which could exhaust disk space
  - Improved request timeout handling to resolve long-running tasks being interrupted incorrectly
  - Improved diagnostics for abnormal responses, so real upstream errors are no longer hidden
  - Improved the stability of multi-agent collaboration
</Update>

<div id="1120-2026-08-12" />

<Update label="August 12, 2026" description="CLI 1.1.20">
  ### Prompt Draft Stashing and Session Reliability Fixes

  - Added Ctrl+S to stash the current prompt draft and restore it later
  - Fixed teammate agents losing memory after being woken up
  - Fixed EPERM errors when running /branch
  - Fixed subagent tasks failing early when their state directory was not readable or writable
  - Fixed prompt rendering glitches right after a session resume finished
</Update>

<div id="1119-2026-08-11" />

<Update label="August 11, 2026" description="CLI 1.1.19">
  ### Cross-Session Messaging and Scheduled Task Budgets

  - Added cross-session messaging, so sessions can discover each other and send messages
  - Added task budgets for scheduled tasks: set turn and credit limits with parameters, or change them in the panel
  - Changed the default theme to auto, which picks the theme from your terminal background and keeps following it as the background changes at runtime
  - Improved startup speed
  - Fixed marketplace plugin installation failing
  - Fixed input starting with an absolute path being misread as a command
  - Fixed errors when switching to a non-vision model with image context
  - Fixed automatic compaction using the wrong context window size
</Update>

<div id="1118-2026-08-10" />

<Update label="August 10, 2026" description="CLI 1.1.18">
  ### Cleaner Status Hints and Stability Fixes

  - Improved memory saving notices to be less intrusive
  - Added ESC to revert an accepted next-step suggestion
  - Fixed the TUI possibly freezing when dragging in images that are slow to read or inaccessible
  - Fixed some historical sessions failing to resume
  - Fixed task failures caused by request interruptions during the model's thinking phase
  - Fixed the AbortError crash caused by canceling a request
</Update>

<div id="1117-2026-08-07" />

<Update label="August 7, 2026" description="CLI 1.1.17">
  ### Status Line Enhancements

  - Improved status line performance, with the option to display credits information
  - Improved the startup guidance shown for the remote control daemon
  - Fixed the subagent display in the TUI task panel
  - Fixed /resume possibly hanging for up to 30 seconds
</Update>

<div id="1116-2026-08-06" />

<Update label="August 6, 2026" description="CLI 1.1.16">
  ### Auto Memory and Stability Improvements

  - Added the auto memory switch, which can be enabled in the /settings panel or in settings.json. Once enabled, it automatically saves information worth reusing from conversations for later sessions
  - Removed the length limit on custom system prompts passed with --system-prompt
  - Improved the model queueing experience
  - Improved login reliability
</Update>

<div id="1115-2026-08-05" />

<Update label="August 5, 2026" description="CLI 1.1.15">
  ### Agent Teams and Long-Session Reliability

  - Added Agent Teams for multi-agent collaboration
  - Improved task reminders in long sessions
  - Fixed automatic context compaction not being triggered
  - Fixed the Remote URL display issue
  - Improved the Thinking status and Hook display interaction
</Update>

<div id="1114-2026-08-04" />

<Update label="August 4, 2026" description="CLI 1.1.14">
  ### Model Preferences and Progress Display

  - Added per-model memory for reasoning effort and context window settings, which are restored automatically when you switch models
  - Added remote ZIP plugin installation, and fixed the plugin status not updating after uninstall
  - Added the security scan subcommand, which runs security scan tasks in Headless mode
  - Improved the next-step suggestion feature, offering suggestions that better match the current conversation
  - Improved session status hints, distinguishing between the Thinking and Generating reply phases
  - Improved image paste responsiveness on Windows and macOS
  - Fixed resuming a session whose worktree had already been deleted
  - Fixed unreadable error messages when context compaction failed
</Update>

<div id="1113-2026-08-03" />

<Update label="August 3, 2026" description="CLI 1.1.13">
  ### Session Browsing and Scheduled Tasks

  - Improved the /resume session browser: aligned shortcuts and clearer session metadata
  - Improved the /crontab task panel: added a table header and clearer schedule interval descriptions
  - Improved worktree stability
  - Improved plugin loading logic
  - Fixed duplicated image content when dragging multiple images at once
  - Fixed session-level approval of plan mode not persisting
</Update>

<div id="1112-2026-08-02" />

<Update label="August 3, 2026" description="CLI 1.1.12">
  ### Display Improvements and Stability

  - Improved the display pages
  - Bug fixes and stability improvements
</Update>

<div id="1111-2026-08-01" />

<Update label="August 1, 2026" description="CLI 1.1.11">
  ### Service Account Auth and Session-Scoped Tasks

  - Fixed persistent scheduled tasks being activated by unrelated sessions, and their owning session can now be managed in /crontab
  - Goal creation is no longer globally unique: each session can have its own goal, and /goal take has been removed
  - Entering and exiting plan mode no longer triggers a permission popup in Yolo and Auto modes
  - The .agents/skills compatibility source is now enabled by default
  - Removed the "Memorying..." progress indicator from the UI
  - Improved the message shown when a streaming connection is interrupted
  - Fixed remote artifacts failing to download on Bun binaries
  - Added support for remote-controlled artifact display and download
</Update>

<div id="1110-2026-07-31" />

<Update label="July 31, 2026" description="CLI 1.1.10">
  ### Session Credits and OAuth Notice

  - Added server-reported session credits usage display
  - Added a manual authorization reminder before MCP servers start
  - Improved keyboard shortcuts for external editor operations
  - Improved Bash tool execution efficiency
  - Fixed /clear and /new not resetting the persistent Bash working directory back to the startup root
  - Added turn progress display in goal mode to improve the interaction experience
</Update>

<div id="119-2026-07-30" />

<Update label="July 30, 2026" description="CLI 1.1.9">
  ### Rename, Skill Scanning, and Startup Improvements

  - Added support for running /rename while a task is in progress
  - Skill directories are now scanned recursively, with a visible warning when a declared directory contains no skills
  - Improved startup speed by prewarming the shell snapshot and avoiding repeated loading of slow shell configs
  - /logout now clears the login state immediately
  - Fixed the external editor (Ctrl+X) failing to open in some integrated terminals such as Cursor
  - Fixed input conflicts while a GUI external editor was open — the terminal is no longer handed over
  - Improved the Ctrl+O detailed view toggle logic
  - Improved /compact command error messages
</Update>

<div id="118-2026-07-29" />

<Update label="July 29, 2026" description="CLI 1.1.8">
  ### Loop Scheduling Upgrade and Workflow Improvements

  - Upgraded /loop: the agent can now decide wakeup intervals on its own, with support for task persistence
  - Added the /crontab command dashboard for viewing and managing scheduled tasks
  - Added inline ghost-text completion for skill and slash commands in the input box
  - The TaskStop tool now supports stopping running workflows
  - Improved the Workflow TUI panel display logic
  - Fixed false stall warnings while workflow agents were streaming
  - The default permission mode in /settings can now be selected via options
  - Fixed known issues with slash command parsing and completion
  - Fixed the terminal title being lost on Windows
  - Fixed skill directories failing to load when a root-level SKILL.md was present
</Update>

<div id="117-2026-07-28" />

<Update label="July 28, 2026" description="CLI 1.1.7">
  ### Prompt Suggestion Toggle and Stability Fixes

  - Added a settings toggle to enable or disable prompt suggestions
  - Added the .agents/skills compatibility toggle to /settings
  - Fixed slash commands being reported as unknown before the command catalog finished loading, and reduced redundant catalog rebuilds
  - Showed the full Bash command in the expanded shell output view
  - Improved Markdown table row boundary rendering
  - Fixed UI freezes when resuming long sessions
  - Fixed Monitor notifications not being delivered in time
  - Fixed Grep/Glob tool cross-platform compatibility issues
</Update>

<div id="116-2026-07-27" />

<Update label="July 27, 2026" description="CLI 1.1.6">
  ### Subtask Command, Feedback Enhancements, and Configurable Directories

  - Added the /subtask command for dispatching background subtasks from the current session: the subagent inherits the session context, runs asynchronously, and reports back its result.
  - Added /feedback argument support to prefill feedback content
  - Added settings configuration to control skill loading from the .agents directory
  - Adjusted the default maximum turns of local subagents to 150
  - Fixed mobile conversation display issues
  - Fixed long MCP user config paths not being fully displayed
</Update>

<div id="115-2026-07-24" />

<Update label="July 24, 2026" description="CLI 1.1.5">
  ### MCP Enhancements, Task Management, and Reliability Fixes

  - Improved plugin validation and update logic
  - Improved Ctrl+B shortcut compatibility
  - Added persistent task management
  - Improved WebFetch timeout error surfacing
  - Adjusted model display name in headless mode
  - Improved command-hook process tree teardown
</Update>

<div id="114-2026-07-23" />

<Update label="July 23, 2026" description="CLI 1.1.4">
  ### Background Tasks, Terminal Titles, and Input Enhancements

  - Improved background task control with monitoring, stopping, and clearer status feedback
  - Added the useProxyFromEnvironment setting to toggle reading proxy configuration from environment variables via /settings
  - Improved terminal session window title updates
  - Added Ctrl+K / Ctrl+U / Ctrl+W line-editing shortcuts in dialog and settings text inputs
  - Improved the /resume session picker
  - Surfaced argument parsing errors on stderr and aligned unknown-option output
  - Fixed the subagent thinking depth setting
  - Fixed image reading failures on Linux
</Update>

<div id="113-2026-07-22" />

<Update label="July 22, 2026" description="CLI 1.1.3">
  ### Compression, MCP, and TUI Improvements

  - Added compression progress display in the TUI to improve the interaction experience
  - Added configuration for shell command model responses, disabled by default
  - Added timeout control for MCP tools
  - Improved permission behavior for referenced files
  - Fixed MCP list names being collapsed
  - Fixed the viewport not restoring after the suggestion list closes
</Update>

<div id="112-2026-07-21" />

<Update label="July 21, 2026" description="CLI 1.1.2">
  ### Workflow Refinements

  - Improved workflow pause and resume logic
  - Improved Deep Research delivery and queued task dispatch
  - Improved startup header and update notification display
  - Improved prompts on model refusal
</Update>

<div id="111-2026-07-20" />

<Update label="July 20, 2026" description="CLI 1.1.1">
  ### Improvements

  - Improved error message display
  - Enhanced code security scanning reliability
</Update>

<div id="110-2026-07-20" />

<Update label="July 20, 2026" description="CLI 1.1.0">
  ### Security Scan & Model Management

  - Officially released native code security capabilities
  - Support refreshing the model list on demand via Ctrl + R
</Update>

<div id="1048-2026-07-17" />

<Update label="July 17, 2026" description="CLI 1.0.48">
  ### Shell & TUI Experience, and Fixes

  - Optimized !bash mode execution and output behavior
  - Improved the built-in Deep Research workflow
  - Optimized underlying network requests to improve reliability and stability
</Update>

<div id="1047-2026-07-16" />

<Update label="July 16, 2026" description="CLI 1.0.47">
  ### Command Execution, Shell Experience, Exit Cleanup, and Hook Fixes

  - Optimized UI rendering during command execution
  - Optimized the auto-allow detection logic for read-only shell commands
  - Cleaned up unfinished background tasks when the CLI exits
  - Fixed an issue where the PreToolUse hook did not take effect in headless and SDK modes
</Update>

<div id="1046-2026-07-15" />

<Update label="July 15, 2026" description="CLI 1.0.46">
  ### Input Experience and Stability Improvements

  - Optimized CLI terminal rendering logic
  - Ensured subagents honor the disallowed tools configuration
  - Optimized memory usage
</Update>

<div id="1045-2026-07-14" />

<Update label="July 14, 2026" description="CLI 1.0.45">
  ### Interaction Experience and Startup Stability Improvements

  - Improved TUI rendering stability
  - Improved the interaction experience for subagent, feedback, remote control, and other features
  - Fixed some known startup blocking issues
</Update>

<div id="1044-2026-07-13" />

<Update label="July 13, 2026" description="CLI 1.0.44">
  ### BYOK Configuration and Rendering Improvements

  - BYOK models support context window and reasoning depth adjustment
  - Added a toggle to manage plan mode in the /settings dialog
  - Improved streaming performance by caching stable Markdown blocks
  - Resolved abnormal color display in the TUI between rendered frames
  - Reduced the impact of the status bar marquee on the user experience
  - Improved the stability of worktree
</Update>

<div id="1043-2026-07-10" />

<Update label="July 10, 2026" description="CLI 1.0.43">
  ### Thinking Stability Enhancements

  - Enhanced the stability of the model's thinking process
</Update>

<div id="1042-2026-07-10" />

<Update label="July 10, 2026" description="CLI 1.0.42">
  ### Startup Performance and Worktree Improvements

  - Optimized the startup critical path for faster launch
  - Improved the worktree experience
</Update>

<div id="1041-2026-07-09" />

<Update label="July 9, 2026" description="CLI 1.0.41">
  ### Workflows, Skills, and Permission Refinements

  - Improved workflow orchestration
  - Added support for installing remote skill packages via HTTPS
  - Improved the Bash tool's redirection command detection scope
  - Improved error messages
  - Improved the tool-calling experience
</Update>

<div id="1040-2026-07-08" />

<Update label="July 8, 2026" description="CLI 1.0.40">
  ### Custom Model and Model Selector Enhancements

  - Added support for custom model names for BYOK models
  - Improved product interaction and onboarding experience
</Update>

<div id="1039-2026-07-07" />

<Update label="July 7, 2026" description="CLI 1.0.39">
  ### Feedback Image Attachments and Experience Improvements

  - Added image attachment support in the /feedback dialog
  - Optimized Plan mode exit options
  - Streamlined worktree tool permission checks
  - Added toggle for code usage statistics in /settings
</Update>

<div id="1038-2026-07-06" />

<Update label="July 6, 2026" description="CLI 1.0.38">
  ### Status Line and Model Hint Improvements

  - Improved UI notifications, including status line prompts and model list hints
</Update>

<div id="1037-2026-07-03" />

<Update label="July 3, 2026" description="CLI 1.0.37">
  ### Input and Display Improvements

  - Support deleting pasted images as a whole on macOS
  - Reduced status bar promo impact on scroll control
  - Fixed context usage display issue when resuming a compacted session
  - Optimized default effort label display in the model list
</Update>

<div id="1036-2026-07-02" />

<Update label="July 2, 2026" description="CLI 1.0.36">
  ### Stability and UX Improvements

  - Fixed a TUI rendering performance issue caused by long single-line tool output
  - Improved plugin marketplace management
  - Improved TUI display and some error messages
</Update>

<div id="1035-2026-07-01" />

<Update label="July 1, 2026" description="CLI 1.0.35">
  ### Marketplace & Permissions Improvements

  - Added plugin marketplace support
  - Upgraded QoderCLI rules types with support for model-driven auto-inclusion and manual inclusion; see [https://docs.qoder.com/zh/cli/memory#%E8%A7%84%E5%88%99%EF%BC%88rules%EF%BC%89](https://docs.qoder.com/zh/cli/memory#%E8%A7%84%E5%88%99%EF%BC%88rules%EF%BC%89)
  - Fixed Plan and Ask tools not being correctly disabled in headless mode
  - Fixed AskUser being silently denied in auto mode
  - Fixed Vim mode ESC not switching from INSERT to NORMAL during streaming
  - Fixed security slash commands not responding in idle state
</Update>

<div id="1034-2026-06-30" />

<Update label="June 30, 2026" description="CLI 1.0.34">
  ### Enhanced Default Permission Mode Configuration and Optimized User Experience

  - defaultPermissionMode now supports yolo and dontask
  - Fixed duplicate rendering of mid-turn interjection records in TUI
  - Improved Background Agent display
</Update>

<div id="1033-2026-06-29" />

<Update label="June 29, 2026" description="CLI 1.0.33">
  ### Plan Mode & Model Improvements

  - Added --config-dir flag to override the configuration directory
  - Fixed Plan mode not supporting Shell read-only commands
  - Improved model connection stability
</Update>

<div id="1032-2026-06-27" />

<Update label="June 27, 2026" description="CLI 1.0.32">
  ### Stability & UI Improvements

  - Improved API error messages
  - Optimized tool call exception handling
  - Improved UI display and experience
</Update>

<div id="1031-2026-06-26" />

<Update label="June 26, 2026" description="CLI 1.0.31">
  ### Dynamic Workflow and Memory Enhancements

  - Added dynamic workflow support
  - Added support for .qoder/rules/\*\*.md; see the Memory module in CLI docs for details: [https://docs.qoder.com/zh/cli/memory](https://docs.qoder.com/zh/cli/memory)
  - Added user-level Memory and improved Memory experience in Plan mode
  - Improved Headless mode startup speed
</Update>

<div id="1030-2026-06-25" />

<Update label="June 25, 2026" description="CLI 1.0.30">
  ### Network Proxy Optimization

  - Optimized network proxy mechanism; currently supports HTTP\_PROXY, HTTPS\_PROXY, and SOCKS5 proxies
</Update>

<div id="1029-2026-06-25" />

<Update label="June 25, 2026" description="CLI 1.0.29">
  ### Startup Performance and Model Reliability

  - Added configurable first-packet and stream-idle timeouts for model SSE responses
  - Improved the model context window fallback strategy
  - Aligned SessionEnd hook timeout and PreToolUse fail-closed behavior with strict semantics
  - Tightened hook validation: hookEventName is now required in hookSpecificOutput
  - Improved SDK performance for fetching the model list
</Update>

<div id="1028-2026-06-24" />

<Update label="June 24, 2026" description="CLI 1.0.28">
  ### Model List Cache Optimization

  - Optimized the model list cache mechanism
</Update>

<div id="1027-2026-06-24" />

<Update label="June 24, 2026" description="CLI 1.0.27">
  ### Permission and Command Stability Improvements

  - Fixed command truncation in permission dialogs
  - Fixed git-related environment variables being cleared during command execution
  - Enhanced /resume command to respect the current permission mode
</Update>

<div id="1026-2026-06-23" />

<Update label="June 23, 2026" description="CLI 1.0.26">
  ### Welcome Page Refinements and Reliability Fixes

  - Refined welcome panel with promotional surfaces and model promo hints
  - Fixed Read tool failures caused by redundant parameter parsing
  - Rebuilt Windows Git Bash download and install flow for greater reliability
</Update>

<div id="1025-2026-06-22" />

<Update label="June 22, 2026" description="CLI 1.0.25">
  ### Workflow Orchestration

  - Improved background task notification experience
  - Fixed voice input ending behavior
</Update>

<div id="1024-2026-06-18" />

<Update label="June 18, 2026" description="CLI 1.0.24">
  ### Model Panel UX and Resume Fixes

  - Improved model selection panel
  - Fixed interjection records not showing on resume
</Update>

<div id="1023-2026-06-17" />

<Update label="June 17, 2026" description="CLI 1.0.23">
  ### Mid-conversation Messaging and Permissions UX

  - Added mid-conversation interjection — messages are sent immediately during agent responses
  - Enriched authorization details shown in the /permissions command panel
  - Improved /resume loading performance for very large sessions
  - Fixed permission prompts being incorrectly auto-approved after mode switches
</Update>

<div id="1022-2026-06-16" />

<Update label="June 16, 2026" description="CLI 1.0.22">
  ### Subagent, Permissions, and UI Improvements

  - Improved Hook message display style in conversation flows
  - Improved interaction experience for model parameter configuration
  - Refined tool permission prompt logic for selected paths
  - Preserved input box content when ending a conversation with Esc
  - Removed the permission request timeout limit for ACP
</Update>

<div id="1021-2026-06-15" />

<Update label="June 15, 2026" description="CLI 1.0.21">
  ### Skill Commands and Model Enhancements

  - Added /run, /verify, and /run-skill-generator bundled skill commands
  - Added /effort command
  - Aligned subagent frontmatter configuration with the existing permission system
  - Fixed broken image recognition tool in Node SEA build
</Update>

<div id="1020-2026-06-13" />

<Update label="June 13, 2026" description="CLI 1.0.20">
  ### Context Warning Threshold Fix

  - Fixed context warning thresholds becoming inconsistent
</Update>

<div id="1019-2026-06-12" />

<Update label="June 12, 2026" description="CLI 1.0.19">
  ### Queue Progress and Bug Fixes

  - Added model queue progress bar with elapsed and max wait time for queued requests
  - Improved auto-compact experience
  - Fixed /context and status bar ratio becoming inconsistent during long sessions
  - Improved Subagent display style
  - Fixed MCP tool call error message display
  - Improved detection of input length range errors
</Update>

<div id="1018-2026-06-11" />

<Update label="June 11, 2026" description="CLI 1.0.18">
  ### TLS Trust, TUI & Stability Improvements

  - Added OS certificate store trust for custom CA certificates
  - Improved subagent display with event-driven transcript rendering
  - Improved TUI support for IDE integration sendString input
  - Improved screen TUI compatibility
  - Improved /plan implementation
  - Improved TUI rendering performance for large session resume
  - Fixed Bash stdin redirect behavior
  - Added clearer HTTPS proxy TLS handshake error messages
</Update>

<div id="1017-2026-06-10" />

<Update label="June 10, 2026" description="CLI 1.0.17">
  ### Agent Sessions, Permissions Upgrade & SOCKS5 Proxy

  - Enabled agent sessions by default
  - Upgraded /permissions: directory completion, workspace dialog, scope-colored trust tags, and remove confirmation
  - Added SOCKS5 proxy support
  - Added CJK input support and prevented cursor reset in the AskUser dialog
  - Redesigned the background task details panel with a structured layout and fixed empty output
  - Allowed plugin hooks to bypass the --setting-sources filter
  - Enhanced asyncRewake hooks with custom messages, non-interactive downgrade, and prefix matching
  - Hidden symlink target paths in /memory output
  - Preserved /goal ownership across resume; reset goal and permission mode on /clear and /new
  - Preserved resumed conversation history when switching model or reasoning effort
  - Fixed MCP `${VAR}` environment variable expansion and OAuth discovery resource mismatch
</Update>

<div id="1016-2026-06-09" />

<Update label="June 10, 2026" description="CLI 1.0.16">
  ### Stability Improvements

  - Fixed npm version dependency issues
</Update>

<div id="1015-2026-06-09" />

<Update label="June 9, 2026" description="CLI 1.0.15">
  ### Plugin Path Placeholders and Fixes

  - Added plugin path placeholder substitution (`${*_PLUGIN_ROOT}`, `${*_PLUGIN_DATA}`) in plugin content
  - Fixed permission mode switch warnings repeating
  - Fixed project permission rules not taking effect immediately after granting workspace trust
  - Fixed Windows control character parsing issues
  - Improved startup speed
</Update>

<div id="1014-2026-06-04" />

<Update label="June 4, 2026" description="CLI 1.0.14">
  ### Plan Mode Independence & Stability Improvements

  - Plan mode is now independent from the permission cycle — use /plan to toggle in and out, Shift+Tab cycles only permission modes
  - ExitPlanMode now offers a "start goal execution" option for seamless goal transitions
  - Fixed session freeze when a hook subprocess hangs on timeout or abort
  - Fixed goal and plan state not restoring correctly after process restart
  - Fixed module loading issues in npm published artifacts
  - Improved permission mode switch warnings and ExitPlanMode options
</Update>

<div id="1013-2026-06-03" />

<Update label="June 3, 2026" description="CLI 1.0.13">
  ### Model List, Promotions & Plugin Improvements

  - Added --model-list flag for headless model enumeration
  - Added model service queue polling with automatic recovery when the service is temporarily unavailable
  - Fixed Agent(name) deny rules not taking effect from permissions configuration
  - Fixed an occasional failure when resuming sessions
</Update>

<div id="1012-2026-06-02" />

<Update label="June 2, 2026" description="CLI 1.0.12">
  ### Startup Performance & YOLO Mode Improvements

  - YOLO mode now allows EnterPlanMode/ExitPlanMode without popups and lets AskUserQuestion pass through
  - Added support for user-configurable auto-mode classifier rules from settings
  - Fixed voice reconnect issues caused by stale WebSocket close events and re-activation loops, improving stability
  - Improved the Windows browser login experience
  - Fixed cross-window goal pollution by isolating goals per session
  - Improved TUI display stability during prompt input completion
  - Reduced performance impact during auto-update
</Update>

<div id="1011-2026-06-01" />

<Update label="June 1, 2026" description="CLI 1.0.11">
  ### TodoWrite & UI Improvements

  - Optimized TodoWrite validation recovery mechanism and error messages
  - Unified info message color scheme, fixed inline code color display
  - Changed cancel prompt messages to gray for improved visual hierarchy
  - Fixed various other issues
</Update>

<div id="1010-2026-05-30" />

<Update label="May 30, 2026" description="CLI 1.0.10">
  ### Voice Polish and Stability Improvements

  - Added voice transcription polish for improved input accuracy
  - Improved BYOK provider UX: disabled providers show clear explanations and better model identifiers
  - Improved Review page submission confirmation interaction
  - Improved YOLO mode permission denial messages
  - Fixed various other issues
</Update>

<div id="109-2026-05-29" />

<Update label="May 29, 2026" description="CLI 1.0.9">
  ### YOLO Mode Revamp and Permission Improvements

  - YOLO mode now fully auto-approves all tools without popups
  - Made --tools flag variadic
  - Improved feed stream visual hierarchy and clarity
  - Fixed Windows console popups appearing during subprocess execution (windowsHide)
  - Fixed pasted content in prompt input being incorrectly parsed as @ references
  - Improved skill and hook loading and display
</Update>

<div id="108-2026-05-28" />

<Update label="May 28, 2026" description="CLI 1.0.8">
  ### Loop & Hooks GA

  - Made /loop command and cron scheduling tools generally available for all users
  - Made /hooks command generally available for all users
  - Added support for startup parameter configuration via environment variables
  - Custom agent names are no longer restricted to slug format
  - Removed @agents autocomplete list count cap
  - Improved chat feed status indicators, message spacing, and visual presentation
  - Fixed various other issues
</Update>

<div id="107-2026-05-27" />

<Update label="May 27, 2026" description="CLI 1.0.7">
  ### Performance and Stability Improvements

  - Improved startup performance through deferred initialization and resource caching
  - Feedback diagnostic package now includes TUI text snapshot for better context
  - Multiple bug fixes and interaction improvements
</Update>

<div id="106-2026-05-26" />

<Update label="May 26, 2026" description="CLI 1.0.6">
  ### Image Search, Voice Streaming, and Plugin Enhancements

  - Added built-in ImageSearch tool for searching images directly within the agent
  - Added voice transcription streaming, with text flowing directly into the input buffer as you speak
  - Improved plugin browser UX for pending-removal items and empty marketplaces
  - Fixed various other minor issues
</Update>

<div id="105-2026-05-25" />

<Update label="May 25, 2026" description="CLI 1.0.5">
  ### Reliability and UX Polish

  - Added credit exhausted warning in the toast area
  - Improved network fetch and model transport reliability
  - Fixed voice STT terminating recording on disconnect
  - Fixed schema parsing failure for built-in tool params on Qwen-style models
  - Fixed various other minor issues
</Update>

<div id="104-2026-05-25" />

<Update label="May 25, 2026" description="CLI 1.0.4">
  ### Stability Improvements

  - Fixed npm package runtime errors caused by incorrect tagged template encoding
</Update>

<div id="103-2026-05-23" />

<Update label="May 23, 2026" description="CLI 1.0.3">
  ### Voice, Remote & UI Fixes

  - Fixed voice transcript flickering during recording and changed transcription to insert at the cursor position
  - Improved Agent task execution effectiveness
</Update>

<div id="102-2026-05-22" />

<Update label="May 22, 2026" description="CLI 1.0.2">
  ### Goal, Voice & Reliability Fixes

  - Fixed voice input reliability issues (recording detection, finalize timeout, multi-utterance handling)
  - Improved reliability of the model invocation service
  - Fixed working directory not syncing correctly in worktree sessions
  - Fixed auto-permission mode incorrectly prompting for project settings file access
</Update>

<div id="101-2026-05-21" />

<Update label="May 21, 2026" description="CLI 1.0.1">
  ### Voice & Stability Fixes

  - Added ElicitationResponse hook notification type
  - Fixed voice mode stability issues
  - Fixed session title generation failing when lite model is unavailable — now falls back to chat model
  - Fixed BYOK model catalog race condition during startup
</Update>

<div id="100-2026-05-19" />

<Update label="May 20, 2026" description="CLI 1.0.0">
  ### Qoder CLI 1.0 is Now Available

  **New Features**

  - **Cloud Execution:** New `qodercli --remote` flag. Cloud mode lets you submit tasks once to a cloud container — shutdown and disconnection no longer interrupt execution, with support for multi-hour long-running workflows.
  - **RepoWiki:** New `qodercli wiki` subcommand. Generates RepoWiki documentation locally with code never leaving your environment.
  - **Voice:** New `/voice` command. Voice input fully upgraded and free to use.
  - **Goal:** New `/goal` command. Keeps long-horizon, goal-oriented tasks on track without drift.
  - **Open Model Parameters:** Configurable effort tiers and 1M context window support.

  **Enterprise Integration**

  - **Agent SDK:** TypeScript and Python installation support — integrate full Agent capabilities in a few lines of code. Programmatic-level control including tool authorization callbacks, pre-execution interception, and parameter modification.
  - **Cloud Agents:** Agents-as-a-Service. Sandbox isolation, state management, async orchestration, credential management, and long-running execution all built into the platform.

  **Core Capability Upgrades**

  - **Orchestration:** Tasks automatically split across multiple Agents running in parallel; Main Agent decides the split strategy; each sub-Agent runs its own event loop.
  - **Extensibility:** Five orthogonal extension points — Skills / Hooks / MCP / Subagent / Command.
  - **Autonomy:** Agents assess risk themselves and only ask for confirmation at critical moments; automatic routing across LLM / SLM / VLM.
  - **Integration:** Three integration modes — Headless (unattended CI/CD), ACP (standard bidirectional protocol), and SDK (TS / Python).
</Update>

<div id="0216-2026-05-18" />

<Update label="May 18, 2026" description="CLI 0.2.16">
  ### MCP Elicitation and Stability Fixes

  - Added MCP elicitation bridge support — MCP servers can now prompt users for input during remote requests
  - Fixed TUI rendering crashes on resize and text wrapping
  - Fixed hook execution and other stability issues
</Update>

<div id="0215-2026-05-18" />

<Update label="May 18, 2026" description="CLI 0.2.15">
  ### Auto Mode Improvements

  - Added auto mode option in plan approval — choose auto mode directly when approving a plan
  - Auto mode now auto-allows reading files outside workspace and blocks writing outside workspace without prompting
  - Fixed auto mode not being respected during plan mode for subagent tool calls
  - Fixed /permissions dialog not clearing denial state on close
</Update>

<div id="0214-2026-05-14" />

<Update label="May 14, 2026" description="CLI 0.2.14">
  ### Auto Permission Mode, Insights, and Windows Stability

  - Added auto permission mode — LLM classifier automatically approves safe tool calls, reducing permission prompts
  - Session resume now supports worktree state persistence and cross-worktree discovery
  - External commands now receive workspace path, auth context, and registry environment variables
  - Fixed Windows ConPTY freeze in text input dialogs (AskUserQuestion, BYOK wizard)
  - Fixed Shift+Tab not working on Windows VT mode terminals (falls back to Meta+M)
  - Fixed Ctrl+V paste not working in BYOK wizard on Windows conhost
  - Fixed left/right arrow keys not working in AskUserQuestion text input
  - Fixed ESC not cancelling /insights during execution
  - Fixed MCP tools with special characters in parameter names failing (key name sanitization and remapping)
  - Fixed MCP images being dropped during output truncation
  - Fixed custom model key (BYOK) not being sent in API requests
  - Fixed empty user messages caused by startup memory injection ordering
  - Fixed QR code rendering on legacy Windows console (compact ASCII fallback)
  - Fixed --setting-sources not accepting empty string to disable all sources
  - Fixed WSL 1 compatibility by bumping Bun to 1.3.14
</Update>

<div id="0213-2026-05-13" />

<Update label="May 13, 2026" description="CLI 0.2.13">
  ### Side Questions, Read-Only Auto-Allow, and Platform Fixes

  - Added /btw side question — ask quick questions without interrupting the main conversation
  - Read-only shell commands now auto-allowed — reduces redundant permission prompts for safe tools
  - Worktree isolation enabled by default
  - Fixed context window progress bar not updating after /compact command
  - Fixed /compact command not clearing the input prompt
  - Fixed color artifacts on macOS Terminal.app during cursor-forward movement
  - Fixed garbled QR code rendering on Windows due to half-block characters
  - Fixed batched text input on Windows causing garbled or missing characters
  - Fixed fish and other unsupported shells being used as Bash tool backend
  - Fixed -w flag not behaving the same as --workspace
  - Fixed TUI hook deletion accidentally removing all same-command hooks
</Update>

<div id="0212-2026-05-12" />

<Update label="May 12, 2026" description="CLI 0.2.12">
  ### Worktree Isolation and Context Bar Improvements

  - Added worktree isolation for agents — run sub-agents in isolated git worktrees with `-w` flag, interactive exit dialog, and automatic cleanup on exit
  - Added context token usage progress bar to default statusline for live context window visibility
  - Fixed context window progress bar zeroing, flashing, or displaying incorrect values during compression, sub-agent runs, and session resume
  - Fixed hook permission decisions not aligning with settings.json rules
  - Fixed empty model response with end\_turn incorrectly treated as an error instead of graceful completion
  - Fixed session title generation timing out on slow networks by increasing timeout to 180s
</Update>

<div id="0211-2026-05-11" />

<Update label="May 9, 2026" description="CLI 0.2.11">
  ### Network Reliability Improvements

  - Fixed network degradation chain to try original URL before falling back to resolved IPs
</Update>

<div id="0210-2026-05-11" />

<Update label="May 9, 2026" description="CLI 0.2.10">
  ### Connection Stability and UI Fixes

  - Added automatic retry on 504 Gateway Timeout
  - Improved permission dialog path display with unified 3-tier format
  - Improved MCP list to show "Needs authentication" for unauthorized servers
  - Fixed duplicate content on terminal resize in alt-screen mode
  - Fixed subagent ESC cancel not persisting state correctly
  - Fixed workspace boundary check false positive for dotdot-like directory prefixes
</Update>

<div id="029-2026-05-11" />

<Update label="May 8, 2026" description="CLI 0.2.9">
  ### Auto-Background, Status Command, and Stability Fixes

  - Added `status` subcommand for checking CLI connection and session state
  - Long-running Bash commands now auto-background with completion notification when they exceed the timeout
  - Improved `--model` option help text with clearer usage guidance
  - Fixed Vim mode ESC not cancelling running session or shell execution
  - Fixed UI stacking on Windows terminal resize
  - Fixed /add-dir trusted directories still requiring read permission approval
  - Fixed MCP OAuth re-authentication failing after token revocation (stale 401)
  - Fixed hook status indicator persisting in TUI after hook completion
  - Fixed compressed conversation incorrectly displayed after /resume
  - Fixed remote control subagents not handling session reconnection properly
  - Fixed symlink reads bypassing permission boundary checks
</Update>

<div id="028-2026-05-11" />

<Update label="May 7, 2026" description="CLI 0.2.8">
  ### HTTP Proxy and Shell Mode Fixes

  - Added HTTP Proxy support for users behind corporate proxies
  - Added Ctrl+C and ESC to cancel running bash mode commands
  - Sorted slash command suggestions alphabetically
  - Improved MCP server status display for unauthorized servers
  - Fixed UI freeze for repetitive output in bash mode
  - Fixed paste into shell mode not working
  - Fixed vim ESC not exiting INSERT mode
  - Fixed /resume loading excessive history beyond compression boundary
  - Fixed install script architecture detection on Apple Silicon under Rosetta
</Update>

<div id="027-2026-05-11" />

<Update label="May 6, 2026" description="CLI 0.2.7">
  ### Stability and Bug Fixes

  - Fixed process crash caused by network jitter (connection-level retry + runtime workaround)
  - Fixed Bash tool output file growing unboundedly
  - Fixed PermissionRequest hook firing twice
  - Fixed /hooks TUI navigation stuck due to duplicate keys
  - Fixed input box disappearing and message loss during TUI compression
</Update>

<div id="026-2026-05-11" />

<Update label="May 2, 2026" description="CLI 0.2.6">
  ### TUI Permission Dialog Improvements

  - Improved TUI permission dialog UX and rendering stability
  - Fixed sub-agent running status indicator display
</Update>

<div id="025-2026-05-11" />

<Update label="April 29, 2026" description="CLI 0.2.5">
  ### BYOK, Permissions & Remote Control

  - BYOK Custom URL: bring your own API key with custom endpoint support
  - Remote Control enabled by default
  - TUI improvements: cursor handling, auth manager, and UI refinements
  - Subagent shows dots spinner while running
  - Validate -m model argument at startup with exact case-sensitive match
  - Per-subcommand permission checking for compound Bash commands
  - Disabled auto-memory feature
  - Fixed hook process hangs with exit event and tree-kill
  - Fixed hook permission decisions discarded on partial failure
  - Windows: suppress where.exe stderr leak when rg not in PATH
  - Bug fixes and stability improvements
</Update>

<div id="024-2026-05-11" />

<Update label="April 28, 2026" description="CLI 0.2.4">
  ### Hotfix

  - Fixed download speed by switching to OSS accelerate endpoint
</Update>

<div id="023-2026-05-11" />

<Update label="April 28, 2026" description="CLI 0.2.3">
  ### Plugins & Stability

  - Plugin variable substitution: support PLUGIN\_ROOT/PLUGIN\_DATA in hooks and MCP configs
  - Improved /context panel accuracy and display
  - Hook output now includes getEffectiveContext() with systemMessage fallback
  - Fixed --agent system prompt not working in TUI/headless modes
  - Fixed model selector not showing all entries
  - Fixed /resume crash on malformed diffs
  - Fixed Plan mode requiring permission to read plan files
  - Fixed concurrent tool confirmations triggering listener overflow warning
  - Fixed active version being cleaned up after cross-channel update
  - Added Linux x64-baseline build target for CPUs without AVX
  - Bug fixes and stability improvements
</Update>

<div id="022-2026-05-11" />

<Update label="April 28, 2026" description="CLI 0.2.2">
  ### Command Stability

  - Fixed /tasks command unable to exit
  - Fixed various other issues and improved stability
</Update>

<div id="021-2026-05-11" />

<Update label="April 27, 2026" description="CLI 0.2.1">
  ### Hook & Platform Fixes

  - Fixed Hook execution failures
  - Fixed newline shortcut not working in macOS default terminal
  - Fixed Hook JSON output not being applied
  - Fixed login errors when using xdg-open
  - Fixed built-in Skills being lost during packaging
</Update>

<div id="020-2026-04-26" />

<Update label="April 27, 2026" description="CLI 0.2.0">
  ### Major Capability Upgrades: Multi-Model, Extensible, and User Experience

  This is the biggest update to Qoder CLI since launch. We've rebuilt the TUI, redesigned the permission model, opened up multi-model access, and turned the CLI from "an agent in your terminal" into an agent endpoint that can be orchestrated and integrated into your workflows. Whether you're coding in the terminal, running pipelines in CI/CD, or embedding agent capabilities into your own tools — this release has you covered.

  **New Features**

  - Brand-new TUI — rich keyboard input support and a fully customizable status line.
  - New permission model — Plan Mode plus multi-project management (/add-dir) for flexible context switching.
  - Multi-model support — integrated state-of-the-art models from across the globe, with BYOK so you're no longer locked to a single provider.
  - Comprehensive built-in commands — 50+ slash commands to handle your day-to-day work with ease.
  - Conversational config creation — describe what you want and the agent generates the MCP / Subagent / Skill / Hook config for you. No more hand-written JSON.
</Update>

<div id="0143-2026-04-16" />

<Update label="April 16, 2026" description="CLI 0.1.43">
  ### Startup Performance and Stability Improvements

  - Implemented permission request queuing and sequential display for concurrent subagents
  - Fixed startup blocking caused by slow network responses
  - Fixed CLI crash when `.qoder.json` config file is corrupted
  - Added image data output support in SDK mode
</Update>

<div id="0134-2026-03-23" />

<Update label="March 23, 2026" description="CLI 0.1.34">
  ### Remove Code Review Restrictions

  - Removed usage restrictions for /review and /setup-github on free subscription
  - Bug fixes and stability improvements
</Update>

<div id="0132-2026-03-18" />

<Update label="March 18, 2026" description="CLI 0.1.32">
  ### Thinking Rendering Support

  - Added thinking/reasoning process rendering in chat for supported models
  - Updated Windows hook execution to run via Git Bash
  - Optimized Windows Git Bash download and installation for faster setup
</Update>

<div id="0131-2026-03-13" />

<Update label="March 13, 2026" description="CLI 0.1.31">
  ### Custom Model Support

  - Support for custom models with providers like Alibaba Cloud Bailian Coding Plan
</Update>

<div id="0130-2026-03-10" />

<Update label="March 10, 2026" description="CLI 0.1.30">
  ### Skills and MCP Enhancements

  - Added Skills loading support from .agents directory
  - Added Skills support via symbolic links
  - Added automatic MCP Server type inference
  - Hidden /compact command results with Ctrl+R to expand and view
</Update>

<div id="0129-2026-02-20" />

<Update label="February 20, 2026" description="CLI 0.1.29">
  ### New Model Support

  - Add support for Alibaba's latest model (Qwen 3.5 Plus)
</Update>

<div id="0128-2026-02-14" />

<Update label="February 14, 2026" description="CLI 0.1.28">
  ### New Model Support

  - Add support for new MiniMax model
  - Fix WebFetch tool execution errors
</Update>

<div id="0127-2026-02-14" />

<Update label="February 14, 2026" description="CLI 0.1.27">
  ### New Model Support

  - Added support for new models
  - Improved Todo task generation rules
  - Enhanced viewing logic for MCP tool execution results
</Update>

<div id="0126-2026-02-02" />

<Update label="February 2, 2026" description="CLI 0.1.26">
  ### Improved Configuration Loading

  - Optimized the resource loading order for skills, commands, etc.
</Update>

<div id="0125-2026-02-01" />

<Update label="February 1, 2026" description="CLI 0.1.25">
  ### Enhanced Configuration Capabilities

  - Added creation of Subagent Skill
  - Added `mcp auth` sub-command to authenticate with an OAuth-enabled MCP Server
  - Added --mcp-config flag to load mcp servers from JSON string
</Update>

<div id="0124-2026-01-28" />

<Update label="January 28, 2026" description="CLI 0.1.24">
  ### Bug Fixes

  - Refactored Glob tool implementation
  - Fixed issue where invalid images would prevent conversations from continuing
  - Fixed intermittent request failures caused by tool execution returning no results
  - Fixed account switching conflicts when running multiple processes concurrently
  - Fixed unauthorized error when running /upgrade command on Teams plans
</Update>

<div id="0123-2026-01-23" />

<Update label="January 23, 2026" description="CLI 0.1.23">
  ### Bug Fixes and Improvements

  - Optimized token estimation logic for images in context
  - Fixed rg execution errors in Linux ARM64 environments
  - Fixed panic issues caused by MCP configuration errors
  - Fixed MCP query subcommand display issues
</Update>

<div id="0122-2026-01-21" />

<Update label="January 21, 2026" description="CLI 0.1.22">
  ### Bug Fixes and Improvements

  - Added --with-claude-config to load Claude Code Skills, Commands, and Subagents
  - Improved zsh shell priority on macOS
  - Fixed TUI crash issues
</Update>

<div id="0121-2026-01-20" />

<Update label="January 20, 2026" description="CLI 0.1.21">
  ### Bug Fixes and Improvements

  - Fixed file retrieval errors on macOS with ARM chips
  - Fixed Glob tool search not canceling properly
  - Fixed context overflow when switching models
  - Added persistent logging for Bash tool execution
  - Improved AskUserQuestion accuracy
  - Fixed -w parameter not recognizing relative paths
</Update>

<div id="0120-2026-01-15" />

<Update label="January 15, 2026" description="CLI 0.1.20">
  ### Skills Support

  - Added /skills command to view Skill configurations
  - Added --agents parameter for subagents configuration
  - Improved Markdown rendering in TUI
  - Fixed trailing newline being removed when editing files with Edit tool
  - Fixed Bash tool execution failures on some older Windows versions
  - Fixed streaming output issues for commands in TUI Bash Mode
  - Fixed inability to execute multi-line commands in TUI Bash Mode
  - Removed minimum window size restriction in TUI
  - Fixed /resume command failing to restore certain conversation sessions
</Update>

<div id="0119-2026-01-12" />

<Update label="January 12, 2026" description="CLI 0.1.19">
  ### Conversation Export Support

  - Added /export command to export conversation history
  - Added automatic git-bash setup for Windows
  - Added current working directory to status bar
  - Enhanced AskUserQuestion tool interaction in TUI
  - Improved context compression
  - Fixed several issues
</Update>

<div id="0118-2025-12-23" />

<Update label="December 23, 2025" description="CLI 0.1.18">
  ### Improvements and Bug Fixes

  - Added plan expiration date to /usage command
  - Improved Bash command parsing
  - Fixed conversation hang after canceling tasks on certain models
  - Fixed http/https prefix being stripped from tool parameters in TUI
  - Fixed Init command in Zed integration
</Update>

<div id="0117-2025-12-17" />

<Update label="December 17, 2025" description="CLI 0.1.17">
  ### ACP Support

  - Added --acp flag for ACP support
  - Added streaming support for tool parameters in TUI
  - Fixed Subagent configuration file parsing errors
</Update>

<div id="0116-2025-12-11" />

<Update label="December 11, 2025" description="CLI 0.1.16">
  ### Model Configuration Enhancements

  - Added support for setting maximum output token length (--max-output-tokens parameter and /config option)
  - Added --model parameter to specify model at startup
  - Fixed OAuth authorization issues with certain MCP Servers
  - Improved TUI display for /model command
</Update>

<div id="0115-2025-12-08" />

<Update label="December 8, 2025" description="CLI 0.1.15">
  ### Model Tier Support

  - Added /model command to switch between model tiers
  - Improved Edit tool validation logic for better file modification performance
  - Enhanced TUI display rendering
  - Fixed inability to restore input history with @file references
</Update>

<div id="0114-2025-12-03" />

<Update label="December 3, 2025" description="CLI 0.1.14">
  ### Improvements and Bug Fixes

  - Added attachments flag in headless mode for image attachments
  - Removed auto-generation of permission config files in new directories
  - Added retries for failed reasoning requests
  - Miscellaneous fixes and improvements
</Update>

<div id="0113-2025-12-02" />

<Update label="December 2, 2025" description="CLI 0.1.13">
  ### TUI Performance Optimization

  - Optimized message caching to enhance TUI rendering performance
  - Fixed Webfetch tool panic on rejection
  - Fixed TUI rendering issues in Windows WSL
</Update>

<div id="0112-2025-11-25" />

<Update label="November 25, 2025" description="CLI 0.1.12">
  ### GitHub CodeReview Release

  - Released GitHub CodeReview feature
  - Added version and other metadata fields to message history
  - Fixed issues and improved user experience
</Update>

<div id="0111-2025-11-20" />

<Update label="November 20, 2025" description="CLI 0.1.11">
  ### Tool Permissions Improvements

  - Added permission prompts when tool (including MCP) output is very large
  - Fixed bundled ripgrep failures on Linux
  - Adjusted log output location and fixed other known issues
</Update>

<div id="0110-2025-11-19" />

<Update label="November 19, 2025" description="CLI 0.1.10">
  ### Improvements and Bug Fixes

  - Removed incremental messages from stream-json output in headless mode
  - Disabled automatic backfilling of environment variables (e.g., QODER\_CURRENT\_WORKDIR) in mcp config files
  - Fixed display corruption from multi-line descriptions in subagents and commands
  - Fixed inability to delete attached files on Windows
</Update>

<div id="019-2025-11-11" />

<Update label="November 11, 2025" description="CLI 0.1.9">
  ### Streaming Output and Ultra Plan Support

  - Added Ultra Plan support
  - Added code syntax highlighting
  - Implemented streaming output and enhanced TUI rendering performance
  - Enabled command execution in headless mode
  - Improved error handling for image file processing in Read tool
  - Fixed Cygwin path compatibility issues with Read tool
  - Fixed WebFetch tool crash when processing large web pages
</Update>

<div id="018-2025-11-08" />

<Update label="November 8, 2025" description="CLI 0.1.8">
  ### Improvements and Bug Fixes

  - Added version update notifications
  - Changed default permission paths to relative in new repositories
  - Fixed Glob tool crash when search results exceed 200 items
</Update>

<div id="017-2025-11-01" />

<Update label="November 1, 2025" description="CLI 0.1.7">
  ### Qoder Personal Access Token Support for Headless Mode

  - Added Qoder Personal Access Token login support
  - Optimized text pasting performance on Windows for large content blocks
</Update>

<div id="016-2025-10-29" />

<Update label="October 29, 2025" description="CLI 0.1.6">
  ### Windows Compatibility Fix

  - Fixed file modification failures on Windows caused by CRLF line endings
  - Enhanced error messaging for failed custom Subagent and Command operations
</Update>

<div id="015-2025-10-29" />

<Update label="October 27, 2025" description="CLI 0.1.5">
  ### Windows Terminal Support Unlocked

  - Removed usage restrictions in CMD and PowerShell terminals on Windows
  - Optimized newline insertion logic for improved text wrapping at any position
  - Fixed a panic in /resume command when used in newly initialized project directories
  - Enhanced Command and Subagent generation pipeline to increase result parsing accuracy
</Update>

<div id="014-2025-10-29" />

<Update label="October 23, 2025" description="CLI 0.1.4">
  ### OAuth MCP Integration Release

  - Added OAuth support to the /mcp command for MCP Server integration
  - Increased default output token limit from 8K to 16K
  - Updated /bashes command to display only background tasks
</Update>

<div id="013-2025-10-29" />

<Update label="October 21, 2025" description="CLI 0.1.3">
  ### Cross-IDE Support Enhancement

  - Enhanced the /login command interface
  - Removed usage restrictions in JetBrains and VS Code terminals on Windows
  - Fixed a bug in the WebFetch tool that caused the agent loop to exit
  - Improved error messages for request-related failures
</Update>

<div id="012-2025-10-29" />

<Update label="October 18, 2025" description="CLI 0.1.2">
  ### Model Accuracy and User Experience Refinements

  - Removed @ symbol references from sent content to improve model accuracy
  - Fixed Bash-related tools to keep agent loop after permission denied
  - Added user-friendly prompts for common exception scenarios
</Update>

<div id="011-2025-10-24" />

<Update label="October 17, 2025" description="CLI 0.1.1">
  ### Installation fixes and general improvements

  - Fixed npm package installation problems on Windows and Linux platforms.
  - Fixed an issue where some existing users would crash after login.
  - Fixed backspace behavior at line start in special modes.
  - Enhanced TUI display and refined text content for better user experience.
</Update>

<div id="010-2025-10-24" />

<Update label="October 15, 2025" description="CLI 0.1.0">
  ### Welcome to Qoder CLI

  Hey, I'm Qoder CLI! It's great to meet you.

  I'm here to bring the full power of AI-assisted development right into your terminal—where you do your best work. No context switching, no heavy IDEs. Just you, your command line, and an AI partner that truly understands your codebase.

  Here's how we'll work together:

  - Quest Mode: Delegate complex tasks to me. Describe what you want, and I'll design the solution, implement it across files, run tests, and deliver working code. You stay focused on what matters—I'll handle the rest.
  - Agent Mode: Code through conversation. Ask me anything about your project, and I'll help you debug, refactor, or implement features with full human-in-the-loop control. Get instant answers with full context of your codebase.
  - Custom Commands & Subagents: Turn your repetitive workflows into executable commands. Whether it's generating migrations, updating docs, or running security checks—your team's knowledge becomes automation.
  - Seamless Integration: I fit into your existing workflow. Git-aware by default, shell-native by design, and ready to integrate into CI/CD pipelines. I work with the tools you already love.

  Powered by an advanced context engine and intelligent tooling, I understand your entire codebase to assist you with incredible efficiency and precision—making me a partner that truly gets your work.

  Ready to code at the speed of thought? Let's ship. 🚀
</Update>
