"""Engine protocol and shared types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class AgentResponse:
    """Response from an AI engine."""

    text: str
    session_id: str | None = None
    cost_usd: float | None = None
    model: str | None = None
    metadata: dict = field(default_factory=dict)


@runtime_checkable
class Engine(Protocol):
    """Protocol that all engine backends must implement."""

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
        """Send a message to the engine and return the response."""
        ...

    async def health_check(self) -> bool:
        """Check if the engine is available. Returns True if healthy."""
        ...
