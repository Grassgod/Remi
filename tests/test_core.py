"""Tests for the Remi core orchestrator."""

import asyncio
import pytest
from pathlib import Path

from remi.config import RemiConfig, EngineConfig
from remi.connectors.base import IncomingMessage
from remi.core import Remi
from remi.engines.base import AgentResponse


class MockEngine:
    def __init__(self, response_text: str = "Mock response"):
        self._response_text = response_text
        self.last_message: str | None = None
        self.last_context: str | None = None

    @property
    def name(self) -> str:
        return "mock"

    async def send(self, message, *, system_prompt=None, context=None,
                   cwd=None, session_id=None) -> AgentResponse:
        self.last_message = message
        self.last_context = context
        return AgentResponse(
            text=self._response_text,
            session_id="sess-mock",
        )

    async def health_check(self) -> bool:
        return True


class MockFailEngine:
    @property
    def name(self) -> str:
        return "fail"

    async def send(self, message, **kwargs) -> AgentResponse:
        return AgentResponse(text="[Engine error: boom]")

    async def health_check(self) -> bool:
        return False


@pytest.fixture
def config(tmp_path: Path) -> RemiConfig:
    return RemiConfig(
        engine=EngineConfig(name="mock"),
        memory_dir=tmp_path / "memory",
    )


@pytest.fixture
def remi(config: RemiConfig) -> Remi:
    r = Remi(config)
    r.add_engine(MockEngine())
    return r


class TestRemiCore:
    @pytest.mark.asyncio
    async def test_handle_message(self, remi: Remi):
        msg = IncomingMessage(text="Hello", chat_id="test-1", sender="user", connector_name="cli")
        response = await remi.handle_message(msg)
        assert response.text == "Mock response"
        assert response.session_id == "sess-mock"

    @pytest.mark.asyncio
    async def test_session_tracking(self, remi: Remi):
        msg = IncomingMessage(text="Hello", chat_id="test-1", sender="user", connector_name="cli")
        await remi.handle_message(msg)
        assert remi._sessions["test-1"] == "sess-mock"

    @pytest.mark.asyncio
    async def test_daily_note_append(self, remi: Remi):
        msg = IncomingMessage(text="Hello", chat_id="test-1", sender="user", connector_name="cli")
        await remi.handle_message(msg)
        daily = remi.memory.read_daily()
        assert "Hello" in daily

    @pytest.mark.asyncio
    async def test_memory_context_injection(self, remi: Remi):
        remi.memory.write_memory("User prefers uv")
        msg = IncomingMessage(text="Hello", chat_id="test-1", sender="user", connector_name="cli")
        await remi.handle_message(msg)

        engine = remi._engines["mock"]
        assert engine.last_context is not None
        assert "uv" in engine.last_context

    @pytest.mark.asyncio
    async def test_fallback_engine(self, config: RemiConfig):
        config.engine.name = "fail"
        config.engine.fallback = "mock"
        r = Remi(config)
        r.add_engine(MockFailEngine())
        r.add_engine(MockEngine("Fallback worked"))

        msg = IncomingMessage(text="Hello", chat_id="test-1", sender="user", connector_name="cli")
        response = await r.handle_message(msg)
        assert response.text == "Fallback worked"

    @pytest.mark.asyncio
    async def test_lane_serialization(self, remi: Remi):
        """Verify that messages for the same chat_id are serialized."""
        msg1 = IncomingMessage(text="First", chat_id="test-1", sender="user", connector_name="cli")
        msg2 = IncomingMessage(text="Second", chat_id="test-1", sender="user", connector_name="cli")

        await asyncio.gather(
            remi.handle_message(msg1),
            remi.handle_message(msg2),
        )
        # Both should complete without error (lock serializes them)

    @pytest.mark.asyncio
    async def test_no_engine_raises(self, config: RemiConfig):
        r = Remi(config)
        with pytest.raises(RuntimeError, match="No engines registered"):
            await r.start()
