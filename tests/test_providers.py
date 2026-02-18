"""Tests for provider backends (mocked subprocess calls)."""

import json
import pytest
from unittest.mock import MagicMock, patch

from remi.providers.claude_cli import ClaudeCLIProvider


class TestClaudeCLIProvider:
    @pytest.fixture
    def provider(self) -> ClaudeCLIProvider:
        return ClaudeCLIProvider()

    def test_name(self, provider: ClaudeCLIProvider):
        assert provider.name == "claude_cli"

    @pytest.mark.asyncio
    async def test_send_success(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({
            "result": "Hello! I'm Claude.",
            "session_id": "sess-123",
            "cost_usd": 0.01,
            "model": "claude-sonnet-4-5-20250929",
        })
        mock_result.stderr = ""

        with patch("remi.providers.claude_cli.subprocess.run", return_value=mock_result):
            response = await provider.send("Hello")

        assert response.text == "Hello! I'm Claude."
        assert response.session_id == "sess-123"
        assert response.cost_usd == 0.01

    @pytest.mark.asyncio
    async def test_send_cli_not_found(self, provider: ClaudeCLIProvider):
        with patch(
            "remi.providers.claude_cli.subprocess.run",
            side_effect=FileNotFoundError,
        ):
            response = await provider.send("Hello")

        assert "not found" in response.text

    @pytest.mark.asyncio
    async def test_send_timeout(self, provider: ClaudeCLIProvider):
        import subprocess

        with patch(
            "remi.providers.claude_cli.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=300),
        ):
            response = await provider.send("Hello")

        assert "timeout" in response.text.lower()

    @pytest.mark.asyncio
    async def test_send_nonzero_exit(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "some error"

        with patch("remi.providers.claude_cli.subprocess.run", return_value=mock_result):
            response = await provider.send("Hello")

        assert "error" in response.text.lower()

    @pytest.mark.asyncio
    async def test_send_with_context(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"result": "Got it"})
        mock_result.stderr = ""

        with patch(
            "remi.providers.claude_cli.subprocess.run", return_value=mock_result
        ) as mock_run:
            await provider.send("Hello", context="Some memory context")

        call_args = mock_run.call_args[0][0]
        prompt_arg = call_args[-1]
        assert "<context>" in prompt_arg
        assert "Some memory context" in prompt_arg

    @pytest.mark.asyncio
    async def test_send_with_session_id(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"result": "Continued"})
        mock_result.stderr = ""

        with patch(
            "remi.providers.claude_cli.subprocess.run", return_value=mock_result
        ) as mock_run:
            await provider.send("Continue", session_id="sess-123")

        call_args = mock_run.call_args[0][0]
        assert "--resume" in call_args
        assert "sess-123" in call_args

    @pytest.mark.asyncio
    async def test_health_check_ok(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 0

        with patch("remi.providers.claude_cli.subprocess.run", return_value=mock_result):
            assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_missing(self, provider: ClaudeCLIProvider):
        with patch(
            "remi.providers.claude_cli.subprocess.run",
            side_effect=FileNotFoundError,
        ):
            assert await provider.health_check() is False
