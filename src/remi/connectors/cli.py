"""Local CLI REPL connector for development and testing."""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import TYPE_CHECKING

from remi.connectors.base import IncomingMessage

if TYPE_CHECKING:
    from remi.connectors.base import MessageHandler
    from remi.engines.base import AgentResponse

logger = logging.getLogger(__name__)

_CLI_CHAT_ID = "cli"
_CLI_SENDER = "user"


class CLIConnector:
    """Interactive REPL connector — reads from stdin, writes to stdout."""

    def __init__(self) -> None:
        self._running = False

    @property
    def name(self) -> str:
        return "cli"

    async def start(self, handler: MessageHandler) -> None:
        self._running = True
        loop = asyncio.get_event_loop()

        print("Remi AI Assistant (type 'exit' or Ctrl+C to quit)")
        print("-" * 48)

        while self._running:
            try:
                line = await loop.run_in_executor(None, self._read_input)
            except (EOFError, KeyboardInterrupt):
                print("\nBye!")
                break

            if line is None or line.strip().lower() in ("exit", "quit"):
                print("Bye!")
                break

            text = line.strip()
            if not text:
                continue

            msg = IncomingMessage(
                text=text,
                chat_id=_CLI_CHAT_ID,
                sender=_CLI_SENDER,
                connector_name=self.name,
            )

            response = await handler(msg)
            await self.reply(_CLI_CHAT_ID, response)

    def _read_input(self) -> str | None:
        try:
            return input("\nYou: ")
        except EOFError:
            return None

    async def stop(self) -> None:
        self._running = False

    async def reply(self, chat_id: str, response: AgentResponse) -> None:
        print(f"\nRemi: {response.text}")
        if response.cost_usd is not None:
            print(f"  [cost: ${response.cost_usd:.4f}]", file=sys.stderr)
