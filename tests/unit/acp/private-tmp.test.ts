import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { AcpClient, isolateProcessTmp, mapPrivateTmpPath } from "@acp/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateDirectory(label: string): string {
  const parent = join(process.cwd(), ".test-private-tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `${label}-`));
  roots.push(root);
  return root;
}

describe("task private /tmp", () => {
  it("isolates the same literal /tmp path across concurrent process trees", async () => {
    if (process.platform !== "linux") return;
    const first = privateDirectory("first");
    const second = privateDirectory("second");
    const barrier = privateDirectory("barrier");
    const shell = Bun.which("sh")!;
    const script = 'printf "%s" "$1" > /tmp/log.json; touch "$2/$1"; while [ ! -f "$2/first" ] || [ ! -f "$2/second" ]; do sleep 0.01; done; cat /tmp/log.json';
    const run = (directory: string, value: string) => {
      const launch = isolateProcessTmp({ executable: shell, args: ["-ceu", script, "sh", value, barrier] }, directory);
      return Bun.spawn( [launch.executable, ...launch.args], { stdout: "pipe", stderr: "pipe" });
    };
    const one = run(first, "first");
    const two = run(second, "second");
    const [oneOut, twoOut, oneCode, twoCode] = await Promise.all([
      new Response(one.stdout).text(), new Response(two.stdout).text(), one.exited, two.exited,
    ]);
    expect([oneCode, twoCode]).toEqual([0, 0]);
    expect([oneOut, twoOut]).toEqual(["first", "second"]);
    expect(readFileSync(join(first, "log.json"), "utf8")).toBe("first");
    expect(readFileSync(join(second, "log.json"), "utf8")).toBe("second");
  });

  it("maps daemon-served ACP file paths into the same task directory", () => {
    const directory = privateDirectory("mapping");
    expect(mapPrivateTmpPath("/tmp/log.json", directory)).toBe(join(directory, "log.json"));
    expect(mapPrivateTmpPath("/tmp/nested/../result.txt", directory)).toBe(join(directory, "result.txt"));
    expect(mapPrivateTmpPath("/tmp/../etc/hosts", directory)).toBe("/tmp/../etc/hosts");
    expect(mapPrivateTmpPath("relative.txt", directory)).toBe("relative.txt");
  });

  it("shares the private mount between child tools and daemon-served ACP file tools", async () => {
    if (process.platform !== "linux") return;
    const directory = privateDirectory("acp-fs");
    const executable = join(directory, "fake-agent.cjs");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let readResult = null;
let wrote = false;
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    fs.writeFileSync("/tmp/log.json", "from-child");
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    send({ jsonrpc: "2.0", id: 10, method: "fs/read_text_file", params: { path: "/tmp/log.json" } });
    send({ jsonrpc: "2.0", id: 11, method: "fs/write_text_file", params: { path: "/tmp/provider.txt", content: "from-provider" } });
    return;
  }
  if (msg.id === 10) readResult = msg.result?.content;
  if (msg.id === 11) wrote = true;
  if (readResult !== null && wrote) send({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: {
      type: "text", text: JSON.stringify({ readResult, providerResult: fs.readFileSync("/tmp/provider.txt", "utf8") }),
    } },
  } });
});
`);
    chmodSync(executable, 0o755);
    const updates: any[] = [];
    const client = new AcpClient({
      executable,
      privateTmpDirectory: directory,
      onSessionUpdate: update => updates.push(update),
    });
    await client.start();
    await client.initialize();
    const deadline = Date.now() + 3_000;
    while (!updates.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await client.stop();
    expect(JSON.parse(updates[0].update.content.text)).toEqual({
      readResult: "from-child",
      providerResult: "from-provider",
    });
    expect(readFileSync(join(directory, "provider.txt"), "utf8")).toBe("from-provider");
  });

  it("fails closed when the private directory is invalid", () => {
    expect(() => isolateProcessTmp({ executable: "true", args: [] }, join(process.cwd(), "missing-private-tmp")))
      .toThrow("private_tmp_isolation_unavailable");
  });

  it("preserves an environment-referenced host Unix socket inside private /tmp", async () => {
    if (process.platform !== "linux") return;
    const directory = privateDirectory("socket");
    const socketPath = `/tmp/remi-private-tmp-${randomUUID()}.sock`;
    const server = createServer(socket => socket.end("ok"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const env = { ...process.env, SSH_AUTH_SOCK: socketPath };
      const launch = isolateProcessTmp({
        executable: Bun.which("sh")!,
        args: ["-ceu", 'test -S "$SSH_AUTH_SOCK"'],
      }, directory, env);
      const child = Bun.spawn([launch.executable, ...launch.args], { env, stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { rmSync(socketPath, { force: true }); } catch {}
    }
  });
});
