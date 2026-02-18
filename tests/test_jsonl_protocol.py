"""Tests for JSONL protocol parsing and formatting."""

import json

import pytest

from remi.providers.claude_cli.protocol import (
    ContentDelta,
    ResultMessage,
    SystemMessage,
    ToolUseRequest,
    format_tool_result,
    format_user_message,
    parse_line,
)


class TestParseLine:
    def test_system_init(self):
        line = json.dumps(
            {
                "type": "system",
                "subtype": "init",
                "session_id": "sess-abc",
                "tools": [{"name": "read_file"}],
                "model": "claude-sonnet-4-5-20250929",
                "mcp_servers": [],
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, SystemMessage)
        assert msg.session_id == "sess-abc"
        assert msg.model == "claude-sonnet-4-5-20250929"
        assert len(msg.tools) == 1

    def test_system_init_minimal(self):
        line = json.dumps({"type": "system", "subtype": "init"})
        msg = parse_line(line)
        assert isinstance(msg, SystemMessage)
        assert msg.session_id == ""
        assert msg.tools == []

    def test_content_delta_text(self):
        line = json.dumps(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, ContentDelta)
        assert msg.text == "Hello"
        assert msg.index == 0

    def test_input_json_delta_returns_dict(self):
        line = json.dumps(
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": '{"key":'},
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, dict)
        assert msg["delta"]["partial_json"] == '{"key":'

    def test_tool_use_from_content_block_start(self):
        line = json.dumps(
            {
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "read_memory",
                    "input": {},
                },
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, ToolUseRequest)
        assert msg.tool_use_id == "toolu_123"
        assert msg.name == "read_memory"

    def test_tool_use_from_assistant_message(self):
        line = json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Let me check."},
                        {
                            "type": "tool_use",
                            "id": "toolu_456",
                            "name": "write_memory",
                            "input": {"content": "hello"},
                        },
                    ],
                },
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, ToolUseRequest)
        assert msg.tool_use_id == "toolu_456"
        assert msg.name == "write_memory"
        assert msg.input == {"content": "hello"}

    def test_assistant_message_no_tools_returns_dict(self):
        line = json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [{"type": "text", "text": "Just text."}],
                },
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, dict)

    def test_result_message(self):
        line = json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "result": "Hello world",
                "session_id": "sess-abc",
                "cost_usd": 0.003,
                "model": "claude-sonnet-4-5-20250929",
                "is_error": False,
                "duration_ms": 1234,
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, ResultMessage)
        assert msg.result == "Hello world"
        assert msg.session_id == "sess-abc"
        assert msg.cost_usd == 0.003
        assert msg.is_error is False
        assert msg.duration_ms == 1234

    def test_result_error(self):
        line = json.dumps(
            {
                "type": "result",
                "subtype": "error",
                "result": "",
                "is_error": True,
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, ResultMessage)
        assert msg.is_error is True

    def test_unknown_type_returns_dict(self):
        line = json.dumps({"type": "unknown", "data": 123})
        msg = parse_line(line)
        assert isinstance(msg, dict)
        assert msg["type"] == "unknown"

    def test_content_block_start_text_returns_dict(self):
        line = json.dumps(
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            }
        )
        msg = parse_line(line)
        assert isinstance(msg, dict)

    def test_content_block_stop_returns_dict(self):
        line = json.dumps({"type": "content_block_stop", "index": 0})
        msg = parse_line(line)
        assert isinstance(msg, dict)

    def test_invalid_json_raises(self):
        with pytest.raises(json.JSONDecodeError):
            parse_line("not valid json")


class TestFormatMessages:
    def test_format_user_message(self):
        result = format_user_message("Hello Claude")
        data = json.loads(result)
        assert data["type"] == "user"
        assert data["message"]["role"] == "user"
        assert data["message"]["content"] == "Hello Claude"

    def test_format_tool_result(self):
        result = format_tool_result("toolu_123", "Memory content here")
        data = json.loads(result)
        assert data["type"] == "tool_result"
        assert data["tool_use_id"] == "toolu_123"
        assert data["content"] == "Memory content here"
        assert data["is_error"] is False

    def test_format_tool_result_error(self):
        result = format_tool_result("toolu_123", "Something went wrong", is_error=True)
        data = json.loads(result)
        assert data["is_error"] is True

    def test_format_roundtrip_valid_json(self):
        """Formatted messages should be valid JSON."""
        msgs = [
            format_user_message("test"),
            format_tool_result("id", "result"),
            format_tool_result("id", "err", is_error=True),
        ]
        for msg in msgs:
            data = json.loads(msg)
            assert isinstance(data, dict)
            assert "type" in data

    def test_format_user_message_special_chars(self):
        result = format_user_message('He said "hello" & <tag>')
        data = json.loads(result)
        assert data["message"]["content"] == 'He said "hello" & <tag>'

    def test_format_user_message_multiline(self):
        result = format_user_message("line1\nline2\nline3")
        data = json.loads(result)
        assert "\n" in data["message"]["content"]
