> ## Documentation Index
> Fetch the complete documentation index at: https://docs.qoder.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent SDK Release Notes

> Release history for Agent SDK.

This page lists the release history for Agent SDK.

<div id="sdk-1041" />

<Update label="September 15, 2026" description="SDK 1.0.41">
  ### Control Request Timeout Identification Improvements

  - Added structured errors for identifying control request timeouts
</Update>

<div id="sdk-1034" />

<Update label="September 5, 2026" description="SDK 1.0.34">
  ### Stability improvements

  - Fixed stability issues
</Update>

<div id="sdk-1033" />

<Update label="September 4, 2026" description="SDK 1.0.33">
  ### Goal and sub-agent control

  - Added support for configuring and dynamically adjusting the maximum number of Goal turns
  - Changed the default maximum sub-agent generation depth to 1, with customization through an environment variable
</Update>

<div id="sdk-1032" />

<Update label="September 1, 2026" description="SDK 1.0.32">
  ### Auto mode permission checks

  - Improved permission checks in Auto mode
</Update>

<div id="sdk-1031" />

<Update label="September 1, 2026" description="SDK 1.0.31">
  ### Large image compaction fix

  - Fixed automatic context compaction failures caused by oversized images
</Update>

<div id="sdk-1030" />

<Update label="August 29, 2026" description="SDK 1.0.30">
  ### URL image input compatibility

  - Improved API compatibility for URL-based image input
</Update>

<div id="sdk-1029" />

<Update label="August 29, 2026" description="SDK 1.0.29">
  ### Base64 and URL image input

  - Added support for Base64 and URL image sources
</Update>

<div id="sdk-1028" />

<Update label="August 27, 2026" description="SDK 1.0.28">
  ### Stability improvements

  - Bug fixes and stability improvements
</Update>

<div id="sdk-1027" />

<Update label="August 26, 2026" description="SDK 1.0.27">
  ### Authentication stability

  - Improved authentication stability to reduce session interruptions caused by expired tokens
</Update>

<div id="sdk-1026" />

<Update label="August 26, 2026" description="SDK 1.0.26">
  ### Plan Mode and runtime control

  - Added independent Plan Mode controls
  - Added proxy configuration support
  - Added optional model overrides through `resolveModel`
  - Added OpenHarmony ARM64 Worker Runtime support
  - Improved maximum-turn termination results for more accurate stop-reason handling
</Update>

<div id="sdk-1025" />

<Update label="August 19, 2026" description="SDK 1.0.25">
  ### Goal and plugin control

  - Added structured Goal controls for managing session objectives and status
  - Added workspace-scoped plugin enable and disable controls
</Update>

<div id="sdk-1024" />

<Update label="August 18, 2026" description="SDK 1.0.24">
  ### Side questions, Memory, and security configuration

  - Added `askSideQuestion()` for asking side questions without interrupting the main task
  - Added SDK Memory configuration and update support
  - Added code security scan configuration
  - Preserved structured tool results when reading session history
</Update>

<div id="sdk-1023" />

<Update label="August 17, 2026" description="SDK 1.0.23">
  ### Background shell task control

  - Added controls for background Shell tasks
</Update>

<div id="sdk-1022" />

<Update label="August 15, 2026" description="SDK 1.0.22">
  ### Context and session recovery improvements

  - Added `getContextUsage()` for inspecting context usage details
  - Added controls for resuming sessions from a specific historical message
  - Preserved tool rejection details when restoring session history
  - Avoided duplicate API error displays
  - Improved Worker Runtime installation for CN and Global SDK packages across supported platforms
</Update>

<div id="sdk-1021" />

<Update label="August 13, 2026" description="SDK 1.0.21">
  ### SDK API and Worker Runtime compatibility

  - Added plugin validation API
  - Added APIs for session prewarming and effective settings resolution
  - Improved Worker Runtime compatibility with Electron ASAR applications
</Update>
