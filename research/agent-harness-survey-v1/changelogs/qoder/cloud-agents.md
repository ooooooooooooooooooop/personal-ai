> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Cloud Agents Release Notes

> Release history for Cloud Agents.

This page lists the release history for Cloud Agents, with the newest version first.

<div id="v100-2026-09-18" />

<Update label="September 18, 2026" description="CloudAgents V1.0.0">
  ### Agent as a Service: Accelerate 10× from Idea to Production

  Qoder Cloud Agents 1.0 provides enterprises and individual developers with fully managed cloud Agents through the Agents API. Developers define business goals, while QCA handles Agent execution, delivery, and operations at scale, taking Agent applications from rapid validation to sustained production with capability upgrades as the platform evolves.

  ### Go Straight to Production

  - **Multiple integration options**: Access Agents through Skills, Plugins, and the CLI, or embed them into existing services through APIs and SDKs for multiple languages, from in-tool experiences to business system integration.
  - **Open management and runtime capabilities**: Manage Agents, execution environments, sessions, and runtime resources through APIs to embed AI assistants into existing products or build your own Agent platform.
  - **QCA Assistant**: Get help with Agent configuration, integration, and troubleshooting, including parameter explanations, configuration suggestions, and integration code examples.

  ### Bring Agents into Your Business

  - **Forward enterprise delivery**: Define capabilities through Templates and manage end-user identities through Identities. Combine credentials, resource isolation, and usage management to continuously deliver Agents to business users.
  - **Open execution and reusable capabilities**: Connect runtime events to business workflows through Webhooks, use your own tool execution environments, and reuse Skills and MCP capabilities.
  - **Multiple interaction channels**: Support a range of IM channels in China and internationally, plus Realtime Voice interaction (Beta), so users can work with Agents in familiar communication settings.

  ### Verifiable Intelligence

  - **Memory and Dreaming**: Retain experience across sessions and use Dreaming to organize and consolidate reusable memories.
  - **Observability and evaluation**: Track runtime status and usage. Manage datasets, evaluators, and experiments in the Evaluation Console (Beta) to compare different Agent configurations.
  - **Outcomes**: Check deliverables against user-defined acceptance criteria and keep refining them based on evaluation feedback within a configured number of rounds, making task results inspectable and traceable.

  ### Scale with Less Overhead

  - **Batch offline processing**: Submit tasks in batches, execute them asynchronously, track progress, and aggregate results and failure information.
  - **Elastic execution**: Activate execution environments on demand and release them when idle. Use resources across regions to meet business needs while reducing idle resources and self-deployment overhead.
  - **Long-running tasks**: Execute continuously in the cloud, persist session state and events, and resume event streams after disconnection to reduce the impact of client disconnects on task tracking.
</Update>

<div id="v080-2026-09-10" />

<Update label="September 10, 2026" description="CloudAgents V0.8.0">
  ### Advisor, Evaluation, and Resource Management Enhancements

  ### ✨ New

  - **Advisor support**: Managed Agents can configure one independent Advisor for guidance based on the current task context. The main thread invokes the Advisor, which returns advice without executing tools
  - **Generic Git repository integration**: Managed Sessions support HTTPS Git repositories with credential authentication, anonymous cloning of public repositories, and branch selection
  - **Evaluation Console Beta**: Manage datasets and versions, configure evaluators, run experiments, and compare results. Review case results and scores, and compare completed or failed experiments that use the same dataset version and the same set of evaluators

  ### 🔧 Improvements

  - **Higher Skill binding limits**: A Managed Agent can bind up to 50 Skills by default. Administrators can adjust binding quotas per user; the effective configuration determines the limit
  - **Improved resource search and filtering**: Managed resource search supports partial name matching, resource ID prefixes, and metadata filters. The search APIs remain in Beta. Forward Session lists support title or full Session ID searches and filtering by Identity ID
</Update>

<div id="v070-2026-08-06" />

