"""Feishu (Lark) webhook connector.

Receives messages via HTTP webhook, sends replies via Feishu API.
Requires: uv pip install 'remi[feishu]'
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import TYPE_CHECKING

from remi.connectors.base import IncomingMessage

if TYPE_CHECKING:
    from remi.config import FeishuConfig
    from remi.connectors.base import MessageHandler
    from remi.engines.base import AgentResponse

logger = logging.getLogger(__name__)


class FeishuConnector:
    """Feishu webhook connector using lark-oapi SDK."""

    def __init__(self, config: FeishuConfig) -> None:
        self._config = config
        self._handler: MessageHandler | None = None
        self._seen_ids: dict[str, float] = {}  # message_id → timestamp for dedup
        self._dedup_ttl = 300  # 5 minutes
        self._server = None

        try:
            import lark_oapi as lark

            self._lark = lark
            self._client = (
                lark.Client.builder().app_id(config.app_id).app_secret(config.app_secret).build()
            )
        except ImportError:
            raise ImportError(
                "lark-oapi package required. Install with: uv pip install 'remi[feishu]'"
            )

    @property
    def name(self) -> str:
        return "feishu"

    async def start(self, handler: MessageHandler) -> None:
        self._handler = handler
        await self._start_webhook_server()

    async def _start_webhook_server(self) -> None:
        """Start an aiohttp server to receive Feishu webhook events."""
        from aiohttp import web

        app = web.Application()
        app.router.add_post("/webhook/feishu", self._handle_webhook)

        runner = web.AppRunner(app)
        await runner.setup()
        self._server = web.TCPSite(runner, "0.0.0.0", self._config.port)
        await self._server.start()
        logger.info("Feishu webhook listening on port %d", self._config.port)

    async def _handle_webhook(self, request) -> None:
        from aiohttp import web

        body = await request.json()

        # URL verification challenge
        if "challenge" in body:
            return web.json_response({"challenge": body["challenge"]})

        # Event callback
        header = body.get("header", {})
        event = body.get("event", {})

        # Verify event token
        token = header.get("token", "")
        if self._config.verification_token and token != self._config.verification_token:
            logger.warning("Invalid verification token")
            return web.json_response({"code": 403}, status=403)

        event_type = header.get("event_type", "")
        if event_type != "im.message.receive_v1":
            return web.json_response({"code": 0})

        # Extract message
        message = event.get("message", {})
        message_id = message.get("message_id", "")
        chat_id = message.get("chat_id", "")
        sender_id = event.get("sender", {}).get("sender_id", {}).get("open_id", "")

        # Dedup
        if self._is_duplicate(message_id):
            return web.json_response({"code": 0})

        # Parse text content
        import json

        content = json.loads(message.get("content", "{}"))
        text = content.get("text", "").strip()

        if not text:
            return web.json_response({"code": 0})

        # Remove @bot mention
        text = self._strip_mention(text)

        msg = IncomingMessage(
            text=text,
            chat_id=chat_id,
            sender=sender_id,
            connector_name=self.name,
        )

        # Process async (don't block webhook response)
        asyncio.create_task(self._process_and_reply(msg, message_id, chat_id))

        return web.json_response({"code": 0})

    async def _process_and_reply(self, msg: IncomingMessage, message_id: str, chat_id: str) -> None:
        try:
            response = await self._handler(msg)
            await self.reply(chat_id, response)
        except Exception as e:
            logger.error("Error processing feishu message %s: %s", message_id, e)

    def _is_duplicate(self, message_id: str) -> bool:
        now = time.time()
        # Clean old entries
        self._seen_ids = {k: v for k, v in self._seen_ids.items() if now - v < self._dedup_ttl}
        if message_id in self._seen_ids:
            return True
        self._seen_ids[message_id] = now
        return False

    @staticmethod
    def _strip_mention(text: str) -> str:
        """Remove @_user_N mentions from text."""
        import re

        return re.sub(r"@_user_\d+\s*", "", text).strip()

    async def stop(self) -> None:
        if self._server:
            await self._server.stop()
            logger.info("Feishu webhook stopped")

    async def reply(self, chat_id: str, response: AgentResponse) -> None:
        """Send a reply message to a Feishu chat."""
        import json

        from lark_oapi.api.im.v1 import CreateMessageBody, CreateMessageRequest

        content = json.dumps({"text": response.text})
        req = (
            CreateMessageRequest.builder()
            .receive_id_type("chat_id")
            .request_body(
                CreateMessageBody.builder()
                .receive_id(chat_id)
                .msg_type("text")
                .content(content)
                .build()
            )
            .build()
        )

        try:
            resp = await asyncio.to_thread(self._client.im.v1.message.create, req)
            if not resp.success():
                logger.error("Feishu reply failed: code=%s msg=%s", resp.code, resp.msg)
        except Exception as e:
            logger.error("Feishu reply error: %s", e)
