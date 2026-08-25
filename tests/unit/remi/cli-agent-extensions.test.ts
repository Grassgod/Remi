import { afterEach, describe, expect, it } from "bun:test";
import { CommandRegistry, type CommandSpec } from "../../../apps/remi/cli/core/index.js";
import { agentExtensionCommandSpecs } from "../../../apps/remi/cli/commands/agent-extensions.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const savedEnv = {
  server: process.env.MULTIREMI_SERVER_URL,
  workspace: process.env.MULTIREMI_WORKSPACE_ID,
  token: process.env.MULTIREMI_TOKEN,
};
const specs = agentExtensionCommandSpecs();

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  restoreEnv("MULTIREMI_SERVER_URL", savedEnv.server);
  restoreEnv("MULTIREMI_WORKSPACE_ID", savedEnv.workspace);
  restoreEnv("MULTIREMI_TOKEN", savedEnv.token);
});

describe("agent extension CLI contracts", () => {
  it("declares shared output/paging contracts and confirmations", () => {
    for (const spec of specs.filter((candidate) => candidate.capability)) {
      const options = new Set(spec.options?.map((option) => option.name));
      expect(spec.outputs, spec.id).toEqual(["table", "json", "jsonl"]);
      expect(options.has("output"), `${spec.id} --output`).toBe(true);
      expect(options.has("workspace"), `${spec.id} --workspace`).toBe(true);
      if (spec.mutation === "read") {
        for (const name of ["limit", "cursor", "query"]) {
          expect(options.has(name), `${spec.id} --${name}`).toBe(true);
        }
      }
      if (spec.mutation === "destructive") {
        expect(options.has("yes"), `${spec.id} --yes`).toBe(true);
      }
    }
  });

  it("registers legacy agent and seed paths as deprecated aliases", () => {
    const aliases = specs.flatMap((spec) => (spec.aliases ?? []).map((alias) => ({ spec, alias })));
    for (const [argv, replacement] of [
      [["multiremi", "agent", "list"], "remi agent list"],
      [["multiremi", "agent", "get", "agt_1"], "remi agent get"],
      [["multiremi", "agent", "edit", "agt_1"], "remi agent update"],
      [["multiremi", "agent", "update", "agt_1"], "remi agent update"],
      [["seed", "--provider", "codex"], "remi agent default"],
      [["multiremi", "seed", "--provider", "claude"], "remi agent default"],
    ] as const) {
      const registered = aliases.find(({ alias }) => alias.path.join(" ") === argv.slice(0, alias.path.length).join(" "));
      expect(registered?.alias.deprecatedSince, argv.join(" ")).toBe("0.3.0");
      expect(registered?.alias.replacement, argv.join(" ")).toBe(replacement);
    }
    const registry = registryFor(specs);
    const seeded = registry.resolve(["seed", "--provider", "codex"]);
    expect(seeded?.spec.id).toBe("agent.default");
    expect(seeded?.options.provider).toBe("codex");
    expect(seeded?.rawArgs).toEqual(["--provider", "codex"]);
  });

  it("renders agent lists as table, JSON, and JSONL", async () => {
    useCliEnv();
    const spec = specById("agent.list");
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      if (new URL(request.url).pathname === "/api/agents") {
        return Response.json({ agents: [{ id: "agt_123", name: "Builder", provider: "codex", status: "active" }] });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const table = await capture(() => registryFor([spec]).execute(["agent", "list", "--output", "table"]));
    const json = await capture(() => registryFor([spec]).execute(["agent", "list", "--output", "json"]));
    const jsonl = await capture(() => registryFor([spec]).execute(["agent", "list", "--output", "jsonl"]));
    expect(table).toContain("Builder");
    expect(JSON.parse(json)).toMatchObject({ agents: [{ id: "agt_123", name: "Builder" }] });
    expect(JSON.parse(jsonl)).toMatchObject({ id: "agt_123", name: "Builder" });
  });

  it("resolves squad names and requires confirmation before member removal", async () => {
    useCliEnv();
    const spec = specById("squad.member.remove");
    const requests: Request[] = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/squads") {
        return Response.json([{ id: "sqd_123456", name: "Core" }]);
      }
      if (url.pathname === "/api/squads/sqd_123456/members" && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });
    await expect(registryFor([spec]).execute(["squad", "member", "remove", "Core", "agt_1"]))
      .rejects.toThrow("requires --yes");
    await capture(() => registryFor([spec]).execute(["squad", "member", "remove", "Core", "agt_1", "--type", "agent", "--yes", "--output", "json"]));
    const deletion = requests.find((request) => request.method === "DELETE");
    expect(deletion).toBeDefined();
    expect(await deletion!.json()).toEqual({ member_type: "agent", member_id: "agt_1" });
  });

  it("resolves archived Agent names before restore", async () => {
    useCliEnv();
    const spec = specById("agent.restore");
    let restoredPath = "";
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/agents") {
        expect(url.searchParams.get("include_archived")).toBe("true");
        return Response.json({ agents: [{ id: "agt_archived_123", name: "Archived builder", status: "archived" }] });
      }
      if (request.method === "POST" && url.pathname.endsWith("/restore")) {
        restoredPath = url.pathname;
        return Response.json({ id: "agt_archived_123", name: "Archived builder", status: "active" });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });
    await capture(() => registryFor([spec]).execute(["agent", "restore", "Archived builder", "--output", "json"]));
    expect(restoredPath).toBe("/api/agents/agt_archived_123/restore");
  });

  it("advertises Task parity for Agent Plugin surfaces", () => {
    const inventory = registryFor(specs).inventory();
    for (const spec of inventory.filter((candidate) => candidate.path[0] === "plugin" || candidate.path.slice(0, 2).join(" ") === "agent plugin")) {
      if (!spec.capability) continue;
      expect(spec.auth, spec.id).toContain("task");
    }
  });
});

function specById(id: string): CommandSpec {
  const spec = specs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`missing spec ${id}`);
  return spec;
}

function registryFor(entries: readonly CommandSpec[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const entry of entries) registry.register(entry);
  return registry;
}

async function capture(run: () => Promise<unknown>): Promise<string> {
  const output: string[] = [];
  console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); };
  console.error = () => {};
  try {
    await run();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return output.join("\n");
}

function capabilityFetch(commandId: string, handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ identity: "human", commands: [{ id: commandId, allowed: true }] });
    }
    return handler(request);
  }) as typeof fetch;
}

function useCliEnv(): void {
  process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
  process.env.MULTIREMI_WORKSPACE_ID = "ws_1";
  process.env.MULTIREMI_TOKEN = "test-token";
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
