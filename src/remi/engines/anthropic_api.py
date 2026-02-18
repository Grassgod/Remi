"""Anthropic API engine — lightweight, no tool use."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from remi.engines.base import AgentResponse

logger = logging.getLogger(__name__)


@dataclass
class AnthropicAPIEngine:
    """Direct Anthropic API via the `anthropic` SDK. Pure conversation, no tools."""

    model: str = "claude-sonnet-4-5-20250929"
    max_tokens: int = 4096
    timeout: int = 120

    def __post_init__(self) -> None:
        try:
            import anthropic

            self._client = anthropic.Anthropic()
        except ImportError:
            raise ImportError(
                "anthropic package required. Install with: uv pip install 'remi[api]'"
            )

    @property
    def name(self) -> str:
        return "anthropic_api"

    async def send(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        import asyncio

        full_prompt = f"<context>\n{context}\n</context>\n\n{message}" if context else message

        messages = [{"role": "user", "content": full_prompt}]
        kwargs: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": messages,
        }
        if system_prompt:
            kwargs["system"] = system_prompt

        try:
            response = await asyncio.to_thread(self._client.messages.create, **kwargs)
        except Exception as e:
            logger.error("Anthropic API error: %s", e)
            return AgentResponse(text=f"[Anthropic API error: {e}]")

        text = response.content[0].text if response.content else ""
        cost = None
        if response.usage:
            # Approximate cost (Sonnet pricing)
            cost = (response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1e6

        return AgentResponse(
            text=text,
            cost_usd=cost,
            model=response.model,
        )

    async def health_check(self) -> bool:
        try:
            import asyncio

            response = await asyncio.to_thread(
                self._client.messages.create,
                model=self.model,
                max_tokens=10,
                messages=[{"role": "user", "content": "ping"}],
            )
            return bool(response.content)
        except Exception:
            return False
