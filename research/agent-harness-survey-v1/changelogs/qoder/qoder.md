> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Qoder Release Notes

> Release history for Qoder.

This page lists the release history for Qoder, with the newest update first.

<Update label="September 18, 2026" description="Qoder 0.3.3">
  ### Sites: Create and Publish Websites Through Conversation

  #### Features

  - **Site building**: Choose from templates, create websites through conversation, and preview, publish, and manage sites in the desktop app.
    <video src="https://download.qoder.com/assets/changelog/283/1789571870033_4bbb52b6.mp4" controls loop muted playsInline style={{ maxWidth: "100%", borderRadius: "8px" }} />
  - **PPT creation and editing**: Open PPTX files in your workspace directly in the desktop app, and edit and save them. Download the PPT plugin from Extensions > Plugin Marketplace for a better experience.
  - **Computer Use**: Upgraded to Computer Use 2.0 for a smoother experience, with Linux support. Enable it in Settings > Computer Use to try it out.
  - **Achievement stickers**: Added 7 achievement stickers that unlock progressively as you use Qoder. Explore and collect them.
  - **Reply annotations**: When enabled in Settings > Experimental features, select text in an agent reply to add it to the input box, attach a comment, and reference the corresponding annotation in later replies.

  #### Improvements

  - **Voice input**: Press and hold the mouse in the input box for voice input; when you release, the transcription stays in the input box so you can edit it before sending.
  - **Send shortcut**: Choose in Settings whether Enter or Cmd/Ctrl+Enter sends messages.
  - **Remote Control**: Automatically syncs local session history updated within the last 7 days, with improved incremental sync that reduces redundant transfers.
  - **Worktree**: Improved start point list loading and creation readiness for large repositories, reducing load or creation failures when there are many local changes.

  #### Fixes

  - Fixed an issue where Remote Control could not restore its connection after an upgrade, and where old messages could be executed again when reconnecting.
  - Fixed Side Chat not correctly inheriting the source session context in its first reply.
  - Fixed replies possibly not appearing after sending a message during session compaction.
</Update>

<Update label="September 12, 2026" description="Qoder 0.2.5">
  ### Everyday Polish

  #### Improvements

  - File opening: Choose whether to open files in the desktop app or in the system's associated app based on file type. Qoder remembers the opening method that was used successfully.
  - Realtime voice: Improved connection stability to reduce unexpected disconnections.
  - File review: Reduced CPU usage when multiple code diffs are expanded and the terminal is open at the same time.
  - Creative achievements: Added Credits and activity data to the profile page, along with achievement stickers for creating on 7, 30, and 100 consecutive days.

  #### Fixes

  - Fixed an issue where the built-in browser could not reuse website login sessions across tasks.
  - Fixed issues where streaming replies did not keep scrolling automatically to the latest content and remained at older content after layout changes.
  - Fixed issues with Chinese text input in Computer Use.
</Update>

<Update label="September 10, 2026" description="Qoder 0.2.3">
  ### Everyday Polish

  #### Improvements

  - Before Computer Use performs a visual operation such as a click, it now verifies that the screenshot is current and that the target window still matches, improving accuracy.
  - Improved cancellation and timeout handling for Computer Use, so long-running operations respond more promptly.

  #### Fixes

  - Fixed Computer Use possibly repeating the same operation while the result of that operation could not yet be confirmed.
</Update>

<Update label="September 9, 2026" description="Qoder 0.2.2">
  ### Network Proxy Support Added

  #### Features

  - **Network proxy**: Added network proxy configuration, with connection testing. Changes take effect after a restart.

  #### Improvements

  - **Model selection**: New sessions now reuse the model you last selected manually, based on your account and runtime environment.
  - **Goal mode**: Added a maximum turn limit for Goal, and Goal timing is now paused when a session is stopped.
  - **Data import**: Improved page grouping, retention of selected items, and task recovery logic.

  #### Fixes

  - Improved automatic recovery from remote control errors, and fixed Managed SSH session failures in a VPC, BYOK model recognition on mobile, and cross-device sync issues.
  - Fixed session issues including the inability to stop during task preparation, the model being overridden when interjecting, and cold sessions relying on a stale connection when switching models.
  - Fixed startup failures on Windows that triggered automatic compatibility mode, corrupted rendering of small icons on macOS, and scrolling in the automation model list.
