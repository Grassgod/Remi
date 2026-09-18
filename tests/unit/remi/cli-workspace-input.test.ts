import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { collaborationCommandSpecs } from "../../../apps/remi/cli/commands/collaboration.js";
import { agentExtensionCommandSpecs } from "../../../apps/remi/cli/commands/agent-extensions.js";
import { projectCommandSpecs } from "../../../apps/remi/cli/commands/project.js";
import { tokenCommandSpecs } from "../../../apps/remi/cli/commands/token.js";

const specs = [...collaborationCommandSpecs(), ...agentExtensionCommandSpecs(), ...projectCommandSpecs(), ...tokenCommandSpecs()];
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const envKeys = ["MULTIREMI_CONFIG", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_SERVER_URL", "MULTIREMI_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;
let dir: string;
let requests: Request[];
let bodies: Record<string, unknown>[];

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), "remi-workspace-input-"));
  process.env.MULTIREMI_CONFIG = join(dir, "config.json");
  delete process.env.MULTIREMI_WORKSPACE_ID;
  process.env.MULTIREMI_SERVER_URL = "https://remi.test";
  process.env.MULTIREMI_TOKEN = "test-credential";
  requests = [];
  bodies = [];
  console.log = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/cli/capabilities") return Response.json({ commands: specs.map(({ id }) => ({ id, allowed: true })) });
    if (request.method === "GET" && path.endsWith("/repos")) {
      return Response.json({ repositories: [{ id: "repo_test", name: "Repo", url: "https://repo.test/a.git" }] });
    }
    const body = await request.json() as Record<string, unknown>;
    bodies.push(body);
    return Response.json({ id: "created", ...body });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true });
});

async function execute(id: string, args: string[]): Promise<void> {
  const spec = specs.find((candidate) => candidate.id === id)!;
  const registry = new CommandRegistry();
  registry.register(spec);
  await registry.execute([...spec.path, ...args, "--output", "json"]);
}

function expectWorkspace(workspace: string): void {
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) expect(request.headers.get("X-Workspace-ID")).toBe(workspace);
  expect(bodies.at(-1)?.workspace_id).toBe(workspace);
}

describe("CLI explicit input workspace", () => {
  for (const [id, args] of [
    ["label.create", ["--name", "Label"]],
    ["chat.create", ["--agent", "agt_test"]],
    ["token.create", []],
    ["agent.create", []],
    ["squad.create", []],
    ["skill.create", []],
    ["project.create", []],
  ] as const) {
    it(`${id} uses JSON workspace for capability and mutation requests`, async () => {
      await execute(id, [...args, "--data", JSON.stringify({ workspace_id: "ws_json", name: "Name", title: "Title", content: "Content" })]);
      expectWorkspace("ws_json");
    });
  }

  it("uses input workspace before environment and saved configuration during repository resolution", async () => {
    writeFileSync(process.env.MULTIREMI_CONFIG!, JSON.stringify({ workspace_id: "ws_config" }));
    process.env.MULTIREMI_WORKSPACE_ID = "ws_env";
    await execute("project.create", ["--repo", "Repo", "--data", JSON.stringify({ workspace_id: "ws_json", title: "Title" })]);
    expectWorkspace("ws_json");
    expect(requests.some((request) => new URL(request.url).pathname === "/api/workspaces/ws_json/repos")).toBe(true);
  });

  it("uses explicit workspace flag over both JSON aliases for headers, lookups and body", async () => {
    await execute("project.create", ["--workspace", "ws_flag", "--repo", "Repo", "--data", JSON.stringify({ workspace_id: "ws_snake", workspaceId: "ws_camel", title: "Title" })]);
    expectWorkspace("ws_flag");
    expect(bodies[0]?.workspaceId).toBe("ws_flag");
    expect(requests.some((request) => new URL(request.url).pathname === "/api/workspaces/ws_flag/repos")).toBe(true);
  });

  it("normalizes conflicting JSON aliases to the selected camelCase workspace", async () => {
    await execute("token.create", ["--data", JSON.stringify({ workspaceId: "ws_camel", workspace_id: "ws_snake", name: "Name" })]);
    expectWorkspace("ws_camel");
    expect(bodies[0]?.workspaceId).toBe("ws_camel");
  });

  it("preserves environment, configuration and local defaults when JSON omits workspace", async () => {
    writeFileSync(process.env.MULTIREMI_CONFIG!, JSON.stringify({ workspace_id: "ws_config" }));
    process.env.MULTIREMI_WORKSPACE_ID = "ws_env";
    await execute("token.create", ["--data", '{"name":"Name"}']);
    expectWorkspace("ws_env");
    delete process.env.MULTIREMI_WORKSPACE_ID;
    requests = [];
    await execute("token.create", ["--data", '{"name":"Name"}']);
    expectWorkspace("ws_config");
    rmSync(process.env.MULTIREMI_CONFIG!);
    await execute("token.create", ["--data", '{"name":"Name"}']);
    expect(bodies.at(-1)?.workspace_id).toBe("local");
  });

  it("accepts camelCase workspace from a file before saved configuration", async () => {
    writeFileSync(process.env.MULTIREMI_CONFIG!, JSON.stringify({ workspace_id: "ws_config" }));
    const file = join(dir, "input.json");
    writeFileSync(file, JSON.stringify({ workspaceId: "ws_file", name: "Name" }));
    await execute("token.create", ["--file", file]);
    expectWorkspace("ws_file");
    expect(bodies[0]?.workspaceId).toBe("ws_file");
  });

  it("consumes stdin once and keeps input scoped to each command invocation", () => {
    const script = `
      import { CommandRegistry } from ${JSON.stringify(fileURLToPath(new URL("../../../apps/remi/cli/core/index.ts", import.meta.url)))};
      import { tokenCommandSpecs } from ${JSON.stringify(fileURLToPath(new URL("../../../apps/remi/cli/commands/token.ts", import.meta.url)))};
      const requests = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const workspace = request.headers.get("X-Workspace-ID");
        if (new URL(request.url).pathname === "/api/cli/capabilities") {
          requests.push({ workspace });
          return Response.json({ commands: [{ id: "token.create", allowed: true }] });
        }
        requests.push({ workspace, body: await request.json() });
        return Response.json({ id: "created" });
      };
      const output = console.log;
      console.log = () => {};
      const registry = new CommandRegistry();
      registry.register(tokenCommandSpecs().find((spec) => spec.id === "token.create"));
      await registry.execute(["token", "create", "--file", "-", "--json"]);
      await registry.execute(["token", "create", "--data", JSON.stringify({ workspace_id: "ws_second", name: "Second" }), "--json"]);
      output(JSON.stringify(requests));
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      stdin: Buffer.from(JSON.stringify({ workspace_id: "ws_stdin", name: "First" })),
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      { workspace: "ws_stdin" },
      { workspace: "ws_stdin", body: { workspace_id: "ws_stdin", name: "First" } },
      { workspace: "ws_second" },
      { workspace: "ws_second", body: { workspace_id: "ws_second", name: "Second" } },
    ]);
  });
});
