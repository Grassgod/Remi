import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry, type CommandSpec } from "../../../apps/remi/cli/core/index.js";
import { inviteCommandSpecs } from "../../../apps/remi/cli/commands/invite.js";
import { knowledgeCommandSpecs } from "../../../apps/remi/cli/commands/knowledge.js";
import { memberCommandSpecs } from "../../../apps/remi/cli/commands/member.js";
import { projectCommandSpecs } from "../../../apps/remi/cli/commands/project.js";
import { repoCommandSpecs } from "../../../apps/remi/cli/commands/repo.js";
import { tokenCommandSpecs } from "../../../apps/remi/cli/commands/token.js";
import { workspaceCommandSpecs } from "../../../apps/remi/cli/commands/workspace.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const tempDirectories: string[] = [];
const savedEnv = {
  server: process.env.MULTIREMI_SERVER_URL,
  workspace: process.env.MULTIREMI_WORKSPACE_ID,
  token: process.env.MULTIREMI_TOKEN,
};

const SPECS = [
  ...workspaceCommandSpecs(),
  ...memberCommandSpecs(),
  ...inviteCommandSpecs(),
  ...tokenCommandSpecs(),
  ...projectCommandSpecs(),
  ...repoCommandSpecs(),
  ...knowledgeCommandSpecs(),
];

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  restoreEnv("MULTIREMI_SERVER_URL", savedEnv.server);
  restoreEnv("MULTIREMI_WORKSPACE_ID", savedEnv.workspace);
  restoreEnv("MULTIREMI_TOKEN", savedEnv.token);
});

