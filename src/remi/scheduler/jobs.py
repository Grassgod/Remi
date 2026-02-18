"""Scheduler for periodic tasks using pure asyncio.

Jobs:
- Heartbeat: check connector/engine health
- Memory compaction: archive daily notes → long-term memory
- Cleanup: remove old dailies and version files
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from remi.config import RemiConfig
    from remi.core import Remi

logger = logging.getLogger(__name__)


def _parse_cron_hour(cron_expr: str) -> int:
    """Extract hour from simple cron expression like '0 3 * * *'."""
    parts = cron_expr.split()
    if len(parts) >= 2:
        try:
            return int(parts[1])
        except ValueError:
            pass
    return 3  # default: 3 AM


class Scheduler:
    """Simple asyncio-based scheduler for periodic tasks."""

    def __init__(self, remi: Remi, config: RemiConfig) -> None:
        self._remi = remi
        self._config = config
        self._compact_hour = _parse_cron_hour(config.scheduler.memory_compact_cron)
        self._heartbeat_interval = config.scheduler.heartbeat_interval

    async def start(self, shutdown_event: asyncio.Event) -> None:
        """Run scheduled jobs until shutdown_event is set."""
        logger.info(
            "Scheduler started (heartbeat=%ds, compact@%02d:00)",
            self._heartbeat_interval,
            self._compact_hour,
        )

        last_compact_date: str | None = None

        while not shutdown_event.is_set():
            try:
                await asyncio.wait_for(
                    shutdown_event.wait(),
                    timeout=self._heartbeat_interval,
                )
                break  # shutdown requested
            except asyncio.TimeoutError:
                pass  # interval elapsed — run jobs

            # Heartbeat
            await self._heartbeat()

            # Daily compaction (run once per day at configured hour)
            now = datetime.now()
            today = now.strftime("%Y-%m-%d")
            if now.hour == self._compact_hour and last_compact_date != today:
                await self._compact_memory()
                await self._cleanup()
                last_compact_date = today

        logger.info("Scheduler stopped.")

    async def _heartbeat(self) -> None:
        """Check engine health."""
        for name, engine in self._remi._engines.items():
            try:
                healthy = await engine.health_check()
                if not healthy:
                    logger.warning("Engine %s health check failed", name)
            except Exception as e:
                logger.error("Engine %s health check error: %s", name, e)

    async def _compact_memory(self) -> None:
        """Summarize yesterday's daily notes and suggest memory updates.

        This uses the engine itself to do the summarization — self-maintaining memory.
        """
        from datetime import timedelta

        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        daily = self._remi.memory.read_daily(yesterday)

        if not daily or len(daily.strip()) < 50:
            logger.debug("No significant daily notes to compact for %s", yesterday)
            return

        logger.info("Compacting daily notes for %s", yesterday)

        # Use the primary engine to summarize
        try:
            engine = self._remi._get_engine()
            prompt = (
                f"Below are my daily notes from {yesterday}. "
                "Extract any important facts, decisions, or preferences that should be "
                "remembered long-term. Format as bullet points. "
                "If nothing is worth remembering long-term, respond with 'SKIP'.\n\n"
                f"{daily}"
            )
            response = await engine.send(prompt)
            if response.text.strip().upper() != "SKIP":
                self._remi.memory.append_memory(
                    f"\n## From {yesterday}\n\n{response.text.strip()}"
                )
                logger.info("Appended compacted memory from %s", yesterday)
        except Exception as e:
            logger.error("Memory compaction failed: %s", e)

    async def _cleanup(self) -> None:
        """Remove old daily notes and version files."""
        removed_daily = self._remi.memory.cleanup_old_dailies(keep_days=30)
        removed_versions = self._remi.memory.cleanup_old_versions(keep=50)
        if removed_daily or removed_versions:
            logger.info(
                "Cleanup: removed %d old dailies, %d old versions",
                removed_daily,
                removed_versions,
            )
