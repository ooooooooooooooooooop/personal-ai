> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.com/llms.txt
> Use this file to discover all available pages before exploring further.

# JetBrains Plugin Release Notes

> Release history for JetBrains Plugin.

This page lists the release history for JetBrains Plugin, with the newest version first.

<div id="202691071036342-2026-09-11" />

<Update label="September 11, 2026" description="JetBrains 2026.910.71036342">
  ### User-Level Rules, Editor Actions & Chat Input Enhancements

  ### Features

  - Added user-level rules in Rules management, with a scope selector to filter All / Project / User rules
  - Added a "Follow IDE proxy settings" option that syncs the IDE proxy configuration to Qoder
  - Added Optimize and Comment actions to the editor right-click menu for one-click code optimization and comment generation
  - Added Paste as Snippet in chat input and a Copy File Reference action, making it easier to bring clipboard content and files into conversations
  - Added Page Up / Page Down scrolling in the chat panel

  ### Improvements

  - Improved sign-in recovery when authentication fails

  ### Bug Fixes

  - Fixed several known issues
</Update>

<div id="202690368782022-2026-09-03" />

<Update label="September 3, 2026" description="JetBrains 2026.903.68782022">
  ### Plugin Management, Conversation Forking, and Database Context

  ### Features

  - **Plugin management**: Personal settings now include plugin management with support for custom plugins.
  - **Conversation forking**: Fork a conversation to explore different approaches while keeping the original conversation intact, without abandoning your existing work.
  - **Database context**: Add database objects such as tables and schemas to conversations so the model can work with your actual database structure.
  - **Custom BYOK models**: BYOK now supports configuring custom models.
  - **Chat history search**: Search results now include keyword highlighting and filters to help locate past conversations.

  ### Improvements

  - **Sign-in stability**: Authentication can recover automatically when lost, avoiding manual sign-in after intermittent credential errors.
  - **Agent terminal execution**: Improved terminal task execution for a better experience with long-running tasks.
</Update>

<div id="202682866878802-2026-08-28" />

<Update label="August 28, 2026" description="JetBrains 2026.828.66878802">
  ### Subagent Tool Execution Fix

  ### Fixes

  - Fixed intermittent execution errors affecting some tool calls in subagents.
</Update>

<div id="202682766482424-2026-08-27" />

<Update label="August 27, 2026" description="JetBrains 2026.827.66482424">
  ### Conversation UI Improvements

  ### Improvements

  - **Conversation interface**: Refined visuals and interaction details for a cleaner, more consistent conversation experience.
</Update>

<div id="202681962697638-2026-08-20" />

<Update label="August 20, 2026" description="JetBrains 2026.819.62697638">
  ### Response Text Selection, Turn Navigation, and One-Click TODO Fixes

  ### Features

  - **Response text selection**: Add selected text from an AI response to the conversation context without quoting the entire response.
  - **Turn navigation**: A new navigation popup shows the current and total turn counts, making it easier to jump within long conversations.
  - **One-click TODO fixes**: The TODO tool window's popup menu now includes a quick-fix action to send a TODO directly to Qoder.

  ### Improvements

  - **Smoother plugin updates**: Improved background service upgrades and graceful shutdown for smoother update transitions.
  - **Terminal command execution**: Commands that time out now continue in the background instead of being interrupted. WSL workspace support has also improved.
</Update>

<div id="202681461148606-2026-08-14" />

<Update label="August 14, 2026" description="JetBrains 2026.814.61148606">
  ### Better Harness Skill, Code Explanations, and Unfocused Terminal Execution

  ### Features

  - **Better Harness Skill**: A new built-in Skill examines Harness engineering practices across multiple dimensions and suggests targeted improvements, helping identify weaknesses without manual checks.
  - **Explain code from the editor**: The editor context menu now includes Explain Code. Select code and use the action or Alt+Shift+P to get an explanation without leaving the editor.
  - **Unfocused PTY execution**: Terminal commands continue running when the IDE window is not focused, including when you switch to another app.
  - **DBML diagrams**: DBML code blocks in conversations now render as diagrams.

  ### Improvements

  - **Workspace-aware terminal execution**: Terminal execution adapts to the workspace environment. WSL projects use the IDE terminal by default.
  - **Graphviz compatibility**: Improved rendering compatibility for Graphviz diagrams in conversations.

  ### Fixes

  - Fixed intermittent credential read failures being treated as a signed-out state and requiring users to sign in again.
