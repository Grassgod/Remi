"""Tests for ClaudeProcessManager (mocked subprocess)."""

import json

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from remi.providers.jsonl_protocol import (
    ContentDelta,
    ResultMessage,
    SystemMessage,
    ToolUseRequest,
)
from remi.providers.process_manager import ClaudeProcessManager


def make_line(data: dict) -> bytes:
    """Helper: dict -> JSONL bytes with newline."""
    return (json.dumps(data) + "\n").encode()


class MockProcess:
    """Mock asyncio.subprocess.Process with controllable stdout."""

    def __init__(self, lines: list[bytes]):
        self._lines = list(lines)
        self._line_idx = 0
        self.returncode = None
        self.pid = 12345
        self.stdin = MagicMock()
        self.stdin.write = MagicMock()
        self.stdin.drain = AsyncMock()
        self.stdin.close = MagicMock()
        self.stdout = self  # self acts as stdout reader
        self.stderr = MagicMock()

    async def readline(self):
        if self._line_idx < len(self._lines):
            line = self._lines[self._line_idx]
            self._line_idx += 1
            return line
        return b""

    async def wait(self):
        self.returncode = 0


INIT_LINE = make_line({
    "type": "system",
    "subtype": "init",
    "session_id": "sess-123",
    "tools": [],
    "model": "claude-sonnet-4-5-20250929",
})


@pytest.fixture
def manager():
    return ClaudeProcessManager(model="claude-sonnet-4-5-20250929")


class TestBuildCommand:
    def test_basic(self, manager):
        cmd = manager._build_command()
        assert cmd[0] == "claude"
        assert "--input-format" in cmd
        idx = cmd.index("--input-format")
        assert cmd[idx + 1] == "stream-json"
        assert "--output-format" in cmd
        assert "--verbose" in cmd

    def test_with_model(self, manager):
        cmd = manager._build_command()
        assert "--model" in cmd
        idx = cmd.index("--model")
        assert cmd[idx + 1] == "claude-sonnet-4-5-20250929"

    def test_with_allowed_tools(self):
        mgr = ClaudeProcessManager(allowed_tools=["Read", "Write"])
        cmd = mgr._build_command()
        assert "--allowedTools" in cmd
        idx = cmd.index("--allowedTools")
        assert cmd[idx + 1] == "Read,Write"

    def test_with_system_prompt(self):
        mgr = ClaudeProcessManager(system_prompt="Be helpful")
        cmd = mgr._build_command()
        assert "--append-system-prompt" in cmd
        idx = cmd.index("--append-system-prompt")
        assert cmd[idx + 1] == "Be helpful"

    def test_minimal(self):
        mgr = ClaudeProcessManager()
        cmd = mgr._build_command()
        assert "--model" not in cmd
        assert "--allowedTools" not in cmd
        assert "--append-system-prompt" not in cmd


class TestStartStop:
    @pytest.mark.asyncio
    async def test_start(self, manager):
        mock_proc = MockProcess([INIT_LINE])

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            result = await manager.start()

        assert isinstance(result, SystemMessage)
        assert result.session_id == "sess-123"
        assert manager.is_alive
        assert manager.session_id == "sess-123"

    @pytest.mark.asyncio
    async def test_start_already_running(self, manager):
        mock_proc = MockProcess([INIT_LINE])

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()

            with pytest.raises(RuntimeError, match="already running"):
                await manager.start()

    @pytest.mark.asyncio
    async def test_stop(self, manager):
        mock_proc = MockProcess([INIT_LINE])

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()
            assert manager.is_alive

            await manager.stop()
            assert not manager.is_alive

    @pytest.mark.asyncio
    async def test_stop_when_not_running(self, manager):
        # Should not raise
        await manager.stop()
        assert not manager.is_alive

    def test_not_alive_initially(self, manager):
        assert not manager.is_alive
        assert manager.session_id is None


