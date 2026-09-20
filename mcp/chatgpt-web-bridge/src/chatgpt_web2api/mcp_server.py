"""MCP Server — expose ChatGPT-Web2API as an MCP server for AI agents.

Implements the Model Context Protocol following official reference patterns
from the `modelcontextprotocol/servers` repository:

  - Pydantic BaseModel input schemas (mcp-server-git pattern)
  - Enum for tool names to prevent typos
  - ToolAnnotations on every tool with all 4 hints
  - outputSchema + structuredContent on every tool
  - Resource templates for dynamic URIs
  - Rich descriptions with domain knowledge baked in
  - Pure business logic with thin tool handlers
  - raise_exceptions=True for proper error propagation

Transports:
    stdio  — for Claude Desktop, Cursor, etc. (default)
    sse    — for web clients (Craft Agent, custom hosts)

Run:
    chatgpt-web2api-mcp                         # stdio (default)
    chatgpt-web2api-mcp --transport sse          # SSE on port 8090
    chatgpt-web2api-mcp --transport sse --port 3000

Prerequisites:
    Run 'chatgpt-web2api' first to start Chrome with an authenticated session.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import sys
import time
from collections.abc import Awaitable, Callable
from enum import Enum
from pathlib import Path
from typing import Any

from mcp import types as mcp_types
from mcp.server import NotificationOptions, Server
from mcp.server.stdio import stdio_server
from pydantic import BaseModel, Field

from . import __version__, conv_binding, conv_dom_read
from .breakers import BreakerKind, BreakerRegistry, CircuitOpenError
from .cdp_driver import (
    AuthExpiredError,
    CDPDriver,
    GenerationInProgressError,
    GenerationStuckError,
    RateLimitError,
)
from .config import Config
from .cross_process_lock import LockAcquisitionError
from .lock_resolver import (
    MutationLock,
    OwnedTabRequiredError,
    resolve_mutation_lock,
)
from .request_monitor import RequestMonitor, request_progress
from .request_pace import ReadThrottledError
from .resilience import retry_on_rate_limit
from .send_recovery import run_with_send_recovery
from .runtime_info import get_runtime_info
from .tab_registry import TabRegistry

logger = logging.getLogger(__name__)

# How many streamed chunks between coalesced progress notifications. The
# underlying DOM poll yields roughly one delta per ~0.5s, so notifying every
# 10 chunks ≈ one progress signal every ~5s — enough to reset an MCP client's
# idle/timeout timer without flooding it. Tunable.
_PROGRESS_EVERY_N_CHUNKS = 10

# A progress notifier built per-request from the MCP request context. Receives
# a short human-readable status string; None means the client can't receive
# progress (no token) and the business function must skip emitting.
ProgressCallback = Callable[[str], Awaitable[None]]


# ═══════════════════════════════════════════════════════════════
# Input Schemas — Pydantic BaseModel (official pattern from mcp-server-git)
# ═══════════════════════════════════════════════════════════════


class ChatCompletionInput(BaseModel):
    """Input schema for chat_completion tool."""

    message: str = Field(description="The user message to send to ChatGPT")
    timeout_seconds: int = Field(
        default=900, ge=1, le=1800,
        description="Total request budget including queueing, navigation, send and reply verification. A timeout does not prove the message was unsent.",
    )
    system_prompt: str | None = Field(
        default=None,
        description=(
            "System instructions prepended to the message. "
            "Changing this value starts a new conversation. "
            "For persistent instructions, use a project instead — "
            "project instructions apply to all conversations in the project."
        ),
    )
    model: str = Field(
        default="auto",
        description=(
            "Model slug to use. Common values: auto (default), "
            "gpt-5-5 (latest, reasoning), gpt-5-mini (fast, simple tasks). "
            "Use list_models to see all available slugs."
        ),
    )
    conversation_id: str | None = Field(
        default=None,
        description=(
            "UUID of an existing conversation to continue. "
            "When omitted, the tool auto-continues the last conversation "
            "(if system_prompt and project_id haven't changed). "
            "Pass a specific ID to resume a particular conversation."
        ),
    )
    project_id: str | None = Field(
        default=None,
        description=(
            "ChatGPT project gizmo ID (e.g. g-p-abc123) OR exact project name "
            "(e.g. 'REDACTED内容与展示') — names are resolved against "
            "list_projects and ambiguous/unknown names fail rather than "
            "landing in the wrong project. For project-scoped memory, "
            "custom instructions, and file attachments. Changing this value "
            "starts a new conversation."
        ),
    )
    confirm: bool = Field(
        default=False,
        description=(
            "Set true when explicit user approval already covers this target "
            "and action (including any occupied-session takeover). Otherwise "
            "the first send returns confirmation_required naming the target; "
            "obtain approval before retrying. Existing approval for the same "
            "target and scope remains valid across MCP reconnects."
        ),
    )


class ListModelsInput(BaseModel):
    """No inputs needed — empty schema."""

    pass


class ListProjectsInput(BaseModel):
    """No inputs needed — empty schema."""

    pass


class GetConversationInput(BaseModel):
    """Input for retrieving conversation history.

    Messages are returned oldest-first. ``limit`` caps how many messages a
    single call returns; ``offset`` skips earlier messages so the agent can
    page through an arbitrarily long conversation in chunks that each fit a
    tool-result budget. ``total`` + ``has_more`` in the response tell it when
    to stop. Defaults (offset=0, limit=50) preserve the old behavior.
    """

    conversation_id: str = Field(
        description="UUID of the conversation to retrieve",
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Skip this many messages from the start. Page through by "
        "increasing offset by `limit` each call until has_more is false.",
    )
    limit: int = Field(
        default=50,
        ge=1,
        le=500,
        description="Max messages to return per call. Lower this (e.g. 15) if "
        "the conversation has very long messages and the result is being "
        "truncated before reaching you.",
    )
    tail: int | None = Field(
        default=None,
        ge=1,
        le=500,
        description=(
            "Return only the final N messages. This is a single backend read "
            "and is useful for checking whether a reply arrived; it avoids "
            "a separate total read followed by an offset read. When set, "
            "`offset` must remain 0."
        ),
    )
    fresh: bool = Field(
        default=False,
        description=(
            "Bypass the short-lived conversation read cache. Use this when "
            "recovering after a send or when the cached tail may be stale. "
            "An already-running fresh read is shared; a normal pre-send read "
            "is not joined by this recovery read."
        ),
    )
    out_file: str | None = Field(
        default=None,
        description=(
            "Absolute path to write this page's messages to as UTF-8 text "
            "(## role + content per message). When set, messages are NOT "
            "returned inline — the tool result stays tiny no matter how long "
            "the messages are, and you read the file instead. Use this for "
            "long replies instead of fighting tool-result truncation."
        ),
    )


class WaitReplyInput(BaseModel):
    """Input for waiting until the assistant reply persists."""

    conversation_id: str = Field(
        description="UUID of the conversation to watch",
    )
    timeout_seconds: int = Field(
        default=600,
        ge=1,
        le=3600,
        description="Give up after this many seconds (default 600).",
    )
    since_total: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Only count replies that arrive AFTER this many total messages. "
            "Pass the `total` from a prior get_conversation call to wait for a "
            "NEW reply instead of matching an already-present tail message."
        ),
    )
    poll_seconds: int = Field(
        default=15,
        ge=8,
        le=120,
        description="Interval between backend polls (default 15; the account-level read pace gate applies on top).",
    )
    dead_after_seconds: int = Field(
        default=120,
        ge=0,
        le=1800,
        description=(
            "Legacy hint only. A user tail by itself is never proof that a "
            "generation died, so wait_reply no longer returns status='dead' "
            "from this timer alone. 0 disables the legacy observation timer."
        ),
    )


class ListConversationsInput(BaseModel):
    """Input for listing recent conversations."""

    limit: int = Field(
        default=28,
        description="Maximum number of conversations to return (default: 28)",
    )
    offset: int = Field(
        default=0,
        description="Number of conversations to skip for pagination",
    )


class DeleteConversationInput(BaseModel):
    """Input for deleting a conversation."""

    conversation_id: str = Field(
        description="UUID of the conversation to delete",
    )


class CreateProjectInput(BaseModel):
    """Input for creating a new ChatGPT project."""

    name: str = Field(
        description=("Display name for the project. This name appears in the ChatGPT sidebar."),
    )
    instructions: str = Field(
        default="",
        description=(
            "Custom instructions (system prompt) for the project. "
            "These instructions apply to ALL conversations created within this project. "
            "Example: 'You are a specialist in Python async programming. Always provide "
            "type hints and docstrings.'"
        ),
    )
    memory_scope: str = Field(
        default="project_v2",
        description=(
            "Memory scope for the project. "
            "'project_v2' = dedicated memory (isolated, no shared memory from other chats) "
            "'global' = shared memory (uses the global ChatGPT memory pool). "
            "Use 'project_v2' when you want isolated context for a specific task."
        ),
    )


class UpdateProjectInstructionsInput(BaseModel):
    """Input for updating a project's custom instructions."""

    project_id: str = Field(
        description="Project gizmo ID (e.g. g-p-abc123)",
    )
    instructions: str = Field(
        description=(
            "New custom instructions for the project. "
            "These replace any existing instructions. "
            "They apply to all new conversations in the project."
        ),
    )


class ArchiveConversationInput(BaseModel):
    """Input for archiving or unarchiving a conversation."""

    conversation_id: str = Field(description="UUID of the conversation")
    archive: bool = Field(
        default=True,
        description="True to archive, False to unarchive",
    )


class ListMemoriesInput(BaseModel):
    """No inputs needed."""

    pass


class CreateMemoryInput(BaseModel):
    """Input for creating a new ChatGPT memory."""

    content: str = Field(
        description=(
            "The fact or information to store in ChatGPT's memory. "
            "ChatGPT will remember this across future conversations. "
            "Example: 'The user prefers concise answers with code examples.'"
        ),
    )


class DeleteMemoryInput(BaseModel):
    """Input for deleting a ChatGPT memory."""

    memory_id: str = Field(description="ID of the memory to delete")


class DeleteProjectInput(BaseModel):
    """Input for deleting a ChatGPT project."""

    project_id: str = Field(description="ID of the project to delete (g-p-...)")


class ListGptsInput(BaseModel):
    """No inputs needed."""

    pass


class ListProjectFilesInput(BaseModel):
    """Input for listing project files."""

    project_id: str = Field(
        description="Project gizmo ID to list files for",
    )


class ChatWithGptInput(BaseModel):
    """Input for chatting with a specific Custom GPT."""

    gpt_id: str = Field(
        description=(
            "Custom GPT gizmo ID (e.g. g-hkJGhxxx). Use list_gpts to discover available GPTs."
        ),
    )
    message: str = Field(description="The message to send to the GPT")
    confirm: bool = Field(
        default=False,
        description=(
            "Every chat_with_gpt call creates a NEW conversation. Set true "
            "when explicit user approval covers this target and action. "
            "Otherwise obtain approval after confirmation_required before "
            "retrying. Existing approval survives reconnects."
        ),
    )


# ═══════════════════════════════════════════════════════════════
# Tool Name Enum — prevents typos (official pattern from mcp-server-git)
# ═══════════════════════════════════════════════════════════════


class ToolName(str, Enum):
    RUNTIME_INFO = "runtime_info"
    # Core chat
    CHAT_COMPLETION = "chat_completion"
    # Discovery
    LIST_MODELS = "list_models"
    LIST_PROJECTS = "list_projects"
    LIST_GPTS = "list_gpts"
    # Conversations
    GET_CONVERSATION = "get_conversation"
    LIST_CONVERSATIONS = "list_conversations"
    WAIT_REPLY = "wait_reply"
    DELETE_CONVERSATION = "delete_conversation"
    ARCHIVE_CONVERSATION = "archive_conversation"
    # Projects
    CREATE_PROJECT = "create_project"
    UPDATE_PROJECT_INSTRUCTIONS = "update_project_instructions"
    DELETE_PROJECT = "delete_project"
    LIST_PROJECT_FILES = "list_project_files"
    # Memory
    LIST_MEMORIES = "list_memories"
    CREATE_MEMORY = "create_memory"
    DELETE_MEMORY = "delete_memory"
    # Custom GPTs
    CHAT_WITH_GPT = "chat_with_gpt"


# ═══════════════════════════════════════════════════════════════
# Output Schemas — structured output validation (Memory server pattern)
# ═══════════════════════════════════════════════════════════════

CHAT_COMPLETION_OUTPUT = {
    "type": "object",
    "properties": {
        "content": {"type": "string", "description": "The assistant response text"},
        "model": {"type": "string", "description": "Selected model slug, or auto when no explicit selection was requested; not an attestation of the backend's resolved model"},
        "requested_model": {"type": "string"},
        "model_selection_verified": {"type": "boolean"},
        "delivery_receipt": {
            "type": "object",
            "description": "Submission evidence for this call; acknowledgement is not reply completion.",
            "properties": {
                "delivery_stage": {"type": "string"},
                "conversation_id": {"type": ["string", "null"]},
                "user_message_id": {"type": ["string", "null"]},
                "reply_persisted": {"type": ["boolean", "null"]},
            },
        },
        "conversation_id": {
            "type": "string",
            "description": "UUID of the conversation for multi-turn follow-up",
        },
        "reply_persisted": {
            "type": ["boolean", "null"],
            "description": (
                "Post-send tail check: true = the assistant reply persisted "
                "to the conversation; false/null = not verified. Missing "
                "persistence is not proof of a dead generation or permission "
                "to resend. Consume content already returned before reading again."
            ),
        },
    },
    "required": ["content", "model", "conversation_id"],
}

MODEL_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Model slug for use in chat_completion"},
        "title": {"type": "string", "description": "Human-readable model name"},
    },
    "required": ["id", "title"],
}

LIST_MODELS_OUTPUT = {
    "type": "object",
    "properties": {
        "models": {"type": "array", "items": MODEL_ITEM},
    },
    "required": ["models"],
}

PROJECT_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Project gizmo ID (use as project_id)"},
        "name": {"type": "string"},
        "memory_scope": {
            "type": "string",
            "description": "'project_v2' (dedicated) or 'global' (shared)",
        },
    },
    "required": ["id", "name"],
}

LIST_PROJECTS_OUTPUT = {
    "type": "object",
    "properties": {
        "projects": {"type": "array", "items": PROJECT_ITEM},
    },
    "required": ["projects"],
}