</Update>

<div id="202680658779059-2026-08-09" />

<Update label="August 6, 2026" description="JetBrains 2026.806.58779059">
  ### DBML Syntax Highlighting, Expanded Diagram Rendering & Full-Access Terminal Mode

  ### Features

  - **DBML syntax highlighting**: `.dbml` files now support syntax highlighting for a clearer reading experience when writing database schema definitions.
  - **Expanded diagram rendering**: Conversations now support rendering D2, Vega-Lite, Graphviz, and QRCode diagrams, so matching code blocks from the model are displayed directly as visuals.
  - **Full-access terminal mode**: When enabled, terminal commands run immediately without going through the approval flow—useful when you need to execute many commands in a row. Since commands are no longer confirmed individually, we recommend enabling this only in trusted projects and environments.
</Update>

<div id="202673056619356-2026-08-09" />

<Update label="July 30, 2026" description="JetBrains 2026.730.56619356">
  ### Session Performance and Formula Recognition Improvements

  ### Improvements

  - **LaTeX math formula recognition**: Improved recognition accuracy for LaTeX math formulas in conversations, so rendered output better matches expectations.
  - **Chat history browsing**: Improved stability and loading performance when browsing chat history, making long session lists smoother to scroll through.
  - **AI commit message generation**: Improved AI commit message generation for amend commits, so the result more accurately reflects the current changes.
  - **Credential error messages**: Improved credential error messages for sign-in and custom models, now with clear recovery guidance when something goes wrong.

  ### Bug Fixes

  - Fixed a compatibility issue with the DataSpell IDE.
</Update>

<div id="20267241-2026-08-09" />

<Update label="July 25, 2026" description="JetBrains 2026.724.1">
  ### Queue Status Notifications & MCP Policy Status

  ### Features

  - **Queue status notifications**: When a request is queued, the current queue position is shown and updates automatically once processing begins.

  ### Improvements

  - **Mermaid diagram rendering**: Improved the stability of Mermaid diagram rendering in conversations.
  - **MCP service status display**: MCP services blocked by enterprise policy are now shown as disabled, making it easier to distinguish policy restrictions from actual service errors.
</Update>

<div id="20267201-2026-07-20" />

<Update label="July 20, 2026" description="JetBrains 2026.720.1">
  ### Sticky Question Summary in Chat, Clearer Paused-Task Resumption

  ### Features

  - Added a sticky question summary in chat: while scrolling through a long response, the current question stays pinned at the top, and clicking it jumps back to that question.
  - Added a dedicated confirmation panel when a paused task needs to be resumed, making the next step clearer.

  ### Bug Fixes

  - Fixed an issue where a file could occasionally become uneditable after reviewing changes.
  - Fixed several known issues.
</Update>

<div id="20267151-2026-07-20" />

<Update label="July 20, 2026" description="JetBrains 2026.715.1">
  ### LaTeX Math Rendering, One-Click TODO Fix, and On-Demand Loading for Long Conversations

  ### Features

  - Added LaTeX math formula rendering in chat responses.
  - Added a gutter icon on TODO comments to fix them directly with Qoder.
  - Added on-demand loading for long conversations: only recent messages load first, and earlier messages load as you scroll up.
  - Added a clear notice with renewal guidance when your Credits are used up during a task, instead of the task appearing stuck.

  ### Improvements

  - Improved the login flow for a smoother, more convenient sign-in.
  - Improved rendering of chat responses, including smoother thinking-content display and more reliable Markdown headings.
  - Improved chat font rendering in JetBrains Gateway remote development mode.

  ### Bug Fixes

  - Fixed an issue where a chat response could occasionally stay stuck in the generating state.
  - Fixed several known issues.
</Update>

<div id="20267091-2026-07-13" />

