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
from remi.engines.claude_cli import ClaudeCLIEngine
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

        # Register engines
        engine = self._build_engine()
        remi.add_engine(engine)

        # Register fallback if configured
        if self.config.engine.fallback:
            try:
                fallback = self._build_engine(self.config.engine.fallback)
                remi.add_engine(fallback)
            except Exception as e:
                logger.warning("Failed to build fallback engine: %s", e)

        return remi

    def _build_engine(self, name: str | None = None):
        name = name or self.config.engine.name
        if name == "claude_cli":
            return ClaudeCLIEngine(
                model=self.config.engine.model,
                timeout=self.config.engine.timeout,
                allowed_tools=self.config.engine.allowed_tools,
            )
        elif name == "claude_sdk":
            from remi.engines.claude_sdk import ClaudeSDKEngine

            return ClaudeSDKEngine(model=self.config.engine.model or "claude-sonnet-4-5-20250929")
        elif name == "openai_codex":
            from remi.engines.openai_codex import OpenAICodexEngine

            return OpenAICodexEngine(timeout=self.config.engine.timeout)
        else:
            raise ValueError(f"Unknown engine: {name}")

    def _build_connectors(self, remi: Remi) -> None:
        # Always add CLI connector in daemon mode? No — daemon uses feishu etc.
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

        logger.info("Remi daemon starting (engine=%s)", self.config.engine.name)

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