<Update label="August 6, 2026" description="CloudAgents V0.7.0">
  ### Features and improvements

  ### ✨ New

  - Agents support Browser Use — open web pages in a session, read page content, and complete web-based interactions and analysis

  ### 🔧 Improvements

  - QCA Assistant can suggest Agent configuration improvements, recommend usage modes, and generate integration code samples for your scenario
  - Session credit charges are shown per conversation turn for easier usage reconciliation
</Update>

<div id="v060-2026-07-23" />

<Update label="July 23, 2026" description="CloudAgents V0.6.0">
  ### Features and improvements

  ### ✨ New

  - Batch API: submit large job sets via JSONL, with off-peak execution, cancellation, and result download
  - Schedule runs in an isolated session and can deliver results back to the source session; nested Schedule management is blocked during a run
  - Create or update Skills with natural language, and mount GitHub repositories for Agents
  - Stronger Channel observability; thinking payloads available when thinking events are requested

  ### 🔧 Improvements

  - More reliable Batch / Schedule recovery under failures and concurrency
  - Clearer Identity and Skill lookup / conflict messaging
</Update>

<div id="v050-2026-07-15" />

<Update label="July 15, 2026" description="CloudAgents V0.5.0">
  ### Console Forward Mode and experience updates

  ### ✨ New

  - Console supports switching to Forward Mode with separate navigation for each mode
  - Console adds a Forward template debugger — create debug sessions, send messages, upload attachments, inspect event streams, and handle tool approvals
  - Console observability overview — active Sessions, success rate, Token / Credit usage, 7-day trends, and details
  - Console usage and quota views — monthly usage, remaining budget, daily consumption, and dimension-level changes
  - Memory Store now supports Agent read and write, so Agents can organize and maintain their memory while working—persisting key information and reusing it in later tasks for more coherent context accumulation
  - Agents now support native image recognition, understanding and reading images directly within a conversation with faster, more efficient image parsing for smoother handling of image-related tasks
</Update>

<div id="v010-2026-07-07" />

<Update label="July 7, 2026" description="CloudAgents V0.1.0">
  ### Forward Mode Launch: Deliver Agents to End Users and Business Systems

  ### ✨ New

  - Forward Mode is now available — deliver pre-configured Agents to end users with just template\_id + identity\_id
  - Forward Templates and Identity — admins preset Agent templates; Identity injects per-user configuration (tools, Skills, files, memory stores, env vars) with automatic memory and permission isolation
  - Forward Schedule: cron, one-time, and manual triggers — runs on schedule and can push results to IM channels
  - Forward Channel: built-in IM integrations (DingTalk, Feishu, WeCom, WeChat, Slack, and more) — messaging, QR binding, approvals, and file intake
  - Forward Schedule: create, query, and delete schedules via natural language; monitoring tasks support start/stop windows
  - Forward Channel: Lark integration — QR registration, long-lived sessions, messaging, and streaming card updates
  - Forward Channel: per-region channel availability and user quota configuration
  - Forward Identity / Channel: Runtime Channels auto-archive and stop sessions when Identity is deleted or Template is archived

  ### 🔧 Improvements

  - Stronger validation and stability for Forward Mode enterprise integrations
  - Forward Schedule: fair queuing and automatic recovery for stable operation under high concurrency
  - Forward Schedule: hot-reloadable dispatch parameters — no service restart required
  - Forward Schedule: natural-language schedule creation prompts for missing details when input is incomplete
  - Forward Channel: stronger Runtime Channel security and user ownership checks with reduced credential exposure
  - Forward Channel: improved approval and streaming card UX — fewer cross-session mix-ups
</Update>

<div id="v008-2026-07-05" />

<Update label="July 5, 2026" description="CloudAgents V0.0.8">
  ### Event-Driven + Vision: Making Agents More Proactive

  **✨ New**

  - Agents now include built-in ImageSearch and ImageGen tools — search or generate images directly in conversations
  - Webhook support for event-driven push notifications — get real-time Agent/Session lifecycle updates at your registered URL without polling
  - Choose model context window size (e.g. 200K, 1M) when creating an Agent to fit different workloads
  - File uploads now accept images, documents, archives, and audio/video formats

  **🔧 Improvements**

  - Session input redesigned with a ChatGPT-style send/stop toggle for more intuitive control
  - Skill and MCP chips in sessions are now clickable to view details
  - MCP server configuration adds an "Interaction Strategy" option
  - Skill Marketplace now supports multi-select and one-click batch import for faster Agent setup
  - Session detail page adds Agent / Environment / Vault tabs for quick access to related resources