<Update label="July 13, 2026" description="JetBrains 2026.709.1">
  ### Custom Agents, Computer Use & Plan Mode

  ### Features

  - Added custom agent management, supporting creating, configuring, and invoking custom agents within the plugin.
  - Added built-in agents: Computer Use and Plan Mode, with configurable run strategies in settings.
  - Added session guide messages and optimized message queue display for an improved conversational experience.
  - Added nested sub-agent display in the tool panel, with sub-task status summary and sub-tool collapse support.
  - Added task tree visualization in the Agent tool panel.
  - Added a toggle in the bottom toolbar to control whether selected text is automatically injected into context.
  - Added Qoder Cleanup feature (Tools > Qoder > Qoder Cleanup) for one-click cleanup of outdated Qoder-related files.

  ### Improvements

  - Improved Ultimate tier model performance.
  - Optimized Markdown streaming rendering performance.
  - Enhanced terminal experience.
  - Improved session title management — user-modified titles will no longer be overwritten by AI auto-generated titles.
  - Raised minimum supported JetBrains IDE version to 2021.2 (dropped support for 2020.3).
  -

  ### Bug Fixes

  - Fixed several known issues to improve overall stability.
</Update>

<div id="0194-2026-06-24" />

<Update label="June 25, 2026" description="JetBrains 0.19.4">
  ### Bug fixes

  Fixed several known issues.
</Update>

<div id="0193-2026-06-24" />

<Update label="June 25, 2026" description="JetBrains 0.19.3">
  ### Improved Login Experience

  ### Improvements

  - Optimized the login experience by reducing duplicate login prompts and improving login-check status display, making authentication smoother and more transparent.
  - Improved network diagnostics coverage for Qoder services, enabling more comprehensive issue detection.

  ### Bug Fixes

  - Fixed several known issues to improve overall stability.
</Update>

<div id="0192-2026-06-24" />

<Update label="June 25, 2026" description="JetBrains 0.19.2">
  ### Fast Mode for Kimi-K2.7-Code

  ### Features

  - Added Fast mode for Kimi-K2.7-Code, delivering faster response speeds while maintaining code generation quality.

  ### Improvements

  - Optimized login process for a smoother authentication experience.
  - Optimized chat history loading for faster retrieval.
  - Added Mac Rosetta support, resolving compatibility issues when running x64 IDEA on Apple Silicon.

  ### Bug Fixes

  - Fixed JetBrains Gateway compatibility issues.
  - Fixed several known issues to improve overall stability.
</Update>

<div id="0190-2026-06-24" />

<Update label="June 25, 2026" description="JetBrains 0.19.0">
  ### Send Text from IDE to Qoder CLI

  ### Features

  - Added the ability to send text from the IDE directly to a Qoder CLI terminal session, enabling a smoother workflow between the editor and the command line.
  - Added a Credits usage panel in the model selector for real-time quota and activity visibility.

  ### Bug Fixes

  - Fixed occasional UI freezes during chat timeout handling.
</Update>

<div id="0181-2026-06-01" />

<Update label="June 2, 2026" description="JetBrains 0.18.1">
  ### Qoder CLI Integration

  ### Features

  - Qoder CLI Integration:Launch Qoder CLI directly from the IDE terminal with auto-installation, version detection, and remote session management.

  ### Bug Fixes

  - Fixed an issue where state and resources were not properly released when a conversation ended abnormally.
  - Fixed an issue where some files could not be switched in the Diff review panel when multiple files were modified in a single response.
</Update>

<div id="0180-2026-05-25" />

<Update label="May 25, 2026" description="JetBrains 0.18.0">
  ### Model Context Length & Thinking Effort Configuration, JetBrains Terminal Support for 2025.2+

  ### Features

  - Added model context length and thinking effort configuration in the chat model selector
  - Added Terminal support for JetBrains IDE 2025.2 and later
  - Added a setting to limit how many times a task can auto-continue within a single chat session

  ### Improvements

  - Improved terminal command execution for compound commands such as cd `<dir>` && `<command>`, ensuring commands run in the intended directory and preventing Git commands from getting stuck on pager output
  - Improved Markdown link rendering and Mermaid rendering stability in chat responses

  ### Bug Fixes

  - Fixed several known issues
</Update>

<div id="0170-2026-05-10" />

<Update label="May 10, 2026" description="JetBrains 0.17.0">
  ### Multi-Chat Support and Connectivity Checks

  ### Features

  - Added support for multi-session chat tabs, so you can keep multiple conversations open at the same time. Create a new tab with Alt+T / Option+T, rename tabs, and close other tabs or tabs to the right from the tab context menu.
  - Added a Network Diagnostics panel in Settings to help check Qoder service connectivity and troubleshoot network-related issues.

  ### Improvement

  - Improved chat session reliability by syncing tab loading states and preventing duplicate tabs when opening conversation history.
  - Improved the stability of commit message generation and Mermaid rendering.
