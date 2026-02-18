"""Maintenance agent prompt building and response parsing.

The maintenance agent reviews conversation transcripts and decides what
memory updates to make (create entities, patch project memory, etc.).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from remi.memory.store import MemoryStore

logger = logging.getLogger(__name__)

MAINTENANCE_PROMPT_TEMPLATE = """\
你是 Remi 的记忆维护 agent。审查以下对话（最近 10 轮 + 对话摘要），
将值得长期记忆的信息写入正确的位置。

## 写入层级判断规则

默认只写两层：
- 全局偏好、跨项目通用知识    → ~/.remi/memory/MEMORY.md
- 项目相关的一切知识          → {{project_root}}/.remi/memory.md
- 关于人、组织、具体决策的信息 → ~/.remi/memory/entities/{{type}}/{{name}}.md

例外：当前 cwd 存在独立的 .remi/memory.md（模块层已拆出），
则模块相关的实现细节、局部约定写入该模块文件，项目根只保留跨模块内容。

## 写入模式说明
- ## Procedures 章节：使用 overwrite 模式（始终是最新版本）
- 其他章节：使用 append 模式（累积历史）

## 当前记忆结构
{memory_structure}

## 对话上下文
工作目录：{cwd}
对话摘要：{summary}
最近对话：
{recent_turns}

## 请决定
对每条值得记忆的信息输出 JSON 行：
  - action: create_entity | update_entity | append_observation | patch_project_memory | append_global
  - target: 目标路径或实体名
  - section: 目标章节（patch_project_memory 时必填）
  - mode: append | overwrite（patch_project_memory 时必填）
  - content: 要写入的内容
  - source: agent-inferred

无值得记忆的内容则输出 SKIP。
"""


@dataclass
class MaintenanceAction:
    """A single memory maintenance action."""

    action: str
    target: str
    content: str
    section: str = ""
    mode: str = "append"
    source: str = "agent-inferred"
    entity_type: str = ""


def build_maintenance_prompt(
    cwd: str | None,
    summary: str,
    recent_turns: str,
    memory_structure: str,
) -> str:
    """Build the maintenance agent prompt."""
    return MAINTENANCE_PROMPT_TEMPLATE.format(
        cwd=cwd or "(unknown)",
        summary=summary or "(none)",
        recent_turns=recent_turns,
        memory_structure=memory_structure,
    )


def parse_maintenance_response(response_text: str) -> list[MaintenanceAction]:
    """Parse LLM response into a list of maintenance actions."""
    if response_text.strip().upper() == "SKIP":
        return []

    actions = []
    for line in response_text.strip().splitlines():
        line = line.strip()
        if not line or line.upper() == "SKIP":
            continue
        try:
            data = json.loads(line)
            actions.append(
                MaintenanceAction(
                    action=data.get("action", ""),
                    target=data.get("target", ""),
                    content=data.get("content", ""),
                    section=data.get("section", ""),
                    mode=data.get("mode", "append"),
                    source=data.get("source", "agent-inferred"),
                    entity_type=data.get("type", ""),
                )
            )
        except json.JSONDecodeError:
            # Try to extract JSON from the line
            match = re.search(r"\{.*\}", line)
            if match:
                try:
                    data = json.loads(match.group())
                    actions.append(
                        MaintenanceAction(
                            action=data.get("action", ""),
                            target=data.get("target", ""),
                            content=data.get("content", ""),
                            section=data.get("section", ""),
                            mode=data.get("mode", "append"),
                            source=data.get("source", "agent-inferred"),
                            entity_type=data.get("type", ""),
                        )
                    )
                except json.JSONDecodeError:
                    logger.warning("Failed to parse maintenance action: %s", line)
    return actions


def execute_maintenance_actions(store: MemoryStore, actions: list[MaintenanceAction]) -> int:
    """Execute parsed maintenance actions against the memory store."""
    executed = 0
    for action in actions:
        try:
            if action.action == "create_entity":
                store.create_entity(
                    name=action.target,
                    type=action.entity_type,
                    content=action.content,
                    source="agent-inferred",
                )
                executed += 1
            elif action.action == "update_entity":
                store.update_entity(name=action.target, content=action.content)
                executed += 1
            elif action.action == "append_observation":
                store.append_observation(name=action.target, observation=action.content)
                executed += 1
            elif action.action == "patch_project_memory":
                store.patch_project_memory(
                    project_path=action.target,
                    section=action.section,
                    content=action.content,
                    mode=action.mode,
                )
                executed += 1
            elif action.action == "append_global":
                store.append_memory(action.content)
                executed += 1
            else:
                logger.warning("Unknown maintenance action: %s", action.action)
        except Exception as e:
            logger.error("Failed to execute action %s on %s: %s", action.action, action.target, e)
    return executed