GET_CONVERSATION_OUTPUT = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "messages": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "role": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["role", "content"],
            },
        },
        "offset": {
            "type": ["integer", "null"],
            "description": (
                "Absolute page offset for a backend result. Null means the "
                "result is a DOM tail and its absolute offset is unknown."
            ),
        },
        "limit": {
            "type": "integer",
            "description": "Max messages requested per call (echoed from the request).",
        },
        "total": {
            "type": ["integer", "null"],
            "description": (
                "Total messages in the conversation for a backend result. "
                "Null means a DOM fallback could only observe a rendered tail."
            ),
        },
        "has_more": {
            "type": ["boolean", "null"],
            "description": (
                "Pagination flag for a backend result. Null means pagination "
                "is unavailable for the partial DOM fallback."
            ),
        },
        "reason": {
            "type": "string",
            "description": (
                "Why the result looks the way it does: 'ok' = messages "
                "returned; 'empty' = conversation reachable but no messages "
                "visible (may be transient mid-generation); 'not_found' = "
                "backend 404 (wrong/inaccessible conversation id); "
                "'fetch_failed' = the backend fetch itself errored; "
                "'partial' = a rendered DOM tail was returned without "
                "absolute paging metadata; 'read_throttled' = the backend "
                "read gate is cooling down."
            ),
        },
        "source": {
            "type": "string",
            "description": "'backend' for an authoritative page or 'dom' for a partial rendered tail.",
        },
        "partial": {
            "type": "boolean",
            "description": "True when only a rendered DOM tail was available.",
        },
        "paging_supported": {
            "type": "boolean",
            "description": "False when offset/total/has_more are intentionally unknown.",
        },
        "requested_offset": {
            "type": "integer",
            "description": "The requested offset when a partial DOM result cannot provide an absolute offset.",
        },
        "retry_after": {
            "type": "number",
            "description": "Seconds before retrying after a read throttle.",
        },
        "out_file": {
            "type": "string",
            "description": "Absolute path the page was written to (only when requested).",
        },
        "messages_written": {
            "type": "integer",
            "description": "How many messages were written to out_file.",
        },
    },
    "required": ["id", "total", "has_more"],
}

WAIT_REPLY_OUTPUT = {
    "type": "object",
    "properties": {
        "conversation_id": {"type": "string"},
        "status": {
            "type": "string",
            "description": (
                "'replied' = an assistant reply FINISHED generating (terminal "
                "backend or DOM status); 'timeout' = deadline hit first; "
                "'dead' = the backend explicitly reported a terminal failure; "
                "'read_throttled' = the read gate rejected the probe. A user "
                "tail alone never produces 'dead'; callers must treat an "
                "unresolved timeout as unknown and inspect the web UI before "
                "sending another message."
            ),
        },
        "total": {
            "type": ["integer", "null"],
            "description": (
                "Message count observed on the last poll; with source='dom' "
                "this is a rendered lower bound, and null means no read "
                "completed."
            ),
        },
        "last_role": {
            "type": ["string", "null"],
            "description": "Role of the last stored message on the final poll.",
        },
        "tail_status": {
            "type": ["string", "null"],
            "description": (
                "Backend status of the tail assistant message on the final "
                "poll ('in_progress', 'finished_successfully', …; null when "
                "the tail is not an assistant message or the payload carries "
                "no status). On 'timeout', 'in_progress' means the web side "
                "is STILL generating — call wait_reply again, do NOT nudge."
            ),
        },
        "source": {
            "type": "string",
            "description": "'backend' or 'dom', whichever supplied the final observation.",
        },
        "total_kind": {
            "type": "string",
            "description": "'absolute' for backend totals or 'rendered_lower_bound' for DOM totals.",
        },
        "observation": {
            "type": ["string", "null"],
            "description": "Why a timeout is unresolved, when no terminal generation evidence was observed.",
        },
        "waited_s": {"type": "number", "description": "Seconds actually waited."},
    },
    "required": ["conversation_id", "status", "total", "waited_s"],
}

CONVERSATION_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Conversation UUID"},
        "title": {"type": "string"},
        # ChatGPT's /backend-api/conversations emits update_time as an ISO-8601
        # string (e.g. "2026-06-26T15:38:05.162163Z"); some fixtures/older
        # payloads use epoch seconds. Accept both plus null/missing so MCP
        # structured-output validation does not reject real backend data.
        "update_time": {
            "type": ["number", "string", "null"],
            "description": "Backend update timestamp; may be epoch seconds or ISO-8601 string",
        },
        "gizmo_id": {
            # Handler emits None for conversations with no project; accept null
            # alongside the string id so MCP output validation matches reality.
            "type": ["string", "null"],
            "description": "Project ID if conversation belongs to a project, null otherwise",
        },
    },
    "required": ["id", "title"],
}

LIST_CONVERSATIONS_OUTPUT = {
    "type": "object",
    "properties": {
        "conversations": {"type": "array", "items": CONVERSATION_ITEM},
    },
    "required": ["conversations"],
}

DELETE_RESULT_OUTPUT = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "conversation_id": {"type": "string"},
    },
    "required": ["success", "conversation_id"],
}

# Distinct from DELETE_RESULT_OUTPUT: delete_memory returns memory_id,
# not conversation_id. Previously the two shared a schema, which made
# every delete_memory call fail MCP output validation.
DELETE_MEMORY_RESULT_OUTPUT = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "memory_id": {"type": "string"},
    },
    "required": ["success", "memory_id"],
}

DELETE_PROJECT_RESULT_OUTPUT = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "project_id": {"type": "string"},
    },
    "required": ["success", "project_id"],
}

CREATE_PROJECT_OUTPUT = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "New project gizmo ID"},
        "name": {"type": "string"},
        "memory_scope": {"type": "string"},
        "instructions": {"type": "string"},
    },
    "required": ["id", "name"],
}

UPDATE_INSTRUCTIONS_OUTPUT = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "project_id": {"type": "string"},
    },
    "required": ["success", "project_id"],
}

ARCHIVE_RESULT_OUTPUT = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "conversation_id": {"type": "string"},
        "archived": {"type": "boolean"},
    },
    "required": ["success", "conversation_id", "archived"],
}

MEMORY_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "content": {"type": "string"},
        "created_at": {"type": "string"},
    },
    "required": ["id", "content"],
}

LIST_MEMORIES_OUTPUT = {
    "type": "object",
    "properties": {
        "memories": {"type": "array", "items": MEMORY_ITEM},
    },
    "required": ["memories"],
}

CREATE_MEMORY_OUTPUT = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "content": {"type": "string"},
    },
    "required": ["content"],
}

GPT_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": ["id", "name"],
}

LIST_GPTS_OUTPUT = {
    "type": "object",
    "properties": {
        "gpts": {"type": "array", "items": GPT_ITEM},
    },
    "required": ["gpts"],
}

PROJECT_FILE_ITEM = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "size": {"type": "number"},
        "mime_type": {"type": "string"},
    },
    "required": ["id", "name"],
}

LIST_PROJECT_FILES_OUTPUT = {
    "type": "object",
    "properties": {
        "files": {"type": "array", "items": PROJECT_FILE_ITEM},
        "project_id": {"type": "string"},
    },
    "required": ["files", "project_id"],
}


# ═══════════════════════════════════════════════════════════════
# Access Control — graduated gating (modeled on hermes-gpt)
# ═══════════════════════════════════════════════════════════════
#
# Three risk tiers:
#   SAFE         — reads + core chat. Always visible. This is the
#                  out-of-box surface; the primary use case works
#                  without any configuration.
#   WRITE gated  — account mutation (create/alter projects, memories,
#                  conversations). Hidden from list_tools unless
#                  W2A_ENABLE_WRITE=1.
#   DESTRUCTIVE  — irreversible deletes. Hidden unless
#                  W2A_ENABLE_DESTRUCTIVE=1.
#
# Hidden tools are also refused at call time (defense-in-depth):
# a client that calls a tool by name without it being listed still
# gets a PermissionError, not silent execution.

WRITE_ENV = "W2A_ENABLE_WRITE"
DESTRUCTIVE_ENV = "W2A_ENABLE_DESTRUCTIVE"

# Tools requiring W2A_ENABLE_WRITE=1 to be visible/callable
_WRITE_GATED_TOOLS = frozenset(
    {
        ToolName.CREATE_PROJECT.value,
        ToolName.UPDATE_PROJECT_INSTRUCTIONS.value,
        ToolName.CREATE_MEMORY.value,
        ToolName.ARCHIVE_CONVERSATION.value,
    }
)

# Tools requiring W2A_ENABLE_DESTRUCTIVE=1 (irreversible account changes)
_DESTRUCTIVE_TOOLS = frozenset(
    {
        ToolName.DELETE_CONVERSATION.value,
        ToolName.DELETE_MEMORY.value,
        ToolName.DELETE_PROJECT.value,
    }
)

# Auth metadata advertised to clients. When api_keys is empty the
# server genuinely has no authentication — saying so lets MCP clients
# (ChatGPT, Claude Desktop) configure their connector correctly.
NOAUTH_META = {"securitySchemes": [{"type": "noauth"}]}


def _env_enabled(name: str) -> bool:
    return os.environ.get(name) == "1"


def tool_meta(extra: dict | None = None) -> dict:
    """Return auth metadata, optionally merged with extras."""
    meta = dict(NOAUTH_META)
    if extra:
        meta.update(extra)
    return meta


def is_loopback_host(host: str) -> bool:
    return host in {"127.0.0.1", "localhost", "::1"}


def warn_non_loopback(host: str, transport: str) -> None:
    """Warn when a no-auth server binds to a non-loopback address.

    The MCP server has no authentication of its own — any reachable host
    can invoke exposed tools. Binding off loopback without configuring
    ``api_keys`` exposes those tools to the network, so we surface that
    loudly. Suppressed when the operator has set API keys.
    """
    if is_loopback_host(host):
        return
    if _config is not None and _config.server.api_keys:
        return  # operator has added authentication
    logger.warning(
        "%s transport bound to %s with no authentication. Exposed tools "
        "are reachable from the network. Bind to 127.0.0.1 or set api_keys.",
        transport,
        host,
    )


def _tool_gate_env(tool_name: str) -> str | None:
    """Return the env var gating this tool, or None if always visible."""
    if tool_name in _DESTRUCTIVE_TOOLS:
        return DESTRUCTIVE_ENV
    if tool_name in _WRITE_GATED_TOOLS:
        return WRITE_ENV
    return None


def _visible_tool_names() -> set[str]:
    """Tool names visible given the current environment."""
    visible = set()
    for member in ToolName:
        gate = _tool_gate_env(member.value)
        if gate is None or _env_enabled(gate):
            visible.add(member.value)
    return visible


# ═══════════════════════════════════════════════════════════════
# Global State
# ═══════════════════════════════════════════════════════════════

_driver: CDPDriver | None = None
# B1: MCP session-affine driver pool. When non-None, the pool owns driver
# lifecycle; _driver is None and _breakers is None. Each MCP session gets
# its own owned CDPDriver/tab on demand (lazy materialization).
_driver_pool = None  # McpSessionDriverPool | None; set in run_mcp when pool enabled
_config: Config | None = None
# Phase 4 PR2: per-process breaker registry (MCP-local). MCP has no
# ChromeProcess, so CHROME_CRASH_LOOP is never tripped here. Auth/composer/CDP
# failures on MCP's own driver DO record into this registry. None until
# run_mcp() sets it. No cross-process propagation to/from REST.
_breakers: BreakerRegistry | None = None
# Cross-process lock factory — creates a fresh CrossProcessLock per critical
# section, keyed on the CDP port so all processes sharing a Chrome instance
# serialize. None until run_mcp() sets it. Read-only tools run lock-free.
_lock_cdp_port: int | None = None
# PR4/5: parallel-tabs flag (mirrors _lock_cdp_port's lifecycle — set in run_mcp).
_parallel_tabs: bool = False
# B1: the MCP transport ("sse" or "stdio"), set in run_mcp.
_transport: str = "stdio"

# Tools that mutate browser state — must hold the lock
_MUTATING_TOOLS = frozenset(
    {
        ToolName.CHAT_COMPLETION.value,
        ToolName.CHAT_WITH_GPT.value,
        ToolName.DELETE_CONVERSATION.value,
        ToolName.CREATE_PROJECT.value,
        ToolName.UPDATE_PROJECT_INSTRUCTIONS.value,
        ToolName.DELETE_PROJECT.value,
        ToolName.ARCHIVE_CONVERSATION.value,
        ToolName.CREATE_MEMORY.value,
        ToolName.DELETE_MEMORY.value,
    }
)
_CHAT_TOOL_NAMES = frozenset({
    ToolName.CHAT_COMPLETION.value, ToolName.CHAT_WITH_GPT.value,
    ToolName.CREATE_MEMORY.value,
})


# ═══════════════════════════════════════════════════════════════
# Business Logic — pure functions (official pattern from mcp-server-git)
# ═══════════════════════════════════════════════════════════════


async def _notify(on_progress: ProgressCallback | None, message: str) -> None:
    """Invoke a progress callback if present, swallowing any error.

    Defense-in-depth: even if the caller hands us a raw (non-helper-built)
    callback that raises on a transport blip, we must never abort the tool
    call — a dropped notification is not worth killing a 40s generation.
    The helper-built _cb already guards internally; this wraps every call
    site so the contract holds regardless of callback provenance.
    """
    if on_progress is None:
        return
    try:
        await on_progress(message)
    except Exception:
        logger.debug("progress notification dropped", exc_info=True)


def _delivery_receipt(driver: CDPDriver) -> dict:
    metadata = getattr(driver, "delivery_metadata", None)
    if isinstance(metadata, dict):
        return dict(metadata)
    return {"delivery_stage": "unknown", "conversation_id": None, "user_message_id": None}


async def do_chat_completion(
    driver: CDPDriver,
    args: dict,
    config: Config,
    on_progress: ProgressCallback | None = None,
    session_key: str | None = None,
) -> dict:
    """Execute a chat completion through the CDP driver."""
    validated = ChatCompletionInput(**args)
    await _notify(on_progress, "Resolving conversation target…")
    project_id = validated.project_id or (config.chatgpt.default_project_id if config else None)
    if project_id:
        # Name-or-id: resolve "REDACTED" → its gizmo id, or raise so a wrong
        # project can never be silently selected.
        project_id = await driver.resolve_project_id(project_id)

    # Build the full text with optional system prompt
    if validated.system_prompt:
        full_text = (
            f"[System Instructions]\n{validated.system_prompt}\n\n[User]\n{validated.message}"
        )
    else:
        full_text = validated.message

    # Route to the send target. Shared with the REST path via
    # driver.route_chat_target: an explicit conversation_id ALWAYS continues
    # that conversation — project_id only scopes NEW conversations and must
    # never veto an explicit target (2026-09-17 misroute: conv-affine tab +
    # project_id fell through to navigate_new_chat and spawned fresh convs).
    route = await driver.route_chat_target(
        conversation_id=validated.conversation_id,
        project_id=project_id,
        # MCP auto-continue heuristic: same session, no new context.
        auto_continue=bool(
            driver._current_conv_id
            and not validated.system_prompt
            and not project_id
        ),
    )
    if route == "auto-continue":
        logger.info("Auto-continuing conversation: %s", driver._current_conv_id)

    # Conversation-binding gate: EVERY first send that binds this session
    # to a conversation must be confirmed by the human user — existing convs
    # return project + title + occupant warning; fresh chats return
    # is_new_conversation + the project label. Unconfirmed sends into a conv
    # another session uses would silently hijack it — and a mid-flight send
    # kills the streaming reply.
    target_conv = validated.conversation_id or (
        driver._current_conv_id if route == "auto-continue" else None
    )
    binding_gate = await conv_binding.gate_check(
        driver,
        target_conv,
        session_key,
        confirmed=validated.confirm,
        project_label=validated.project_id or project_id,
    )
    if binding_gate is not None:
        return binding_gate

    # Navigation can reset the picker. Select only on the final target, and
    # never silently substitute an explicitly requested model.
    model_selection_verified = False
    if validated.model and validated.model != "auto":
        from .cdp_driver import ModelSelectionError

        await _notify(on_progress, "Selecting requested model…")
        if await driver.select_model(validated.model) is not True:
            raise ModelSelectionError(validated.model)
        model_selection_verified = True

    # Send and collect response. Progress notifications reset the MCP client's
    # idle timer during long generations so the tool call isn't killed at
    # ~30s. on_progress is None when the client can't receive progress.
    # NOTE: across a rate-limit retry ChatGPT re-types and re-streams the
    # response from scratch, so the message may visually "reset" even though
    # the numeric progress counter keeps climbing — see _make_progress_callback.
    full_response = ""
    conv_id = ""
    chunk_count = 0
    # P1: resolve model-aware detector budgets from config. Guard against
    # config=None (some test paths) by falling back to legacy behavior.
    from .completion_detector import DetectorBudgets

    _budgets = (
        DetectorBudgets.from_config(config.chatgpt, validated.model)
        if config is not None
        else None
    )
    async for chunk in driver.send_and_stream(
        full_text, timeout=120, budgets=_budgets, model=validated.model,
        on_progress=on_progress,
    ):
        if chunk.delta:
            full_response += chunk.delta
            chunk_count += 1
            if chunk_count == 1:
                await _notify(on_progress, "Assistant is responding…")
            elif chunk_count % _PROGRESS_EVERY_N_CHUNKS == 0:
                await _notify(on_progress, f"Streaming… {len(full_response)} chars")
        if chunk.finish_reason:
            conv_id = driver._current_conv_id or ""
            await _notify(on_progress, "Finalizing…")

    # Dead-generation check: the streamed response can look complete locally
    # while the reply never persisted server-side (mid-stream death/retract).
    await _notify(on_progress, "Verifying reply persisted…")
    persisted = await _verify_reply_persisted(
        driver,
        conv_id,
        sent_text=full_text,
    )

    # Bind this session to the conversation it just sent into — covers new
    # conversations (no conv_id existed at gate-check time) and refreshes
    # the heartbeat for already-bound ones.
    if conv_id and session_key:
        conv_binding.claim(conv_id, session_key)

    return {
        "content": full_response,
        "model": validated.model,
        "requested_model": validated.model,
        "model_selection_verified": model_selection_verified,
        "delivery_receipt": _delivery_receipt(driver),
        "conversation_id": conv_id,
        "reply_persisted": persisted,
    }


