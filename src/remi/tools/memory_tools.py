"""Memory tools v2 — recall + remember.

Two tools exposed to the AI agent for memory access:
- recall: search all memory sources (entities, daily logs, project memory)
- remember: immediately save an observation about an entity
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from remi.memory.store import MemoryStore


def get_memory_tools(store: MemoryStore) -> dict[str, callable]:
    """Return a dict of tool_name -> callable for v2 memory operations."""

    def recall(
        query: str,
        type: str | None = None,
        tags: list[str] | None = None,
        cwd: str | None = None,
    ) -> str:
        """搜索记忆。可搜索联系人、项目记忆、历史日志等所有记忆源。
        精确匹配实体名或别名返回全文，模糊匹配返回摘要列表。
        """
        result = store.recall(query, type=type, tags=tags, cwd=cwd)
        return result or "(无匹配结果)"

    def remember(
        entity: str,
        type: str,
        observation: str,
        scope: str = "personal",
        cwd: str | None = None,
    ) -> str:
        """即时记住重要信息。当用户告知生日、偏好、决策等值得长期保存的内容时调用。
        实体不存在则自动创建，已存在则追加为新观察。
        """
        return store.remember(entity, type, observation, scope=scope, cwd=cwd)

    return {
        "recall": recall,
        "remember": remember,
    }
