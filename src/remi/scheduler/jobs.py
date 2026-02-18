"""Scheduler for periodic tasks using pure asyncio.

Jobs:
- Heartbeat: check connector/provider health
- Memory compaction: archive daily notes → long-term memory + entity extraction
- Cleanup: remove old dailies and version files
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta
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
        """Check provider health."""
        for name, provider in self._remi._providers.items():
            try:
                healthy = await provider.health_check()
                if not healthy:
                    logger.warning("Provider %s health check failed", name)
            except Exception as e:
                logger.error("Provider %s health check error: %s", name, e)

    async def _compact_memory(self) -> None:
        """Summarize yesterday's daily notes, extract entities, update rolling summary.

        v2 enhanced compaction:
        1. Read yesterday's daily log
        2. Append observations to mentioned entities
        3. Extract new entities
        4. Update rolling summary (.conversation_summary.md)
        5. Compress 8-30 day logs into weekly summaries
        6. Archive logs older than 30 days
        """
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        daily = self._remi.memory.read_daily(yesterday)

        if not daily or len(daily.strip()) < 50:
            logger.debug("No significant daily notes to compact for %s", yesterday)
            return

        logger.info("Compacting daily notes for %s", yesterday)

        try:
            provider = self._remi._get_provider()
            prompt = (
                f"Below are my daily notes from {yesterday}. "
                "Extract any important facts, decisions, or preferences that should be "
                "remembered long-term. Format as bullet points. "
                "If nothing is worth remembering long-term, respond with 'SKIP'.\n\n"
                f"Also identify any people, organizations, or decisions mentioned. "
                f"For each, output a line: ENTITY: name (type) - observation\n\n"
                f"{daily}"
            )
            response = await provider.send(prompt)
            text = response.text.strip()

            if text.upper() != "SKIP":
                # Extract entity observations
                for line in text.splitlines():
                    if line.startswith("ENTITY:"):
                        self._process_entity_line(line)

                # Filter out ENTITY lines for the general summary
                summary_lines = [
                    line for line in text.splitlines() if not line.startswith("ENTITY:")
                ]
                summary_text = "\n".join(summary_lines).strip()

                if summary_text:
                    self._remi.memory.append_memory(f"\n## From {yesterday}\n\n{summary_text}")
                    logger.info("Appended compacted memory from %s", yesterday)

                # Update rolling summary
                self._update_rolling_summary(yesterday, summary_text)

            # Compress old daily logs into weekly summaries
            self._compress_weekly_logs()

            # Archive very old logs
            self._archive_old_logs()

        except Exception as e:
            logger.error("Memory compaction failed: %s", e)

    def _process_entity_line(self, line: str) -> None:
        """Parse and process an ENTITY: line from compaction output."""
        # Format: ENTITY: name (type) - observation
        match = re.match(r"ENTITY:\s*(.+?)\s*\((\w+)\)\s*-\s*(.+)", line)
        if not match:
            return
        name, etype, observation = match.group(1), match.group(2), match.group(3)
        try:
            entity_path = self._remi.memory._find_entity_by_name(name)
            if entity_path:
                self._remi.memory.append_observation(name, observation)
            else:
                self._remi.memory.create_entity(
                    name=name,
                    type=etype,
                    content=observation,
                    source="agent-inferred",
                )
        except Exception as e:
            logger.warning("Failed to process entity %s: %s", name, e)

    def _update_rolling_summary(self, date_str: str, summary: str) -> None:
        """Update the rolling conversation summary file."""
        summary_file = self._remi.memory.root / ".conversation_summary.md"
        try:
            existing = ""
            if summary_file.exists():
                existing = summary_file.read_text(encoding="utf-8")

            entry = f"\n## {date_str}\n{summary}\n"
            summary_file.write_text(existing + entry, encoding="utf-8")
        except OSError as e:
            logger.warning("Failed to update rolling summary: %s", e)

    def _compress_weekly_logs(self) -> None:
        """Compress 8-30 day old daily logs into weekly summaries."""
        daily_dir = self._remi.memory.root / "daily"
        now = datetime.now()

        for path in sorted(daily_dir.glob("*.md")):
            if path.stem.startswith("weekly-"):
                continue
            try:
                log_date = datetime.strptime(path.stem, "%Y-%m-%d")
            except ValueError:
                continue

            age = (now - log_date).days
            if 8 <= age <= 30:
                # Determine ISO week
                iso_year, iso_week, _ = log_date.isocalendar()
                weekly_name = f"weekly-{iso_year}-W{iso_week:02d}.md"
                weekly_path = daily_dir / weekly_name

                content = path.read_text(encoding="utf-8")
                with weekly_path.open("a", encoding="utf-8") as f:
                    f.write(f"\n## {path.stem}\n{content}\n")

                path.unlink()
                logger.debug("Compressed %s into %s", path.stem, weekly_name)

    def _archive_old_logs(self) -> None:
        """Move logs older than 30 days to daily/archive/."""
        daily_dir = self._remi.memory.root / "daily"
        archive_dir = daily_dir / "archive"
        now = datetime.now()

        for path in sorted(daily_dir.glob("*.md")):
            if path.stem.startswith("weekly-"):
                try:
                    # Parse weekly-YYYY-WNN
                    parts = path.stem.split("-")
                    year = int(parts[1])
                    week = int(parts[2][1:])
                    week_date = datetime.strptime(f"{year}-W{week:02d}-1", "%Y-W%W-%w")
                    if (now - week_date).days > 30:
                        archive_dir.mkdir(exist_ok=True)
                        path.rename(archive_dir / path.name)
                except (ValueError, IndexError):
                    continue
            else:
                try:
                    log_date = datetime.strptime(path.stem, "%Y-%m-%d")
                    if (now - log_date).days > 30:
                        archive_dir.mkdir(exist_ok=True)
                        path.rename(archive_dir / path.name)
                except ValueError:
                    continue

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
