#!/usr/bin/env bun
/**
 * MCP Server for Remi memory tools (recall + remember).
 *
 * Runs as a standalone stdio MCP server so Claude Code CLI can
 * natively discover and call these tools.
 *
 * Protocol: JSON-RPC 2.0 over stdio (Content-Length framing, like LSP).
 *
 * Usage:
 *   bun run src/mcp/memory-server.ts
 *
 * Register in ~/.claude/.mcp.json:
 *   { "mcpServers": { "remi-memory": { "command": "bun", "args": ["run", "<path>/memory-server.ts"] } } }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../memory/store.js";

// ── Constants ────────────────────────────────────────────────

const MEMORY_ROOT = join(homedir(), ".remi", "memory");
const SERVER_NAME = "remi-memory";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

// ── MemoryStore singleton ────────────────────────────────────

let store: MemoryStore;
try {
  store = new MemoryStore(MEMORY_ROOT);
} catch (e) {
  process.stderr.write(`[${SERVER_NAME}] Failed to init MemoryStore: ${e}\n`);
  process.exit(1);
}

// ── Tool definitions ─────────────────────────────────────────

const TOOLS = [
  {
    name: "recall",
    description:
      "搜索 Remi 记忆系统。可搜索联系人、项目记忆、历史日志等所有记忆源。" +
      "精确匹配实体名或别名返回全文，模糊匹配返回摘要列表。",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词（实体名、别名、日期、或任意文本）",
        },
        cwd: {
          type: "string",
          description: "当前工作目录（可选，用于搜索项目级记忆）",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "即时保存重要信息到 Remi 记忆系统。" +
      "当用户告知生日、偏好、决策等值得长期保存的内容时调用。" +
      "实体不存在则自动创建，已存在则追加为新观察。",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity: { type: "string", description: "实体名称" },
        type: {
          type: "string",
          description: "实体类型（person/organization/project/decision/software/platform/...）",
        },
        observation: { type: "string", description: "要记住的信息" },
        scope: {
          type: "string",
          enum: ["personal", "project"],
          description: "存储范围：personal=个人记忆（默认），project=项目记忆",
        },
        cwd: {
          type: "string",
          description: "当前工作目录（scope=project 时必填）",
        },
      },
      required: ["entity", "type", "observation"],
    },
  },
];

// ── JSON-RPC 2.0 helpers ─────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// ── Request handler ──────────────────────────────────────────

function handleRequest(req: JsonRpcRequest): Record<string, unknown> | null {
  // Notifications (no id) — don't send response
  if (req.id === undefined || req.id === null) {
    if (req.method === "notifications/initialized") {
      process.stderr.write(`[${SERVER_NAME}] Client initialized\n`);
    }
    return null;
  }

  switch (req.method) {
    case "initialize":
      return jsonRpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "tools/list":
      return jsonRpcResult(req.id, { tools: TOOLS });

    case "tools/call": {
      const params = req.params as { name: string; arguments?: Record<string, unknown> };
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "recall") {
        const result = store.recall(args.query as string, {
          cwd: (args.cwd as string) || null,
        });
        return jsonRpcResult(req.id, {
          content: [{ type: "text", text: result || "(无匹配结果)" }],
        });
      }

      if (toolName === "remember") {
        const result = store.remember(
          args.entity as string,
          args.type as string,
          args.observation as string,
          (args.scope as "personal" | "project") || "personal",
          (args.cwd as string) || null,
        );
        return jsonRpcResult(req.id, {
          content: [{ type: "text", text: result }],
        });
      }

      return jsonRpcResult(req.id, {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      });
    }

    default:
      return jsonRpcError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ── Stdio transport (auto-detect: Content-Length framing OR NDJSON) ──

function sendMessage(msg: Record<string, unknown>): void {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

function processJsonRpc(json: string): void {
  try {
    const req = JSON.parse(json) as JsonRpcRequest;
    process.stderr.write(`[${SERVER_NAME}] <- ${req.method}\n`);
    const response = handleRequest(req);
    if (response) {
      sendMessage(response);
      process.stderr.write(`[${SERVER_NAME}] -> response for ${req.method}\n`);
    }
  } catch (e) {
    process.stderr.write(`[${SERVER_NAME}] Parse error: ${e}\n`);
  }
}

async function main(): Promise<void> {
  process.stderr.write(`[${SERVER_NAME}] Starting (memory_root=${MEMORY_ROOT})\n`);

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Try Content-Length framing first
    while (buffer.includes("Content-Length:")) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (buffer.length < bodyEnd) break;

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);
      processJsonRpc(body);
    }

    // Fallback: NDJSON (newline-delimited JSON)
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      // Skip if it looks like a Content-Length header (will be handled above)
      if (line.startsWith("Content-Length:")) continue;
      processJsonRpc(line);
    }
  }

  process.stderr.write(`[${SERVER_NAME}] stdin closed, exiting\n`);
}

main().catch((e) => {
  process.stderr.write(`[${SERVER_NAME}] Fatal: ${e}\n`);
  process.exit(1);
});
