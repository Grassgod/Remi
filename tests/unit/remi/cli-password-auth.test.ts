import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { operationsCommandSpecs } from "../../../apps/remi/cli/commands/operations.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const envNames = ["MULTIREMI_CONFIG", "MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN"] as const;
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const credentials = { email: "cli-reader@example.test", password: "  cli-login-fixture-password  " };
let directory: string;
let configPath: string;
let inputPath: string;
let output: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "remi-cli-password-"));
  configPath = join(directory, "config.json");
  inputPath = join(directory, "input.json");
  process.env.MULTIREMI_CONFIG = configPath;
  process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
  delete process.env.MULTIREMI_WORKSPACE_ID;
  delete process.env.MULTIREMI_TOKEN;
  writeFileSync(inputPath, JSON.stringify(credentials));
  output = [];
  console.log = (...parts: unknown[]) => output.push(parts.map(String).join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  rmSync(directory, { recursive: true, force: true });
});

function registry(): CommandRegistry {
  const result = new CommandRegistry();
  for (const spec of operationsCommandSpecs()) result.register(spec);
  return result;
}

describe("password authentication CLI", () => {
  it("registers canonical file-only commands without granting task parity", () => {
    const commands = registry();
    for (const [id, path] of [
      ["context.auth.password", ["context", "auth", "password"]],
      ["context.auth.password-account.set", ["context", "auth", "password-account", "set"]],
    ] as const) {
      const entry = commands.inventory().find((candidate) => candidate.id === id)!;
      expect(entry.path).toEqual(path);
      expect(entry.auth).toEqual(["human"]);
      expect(entry.options.find((option) => option.name === "file")?.required).toBe(true);
      expect(entry.options.some((option) => option.name === "password" || option.name === "data")).toBe(false);
      expect(commands.renderHelp(path)).toContain("--file");
      expect(() => commands.resolve([...path])).toThrow("--file");
      expect(() => commands.resolve([...path, "--password", "argv-secret", "--file", "-"])).toThrow("unknown option");
      expect(() => commands.resolve([...path, "--data", "{}", "--file", "-"])).toThrow("unknown option");
    }
  });

  it("bootstraps without an existing token, preserves the password, and saves only the returned session", async () => {
    writeFileSync(configPath, JSON.stringify({ provider: "codex", workspace_id: "ws_existing" }));
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(new URL(request.url).pathname);
      expect(request.headers.get("Authorization")).toBeNull();
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual(credentials);
      return Response.json({
        token: "returned-login-session",
        user: { id: "usr_password", name: "CLI Reader", email: credentials.email, password_hash: "never-print-hash" },
      });
    }) as typeof fetch;

    await registry().execute(["context", "auth", "password", "--file", inputPath, "--server", "https://new-server.example.test", "--output", "json"]);

    expect(requests).toEqual(["/auth/password"]);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      provider: "codex", workspace_id: "ws_existing", server_url: "https://new-server.example.test", token: "returned-login-session",
    });
    expect(JSON.parse(output.join("\n"))).toEqual({ id: "usr_password", name: "CLI Reader", email: credentials.email, status: "authenticated" });
    expect(output.join("\n")).not.toContain(credentials.password);
    expect(output.join("\n")).not.toMatch(/returned-login-session|never-print-hash/);
  });

  it("keeps existing configuration when credentials are rejected or the response is invalid", async () => {
    const previous = JSON.stringify({ token: "previous-session", server_url: "https://cli.example.test" });
    writeFileSync(configPath, previous);
    for (const response of [
      Response.json({ error: "Invalid email or password" }, { status: 401 }),
      Response.json({ user: { id: "usr_no_session" } }),
      Response.json({ token: "invalid-response-token", user: { id: " ", email: credentials.email } }),
      Response.json({ token: "invalid-response-token", user: { id: "usr_no_email", email: " " } }),
    ]) {
      globalThis.fetch = (async () => response) as unknown as typeof fetch;
      await expect(registry().execute(["context", "auth", "password", "--file", inputPath, "--output", "json"])).rejects.toThrow();
      expect(readFileSync(configPath, "utf8")).toBe(previous);
    }
    expect(output).toEqual([]);
  });

  it("saves the actual selected server only into the configured CLI profile", async () => {
    const otherPath = join(directory, "other-config.json");
    const otherContents = JSON.stringify({ server_url: "https://untouched.example.test", token: "untouched-session" });
    writeFileSync(otherPath, otherContents);
    for (const [environment, flag, expected] of [
      ["https://environment.example.test/", "https://explicit.example.test/", "https://explicit.example.test"],
      ["https://environment.example.test/", null, "https://environment.example.test"],
      [null, null, "https://configured.example.test"],
    ] as const) {
      writeFileSync(configPath, JSON.stringify({ server_url: "https://configured.example.test/" }));
      if (environment === null) delete process.env.MULTIREMI_SERVER_URL;
      else process.env.MULTIREMI_SERVER_URL = environment;
      globalThis.fetch = (async (input, init) => {
        expect(new Request(input, init).url).toBe(`${expected}/auth/password`);
        return Response.json({ token: "selected-profile-session", user: { id: "usr_selected", email: credentials.email } });
      }) as typeof fetch;
      await registry().execute(["context", "auth", "password", "--file", inputPath, ...(flag ? ["--server", flag] : []), "--output", "json"]);
      expect(JSON.parse(readFileSync(configPath, "utf8")).server_url).toBe(expected);
      expect(readFileSync(otherPath, "utf8")).toBe(otherContents);
    }
  });

  it.each([
    { path: ["context", "auth", "password"] },
    { path: ["context", "auth", "password-account", "set"] },
  ])("does not expose malformed password input in CLI errors for %j", async ({ path }) => {
    writeFileSync(inputPath, `{"password": "${credentials.password}"`);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("Malformed login input must not be sent");
    }) as unknown as typeof fetch;
    let message = "";
    try {
      await registry().execute([...path, "--file", inputPath]);
    } catch (error) { message = String(error); }
    expect(message).toContain("Read email/password JSON");
    expect(message).not.toContain(credentials.password);
    expect(requests).toBe(0);
    expect(output).toEqual([]);
  });

  it.each([
    { input: { workspaceId: "ws_from_file" }, args: ["--workspace", "ws_explicit"], workspace: "ws_explicit" },
    { input: { workspace_id: "ws_snake" }, args: [], workspace: "ws_snake" },
    { input: { workspaceId: "ws_camel", workspace_id: "ws_snake" }, args: [], workspace: "ws_camel" },
  ])("negotiates account provisioning and forwards the master credential with file input %j", async ({ input, args, workspace }) => {
    process.env.MULTIREMI_TOKEN = "provisioning-master-fixture";
    writeFileSync(inputPath, JSON.stringify({ ...credentials, name: "CLI Reader", ...input }));
    const paths: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      expect(request.headers.get("X-Workspace-ID")).toBe(workspace);
      expect(request.headers.get("Authorization")).toBe("Bearer provisioning-master-fixture");
      if (path === "/api/cli/capabilities") {
        return Response.json({ identity: "human", commands: [{ id: "context.auth.password-account.set", allowed: true }] });
      }
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({ ...credentials, name: "CLI Reader", workspaceId: workspace });
      return Response.json({ user: { id: "usr_provisioned", email: credentials.email }, password: credentials.password, password_hash: "never-output-this" });
    }) as typeof fetch;

    await registry().execute(["context", "auth", "password-account", "set", "--file", inputPath, ...args, "--output", "json"]);
    expect(paths).toEqual(["/api/cli/capabilities", "/api/auth/password-accounts"]);
    expect(JSON.parse(output.join("\n"))).toEqual({ user: { id: "usr_provisioned", email: credentials.email } });
    expect(output.join("\n")).not.toContain(credentials.password);
  });

  it("does not send account provisioning input after capability denial", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({ identity: "task", commands: [{ id: "context.auth.password-account.set", allowed: false }] });
    }) as unknown as typeof fetch;
    await expect(registry().execute(["context", "auth", "password-account", "set", "--file", inputPath])).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("accepts JSON over real stdin through the shipped CLI for both commands", async () => {
    const bodies: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/cli/capabilities") {
          return Response.json({ identity: "human", commands: [{ id: "context.auth.password-account.set", allowed: true }] });
        }
        bodies.push({ path, body: await request.json() });
        return Response.json(path === "/auth/password"
          ? { token: "stdin-session-fixture", user: { id: "usr_stdin", email: credentials.email } }
          : { user: { id: "usr_stdin", email: credentials.email } });
      },
    });
    try {
      for (const path of [["context", "auth", "password"], ["context", "auth", "password-account", "set"]]) {
        const child = Bun.spawn([process.execPath, "apps/remi/main.ts", ...path, "--file", "-", "--output", "json"], {
          env: { ...process.env, MULTIREMI_SERVER_URL: `http://127.0.0.1:${server.port}`, MULTIREMI_CONFIG: configPath, MULTIREMI_TOKEN: "" },
          stdin: Buffer.from(JSON.stringify(credentials)), stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exitCode, stderr).toBe(0);
        expect(stdout).not.toContain(credentials.password);
        expect(stdout).not.toContain("stdin-session-fixture");
        expect(JSON.parse(stdout)).toBeObject();
      }
      expect(bodies).toEqual([
        { path: "/auth/password", body: credentials },
        { path: "/api/auth/password-accounts", body: credentials },
      ]);
      expect(JSON.parse(readFileSync(configPath, "utf8")).token).toBe("stdin-session-fixture");
    } finally { server.stop(true); }
  });
});