</Update>

<div id="0164-2026-05-03" />

<Update label="May 3, 2026" description="JetBrains 0.16.4">
  ### Optimized user experience for personal settings page

  ### Improvement

  - Optimized user experience for personal settings page.

  ### Bug Fixes

  - Fixed an issue where chat sessions would occasionally freeze after plugin auto-update, requiring an IDE restart to recover.
  - Fixed IDE compatibility issues on JetBrains 2020.3.
</Update>

<div id="0163-2026-04-23" />

<Update label="April 23, 2026" description="JetBrains 0.16.3">
  ### @task — Chat with Your Jira & GitHub Issues

  ### Features

  - Integrate JetBrains Task Management into chat context via @task, allowing users to reference issues from Jira, GitHub, and other trackers directly in conversations.

  ### Improvements

  - Redesigned the personal settings module with a refreshed UI layout.

  ### Bug Fixes

  - Fixed occasional out-of-order model output in chat sessions.
  - Fixed an issue where AI responses could get stuck in the "generating" state with an unresponsive stop button.
  - Fixed an occasional issue when clearing the current project's chat history.
  - Fixed an occasional Unauthorized error with BYOK custom models.
</Update>

<div id="0160-2026-04-23" />

<Update label="April 23, 2026" description="JetBrains 0.16.0">
  ### Support for standard Markdown format files to enable File-Based Prompting.

  ### Features

  - Support switching the input box to Markdown editor mode, providing a standalone .amd file editing area for a larger writing space.
  - Support copying table metadata from the database view context menu.
  - Support SVG image rendering in the conversation flow panel.
  - Slash commands are now automatically filtered by the current session mode, showing only available commands.

  ### Improvements

  - Display a "Checking login status" loading state on the login button during startup authentication check.
  - Added more built-in project ignore patterns to improve indexing performance.
</Update>

<div id="0150-2026-04-02" />

<Update label="April 2, 2026" description="JetBrains 0.15.0">
  ### New Hook Mechanism for Agent Execution

  ### Features

  - To provide developers with greater control over the agent lifecycle, we’ve implemented a comprehensive Hook system. You can now inject custom logic at critical stages of the agent's execution flow by listening to the following events:UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, and Stop.
  - New Qwen3.5-Plus Model Support

  ### Improvements

  - Added syntax highlighting support for 80+ programming languages in chat sessions.

  ### Fixed

  - Fixed several known issues.
</Update>

<div id="0141-2026-03-14" />

<Update label="March 14, 2026" description="JetBrains 0.14.1">
  ### Support Custom Models

  ### Features

  - Now supports BYOK configuration for easy integration with Coding Plans from providers including Alibaba Cloud Model Studio.

  <img width="1964" height="1444" alt="4A336C1C-B019-4B3A-90B2-467BCD4FED8A" src="https://github.com/user-attachments/assets/dc772d56-5bc7-41b1-b65f-76a2261df885" />

  - Support to use Color Scheme Font from Color Scheme in the chat window.

  ### Improvements

  - Optimized login interaction experience

  ### Fixed

  - Other performance improvements and network bug fixes.
</Update>

<div id="0130-2026-03-05" />

