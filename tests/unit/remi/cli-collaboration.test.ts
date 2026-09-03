import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CommandRegistry, type CommandSpec } from "../../../apps/remi/cli/core/index.js";
import {
  BOOTSTRAP_COMPATIBILITY_PATHS,
  collaborationCommandSpecs,
} from "../../../apps/remi/cli/commands/collaboration.js";
import { runMultiremi } from "../../../apps/remi/cli/multiremi.js";

const root = resolve(import.meta.dir, "../../..");
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const savedEnv = {
  server: process.env.MULTIREMI_SERVER_URL,
  workspace: process.env.MULTIREMI_WORKSPACE_ID,
  token: process.env.MULTIREMI_TOKEN,
};
const specs = collaborationCommandSpecs();

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  restoreEnv("MULTIREMI_SERVER_URL", savedEnv.server);
  restoreEnv("MULTIREMI_WORKSPACE_ID", savedEnv.workspace);
  restoreEnv("MULTIREMI_TOKEN", savedEnv.token);
});

describe("native collaboration CLI contracts", () => {
  it("keeps issue share capability management human-only", () => {
    const inventory = new Map(registryFor(specs).inventory().map((entry) => [entry.id, entry]));
    for (const id of ["share.get", "share.create", "share.extend", "share.delete"]) {
      expect(inventory.get(id)?.auth, id).toEqual(["human"]);
    }
    expect(inventory.get("share.view")?.auth).toEqual(["human", "share", "task"]);
  });

  it("declares output/paging contracts and confirmations for native destructive commands", () => {
    for (const spec of specs.filter((candidate) => candidate.capability)) {
      expect(spec.outputs, spec.id).toEqual(["table", "json", "jsonl"]);
      const options = new Set(spec.options?.map((option) => option.name));
      expect(options.has("output"), `${spec.id} --output`).toBe(true);
      expect(options.has("workspace"), `${spec.id} --workspace`).toBe(true);
      if (spec.mutation === "read") {
        for (const name of ["limit", "cursor", "query"]) {
          expect(options.has(name), `${spec.id} --${name}`).toBe(true);
        }
      }
      if (spec.mutation === "destructive" && spec.parse !== "passthrough") {
        expect(options.has("yes"), `${spec.id} --yes`).toBe(true);
      }
    }
  });

  it("injects canonical daemon prompt paths while preserving legacy issue dispatch", () => {
    const daemonSource = readFileSync(resolve(root, "packages/daemon/src/agent-runtime/prompts/ephemeral.ts"), "utf8");
    const canonicalPromptPaths = [
      "comment list",
      "comment add",
      "session result publish",
    ];
    for (const path of canonicalPromptPaths) {
      expect(daemonSource, path).toContain(`remi ${path}`);
    }
    const compatibilityPaths = [
      "issue comment list",
      "issue comment add",
      "issue session result publish",
    ];
    for (const path of compatibilityPaths) {
      expect(daemonSource, path).not.toContain(`remi ${path}`);
      expect(BOOTSTRAP_COMPATIBILITY_PATHS).toContain(path as typeof BOOTSTRAP_COMPATIBILITY_PATHS[number]);
    }

    const registry = new CommandRegistry();
    registry.register(legacyParent("issue"));
    registry.register(legacyParent("attachment"));
    for (const spec of specs) registry.register(spec);
    const cases = [
      ["issue", "comment", "list", "iss_1", "--thread", "cmt_1", "--output", "json"],
      ["issue", "comment", "add", "iss_1", "--parent", "cmt_1", "--content-stdin"],
      ["issue", "session", "result", "publish", "iss_1", "--session", "ises_1", "--content-stdin"],
    ];
    for (const argv of cases) {
      const invocation = registry.resolve(argv);
      expect(invocation?.spec.id, argv.join(" ")).toBe(`legacy.${argv[0]}`);
      expect(invocation?.rawArgs, argv.join(" ")).toEqual(argv.slice(1));
    }

    const attachmentDownload = registry.resolve(["attachment", "download", "att_1", "--output-dir", "/tmp"]);
    expect(attachmentDownload?.spec.id).toBe("issue.attachment.download");
    expect(attachmentDownload?.positionals).toEqual(["att_1"]);
    expect(attachmentDownload?.options["output-dir"]).toBe("/tmp");

    const inventory = specs.flatMap((spec) => spec.aliases ?? []);
    for (const path of compatibilityPaths) {
      expect(inventory.some((alias) => alias.path.join(" ") === path && alias.dispatch === false), path).toBe(true);
    }

    const taskMessages = registry.resolve(["task", "messages", "tsk_1", "--since", "4"]);
    expect(taskMessages?.spec.id).toBe("task.message.list");
    expect(taskMessages?.options.since).toBe(4);
  });

  it("keeps issue list output byte-compatible with the legacy handler", async () => {
    useCliEnv();
    globalThis.fetch = (async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/issues") return Response.json({ issues: [{ id: "iss_1", key: "MUL-1", title: "Compatibility", status: "todo", priority: "high" }], total: 1 });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;
    const direct = await capture(() => runMultiremi(["issue", "list", "--output", "json"], { programName: "remi multiremi" }));
    const nativeAdapter = specById("issue.list");
    const viaRegistry = await capture(() => registryFor([nativeAdapter]).execute(["issue", "list", "--output", "json"]));
    expect(viaRegistry).toEqual(direct);
  });

  it("supports table, JSON, and JSONL on a native collaboration read command", async () => {
    useCliEnv();
    const spec = specById("label.list");
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      if (new URL(request.url).pathname === "/api/labels") {
        return Response.json({ labels: [{ id: "lbl_1", name: "Urgent", color: "#ff0000" }], total: 1 });
      }
      throw new Error(`unexpected request ${request.url}`);
    });
    const table = await capture(() => registryFor([spec]).execute(["label", "list", "--output", "table"]));
    const json = await capture(() => registryFor([spec]).execute(["label", "list", "--output", "json"]));
    const jsonl = await capture(() => registryFor([spec]).execute(["label", "list", "--output", "jsonl"]));
    expect(table.stdout).toContain("Urgent");
    expect(JSON.parse(json.stdout)).toMatchObject({ labels: [{ id: "lbl_1", name: "Urgent" }] });
    expect(JSON.parse(jsonl.stdout)).toMatchObject({ id: "lbl_1", name: "Urgent" });
  });

  it("binds and unbinds a Chat Issue through registered commands", async () => {
    useCliEnv();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/cli/capabilities") {
        return Response.json({ commands: [
          { id: "chat.issue.bind", allowed: true },
          { id: "chat.issue.unbind", allowed: true },
        ] });
      }
      if (path === "/api/chat/sessions" && request.method === "GET") {
        return Response.json([{ id: "chat_1", title: "Work" }]);
      }
      if (path === "/api/issues/MUL-226" && request.method === "GET") {
        return Response.json({ id: "iss_226", key: "MUL-226", title: "Bound" });
      }
      if (path === "/api/chat/sessions/chat_1" && request.method === "PATCH") {
        requests.push({ method: request.method, path, body: await request.json() });
        return Response.json({ id: "chat_1", issue_id: (requests.at(-1)?.body as any).issue_id });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    }) as typeof fetch;

    await capture(() => registryFor([specById("chat.issue.bind")]).execute([
      "chat", "issue", "bind", "Work", "MUL-226", "--output", "json",
    ]));
    await capture(() => registryFor([specById("chat.issue.unbind")]).execute([
      "chat", "issue", "unbind", "Work", "--output", "json",
    ]));

    expect(requests).toEqual([
      { method: "PATCH", path: "/api/chat/sessions/chat_1", body: { issue_id: "iss_226" } },
      { method: "PATCH", path: "/api/chat/sessions/chat_1", body: { issue_id: null } },
    ]);
  });

  it("creates workspace Sessions by default and supports discussion Sessions", async () => {
    useCliEnv();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = capabilityFetch("session.create", async (input) => {
      const request = input;
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/issues/MUL-136/sessions");
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      return Response.json({ id: `ises_${bodies.length}`, ...body }, { status: 201 });
    });
    const spec = specById("session.create");

    await capture(() => registryFor([spec]).execute([
      "session", "create", "MUL-136", "--title", "Implementation", "--output", "json",
    ]));
    await capture(() => registryFor([spec]).execute([
      "session", "create", "MUL-136", "--title", "Design chat", "--discussion", "--output", "json",
    ]));

    expect(bodies).toEqual([
      { title: "Implementation" },
      { title: "Design chat", holds_workspace: false },
    ]);
  });

  it("executes task inspection and supervisor-only redispatch commands", async () => {
    useCliEnv();
    const inspect = specById("task.inspect");
    globalThis.fetch = capabilityFetch(inspect.id, (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/api/tasks/tsk_target/inspection");
      return Response.json({ inspection: { id: "tsk_target", status: "running" } });
    });
    const inspected = await capture(() => registryFor([inspect]).execute([
      "task", "inspect", "tsk_target", "--output", "json",
    ]));
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      inspection: { id: "tsk_target", status: "running" },
    });

    const redispatch = specById("task.redispatch");
    let body: unknown;
    globalThis.fetch = capabilityFetch(redispatch.id, async (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/tasks/tsk_target/redispatch");
      body = await request.json();
      return Response.json({ replacement_task: { id: "tsk_replacement", status: "queued" } }, { status: 202 });
    });
    await capture(() => registryFor([redispatch]).execute([
      "task", "redispatch", "tsk_target", "--reason", "Queued too long", "--yes", "--output", "json",
    ]));
    expect(body).toEqual({ reason: "Queued too long" });
    expect(registryFor([redispatch]).inventory()[0]?.auth).toEqual(["task"]);
  });

  it("uploads attachments against the requested issue and honors structured output", async () => {
    useCliEnv();
    let uploadedIssue = "";
    globalThis.fetch = (async (_input, init) => {
      const form = init?.body as FormData;
      uploadedIssue = String(form.get("issue_id"));
      return Response.json({ attachment: { id: "att_1", issue_id: uploadedIssue, filename: "package.json" } });
    }) as typeof fetch;
    const upload = specById("issue.attachment.upload");
    const result = await capture(() => registryFor([upload]).execute([
      "issue", "attachment", "upload", "iss_target", "--attachment", resolve(root, "package.json"), "--output", "json",
    ]));
    expect(uploadedIssue).toBe("iss_target");
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: "att_1", issue_id: "iss_target" }),
    ]);
  });

  it("leaves default-assignee inheritance to the server and opts out with --no-project-defaults", async () => {
    useCliEnv();
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/issues" && request.method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        bodies.push(body);
        return Response.json({ id: `iss_${bodies.length}`, ...body }, { status: 201 });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    }) as typeof fetch;
    const spec = specById("issue.create");
    // Default: no assignee fields at all — the server inherits the project default.
    const inherited = await capture(() => registryFor([spec]).execute(["issue", "create", "--title", "Inherited", "--project", "prj_1"]));
    expect(bodies[0]).not.toHaveProperty("assignee_id");
    expect(bodies[0]).not.toHaveProperty("assignee_type");
    expect(inherited.stderr).not.toContain("Project default assignee is");
    // --use-project-defaults stays accepted as a no-op (server-side default).
    await capture(() => registryFor([spec]).execute(["issue", "create", "--title", "Legacy opt-in", "--project", "prj_1", "--use-project-defaults"]));
    expect(bodies[1]).not.toHaveProperty("assignee_id");
    // --no-project-defaults sends explicit nulls so the issue stays unassigned.
    await capture(() => registryFor([spec]).execute(["issue", "create", "--title", "Unassigned", "--project", "prj_1", "--no-project-defaults"]));
    expect(bodies[2]).toMatchObject({ assignee_type: null, assignee_id: null });
  });

  it("restores an archived issue through the native command", async () => {
    useCliEnv();
    const spec = specById("issue.restore");
    let restored = "";
    globalThis.fetch = capabilityFetch(spec.id, (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/issues/iss_archived/restore") {
        restored = path;
        return Response.json({ id: "iss_archived", status: "backlog", deleted_at: null });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });
    const result = await capture(() => registryFor([spec]).execute(["issue", "restore", "iss_archived", "--output", "json"]));
    expect(restored).toBe("/api/issues/iss_archived/restore");
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "iss_archived", deleted_at: null });
  });

  it("retitles an issue through the registered command and supports dry-run", async () => {
    useCliEnv();
    const spec = specById("issue.retitle");
    const bodies: unknown[] = [];
    globalThis.fetch = capabilityFetch(spec.id, async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/multiremi/issues/MUL-111/retitle") {
        bodies.push(await request.json());
        return Response.json({
          title: "Use Luna to improve Issue titles",
          previous_title: "Remi",
          applied: (bodies.at(-1) as { apply: boolean }).apply,
          reason: "generated",
        });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    });

    await capture(() => registryFor([spec]).execute([
      "issue", "retitle", "MUL-111", "--output", "json",
    ]));
    await capture(() => registryFor([spec]).execute([
      "issue", "retitle", "MUL-111", "--dry-run", "--output", "json",
    ]));

    expect(bodies).toEqual([{ apply: true }, { apply: false }]);
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
  return {
    id: `legacy.${name}`,
    path: [name],
    description: "legacy",
    parse: "passthrough",
    run: async () => {},
  };
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

function capabilityFetch(commandId: string, handler: (request: Request) => Response | Promise<Response>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/api/cli/capabilities") {
      return Response.json({ commands: [{ id: commandId, allowed: true }] });
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
