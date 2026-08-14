import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpClient } from "@acp/index.js";
import type { ElicitationCreateParams, PermissionOutcome } from "@acp/index.js";

function fakeAgent(script: string, ext = "sh"): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-client-test-"));
  const path = join(dir, `fake-agent.${ext}`);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "acp-client-test-"));
}

async function waitFor(predicate: () => boolean, attempts = 150): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Text of every agent_message_chunk the fake agent echoed back at us. */
function echoes(updates: any[]): any[] {
  return updates.map((u) => JSON.parse(u.update.content.text));
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

  it("stops a launcher and the native child that inherits its stdio", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const childPidPath = join(dir, "child.pid");
    const childPath = join(dir, "stubborn-child.js");
    writeFileSync(
      childPath,
      `const { writeFileSync } = require("node:fs");\nprocess.on("SIGTERM", () => {});\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1_000);\n`,
    );
    const executable = fakeAgent(
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [${JSON.stringify(childPath)}, ${JSON.stringify(childPidPath)}], { stdio: "inherit" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      "js",
    );
    const client = new AcpClient({ executable });
    await client.start();
    await waitFor(() => existsSync(childPidPath));
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(processIsAlive(childPid)).toBe(true);

    await client.stop();
    await waitFor(() => !processIsAlive(childPid));
    expect(processIsAlive(childPid)).toBe(false);
  });

  it("kills an inherited native child when its launcher crashes", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const childPidPath = join(dir, "child.pid");
    const childPath = join(dir, "stubborn-child.js");
    writeFileSync(
      childPath,
      `const { writeFileSync } = require("node:fs");\nprocess.on("SIGTERM", () => {});\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1_000);\n`,
    );
    const executable = fakeAgent(
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(childPath)}, ${JSON.stringify(childPidPath)}], { stdio: "inherit" });
setTimeout(() => process.exit(1), 100);
`,
      "js",
    );
    const client = new AcpClient({ executable });
    let childPid = 0;
    try {
      await client.start();
      await waitFor(() => existsSync(childPidPath));
      childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(processIsAlive(childPid)).toBe(true);

      await waitFor(() => !client.alive);
      await waitFor(() => !processIsAlive(childPid));
      expect(client.alive).toBe(false);
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      if (childPid > 0 && processIsAlive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch {}
      }
      await client.stop();
    }
  });
});

function processIsAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      // kill(pid, 0) also succeeds for a zombie. A zombie has stopped running
      // and only awaits adoption/reaping, so it satisfies this lifecycle test.
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
      if (state === "Z") return false;
    } catch {}
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

// The ACP filesystem methods are snake_case (sdk dist/schema/index.js:35-36
// `fs_read_text_file: "fs/read_text_file"`); claude-agent-acp reaches them via
// `methods.client.fs.readTextFile` (dist/acp-agent.js:557-562) and codex-acp
// registers the same constant (dist/index.js:21589). Nothing on the wire ever
// uses the camelCase spelling we used to match on.
describe("AcpClient fs methods", () => {
  it("serves fs/read_text_file and fs/write_text_file, honoring line/limit", async () => {
    const dir = tempDir();
    const readPath = join(dir, "source.txt");
    const writePath = join(dir, "written.txt");
    writeFileSync(readPath, "l1\nl2\nl3\nl4\nl5");

    const executable = fakeAgent(
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const READ = ${JSON.stringify(readPath)};
const WRITE = ${JSON.stringify(writePath)};
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    send({ jsonrpc: "2.0", id: 10, method: "fs/read_text_file", params: { sessionId: "s1", path: READ } });
    send({ jsonrpc: "2.0", id: 11, method: "fs/read_text_file", params: { sessionId: "s1", path: READ, line: 2, limit: 2 } });
    send({ jsonrpc: "2.0", id: 12, method: "fs/write_text_file", params: { sessionId: "s1", path: WRITE, content: "hello" } });
  } else if (msg.id >= 10 && msg.id <= 12) {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ id: msg.id, result: msg.result, error: msg.error }) } },
    } });
  }
});
`,
      "js",
    );

    const updates: any[] = [];
    const client = new AcpClient({ executable, onSessionUpdate: (n) => updates.push(n) });
    await client.start();
    await client.initialize();
    await waitFor(() => updates.length >= 3);
    await client.stop();

    const byId = new Map(echoes(updates).map((e) => [e.id, e]));
    expect(byId.get(10)?.error).toBeUndefined();
    expect(byId.get(10)?.result).toEqual({ content: "l1\nl2\nl3\nl4\nl5" });
    expect(byId.get(11)?.result).toEqual({ content: "l2\nl3" });
    expect(byId.get(12)?.error).toBeUndefined();
    expect(readFileSync(writePath, "utf-8")).toBe("hello");
  });
});

