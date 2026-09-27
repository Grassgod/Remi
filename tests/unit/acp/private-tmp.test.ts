import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import {
  AcpClient,
  isolateProcessTmp,
  mapPrivateTmpPath,
  privateTmpVisiblePath,
  PrivateTmpIsolationUnavailableError,
} from "@acp/index.js";
import { privateTmpRealDirectory } from "@acp/private-tmp.js";

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

function unavailableIsolation(directory: string): PrivateTmpIsolationUnavailableError | null {
  try {
    isolateProcessTmp({ executable: Bun.which("true") ?? "true", args: [] }, directory);
    return null;
  } catch (error) {
    if (error instanceof PrivateTmpIsolationUnavailableError) return error;
    throw error;
  }
}

describe("task private /tmp", () => {
  it("isolates the same literal /tmp path across concurrent process trees", async () => {
    if (process.platform !== "linux") return;
    const first = privateDirectory("first");
    const second = privateDirectory("second");
    const barrier = privateDirectory("barrier");
    const unavailable = unavailableIsolation(first);
    if (unavailable) {
      expect(unavailable.code).toBe("private_tmp_isolation_unavailable");
      expect(unavailable.message).toContain("runtime cannot create a private /tmp mount");
      return;
    }
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
    expect(privateTmpVisiblePath(join(directory, "nested", "result.txt"), directory)).toBe("/tmp/nested/result.txt");
    expect(() => privateTmpVisiblePath(join(directory, "..", "outside.txt"), directory))
      .toThrow("task temporary path escapes its private directory");
  });

  it("shares the private mount between child tools and daemon-served ACP file tools", async () => {
    if (process.platform !== "linux") return;
    const directory = privateDirectory("acp-fs");
    const unavailable = unavailableIsolation(directory);
    if (unavailable) {
      expect(unavailable.code).toBe("private_tmp_isolation_unavailable");
      expect(unavailable.message).toContain("runtime cannot create a private /tmp mount");
      return;
    }
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

  // MUL-449: macOS has no user/mount namespace. The execution keeps its own
  // temp directory through TMPDIR/TMP/TEMP instead of a literal /tmp mount, and
  // the path mappings must stay identity so shell and ACP file tools agree.
  it("downgrades to TMPDIR redirection on darwin without unshare", () => {
    const directory = privateDirectory("darwin");
    const launch = isolateProcessTmp(
      { executable: "/usr/local/bin/fake-agent", args: ["--flag", "value"] },
      directory,
      { PATH: "/usr/bin" },
      "darwin",
    );
    expect(launch.executable).toBe("/usr/local/bin/fake-agent");
    expect(launch.args).toEqual(["--flag", "value"]);
    expect(launch.env).toEqual({ TMPDIR: directory, TMP: directory, TEMP: directory });
    expect(launch.executable).not.toContain("unshare");

    expect(mapPrivateTmpPath("/tmp/log.json", directory, "darwin")).toBe("/tmp/log.json");
    expect(mapPrivateTmpPath("/tmp/nested/../result.txt", directory, "darwin")).toBe("/tmp/nested/../result.txt");
    expect(privateTmpVisiblePath(join(directory, "run.log"), directory, "darwin")).toBe(join(directory, "run.log"));
    expect(privateTmpVisiblePath("/tmp/log.json", directory, "darwin")).toBe("/tmp/log.json");
  });

  it("keeps failing closed on other non-Linux platforms and for invalid directories", () => {
    const directory = privateDirectory("win32");
    expect(() => isolateProcessTmp({ executable: "agent.exe", args: [] }, directory, {}, "win32"))
      .toThrow("Linux mount namespaces are unavailable on win32");
    // darwin must still reject a directory that is not the daemon's real one.
    expect(() => isolateProcessTmp(
      { executable: "agent", args: [] },
      join(process.cwd(), "missing-private-tmp"),
      {},
      "darwin",
    )).toThrow("private_tmp_isolation_unavailable");
  });

  it("does not leave a shared env object polluted across launches", () => {
    const directory = privateDirectory("env-merge");
    const shared = { PATH: "/usr/bin", TMPDIR: "/var/folders/host" };
    const launch = isolateProcessTmp({ executable: "agent", args: [] }, directory, shared, "darwin");
    expect(launch.env).toEqual({ TMPDIR: directory, TMP: directory, TEMP: directory });
    expect(shared).toEqual({ PATH: "/usr/bin", TMPDIR: "/var/folders/host" });
  });

  // MUL-449: on macOS the daemon hands over a SHORT /tmp alias because a unix
  // socket path is capped at 104 bytes. The darwin branch must export that alias
  // verbatim instead of resolving it back to the long real directory.
  it("exports the darwin alias verbatim instead of resolving it to the real path", () => {
    const real = privateDirectory("darwin-alias-real");
    const alias = join("/tmp", `remi-test-${randomUUID().slice(0, 8)}`);
    symlinkSync(real, alias);
    roots.push(alias);
    const launch = isolateProcessTmp(
      { executable: "/usr/local/bin/fake-agent", args: [] },
      alias,
      {},
      "darwin",
    );
    expect(launch.env).toEqual({ TMPDIR: alias, TMP: alias, TEMP: alias });
    expect(launch.env!.TMPDIR).not.toBe(real);
    // Mapping stays identity on darwin, so the alias path is untouched.
    expect(mapPrivateTmpPath(join(alias, "log.json"), alias, "darwin")).toBe(join(alias, "log.json"));
    expect(privateTmpVisiblePath(join(alias, "run.log"), alias, "darwin")).toBe(join(alias, "run.log"));
  });

  it("resolves a linked ancestor on the default Linux directory path", () => {
    const real = privateDirectory("linked-parent-real");
    const alias = join("/tmp", `remi-parent-${randomUUID().slice(0, 8)}`);
    symlinkSync(real, alias);
    roots.push(alias);
    const directory = join(alias, "task-tmp");
    mkdirSync(directory);
    expect(privateTmpRealDirectory(directory)).toBe(realpathSync(directory));
    expect(privateTmpRealDirectory(directory)).not.toBe(directory);
    expect(privateTmpRealDirectory(directory, false)).toBe(directory);
  });

  it("fails closed when the private directory is invalid", () => {
    expect(() => isolateProcessTmp({ executable: "true", args: [] }, join(process.cwd(), "missing-private-tmp")))
      .toThrow("private_tmp_isolation_unavailable");
  });

  it("hands the darwin TMPDIR to the spawned provider process", async () => {
    const directory = privateDirectory("darwin-client");
    const executable = join(directory, "fake-agent.cjs");
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (msg.method !== "initialize") return;
  send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  send({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text",
      text: JSON.stringify({ tmpdir: process.env.TMPDIR, tmp: process.env.TMP, temp: process.env.TEMP }) } },
  } });
});
`);
    chmodSync(executable, 0o755);
    const updates: any[] = [];
    const client = new AcpClient({
      executable,
      privateTmpDirectory: directory,
      privateTmpPlatform: "darwin",
      env: { TMPDIR: "/var/folders/host-tmp" },
      onSessionUpdate: update => updates.push(update),
    });
    await client.start();
    await client.initialize();
    const deadline = Date.now() + 3_000;
    while (!updates.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await client.stop();
    expect(JSON.parse(updates[0].update.content.text)).toEqual({
      tmpdir: directory, tmp: directory, temp: directory,
    });
  });

  it("preserves environment-referenced host files and Unix sockets inside private /tmp", async () => {
    if (process.platform !== "linux") return;
    const directory = privateDirectory("socket");
    const unavailable = unavailableIsolation(directory);
    if (unavailable) {
      expect(unavailable.code).toBe("private_tmp_isolation_unavailable");
      expect(unavailable.message).toContain("runtime cannot create a private /tmp mount");
      return;
    }
    const socketPath = `/tmp/remi-private-tmp-${randomUUID()}.sock`;
    const credentialPath = `/tmp/remi-private-tmp-${randomUUID()}.credential`;
    writeFileSync(credentialPath, "credential");
    const server = createServer(socket => socket.end("ok"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const env = { ...process.env, SSH_AUTH_SOCK: socketPath, TEST_CREDENTIAL_FILE: credentialPath };
      const launch = isolateProcessTmp({
        executable: Bun.which("sh")!,
        args: ["-ceu", 'test -S "$SSH_AUTH_SOCK" && test "$(cat "$TEST_CREDENTIAL_FILE")" = credential'],
      }, directory, env);
      const child = Bun.spawn([launch.executable, ...launch.args], { env, stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { rmSync(socketPath, { force: true }); } catch {}
      rmSync(credentialPath, { force: true });
    }
  });
});