async def do_list_models(driver: CDPDriver) -> dict:
    """List available models."""
    models = await driver.get_models()
    return {
        "models": [{"id": m.get("slug", ""), "title": m.get("title", "")} for m in models],
    }


async def do_list_projects(driver: CDPDriver) -> dict:
    """List available projects."""
    projects = await driver.get_projects()
    return {
        "projects": [
            {
                "id": p.get("id", ""),
                "name": p.get("name", "Unknown"),
                "memory_scope": p.get("memory_scope", "project_v2"),
            }
            for p in projects
            if p.get("id")
        ],
    }


def _conversation_chain(data: dict, *, with_meta: bool = False) -> list[dict]:
    """Walk the backend mapping tree from current_node backwards →
    oldest-first [{role, content}] of user/assistant messages.

    Returns [] when the payload carries no mapping (failed/404/empty fetches
    all collapse here — callers distinguish them via the _fetch_* annotations
    backend_client stamps on the result).

    With ``with_meta=True`` each entry also carries the node's raw ``status``
    and ``end_turn`` fields — internal use only (wait_reply's terminal-
    generation gate); get_conversation output keeps the {role, content}
    shape.
    """
    mapping = data.get("mapping") or {}
    node_id = data.get("current_node")
    chain = []
    visited = set()
    while node_id and node_id not in visited:
        visited.add(node_id)
        node_data = mapping.get(node_id, {})
        msg = node_data.get("message")
        if msg and msg.get("content"):
            role = msg.get("author", {}).get("role", "unknown")
            parts = msg.get("content", {}).get("parts", [])
            text = " ".join(p for p in parts if isinstance(p, str))
            if text and role in ("user", "assistant"):
                entry = {"role": role, "content": text}
                if with_meta:
                    entry["status"] = msg.get("status")
                    entry["end_turn"] = msg.get("end_turn")
                chain.append(entry)
        node_id = node_data.get("parent")
    chain.reverse()
    return chain


def _conversation_nodes(data: dict) -> list[dict]:
    """Return the current mapping chain with backend node ids retained."""
    mapping = data.get("mapping") or {}
    node_id = data.get("current_node")
    chain: list[dict] = []
    visited = set()
    while node_id and node_id not in visited:
        visited.add(node_id)
        node_data = mapping.get(node_id, {})
        msg = node_data.get("message") or {}
        content = msg.get("content") or {}
        parts = content.get("parts", [])
        text = " ".join(p for p in parts if isinstance(p, str))
        role = (msg.get("author") or {}).get("role")
        if text and role in ("user", "assistant"):
            chain.append({
                "node_id": node_id,
                "role": role,
                "content": text,
                "status": msg.get("status"),
                "end_turn": msg.get("end_turn"),
            })
        node_id = node_data.get("parent")
    chain.reverse()
    return chain


def _tail_reply_finished(entry: dict) -> bool:
    """Did the tail assistant message FINISH generating?

    The backend marks a live-streaming node ``status='in_progress'`` (with
    ``end_turn`` unset/false) and flips to a ``finished_*`` status once the
    turn completes. Node existence alone is NOT completion — field-observed
    2026-09-15: wait_reply reported 'replied' on a still-streaming intro
    node and the caller consumed a partial reply, then misdiagnosed a live
    generation as dead. Payloads carrying no signal at all (mocks, stripped
    fixtures) keep the legacy exists-is-done behavior.
    """
    status = entry.get("status")
    if status is not None:
        return status != "in_progress"
    if entry.get("end_turn") is not None:
        return bool(entry["end_turn"])
    return True


_GENERATION_FAILURE_STATUSES = frozenset({
    "failed",
    "error",
    "errored",
    "cancelled",
    "canceled",
    "aborted",
    "rejected",
})


def _explicit_generation_failure(data: dict, tail: dict) -> bool:
    """Return True only for a field that explicitly names a failed turn."""
    candidates = [
        tail.get("status"),
        data.get("generation_status"),
        data.get("turn_status"),
        data.get("status") if data.get("status") != data.get("_fetch_status") else None,
    ]
    return any(
        isinstance(value, str)
        and value.strip().lower() in _GENERATION_FAILURE_STATUSES
        for value in candidates
    )


# Post-send persistence-check timings. The stream/reconciliation path already
# waits for the current turn; this check is a bounded diagnostic, not a second
# polling loop. Keep the names patchable for offline tests/back-compat.
_PERSIST_MAX_CHECKS = 1
_PERSIST_TOTAL_TIMEOUT_S = 8.0
_PERSIST_TAIL_USER_DELAY_S = 0.0
_PERSIST_EMPTY_DELAY_S = 0.0

# Conversation-read coalescing. Every get_conversation poll hits
# /backend-api/conversation/{id} — the endpoint family behind ChatGPT's
# "限制访问对话记录" limiter, which can 429 on a single request once the
# account is flagged. Multiple waiters across pool slots (wait_reply,
# get_conversation, post-send checks) used to each issue their own fetch.
# A single-flight map plus a cache whose TTL equals the read pace interval
# collapses the duplicates: the pace gate could not have produced fresher
# data anyway. Verification paths that require current truth (reply
# persistence) bypass via _verify_reply_persisted's direct fetch.
_CONV_READ_CACHE: dict[str, tuple[float, dict]] = {}
_CONV_READ_INFLIGHT: dict[str, "_ConvReadFlight"] = {}

# ``CDPDriver.get_conversation`` has its own 30s browser-evaluation timeout,
# but the single-flight wrapper also waits for the per-slot lock and the shared
# pace gate. Keep that whole operation bounded independently of any one
# caller's deadline. A caller with a shorter deadline times out its own wait;
# another subscriber may continue using the same bounded fetch.
_CONV_READ_FETCH_TIMEOUT_S = 35.0


class _ConvReadFlight:
    """One shared conversation fetch and its active subscribers.

    ``asyncio.shield`` keeps a cancelled waiter from cancelling a fetch that
    another waiter still needs. The waiter count lets the last subscriber
    cancel the task, so a forgotten/aborted MCP request cannot leave a lock or
    browser evaluation running indefinitely.
    """

    __slots__ = ("task", "waiters", "fresh")

    def __init__(self, task: asyncio.Task, *, fresh: bool = False) -> None:
        self.task = task
        self.waiters = 0
        self.fresh = fresh


def _conv_read_ttl(driver: CDPDriver) -> float:
    return max(1.0, getattr(getattr(driver, "_pace", None), "read_interval", 0.0) or 8.0)


def _conv_read_cacheable(payload) -> bool:
    return isinstance(payload, dict) and not payload.get("_fetch_error") and not (
        isinstance(payload.get("_fetch_status"), int) and payload["_fetch_status"] >= 400
    )


def _conv_read_store(driver: CDPDriver, conv_id: str, payload) -> None:
    if _conv_read_cacheable(payload):
        _CONV_READ_CACHE[conv_id] = (time.monotonic() + _conv_read_ttl(driver), payload)


def _conv_read_invalidate(conv_id: str) -> None:
    _CONV_READ_CACHE.pop(conv_id, None)


async def _conv_read_coalesced(
    driver: CDPDriver,
    conv_id: str,
    lock_cm,
    *,
    fresh: bool = False,
    timeout: float | None = None,
) -> dict:
    """get_conversation with cross-slot dedup.

    Cache hit → return immediately unless ``fresh`` is requested. A peer
    fetch already in flight → join it via shield, WITHOUT touching lock_cm,
    so a waiter never holds the slot lock while a leader sits in the shared
    pace queue. Only a cache-miss leader takes lock_cm around the real fetch.

    Each subscriber has its own timeout. The shared fetch has an independent
    hard cap, and the last subscriber to cancel/timeout cancels that fetch.
    """
    hit = _CONV_READ_CACHE.get(conv_id)
    if not fresh and hit and hit[0] > time.monotonic():
        return hit[1]

    flight = _CONV_READ_INFLIGHT.get(conv_id)
    if fresh and flight is not None and not flight.fresh:
        # A fresh post-send check must not join a normal fetch that may have
        # started before the send. Keep that older flight alive for its own
        # subscribers, but install a separate fresh flight below; callbacks
        # use identity checks so they cannot remove the replacement.
        flight = None
    if flight is not None and flight.task.done():
        # Done callbacks normally remove completed flights, but a caller can
        # arrive in the small callback scheduling window. Never join a stale
        # completed task when a fresh fetch is requested.
        if _CONV_READ_INFLIGHT.get(conv_id) is flight:
            del _CONV_READ_INFLIGHT[conv_id]
        flight = None

    if flight is None:
        async def _lead():
            async with lock_cm:
                return await driver.get_conversation(conv_id)

        task = asyncio.ensure_future(
            asyncio.wait_for(_lead(), _CONV_READ_FETCH_TIMEOUT_S)
        )
        flight = _ConvReadFlight(task, fresh=fresh)
        _CONV_READ_INFLIGHT[conv_id] = flight

        def _store(t: asyncio.Task, cid: str = conv_id, f: _ConvReadFlight = flight) -> None:
            if _CONV_READ_INFLIGHT.get(cid) is not f:
                # A fresh recovery read replaced this flight; an older
                # response must not overwrite the fresh cache entry.
                return
            del _CONV_READ_INFLIGHT[cid]
            try:
                _conv_read_store(driver, cid, t.result())
            except BaseException:
                pass

        task.add_done_callback(_store)

    flight.waiters += 1
    try:
        if timeout is None:
            return await asyncio.shield(flight.task)
        remaining = max(0.0, float(timeout))
        if remaining <= 0:
            raise asyncio.TimeoutError
        return await asyncio.wait_for(asyncio.shield(flight.task), remaining)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        # A waiter timing out is not allowed to cancel a peer's fetch. Once
        # the final subscriber leaves, cancel it so the lock/driver operation
        # is released promptly.
        raise
    finally:
        flight.waiters = max(0, flight.waiters - 1)
        if (
            flight.waiters == 0
            and not flight.task.done()
        ):
            if _CONV_READ_INFLIGHT.get(conv_id) is flight:
                del _CONV_READ_INFLIGHT[conv_id]
            flight.task.cancel()


async def _await_until(awaitable, deadline: float | None):
    """Await one read/DOM operation without exceeding an absolute deadline."""
    if deadline is None:
        return await awaitable
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        # Close coroutine objects that were created before the deadline check;
        # otherwise direct callers get a ``coroutine was never awaited``
        # warning when a wait expires between polls.
        close = getattr(awaitable, "close", None)
        if close is not None:
            close()
        raise asyncio.TimeoutError
    return await asyncio.wait_for(awaitable, remaining)


async def _sleep_until(delay: float, deadline: float | None) -> None:
    """Sleep for at most ``delay`` while respecting an absolute deadline."""
    if deadline is None:
        await asyncio.sleep(delay)
        return
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise asyncio.TimeoutError
    await asyncio.sleep(min(delay, remaining))


async def _verify_reply_persisted(
    driver: CDPDriver,
    conv_id: str | None,
    *,
    deadline: float | None = None,
    sent_text: str | None = None,
    user_message_id: str | None = None,
) -> bool | None:
    """Post-send tail check: did the assistant reply actually persist?

    The DOM stream can return a partial/corrupt response for a generation
    that dies mid-stream and is then retracted server-side — the reply never
    lands in the conversation. This is one bounded best-effort observation,
    keyed to the current sent user node/text when available. It must never
    treat an unrelated old assistant tail as proof for the current send.

    Returns True only when the current turn's anchor is followed by a
    persisted assistant, False only when that anchored turn explicitly reports
    a terminal failure, and None when the anchor/read is unavailable.
    """
    if not conv_id:
        return None
    metadata = getattr(driver, "delivery_metadata", None)
    if isinstance(metadata, dict):
        # The send path may already have completed an anchored reconciliation.
        # Consume that receipt before opening another backend read; it is
        # scoped to the current send and cannot be an old tail.
        if metadata.get("reply_persisted") is True:
            return True
        if user_message_id is None:
            user_message_id = metadata.get("user_message_id") or None
    # A text-only match can collide with an earlier repeated prompt (for
    # example, several turns containing "继续"). Without the current-turn
    # identity captured by the send path, remain unknown and avoid a needless
    # post-send read that could incorrectly certify an old assistant tail.
    if not user_message_id:
        return None

    # The send just mutated this conversation — a pre-send cache entry must
    # never satisfy this check, and each fresh result is the newest truth for
    # any coalesced waiter.
    _conv_read_invalidate(conv_id)
    verify_deadline = time.monotonic() + _PERSIST_TOTAL_TIMEOUT_S
    if deadline is not None:
        verify_deadline = min(verify_deadline, deadline)
    try:
        data = await _conv_read_coalesced(
            driver,
            conv_id,
            contextlib.nullcontext(),
            fresh=True,
            timeout=max(0.0, verify_deadline - time.monotonic()),
        )
    except asyncio.TimeoutError:
        return None
    except ReadThrottledError:
        # The DOM has no stable backend node id. Even with a captured UUID,
        # falling back to a same-text DOM match could select a repeated older
        # prompt, so leave this receipt unknown while the backend is gated.
        return None
    except Exception:
        # A failed/ambiguous check must never turn a successful send into an
        # exception or a retry signal.
        return None

    if not isinstance(data, dict):
        return None
    _conv_read_store(driver, conv_id, data)
    nodes = _conversation_nodes(data)
    if not nodes:
        return None

    anchor_index = -1
    if user_message_id:
        anchor_index = next(
            (
                i for i, node in enumerate(nodes)
                if node.get("node_id") == user_message_id
            ),
            -1,
        )
    if anchor_index < 0:
        return None

    tail = nodes[-1]
    if tail.get("role") == "assistant" and anchor_index < len(nodes) - 1:
        # A streaming assistant node is persisted but not a finished reply.
        return True if _tail_reply_finished(tail) else None
    if (
        tail.get("role") == "user"
        and anchor_index == len(nodes) - 1
        and _explicit_generation_failure(data, tail)
    ):
        return False
    return None


