#!/usr/bin/env bun

import { createInterface } from "node:readline";

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

let sequence = 0;
const sessions = new Set<string>();

createInterface({ input: process.stdin }).on("line", (line) => {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    return;
  }
  if (request.id == null) return;

  const result = (value: unknown): void => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      return;
    case "session/new": {
      const sessionId = `ppe-${++sequence}`;
      sessions.add(sessionId);
      result({ sessionId });
      return;
    }
    case "session/resume":
    case "session/load": {
      const sessionId = String(request.params?.sessionId ?? `ppe-${++sequence}`);
      sessions.add(sessionId);
      result({ sessionId });
      return;
    }
    case "session/set_mode":
    case "session/set_config_option":
    case "session/close":
      result({});
      return;
    case "session/prompt": {
      const sessionId = String(request.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "unknown PPE session" } });
        return;
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "PPE daemon ACP smoke test completed." },
          },
        },
      });
      result({ stopReason: "end_turn" });
      return;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `method not supported by PPE fake ACP: ${request.method ?? "unknown"}` },
      });
  }
});
