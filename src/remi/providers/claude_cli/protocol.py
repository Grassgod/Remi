"""JSONL streaming protocol — message types + parse/format (no I/O).

Handles the Claude CLI stream-json protocol:
- Parse: stdout JSONL lines -> typed dataclasses
- Format: typed data -> stdin JSONL strings
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


# ── Parsed message types (CLI stdout -> Remi) ─────────────────


@dataclass
class SystemMessage:
    """type=system, subtype=init — first line after CLI startup."""

    session_id: str
    tools: list[dict[str, Any]] = field(default_factory=list)
    model: str = ""
    mcp_servers: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ContentDelta:
    """type=content_block_delta, delta.type=text_delta — streaming text chunk."""

    text: str
    index: int = 0


@dataclass
class ToolUseRequest:
    """Tool call from the assistant — parsed from content_block_start or assistant message."""

    tool_use_id: str
    name: str
    input: dict[str, Any] = field(default_factory=dict)


@dataclass
class ResultMessage:
    """type=result — final message marking end of a turn."""

    result: str
    session_id: str = ""
    cost_usd: float | None = None
    model: str = ""
    is_error: bool = False
    duration_ms: int | None = None


# Union type for all parsed messages
ParsedMessage = SystemMessage | ContentDelta | ToolUseRequest | ResultMessage | dict


# ── Parsing (stdout line -> typed message) ─────────────────────


def parse_line(line: str) -> ParsedMessage:
    """Parse a single JSONL line from CLI stdout into a typed message.

    Returns the appropriate dataclass for known message types,
    or the raw dict for unrecognized types.
    """
    data = json.loads(line)
    msg_type = data.get("type", "")

    # System init
    if msg_type == "system" and data.get("subtype") == "init":
        return SystemMessage(
            session_id=data.get("session_id", ""),
            tools=data.get("tools", []),
            model=data.get("model", ""),
            mcp_servers=data.get("mcp_servers", []),
        )

    # Streaming text delta (only text_delta, not input_json_delta)
    if msg_type == "content_block_delta":
        delta = data.get("delta", {})
        if delta.get("type") == "text_delta":
            return ContentDelta(
                text=delta.get("text", ""),
                index=data.get("index", 0),
            )
        # input_json_delta and others: return raw dict for accumulation
        return data

    # Tool use start (streaming content_block_start)
    if msg_type == "content_block_start":
        block = data.get("content_block", {})
        if block.get("type") == "tool_use":
            return ToolUseRequest(
                tool_use_id=block.get("id", ""),
                name=block.get("name", ""),
                input=block.get("input", {}),
            )
        return data

    # Assistant message with complete tool_use blocks (non-streaming path)
    if msg_type == "assistant":
        message = data.get("message", {})
        content = message.get("content", [])
        tool_blocks = [b for b in content if b.get("type") == "tool_use"]
        if tool_blocks:
            block = tool_blocks[0]
            return ToolUseRequest(
                tool_use_id=block.get("id", ""),
                name=block.get("name", ""),
                input=block.get("input", {}),
            )
        return data

    # Result (end of turn)
    if msg_type == "result":
        return ResultMessage(
            result=data.get("result", ""),
            session_id=data.get("session_id", ""),
            cost_usd=data.get("cost_usd"),
            model=data.get("model", ""),
            is_error=data.get("is_error", False),
            duration_ms=data.get("duration_ms"),
        )

    return data


# ── Formatting (Remi -> CLI stdin) ─────────────────────────────


def format_user_message(text: str) -> str:
    """Format a user message for CLI stdin (JSONL string, no trailing newline)."""
    return json.dumps(
        {
            "type": "user",
            "message": {"role": "user", "content": text},
        }
    )


def format_tool_result(tool_use_id: str, result: str, is_error: bool = False) -> str:
    """Format a tool result for CLI stdin (JSONL string, no trailing newline)."""
    return json.dumps(
        {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": result,
            "is_error": is_error,
        }
    )
