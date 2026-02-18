"""Connector protocol and shared types."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Coroutine, Protocol, runtime_checkable

if TYPE_CHECKING:
    from remi.engines.base import AgentResponse


@dataclass
class IncomingMessage:
    """A message received from any connector."""

    text: str
    chat_id: str
    sender: str = ""
    connector_name: str = ""
    metadata: dict = field(default_factory=dict)


# Callback type: core.Remi.handle_message
MessageHandler = Callable[[IncomingMessage], Coroutine[None, None, "AgentResponse"]]


@runtime_checkable
class Connector(Protocol):
    """Protocol that all input connectors must implement."""

    @property
    def name(self) -> str: ...

    async def start(self, handler: MessageHandler) -> None:
        """Start listening for messages. Call handler for each incoming message."""
        ...

    async def stop(self) -> None:
        """Gracefully stop the connector."""
        ...

    async def reply(self, chat_id: str, response: "AgentResponse") -> None:
        """Send a response back to the given chat."""
        ...
