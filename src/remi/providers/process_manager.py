"""Long-running Claude CLI subprocess manager.

Manages the lifecycle of a `claude --input-format stream-json --output-format stream-json`
subprocess, providing async streaming I/O with tool call handling.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from remi.providers.jsonl_protocol import (
    ContentDelta,
    ParsedMessage,
    ResultMessage,
    SystemMessage,
    ToolUseRequest,
    format_tool_result,
    format_user_message,
    parse_line,
)

logger = logging.getLogger(__name__)

# Tool handler: async (ToolUseRequest) -> str
ToolHandler = Callable[[ToolUseRequest], Awaitable[str]]


class ClaudeProcessManager:
    """Manages a long-running Claude CLI subprocess with stream-json protocol."""

    def __init__(
        self,
        *,
        model: str | None = None,
        allowed_tools: list[str] | None = None,
        system_prompt: str | None = None,
        cwd: str | None = None,
    ) -> None:
        self.model = model
        self.allowed_tools = allowed_tools or []
        self.system_prompt = system_prompt
        self.cwd = cwd
        self._process: asyncio.subprocess.Process | None = None
        self._session_id: str | None = None
        self._lock = asyncio.Lock()
        self._started = False

    @property
    def is_alive(self) -> bool:
        return self._process is not None and self._process.returncode is None

    @property
    def session_id(self) -> str | None:
        return self._session_id

    def _build_command(self) -> list[str]:
        cmd = [
            "claude",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ]
        if self.model:
            cmd.extend(["--model", self.model])
        if self.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.allowed_tools)])
        if self.system_prompt:
            cmd.extend(["--append-system-prompt", self.system_prompt])
        return cmd

    async def start(self) -> SystemMessage:
        """Start the CLI subprocess and wait for the system init message."""
        if self.is_alive:
            raise RuntimeError("Process already running")

        cmd = self._build_command()
        logger.debug("Starting: %s", " ".join(cmd[:6]) + " ...")

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
        )

        # Wait for system init message
        init_msg = await self._read_until_type(SystemMessage)
        if not isinstance(init_msg, SystemMessage):
            raise RuntimeError(f"Expected SystemMessage, got: {type(init_msg)}")

        self._session_id = init_msg.session_id
        self._started = True
        logger.info(
            "CLI process started (pid=%d, session=%s)",
            self._process.pid,
            self._session_id,
        )
        return init_msg

    async def send_and_stream(
        self,
        text: str,
        tool_handler: ToolHandler | None = None,
    ) -> AsyncIterator[ParsedMessage]:
        """Send a user message and stream back parsed responses.

        Handles tool calls internally: when a ToolUseRequest is complete,
        calls tool_handler and writes the result back to stdin.

        Yields ContentDelta, ToolUseRequest (for tracking), and ResultMessage events.
        """
        async with self._lock:
            if not self.is_alive:
                raise RuntimeError("Process not running — call start() first")

            # Send user message
            await self._write_line(format_user_message(text))

            # Stream responses, handling tool calls inline
            pending_tool: ToolUseRequest | None = None
            input_chunks: list[str] = []

            while True:
                line = await self._readline()
                if line is None:
                    break

                msg = parse_line(line)

                # Tool use start (streaming — input comes via deltas)
                if isinstance(msg, ToolUseRequest) and not msg.input:
                    pending_tool = msg
                    input_chunks = []
                    continue

                # Tool use with complete input (non-streaming assistant message)
                if isinstance(msg, ToolUseRequest) and msg.input:
                    yield msg  # yield for tracking
                    if tool_handler:
                        result_text = await tool_handler(msg)
                        await self._write_line(
                            format_tool_result(msg.tool_use_id, result_text)
                        )
                    continue

                # Input JSON delta accumulation
                if isinstance(msg, dict) and msg.get("type") == "content_block_delta":
                    delta = msg.get("delta", {})
                    if delta.get("type") == "input_json_delta" and pending_tool:
                        input_chunks.append(delta.get("partial_json", ""))
                        continue

                # Content block stop — finalize pending tool if any
                if isinstance(msg, dict) and msg.get("type") == "content_block_stop":
                    if pending_tool:
                        # Parse accumulated input
                        full_json = "".join(input_chunks)
                        if full_json:
                            try:
                                pending_tool.input = json.loads(full_json)
                            except json.JSONDecodeError:
                                logger.warning(
                                    "Failed to parse tool input: %s", full_json[:200]
                                )

                        yield pending_tool  # yield for tracking
                        # Call tool handler and write result back
                        if tool_handler:
                            result_text = await tool_handler(pending_tool)
                            await self._write_line(
                                format_tool_result(pending_tool.tool_use_id, result_text)
                            )

                        pending_tool = None
                        input_chunks = []
                    continue

                # Text delta
                if isinstance(msg, ContentDelta):
                    yield msg
                    continue

                # Result — end of turn
                if isinstance(msg, ResultMessage):
                    self._session_id = msg.session_id or self._session_id
                    yield msg
                    return

                # Other events (content_block_start for text, etc.) — skip

    async def stop(self) -> None:
        """Gracefully stop the CLI subprocess."""
        if not self._process:
            return

        if self.is_alive:
            logger.info("Stopping CLI process (pid=%d)", self._process.pid)
            try:
                self._process.stdin.close()
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning("CLI process didn't exit gracefully, terminating")
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    self._process.kill()

        self._process = None
        self._started = False
        logger.info("CLI process stopped")

    # ── Internal I/O helpers ──────────────────────────────────

    async def _readline(self) -> str | None:
        """Read a single non-empty line from stdout. Returns None on EOF."""
        if not self._process or not self._process.stdout:
            return None
        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    return None
                decoded = line.decode().strip()
                if decoded:
                    logger.debug("< %s", decoded[:200])
                    return decoded
                # Empty line — keep reading
        except Exception:
            return None

    async def _write_line(self, data: str) -> None:
        """Write a JSONL line to stdin."""
        if not self._process or not self._process.stdin:
            raise RuntimeError("Process stdin not available")
        logger.debug("> %s", data[:200])
        self._process.stdin.write((data + "\n").encode())
        await self._process.stdin.drain()

    async def _read_until_type(
        self, target_type: type, timeout: float = 30.0
    ) -> ParsedMessage:
        """Read lines until a message of the target type is found."""

        async def _read() -> ParsedMessage:
            while True:
                line = await self._readline()
                if line is None:
                    raise RuntimeError(
                        "Process stdout closed before receiving expected message"
                    )
                msg = parse_line(line)
                if isinstance(msg, target_type):
                    return msg

        return await asyncio.wait_for(_read(), timeout=timeout)
