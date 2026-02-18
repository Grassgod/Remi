"""Provider protocol and shared types."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# Callback for streaming text chunks
StreamCallback = Callable[[str], None]


@dataclass
class ToolDefinition:
    """Custom tool that the agent can call, handled within Remi."""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., str]


@dataclass
class AgentResponse:
    """Response from an AI provider."""

    text: str
    session_id: str | None = None
    cost_usd: float | None = None
    model: str | None = None
    metadata: dict = field(default_factory=dict)
    tool_calls: list[dict] = field(default_factory=list)


@runtime_checkable
class Provider(Protocol):
    """Protocol that all provider backends must implement."""

    @property
    def name(self) -> str: ...

    async def send(
        self,
        message: str,
        *,
        system_prompt: str | None = None,
        context: str | None = None,
        cwd: str | None = None,
        session_id: str | None = None,
    ) -> AgentResponse:
        """Send a message to the provider and return the response."""
        ...

    async def health_check(self) -> bool:
        """Check if the provider is available. Returns True if healthy."""
        ...