async def do_get_conversation(
    driver: CDPDriver,
    args: dict,
    call_lock: asyncio.Lock | None = None,
) -> dict:
    """Retrieve conversation history (paginated, oldest-first)."""
    validated = GetConversationInput(**args)
    if validated.tail is not None and validated.offset:
        raise ValueError("tail cannot be combined with a non-zero offset")
    fetch_lock = call_lock if call_lock is not None else contextlib.nullcontext()
    try:
        data = await _conv_read_coalesced(
            driver,
            validated.conversation_id,
            fetch_lock,
            fresh=validated.fresh,
        )
    except ReadThrottledError as e:
        # DOM fallback: if a tab is showing this conversation, its rendered
        # messages are free even while the backend read endpoint is in a
        # 429 cooldown. Partial by nature (virtualized history) — marked so.
        msgs = await conv_dom_read.conv_messages(
            getattr(driver, "port", 0) or 0,
            validated.conversation_id,
            limit=validated.tail or validated.limit,
        )
        if msgs is not None:
            # The DOM only exposes rendered nodes (often a virtualized tail),
            # so it cannot truthfully answer absolute offset/total/has_more.
            # Keep those fields null and carry the requested offset
            # separately; callers must not page by repeatedly adding limit.
            result = {
                "id": validated.conversation_id,
                "title": "",
                "offset": None,
                "limit": validated.tail or validated.limit,
                "total": None,
                "has_more": None,
                "reason": "partial",
                "source": "dom",
                "partial": True,
                "paging_supported": False,
                "requested_offset": validated.offset,
            }
            _write_messages_result(result, msgs, validated.out_file)
            return result
        result = {
            "id": validated.conversation_id,
            "title": "",
            "offset": None,
            "limit": validated.limit,
            "total": None,
            "has_more": None,
            "reason": "read_throttled",
            "retry_after": round(e.retry_after, 1),
            "source": "backend",
            "partial": False,
            "paging_supported": False,
            "requested_offset": validated.offset,
        }
        _write_messages_result(result, [], validated.out_file)
        return result
    chain = _conversation_chain(data)

    # Why the result looks the way it does — previously 404s, fetch errors
    # and genuinely-empty conversations all surfaced as identical {[], 0}.
    if data.get("_fetch_error"):
        reason = "fetch_failed"
    elif data.get("_fetch_status") == 404:
        reason = "not_found"
    elif isinstance(data.get("_fetch_status"), int) and data["_fetch_status"] >= 400:
        reason = "fetch_failed"
    elif not chain:
        reason = "empty"
    else:
        reason = "ok"

    total = len(chain)
    if validated.tail is not None:
        # Tail reads intentionally still report the authoritative total from
        # the same backend response, but the returned page is described by its
        # computed absolute offset. This replaces the common two-call
        # ``total`` then ``offset=total-N`` pattern.
        page = chain[-validated.tail :]
        page_offset = max(0, total - len(page))
        page_limit = validated.tail
    else:
        page = chain[validated.offset : validated.offset + validated.limit]
        page_offset = validated.offset
        page_limit = validated.limit
    result = {
        "id": data.get("id", validated.conversation_id),
        "title": data.get("title", ""),
        "offset": page_offset,
        "limit": page_limit,
        "total": total,
        "has_more": page_offset + len(page) < total,
        "reason": reason,
        "source": "backend",
        "partial": False,
        "paging_supported": True,
    }
    _write_messages_result(result, page, validated.out_file)
    return result


def _write_messages_result(result: dict, messages: list[dict], out_file: str | None) -> None:
    """Attach messages inline or write them to the requested absolute path."""
    if out_file:
        p = Path(out_file)
        if not p.is_absolute():
            raise ValueError("out_file must be an absolute path")
        p.parent.mkdir(parents=True, exist_ok=True)
        text = "".join(f"## {m['role']}\n\n{m['content']}\n\n" for m in messages)
        p.write_text(text, encoding="utf-8")
        result["out_file"] = str(p)
        result["messages_written"] = len(messages)
    else:
        result["messages"] = messages


async def do_wait_reply(
    driver: CDPDriver,
    args: dict,
    on_progress: ProgressCallback | None = None,
    call_lock: asyncio.Lock | None = None,
) -> dict:
    """Block until an assistant reply persists (or the deadline hits).

    Replaces hand-rolled get_conversation+sleep polling: the failure mode it
    prevents is consuming a partial assistant node as a finished reply. A
    user tail is only an observation: without an explicit terminal failure it
    remains unresolved and eventually returns ``timeout``. This avoids turning
    a slow/live generation into a duplicate nudge.

    ``call_lock`` (pool mode) is the leased slot's per-driver lock: it is held
    only around each fetch, never across the poll sleep, so a wait of up to
    ``timeout_seconds`` does not block the other tools sharing that slot.
    """
    validated = WaitReplyInput(**args)
    deadline = time.monotonic() + validated.timeout_seconds
    start = time.monotonic()
    total: int | None = None
    last_role = None
    tail_status = None
    source = "backend"
    total_kind = "absolute"
    observation: str | None = None
    user_tail_since: float | None = None
    fetch_lock = call_lock if call_lock is not None else contextlib.nullcontext()
    # DOM-mode baseline: "replied" is judged against the tail state at wait
    # start, not absolute backend totals (rendered counts differ).
    baseline_tail_text: str | None = None
    baseline_rendered = 0
    baseline_initialized = False

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            status = "timeout"
            if last_role == "user" and tail_status != "in_progress":
                observation = (
                    "user_tail_unresolved_"
                    + ("generation_signal_unknown" if tail_status is None else tail_status)
                )
            observation = observation or "deadline_exceeded"
            break

        # ``since_total`` is an absolute backend count. Probe the backend
        # first in that mode so a reply that completed before our first DOM
        # baseline cannot be mistaken for an old tail and then wait forever.
        # For ordinary waits, keep the cheap DOM-first path, falling back to
        # the backend only when no conversation tab is available.
        dom = None
        data = None
        backend_throttled: ReadThrottledError | None = None
        backend_first = validated.since_total is not None
        if backend_first:
            try:
                data = await _await_until(
                    _conv_read_coalesced(
                        driver,
                        validated.conversation_id,
                        fetch_lock,
                    ),
                    deadline,
                )
            except ReadThrottledError as e:
                backend_throttled = e
            except asyncio.TimeoutError:
                status = "timeout"
                observation = "backend_read_timeout"
                break
            except Exception:
                data = {}
                observation = "backend_read_failed"

        if not backend_first or backend_throttled is not None:
            # DOM-first for normal waits; for since_total this is a bounded
            # fallback only when the absolute backend read is rate-limited.
            # Its rendered count is never compared with ``since_total``.
            try:
                dom = await _await_until(
                    conv_dom_read.conv_tail_state(
                        getattr(driver, "port", 0) or 0,
                        validated.conversation_id,
                    ),
                    deadline,
                )
            except asyncio.TimeoutError:
                status = "timeout"
                observation = "dom_read_timeout"
                break
            except Exception:
                dom = None

        if dom is not None:
            source = "dom"
            total_kind = "rendered_lower_bound"
            total = dom.get("rendered_total") or 0
            last_role = dom.get("last_role")
            generating = bool(dom.get("generating"))
            tail_text = dom.get("tail_text") or ""
            tail_status = (
                "in_progress"
                if generating
                else ("finished_successfully" if last_role == "assistant" else None)
            )
            if baseline_tail_text is None:
                baseline_tail_text = tail_text
                baseline_rendered = total
                baseline_initialized = True
            # ``since_total`` is a backend absolute count. Rendered DOM nodes
            # are a virtualized lower bound and must never be compared to it.
            # When a baseline is requested, use a same-tab message anchor
            # instead; a mismatch can only cause a safe timeout, never a false
            # replied result.
            dom_anchor_changed = (
                baseline_initialized
                and (
                    total > baseline_rendered
                    or tail_text != baseline_tail_text
                )
            )
            replied = (
                last_role == "assistant"
                and not generating
                and (
                    validated.since_total is None
                    or dom_anchor_changed
                )
            )
            data = None  # no backend payload in DOM mode
            if generating:
                observation = "generation_in_progress"
            elif last_role == "user":
                observation = "user_tail_without_terminal_evidence"
            else:
                observation = None
        else:
            if not backend_first:
                try:
                    data = await _await_until(
                        _conv_read_coalesced(
                            driver,
                            validated.conversation_id,
                            fetch_lock,
                        ),
                        deadline,
                    )
                except ReadThrottledError as e:
                    backend_throttled = e
                except asyncio.TimeoutError:
                    status = "timeout"
                    observation = "backend_read_timeout"
                    break
                except Exception:
                    data = {}
                    observation = "backend_read_failed"
            if backend_throttled is not None:
                # The shared read gate is in cooldown AND no DOM tab was
                # available — surface an actionable signal instead of
                # burning the whole timeout on fetches that cannot run.
                return {
                    "conversation_id": validated.conversation_id,
                    "status": "read_throttled",
                    "retry_after": round(backend_throttled.retry_after, 1),
                    "send_hint": (
                        "a prior send is usually already DELIVERED — do "
                        "NOT resend before checking the conversation tail "
                        "(the cooldown only blocks reads, not generation)"
                    ),
                    "total": total,
                    "last_role": last_role,
                    "tail_status": tail_status,
                    "source": source,
                    "total_kind": total_kind,
                    "observation": "read_throttled",
                    "waited_s": round(time.monotonic() - start, 1),
                }
            chain = (
                _conversation_chain(data, with_meta=True)
                if isinstance(data, dict)
                else []
            )
            total = len(chain)
            tail = chain[-1] if chain else {}
            last_role = tail.get("role")
            tail_status = (
                tail.get("status") if last_role == "assistant" else None
            )
            explicit_failure = (
                isinstance(data, dict)
                and last_role == "user"
                and _explicit_generation_failure(data, tail)
            )
            # 'replied' requires a TERMINAL tail: a persisted assistant node
            # can still be streaming (status='in_progress') — counting it was
            # the 2026-09-15 false-replied incident.
            replied = (
                last_role == "assistant"
                and _tail_reply_finished(tail)
                and (
                    validated.since_total is None
                    or total > validated.since_total
                )
            )
            if last_role == "assistant" and tail_status == "in_progress":
                observation = "generation_in_progress"
            elif last_role == "user":
                observation = "user_tail_without_terminal_evidence"
            elif replied:
                observation = None
            if explicit_failure:
                status = "dead"
                observation = "terminal_generation_failure"
                break
        if replied:
            status = "replied"
            break

        # A user tail used to become ``dead`` after a timer. That was unsafe:
        # the DOM may explicitly report a live generation, and the backend
        # payload does not identify a terminal failure for this turn. Keep the
        # timer only as an observation marker for compatibility and wait until
        # the caller's absolute deadline.
        if last_role == "user":
            user_tail_since = user_tail_since or time.monotonic()
            if (
                validated.dead_after_seconds
                and time.monotonic() - user_tail_since >= validated.dead_after_seconds
            ):
                observation = (
                    "user_tail_unresolved_" +
                    ("generation_signal_unknown" if tail_status is None else tail_status)
                )
        else:
            user_tail_since = None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            status = "timeout"
            if last_role == "user" and tail_status != "in_progress":
                observation = (
                    "user_tail_unresolved_"
                    + ("generation_signal_unknown" if tail_status is None else tail_status)
                )
            break
        try:
            await _await_until(
                _notify(
                    on_progress,
                    f"Waiting for reply… total={total if total is not None else 'unknown'} "
                    f"last={last_role or 'none'}"
                    + (f" ({tail_status})" if tail_status else ""),
                ),
                deadline,
            )
            await _sleep_until(validated.poll_seconds, deadline)
        except asyncio.TimeoutError:
            status = "timeout"
            if last_role == "user" and tail_status != "in_progress":
                observation = (
                    "user_tail_unresolved_"
                    + ("generation_signal_unknown" if tail_status is None else tail_status)
                )
            observation = observation or "deadline_exceeded"
            break

    return {
        "conversation_id": validated.conversation_id,
        "status": status,
        "source": source,
        "total": total,
        "last_role": last_role,
        "tail_status": tail_status,
        "total_kind": total_kind,
        "observation": observation,
        "waited_s": round(time.monotonic() - start, 1),
    }


async def do_list_conversations(driver: CDPDriver, args: dict) -> dict:
    """List recent conversations."""
    validated = ListConversationsInput(**args)
    conversations = await driver.get_conversations(
        offset=validated.offset,
        limit=validated.limit,
    )
    return {
        "conversations": [
            {
                "id": c.get("id", ""),
                "title": c.get("title", "Untitled"),
                "update_time": c.get("update_time"),
                "gizmo_id": c.get("gizmo_id"),
            }
            for c in conversations
        ],
    }


async def do_delete_conversation(driver: CDPDriver, args: dict) -> dict:
    """Delete a conversation."""
    validated = DeleteConversationInput(**args)
    success = await driver.delete_conversation(validated.conversation_id)
    return {
        "success": success,
        "conversation_id": validated.conversation_id,
    }


async def do_create_project(driver: CDPDriver, args: dict) -> dict:
    """Create a new ChatGPT project."""
    validated = CreateProjectInput(**args)
    result = await driver.create_project(
        name=validated.name,
        instructions=validated.instructions,
        memory_scope=validated.memory_scope,
    )
    return result


async def do_delete_project(driver: CDPDriver, args: dict) -> dict:
    """Delete a ChatGPT project."""
    validated = DeleteProjectInput(**args)
    return await driver.delete_project(validated.project_id)


async def do_update_project_instructions(driver: CDPDriver, args: dict) -> dict:
    """Update a project's custom instructions."""
    validated = UpdateProjectInstructionsInput(**args)
    success = await driver.update_project_instructions(
        project_id=validated.project_id,
        instructions=validated.instructions,
    )
    return {
        "success": success,
        "project_id": validated.project_id,
    }


async def do_archive_conversation(driver: CDPDriver, args: dict) -> dict:
    """Archive or unarchive a conversation."""
    validated = ArchiveConversationInput(**args)
    success = await driver.archive_conversation(
        conversation_id=validated.conversation_id,
        archive=validated.archive,
    )
    return {
        "success": success,
        "conversation_id": validated.conversation_id,
        "archived": validated.archive,
    }


async def do_list_memories(driver: CDPDriver) -> dict:
    """List all ChatGPT memories."""
    memories = await driver.get_memories()
    # Normalize memory items
    result = []
    for m in memories:
        if isinstance(m, dict):
            result.append(
                {
                    "id": m.get("id", ""),
                    "content": m.get("content", m.get("text", "")),
                    "created_at": m.get("created_at", ""),
                }
            )
    return {"memories": result}


