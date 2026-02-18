"""Tests for the dual-layer memory system."""

import pytest
from pathlib import Path

from remi.memory.store import MemoryStore


@pytest.fixture
def store(tmp_path: Path) -> MemoryStore:
    return MemoryStore(tmp_path / "memory")


class TestLongTermMemory:
    def test_read_empty(self, store: MemoryStore):
        assert store.read_memory() == ""

    def test_write_and_read(self, store: MemoryStore):
        store.write_memory("# My Preferences\n\n- Use uv for Python")
        assert "uv for Python" in store.read_memory()

    def test_append(self, store: MemoryStore):
        store.write_memory("# Memory\n")
        store.append_memory("- Fact 1")
        store.append_memory("- Fact 2")
        content = store.read_memory()
        assert "Fact 1" in content
        assert "Fact 2" in content

    def test_write_creates_backup(self, store: MemoryStore):
        store.write_memory("version 1")
        store.write_memory("version 2")
        versions = list((store.root / ".versions").glob("MEMORY_*.md"))
        assert len(versions) == 1  # backup of version 1


class TestDailyNotes:
    def test_read_empty(self, store: MemoryStore):
        assert store.read_daily("2026-01-01") == ""

    def test_append_and_read(self, store: MemoryStore):
        store.append_daily("Did something important", date="2026-02-17")
        content = store.read_daily("2026-02-17")
        assert "Did something important" in content

    def test_multiple_appends(self, store: MemoryStore):
        store.append_daily("Morning task", date="2026-02-17")
        store.append_daily("Evening task", date="2026-02-17")
        content = store.read_daily("2026-02-17")
        assert "Morning task" in content
        assert "Evening task" in content


class TestProjectMemory:
    def test_read_empty(self, store: MemoryStore):
        assert store.read_project_memory("remi") == ""

    def test_write_and_read(self, store: MemoryStore):
        store.write_project_memory("remi", "# Remi Project\n\nHub-and-spoke arch")
        content = store.read_project_memory("remi")
        assert "Hub-and-spoke" in content


class TestContextAssembly:
    def test_empty_context(self, store: MemoryStore):
        assert store.read_with_ancestors() == ""

    def test_full_context(self, store: MemoryStore):
        store.write_memory("Long-term fact")
        store.write_project_memory("remi", "Project fact")
        store.append_daily("Daily note")

        ctx = store.read_with_ancestors("remi")
        assert "Long-term fact" in ctx
        assert "Project fact" in ctx
        assert "Daily note" in ctx


class TestCleanup:
    def test_cleanup_old_versions(self, store: MemoryStore):
        # Create many version files
        for i in range(10):
            (store.root / ".versions" / f"test_{i}.md").write_text(f"v{i}")
        removed = store.cleanup_old_versions(keep=3)
        assert removed == 7
        remaining = list((store.root / ".versions").glob("*.md"))
        assert len(remaining) == 3
