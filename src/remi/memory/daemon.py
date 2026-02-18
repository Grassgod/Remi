"""Memory daemon — consume queued transcripts and run maintenance agent.

Watches ~/.remi/queue/ for new .jsonl files, processes them through an LLM
to extract memory-worthy information, and patches memory files.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from remi.memory.maintenance import build_maintenance_prompt
from remi.memory.store import MemoryStore

logger = logging.getLogger(__name__)

LOCK_FILE = ".maintenance.lock"
LOCK_TIMEOUT = 60  # seconds


class MemoryDaemon:
    """Watch queue directory and process transcripts."""

    def __init__(
        self,
        store: MemoryStore,
        queue_dir: Path | None = None,
        poll_interval: float = 10.0,
    ) -> None:
        self.store = store
        self.queue_dir = queue_dir or Path.home() / ".remi" / "queue"
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        (self.queue_dir / "processed").mkdir(exist_ok=True)
        self.poll_interval = poll_interval

    async def run(self, shutdown_event: asyncio.Event | None = None) -> None:
        """Main loop: poll queue directory for new items."""
        logger.info("MemoryDaemon started, watching %s", self.queue_dir)
        while True:
            if shutdown_event and shutdown_event.is_set():
                break
            try:
                await self._process_queue()
            except Exception as e:
                logger.error("Queue processing error: %s", e)
            if shutdown_event:
                try:
                    await asyncio.wait_for(shutdown_event.wait(), timeout=self.poll_interval)
                    break
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(self.poll_interval)
        logger.info("MemoryDaemon stopped.")

    async def _process_queue(self) -> None:
        """Process all pending .jsonl files in the queue."""
        lock_path = self.store.root / LOCK_FILE
        if lock_path.exists():
            mtime = lock_path.stat().st_mtime
            if time.time() - mtime < LOCK_TIMEOUT:
                logger.debug("Maintenance lock held, skipping")
                return
            # Stale lock
            lock_path.unlink()

        pending = sorted(self.queue_dir.glob("*.jsonl"))
        if not pending:
            return

        # Acquire lock
        lock_path.write_text(str(time.time()), encoding="utf-8")
        try:
            for jsonl_file in pending:
                await self._process_file(jsonl_file)
        finally:
            lock_path.unlink(missing_ok=True)

    async def _process_file(self, jsonl_file: Path) -> None:
        """Process a single queued transcript file."""
        try:
            data = json.loads(jsonl_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            logger.error("Failed to read %s: %s", jsonl_file, e)
            return

        content_hash = data.get("hash", "")

        # Idempotency check
        processed_file = self.queue_dir / ".processed"
        if processed_file.exists():
            processed = processed_file.read_text(encoding="utf-8").splitlines()
            if content_hash in processed:
                logger.debug("Already processed %s, skipping", content_hash)
                jsonl_file.unlink()
                return

        transcript = data.get("transcript", "")
        if not transcript.strip():
            jsonl_file.unlink()
            return

        logger.info("Processing queued transcript: %s", jsonl_file.name)

        # Build prompt and process (placeholder for LLM integration)
        prompt = build_maintenance_prompt(
            cwd=None,
            summary="",
            recent_turns=transcript[:5000],
            memory_structure=self._describe_memory_structure(),
        )

        # TODO: call LLM with prompt, parse response, execute actions
        # For now, just log and move to processed
        logger.info("Maintenance prompt built (%d chars), LLM call pending", len(prompt))

        # Record as processed
        with processed_file.open("a", encoding="utf-8") as f:
            f.write(f"{content_hash}\n")

        # Move to processed directory
        dest = self.queue_dir / "processed" / jsonl_file.name
        jsonl_file.rename(dest)
        logger.info("Moved %s to processed/", jsonl_file.name)

    def _describe_memory_structure(self) -> str:
        """Describe current memory layout for the maintenance prompt."""
        lines = []
        entities_dir = self.store.root / "entities"
        if entities_dir.is_dir():
            for type_dir in sorted(entities_dir.iterdir()):
                if type_dir.is_dir():
                    count = len(list(type_dir.glob("*.md")))
                    lines.append(f"  entities/{type_dir.name}/: {count} files")

        daily_dir = self.store.root / "daily"
        if daily_dir.is_dir():
            count = len(list(daily_dir.glob("*.md")))
            lines.append(f"  daily/: {count} files")

        return "\n".join(lines) if lines else "  (empty)"

    def cleanup_processed(self, keep_days: int = 30) -> int:
        """Remove processed files older than keep_days."""
        from datetime import timedelta

        cutoff = time.time() - timedelta(days=keep_days).total_seconds()
        removed = 0
        processed_dir = self.queue_dir / "processed"
        if processed_dir.is_dir():
            for f in processed_dir.glob("*.jsonl"):
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    removed += 1
        return removed
