"""Claude Agent SDK engine — full tool support via API billing."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from remi.engines.base import AgentResponse

logger = logging.getLogger(__name__)


@dataclass
class ClaudeSDKEngine:
    """Engine using the Claude Agent SDK (claude-agent-sdk package)."""

    model: str = "claude-sonnet-4-5-20250929"
    max_turns: int = 10
    timeout: int = 300

    def __post_init__(self) -> None:
        try:
            from claude_agent_sdk import ClaudeSDKClient

            self._client_cls = ClaudeSDKClient
        except ImportError:
            raise ImportError(
                "claude-agent-sdk package required. Install with: uv pip install 'remi[sdk]'"
            )

    @property
    def name(self) -> str:
        return "claude_sdk"

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

        kwargs: dict = {
            "prompt": full_prompt,
            "model": self.model,
            "max_turns": self.max_turns,
        }
        if system_prompt:
            kwargs["system_prompt"] = system_prompt
        if cwd:
            kwargs["cwd"] = cwd
        if session_id:
            kwargs["session_id"] = session_id

        try:
            client = self._client_cls()
            result = await asyncio.to_thread(client.process, **kwargs)
        except Exception as e:
            logger.error("Claude SDK error: %s", e)
            return AgentResponse(text=f"[Claude SDK error: {e}]")

        return AgentResponse(
            text=getattr(result, "response", str(result)),
            session_id=getattr(result, "session_id", None),
            cost_usd=getattr(result, "cost_usd", None),
            model=self.model,
        )

    async def health_check(self) -> bool:
        try:
            self._client_cls()
            return True
        except Exception:
            return False
