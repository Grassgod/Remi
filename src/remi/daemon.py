"""Daemon process — always-on mode for production.

Usage: python -m remi serve

Manages:
- Connector lifecycle (Feishu webhook, etc.)
- Scheduler (heartbeat, memory compaction, reminders)
- PID file (prevent duplicate instances)
- Graceful shutdown (SIGTERM/SIGINT)
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from remi.config import RemiConfig, load_config
from remi.core import Remi
from remi.providers.claude_cli import ClaudeCLIProvider
from remi.scheduler.jobs import Scheduler

logger = logging.getLogger(__name__)


class RemiDaemon:
    """Always-on daemon process."""

    def __init__(self, config: RemiConfig | None = None) -> None:
        self.config = config or load_config()
        self._shutdown_event = asyncio.Event()

    # ── PID file management ──────────────────────────────────

    def _write_pid(self) -> None:
        self.config.pid_file.parent.mkdir(parents=True, exist_ok=True)
        self.config.pid_file.write_text(str(os.getpid()))
        logger.info("PID file written: %s (pid=%d)", self.config.pid_file, os.getpid())

    def _remove_pid(self) -> None:
        if self.config.pid_file.exists():
            self.config.pid_file.unlink()

    def _check_existing(self) -> None:
        if not self.config.pid_file.exists():
            return
        try:
            pid = int(self.config.pid_file.read_text().strip())
            os.kill(pid, 0)  # Check if process exists
            print(f"Remi daemon already running (pid={pid}). Exiting.", file=sys.stderr)
            sys.exit(1)
        except (ProcessLookupError, ValueError):
            # Stale PID file — remove it
            self._remove_pid()

    # ── Signal handling ──────────────────────────────────────

    def _setup_signals(self) -> None:
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_signal, sig)

    def _handle_signal(self, sig: signal.Signals) -> None:
        logger.info("Received %s, shutting down...", sig.name)
        self._shutdown_event.set()

    # ── Build components ─────────────────────────────────────

    def _build_remi(self) -> Remi:
        remi = Remi(self.config)

        # Register providers
        provider = self._build_provider()
        remi.add_provider(provider)

        # Register memory tools on provider (if supported)
        self._register_memory_tools(provider, remi)

        # Register fallback if configured
        if self.config.provider.fallback:
            try:
                fallback = self._build_provider(self.config.provider.fallback)
                remi.add_provider(fallback)
            except Exception as e:
                logger.warning("Failed to build fallback provider: %s", e)

        return remi

    def _register_memory_tools(self, provider, remi: Remi) -> None:
        """Register memory tools on a provider that supports tool registration."""
        register = getattr(provider, "register_tools_from_dict", None)
        if not register:
            return

        try:
            from remi.tools.memory_tools import get_memory_tools

            tools = get_memory_tools(remi.memory)
            register(tools)
            logger.info("Registered %d memory tools on %s", len(tools), provider.name)
        except Exception as e:
            logger.warning("Failed to register memory tools: %s", e)

    def _build_provider(self, name: str | None = None):
        name = name or self.config.provider.name
        if name == "claude_cli":
            return ClaudeCLIProvider(
                model=self.config.provider.model,
                timeout=self.config.provider.timeout,
                allowed_tools=self.config.provider.allowed_tools,
            )
        else:
            raise ValueError(f"Unknown provider: {name}")

    def _build_connectors(self, remi: Remi) -> None:
        if self.config.feishu.app_id:
            try:
                from remi.connectors.feishu import FeishuConnector

                connector = FeishuConnector(self.config.feishu)
                remi.add_connector(connector)
            except ImportError:
                logger.warning("Feishu connector unavailable (install 'remi[feishu]')")

    # ── Main run loop ────────────────────────────────────────

    async def run(self) -> None:
        self._check_existing()
        self._write_pid()
        self._setup_signals()

        remi = self._build_remi()
        self._build_connectors(remi)

        scheduler = Scheduler(remi, self.config)

        logger.info("Remi daemon starting (provider=%s)", self.config.provider.name)

        try:
            await asyncio.gather(
                remi.start(),
                scheduler.start(self._shutdown_event),
            )
        except asyncio.CancelledError:
            pass
        finally:
            await remi.stop()
            self._remove_pid()
            logger.info("Remi daemon stopped.")