</Update>

<div id="v007-2026-06-30" />

<Update label="June 30, 2026" description="CloudAgents V0.0.7">
  ### Cloud Use Launch: Let Agents Operate Cloud Services Autonomously

  This release centers on the **Cloud Use** thesis: Agents are no longer just conversational assistants — they are autonomous units that securely invoke cloud APIs under a machine identity. Together with the Diagnostic Assistant and Session Dynamic Patch, the full loop from assembly to debugging is dramatically faster.

  ### ☁️ Cloud Use — One Task, Full Cloud Loop

  No human needs to stay online. The Agent operates under a machine identity, securely calling Alibaba Cloud services via the MCP protocol — from running SQL on MaxCompute to orchestrating DataWorks pipelines — completing the entire cloud workflow in one shot.

  - **One-click skill assembly**: Browse the Qoder Skill Center with the Alibaba Cloud section pinned at the top, multi-select and batch import supported, from discovery to deployment in a single flow
  - **Secure MCP credential hosting**: Vault-backed credential groups with collapsible organization and lazy loading, OAuth wizard with guided setup (including a dedicated Alibaba Cloud Use onboarding flow) — secrets never leave the Vault, Agents call transparently
  - **Single-pane Agent setup**: Import skills → bind MCP credentials → configure permission policies → create Agent, all completed in one console without switching tools

  ### 🩺 Diagnostic Assistant

  When a Session stalls, errors, or behaves unexpectedly, the Diagnostic Assistant handles "locate → root-cause → recommend" entirely within the console — no more digging through logs to piece together context.

  - **Real-time diagnosis**: Automatically identifies errors, infers root causes, and provides actionable fix suggestions
  - **One-click context pull**: Events, turns, and tool\_calls are collected automatically as diagnostic input — no manual export needed
  - **Shareable conclusions**: Diagnostic results can be exported, copied, or shared — paste into tickets or sync with the team

  ### 🔄 Session Dynamic Patch

  Running Sessions now accept live configuration changes — no need to archive and recreate.

  - **Instant config delivery**: PATCH tools and mcp\_servers; changes take effect on the very next turn
  - **Zero-interruption debugging**: A/B test prompts, add tools on the fly, swap models — without restarting the session
  - **Context preserved**: Configuration changes do not discard existing conversation or execution history

  ### 🔧 Improvements

  - MCP tool picker now supports collapsible groups, lazy loading, and type filtering for quick navigation in long lists
  - Skill package downloads use native browser downloads, eliminating cross-origin compatibility issues
  - Self-hosted mode no longer force-injects workdir; uses relative path prompting instead, better aligned with local engineering workflows
  - Deployment creation and run UX improvements: resource config prefill, correct initial event block rendering
  - Skill center import button permanently anchored in the bottom action bar — no more scrolling to find the confirm action in multi-select scenarios
  - Environment list shows a "Self-hosted" label for self\_hosted type entries, making environment ownership visible at a glance
</Update>

<div id="v006-2026-06-18" />