async def do_create_memory(
    driver: CDPDriver,
    args: dict,
    on_progress: ProgressCallback | None = None,
) -> dict:
    """Create a new ChatGPT memory.

    create_memory drives a short ChatGPT exchange internally (it uses
    send_and_stream), so it accepts the same on_progress hook for parity.
    The response is usually one sentence, so the hook rarely fires here —
    but if it does, it keeps a slow confirmation from tripping the client
    timeout just like a full chat_completion.
    """
    validated = CreateMemoryInput(**args)
    await _notify(on_progress, "Creating memory…")
    result = await driver.create_memory(content=validated.content)
    return result


async def do_delete_memory(driver: CDPDriver, args: dict) -> dict:
    """Delete a ChatGPT memory."""
    validated = DeleteMemoryInput(**args)
    success = await driver.delete_memory(memory_id=validated.memory_id)
    return {"success": success, "memory_id": validated.memory_id}


async def do_list_gpts(driver: CDPDriver) -> dict:
    """List Custom GPTs."""
    gpts = await driver.list_gpts()
    return {
        "gpts": [
            {
                "id": g.get("id", ""),
                "name": g.get("name", ""),
                "description": g.get("description", ""),
            }
            for g in gpts
        ],
    }


async def do_list_project_files(driver: CDPDriver, args: dict) -> dict:
    """List files in a project."""
    validated = ListProjectFilesInput(**args)
    files = await driver.get_project_files(project_id=validated.project_id)
    return {
        "files": files,
        "project_id": validated.project_id,
    }


async def do_chat_with_gpt(
    driver: CDPDriver,
    args: dict,
    on_progress: ProgressCallback | None = None,
    session_key: str | None = None,
) -> dict:
    """Chat with a specific Custom GPT."""
    validated = ChatWithGptInput(**args)
    # Every GPT chat creates a new conversation — first call must be
    # user-confirmed (conv_id is always None here; the gate returns the
    # new-conversation payload).
    binding_gate = await conv_binding.gate_check(
        driver,
        None,
        session_key,
        confirmed=validated.confirm,
        project_label=f"gpt:{validated.gpt_id}",
    )
    if binding_gate is not None:
        return binding_gate
    await driver.navigate_gpt(gizmo_id=validated.gpt_id)
    full_response = ""
    conv_id = ""
    chunk_count = 0
    async for chunk in driver.send_and_stream(
        validated.message, timeout=120, on_progress=on_progress,
    ):
        if chunk.delta:
            full_response += chunk.delta
            chunk_count += 1
            if chunk_count == 1:
                await _notify(on_progress, "Assistant is responding…")
            elif chunk_count % _PROGRESS_EVERY_N_CHUNKS == 0:
                await _notify(on_progress, f"Streaming… {len(full_response)} chars")
        if chunk.finish_reason:
            conv_id = driver._current_conv_id or ""
            await _notify(on_progress, "Finalizing…")

    # The GPT chat created a fresh conversation — bind it to this session.
    if conv_id and session_key:
        conv_binding.claim(conv_id, session_key)

    persisted = await _verify_reply_persisted(driver, conv_id)
    return {
        "content": full_response,
        "model": "gpt",
        "delivery_receipt": _delivery_receipt(driver),
        "conversation_id": conv_id,
        "gpt_id": validated.gpt_id,
        "reply_persisted": persisted,
    }


# ═══════════════════════════════════════════════════════════════
# Tool Definitions — declarative list with full annotations
# ═══════════════════════════════════════════════════════════════


def _build_tools() -> list[mcp_types.Tool]:
    """Build the full tool catalog, including browser-free diagnostics.

    Returns every tool regardless of access gates. Used by tests that
    assert the complete catalog. Runtime tool exposure goes through
    :func:`build_tools`, which applies the access gates.
    """
    return [
        mcp_types.Tool(
            name=ToolName.RUNTIME_INFO.value,
            title="Bridge Runtime Info",
            description=(
                "Inspect this running bridge's startup time, source fingerprint, "
                "contract version and whether disk code changed. Local only: "
                "does not acquire a browser slot or contact ChatGPT. After an "
                "upgrade, verify this live response instead of assuming a "
                "long-running MCP process reloaded its code."
            ),
            inputSchema={"type": "object", "properties": {}},
            outputSchema={
                "type": "object",
                "properties": {
                    "package_version": {"type": "string"},
                    "contract_version": {"type": "string"},
                    "pid": {"type": "integer"},
                    "started_at": {"type": "string"},
                    "startup_source_fingerprint": {"type": ["string", "null"]},
                    "disk_source_fingerprint": {"type": ["string", "null"]},
                    "restart_required": {"type": ["boolean", "null"]},
                    "capabilities": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["contract_version", "started_at", "restart_required"],
            },
            annotations=mcp_types.ToolAnnotations(
                readOnlyHint=True, destructiveHint=False,
                idempotentHint=True, openWorldHint=False,
            ),
        ),
        # ── Core: Chat ────────────────────────────────────────
        mcp_types.Tool(
            name=ToolName.CHAT_COMPLETION.value,
            title="ChatGPT Completion",
            description=(
                "Send a message to ChatGPT and receive a response. "
                "This is the primary tool for interacting with ChatGPT.\n\n"
                "Context persistence levels:\n"
                "• No project_id → ephemeral chat (or auto-continue last conversation)\n"
                "• With project_id → project-scoped persistent memory and custom instructions\n"
                "• With conversation_id → resume a specific conversation\n\n"
                "Auto-continue behavior: if you omit conversation_id, the tool continues "
                "the last conversation automatically (unless system_prompt or project_id changes). "
                "This makes multi-turn conversations seamless — just call this tool again "
                "with the next message."
            ),
            inputSchema=ChatCompletionInput.model_json_schema(),
            outputSchema=CHAT_COMPLETION_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="ChatGPT Completion",
                readOnlyHint=False,
                destructiveHint=False,
                idempotentHint=False,
                openWorldHint=True,
            ),
        ),
        # ── Core: Discovery ──────────────────────────────────
        mcp_types.Tool(
            name=ToolName.LIST_MODELS.value,
            title="List Models",
            description=(
                "List all ChatGPT models available on your account. "
                "Returns model slugs (like 'auto', 'gpt-5-5', 'gpt-5-mini') "
                "that can be used as the 'model' parameter in chat_completion.\n\n"
                "Model selection guide:\n"
                "• auto — best for most tasks (system picks the right model)\n"
                "• gpt-5-5 — latest with reasoning, 34K context\n"
                "• gpt-5-mini — fast and cheap, no reasoning, 8K context"
            ),
            inputSchema=ListModelsInput.model_json_schema(),
            outputSchema=LIST_MODELS_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="List Models",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.LIST_PROJECTS.value,
            title="List Projects",
            description=(
                "List all ChatGPT projects. Each project is an isolated workspace with:\n"
                "• Persistent memory — ChatGPT remembers facts across conversations in the project\n"
                "• Custom instructions — a system prompt that applies to all project conversations\n"
                "• File attachments — a knowledge base for the project\n\n"
                "Memory scopes:\n"
                "• 'project_v2' — dedicated memory (isolated, no cross-contamination)\n"
                "• 'global' — shared memory (uses global ChatGPT memory pool)\n\n"
                "Use the project's 'id' as the 'project_id' parameter in chat_completion."
            ),
            inputSchema=ListProjectsInput.model_json_schema(),
            outputSchema=LIST_PROJECTS_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="List Projects",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        # ── Conversations ─────────────────────────────────────
        mcp_types.Tool(
            name=ToolName.LIST_CONVERSATIONS.value,
            title="List Conversations",
            description=(
                "List recent ChatGPT conversations, ordered by last update. "
                "Returns conversation IDs, titles, and timestamps. "
                "Use this to find a conversation_id for resuming with chat_completion "
                "or for retrieving full history with get_conversation.\n\n"
                "Each conversation's 'gizmo_id' field indicates which project it belongs to "
                "(null means it's a standalone conversation)."
            ),
            inputSchema=ListConversationsInput.model_json_schema(),
            outputSchema=LIST_CONVERSATIONS_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="List Conversations",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.GET_CONVERSATION.value,
            title="Get Conversation",
            description=(
                "Retrieve the message history of a conversation as a chronological "
                "list of user and assistant messages (oldest-first). "
                "Useful for reviewing what was discussed before continuing a conversation.\n\n"
                "For recovery, use tail=2 to fetch the latest messages in one call; "
                "do not first fetch a count and then fetch the tail. fresh=true "
                "bypasses the read cache when current evidence is necessary. "
                "Consume an existing result or client overflow file before repeating a read.\n\n"
                "Pagination: returns `limit` messages starting at `offset` (defaults: "
                "offset=0, limit=50). To read the ENTIRE conversation (not just the "
                "most recent page), page through by increasing offset by limit each "
                "call until has_more is false: "
                "get_conversation(id, offset=0, limit=50), then offset=50, offset=100, … . "
                "If a single page's result is truncated before reaching you, either "
                "lower limit (e.g. 15) and retry, or pass `out_file` (absolute path) "
                "to write the page to disk and read the file — the tool result then "
                "stays tiny no matter how long the messages are.\n\n"
                "Empty results are disambiguated by `reason`: 'not_found' = backend "
                "404 (check the id against list_conversations), 'empty' = reachable "
                "but nothing visible yet (often mid-generation), 'fetch_failed' = "
                "the fetch itself errored. DOM fallback returns reason='partial', "
                "source='dom', paging_supported=false and unknown absolute "
                "offset/total/has_more; it is a rendered tail, not a complete page. "
                "out_file is honored for both backend and DOM results."
            ),
            inputSchema=GetConversationInput.model_json_schema(),
            outputSchema=GET_CONVERSATION_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Get Conversation",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.WAIT_REPLY.value,
            title="Wait for Reply",
            description=(
                "Block until an assistant reply FINISHES generating and "
                "persists in the conversation (or the timeout hits). Use "
                "after chat_completion when the stream looked "
                "corrupt/truncated, or `reply_persisted` came back false — "
                "instead of hand-polling get_conversation.\n\n"
                "A reply counts only once its backend status is terminal — a "
                "still-streaming tail (status='in_progress') keeps waiting. "
                "On 'timeout' read `tail_status`: 'in_progress' means the web "
                "side is STILL generating (a bridge-side read timeout is not "
                "a dead generation), so call wait_reply again rather than "
                "nudging.\n\n"
                "Pass `since_total` (a prior backend call's `total`) to wait for "
                "a NEW reply past an existing tail. A user tail alone is not "
                "a dead-generation proof; if the timeout is unresolved, inspect "
                "the web UI or use a fresh tail read before sending anything. "
                "Read-only; prefers the conversation tab's DOM and falls back "
                "to bounded backend reads at poll_seconds intervals."
            ),
            inputSchema=WaitReplyInput.model_json_schema(),
            outputSchema=WAIT_REPLY_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Wait for Reply",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.DELETE_CONVERSATION.value,
            title="Delete Conversation",
            description=(
                "Delete a conversation permanently. The conversation is removed from "
                "the ChatGPT sidebar and cannot be recovered. "
                "Use list_conversations first to find the conversation_id."
            ),
            inputSchema=DeleteConversationInput.model_json_schema(),
            outputSchema=DELETE_RESULT_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Delete Conversation",
                readOnlyHint=False,
                destructiveHint=True,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        # ── Projects (write) ──────────────────────────────────
        mcp_types.Tool(
            name=ToolName.CREATE_PROJECT.value,
            title="Create Project",
            description=(
                "Create a new ChatGPT project — an isolated workspace with persistent memory, "
                "custom instructions, and file attachments.\n\n"
                "Memory scope options:\n"
                "• 'project_v2' (default) — dedicated memory. ChatGPT only remembers facts "
                "from conversations within this project. No cross-contamination with other chats. "
                "Best for: isolated tasks, specific domains, sensitive contexts.\n"
                "• 'global' — shared memory. Uses ChatGPT's global memory pool. "
                "Best for: general-purpose projects that benefit from cross-chat context.\n\n"
                "After creating a project, use its 'id' as the 'project_id' in chat_completion "
                "to start conversations within the project."
            ),
            inputSchema=CreateProjectInput.model_json_schema(),
            outputSchema=CREATE_PROJECT_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Create Project",
                readOnlyHint=False,
                destructiveHint=False,
                idempotentHint=False,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.DELETE_PROJECT.value,
            title="Delete Project",
            description=(
                "Permanently delete a ChatGPT project by ID. Use list_projects first to "
                "find the project_id (g-p-...). Deletion is irreversible — the project, "
                "its instructions, and its dedicated memory are removed. Hidden behind "
                "W2A_ENABLE_DESTRUCTIVE=1."
            ),
            inputSchema=DeleteProjectInput.model_json_schema(),
            outputSchema=DELETE_PROJECT_RESULT_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Delete Project",
                readOnlyHint=False,
                destructiveHint=True,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.UPDATE_PROJECT_INSTRUCTIONS.value,
            title="Update Project Instructions",
            description=(
                "Update the custom instructions (system prompt) for an existing ChatGPT project. "
                "The new instructions replace any existing ones and apply to all future "
                "conversations created within the project. "
                "Existing conversations are not retroactively affected.\n\n"
                "Instructions act as a persistent system prompt for the project — "
                "unlike the system_prompt parameter in chat_completion which is per-message, "
                "project instructions persist across all conversations in the project."
            ),
            inputSchema=UpdateProjectInstructionsInput.model_json_schema(),
            outputSchema=UPDATE_INSTRUCTIONS_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Update Project Instructions",
                readOnlyHint=False,
                destructiveHint=False,
                idempotentHint=False,
                openWorldHint=False,
            ),
        ),
        # ── Archive ────────────────────────────────────────────
        mcp_types.Tool(
            name=ToolName.ARCHIVE_CONVERSATION.value,
            title="Archive Conversation",
            description=(
                "Archive or unarchive a conversation. "
                "Archived conversations are hidden from the sidebar but not deleted. "
                "Pass archive=false to unarchive. "
                "This is reversible — use this instead of delete_conversation when unsure."
            ),
            inputSchema=ArchiveConversationInput.model_json_schema(),
            outputSchema=ARCHIVE_RESULT_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Archive Conversation",
                readOnlyHint=False,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        # ── Memory ─────────────────────────────────────────────
        mcp_types.Tool(
            name=ToolName.LIST_MEMORIES.value,
            title="List Memories",
            description=(
                "List all facts ChatGPT remembers about the user. "
                "ChatGPT's memory stores personal preferences, context, and facts "
                "that persist across all conversations. "
                "Memory is separate from conversation history — it survives even after conversations are deleted."
            ),
            inputSchema=ListMemoriesInput.model_json_schema(),
            outputSchema=LIST_MEMORIES_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="List Memories",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.CREATE_MEMORY.value,
            title="Create Memory",
            description=(
                "Instruct ChatGPT to remember a new fact. "
                "This works by sending a chat message asking ChatGPT to remember — "
                "the POST /backend-api/memories endpoint returns 405, so memory "
                "creation must go through conversation. ChatGPT may paraphrase "
                "or decline the request. Use list_memories to verify.\n\n"
                "Examples: 'I prefer Python over JavaScript', 'My project uses PostgreSQL 16', "
                "'Always respond in markdown with code examples'."
            ),
            inputSchema=CreateMemoryInput.model_json_schema(),
            outputSchema=CREATE_MEMORY_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Create Memory",
                readOnlyHint=False,
                destructiveHint=False,
                idempotentHint=False,
                openWorldHint=False,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.DELETE_MEMORY.value,
            title="Delete Memory",
            description=(
                "Delete a specific memory from ChatGPT's persistent memory. "
                "Use list_memories first to find the memory_id. "
                "Deletion is permanent — ChatGPT will no longer remember this fact."
            ),
            inputSchema=DeleteMemoryInput.model_json_schema(),
            outputSchema=DELETE_MEMORY_RESULT_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Delete Memory",
                readOnlyHint=False,
                destructiveHint=True,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
        # ── Custom GPTs ────────────────────────────────────────
        mcp_types.Tool(
            name=ToolName.LIST_GPTS.value,
            title="List Custom GPTs",
            description=(
                "List all Custom GPTs available to the account. "
                "Custom GPTs are specialized assistants created by users or OpenAI — "
                "each has unique capabilities, knowledge, and personality. "
                "Use chat_with_gpt to interact with a specific GPT."
            ),
            inputSchema=ListGptsInput.model_json_schema(),
            outputSchema=LIST_GPTS_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="List Custom GPTs",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=True,
            ),
        ),
        mcp_types.Tool(
            name=ToolName.CHAT_WITH_GPT.value,
            title="Chat with Custom GPT",
            description=(
                "Send a message to a specific Custom GPT and receive a response. "
                "Each GPT has its own system prompt, knowledge base, and capabilities. "
                "Use list_gpts to discover available GPTs, then pass the gpt_id to this tool.\n\n"
                "This navigates to the GPT's page in the browser, so it's slower than "
                "chat_completion for simple tasks. Use it when you need GPT-specific capabilities."
            ),
            inputSchema=ChatWithGptInput.model_json_schema(),
            outputSchema=CHAT_COMPLETION_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="Chat with Custom GPT",
                readOnlyHint=False,
                destructiveHint=False,
                idempotentHint=False,
                openWorldHint=True,
            ),
        ),
        # ── Project Files ──────────────────────────────────────
        mcp_types.Tool(
            name=ToolName.LIST_PROJECT_FILES.value,
            title="List Project Files",
            description=(
                "List files attached to a ChatGPT project. "
                "Projects can have uploaded documents that serve as a knowledge base. "
                "ChatGPT references these files when answering questions in the project."
            ),
            inputSchema=ListProjectFilesInput.model_json_schema(),
            outputSchema=LIST_PROJECT_FILES_OUTPUT,
            annotations=mcp_types.ToolAnnotations(
                title="List Project Files",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=False,
            ),
        ),
    ]


def build_tools() -> list[mcp_types.Tool]:
    """Build the *visible* tool list, applying access gates.

    Filters :func:`_build_tools` by the current environment:
      - SAFE tools (reads + chat) are always returned.
      - Write tools require ``W2A_ENABLE_WRITE=1``.
      - Destructive tools require ``W2A_ENABLE_DESTRUCTIVE=1``.

    This is the runtime entrypoint used by ``list_tools``. Every
    returned tool carries honest ``noauth`` auth metadata when the
    server has no API keys configured.
    """
    visible = _visible_tool_names()
    gated = [t for t in _build_tools() if t.name in visible]
    # Stamp auth metadata on every exposed tool
    for tool in gated:
        tool.meta = tool_meta()
    return gated


# ═══════════════════════════════════════════════════════════════
# Server Factory
# ═══════════════════════════════════════════════════════════════

# ── Shared tool-result formatting + exception mapping ─────────────────────
# Extracted from the singleton call_tool path so the pooled path reuses
# exactly the same result shaping and error semantics. (PR #42 review fix #1/#2)

_STATUS_TOOLS = frozenset({
    ToolName.DELETE_CONVERSATION.value,
    ToolName.UPDATE_PROJECT_INSTRUCTIONS.value,
    ToolName.DELETE_PROJECT.value,
    ToolName.ARCHIVE_CONVERSATION.value,
    ToolName.DELETE_MEMORY.value,
})


def _format_tool_result(name: str, result) -> object:
    """Shape the raw handler result into the MCP CallToolResult contract.

    Shared between singleton and pooled paths so both return identical
    payload shapes for the same tool + result.
    """
    # chat_completion and chat_with_gpt return both text + structured output
    if name in (ToolName.CHAT_COMPLETION.value, ToolName.CHAT_WITH_GPT.value):
        if isinstance(result, dict) and result.get("status") == "confirmation_required":
            # Binding gate: no assistant content exists — the payload itself
            # is the message the agent must relay to the user.
            text_content = [
                mcp_types.TextContent(
                    type="text", text=json.dumps(result, ensure_ascii=False)
                )
            ]
            return text_content, result
        text_content = [mcp_types.TextContent(type="text", text=result["content"])]
        return text_content, result
    # Status operations return status text + structured output
    if name in _STATUS_TOOLS:
        status = "succeeded" if result.get("success") else "failed"
        text_content = [mcp_types.TextContent(type="text", text=f"Operation {status}")]
        return text_content, result
    # Everything else returns structured only (SDK auto-wraps as text JSON)
    return result


def _map_tool_exception(exc: Exception) -> object:
    """Map a tool-execution exception to an isError CallToolResult.

    Shared between singleton and pooled paths. Returns None if the exception
    type is not mapped (caller should re-raise).
    """
    # Lazy imports for circular-dependency avoidance.
    from .cdp_driver import ModelSelectionError
    from .backend_client import BackendReadError
    from .cdp_transport import CDPTimeoutError

    if isinstance(exc, PermissionError):
        payload = {"error": "permission_denied", "retryable": False}
        if hasattr(exc, "delivery_stage"):
            payload.update(
                delivery_stage=exc.delivery_stage,
                conversation_id=getattr(exc, "conversation_id", None),
                user_message_id=getattr(exc, "user_message_id", None),
                retry_safe=False,
            )
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text", text=json.dumps(payload))],
            structuredContent=payload, isError=True,
        )

    if isinstance(exc, CDPTimeoutError) and not hasattr(exc, "delivery_stage"):
        payload = {
            "error": "cdp_timeout", "phase": exc.phase,
            "method": exc.method, "timeout_seconds": exc.timeout,
        }
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text", text=json.dumps(payload))],
            structuredContent=payload, isError=True,
        )

    if isinstance(exc, BackendReadError):
        payload = {
            "error": "backend_read_failed", "phase": "backend_http_read",
            "kind": exc.kind, "http_status": exc.status,
            "retry_after": exc.retry_after,
        }
        # A model/preflight read can be part of a send. Preserve that send's
        # delivery state without treating this HTTP failure as a CDP reconnect
        # signal. Never expose the raw authenticated response body.
        if hasattr(exc, "delivery_stage"):
            payload.update(
                delivery_stage=exc.delivery_stage,
                conversation_id=getattr(exc, "conversation_id", None),
                user_message_id=getattr(exc, "user_message_id", None),
                retry_safe=exc.delivery_stage == "not_started",
            )
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text", text=json.dumps(payload))],
            structuredContent=payload, isError=True,
        )

    if isinstance(exc, ModelSelectionError):
        payload = {
            "error": "model_selection_failed", "requested_model": exc.requested_model,
            "delivery_stage": "not_started", "retry_safe": True, "retryable": False,
            "message": "Requested model could not be selected; no message was submitted. Check available models rather than silently substituting.",
        }
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text", text=json.dumps(payload))],
            structuredContent=payload, isError=True,
        )

    if isinstance(exc, OwnedTabRequiredError):
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text=f"{exc}. Retry later. (owned_tab_required)")],
            isError=True,
        )
    if isinstance(exc, RateLimitError):
        safe = getattr(exc, "delivery_stage", "unknown") == "not_started"
        payload = {
            "error": "rate_limit_exceeded", "retry_after": exc.retry_after,
            "delivery_stage": getattr(exc, "delivery_stage", "unknown"),
            "retry_safe": safe,
            "conversation_id": getattr(exc, "conversation_id", None),
            "user_message_id": getattr(exc, "user_message_id", None),
            "send_hint": (
                "No submission occurred; retry after cooldown."
                if safe else "Do not resend. Consume existing results, then check the conversation tail once; submission may have occurred."
            ),
        }
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text=json.dumps(payload))],
            structuredContent=payload, isError=True,
        )
    if isinstance(exc, CircuitOpenError):
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text=(f"Circuit open for {exc.kind.value} — cooling down. "
                      f"Retry later. (circuit_open, kind={exc.kind.value})"))],
            isError=True,
        )
    if isinstance(exc, AuthExpiredError):
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text="ChatGPT session expired — re-login required. (auth_expired)")],
            isError=True,
        )
    if isinstance(exc, GenerationInProgressError):
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text=(f"Conversation is mid-generation — a send now would "
                      f"interrupt the streaming reply. Retry in "
                      f"{exc.retry_after:.0f}s or poll wait_reply. "
                      f"(generation_in_progress, retry_after={exc.retry_after:.0f})"))],
            isError=True,
        )
    if isinstance(exc, GenerationStuckError):
        details = {
            "error": "generation_stuck", "phase": exc.phase,
            "stalled_for_s": exc.stalled_for_s,
            "delivery_stage": getattr(exc, "delivery_stage", "unknown"),
            "conversation_id": getattr(exc, "conversation_id", None),
            "user_message_id": getattr(exc, "user_message_id", None),
            "retry_safe": False,
        }
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text=(f"Generation stalled — no DOM progress. Your message "
                      f"was already DELIVERED — do NOT resend it (that would "
                      f"duplicate). Poll wait_reply to check whether it "
                      f"recovered. (generation_stuck, "
                      f"phase={exc.phase}, stalled_for={exc.stalled_for_s:.0f}s)"))],
            structuredContent=details, isError=True,
        )
    if isinstance(exc, LockAcquisitionError):
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text",
                text="Browser busy — another operation in progress. Retry later. (lock_timeout)")],
            isError=True,
        )
    if hasattr(exc, "delivery_stage"):
        details = {
            "error": type(exc).__name__, "message": str(exc),
            "delivery_stage": exc.delivery_stage,
            "conversation_id": getattr(exc, "conversation_id", None),
            "user_message_id": getattr(exc, "user_message_id", None),
            "retry_safe": exc.delivery_stage == "not_started",
            "recovery_attempts": getattr(exc, "recovery_attempts", 0),
            "receipt_check": getattr(exc, "receipt_check", None),
            "send_hint": "Consume any existing result before recovery; do not resend after a possible submission.",
        }
        return mcp_types.CallToolResult(
            content=[mcp_types.TextContent(type="text", text=json.dumps(details))],
            structuredContent=details, isError=True,
        )
    return None


