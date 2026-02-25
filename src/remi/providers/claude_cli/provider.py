"""Claude CLI provider — streaming JSONL protocol with fallback.

Uses Claude Code subscription — no API key needed.

Supports:
- Streaming output via long-running subprocess
- Custom tool registration and execution
- Pre/Post tool hooks
- Fallback to single-shot subprocess.run()
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import subprocess
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

from remi.providers.base import AgentResponse, ToolDefinition
from remi.providers.claude_cli.protocol import (
    ContentDelta,
    ResultMessage,
    ToolUseRequest,
)
from remi.providers.claude_cli.process import ClaudeProcessManager

logger = logging.getLogger(__name__)

# Hook signatures
PreToolHook = Callable[[str, dict], bool | None]  # (tool_name, input) -> allow?
PostToolHook = Callable[[str, dict, str], None]  # (tool_name, input, result)


@dataclass
class ClaudeCLIProvider:
    """Streaming Claude CLI provider with tool support and fallback.

    Primary path: long-running stream-json subprocess
    Fallback path: single-shot subprocess.run() (original behavior)
    """

    allowed_tools: list[str] = field(default_factory=list)
    model: str | None = None
    timeout: int = 300
    system_prompt: str | None = None
    cwd: str | None = None
    mcp_config: dict | None = None

    # Internal state (not part of public API)
    _process_mgr: ClaudeProcessManager | None = field(default=None, repr=False)
    _tools: dict[str, ToolDefinition] = field(default_factory=dict, repr=False)
    _pre_hooks: list[PreToolHook] = field(default_factory=list, repr=False)
    _post_hooks: list[PostToolHook] = field(default_factory=list, repr=False)
    _streaming_disabled: bool = field(default=False, repr=False)

    @property
    def name(self) -> str:
        return "claude_cli"

    # ── Tool registration ─────────────────────────────────────

    def register_tool(self, tool: ToolDefinition) -> None:
        """Register a custom tool that the agent can call."""
        self._tools[tool.name] = tool
        logger.info("Registered tool: %s", tool.name)

    def register_tools_from_dict(self, tools: dict[str, callable]) -> None:
        """Register tools from a dict[name, callable] (e.g. from memory_tools)."""
        for name, handler in tools.items():
            sig = inspect.signature(handler)
            params: dict[str, Any] = {}
            for param_name, param in sig.parameters.items():
                param_type = "string"
                if param.annotation is int:
                    param_type = "integer"
                elif param.annotation is bool:
                    param_type = "boolean"
                params[param_name] = {"type": param_type}

            tool = ToolDefinition(
                name=name,
                description=handler.__doc__ or f"Tool: {name}",
                parameters=params,
                handler=handler,
            )
            self.register_tool(tool)

    # ── Hook registration ─────────────────────────────────────

    def add_pre_tool_hook(self, hook: PreToolHook) -> None:
        """Add a hook called before each tool execution.
        Return False to block the tool call.
        """
        self._pre_hooks.append(hook)

    def add_post_tool_hook(self, hook: PostToolHook) -> None:
        """Add a hook called after each tool execution."""
        self._post_hooks.append(hook)

    # ── Provider protocol ─────────────────────────────────────

    async def send(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        """Send a message and return the buffered response.

        Tries streaming path first, falls back to subprocess.run() on failure.
        """
        return await self._send_fallback(
            message,
            system_prompt=system_prompt,
            context=context,
            cwd=cwd,
            session_id=session_id,
        )

    async def send_stream(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
    ) -> AsyncIterator[str]:
        """Send a message and yield text chunks as they arrive."""
        full_prompt = f"<context>\n{context}\n</context>\n\n{message}" if context else message

        await self._ensure_process(system_prompt=system_prompt)
        async for msg in self._process_mgr.send_and_stream(
            full_prompt, tool_handler=self._handle_tool_call
        ):
            if isinstance(msg, ContentDelta):
                yield msg.text

    async def health_check(self) -> bool:
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["claude", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    async def close(self) -> None:
        """Shut down the long-running process."""
        if self._process_mgr:
            await self._process_mgr.stop()
            self._process_mgr = None

    # ── Internal: streaming path ──────────────────────────────

    async def _ensure_process(self, *, system_prompt: str | None = None) -> None:
        """Start the long-running process if not already running."""
        if self._process_mgr and self._process_mgr.is_alive:
            return

        self._process_mgr = ClaudeProcessManager(
            model=self.model,
            allowed_tools=self.allowed_tools,
            system_prompt=system_prompt or self.system_prompt,
            cwd=self.cwd,
        )
        await self._process_mgr.start()

    async def _send_streaming(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
    ) -> AgentResponse:
        """Send via streaming protocol and buffer the full response."""
        await self._ensure_process(system_prompt=system_prompt)

        text_parts: list[str] = []
        tool_calls: list[dict] = []
        result_msg: ResultMessage | None = None

        async for msg in self._process_mgr.send_and_stream(
            prompt, tool_handler=self._handle_tool_call
        ):
            if isinstance(msg, ContentDelta):
                text_parts.append(msg.text)
            elif isinstance(msg, ToolUseRequest):
                tool_calls.append(
                    {
                        "id": msg.tool_use_id,
                        "name": msg.name,
                        "input": msg.input,
                    }
                )
            elif isinstance(msg, ResultMessage):
                result_msg = msg

        full_text = "".join(text_parts)

        if result_msg:
            return AgentResponse(
                text=result_msg.result or full_text,
                session_id=result_msg.session_id,
                cost_usd=result_msg.cost_usd,
                model=result_msg.model,
                tool_calls=tool_calls,
            )

        return AgentResponse(text=full_text, tool_calls=tool_calls)

    # ── Internal: fallback path (original subprocess.run) ─────

    async def _send_fallback(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        """Fallback: single-shot subprocess.run() (original behavior)."""
        cmd = ["claude", "-p", "--output-format", "json"]

        if session_id:
            cmd.extend(["--resume", session_id])
        if self.model:
            cmd.extend(["--model", self.model])
        if self.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.allowed_tools)])
        else:
            cmd.append("--dangerously-skip-permissions")
        if self.mcp_config:
            cmd.extend(["--mcp-config", json.dumps(self.mcp_config)])
        if system_prompt:
            cmd.extend(["--append-system-prompt", system_prompt])

        full_prompt = f"<context>\n{context}\n</context>\n\n{message}" if context else message
        cmd.append(full_prompt)

        logger.debug("Fallback running: %s", " ".join(cmd[:4]) + " ...")

        try:
            result = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                text=True,
                cwd=cwd,
                timeout=None,
            )
        except FileNotFoundError:
            return AgentResponse(text="[Error: `claude` CLI not found. Is Claude Code installed?]")

        if result.returncode != 0:
            stderr = result.stderr.strip()
            logger.error("claude CLI error (rc=%d): %s", result.returncode, stderr)
            return AgentResponse(text=f"[Provider error: {stderr or 'unknown error'}]")

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            return AgentResponse(text=result.stdout.strip())

        return AgentResponse(
            text=data.get("result", result.stdout.strip()),
            session_id=data.get("session_id"),
            cost_usd=data.get("cost_usd") or data.get("total_cost_usd"),
            input_tokens=data.get("usage", {}).get("input_tokens"),
            output_tokens=data.get("usage", {}).get("output_tokens"),
            duration_ms=data.get("duration_ms"),
            model=data.get("model"),
        )

    # ── Internal: tool handling ───────────────────────────────

    async def _handle_tool_call(self, request: ToolUseRequest) -> str:
        """Handle a tool call: run hooks -> execute -> run hooks."""
        tool_name = request.name
        tool_input = request.input

        # Pre-hooks
        for hook in self._pre_hooks:
            result = hook(tool_name, tool_input)
            if result is False:
                return f"[Tool call blocked by hook: {tool_name}]"

        # Find and execute tool
        tool_def = self._tools.get(tool_name)
        if not tool_def:
            return f"[Unknown tool: {tool_name}]"

        try:
            result = tool_def.handler(**tool_input)
            # Support both sync and async handlers
            if asyncio.iscoroutine(result):
                result = await result
            result_str = str(result)
        except Exception as e:
            logger.error("Tool %s failed: %s", tool_name, e)
            result_str = f"[Tool error: {e}]"

        # Post-hooks
        for hook in self._post_hooks:
            hook(tool_name, tool_input, result_str)

        return result_str