<Update label="June 18, 2026" description="CloudAgents V0.0.6">
  ### Bring Your Own Infrastructure, Reach Private Tools

  This release evolves the Agent from a single cloud execution environment into an open system — bring your own infrastructure, reach private-network tools, and programmatically initialize your environment.

  ### 🏗️ Self-Hosted Sandbox

  Run agent tool execution on your own infrastructure while LLM inference stays in the cloud. Your code, filesystem, and network egress never leave your environment — ideal for data compliance and private network access.

  - Create a `self_hosted` environment; workers listen to and execute tasks via the Work Queue protocol
  - Supports Go SDK, CLI, and direct HTTP integration in any language

  ### 🔌 MCP Connector

  Securely and reliably expose private-network MCP servers to Cloud Agents through a Connector — no need to open internal services to the public internet.

  - Create Tunnel → Start Connector (SSE reverse connection) → Bind tunnel\_id to Session — three steps to completion
  - Domain allowlist + IP-level SSRF protection for a clear security boundary
  - Horizontal scaling with multiple Connector instances per Tunnel for load balancing

  ### 🛠️ Worker setup\_script

  Workers run a custom initialization script before tool execution begins. Use it to install dependencies, pre-configure the environment, stage resources, or inject credentials. In sandbox mode, it runs once per session before the first tool call.

  ### 🔧 Improved

  - Tool execution duration display uses wall-clock anchoring, eliminating timer jumps caused by streaming rendering
</Update>

<div id="v005-2026-06-14" />

<Update label="June 14, 2026" description="CloudAgents V0.0.5">
  ### Multi-Agent Collaboration, Environment Variables, Intelligent Memory, Scheduled Deployments

  This release evolves Agents from "single-role, one-shot conversations" into a full system of multi-role collaboration, cross-session memory, and automated scheduling.

  ### 🤝 Multi-Agent Collaboration

  Orchestrate multiple Agents within a single session — each runs in its own thread and communicates via a Mailbox mechanism. Ideal for splitting complex tasks into multi-role pipelines (e.g., research + code + test) without manual coordination.

  ### 🔑 Environment Variables

  Pass custom key-value environment variables when creating a session. Agents access them directly via `$ENV_NAME` in the Sandbox. Perfect for injecting database URLs, API keys, and other runtime config without hardcoding them in prompts.

  ### 🧠 Dreaming (Intelligent Memory)

  After a session ends, the platform automatically reviews the conversation, extracts key insights, and writes them to a Memory Store. The next time the same Agent starts, it loads existing memories — enabling persistent context accumulation across sessions. The more you use it, the better it knows your project.

  ### ⏰ Scheduled Deployments

  Configure cron-based recurring triggers or trigger manually with one click. Full lifecycle management included: pause / resume / archive / auto-retry / auto-pause after consecutive failures. Ideal for daily reports, periodic health checks, and data synchronization workflows.
</Update>

<div id="v004-2026-06-10" />

<Update label="June 10, 2026" description="CloudAgents V0.0.4">
  ### GitHub Repos, Model Freedom, and Tool Control

  This upgrade focuses on making Agent inputs smoother, model selection freer, tool execution more controllable, and the overall experience more stable. It covers four themes: GitHub repository mounting, new model catalog, custom Agent tool support, and a batch of bug fixes and UX improvements.

  ### 🔗 GitHub Repository Support

  - Mount GitHub repositories directly as session resources when creating a session — no need to clone locally and upload. One less step.
  - Inline GitHub Personal Access Token input on the session creation page. Private repos are ready to use on the spot — credentials apply to the current session only, no separate vault configuration required.

  ### 🤖 New Model Catalog

  - Added support for multiple partner models in one go — Qwen, DeepSeek, GLM, Kimi, MiniMax, and more — with a unified `${price_factor}x` credit multiplier display, making it easy to pick the right model for the task and budget.

  <img width="1358" height="824" alt="image" src="https://github.com/user-attachments/assets/841e0e18-024a-4e95-bfcb-786d7f0dd611" />

  ### 🛠️ Custom Agent Tool Support

  - Agents can now declare `type: custom` tools with execution logic implemented on the client side, letting you extend Agent capabilities per your business needs without being limited to the built-in toolset.
  - Three-tier tool permission policies: `always_allow` for auto-execution, `always_ask` for user confirmation before execution, and `always_deny` for outright rejection. Human-in-the-loop lands for the first time — sensitive actions can require manual approval.
  - MCP tools can be authorized by server prefix in one shot. Configure once and all tools under that server are permitted — no more checking them off one by one.

  ### 🐛 Bug Fixes & UX Improvements

  - Session event list now supports cursor-based pagination with infinite scroll — sessions with more than 100 events are no longer silently truncated.
  - Files page sorts by creation time descending with the newest file on top; new "Purpose / Status / File ID" columns and one-click copy.
  - SSE event streams support Last-Event-ID resume after reconnects — network hiccups recover automatically with no manual page refresh.
  - 10-second session list polling no longer causes full-page flicker; the event panel has its own scroll container and no longer drags the whole page.
  - Agent edit mode skill display is now fully consistent with the detail view; hitting the 20-skill cap shows a friendly inline error and blocks submission upfront.
  - Pressing Enter during IME composition no longer sends the message prematurely; file mount paths no longer produce `/data/data` double prefixes.
  - Feedback dialog supports image upload and one-click viewport screenshot, moved into the Settings menu for a smoother reporting flow.
  - Sessions stuck in the cancelling state now auto-recover; concurrent resource additions run under `FOR UPDATE` locks to prevent overwrites.
  - Skills zip uploads automatically normalize Windows backslash paths for consistent behavior across Mac and Windows.
