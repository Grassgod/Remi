"""OpenAI Codex CLI engine — wraps the `codex` CLI."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
from dataclasses import dataclass

from remi.engines.base import AgentResponse

logger = logging.getLogger(__name__)


@dataclass
class OpenAICodexEngine:
    """Subprocess wrapper around the `codex` CLI."""

    timeout: int = 300

    @property
    def name(self) -> str:
        return "openai_codex"

    async def send(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        full_prompt = f"<context>\n{context}\n</context>\n\n{message}" if context else message

        cmd = ["codex", "--quiet", "--full-auto", full_prompt]

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
            return AgentResponse(text="[Engine timeout — Codex CLI did not respond in time.]")
        except FileNotFoundError:
            return AgentResponse(text="[Error: `codex` CLI not found. Is it installed?]")

        if result.returncode != 0:
            stderr = result.stderr.strip()
            logger.error("codex CLI error (rc=%d): %s", result.returncode, stderr)
            return AgentResponse(text=f"[Engine error: {stderr or 'unknown error'}]")

        # Try JSON parse, fallback to raw text
        try:
            data = json.loads(result.stdout)
            return AgentResponse(
                text=data.get("result", result.stdout.strip()),
                model=data.get("model"),
            )
        except json.JSONDecodeError:
            return AgentResponse(text=result.stdout.strip())

    async def health_check(self) -> bool:
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["codex", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
