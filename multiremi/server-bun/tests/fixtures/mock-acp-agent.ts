#!/usr/bin/env bun
/**
 * Minimal mock ACP agent for tests. Speaks newline-delimited JSON-RPC 2.0 over
 * stdio (the same framing AcpClient uses). Lets us verify the provider drives a
 * full turn (initialize → session/new → session/prompt → updates → result)
 * without installing a real codex-acp / claude-agent-acp binary.
 */

type Json = Record<string, unknown>;

function send(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notify(sessionId: string, update: Json): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function handle(msg: any): void {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "mock-session-1" } });
  } else if (method === "session/prompt") {
    const sessionId: string = params?.sessionId ?? "mock-session-1";
    const promptText: string = params?.prompt?.[0]?.text ?? "";
    notify(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: [{ type: "text", text: "thinking…" }],
    });
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: `echo: ${promptText}` }],
    });
    // Report the process working directory so tests can verify the executor
    // spawned the agent inside the task's checked-out git worktree.
    notify(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: `\ncwd: ${process.cwd()}` }],
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else if (id != null) {
    // Unknown request: ack so the client never hangs.
    send({ jsonrpc: "2.0", id, result: {} });
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.resume();
