"""MCP tools for agent memory access.

These functions are designed to be exposed as tools to the AI agent,
allowing it to read and write its own memory system.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from remi.memory.store import MemoryStore


def get_memory_tools(store: MemoryStore) -> dict[str, callable]:
    """Return a dict of tool_name -> callable for memory operations.

    These can be registered as MCP tools or called directly.
    """

    def read_memory() -> str:
        """Read the long-term MEMORY.md file."""
        content = store.read_memory()
        return content or "(empty — no long-term memories yet)"

    def write_memory(content: str) -> str:
        """Overwrite the long-term MEMORY.md with new content.
        A backup is automatically created before overwriting.
        """
        store.write_memory(content)
        return f"MEMORY.md updated ({len(content)} chars)"

    def append_memory(entry: str) -> str:
        """Append a new entry to the long-term MEMORY.md."""
        store.append_memory(entry)
        return f"Appended to MEMORY.md: {entry[:80]}..."

    def read_daily(date: str | None = None) -> str:
        """Read today's daily notes (or a specific date in YYYY-MM-DD format)."""
        content = store.read_daily(date)
        return content or "(no notes for this date)"

    def append_daily(entry: str) -> str:
        """Append an entry to today's daily notes with timestamp."""
        store.append_daily(entry)
        return f"Added to daily notes: {entry[:80]}..."

    def read_context(project: str | None = None) -> str:
        """Read the full assembled context (root memory + project memory + today's notes)."""
        content = store.read_with_ancestors(project)
        return content or "(no memory context available)"

    return {
        "read_memory": read_memory,
        "write_memory": write_memory,
        "append_memory": append_memory,
        "read_daily": read_daily,
        "append_daily": append_daily,
        "read_context": read_context,
    }