</Update>

<Update label="September 8, 2026" description="Qoder 0.2.1">
  ### Mobile remote control is supported

  #### Features

  - **Mobile Remote Control**: Once enabled, you can use your phone to create and run tasks on your computer. The phone and the computer share the same session, and renaming, deletion, task forking, and follow-up questions all sync in both directions.
  - **Session references via drag-and-drop**: Drag a session into the chat input box to reference it.

  #### Improvements

  - **Multitasking performance**: Lower memory usage and reduced messaging overhead when multiple tasks run concurrently.
  - **Visuals**: Updated the empty-state illustration for workspace files.
  - **Conversation output**: No longer collapsed by default; any setting you enabled manually is preserved.

  #### Fixes

  - Fixed an issue where a failed registration of a historical session prevented the conversation from continuing.
  - Fixed an issue where the last message briefly disappeared when reverting and resending.
  - Fixed continuous flickering during session output.
  - Fixed rendering issues with symbols and formulas in Markdown.
</Update>

<Update label="September 5, 2026" description="Qoder 0.1.8">
  ### Custom Base URLs for BYOK

  #### Features

  - **Custom BYOK endpoints**: Personal plan BYOK now supports custom Base URLs for any OpenAI- or Anthropic-compatible model service.

  #### Improvements

  - **Workspace Search**: You can now search for content directly within the Markdown preview.
  - **Installer**: Better process detection and install recovery on Windows
  - **Extension Market**: Smoother category switching and detail layout

  #### Fixes

  - Fixed messages lost after repeated context compression
  - Fixed MCP OAuth negotiation failure diagnostics
  - Fixed Worktree init failure with no retry option
  - Fixed voice input floating window position not preserved
</Update>

<Update label="September 3, 2026" description="Qoder 0.1.6">
  ### Everyday Polish

  #### Features

  - **Batch tasks archiving**: Multi-select tasks in the sidebar to archive them, and switch work modes with one click.
  - **Artifact preview in a separate window**: Open agent-generated artifacts in a standalone window.
  - **Clickable terminal links**: HTTP/HTTPS links in the terminal now open directly.

  #### Improvements

  - Faster app startup and smoother streaming in long sessions.
  - Reduced wait time before the first response of a new task.

  #### Bug Fixes

  - Fixed occasional duplicate sign-ins and being unable to sign in again after returning from browser authorization.
  - Fixed manually selected models being switched back to the default.
  - Fixed session messages overlapping after resizing panes.
  - Fixed sidebar drag-and-drop reordering failing with many sessions.
</Update>

<Update label="September 1, 2026" description="Qoder 0.1.4">
  ### Everyday Polish

  #### Improvements

  - Windows updates now automatically clean up old version backups, freeing disk space.

  #### Bug Fixes

  - Fixed the taskbar icon showing blank after a quick update on Windows.
  - Fixed plugins being marked unresponsive after macOS wakes from sleep.
</Update>

<Update label="August 31, 2026" description="Qoder 0.1.3">
  ### Improvements

  - Improved the reliability of installation and updates on Windows
  - Improved streaming rendering and persistence performance in long sessions for smoother responses
  - Reduced redundant refreshes triggered by plugin and MCP state changes, lowering CPU and memory usage
  - The workspace file tree is now collapsed by default and remembers your preference

  ### Bug Fixes

  - Fixed an issue where vision-capable custom models could not process image inputs
  - Fixed an issue where structured context from attachments was lost when sending
  - Fixed an issue where leftover terminated processes incorrectly blocked installation on Windows
  - Fixed an issue where the main window still appeared after closing the login or onboarding window on first install
</Update>

