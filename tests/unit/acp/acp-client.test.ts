import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpClient } from "@remi/acp-provider";
import type { ElicitationCreateParams } from "@remi/acp-provider";

function fakeAgent(script: string, ext = "sh"): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-client-test-"));
  const path = join(dir, `fake-agent.${ext}`);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("AcpClient process death", () => {
  it("rejects in-flight requests when the agent dies without responding", async () => {
    // Agent reads one request then exits silently — the bug that froze chats.
    const executable = fakeAgent("#!/bin/sh\nread line\nexit 1\n");
    const client = new AcpClient({ executable });
    await client.start();

    await expect(client.initialize()).rejects.toThrow(/died unexpectedly/);
    expect(client.alive).toBe(false);
    expect(client.initialized).toBe(false);
  });

  it("fails fast on requests after the agent has died", async () => {
    const executable = fakeAgent("#!/bin/sh\nexit 0\n");
    const client = new AcpClient({ executable });
    await client.start();
    // Wait for the exit watcher to fire.
    await new Promise((r) => setTimeout(r, 300));

    expect(client.alive).toBe(false);
    await expect(client.initialize()).rejects.toThrow(/not running/);
  });

  it("does not reject pending state on graceful stop after death cleanup", async () => {
    const executable = fakeAgent("#!/bin/sh\nread line\nexit 1\n");
    const client = new AcpClient({ executable });
    await client.start();
    await expect(client.initialize()).rejects.toThrow(/died unexpectedly/);
    // stop() after unexpected death must be a no-op, not throw.
    await client.stop();
  });
});

describe("AcpClient elicitation", () => {
  it("answers elicitation/create via the registered handler", async () => {
    // Fake agent: respond to initialize, immediately send an elicitation, then
    // echo whatever response it gets back as a session/update notification.
    const executable = fakeAgent(
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    send({ jsonrpc: "2.0", id: 99, method: "elicitation/create", params: {
      mode: "form", sessionId: "s1", message: "Pick one",
      requestedSchema: { type: "object", properties: {
        question_0: { type: "string", oneOf: [{ const: "a" }, { const: "b" }] },
        customAnswer: { type: "string" },
      } },
    } });
  } else if (msg.id === 99) {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(msg.result) } },
    } });
  }
});
`,
      "js",
    );

    const updates: any[] = [];
    const seen: ElicitationCreateParams[] = [];
    const client = new AcpClient({
      executable,
      onElicitationRequest: async (params) => {
        seen.push(params);
        return { action: "accept", content: { question_0: "a" } };
      },
      onSessionUpdate: (n) => updates.push(n),
    });
    await client.start();
    await client.initialize();

    const deadline = Date.now() + 3000;
    while (updates.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await client.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("Pick one");
    expect(updates).toHaveLength(1);
    const echoed = JSON.parse(updates[0].update.content.text);
    expect(echoed).toEqual({ action: "accept", content: { question_0: "a" } });
  });
});
