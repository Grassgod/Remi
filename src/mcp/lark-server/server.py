#!/usr/bin/env python3
"""
MCP Server: remi-lark — 飞书文档获取工具。

将 bytedance.lark_parser SDK 封装为 MCP tool (lark_fetch),
供 Claude Code CLI 调用以读取飞书文档并转换为 Markdown。

Protocol: JSON-RPC 2.0 over stdio (NDJSON).

Usage:
  uv run --project <this-dir> python server.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from bytedance.lark_parser import LarkParser

# ── Constants ────────────────────────────────────────────────

SERVER_NAME = "remi-lark"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"
TOKEN_FILE = Path.home() / ".remi" / "auth" / "tokens.json"
MAX_OUTPUT_CHARS = 80_000  # Prevent blowing up context

# ── Singleton parser ─────────────────────────────────────────

parser = LarkParser()

# ── Tool definitions ─────────────────────────────────────────

TOOLS = [
    {
        "name": "lark_fetch",
        "description": (
            "获取飞书/Lark文档内容并转换为Markdown格式。"
            "支持 docx、wiki、sheet、bitable 等文档类型。"
            "输入飞书文档 URL，返回结构化的 Markdown 内容。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": (
                        "飞书文档 URL，如 "
                        "https://xxx.feishu.cn/wiki/xxx 或 "
                        "https://xxx.larkoffice.com/docx/xxx"
                    ),
                },
                "mode": {
                    "type": "string",
                    "enum": ["fast", "retry", "strict"],
                    "description": "转换模式：strict=含限流重试（默认），retry=3次重试，fast=无重试",
                },
                "access_token": {
                    "type": "string",
                    "description": "飞书 API access_token（可选，默认自动从 Remi 凭据读取）",
                },
            },
            "required": ["url"],
        },
    }
]

# ── Token management ─────────────────────────────────────────


def load_access_token() -> str | None:
    """Read access_token from Remi token persistence (~/.remi/auth/tokens.json).

    Prefers user_access_token, falls back to tenant_access_token.
    Checks expiry to avoid using stale tokens.
    """
    if not TOKEN_FILE.exists():
        return None
    try:
        data = json.loads(TOKEN_FILE.read_text())
        feishu = data.get("feishu", {})
        now_ms = time.time() * 1000
        for key in ("user", "tenant"):
            entry = feishu.get(key, {})
            value = entry.get("value")
            expires_at = entry.get("expiresAt", 0)
            if value and expires_at > now_ms:
                return value
        return None
    except Exception:
        return None


# ── lark_fetch implementation ────────────────────────────────


async def lark_fetch(args: dict) -> str:
    """Execute lark_fetch: convert a Lark document URL to Markdown."""
    url = args.get("url", "").strip()
    if not url:
        return "[错误] 缺少 url 参数"

    mode = args.get("mode", "strict")
    access_token = args.get("access_token") or load_access_token()

    if not access_token:
        return (
            "[错误] 无可用的 access_token。"
            "请确保 Remi 已完成飞书 OAuth 认证（~/.remi/auth/tokens.json），"
            "或在调用时提供 access_token 参数。"
        )

    try:
        result = await parser.aconvert(
            url=url,
            access_token=access_token,
            mode=mode,
            agent_friendly=True,
            output=["markdown"],
        )
    except Exception as e:
        return f"[错误] 文档转换失败: {e}"

    # Build output from result
    parts: list[str] = []
    for doc in result.docs:
        header_parts = []
        if doc.meta.title:
            header_parts.append(f"# {doc.meta.title}")
        if doc.meta.url:
            header_parts.append(f"> 来源: {doc.meta.url}")
        if doc.meta.latest_modify_time:
            header_parts.append(
                f"> 最后修改: {time.strftime('%Y-%m-%d %H:%M', time.localtime(doc.meta.latest_modify_time))}"
            )
        if header_parts:
            parts.append("\n".join(header_parts))
        parts.append(doc.markdown)

    if not parts:
        return "[文档内容为空]"

    output = "\n\n".join(parts).strip()

    if len(output) > MAX_OUTPUT_CHARS:
        output = (
            output[:MAX_OUTPUT_CHARS]
            + f"\n\n... [内容截断，共 {len(output)} 字符，已显示前 {MAX_OUTPUT_CHARS} 字符]"
        )

    return output


# ── JSON-RPC 2.0 helpers ─────────────────────────────────────


def jsonrpc_result(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def jsonrpc_error(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


# ── Request handler ──────────────────────────────────────────


async def handle_request(req: dict) -> dict | None:
    req_id = req.get("id")
    method = req.get("method", "")

    # Notifications (no id) — no response
    if req_id is None:
        if method == "notifications/initialized":
            log("Client initialized")
        return None

    if method == "initialize":
        return jsonrpc_result(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })

    if method == "tools/list":
        return jsonrpc_result(req_id, {"tools": TOOLS})

    if method == "tools/call":
        params = req.get("params", {})
        tool_name = params.get("name", "")
        args = params.get("arguments", {})

        if tool_name == "lark_fetch":
            try:
                text = await lark_fetch(args)
            except Exception as e:
                text = f"[内部错误] {e}"
            return jsonrpc_result(req_id, {
                "content": [{"type": "text", "text": text}],
            })

        return jsonrpc_result(req_id, {
            "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
            "isError": True,
        })

    return jsonrpc_error(req_id, -32601, f"Method not found: {method}")


# ── Logging ──────────────────────────────────────────────────


def log(msg: str):
    sys.stderr.write(f"[{SERVER_NAME}] {msg}\n")
    sys.stderr.flush()


# ── Stdio transport (NDJSON) ─────────────────────────────────


async def main():
    log(f"Starting (token_file={TOKEN_FILE})")

    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        line = line.decode("utf-8").strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            log(f"<- {req.get('method', '?')}")
            response = await handle_request(req)
            if response:
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
        except json.JSONDecodeError as e:
            log(f"Parse error: {e}")
        except Exception as e:
            log(f"Handler error: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log(f"Fatal: {e}")
        sys.exit(1)
