import { afterEach, describe, expect, it } from "bun:test";
import { CommandRegistry, CliError, type CommandSpec } from "../../../apps/remi/cli/core/index.js";
import { operationsCommandSpecs } from "../../../apps/remi/cli/commands/operations.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const savedEnv = {
  server: process.env.MULTIREMI_SERVER_URL,
  workspace: process.env.MULTIREMI_WORKSPACE_ID,
  token: process.env.MULTIREMI_TOKEN,
};
const specs = operationsCommandSpecs();

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  restoreEnv("MULTIREMI_SERVER_URL", savedEnv.server);
  restoreEnv("MULTIREMI_WORKSPACE_ID", savedEnv.workspace);
  restoreEnv("MULTIREMI_TOKEN", savedEnv.token);
});

describe("operations CLI contracts", () => {
  it("advertises task parity for platform operations while keeping control-plane administration denied", () => {
    const registry = registryFor(specs);
    const inventory = new Map(registry.inventory().map((entry) => [entry.id, entry]));
    for (const id of [
      "runtime.list",
      "runtime.update",
      "autopilot.list",
      "autopilot.update",
      "platform.feedback.create",
      "feishu.messages.propose-issue",
      "platform.status",
      "platform.operation.list",
      "platform.operation.create",
      "platform.operation.cancel",
    ]) {
      expect(inventory.get(id)?.auth, id).toContain("task");
    }
    for (const id of [
      "runtime.delete",
      "runtime.archive-agents-and-delete",
      "runtime.release.start",
      "runtime.cloud.status",
      "billing.balance",
      "platform.settings.update",
      "daemon.retire",
      "feishu.messages.create-issue",
      "feishu.proposals.approve",
      "feishu.proposals.reject",
      "lark.install.begin",
      "lark.installation.delete",
      "lark.binding.redeem",
      "notification.channel.create",
      "notification.channel.update",
      "notification.channel.delete",
      "notification.delivery.retry",
      "context.auth.logout",
    ]) {
      expect(inventory.get(id)?.auth, id).not.toContain("task");
    }
  });

  it("declares shared output/paging contracts and confirms every destructive command", () => {
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

  it("keeps local daemon lifecycle and update aliases on byte-compatible legacy dispatch", () => {
    const registry = registryFor([
      ...["start", "stop", "restart", "status", "logs", "service", "update"].map(legacyParent),
      ...specs,
    ]);
    for (const command of ["start", "stop", "restart", "status", "logs", "service", "update"]) {
      const invocation = registry.resolve([command, "--test-argument"]);
      expect(invocation?.spec.id, command).toBe(`legacy.${command}`);
      expect(invocation?.rawArgs, command).toEqual(["--test-argument"]);
      const alias = specs.flatMap((spec) => spec.aliases ?? []).find((candidate) => candidate.path.join(" ") === command);
      expect(alias, command).toMatchObject({ deprecatedSince: "0.3.0", dispatch: false });
    }
  });

  it("reports runtime impact and refuses deletion without --yes", async () => {
    useCliEnv();
    const spec = specById("runtime.delete");
    const requests: Request[] = [];
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/runtimes") return Response.json([{ id: "rt_123456", name: "Builder runtime" }]);
      if (url.pathname === "/api/agents") return Response.json({ agents: [{ id: "agt_1", status: "active" }, { id: "agt_2", status: "archived" }] });
      if (request.method === "DELETE" && url.pathname === "/api/runtimes/rt_123456") return Response.json({ status: "ok" });
      throw new Error(`unexpected ${request.method} ${url.pathname}`);
    });
    await expect(registryFor([spec]).execute(["runtime", "delete", "Builder runtime"]))
      .rejects.toThrow("requires --yes");
    const result = await capture(() => registryFor([spec]).execute(["runtime", "delete", "Builder runtime", "--yes", "--output", "json"]));
    expect(result.stderr).toContain("1 active agent(s)");
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("reviews the daemon retirement snapshot and sends the exact confirmed snapshot", async () => {
    useCliEnv();
    const spec = specById("daemon.retire");
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/retirement-plan")) {
        return Response.json({ plan: { snapshot: "snapshot-1", impact: { runtimes_removed: 2, agents_detached: 3, queued_tasks_requeued: 1 } } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/retire")) {
        body = await request.json() as Record<string, unknown>;
        return Response.json({ status: "retired" });
      }
      throw new Error(`unexpected ${request.method} ${url.pathname}`);
    });
    const result = await capture(() => registryFor([spec]).execute(["daemon", "retire", "dmn_1", "--yes", "--output", "json"]));
    expect(result.stderr).toContain("2 runtime(s), 3 agent(s), 1 queued task(s)");
    expect(body).toMatchObject({ expected_snapshot: "snapshot-1", workspace_id: "ws_1" });
  });

  it("redacts secret-bearing SCM, billing, and Lark output plus server errors", async () => {
    useCliEnv();
    const cases = [
      { id: "scm.connection.get", argv: ["scm", "connection", "get", "scm_1"], path: "/api/workspaces/ws_1/scm/connections/scm_1" },
      { id: "billing.balance", argv: ["billing", "balance"], path: "/api/cloud-billing/balance" },
      { id: "lark.installation.list", argv: ["lark", "installation", "list"], path: "/api/workspaces/ws_1/lark/installations" },
    ];
    for (const entry of cases) {
      const spec = specById(entry.id);
      const secrets = [`${entry.id}-token-value`, `${entry.id}-password-value`, `${entry.id}-secret-value`];
      globalThis.fetch = capabilityFetch(spec.id, (request) => {
        const path = new URL(request.url).pathname;
        if (entry.id === "scm.connection.get" && path === "/api/workspaces/ws_1/scm/connections") {
          return Response.json({ connections: [{ id: "scm_1", name: "Production" }] });
        }
        expect(path).toBe(entry.path);
        return Response.json({ id: entry.id, access_token: secrets[0], password: secrets[1], app_secret: secrets[2], authorization: `Bearer ${secrets[0]}` });
      });
      const output = await capture(() => registryFor([spec]).execute([...entry.argv, "--output", "json"]));
      for (const secret of secrets) expect(output.stdout).not.toContain(secret);
      expect(output.stdout.toLowerCase()).not.toMatch(/token|password|secret|key|authorization/);
    }

    const error = new CliError("server", "authorization=server-error-secret password:other-secret", {
      details: { token: "details-secret" },
    });
    expect(JSON.stringify(error.toJSON())).not.toMatch(/server-error-secret|other-secret|details-secret/);
  });

  it("lets unauthenticated login bootstrap run before capability negotiation", async () => {
    process.env.MULTIREMI_SERVER_URL = "https://cli.example.test";
    delete process.env.MULTIREMI_TOKEN;
    const spec = specById("context.auth.send-code");
    const paths: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      paths.push(new URL(request.url).pathname);
      return Response.json({ ok: true });
    }) as typeof fetch;
    await capture(() => registryFor([spec]).execute(["context", "auth", "send-code", "--data", '{"email":"person@example.test"}', "--output", "json"]));
    expect(paths).toEqual(["/auth/send-code"]);
  });

  it("cancels a platform operation through the registered destructive command", async () => {
    useCliEnv();
    const spec = specById("platform.operation.cancel");
    const requests: Request[] = [];
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      requests.push(request);
      return Response.json({ operation: { id: "op_123", status: "cancelled" } });
    });

    await expect(registryFor([spec]).execute(["platform", "operation", "cancel", "op_123"]))
      .rejects.toThrow("requires --yes");
    await capture(() => registryFor([spec]).execute([
      "platform", "operation", "cancel", "op_123", "--yes", "--output", "json",
    ]));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe("/api/multiremi/platform/operations/op_123/cancel");
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

function legacyParent(name: string): CommandSpec {
  return { id: `legacy.${name}`, path: [name], description: "legacy", parse: "passthrough", run: async () => {} };
}

async function capture(run: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  try {
    await run();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
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
