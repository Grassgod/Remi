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
  project: process.env.MULTIREMI_PROJECT_ID,
  workspaceRoot: process.env.MULTIREMI_WORKSPACE_ROOT,
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
  restoreEnv("MULTIREMI_PROJECT_ID", savedEnv.project);
  restoreEnv("MULTIREMI_WORKSPACE_ROOT", savedEnv.workspaceRoot);
});

describe("native CLI resource contracts", () => {
  it("advertises task parity except for identity and workspace lifecycle commands", () => {
    const registry = registryFor(SPECS);
    const inventory = new Map(registry.inventory().map((entry) => [entry.id, entry]));
    for (const id of ["workspace.get", "workspace.update", "project.update", "repo.list", "memory.list"]) {
      expect(inventory.get(id)?.auth, id).toEqual(["human", "task"]);
    }
    for (const id of [
      "workspace.create",
      "workspace.delete",
      "workspace.leave",
      "workspace.ssh-mesh.update",
      "workspace.ssh-mesh.rotate",
      "workspace.relay.reveal",
      "member.list",
      "invite.list",
      "token.list",
      "workspace.organizer.update",
    ]) {
      expect(inventory.get(id)?.auth, id).toEqual(["human"]);
    }
  });

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

  it("manages project device bindings through canonical commands", async () => {
    useCliEnv();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/cli/capabilities") {
        return Response.json({
          protocol_version: 1,
          identity: "human",
          commands: ["project.device.list", "project.device.add", "project.device.set", "project.device.remove"]
            .map((id) => ({ id, allowed: true })),
        });
      }
      if (path === "/api/projects/prj_1" && request.method === "GET") {
        return Response.json({ id: "prj_1", title: "Independent" });
      }
      requests.push({
        method: request.method,
        path,
        body: request.method === "POST" || request.method === "PUT" ? await request.json() : null,
      });
      if (request.method === "GET") return Response.json({ devices: [{ daemon_id: "device-1" }] });
      if (request.method === "POST") return Response.json({ device: { daemon_id: "device-1" } }, { status: 201 });
      if (request.method === "PUT") return Response.json({ devices: [{ daemon_id: "device-1" }], total: 1, warning: null });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await execute(specById("project.device.list"), ["prj_1", "--output", "json"]);
    await execute(specById("project.device.add"), ["prj_1", "device-1", "--output", "json"]);
    await execute(specById("project.device.set"), ["prj_1", "--daemon", "device-1", "--daemon", "device-2", "--output", "json"]);
    await expect(execute(specById("project.device.remove"), ["prj_1", "device-1"]))
      .rejects.toThrow("requires --yes");
    await execute(specById("project.device.remove"), ["prj_1", "device-1", "--yes", "--output", "json"]);

    expect(requests).toEqual([
      { method: "GET", path: "/api/projects/prj_1/devices", body: null },
      { method: "POST", path: "/api/projects/prj_1/devices", body: { daemon_id: "device-1" } },
      { method: "PUT", path: "/api/projects/prj_1/devices", body: { daemon_ids: ["device-1", "device-2"] } },
      { method: "DELETE", path: "/api/projects/prj_1/devices/device-1", body: null },
    ]);
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

  it("passes the explicit Runtime provision version-check opt-out", async () => {
    useCliEnv();
    const spec = specById("workspace.runtime-provision.create");
    let body: unknown;
    globalThis.fetch = mockFetch(spec.id, [], async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/workspaces/ws_1") {
        return Response.json({ id: "ws_1", name: "Workspace" });
      }
      if (path === "/api/workspaces/ws_1/runtime-provisions" && request.method === "POST") {
        body = await request.json();
        return Response.json({ provision: { id: "prov_1", ...(body as object) } }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });

    await execute(spec, [
      "ws_1",
      "--kind", "npm-global",
      "--package", "example-tool",
      "--version", "latest",
      "--bin", "example-tool",
      "--no-version-check",
      "--output", "json",
    ]);

    expect(body).toMatchObject({ version_check: false });
  });

  it("updates workspace prompts and issue archive settings through explicit commands", async () => {
    useCliEnv();
    const bodies = new Map<string, unknown>();
    const handler = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/workspaces/ws_1" && request.method === "GET") {
        return Response.json({ id: "ws_1", name: "Workspace" });
      }
      if (path === "/api/workspaces/ws_1/prompts" && request.method === "PUT") {
        bodies.set(path, await request.json());
        return Response.json({ revision: 4 });
      }
      if (path === "/api/workspaces/ws_1/issue-archive" && request.method === "PUT") {
        bodies.set(path, await request.json());
        return Response.json({ config: await bodies.get(path) });
      }
      if (path === "/api/workspaces/ws_1/issue-topics" && request.method === "PUT") {
        bodies.set(path, await request.json());
        return Response.json({ config: await bodies.get(path) });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    };
    const prompts = specById("workspace.prompt.update");
    globalThis.fetch = mockFetch(prompts.id, [], handler);
    await execute(prompts, ["ws_1", "--bootstrap-prompt", "Bootstrap", "--delta-prompt=", "--expected-revision", "3", "--output", "json"]);
    expect(bodies.get("/api/workspaces/ws_1/prompts")).toEqual({
      bootstrap_prompt: "Bootstrap",
      delta_prompt: "",
      expected_revision: 3,
    });

    const archive = specById("workspace.issue-archive.update");
    globalThis.fetch = mockFetch(archive.id, [], handler);
    await execute(archive, ["ws_1", "--ttl-ms", "86400000", "--sweep-interval-ms", "60000", "--output", "json"]);
    expect(bodies.get("/api/workspaces/ws_1/issue-archive")).toEqual({ ttl_ms: 86400000, sweep_interval_ms: 60000 });

    const issueTopics = specById("workspace.issue-topics.set");
    globalThis.fetch = mockFetch(issueTopics.id, [], handler);
    await execute(issueTopics, [
      "ws_1",
      "--enabled",
      "--chat-id",
      "oc_topics",
      "--project",
      "prj_a",
      "--project",
      "prj_b",
      "--output",
      "json",
    ]);
    expect(bodies.get("/api/workspaces/ws_1/issue-topics")).toEqual({
      enabled: true,
      chat_id: "oc_topics",
      project_ids: ["prj_a", "prj_b"],
    });

    const organizer = specById("workspace.organizer.update");
    globalThis.fetch = mockFetch(organizer.id, [], async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/workspaces/ws_1" && request.method === "GET") {
        return Response.json({ id: "ws_1", name: "Workspace" });
      }
      if (path === "/api/workspaces/ws_1/organizer" && request.method === "PUT") {
        bodies.set(path, await request.json());
        return Response.json({ workspace_id: "ws_1", mode: "act" });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });
    await execute(organizer, ["ws_1", "--mode", "act", "--output", "json"]);
    expect(bodies.get("/api/workspaces/ws_1/organizer")).toEqual({ mode: "act" });
  });

  it("reads the platform prompt template through the workspace command", async () => {
    useCliEnv();
    const spec = specById("workspace.prompt.template");
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(spec.id, requests, (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/workspaces/ws_1") {
        return Response.json({ id: "ws_1", name: "Workspace" });
      }
      if (path === "/api/workspaces/ws_1/prompt-template") {
        return Response.json({
          bootstrap: "# Bootstrap Prompt",
          delta: "# Delta Prompt",
          sha256: { bootstrap: "a".repeat(64), delta: "b".repeat(64) },
        });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });

    await execute(spec, ["ws_1", "--output", "json"]);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/cli/capabilities",
      "/api/workspaces/ws_1",
      "/api/workspaces/ws_1/prompt-template",
    ]);
  });

  it("lists repositories from the API without contacting the local Git helper", async () => {
    useCliEnv();
    const spec = specById("repo.list");
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(spec.id, requests, (request) => {
      const url = new URL(request.url);
      if (url.hostname === "127.0.0.1") throw new Error("Git helper must stay offline for repo list");
      if (url.pathname === "/api/workspaces/ws_1/repos") {
        return Response.json({ repositories: [{ id: "repo_db", name: "Database only", url: "https://offline.test/repo.git" }] });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const output = await execute(spec, ["--output", "json"]);
    expect(JSON.parse(output).repositories[0]).toMatchObject({ id: "repo_db", name: "Database only" });
    expect(requests.some((request) => new URL(request.url).hostname === "127.0.0.1")).toBe(false);
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

  it("returns checkout timeout and daemon failures as retryable CLI errors", async () => {
    useCliEnv();
    const spec = specById("repo.checkout");
    globalThis.fetch = mockFetch(spec.id, [], (request) => {
      if (new URL(request.url).hostname !== "127.0.0.1") throw new Error(`unexpected request ${request.url}`);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    await expect(execute(spec, [
      "https://example.test/slow.git",
      "--daemon-port", "6121",
      "--timeout", "5",
    ])).rejects.toMatchObject({ code: "timeout", retryable: true });

    globalThis.fetch = mockFetch(spec.id, [], (request) => {
      if (new URL(request.url).hostname === "127.0.0.1") {
        return Response.json({ error: "repository fetch failed" }, { status: 500 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    await expect(execute(spec, [
      "https://example.test/fail.git",
      "--daemon-port", "6121",
    ])).rejects.toMatchObject({ code: "server", status: 500 });
  });

  it("keeps project discovery open to task credentials and renders defaults columns", async () => {
    useCliEnv();
    for (const id of ["project.list", "project.get", "project.search", "project.defaults"]) {
      expect(specById(id).auth, id).toContain("task");
    }
    const spec = specById("project.defaults");
    globalThis.fetch = mockFetch(spec.id, [], (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/projects/prj_own") {
        return Response.json({ id: "prj_own", title: "Own", default_assignee_type: "squad", default_assignee_id: "sqd_1" });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const table = await execute(spec, ["prj_own"]);
    expect(table).toContain("ASSIGNEE_TYPE");
    expect(table).toContain("squad");
    expect(table).toContain("sqd_1");
    const json = await execute(spec, ["prj_own", "--output", "json"]);
    expect(JSON.parse(json)).toEqual({
      project_id: "prj_own",
      default_assignee_type: "squad",
      default_assignee_id: "sqd_1",
    });
  });

  it("resolves a project through the workspace list when direct lookup is unavailable", async () => {
    // Compatibility fallback for older servers whose direct project lookup
    // may be narrower than their workspace project listing.
    useCliEnv();
    const spec = specById("project.defaults");
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(spec.id, requests, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/projects/prj_other") {
        return Response.json({ error: "project not found" }, { status: 404 });
      }
      if (url.pathname === "/api/projects/search") {
        return Response.json({ projects: [] });
      }
      if (url.pathname === "/api/projects") {
        return Response.json({ projects: [
          { id: "prj_own", title: "Own", default_assignee_type: "squad", default_assignee_id: "sqd_1" },
          { id: "prj_other", title: "Other", default_assignee_type: "agent", default_assignee_id: "agt_9" },
        ] });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const output = await execute(spec, ["prj_other", "--output", "json"]);
    expect(JSON.parse(output)).toEqual({
      project_id: "prj_other",
      default_assignee_type: "agent",
      default_assignee_id: "agt_9",
    });
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

  it("resolves repositories for direct Repository Wiki commands", async () => {
    useCliEnv();
    const create = specById("wiki.repository.create");
    let body: unknown;
    globalThis.fetch = mockFetch(create.id, [], async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/workspaces/ws_1/repos" && request.method === "GET") {
        return Response.json({ repositories: [{ id: "repo_123456", name: "Remi", url: "https://example.test/remi.git" }] });
      }
      if (path === "/api/workspaces/ws_1/repos/repo_123456/wiki" && request.method === "POST") {
        body = await request.json();
        return Response.json({ doc: { id: "rwd_1", ...(body as object) } }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });
    await execute(create, [
      "Remi",
      "--path", "architecture/overview.md",
      "--title", "Architecture",
      "--content", "Repository facts",
      "--source-revision", "abc123",
      "--output", "json",
    ]);
    expect(body).toMatchObject({
      path: "architecture/overview.md",
      title: "Architecture",
      body: "Repository facts",
      source_revision: "abc123",
    });
  });

  it("lists Repository Wiki backlinks through the resolved repository", async () => {
    useCliEnv();
    const backlinks = specById("wiki.repository.backlinks");
    const requests: Request[] = [];
    globalThis.fetch = mockFetch(backlinks.id, requests, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/workspaces/ws_1/repos" && request.method === "GET") {
        return Response.json({ repositories: [{ id: "repo_123456", name: "Remi", url: "https://example.test/remi.git" }] });
      }
      if (path === "/api/workspaces/ws_1/repos/repo_123456/wiki/architecture%2Foverview/backlinks" && request.method === "GET") {
        return Response.json({ docs: [{ id: "rwd_index", path: "index.md", title: "Index" }] });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });

    const output = await execute(backlinks, ["Remi", "architecture/overview", "--output", "json"]);

    expect(JSON.parse(output).docs).toEqual([{ id: "rwd_index", path: "index.md", title: "Index" }]);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /api/cli/capabilities",
      "GET /api/workspaces/ws_1/repos",
      "GET /api/workspaces/ws_1/repos",
      "GET /api/workspaces/ws_1/repos/repo_123456/wiki/architecture%2Foverview/backlinks",
    ]);
  });

  it("keeps native Repository Wiki status and push usable without a project", async () => {
    useCliEnv();
    delete process.env.MULTIREMI_PROJECT_ID;
    const directory = mkdtempSync(join(tmpdir(), "remi-cli-repository-wiki-"));
    tempDirectories.push(directory);
    process.env.MULTIREMI_WORKSPACE_ROOT = directory;

    for (const id of ["wiki.status", "wiki.push"]) {
      await expect(execute(specById(id), [])).rejects.toThrow("Wiki working copy is not initialized");
    }
    for (const id of ["wiki.pull", "wiki.diff"]) {
      await expect(execute(specById(id), [])).rejects.toThrow("--project is required");
    }
  });

  it("preserves legacy memory body flags while rejecting empty content", async () => {
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
      "--content=Durable fact",
      "--tags=",
      "--ref", "https://example.test/source",
      "--output", "json",
    ]);
    expect(body).toMatchObject({
      kind: "memory",
      title: "Compatibility",
      pinned: false,
      summary: null,
      body: "Durable fact",
      tags: [],
      refs: [{ type: "url", value: "https://example.test/source" }],
    });

    await expect(registryFor([spec]).execute([
      "memory", "remember",
      "--project", "prj_1",
      "--title", "Empty placeholder",
      "--content=",
    ])).rejects.toThrow("memory body is required");
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
