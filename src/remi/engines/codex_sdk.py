"""Codex SDK engine — OpenAI models with full tool support.

Uses the `openai-codex-sdk` package which wraps the Codex CLI binary
via subprocess, similar to how `claude-agent-sdk` wraps Claude CLI.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from remi.engines.base import AgentResponse

logger = logging.getLogger(__name__)


@dataclass
class CodexSDKEngine:
    """Engine using the OpenAI Codex SDK (openai-codex-sdk package)."""

    model: str | None = None
    timeout: int = 300

    def __post_init__(self) -> None:
        try:
            from openai_codex_sdk import Codex

            self._codex_cls = Codex
        except ImportError:
            raise ImportError(
                "openai-codex-sdk package required. Install with: "
                "uv pip install 'remi[codex]'"
            )

    @property
    def name(self) -> str:
        return "codex_sdk"

    async def send(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        from openai_codex_sdk import Codex

        full_prompt = f"<context>\n{context}\n</context>\n\n{message}" if context else message

        try:
            codex = Codex()
            thread_opts = {}
            if cwd:
                thread_opts["working_directory"] = cwd

            if session_id:
                thread = codex.resume_thread(session_id)
            else:
                thread = codex.start_thread(thread_opts or None)

            turn = await asyncio.wait_for(
                thread.run(full_prompt),
                timeout=self.timeout,
            )

            return AgentResponse(
                text=turn.final_response or "",
                session_id=getattr(thread, "id", None),
                model=self.model,
            )
        except asyncio.TimeoutError:
            return AgentResponse(text="[Engine timeout — Codex SDK did not respond in time.]")
        except Exception as e:
            logger.error("Codex SDK error: %s", e)
            return AgentResponse(text=f"[Codex SDK error: {e}]")

    async def health_check(self) -> bool:
        try:
            self._codex_cls()
            return True
        except Exception:
            return False