class _BridgeServer(Server):
    """Expose process identity on every transport's standard MCP handshake."""

    def get_capabilities(
        self,
        notification_options: NotificationOptions,
        experimental_capabilities: dict[str, dict[str, Any]],
    ) -> mcp_types.ServerCapabilities:
        # Some hosts discard startup stderr and cannot call tools outside a
        # model turn. The initialize response is tied to their actual child
        # process, so it can attest activation without another test process.
        experimental = dict(experimental_capabilities)
        experimental["chatgpt-web2api/runtime"] = get_runtime_info()
        return super().get_capabilities(notification_options, experimental)


def create_server() -> Server:
    """Create and configure the MCP server with all capabilities."""

    server = _BridgeServer("chatgpt-web2api", version=__version__)

    def _make_progress_callback() -> ProgressCallback | None:
        """Build a best-effort progress notifier from the in-flight MCP request.

        Returns None when there is no usable progress channel: outside a
        request (direct call / unit test) or when the client sent no
        ``_meta.progressToken``. Business functions check for None and skip
        emitting.

        The returned counter is monotonic and persists across rate-limit
        retries (it's bound to the outer call_tool invocation, and the retry
        wrapper re-enters the business function without rebuilding it). Note
        for future debugging: the *message* may visually "reset" across a
        retry because ChatGPT re-types and re-streams the response from
        scratch, while the numeric progress counter keeps climbing. This is
        expected — the text genuinely restarts; only the counter is stable.
        """
        inherited = request_progress.get()
        if inherited is not None:
            return inherited
        try:
            ctx = server.request_context
        except LookupError:
            return None  # not inside a request (direct call / test)
        token = ctx.meta.progressToken if ctx.meta else None
        if token is None:
            return None  # client didn't ask for progress
        counter = 0

        async def _cb(message: str) -> None:
            nonlocal counter
            counter += 1
            # Best-effort: a dropped notification (network blip, session
            # closed mid-stream) must NEVER abort the tool call — that would
            # kill a 40s generation over a transient transport issue.
            try:
                await ctx.session.send_progress_notification(
                    progress_token=token,
                    progress=counter,
                    message=message,
                )
            except Exception:
                logger.debug(
                    "progress notification dropped (transport error)",
                    exc_info=True,
                )

        return _cb

    # ── Tools (model-controlled) ──────────────────────────────

    @server.list_tools()
    async def list_tools() -> list[mcp_types.Tool]:
        return build_tools()

    async def _call_tool_pooled(
        name: str, arguments: dict, srv
    ) -> tuple[list[mcp_types.TextContent], dict] | list[mcp_types.TextContent] | dict:
        """B1: pooled tool execution — acquires a session-affine driver lease.

        In pool mode, _driver is None and _breakers is None. This function
        resolves the session key, acquires a lease from the pool, and runs
        the tool against the leased driver. The call_lock serializes all
        operations per session. The existing MutationLock is resolved against
        lease.driver (not the global _driver).
        """
        from .mcp_driver_pool import (
            UTILITY_SLOT_KEY,
            PoolExhaustedError,
            PoolShuttingDownError,
        )
        from .session_key import current_mcp_session_key

        # Canary logging — distinguishes failure modes A/B/C/D (see PR #42 review).
        logger.info("_call_tool_pooled entered: name=%s", name)

        # Defense-in-depth: gated tool check (same as singleton path).
        gate = _tool_gate_env(name)
        if gate is not None and not _env_enabled(gate):
            raise PermissionError(f"Tool '{name}' is not enabled. Set {gate}=1 to expose it.")

        # Account throttle breaker: block mutations pool-wide.
        is_mutation = name in _MUTATING_TOOLS
        if is_mutation and _driver_pool.account_breaker.is_tripped():
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(
                    type="text",
                    text="ChatGPT account throttle detected; mutating requests are paused "
                         "pool-wide until cooldown elapses. (mcp_account_throttled)",
                )],
                isError=True,
            )

        # Resolve session key (fail-closed for pool-enabled SSE with no session_id).
        session_key = current_mcp_session_key(
            srv, transport=_transport,
            pool_enabled=True,
        )
        logger.info("_call_tool_pooled session_key=%s transport=%s", session_key, _transport)

        # Slot affinity. A tab's URL is its conversation identity:
        #  - chat tools WITH an explicit conversation_id are bound to the
        #    conversation ("conv:<id>") — one tab per conversation, shared
        #    across sessions and processes;
        #  - chat tools WITHOUT one stay session-affine (auto-continue);
        #  - all other tools share a single "utility" slot — they never
        #    navigate, so one tab serves all read/maintenance traffic.
        cid = arguments.get("conversation_id") if isinstance(arguments, dict) else None
        _CHATTY = (ToolName.CHAT_COMPLETION.value, ToolName.CHAT_WITH_GPT.value)
        if cid and name in _CHATTY:
            slot_key = f"conv:{cid}"
        elif name in (*_CHATTY, ToolName.CREATE_MEMORY.value):
            slot_key = session_key
        else:
            slot_key = UTILITY_SLOT_KEY
        if slot_key is None:
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(
                    type="text",
                    text="MCP session identity unavailable; cannot allocate session-affine tab. "
                         "(mcp_session_identity_unavailable)",
                )],
                isError=True,
            )

        on_progress = _make_progress_callback()
        _CHAT_TOOLS = frozenset({
            ToolName.CHAT_COMPLETION.value,
            ToolName.CHAT_WITH_GPT.value,
            ToolName.CREATE_MEMORY.value,
        })

        try:
            logger.info("pool.acquire entered: slot_key=%s", slot_key)
            async with _driver_pool.acquire(slot_key) as lease:
                if name in (
                    ToolName.WAIT_REPLY.value,
                    ToolName.GET_CONVERSATION.value,
                ):
                    # Reads that can wait on or join a shared fetch: holding
                    # call_lock for their whole duration would queue every
                    # other read tool, from every session, behind one caller.
                    # Take the lock only for the breaker check; the handler
                    # re-acquires it around each real fetch (never while
                    # sleeping or joining a peer's in-flight read).
                    async with lease.call_lock:
                        await _fail_fast_on_open_breaker(lease.driver, lease.breakers)
                    if name == ToolName.WAIT_REPLY.value:
                        result = await do_wait_reply(
                            lease.driver, arguments, on_progress, call_lock=lease.call_lock
                        )
                    else:
                        result = await do_get_conversation(
                            lease.driver, arguments, call_lock=lease.call_lock
                        )
                    return _format_tool_result(name, result)

                async with lease.call_lock:
                    driver = lease.driver
                    breakers = lease.breakers

                    # Conv-affinity retarget BEFORE the mutation lock is
                    # resolved — the lock key names the target, so the target
                    # must be final here. Adoption is best-effort: False just
                    # means no existing tab for the conv; the handler's
                    # navigate path then moves the current tab onto it.
                    if name == ToolName.CHAT_COMPLETION.value and cid:
                        if getattr(driver, "_current_conv_id", None) != cid:
                            try:
                                await driver.adopt_conversation_tab(cid)
                            except PermissionError:
                                raise
                            except Exception:
                                logger.debug(
                                    "conv-tab adopt failed (handler navigates)",
                                    exc_info=True,
                                )

                    await _fail_fast_on_open_breaker(driver, breakers)

                    # Build handlers bound to the LEASED driver (not _driver).
                    handler = _build_tool_handler(
                        name, arguments, driver, on_progress, session_key=session_key
                    )
                    if handler is None:
                        raise ValueError(f"Unknown tool: {name}")

                    async def _run_pooled() -> dict:
                        if name in _CHAT_TOOLS:
                            return await run_with_send_recovery(
                                driver, lambda: retry_on_rate_limit(driver, handler, on_progress=on_progress),
                                on_progress,
                            )
                        return await handler()

                    if is_mutation and _lock_cdp_port is not None:
                        if _parallel_tabs:
                            _port, _key = resolve_mutation_lock(driver, True)
                        else:
                            _port, _key = _lock_cdp_port, None
                        async with MutationLock(_port, _key):
                            if _parallel_tabs:
                                _, _current_key = resolve_mutation_lock(driver, True)
                                if _current_key != _key:
                                    raise OwnedTabRequiredError(
                                        "owned target changed while waiting for mutation lock"
                                    )
                            result = await _run_pooled()
                    else:
                        result = await _run_pooled()

                    # Account throttle detection.
                    if is_mutation and _looks_like_account_throttle_warning(result):
                        await _driver_pool.account_breaker.trip()

                    # Shared result formatting (singleton parity, PR #42 fix #1).
                    return _format_tool_result(name, result)
        except (PoolExhaustedError, PoolShuttingDownError) as e:
            # Defensive: never let an empty-message exception surface as
            # ". Retry later." Fall back to the type name so the caller always
            # gets a diagnosable signal. (The exception classes now carry a
            # default message, but this guards against future bare raises.)
            detail = str(e) or type(e).__name__
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(type="text", text=f"{detail}. Retry later.")],
                isError=True,
            )
        except Exception as exc:
            # Shared exception mapping (singleton parity, PR #42 fix #2).
            # Log here: mapped results reach the MCP client but were
            # previously invisible in the daemon log — which is how repeated
            # tool failures went unattributed.
            mapped = _map_tool_exception(exc)
            if mapped is not None:
                logger.warning(
                    "tool %s failed (mapped): %s: %s", name, type(exc).__name__, exc
                )
                return mapped
            logger.exception("tool %s failed with unmapped exception", name)
            raise

    async def _fail_fast_on_open_breaker(driver, breakers) -> None:
        """Circuit-open fail-fast on the leased driver's breakers."""
        if breakers is None:
            return
        open_kind = breakers.first_open()
        if open_kind is not None:
            if open_kind is BreakerKind.AUTH_EXPIRED:
                if await driver.recover_auth():
                    open_kind = breakers.first_open()
            if open_kind is not None:
                raise CircuitOpenError(open_kind)

    def _build_tool_handler(name, arguments, driver, on_progress, session_key=None):
        """Build a tool handler bound to a specific driver (singleton or leased)."""
        handlers = {
            ToolName.CHAT_COMPLETION.value: lambda: do_chat_completion(
                driver, arguments, _config, on_progress, session_key=session_key
            ),
            ToolName.LIST_MODELS.value: lambda: do_list_models(driver),
            ToolName.LIST_PROJECTS.value: lambda: do_list_projects(driver),
            ToolName.GET_CONVERSATION.value: lambda: do_get_conversation(driver, arguments),
            ToolName.LIST_CONVERSATIONS.value: lambda: do_list_conversations(driver, arguments),
            ToolName.WAIT_REPLY.value: lambda: do_wait_reply(driver, arguments, on_progress),
            ToolName.DELETE_CONVERSATION.value: lambda: do_delete_conversation(driver, arguments),
            ToolName.CREATE_PROJECT.value: lambda: do_create_project(driver, arguments),
            ToolName.DELETE_PROJECT.value: lambda: do_delete_project(driver, arguments),
            ToolName.UPDATE_PROJECT_INSTRUCTIONS.value: lambda: do_update_project_instructions(driver, arguments),
            ToolName.ARCHIVE_CONVERSATION.value: lambda: do_archive_conversation(driver, arguments),
            ToolName.LIST_MEMORIES.value: lambda: do_list_memories(driver),
            ToolName.CREATE_MEMORY.value: lambda: do_create_memory(driver, arguments, on_progress),
            ToolName.DELETE_MEMORY.value: lambda: do_delete_memory(driver, arguments),
            ToolName.LIST_GPTS.value: lambda: do_list_gpts(driver),
            ToolName.CHAT_WITH_GPT.value: lambda: do_chat_with_gpt(
                driver, arguments, on_progress, session_key=session_key
            ),
            ToolName.LIST_PROJECT_FILES.value: lambda: do_list_project_files(driver, arguments),
        }
        return handlers.get(name)

    def _looks_like_account_throttle_warning(result) -> bool:
        """Heuristic: does a tool result contain the ChatGPT excessive-consumption warning?"""
        if result is None:
            return False
        # Check text content for the warning marker.
        text = ""
        if isinstance(result, dict):
            text = str(result.get("content", ""))
        elif hasattr(result, "__iter__"):
            try:
                for item in result:
                    if hasattr(item, "text"):
                        text += item.text
            except TypeError:
                pass
        return "excessive consumption" in text.lower() or "too many requests" in text.lower()

    @server.call_tool()
    async def call_tool(
        name: str, arguments: dict
    ) -> tuple[list[mcp_types.TextContent], dict] | list[mcp_types.TextContent] | dict:
        if name == ToolName.RUNTIME_INFO.value:
            return get_runtime_info()
        # The deadline starts before acquiring any pool slot or mutation lock.
        # It is independent of progress/heartbeat notifications.
        if name == ToolName.CHAT_COMPLETION.value:
            budget = ChatCompletionInput(**arguments).timeout_seconds
        elif name == ToolName.WAIT_REPLY.value:
            budget = WaitReplyInput(**arguments).timeout_seconds + 1
        elif name in _CHAT_TOOL_NAMES:
            budget = 900
        else:
            budget = 60
        monitor = RequestMonitor(_make_progress_callback(), budget)
        token = request_progress.set(monitor.update)
        deadline = asyncio.timeout(budget)
        try:
            async with deadline:
                async with monitor:
                    return await _dispatch_tool(name, arguments)
        except TimeoutError:
            if not deadline.expired():
                raise
            payload = {
                "error": "request_timeout", "phase": monitor.phase,
                "elapsed_s": round(monitor.elapsed, 1), "timeout_seconds": budget,
            }
            if name in _CHAT_TOOL_NAMES:
                payload.update(
                    conversation_id=arguments.get("conversation_id"),
                    delivery_stage="unknown",
                    retry_safe=False,
                    send_hint="Do not resend. Consume any returned result, then check this conversation's tail once; timeout only ended local observation.",
                )
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(type="text", text=json.dumps(payload))],
                structuredContent=payload, isError=True,
            )
        finally:
            request_progress.reset(token)

    async def _dispatch_tool(
        name: str, arguments: dict
    ) -> tuple[list[mcp_types.TextContent], dict] | list[mcp_types.TextContent] | dict:
        """Route tool calls to business logic functions."""
        # B1: in pool mode, acquire a session-affine driver lease.
        # In singleton mode, use the global _driver directly (unchanged).
        if _driver_pool is not None:
            return await _call_tool_pooled(name, arguments, server)

        if _driver is None:
            raise ConnectionError("Not connected to Chrome. Run 'chatgpt-web2api' first.")

        # Build once per request: the callback reads server.request_context,
        # which is request-scoped. None when the client can't receive progress.
        on_progress = _make_progress_callback()

        # Session identity for the conversation-binding gate (singleton mode:
        # "singleton"/"stdio-singleton", or the SSE/http session id when the
        # transport exposes one — a reconnect therefore re-confirms).
        from .session_key import current_mcp_session_key

        _session_key = current_mcp_session_key(
            server, transport=_transport, pool_enabled=False
        )

        handlers = {
            ToolName.CHAT_COMPLETION.value: lambda: do_chat_completion(
                _driver, arguments, _config, on_progress, session_key=_session_key
            ),
            ToolName.LIST_MODELS.value: lambda: do_list_models(_driver),
            ToolName.LIST_PROJECTS.value: lambda: do_list_projects(_driver),
            ToolName.GET_CONVERSATION.value: lambda: do_get_conversation(_driver, arguments),
            ToolName.LIST_CONVERSATIONS.value: lambda: do_list_conversations(_driver, arguments),
            ToolName.WAIT_REPLY.value: lambda: do_wait_reply(_driver, arguments, on_progress),
            ToolName.DELETE_CONVERSATION.value: lambda: do_delete_conversation(_driver, arguments),
            ToolName.CREATE_PROJECT.value: lambda: do_create_project(_driver, arguments),
            ToolName.DELETE_PROJECT.value: lambda: do_delete_project(_driver, arguments),
            ToolName.UPDATE_PROJECT_INSTRUCTIONS.value: lambda: do_update_project_instructions(
                _driver, arguments
            ),
            ToolName.ARCHIVE_CONVERSATION.value: lambda: do_archive_conversation(
                _driver, arguments
            ),
            ToolName.LIST_MEMORIES.value: lambda: do_list_memories(_driver),
            ToolName.CREATE_MEMORY.value: lambda: do_create_memory(_driver, arguments, on_progress),
            ToolName.DELETE_MEMORY.value: lambda: do_delete_memory(_driver, arguments),
            ToolName.LIST_GPTS.value: lambda: do_list_gpts(_driver),
            ToolName.CHAT_WITH_GPT.value: lambda: do_chat_with_gpt(
                _driver, arguments, on_progress, session_key=_session_key
            ),
            ToolName.LIST_PROJECT_FILES.value: lambda: do_list_project_files(_driver, arguments),
        }

        handler = handlers.get(name)
        if not handler:
            raise ValueError(f"Unknown tool: {name}")

        # Defense-in-depth: refuse gated tools even when called by name.
        # A client could call a tool that isn't in list_tools; the call
        # must be rejected rather than silently executed.
        gate = _tool_gate_env(name)
        if gate is not None and not _env_enabled(gate):
            raise PermissionError(f"Tool '{name}' is not enabled. Set {gate}=1 to expose it.")

        # Tools whose business logic drives ChatGPT chat (and can hit the rate
        # limit). These get transparent retry: a transient "Too many requests"
        # pop-up is dismissed and retried so the agent never sees it. Only a
        # persistent limit surfaces — as a structured error result below.
        _CHAT_TOOLS = frozenset(
            {
                ToolName.CHAT_COMPLETION.value,
                ToolName.CHAT_WITH_GPT.value,
                ToolName.CREATE_MEMORY.value,  # uses send_and_stream internally
            }
        )

        async def _run() -> dict:
            """Execute the handler, with transparent rate-limit retry for chat tools."""
            # Circuit-open fail-fast (Phase 4 PR2): refuse before driving Chrome
            # if a breaker is open on this process's driver. If AUTH_EXPIRED is
            # open, probe auth recovery first (the user may have logged back in).
            if _breakers is not None:
                open_kind = _breakers.first_open()
                if open_kind is not None:
                    if open_kind is BreakerKind.AUTH_EXPIRED:
                        if await _driver.recover_auth():
                            open_kind = _breakers.first_open()
                    if open_kind is not None:
                        raise CircuitOpenError(open_kind)
            if name in _CHAT_TOOLS:
                # on_progress is the same callback the lambda captures and
                # passes into the business function; here it's also used by
                # retry_on_rate_limit to signal the backoff pause. Same object
                # by design — two injection points, one notifier.
                return await run_with_send_recovery(
                    _driver, lambda: retry_on_rate_limit(_driver, handler, on_progress=on_progress),
                    on_progress,
                )
            return await handler()

        # Serialize mutating tools through the cross-process lock
        try:
            # Conv-affinity retarget BEFORE the mutation lock is resolved —
            # the lock key names the target, so the target must be final here.
            if name == ToolName.CHAT_COMPLETION.value and isinstance(arguments, dict):
                _cid = arguments.get("conversation_id")
                if _cid and getattr(_driver, "_current_conv_id", None) != _cid:
                    try:
                        await _driver.adopt_conversation_tab(_cid)
                    except Exception:
                        logger.debug(
                            "conv-tab adopt failed (handler navigates)",
                            exc_info=True,
                        )
            if name in _MUTATING_TOOLS and _lock_cdp_port is not None:
                # PR4/5: per-target MutationLock in parallel mode (port-wide
                # otherwise). Resolver raises OwnedTabRequiredError (→ isError)
                # if parallel mode has no owned target. When parallel mode is
                # OFF, use the cached port directly (legacy path).
                if _parallel_tabs:
                    _port, _key = resolve_mutation_lock(_driver, True)
                else:
                    _port, _key = _lock_cdp_port, None
                async with MutationLock(_port, _key):
                    # Drift guard (parallel mode only).
                    if _parallel_tabs:
                        _, _current_key = resolve_mutation_lock(_driver, True)
                        if _current_key != _key:
                            raise OwnedTabRequiredError(
                                "owned target changed while waiting for mutation lock"
                            )
                    result = await _run()
            else:
                result = await _run()
        except Exception as exc:
            # Shared exception mapping (extracted from inline chain for
            # singleton/pooled parity, PR #42 fix #2).
            mapped = _map_tool_exception(exc)
            if mapped is not None:
                return mapped
            raise

        # Shared result formatting (singleton/pooled parity, PR #42 fix #1).
        return _format_tool_result(name, result)

    # ── Resources (application-controlled) ────────────────────

    @server.list_resources()
    async def list_resources() -> list[mcp_types.Resource]:
        """List static resources — models and account info."""
        resources = [
            mcp_types.Resource(
                uri="chatgpt://models",
                name="Available Models",
                description="All ChatGPT model slugs available on the account",
                mimeType="application/json",
            ),
            mcp_types.Resource(
                uri="chatgpt://account",
                name="Account Info",
                description="Current ChatGPT account status and user info",
                mimeType="application/json",
            ),
        ]

        if _driver:
            try:
                projects = await _driver.get_projects()
                for p in projects:
                    if p.get("id"):
                        resources.append(
                            mcp_types.Resource(
                                uri=f"chatgpt://projects/{p['id']}",
                                name=p.get("name", "Unknown Project"),
                                description=(
                                    f"ChatGPT project: {p.get('name', 'Unknown')} "
                                    f"({p.get('memory_scope', 'project_v2')} memory)"
                                ),
                                mimeType="application/json",
                            )
                        )
            except Exception as e:
                logger.warning("Failed to list project resources: %s", e)

        return resources

    @server.list_resource_templates()
    async def list_resource_templates() -> list[mcp_types.ResourceTemplate]:
        """Declare URI templates for dynamic resource access."""
        return [
            mcp_types.ResourceTemplate(
                uriTemplate="chatgpt://projects/{project_id}",
                name="ChatGPT Project",
                description="Access a specific ChatGPT project by ID",
                mimeType="application/json",
            ),
        ]

    @server.read_resource()
    async def read_resource(
        request: mcp_types.ReadResourceRequest,
    ) -> str | list[mcp_types.ResourceContents]:
        """Read a specific resource by URI."""
        uri = str(request.params.uri)

        # B1: in pool mode, resources that need live data require a lease.
        # For B1, return a clear error rather than materializing — resource
        # reads are secondary to tool calls and should not eagerly create tabs.
        if _driver is None and _driver_pool is not None:
            raise ConnectionError(
                "Resource reads are not available in pool mode without an "
                "active session tab. Use a chat tool first to materialize a "
                "session driver, then retry. (mcp_pool_resource_unavailable)"
            )

        if _driver is None:
            raise ConnectionError("Not connected to Chrome")

        if uri == "chatgpt://models":
            models = await _driver.get_models()
            data = [{"id": m.get("slug", ""), "title": m.get("title", "")} for m in models]
            return json.dumps(data, ensure_ascii=False, indent=2)

        elif uri == "chatgpt://account":
            return json.dumps(
                {
                    "user": _driver._user_name,
                    "connected": _driver.is_connected,
                },
                ensure_ascii=False,
                indent=2,
            )

        elif uri.startswith("chatgpt://projects/"):
            project_id = uri.split("/")[-1]
            projects = await _driver.get_projects()
            for p in projects:
                if p.get("id") == project_id:
                    return json.dumps(p, ensure_ascii=False, indent=2)
            raise ValueError(f"Project not found: {project_id}")

        raise ValueError(f"Unknown resource URI: {uri}")

    # ── Prompts (user-controlled) ─────────────────────────────

    @server.list_prompts()
    async def list_prompts() -> list[mcp_types.Prompt]:
        return [
            mcp_types.Prompt(
                name="ask-chatgpt",
                description=(
                    "Send a question to ChatGPT with optional project context. "
                    "The model will use the chat_completion tool to get an answer."
                ),
                arguments=[
                    mcp_types.PromptArgument(
                        name="question",
                        description="The question to ask",
                        required=True,
                    ),
                    mcp_types.PromptArgument(
                        name="project",
                        description=(
                            "Project name or ID for scoped memory "
                            "(optional — uses default project if omitted)"
                        ),
                        required=False,
                    ),
                ],
            ),
            mcp_types.Prompt(
                name="continue-chat",
                description=(
                    "Continue the last conversation with a follow-up message. "
                    "Automatically uses the active conversation context."
                ),
                arguments=[
                    mcp_types.PromptArgument(
                        name="message",
                        description="Follow-up message to send",
                        required=True,
                    ),
                ],
            ),
        ]

    @server.get_prompt()
    async def get_prompt(
        request: mcp_types.GetPromptRequest,
    ) -> mcp_types.GetPromptResult:
        name = request.params.name
        args = request.params.arguments or {}

        if name == "ask-chatgpt":
            question = args.get("question", "")
            project = args.get("project", "")
            if not question:
                raise ValueError("question argument is required")

            tool_args: dict[str, Any] = {"message": question}

            if project and _driver:
                # B1: in pool mode, project resolution needs live data but
                # we don't allocate a tab for prompt resolution. Skip silently.
                pass  # falls through to no-project path
                try:
                    projects = await _driver.get_projects()
                    for p in projects:
                        if project.lower() in (
                            p.get("name", "").lower(),
                            p.get("id", "").lower(),
                        ):
                            tool_args["project_id"] = p["id"]
                            break
                except Exception as e:
                    logger.warning("Project resolution failed: %s", e)

            return mcp_types.GetPromptResult(
                description=f"Ask ChatGPT: {question[:60]}",
                messages=[
                    mcp_types.SamplingMessage(
                        role="user",
                        content=mcp_types.TextContent(
                            type="text",
                            text=(
                                f"Use the chat_completion tool to answer this question. "
                                f"Call it with these arguments:\n"
                                f"```json\n{json.dumps(tool_args, indent=2)}\n```\n\n"
                                f"Return the response content directly to the user."
                            ),
                        ),
                    ),
                ],
            )

        elif name == "continue-chat":
            message = args.get("message", "")
            if not message:
                raise ValueError("message argument is required")

            return mcp_types.GetPromptResult(
                description=f"Continue chat: {message[:60]}",
                messages=[
                    mcp_types.SamplingMessage(
                        role="user",
                        content=mcp_types.TextContent(
                            type="text",
                            text=(
                                f"Use the chat_completion tool with this message. "
                                f"Do NOT pass conversation_id — the tool will auto-continue "
                                f"the last conversation.\n\n"
                                f"Message: {message}"
                            ),
                        ),
                    ),
                ],
            )

        raise ValueError(f"Unknown prompt: {name}")

    # ── Completion (argument autocomplete) ────────────────────

    @server.completion()
    async def handle_completion(
        ref: mcp_types.PromptReference | mcp_types.ResourceTemplateReference,
        argument: mcp_types.CompletionArgument,
        context: mcp_types.CompletionContext | None,
    ) -> mcp_types.Completion | None:
        """Provide autocomplete suggestions for prompt arguments."""
        if isinstance(ref, mcp_types.PromptReference):
            # Autocomplete 'project' argument in ask-chatgpt prompt
            if ref.name == "ask-chatgpt" and argument.name == "project":
                if _driver:
                    try:
                        projects = await _driver.get_projects()
                        names = [p.get("name", "") for p in projects if p.get("name")]
                        # Filter by what user has typed
                        prefix = argument.value.lower()
                        matches = [n for n in names if prefix in n.lower()]
                        return mcp_types.Completion(
                            values=matches[:20],
                            total=len(matches),
                            hasMore=len(matches) > 20,
                        )
                    except Exception:
                        pass
        return None

    return server