<Update label="August 28, 2026" description="Qoder 0.1.2">
  ### Enterprise Controls and Reliability Improvements

  #### Features

  - Added enterprise policy controls for extensions and MCP servers.

  #### Improvements

  - Improved first-message and app startup performance.
  - Improved initial data import with parallel processing and failure isolation.
  - Added clearer extension installation errors and recovery guidance.
  - Improved Knowledge Center authentication synchronization.

  #### Fixes

  - Fixed message history overwriting current input and losing unsent drafts.
  - Fixed overlapping messages after resizing panels and artifacts appearing in the wrong session.
  - Fixed sidebar sorting and pinning with large numbers of sessions.
  - Fixed Chinese SSH host names not being recognized and Remote SSH sessions disappearing after switching work modes.
  - Fixed theme conflicts between windows using different work modes.
  - Fixed Windows tray icon, first-login window, language switching, installation, and update issues.
</Update>

<Update label="August 27, 2026" description="Qoder 0.1.1">
  ### Everyday Polish

  #### Features

  - Added background bulk import for existing sessions during first launch.
  - Added work role editing in Settings.

  #### Improvements

  - Improved app startup performance and reliability.
  - Added original and discounted usage multipliers to the model menu.
  - Improved MCP reconnection and state synchronization.

  * **Voice input**: Added a quota-exhausted notice for live voice, so you always know your remaining allowance.
  * **Installation**: The installer now displays product names and download links dynamically; Linux first-time installs skip onboarding.
  * **MCP connections**: Improved stdio authorization lifecycle and retry handling for more reliable connections.
  * **Startup feedback**: The startup error page now includes a direct feedback entry.

  #### Fixes

  - Fixed duplicate login windows on first launch; auth calibration no longer blocks the main window.
  - Fixed voice drafts rendering twice in the composer and hardware cleanup errors on exit.
  - Fixed several Windows install/uninstall issues; installer copy now displays correctly.
  - Fixed language switching and website links during first login.
  - Fixed UI issues including usage label wrapping, workspace sidebar ordering, and identity card copy.
  - Fixed a cold-start misdetection in the Windows runtime.
</Update>

<Update label="August 27, 2026" description="Qoder 0.1.0">
  ### Hello, World!

  New Qoder is here. Qoder is an agentic platform for everyone, powered by an Agentic Coding core. You bring the idea, and Qoder gets it done.

  Since Qoder IDE launched in August 2025, Qoder has grown to more than 6 million users worldwide and serves more than 100,000 businesses.

  Coding is becoming a universal capability. The people using software to solve problems are no longer limited to developers; they now include everyone who wants to turn an idea into reality. At the same time, human-agent collaboration is changing: work is shifting from codebases to agent tasks, and from hands-on production to delegation and review.

  People need a task-centric interface that lives on their machine and keeps work observable and open to intervention. New Qoder is our answer.

  ### What's New

  - **Frontier models and smart routing**: Qoder brings together leading models without locking you into a single one. Choose the model that fits your task, or let the Auto routing engine balance quality, speed, and cost automatically.
  - **Harness for complex tasks**: Qoder's Harness keeps planning, execution, verification, and self-correction in a continuous loop. For long-running and complex tasks, it retains context, adapts based on real results, and retries or rolls back when needed, while permission tiers and tool allowlists keep sensitive actions within clear boundaries.
  - **Works in real environments**: With Browser Use and Computer Use, Qoder can operate websites and desktop apps as you would, so it can complete work in real environments rather than being limited to chat and codebases.
  - **An ecosystem that connects**: With more than 70 plugins, 20,000 skills, and 40 connectors, Qoder connects to the systems where work happens: code repositories, documents and data sources, collaboration tools, databases, internal APIs, ticketing systems, and monitoring tools.
  - **Proactive by default**: Qoder does more than respond to instructions. It proactively brings unresolved errors, changes without tests, inconsistent logic, task updates, and suggested next steps to your attention. You remain the decision-maker without having to remember everything yourself.

  This is just the beginning.

  Our direction is clear: fewer required interventions and more trustworthy results. As Coding becomes a universal capability, having a Coding Agent gives anyone the power to turn ideas into reality.

  We want that capability to belong to everyone.
</Update>