// The agent aborts a dialog it no longer needs by sending `$/cancel_request`
// (sdk dist/jsonrpc.js:527-528, 852-863); claude-agent-acp wires a
// cancellationSignal into both `session/request_permission` and
// `elicitation/create` (dist/acp-agent.js:552-567) and expects us to settle the
// request with a cancelled outcome (dist/acp-agent.js:3641-3647).
describe("AcpClient $/cancel_request", () => {
  it("settles an abandoned permission request as cancelled and drops the late answer", async () => {
    const executable = fakeAgent(
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Bash" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 99 } }), 100);
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
    let answer: (outcome: PermissionOutcome) => void = () => {};
    const client = new AcpClient({
      executable,
      // The human never gets around to clicking before the agent gives up.
      onPermissionRequest: () => new Promise<PermissionOutcome>((resolve) => { answer = resolve; }),
      onSessionUpdate: (n) => updates.push(n),
    });
    await client.start();
    await client.initialize();

    await waitFor(() => updates.length >= 1);
    expect(echoes(updates)).toEqual([{ outcome: { outcome: "cancelled" } }]);

    // The late human decision must not produce a second response for id 99.
    answer({ outcome: "selected", optionId: "allow" });
    await new Promise((r) => setTimeout(r, 200));
    await client.stop();
    expect(updates).toHaveLength(1);
  });

  it("settles an abandoned elicitation as action=cancel", async () => {
    const executable = fakeAgent(
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    send({ jsonrpc: "2.0", id: 42, method: "elicitation/create", params: {
      mode: "form", sessionId: "s1", message: "Pick one",
      requestedSchema: { type: "object", properties: { question_0: { type: "string" } } },
    } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 42 } }), 100);
  } else if (msg.id === 42) {
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
    const client = new AcpClient({
      executable,
      onElicitationRequest: () => new Promise(() => {}),
      onSessionUpdate: (n) => updates.push(n),
    });
    await client.start();
    await client.initialize();
    await waitFor(() => updates.length >= 1);
    await client.stop();

    expect(echoes(updates)).toEqual([{ action: "cancel" }]);
  });
});

describe("AcpClient initialize result", () => {
  it("retains the protocol version and agent capabilities for the caller", async () => {
    const executable = fakeAgent(
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {} },
      },
      agentInfo: { name: "claude-agent-acp", version: "0.66.0" },
    } });
  }
});
`,
      "js",
    );

    const client = new AcpClient({ executable });
    await client.start();
    expect(client.initializeResult).toBeNull();

    const result = await client.initialize();
    expect(client.initializeResult).toEqual(result);
    expect(client.initializeResult?.protocolVersion).toBe(1);
    expect(client.initializeResult?.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    expect(client.initializeResult?.agentCapabilities?.promptCapabilities?.image).toBe(true);

    await client.stop();
    expect(client.initializeResult).toBeNull();
  });
});

// `mcpServers` and `cwd` are both required by zLoadSessionRequest
// (sdk dist/schema/zod.gen.js:2457-2463, codex-acp dist/index.js:19550-19556);
// `requiredDefaultOnError` raises "Required value is missing" for an omitted
// `mcpServers` rather than defaulting it, so the load fails with -32602.
describe("AcpClient loadSession", () => {
  it("sends cwd and mcpServers on session/load", async () => {
    const executable = fakeAgent(
      `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { _meta: { echo: msg.params } } });
  }
});
`,
      "js",
    );

    const client = new AcpClient({ executable });
    await client.start();
    await client.initialize();
    const servers = [{ name: "recall", command: "/bin/recall", args: [], env: [] }];
    const result = await client.loadSession("sess_1", "/work/repo", servers);
    await client.stop();

    expect(result.sessionId).toBe("sess_1");
    expect(result._meta?.echo).toEqual({
      sessionId: "sess_1",
      cwd: "/work/repo",
      mcpServers: servers,
    });
  });
});