</Update>

<div id="v003-2026-06-02" />

<Update label="June 2, 2026" description="CloudAgents V0.0.3">
  ### Agent artifacts downloadable

  ### Agent artifacts downloadable via Files API

  **✨ New**

  - Smoother real-time event streaming: automatic reconnection with resume-from-last-event after network interruptions — no page refresh needed.
  - More flexible file mounting & downloads: custom mount paths for uploaded files with no directory restrictions; agent-produced artifacts are now downloadable via the Files API.

  <img width="2558" height="614" alt="image" src="https://github.com/user-attachments/assets/19f33652-0fec-449d-b143-ccc9c77a5dae" />

  **🔧 Improved**

  - Session detail layout refined — event list and detail panel now scroll independently.
  - Enter key no longer sends messages prematurely during IME composition (Chinese, Japanese, etc.).

  **🐛 Fixed**

  - Fixed an issue where some agent sessions would get stuck due to misconfigured tool permissions.
  - Fixed sessions staying in "Cancelling" state indefinitely without completing.
</Update>

<div id="v002-2026-05-27" />

<Update label="May 28, 2026" description="CloudAgents V0.0.2">
  ### Qoder Cloud Agents Beta Release

  ### Qoder Cloud Agents is now in public beta — deploy persistently running, self-evolving AI Agent cloud services via REST API.

  Qoder Cloud Agents is a fully managed AI Agent platform with a built-in reasoning execution engine and tool runtime environment, providing persistent storage for task conversations and file history. Through the separation of "brain" and "hands," it enables management of arbitrary execution environments while ensuring data security. Developers can quickly build their own applications by directly invoking Cloud Agents via API.

  ### Core Capabilities

  - Agent API: Declaratively create and manage Agents (models, tools, system instructions, MCP integrations), with version management and rollback support
  - Managed Environments: Securely isolated Sandbox execution environments with configurable network policies — no infrastructure to build or maintain
  - Long-Running Sessions: Continuous execution for up to 26 hours, with checkpoint resume support and event-stream-based state persistence
  - Built-in Toolset: 8 out-of-the-box tools (bash, read, write, edit, glob, grep, web\_fetch, web\_search)
  - MCP Extensibility: Connect to external MCP Servers for unlimited extensibility
  - Real-time SSE Event Stream: Full observability — every reasoning step and tool call is pushed in real time
  - Self-Evolving: When the platform upgrades models and orchestration strategies, integrated applications automatically get stronger with zero code changes

  ### API Endpoints

  - `POST /v1/cloud/agents` — Create an Agent
  - `POST /v1/cloud/environments` — Create an execution environment
  - `POST /v1/cloud/sessions` — Create a Session (binding Agent + Environment)
  - `POST /v1/cloud/sessions/{id}/events` — Send a message
  - `GET /v1/cloud/sessions/{id}/events/stream` — Stream responses (SSE)

  ### Additional Features

  - File upload and management support (Files API)
  - Secret injection support (Vaults API)
  - Skill packages support (Skills API)
  - Persistent memory support (Memory Stores API)
  - Quickstart Console: from zero to your first running Agent in 60 seconds
</Update>