describe("native CLI resource contracts", () => {
  it("gives every read command paging/output options and every destructive command --yes", () => {
    const native = SPECS.filter((spec) => spec.capability);
    for (const spec of native) {
      expect(spec.outputs, spec.id).toEqual(["table", "json", "jsonl"]);
      const options = new Set(spec.options?.map((option) => option.name));
      expect(options.has("output"), spec.id).toBe(true);
      expect(options.has("workspace"), spec.id).toBe(true);
      if (spec.mutation === "read") {
        for (const option of ["limit", "cursor", "query"]) expect(options.has(option), `${spec.id} --${option}`).toBe(true);
      }
      if (spec.mutation === "destructive") expect(options.has("yes"), `${spec.id} --yes`).toBe(true);
      if (spec.path.at(-1) === "create" || spec.path.at(-1) === "update") {
        expect(options.has("data"), `${spec.id} --data`).toBe(true);
        expect(options.has("file"), `${spec.id} --file`).toBe(true);
      }
    }
  });

  it("renders workspace list as table, JSON, and JSONL", async () => {
    useCliEnv();
    const spec = specById("workspace.list");
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(spec.id, requests, (request) => {
      if (new URL(request.url).pathname === "/api/workspaces") {
        return Response.json([{ id: "ws_1", name: "Alpha", status: "active" }]);
      }
      throw new Error(`unexpected request ${request.url}`);
    });

    for (const mode of ["table", "json", "jsonl"] as const) {
      const output = await execute(spec, ["--output", mode]);
      if (mode === "table") expect(output).toContain("Alpha");
      else if (mode === "json") expect(JSON.parse(output)).toEqual([{ id: "ws_1", name: "Alpha", status: "active" }]);
      else expect(JSON.parse(output)).toMatchObject({ id: "ws_1", name: "Alpha" });
    }
    expect(requests.filter((request) => new URL(request.url).pathname === "/api/workspaces")).toHaveLength(3);
  });

  it("merges file input with explicit workspace create fields", async () => {
    useCliEnv();
    const spec = specById("workspace.create");
    const directory = mkdtempSync(join(tmpdir(), "remi-cli-resource-"));
    tempDirectories.push(directory);
    const inputPath = join(directory, "workspace.json");
    writeFileSync(inputPath, JSON.stringify({ name: "From file", description: "file description" }));
    let body: unknown;
    globalThis.fetch = mockFetch(spec.id, [], async (request) => {
      if (new URL(request.url).pathname === "/api/workspaces") {
        body = await request.json();
        return Response.json({ id: "ws_new", ...(body as object) }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });

    await execute(spec, ["--file", inputPath, "--name", "Explicit", "--output", "json"]);
    expect(body).toEqual({ name: "Explicit", description: "file description" });
  });

  it("resolves repository names when creating a project and carries explicit defaults", async () => {
    useCliEnv();
    const spec = specById("project.create");
    let body: any;
    globalThis.fetch = mockFetch(spec.id, [], async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/workspaces/ws_1/repos") {
        return Response.json({ repositories: [{ id: "repo_123456", name: "Remi", url: "https://example.test/remi.git" }] });
      }
      if (url.pathname === "/api/projects") {
        body = await request.json();
        return Response.json({ id: "prj_1", ...body }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });

    await execute(spec, [
      "--title", "CLI parity",
      "--repo", "Remi",
      "--default-assignee", "agt_default",
      "--default-assignee-type", "agent",
      "--output", "json",
    ]);
    expect(body).toMatchObject({
      workspace_id: "ws_1",
      title: "CLI parity",
      default_assignee_id: "agt_default",
      default_assignee_type: "agent",
      resources: [{ resource_type: "github_repo", resource_ref: { url: "https://example.test/remi.git" } }],
    });
  });

  it("keeps URL checkout compatibility and resolves ID/name checkout through the database directory", async () => {
    useCliEnv();
    const spec = specById("repo.checkout");
    const requests: Request[] = [];
    const daemonBodies: any[] = [];
    globalThis.fetch = mockFetch(spec.id, requests, async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "127.0.0.1") {
        daemonBodies.push(await request.json());
        return Response.json({ path: "/tmp/worktree", branch_name: "main" });
      }
      if (url.pathname === "/api/workspaces/ws_1/repos") {
        return Response.json({ repositories: [{ id: "repo_123456", name: "Remi", url: "https://example.test/remi.git" }] });
      }
      throw new Error(`unexpected request ${request.url}`);
    });

    await execute(spec, ["https://example.test/direct.git", "--daemon-port", "6121", "--output", "json"]);
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/repos"))).toHaveLength(0);
    await execute(spec, ["repo_123", "--daemon-port", "6121", "--ref", "feature", "--output", "json"]);
    expect(daemonBodies).toEqual([
      expect.objectContaining({ url: "https://example.test/direct.git", ref: "" }),
      expect.objectContaining({ url: "https://example.test/remi.git", ref: "feature" }),
    ]);
    const help = registryFor(SPECS).renderHelp(["repo", "checkout"]);
    expect(help).toContain("URLs are used directly");
    expect(help).toContain("IDs, short IDs, and names resolve from the database");
    expect(help).toContain("--ref <branch-or-sha>");
  });

  it("registers all legacy memory/wiki paths as deprecated aliases", () => {
    const registry = registryFor(SPECS);
    const aliases = [
      ["memory", "recall", "query"],
      ["memory", "remember"],
      ["memory", "add"],
      ["memory", "read", "doc"],
      ["memory", "forget", "doc"],
      ["wiki", "read", "doc"],
      ["wiki", "history", "doc"],
      ["project", "knowledge", "retry-failed"],
    ];
    for (const argv of aliases) {
      const resolved = registry.resolve(argv);
      expect(resolved?.alias?.deprecatedSince, argv.join(" ")).toBe("0.3.0");
      expect(resolved?.alias?.replacement, argv.join(" ")).toStartWith("remi ");
    }
  });

  it("preserves legacy memory body flags while routing through the native command", async () => {
    useCliEnv();
    console.log = () => {};
    const spec = specById("memory.create");
    let body: any;
    globalThis.fetch = mockFetch(spec.id, [], async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/projects/prj_1") return Response.json({ id: "prj_1", title: "Project" });
      if (url.pathname === "/api/projects/prj_1/docs") {
        body = await request.json();
        return Response.json({ id: "pdoc_1", ...body }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });

    await registryFor([spec]).execute([
      "memory", "remember",
      "--project", "prj_1",
      "--title", "Compatibility",
      "--pinned", "false",
      "--summary=",
      "--content=",
      "--tags=",
      "--ref", "https://example.test/source",
      "--output", "json",
    ]);
    expect(body).toMatchObject({
      kind: "memory",
      title: "Compatibility",
      pinned: false,
      summary: null,
      body: "",
      tags: [],
      refs: [{ type: "url", value: "https://example.test/source" }],
    });
    expect(spec.options?.some((option) => option.name === "content-stdin")).toBe(true);
  });

  it("accepts the legacy positional project on knowledge migration aliases", async () => {
    useCliEnv();
    console.log = () => {};
    const spec = specById("memory.migration.backfill");
    let body: any;
    globalThis.fetch = mockFetch(spec.id, [], async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/projects/prj_1") return Response.json({ id: "prj_1", title: "Project" });
      if (url.pathname === "/api/project-knowledge/migration/backfill") {
        body = await request.json();
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected request ${request.url}`);
    });

    await registryFor([spec]).execute([
      "project", "knowledge", "backfill", "prj_1", "--dry-run", "--output", "json",
    ]);
    expect(body).toMatchObject({ project_id: "prj_1", workspace_id: "ws_1", dry_run: true });
  });
});

function specById(id: string): CommandSpec {
  const spec = SPECS.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`missing test spec ${id}`);
  return spec;
}

function registryFor(specs: readonly CommandSpec[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const spec of specs) registry.register(spec);
  return registry;
}

async function execute(spec: CommandSpec, args: string[]): Promise<string> {
  const output: string[] = [];
  console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); };
  console.error = () => {};
  await registryFor([spec]).execute([...spec.path, ...args]);
  return output.join("\n");
}

function mockFetch(
  commandId: string,
  requests: Request[],
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({
        protocol_version: 1,
        identity: "human",
        commands: [{ id: commandId, allowed: true }],
      });
    }
    return handler(request);
  }) as typeof fetch;
}

function useCliEnv(): void {
  process.env.MULTIREMI_SERVER_URL = "https://api.example.test";
  process.env.MULTIREMI_WORKSPACE_ID = "ws_1";
  process.env.MULTIREMI_TOKEN = "human-credential";
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
