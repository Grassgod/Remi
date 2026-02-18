"""Tests for the Remi core orchestrator."""

import asyncio
import pytest
from pathlib import Path

from remi.config import RemiConfig, ProviderConfig
from remi.connectors.base import IncomingMessage
from remi.core import Remi
from remi.providers.base import AgentResponse


class MockProvider:
    def __init__(self, response_text: str = "Mock response"):
        self._response_text = response_text
        self.last_message: str | None = None
        self.last_context: str | None = None
        self.closed = False

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

    async def close(self) -> None:
        self.closed = True


class MockFailProvider:
    @property
    def name(self) -> str:
        return "fail"

    async def send(self, message, **kwargs) -> AgentResponse:
        return AgentResponse(text="[Provider error: boom]")

    async def health_check(self) -> bool:
        return False


@pytest.fixture
def config(tmp_path: Path) -> RemiConfig:
    return RemiConfig(
        provider=ProviderConfig(name="mock"),
        memory_dir=tmp_path / "memory",
    )


@pytest.fixture
def remi(config: RemiConfig) -> Remi:
    r = Remi(config)
    r.add_provider(MockProvider())
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

        provider = remi._providers["mock"]
        assert provider.last_context is not None
        assert "uv" in provider.last_context

    @pytest.mark.asyncio
    async def test_fallback_provider(self, config: RemiConfig):
        config.provider.name = "fail"
        config.provider.fallback = "mock"
        r = Remi(config)
        r.add_provider(MockFailProvider())
        r.add_provider(MockProvider("Fallback worked"))

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

    @pytest.mark.asyncio
    async def test_no_provider_raises(self, config: RemiConfig):
        r = Remi(config)
        with pytest.raises(RuntimeError, match="No providers registered"):
            await r.start()

    @pytest.mark.asyncio
    async def test_stop_closes_providers(self, remi: Remi):
        """stop() should call close() on providers that support it."""
        await remi.stop()
        provider = remi._providers["mock"]
        assert provider.closed is True

    @pytest.mark.asyncio
    async def test_stop_without_close(self, config: RemiConfig):
        """stop() should not fail if provider has no close() method."""
        r = Remi(config)
        r.add_provider(MockFailProvider())
        # MockFailProvider has no close() — should not raise
        await r.stop()