<Update label="March 5, 2026" description="JetBrains 0.13.0">
  ### Enhanced Context Management, SkillsJars Integration & Shortcut Improvements

  ### Features

  - Support for context usage display and proactive compression in input box.
  - Support for [SkillsJars](https://www.skillsjars.com/): right-click the resources directory to quickly create a Skill from within a Jar package via the Qoder Files menu.
  - Support for creating a new session via keyboard shortcut: Alt+N (Windows) and Option+N (Mac).
  - Support for adding files to the Qoder input box by right-clicking files in the project file window.
  - Support for right-click for cut, copy, and paste operations in Qoder input box.
  - Issue reporting now supports uploading screenshots or local images via keyboard shortcut.

  ### Improvements

  - Issue reporting now supports uploading screenshots or local images via keyboard shortcut.

  ### Fixed

  - Other performance improvements and network bug fixes.
</Update>

<div id="0121-2026-02-23" />

<Update label="February 23, 2026" description="JetBrains 0.12.1">
  ### New Qwen3.5-Plus Model Support

  ### Features

  - **Qwen3.5-Plus**: Alibaba's latest model, delivering a comprehensive leap in reasoning capability, efficiency, and multimodal experience.
</Update>

<div id="0120-2026-02-14" />

<Update label="February 14, 2026" description="JetBrains 0.12.0">
  ### More New Model Support

  ### Features

  - **Kimi-K2.5**: Kimi's latest model, excelling in multimodal understanding and complex task handling.
  - **GLM-5**: Zhipu AI's latest flagship model, excels at complex systems engineering and long-horizon tasks
  - **MiniMax-M2.5**: MiniMax's latest Agentic model, combining speed, performance, and cost-efficiency.
  - **Inline Chat**: Able to switch model selection for inline chat only

  <img width="1282" height="632" alt="image (2)" src="https://github.com/user-attachments/assets/d7edd553-2369-45c6-a342-bf314928015d" />

  ### Improvements

  - Auto swtich to Auto model for new users in Pro trial duration

  ### Fixed

  - Fixed several known issues
</Update>

<div id="0110-2026-02-03" />

<Update label="February 3, 2026" description="JetBrains 0.11.0">
  ### Built for Qoder: The New Qwen-Coder-Qoder Model, Elevating the End-to-End Coding Experience

  ### Features

  - **Introducing Qwen-Coder-Qoder Model**: A deeply customized model built to enhance the end-to-end programming experience in Qoder. This model is based on Qwen-Coder and has undergone large-scale reinforcement learning optimized for the Qoder Agent framework, tools, and scenarios. In our real-world software engineering task benchmarks, it has surpassed Cursor Composer-1 in task completion rate, particularly achieving 50% higher accuracy in terminal commands on Windows systems.

  <img width="1302" height="548" alt="image (1)" src="https://github.com/user-attachments/assets/bf9e6d9f-ac7c-4b3d-9c20-9a924a3dd0bc" />

  ### Fixed

  - Fixed other known issues
</Update>

<div id="0101-2026-01-30" />

<Update label="January 30, 2026" description="JetBrains 0.10.1">
  ### Bug fixes

  ### Improvements

  - Repositioned "Qoder Files" option in the right-click context menu

  ### Fixed

  - Fixed occasional deadlock in code completion that caused IDE freezing
</Update>

<div id="0100-2026-01-30" />

<Update label="January 30, 2026" description="JetBrains 0.10.0">
  ### Support for adding customized skills

  ### Features

  - **Custom Skills support**: Add your own skills and invoke them with /skill in the input field

  - **Enhanced .aiignore**: Now supports .md extension for more flexible file exclusion rules

  - **Quick file creation**: Right-click in Project view to create Qoder files (commands, rules, skills, AGENT.md, .aiignore)

  <img width="778" height="296" alt="2082656E-8786-41E6-A309-A34128A2BB5D" src="https://github.com/user-attachments/assets/f7c50835-a47f-4506-bfd9-a42230257175" />

  - **Smart prompt enhancement**: One-click expansion and optimization of brief prompts

  ### Improvements

  - Better quota limit notifications for free tier users

  ### Fixed

  - Fixed errors when accepting code completions with Tab
  - Fixed code completion not working for certain XML files
  - Various stability improvements
</Update>

<div id="091-2026-01-23" />

<Update label="January 23, 2026" description="JetBrains 0.9.1">
  ### Manually trigger NEXT code completion

  ### Features

  - Support for manually triggering NEXT code completion

  ### Improvements

  - Improved experience for "Issue Report"

  ### Fixed

  - Fixed compatibility issue with JetBrains 2026.1 EAP
  - Fixed occasional login error issues
  - Fixed other known issues
</Update>

<div id="090-2026-01-19" />

<Update label="January 19, 2026" description="JetBrains 0.9.0">
  ### Adds Database Integration and Command Capabilities

  ### Features

  - Comprehensive Database Support
    - Support for @databases as context in Qoder's Ask/Agent mode
    - Support for generating and executing SQL in Query Console
  - New Custom Commands
    - Create reusable commands from your common prompts and workflows, and instantly invoke them in the Agent with / to streamline daily development tasks
    - Enhanced PlantUML rendering capabilities
  - Allow editing files outside the project through tools

  ### Improvements

  - Optimized basic transport protocol
</Update>

<div id="080-2026-01-12" />

<Update label="January 12, 2026" description="JetBrains 0.8.0">
  ### Completion and NES Upgraded to NEXT

  ### Features

  - NES Core Capability Upgrade: From passive completion to proactive prediction. Now supports file edit prediction, automatic dependency imports, and more—enhanced capabilities with a refined user experience.

  ### Improvements

  - Improved Context Selection, include @gitcommit and etc.
</Update>

<div id="070-2025-12-29" />

<Update label="December 29, 2025" description="JetBrains 0.7.0">
  ### Add @openFiles for Context

  ### Features

  - Add @openFiles annotation for Context to include all open files (project's files, SDK files, Scratch files, etc. ).

  ### Improvements

  - Fixed several known issues.
</Update>

<div id="061-2025-12-19" />

<Update label="December 19, 2025" description="JetBrains 0.6.1">
  ### Bug Fixes

  Fixed several known issues.
</Update>

<div id="060-2025-12-10" />

<Update label="December 10, 2025" description="JetBrains 0.6.0">
  ### Automatically loads AGENTS.md

  ### Features

  - AGENTS.md Compatibility: Automatically loads AGENTS.md content into context when present in the root folder of your project.

  ### Improvements

  - Fixed occasional abnormal credit consumption.
  - Fixed the abnormal behavior of viewing changed files under history sessions.
  - Fixed several known issues.
</Update>

<div id="054-2025-12-02" />

<Update label="December 2, 2025" description="JetBrains 0.5.4">
  ### Introducing the New "Ultimate" Model Tier

  Introducing the New "Ultimate" Model Tier: provides expert-level deep reasoning and thinking capabilities, with output quality reaching a new level.
</Update>

<div id="053-2025-12-02" />

<Update label="December 2, 2025" description="JetBrains 0.5.3">
  ### View JetBrains Plugin Credit Usage on the Website Dashboard

  - On the Website - Personal dashboard - Usage, you can now see the credits consumed in the JetBrains plugin.
  - Several bugs have been fixed.
</Update>

<div id="052-2025-11-17" />

<Update label="November 17, 2025" description="JetBrains 0.5.2">
  ### Bug Fixes

  Fixed unavailable paste functionality in CLion and Rider.
</Update>

<div id="050-2025-11-05" />

<Update label="November 12, 2025" description="JetBrains 0.5.0">
  ### Qoder Plugin for JetBrains IDEs!

  We are excited to announce the first official release of the **Qoder Plugin for JetBrains IDEs**!
  Qoder is an agentic coding platform built for modern software development. This plugin brings the power of our AI agents directly into your editor. This initial release focuses on pillars as follows:

  ### AI Chat

  The central hub for interacting with Qoder, featuring two distinct modes:

  - Ask mode: Your go-to for expert assistance. Get contextual answers, debug code, and troubleshoot errors with an AI that understands your project.
  - Agent mode: Delegate complex tasks. The AI agent can autonomously use tools, make decisions, and execute multi-step plans to complete your objectives from start to finish.

  ### Inline code suggestion

  AI-powered features that work seamlessly within your code editor:

  - Code completion: Our completion engine goes beyond single-file analysis. It understands your entire project's context, dependencies, and architectural patterns to provide suggestions that are not just correct, but consistent.
  - NES: Qoder anticipates your next move, offering intelligent, multi-line edits directly at your cursor to accelerate refactoring and coding.

  ### Autonomous task completion

  This is what makes Qoder truly powerful. The agent can understand and act on high-level goals using a suite of advanced capabilities:

  - Full codebase awareness: The agent intelligently analyzes your entire project to grasp the full context of a task before it begins work.
  - Multi-file edits: Based on your instructions, the agent can execute complex, multi-file edits across the entire codebase.
  - Persistent memory: Qoder learns from your conversations and project history, providing increasingly personalized and effective assistance over time.
  - Autonomous tool use: The agent can independently select, generate, and execute necessary terminal commands, web searches, and other integrated tools to complete its objective.
  - Transparent Task Planning: For any complex goal, the agent first generates a structured, step-by-step plan, giving you full visibility and control over its work.

  ### Customization & extensibility

  Tailor Qoder to your specific environment and standards:

  - Project rules: Define project-specific rules to ensure the AI's output consistently aligns with your team's coding standards and architectural patterns.
  - MCP: Securely connect Qoder to your own internal APIs, databases, and other data sources, extending its capabilities far beyond the IDE.

  To begin, install the plugin and open the AI Chat panel from the side navigation bar to sign in. We can't wait to see what you build with Qoder!
</Update>