class TestSendAndStream:
    @pytest.mark.asyncio
    async def test_text_streaming(self, manager):
        lines = [
            INIT_LINE,
            make_line({
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            }),
            make_line({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            }),
            make_line({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": " world"},
            }),
            make_line({"type": "content_block_stop", "index": 0}),
            make_line({
                "type": "result",
                "result": "Hello world",
                "session_id": "sess-123",
                "cost_usd": 0.001,
            }),
        ]
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()

            messages = []
            async for msg in manager.send_and_stream("Hi"):
                messages.append(msg)

        deltas = [m for m in messages if isinstance(m, ContentDelta)]
        results = [m for m in messages if isinstance(m, ResultMessage)]

        assert len(deltas) == 2
        assert deltas[0].text == "Hello"
        assert deltas[1].text == " world"
        assert len(results) == 1
        assert results[0].result == "Hello world"
        assert results[0].cost_usd == 0.001

    @pytest.mark.asyncio
    async def test_tool_call_streaming(self, manager):
        """Tool use via content_block_start + input_json_delta + content_block_stop."""
        lines = [
            INIT_LINE,
            # Tool use block
            make_line({
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "read_memory",
                    "input": {},
                },
            }),
            make_line({
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": "{}"},
            }),
            make_line({"type": "content_block_stop", "index": 1}),
            # After tool result, text response
            make_line({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Memory says hi"},
            }),
            make_line({
                "type": "result",
                "result": "Memory says hi",
                "session_id": "sess-123",
            }),
        ]
        mock_proc = MockProcess(lines)

        async def mock_tool_handler(req: ToolUseRequest) -> str:
            assert req.name == "read_memory"
            return "memory content"

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()

            messages = []
            async for msg in manager.send_and_stream(
                "Read my memory", tool_handler=mock_tool_handler
            ):
                messages.append(msg)

        tool_reqs = [m for m in messages if isinstance(m, ToolUseRequest)]
        assert len(tool_reqs) == 1
        assert tool_reqs[0].name == "read_memory"

        # Verify tool result was written to stdin
        write_calls = mock_proc.stdin.write.call_args_list
        # First write: user message, second write: tool result
        assert len(write_calls) >= 2
        tool_result_line = write_calls[1][0][0].decode().strip()
        tool_result_data = json.loads(tool_result_line)
        assert tool_result_data["type"] == "tool_result"
        assert tool_result_data["tool_use_id"] == "toolu_1"
        assert tool_result_data["content"] == "memory content"

    @pytest.mark.asyncio
    async def test_tool_call_with_accumulated_input(self, manager):
        """Tool input arrives in multiple input_json_delta chunks."""
        lines = [
            INIT_LINE,
            make_line({
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_2",
                    "name": "write_memory",
                    "input": {},
                },
            }),
            make_line({
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": '{"content"'},
            }),
            make_line({
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": ': "hello"}'},
            }),
            make_line({"type": "content_block_stop", "index": 1}),
            make_line({
                "type": "result",
                "result": "Done",
                "session_id": "sess-123",
            }),
        ]
        mock_proc = MockProcess(lines)

        received_input = {}

        async def mock_tool_handler(req: ToolUseRequest) -> str:
            nonlocal received_input
            received_input = req.input
            return "ok"

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()

            async for _ in manager.send_and_stream(
                "Write memory", tool_handler=mock_tool_handler
            ):
                pass

        assert received_input == {"content": "hello"}

    @pytest.mark.asyncio
    async def test_tool_call_no_handler(self, manager):
        """Tool call without handler — should still yield the request."""
        lines = [
            INIT_LINE,
            make_line({
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_3",
                    "name": "unknown_tool",
                    "input": {},
                },
            }),
            make_line({
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": "{}"},
            }),
            make_line({"type": "content_block_stop", "index": 1}),
            make_line({
                "type": "result",
                "result": "Done",
                "session_id": "sess-123",
            }),
        ]
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()

            messages = []
            async for msg in manager.send_and_stream("test", tool_handler=None):
                messages.append(msg)

        # Tool request should still be yielded
        tool_reqs = [m for m in messages if isinstance(m, ToolUseRequest)]
        assert len(tool_reqs) == 1

    @pytest.mark.asyncio
    async def test_not_running_raises(self, manager):
        with pytest.raises(RuntimeError, match="not running"):
            async for _ in manager.send_and_stream("test"):
                pass

    @pytest.mark.asyncio
    async def test_session_id_updated_from_result(self, manager):
        lines = [
            INIT_LINE,
            make_line({
                "type": "result",
                "result": "ok",
                "session_id": "sess-new",
            }),
        ]
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()
            assert manager.session_id == "sess-123"

            async for _ in manager.send_and_stream("test"):
                pass

            assert manager.session_id == "sess-new"

    @pytest.mark.asyncio
    async def test_user_message_written_to_stdin(self, manager):
        lines = [
            INIT_LINE,
            make_line({"type": "result", "result": "ok", "session_id": "sess-123"}),
        ]
        mock_proc = MockProcess(lines)

        with patch(
            "remi.providers.process_manager.asyncio.create_subprocess_exec",
            return_value=mock_proc,
        ):
            await manager.start()

            async for _ in manager.send_and_stream("Hello there"):
                pass

        # Check stdin write
        write_calls = mock_proc.stdin.write.call_args_list
        assert len(write_calls) >= 1
        user_msg = json.loads(write_calls[0][0][0].decode().strip())
        assert user_msg["type"] == "user"
        assert user_msg["message"]["content"] == "Hello there"
