"""Tests for provider backends (mocked subprocess calls)."""

import json

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from remi.providers.base import AgentResponse, ToolDefinition
from remi.providers.claude_cli import ClaudeCLIProvider
from remi.providers.claude_cli.protocol import ToolUseRequest
from remi.providers.claude_cli.process import ClaudeProcessManager


# ── Helpers ───────────────────────────────────────────────────


def make_line(data: dict) -> bytes:
    return (json.dumps(data) + "\n").encode()


class MockProcess:
    """Mock asyncio.subprocess.Process."""

    def __init__(self, lines: list[bytes]):
        self._lines = list(lines)
        self._line_idx = 0
        self.returncode = None
        self.pid = 99999
        self.stdin = MagicMock()
        self.stdin.write = MagicMock()
        self.stdin.drain = AsyncMock()
        self.stdin.close = MagicMock()
        self.stdout = self
        self.stderr = MagicMock()

    async def readline(self):
        if self._line_idx < len(self._lines):
            line = self._lines[self._line_idx]
            self._line_idx += 1
            return line
        return b""

    async def wait(self):
        self.returncode = 0


INIT_LINE = make_line(
    {
        "type": "system",
        "subtype": "init",
        "session_id": "sess-test",
        "tools": [],
        "model": "claude-sonnet-4-5-20250929",
    }
)


def streaming_lines(text: str = "Hello! I'm Claude.", session_id: str = "sess-test"):
    """Generate a standard streaming response sequence."""
    return [
        INIT_LINE,
        make_line(
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            }
        ),
        make_line(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": text},
            }
        ),
        make_line({"type": "content_block_stop", "index": 0}),
        make_line(
            {
                "type": "result",
                "result": text,
                "session_id": session_id,
                "cost_usd": 0.01,
                "model": "claude-sonnet-4-5-20250929",
            }
        ),
    ]


# ── Basic provider tests ─────────────────────────────────────


