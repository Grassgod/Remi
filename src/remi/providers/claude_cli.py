"""Claude CLI provider — wraps `claude -p` using Claude Code subscription."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from dataclasses import dataclass, field

from remi.providers.base import AgentResponse

logger = logging.getLogger(__name__)


@dataclass
class ClaudeCLIProvider:
    """Subprocess wrapper around `claude -p --output-format json`.

    Uses your Claude Code subscription — no API key needed.
    """

    allowed_tools: list[str] = field(default_factory=list)
    mcp_config: dict | None = None
    model: str | None = None
    timeout: int = 300

    @property
    def name(self) -> str:
        return "claude_cli"

    async def send(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        cmd = ["claude", "-p", "--output-format", "json"]

        if session_id:
            cmd.extend(["--resume", session_id])
        if self.model:
            cmd.extend(["--model", self.model])
        if self.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.allowed_tools)])
        if self.mcp_config:
            cmd.extend(["--mcp-config", json.dumps(self.mcp_config)])
        if system_prompt:
            cmd.extend(["--append-system-prompt", system_prompt])

        # Inject memory context into prompt
        full_prompt = f"<context>\n{context}\n</context>\n\n{message}" if context else message
        cmd.append(full_prompt)

        logger.debug("Running: %s", " ".join(cmd[:4]) + " ...")

        try:
            result = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                text=True,
                cwd=cwd,
                timeout=self.timeout,
            )
        except subprocess.TimeoutExpired:
            return AgentResponse(text="[Provider timeout — Claude CLI did not respond in time.]")
        except FileNotFoundError:
            return AgentResponse(
                text="[Error: `claude` CLI not found. Is Claude Code installed?]"
            )

        if result.returncode != 0:
            stderr = result.stderr.strip()
            logger.error("claude CLI error (rc=%d): %s", result.returncode, stderr)
            return AgentResponse(text=f"[Provider error: {stderr or 'unknown error'}]")

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            # Fallback: treat raw stdout as plain text
            return AgentResponse(text=result.stdout.strip())

        return AgentResponse(
            text=data.get("result", result.stdout.strip()),
            session_id=data.get("session_id"),
            cost_usd=data.get("cost_usd") or data.get("total_cost_usd"),
            model=data.get("model"),
        )

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
