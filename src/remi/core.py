"""Remi orchestrator — the Hub in Hub-and-Spoke architecture.

Responsibilities:
1. Receive messages from any connector (IncomingMessage)
2. Lane Queue — serialize per chat_id to prevent race conditions
3. Session management — chat_id → session_id mapping
4. Memory injection — assemble context before calling provider
5. Provider routing — select provider + fallback
6. Response dispatch — return AgentResponse via originating connector
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from remi.config import RemiConfig
from remi.connectors.base import IncomingMessage
from remi.providers.base import AgentResponse
from remi.memory.store import MemoryStore

if TYPE_CHECKING:
    from remi.connectors.base import Connector
    from remi.providers.base import Provider

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
你是 Remi，Jack 的个人 AI 助手。

## 记忆系统
你拥有持久化记忆。每次对话开始时，相关记忆上下文自动注入在 <context> 标签中，
包含个人记忆、项目记忆、当日日志和可用实体目录。

你有两个记忆工具：
- recall(query, cwd?) — 搜索所有记忆（实体、历史日志、项目记忆）。
  当注入的上下文不够时使用。精确匹配实体名或别名返回全文，否则返回摘要列表。
- remember(entity, type, observation, scope?, cwd?) — 即时保存关于实体的重要信息。
  当用户告知值得长期记住的内容时使用（生日、偏好、重要决策）。
  scope="project" 时写入当前项目的实体目录，默认写入个人实体目录。
  注意：项目级技术知识（架构、技术栈）会在对话结束后由维护 agent 自动整理。

<context> 末尾的"可用记忆"表格是摘要目录，使用 recall(名称) 可查看完整详情。
"""


class Remi:
    """Core orchestrator — routes messages between connectors and providers."""

    def __init__(self, config: RemiConfig) -> None:
        self.config = config
        self.memory = MemoryStore(config.memory_dir)
        self._providers: dict[str, Provider] = {}
        self._connectors: list[Connector] = []
        self._sessions: dict[str, str] = {}  # chat_id → session_id
        self._lane_locks: dict[str, asyncio.Lock] = {}  # per-chat serialization

    # ── Provider management ──────────────────────────────────

    def add_provider(self, provider: Provider) -> None:
        self._providers[provider.name] = provider
        logger.info("Registered provider: %s", provider.name)

    def _get_provider(self, name: str | None = None) -> Provider:
        name = name or self.config.provider.name
        provider = self._providers.get(name)
        if not provider:
            raise RuntimeError(
                f"Provider '{name}' not registered. Available: {list(self._providers)}"
            )
        return provider

    # ── Connector management ─────────────────────────────────

    def add_connector(self, connector: Connector) -> None:
        self._connectors.append(connector)
        logger.info("Registered connector: %s", connector.name)

    # ── Lane Queue (per-chat serialization) ──────────────────

    def _get_lane_lock(self, chat_id: str) -> asyncio.Lock:
        if chat_id not in self._lane_locks:
            self._lane_locks[chat_id] = asyncio.Lock()
        return self._lane_locks[chat_id]

    # ── Message handling (the core loop) ─────────────────────

    async def handle_message(self, msg: IncomingMessage) -> AgentResponse:
        """Process an incoming message — the main entry point for all connectors."""
        lock = self._get_lane_lock(msg.chat_id)
        async with lock:
            return await self._process(msg)

    async def _process(self, msg: IncomingMessage) -> AgentResponse:
        # 1. Assemble memory context
        context = self.memory.gather_context(cwd=msg.metadata.get("cwd"))

        # 2. Get session for multi-turn
        session_id = self._sessions.get(msg.chat_id)

        # 3. Route to provider
        provider = self._get_provider()
        response = await provider.send(
            msg.text,
            system_prompt=SYSTEM_PROMPT,
            context=context or None,
            session_id=session_id,
        )

        # 4. Fallback if primary fails
        if response.text.startswith("[Provider error") or response.text.startswith(
            "[Provider timeout"
        ):
            fallback_name = self.config.provider.fallback
            if fallback_name and fallback_name in self._providers:
                logger.warning("Primary provider failed, trying fallback: %s", fallback_name)
                fallback = self._providers[fallback_name]
                response = await fallback.send(
                    msg.text,
                    system_prompt=SYSTEM_PROMPT,
                    context=context or None,
                )

        # 5. Update session mapping
        if response.session_id:
            self._sessions[msg.chat_id] = response.session_id

        # 6. Append to daily notes
        self.memory.append_daily(f"[{msg.connector_name}] {msg.sender}: {msg.text[:100]}")

        return response

    # ── Lifecycle ─────────────────────────────────────────────

    async def start(self) -> None:
        """Start all connectors (each listens for messages)."""
        if not self._providers:
            raise RuntimeError("No providers registered. Call add_provider() first.")

        tasks = [connector.start(self.handle_message) for connector in self._connectors]
        if tasks:
            await asyncio.gather(*tasks)

    async def stop(self) -> None:
        """Gracefully stop all connectors and providers."""
        for connector in self._connectors:
            await connector.stop()

        # Close providers that support it (e.g. long-running subprocesses)
        for provider in self._providers.values():
            close = getattr(provider, "close", None)
            if close and callable(close):
                await close()