class TestClaudeCLIProvider:
    @pytest.fixture
    def provider(self) -> ClaudeCLIProvider:
        return ClaudeCLIProvider()

    def test_name(self, provider: ClaudeCLIProvider):
        assert provider.name == "claude_cli"

    @pytest.mark.asyncio
    async def test_send_streaming_success(self, provider: ClaudeCLIProvider):
        """send() uses streaming path when available."""
        lines = streaming_lines("Hello! I'm Claude.")
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            response = await provider.send("Hello")

        assert response.text == "Hello! I'm Claude."
        assert response.session_id == "sess-test"
        assert response.cost_usd == 0.01

    @pytest.mark.asyncio
    async def test_send_fallback_on_streaming_failure(self, provider: ClaudeCLIProvider):
        """send() falls back to subprocess.run() if streaming fails."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps(
            {
                "result": "Fallback response",
                "session_id": "sess-fb",
                "cost_usd": 0.02,
                "model": "claude-sonnet-4-5-20250929",
            }
        )
        mock_result.stderr = ""

        with (
            patch(
                "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError("no claude"),
            ),
            patch(
                "remi.providers.claude_cli.provider.subprocess.run",
                return_value=mock_result,
            ),
        ):
            response = await provider.send("Hello")

        assert response.text == "Fallback response"
        assert response.session_id == "sess-fb"

    @pytest.mark.asyncio
    async def test_send_with_context(self, provider: ClaudeCLIProvider):
        """Context is injected into prompt."""
        lines = streaming_lines("Got it")
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await provider.send("Hello", context="Some memory context")

        # Verify the user message written to stdin contains context
        write_calls = mock_proc.stdin.write.call_args_list
        user_msg = json.loads(write_calls[0][0][0].decode().strip())
        assert "<context>" in user_msg["message"]["content"]
        assert "Some memory context" in user_msg["message"]["content"]

    @pytest.mark.asyncio
    async def test_health_check_ok(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 0

        with patch("remi.providers.claude_cli.provider.subprocess.run", return_value=mock_result):
            assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_missing(self, provider: ClaudeCLIProvider):
        with patch(
            "remi.providers.claude_cli.provider.subprocess.run",
            side_effect=FileNotFoundError,
        ):
            assert await provider.health_check() is False

    @pytest.mark.asyncio
    async def test_close(self, provider: ClaudeCLIProvider):
        lines = streaming_lines()
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await provider.send("Hello")
            assert provider._process_mgr is not None

            await provider.close()
            assert provider._process_mgr is None

    @pytest.mark.asyncio
    async def test_close_when_not_started(self, provider: ClaudeCLIProvider):
        # Should not raise
        await provider.close()


# ── Fallback path tests ──────────────────────────────────────


class TestFallbackPath:
    @pytest.fixture
    def provider(self) -> ClaudeCLIProvider:
        return ClaudeCLIProvider()

    @pytest.mark.asyncio
    async def test_fallback_cli_not_found(self, provider: ClaudeCLIProvider):
        with (
            patch(
                "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError,
            ),
            patch(
                "remi.providers.claude_cli.provider.subprocess.run",
                side_effect=FileNotFoundError,
            ),
        ):
            response = await provider.send("Hello")
        assert "not found" in response.text

    @pytest.mark.asyncio
    async def test_fallback_timeout(self, provider: ClaudeCLIProvider):
        import subprocess

        with (
            patch(
                "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError,
            ),
            patch(
                "remi.providers.claude_cli.provider.subprocess.run",
                side_effect=subprocess.TimeoutExpired(cmd="claude", timeout=300),
            ),
        ):
            response = await provider.send("Hello")
        assert "timeout" in response.text.lower()

    @pytest.mark.asyncio
    async def test_fallback_nonzero_exit(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "some error"

        with (
            patch(
                "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError,
            ),
            patch(
                "remi.providers.claude_cli.provider.subprocess.run",
                return_value=mock_result,
            ),
        ):
            response = await provider.send("Hello")
        assert "error" in response.text.lower()

    @pytest.mark.asyncio
    async def test_fallback_with_session_id(self, provider: ClaudeCLIProvider):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"result": "Continued"})
        mock_result.stderr = ""

        with (
            patch(
                "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
                side_effect=FileNotFoundError,
            ),
            patch(
                "remi.providers.claude_cli.provider.subprocess.run",
                return_value=mock_result,
            ) as mock_run,
        ):
            await provider.send("Continue", session_id="sess-123")

        call_args = mock_run.call_args[0][0]
        assert "--resume" in call_args
        assert "sess-123" in call_args


# ── Tool registration tests ──────────────────────────────────


class TestToolRegistration:
    @pytest.fixture
    def provider(self) -> ClaudeCLIProvider:
        return ClaudeCLIProvider()

    def test_register_tool(self, provider: ClaudeCLIProvider):
        tool = ToolDefinition(
            name="test_tool",
            description="A test tool",
            parameters={"input": {"type": "string"}},
            handler=lambda input: f"Got: {input}",
        )
        provider.register_tool(tool)
        assert "test_tool" in provider._tools

    def test_register_tools_from_dict(self, provider: ClaudeCLIProvider):
        def read_memory() -> str:
            """Read the memory."""
            return "memory content"

        def write_memory(content: str) -> str:
            """Write to memory."""
            return f"Wrote: {content}"

        tools = {"read_memory": read_memory, "write_memory": write_memory}
        provider.register_tools_from_dict(tools)

        assert "read_memory" in provider._tools
        assert "write_memory" in provider._tools
        assert provider._tools["read_memory"].description == "Read the memory."
        assert "content" in provider._tools["write_memory"].parameters


# ── Hook tests ────────────────────────────────────────────────


class TestHooks:
    @pytest.fixture
    def provider(self) -> ClaudeCLIProvider:
        p = ClaudeCLIProvider()
        p.register_tool(
            ToolDefinition(
                name="test_tool",
                description="test",
                parameters={},
                handler=lambda: "result",
            )
        )
        return p

    @pytest.mark.asyncio
    async def test_pre_hook_allows(self, provider: ClaudeCLIProvider):
        hook_called = []
        provider.add_pre_tool_hook(lambda name, inp: hook_called.append(name))

        result = await provider._handle_tool_call(
            ToolUseRequest(tool_use_id="t1", name="test_tool", input={})
        )
        assert result == "result"
        assert hook_called == ["test_tool"]

    @pytest.mark.asyncio
    async def test_pre_hook_blocks(self, provider: ClaudeCLIProvider):
        provider.add_pre_tool_hook(lambda name, inp: False)

        result = await provider._handle_tool_call(
            ToolUseRequest(tool_use_id="t1", name="test_tool", input={})
        )
        assert "blocked" in result.lower()

    @pytest.mark.asyncio
    async def test_post_hook_called(self, provider: ClaudeCLIProvider):
        hook_results = []
        provider.add_post_tool_hook(lambda name, inp, res: hook_results.append((name, res)))

        await provider._handle_tool_call(
            ToolUseRequest(tool_use_id="t1", name="test_tool", input={})
        )
        assert hook_results == [("test_tool", "result")]

    @pytest.mark.asyncio
    async def test_unknown_tool(self, provider: ClaudeCLIProvider):
        result = await provider._handle_tool_call(
            ToolUseRequest(tool_use_id="t1", name="nonexistent", input={})
        )
        assert "Unknown tool" in result

    @pytest.mark.asyncio
    async def test_tool_handler_exception(self, provider: ClaudeCLIProvider):
        provider.register_tool(
            ToolDefinition(
                name="bad_tool",
                description="fails",
                parameters={},
                handler=lambda: (_ for _ in ()).throw(ValueError("boom")),
            )
        )
        result = await provider._handle_tool_call(
            ToolUseRequest(tool_use_id="t1", name="bad_tool", input={})
        )
        assert "Tool error" in result


# ── Streaming send tests ─────────────────────────────────────


class TestSendStream:
    @pytest.fixture
    def provider(self) -> ClaudeCLIProvider:
        return ClaudeCLIProvider()

    @pytest.mark.asyncio
    async def test_send_stream(self, provider: ClaudeCLIProvider):
        lines = streaming_lines("Hello world")
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            chunks = []
            async for chunk in provider.send_stream("Hi"):
                chunks.append(chunk)

        assert "".join(chunks) == "Hello world"

    @pytest.mark.asyncio
    async def test_send_stream_with_context(self, provider: ClaudeCLIProvider):
        lines = streaming_lines("Got it")
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            async for _ in provider.send_stream("Hi", context="ctx"):
                pass

        write_calls = mock_proc.stdin.write.call_args_list
        user_msg = json.loads(write_calls[0][0][0].decode().strip())
        assert "<context>" in user_msg["message"]["content"]


# ── Tool call integration tests ──────────────────────────────


class TestToolCallIntegration:
    @pytest.mark.asyncio
    async def test_send_with_tool_call(self):
        """Full flow: send -> tool call -> tool result -> final response."""
        lines = [
            INIT_LINE,
            # Tool use
            make_line(
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_mem1",
                        "name": "read_memory",
                        "input": {},
                    },
                }
            ),
            make_line(
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": "{}"},
                }
            ),
            make_line({"type": "content_block_stop", "index": 1}),
            # Text after tool
            make_line(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "Based on memory..."},
                }
            ),
            make_line(
                {
                    "type": "result",
                    "result": "Based on memory...",
                    "session_id": "sess-test",
                    "cost_usd": 0.005,
                }
            ),
        ]
        mock_proc = MockProcess(lines)

        provider = ClaudeCLIProvider()
        provider.register_tools_from_dict(
            {
                "read_memory": lambda: "User prefers Python",
            }
        )

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            response = await provider.send("What do I prefer?")

        assert response.text == "Based on memory..."
        assert len(response.tool_calls) == 1
        assert response.tool_calls[0]["name"] == "read_memory"

    @pytest.mark.asyncio
    async def test_process_reuse(self):
        """Multiple sends reuse the same process."""
        lines = [
            INIT_LINE,
            # First response
            make_line(
                {
                    "type": "result",
                    "result": "First",
                    "session_id": "sess-test",
                }
            ),
            # Second response
            make_line(
                {
                    "type": "result",
                    "result": "Second",
                    "session_id": "sess-test",
                }
            ),
        ]
        mock_proc = MockProcess(lines)

        provider = ClaudeCLIProvider()

        with patch(
            "remi.providers.claude_cli.process.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ) as mock_exec:
            await provider.send("First msg")
            await provider.send("Second msg")

            # Only one subprocess was created
            assert mock_exec.call_count == 1