# ═══════════════════════════════════════════════════════════════
# Transport Layer
# ═══════════════════════════════════════════════════════════════


def _mcp_server_identity(config: Config, transport: str, port: int) -> str:
    """Derive the tab-registry ``server_identity`` for MCP (PR4/5).

    Outside parallel mode this is the fixed ``"mcp"`` (legacy behavior). In
    parallel mode it must be unique per concurrent MCP process so two processes
    on the same CDP port don't collide on a tab-registry entry:

      - SSE: ``mcp:sse:{host}:{port}`` — unique AND stable across restart
        (host:port survives restart, so reclaim works). Mirrors REST's
        ``rest:{port}`` model.
      - stdio: ``mcp:stdio:{pid}`` — unique (one PID per process) but NOT stable
        across restart, so restart-reclaim is sacrificed. For the typical
        one-MCP-per-agent-session case, isolation beats reclaim; a leaked tab
        on restart is preferable to two sessions corrupting a shared lease.

    The result feeds ``TabRegistry.derive_instance_id``, which still honors
    ``W2A_INSTANCE_ID`` as the highest-priority override.
    """
    if not config.chatgpt.parallel_tabs:
        return "mcp"
    if transport == "sse":
        return f"mcp:sse:{config.server.host or '127.0.0.1'}:{port}"
    return f"mcp:stdio:{os.getpid()}"


