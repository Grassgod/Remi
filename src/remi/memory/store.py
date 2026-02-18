"""Dual-layer memory system (inspired by OpenClaw).

Markdown files are the source of truth — the model only "remembers"
what has been written to disk.

Layout:
    ~/.remi/memory/
    ├── MEMORY.md                # Long-term: preferences, decisions, core facts
    ├── daily/
    │   └── 2026-02-17.md        # Daily notes (append-only)
    ├── projects/
    │   ├── MEMORY.md            # Project-wide memory
    │   └── remi/
    │       └── MEMORY.md        # Project-specific memory
    └── .versions/               # Rollback snapshots
"""

from __future__ import annotations

import logging
import shutil
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


class MemoryStore:
    """Read/write access to the dual-layer memory system."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._ensure_dirs()

    def _ensure_dirs(self) -> None:
        (self.root / "daily").mkdir(parents=True, exist_ok=True)
        (self.root / "projects").mkdir(parents=True, exist_ok=True)
        (self.root / ".versions").mkdir(parents=True, exist_ok=True)

    # ── Long-term memory ─────────────────────────────────────

    @property
    def memory_file(self) -> Path:
        return self.root / "MEMORY.md"

    def read_memory(self) -> str:
        """Read the root MEMORY.md."""
        if self.memory_file.exists():
            return self.memory_file.read_text()
        return ""

    def write_memory(self, content: str) -> None:
        """Overwrite root MEMORY.md with version backup."""
        self._backup(self.memory_file)
        self.memory_file.write_text(content)
        logger.info("Updated MEMORY.md (%d chars)", len(content))

    def append_memory(self, entry: str) -> None:
        """Append an entry to root MEMORY.md."""
        self._backup(self.memory_file)
        with self.memory_file.open("a") as f:
            f.write(f"\n{entry.rstrip()}\n")

    # ── Daily notes ──────────────────────────────────────────

    def _daily_path(self, date: str | None = None) -> Path:
        date = date or datetime.now().strftime("%Y-%m-%d")
        return self.root / "daily" / f"{date}.md"

    def read_daily(self, date: str | None = None) -> str:
        """Read today's (or specified date's) daily notes."""
        path = self._daily_path(date)
        if path.exists():
            return path.read_text()
        return ""

    def append_daily(self, entry: str, date: str | None = None) -> None:
        """Append an entry to today's daily notes."""
        path = self._daily_path(date)
        timestamp = datetime.now().strftime("%H:%M")
        with path.open("a") as f:
            if not path.exists() or path.stat().st_size == 0:
                f.write(f"# {date or datetime.now().strftime('%Y-%m-%d')}\n\n")
            f.write(f"- [{timestamp}] {entry.rstrip()}\n")

    # ── Project memory ───────────────────────────────────────

    def read_project_memory(self, project: str) -> str:
        """Read a project-specific MEMORY.md."""
        path = self.root / "projects" / project / "MEMORY.md"
        if path.exists():
            return path.read_text()
        return ""

    def write_project_memory(self, project: str, content: str) -> None:
        """Write a project-specific MEMORY.md."""
        proj_dir = self.root / "projects" / project
        proj_dir.mkdir(parents=True, exist_ok=True)
        path = proj_dir / "MEMORY.md"
        self._backup(path)
        path.write_text(content)

    # ── Hierarchical context assembly ────────────────────────

    def read_with_ancestors(self, project: str | None = None) -> str:
        """Assemble context: root MEMORY.md + project MEMORY.md + today's notes."""
        parts: list[str] = []

        root_mem = self.read_memory()
        if root_mem:
            parts.append(f"# Long-term Memory\n\n{root_mem}")

        if project:
            proj_mem = self.read_project_memory(project)
            if proj_mem:
                parts.append(f"# Project Memory ({project})\n\n{proj_mem}")

        daily = self.read_daily()
        if daily:
            parts.append(f"# Today's Notes\n\n{daily}")

        return "\n\n---\n\n".join(parts) if parts else ""

    # ── Version management ───────────────────────────────────

    def _backup(self, path: Path) -> None:
        """Create a timestamped backup in .versions/."""
        if not path.exists():
            return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"{path.stem}_{ts}{path.suffix}"
        dest = self.root / ".versions" / backup_name
        shutil.copy2(path, dest)
        logger.debug("Backed up %s -> %s", path.name, dest.name)

    def cleanup_old_dailies(self, keep_days: int = 30) -> int:
        """Remove daily notes older than keep_days. Returns count removed."""
        from datetime import timedelta

        cutoff = datetime.now() - timedelta(days=keep_days)
        removed = 0
        for path in (self.root / "daily").glob("*.md"):
            try:
                date = datetime.strptime(path.stem, "%Y-%m-%d")
                if date < cutoff:
                    path.unlink()
                    removed += 1
            except ValueError:
                continue
        return removed

    def cleanup_old_versions(self, keep: int = 50) -> int:
        """Keep only the most recent `keep` version files."""
        versions = sorted(
            (self.root / ".versions").glob("*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        removed = 0
        for path in versions[keep:]:
            path.unlink()
            removed += 1
        return removed