async def run_mcp(config: Config, transport: str = "stdio", port: int = 8090) -> None:
    """Connect to Chrome and run the MCP server."""
    global _driver, _driver_pool, _config, _lock_cdp_port, _breakers, _parallel_tabs, _transport

    _config = config
    _lock_cdp_port = config.chrome.cdp_port
    _parallel_tabs = config.chatgpt.parallel_tabs
    _transport = transport

    if config.chatgpt.mcp_session_pool_enabled:
        # B1: pool mode. Do NOT connect to Chrome at startup. The pool
        # materializes one owned CDPDriver/tab per session on first request.
        from .mcp_driver_pool import McpSessionDriverPool

        _driver = None
        _breakers = None
        _driver_pool = McpSessionDriverPool(
            config, transport=transport, port=port,
        )
        await _driver_pool.start_sweeper()
        logger.info(
            "MCP session pool enabled (size=%d, ttl=%ds); drivers materialize on first request",
            config.chatgpt.mcp_session_pool_size,
            config.chatgpt.mcp_session_pool_ttl_seconds,
        )
    else:
        # Singleton mode: connect immediately (unchanged pre-B1 behavior).
        _driver_pool = None
        _breakers = BreakerRegistry()
        _driver = CDPDriver(
            cdp_port=config.chrome.cdp_port,
            tab_mode=config.chatgpt.tab_mode,
            instance_id=TabRegistry.derive_instance_id(
                cdp_port=config.chrome.cdp_port,
                server_identity=_mcp_server_identity(config, transport, port),
            ),
            breakers=_breakers,
            parallel_tabs=config.chatgpt.parallel_tabs,
            pace_send_seconds=config.chatgpt.request_pace_send_seconds,
            pace_read_seconds=config.chatgpt.request_pace_read_seconds,
            pace_cooldown_seconds=config.chatgpt.request_pace_cooldown_seconds,
        )
        try:
            # Local delta: harness-bound lifecycle — start Chrome on demand
            # instead of requiring the REST daemon to have launched it.
            from .chrome import ChromeProcess

            await ChromeProcess(config).ensure_running()
            await _driver.connect()
            logger.info("Connected to Chrome on CDP port %d", config.chrome.cdp_port)
        except Exception as e:
            logger.error(
                "Chrome unavailable on CDP port %d after auto-start attempt. "
                "Error: %s",
                config.chrome.cdp_port,
                e,
            )
            await _driver.close()
            return

    server = create_server()
    init_options = server.create_initialization_options()

    try:
        if transport == "stdio":
            async with stdio_server() as (read, write):
                await server.run(read, write, init_options, raise_exceptions=True)
        elif transport == "sse":
            await _run_sse(server, init_options, config, port)
    finally:
        if _driver_pool is not None:
            await _driver_pool.close_all()
        elif _driver is not None:
            await _driver.close()


async def _run_sse(server: Server, init_options, config: Config, port: int) -> None:
    """Run MCP server with SSE transport via Starlette + uvicorn.

    The MCP library's ``SseServerTransport`` is ASGI-native (built on
    ``sse_starlette``, designed for Starlette). The previous
    implementation tried to bridge aiohttp requests into ASGI scopes —
    that was broken since inception (``request.scope`` doesn't exist on
    aiohttp) and the aiohttp→ASGI rewrite couldn't flush SSE chunks to
    the wire. Instead of fighting the framework mismatch, we run a
    proper Starlette ASGI app under uvicorn for the SSE transport.

    The stdio transport is unaffected — it stays on its existing path.
    """
    import contextlib

    import uvicorn
    from mcp.server.sse import SseServerTransport
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from starlette.applications import Starlette
    from starlette.responses import Response
    from starlette.routing import Mount, Route

    warn_non_loopback(config.server.host, "SSE")

    sse = SseServerTransport("/messages")

    async def handle_sse(request):
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(streams[0], streams[1], init_options, raise_exceptions=True)
        return Response()

    # Streamable-HTTP transport on the same port: harnesses that cannot speak
    # legacy SSE (e.g. Codex's rmcp client only does stdio + streamable-http)
    # register url=http://127.0.0.1:8090/mcp instead of spawning a per-session
    # stdio server — one daemon, one driver pool, one mutation-lock regime.
    http_sessions = StreamableHTTPSessionManager(
        app=server,
        event_store=None,
        json_response=False,
        stateless=False,
    )

    @contextlib.asynccontextmanager
    async def lifespan(app):
        async with http_sessions.run():
            yield

    # handle_post_message is a raw ASGI app (scope, receive, send) that
    # sends its own HTTP response. Mount it directly — not as a Starlette
    # endpoint, which would try to wrap it in a second response. Same for
    # the streamable-http session manager's handle_request.
    app = Starlette(
        routes=[
            Route("/sse", endpoint=handle_sse, methods=["GET"]),
            Mount("/messages", app=sse.handle_post_message),
            Mount("/mcp", app=http_sessions.handle_request),
        ],
        lifespan=lifespan,
    )

    logger.info(
        "MCP SSE server on http://%s:%d/sse (streamable-http: /mcp)",
        config.server.host,
        port,
    )

    uconfig = uvicorn.Config(
        app,
        host=config.server.host,
        port=port,
        log_level="warning",
        loop="asyncio",
    )
    uvi = uvicorn.Server(uconfig)
    await uvi.serve()


# ═══════════════════════════════════════════════════════════════
# CLI Entry Point
# ═══════════════════════════════════════════════════════════════


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="chatgpt-web2api-mcp",
        description="MCP server for ChatGPT-Web2API",
    )
    parser.add_argument("--config", "-c", help="Config file path")
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse"],
        default="stdio",
        help="Transport layer (default: stdio)",
    )
    parser.add_argument("--port", type=int, default=8090, help="SSE port (default: 8090)")
    parser.add_argument("--cdp-port", type=int, help="Chrome CDP port (default: from config)")
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("mcp").setLevel(logging.WARNING)
    if args.transport == "sse":
        # Shared daemon: nobody reads its stderr. (stdio: the harness owns it.)
        from .diagnostics import attach_daemon_log

        attach_daemon_log(f"mcp-sse-{args.port}")

    # The owning host captures stderr. This receipt lets an operator match
    # an actual host child PID to the loaded source without substituting a
    # separately launched smoke-test process. No credentials or chat data.
    from .runtime_info import get_runtime_info

    logger.info("MCP runtime identity: %s", json.dumps(get_runtime_info(), sort_keys=True))

    config = Config.load(args.config)
    if args.cdp_port:
        config.chrome.cdp_port = args.cdp_port

    try:
        asyncio.run(run_mcp(config, transport=args.transport, port=args.port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
