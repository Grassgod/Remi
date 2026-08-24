import { describe, expect, it } from "bun:test";
import {
  AsyncOperationController,
  CliApiClient,
  CliError,
  CliRenderer,
  CommandRegistry,
  ResourceResolver,
  sanitizeCliDetails,
} from "../../../apps/remi/cli/core/index.js";

describe("CLI command registry", () => {
  it("prefers the longest command path and preserves legacy passthrough args", async () => {
    const registry = new CommandRegistry();
    const calls: string[][] = [];
    registry.register({
      id: "legacy.issue",
      path: ["issue"],
      description: "legacy issue handler",
      parse: "passthrough",
      run: async (invocation) => { calls.push([...invocation.rawArgs]); },
    });
    registry.register({
      id: "issue.list",
      path: ["issue", "list"],
      description: "list issues",
      options: [{ name: "limit", type: "integer" }],
      run: async (invocation) => {
        calls.push([String(invocation.options.limit)]);
      },
    });

    expect(await registry.execute(["issue", "list", "--limit", "3"])).toBe(true);
    expect(await registry.execute(["issue", "unknown", "--raw=value"])).toBe(true);
    expect(registry.supportsGeneratedHelp(["issue", "unknown"])).toBe(false);
    expect(calls).toEqual([["3"], ["unknown", "--raw=value"]]);
  });

  it("parses typed options, repeats, defaults, positionals, and conflicts", async () => {
    const registry = new CommandRegistry();
    let captured: unknown = null;
    registry.register({
      id: "project.update",
      path: ["project", "update"],
      aliases: [{
        path: ["project", "edit"],
        deprecatedSince: "0.3.0",
        replacement: "remi project update",
      }],
      description: "update project",
      positionals: [{ name: "project", required: true }],
      options: [
        { name: "limit", aliases: ["max"], type: "integer", defaultValue: 10 },
        { name: "tag", type: "string", repeatable: true },
        { name: "archived", type: "boolean", conflictsWith: ["active"] },
        { name: "active", type: "boolean" },
      ],
      run: async (invocation) => { captured = invocation; },
    });
    const deprecated: string[] = [];

    await registry.execute([
      "project", "edit", "prj_1", "--max=5", "--tag", "one", "--tag=two", "--archived", "false",
    ], {
      onDeprecatedAlias: (alias) => { deprecated.push(alias.replacement ?? ""); },
    });

    expect(captured).toMatchObject({
      matchedPath: ["project", "edit"],
      rawArgs: ["prj_1", "--max=5", "--tag", "one", "--tag=two", "--archived", "false"],
      positionals: ["prj_1"],
      options: { limit: 5, tag: ["one", "two"], archived: false },
    });
    expect(deprecated).toEqual(["remi project update"]);
    expect(() => registry.resolve(["project", "update", "prj_1", "--archived", "--active"]))
      .toThrow("--archived conflicts with --active");
    expect(() => registry.resolve(["project", "update", "prj_1", "--unknown"]))
      .toThrow("unknown option --unknown");
    expect(registry.resolve(["project", "update", "prj_1", "--no-archived"])?.options.archived).toBe(false);
    expect(registry.renderHelp(["project", "update"])).toContain("Usage: remi project update <project> [options]");
    expect(registry.renderHelp(["project", "update"])).toContain("remi project edit (use remi project update)");
    expect(registry.renderHelpForArgv(["project", "edit", "prj_1"])).toContain("Usage: remi project update");
    expect(registry.supportsGeneratedHelp(["project", "edit"])).toBe(true);
  });

  it("rejects duplicate ids and paths and exposes hidden commands in inventory", () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "internal.multiremi",
      path: ["multiremi"],
      description: "compatibility entry",
      hidden: true,
      parse: "passthrough",
      run: async () => {},
    });
    expect(registry.inventory()).toEqual([expect.objectContaining({
      id: "internal.multiremi",
      path: ["multiremi"],
      hidden: true,
    })]);
    expect(() => registry.register({
      id: "other",
      path: ["multiremi"],
      description: "duplicate",
      run: async () => {},
    })).toThrow("path already registered");
  });
});

describe("CLI API client", () => {
  it("applies auth/workspace/query/body without exposing credentials", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = new CliApiClient({
      serverUrl: "https://api.example.test/",
      token: "tok_secret",
      workspaceId: "ws_1",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          authorization: request.headers.get("Authorization"),
          workspace: request.headers.get("X-Workspace-ID"),
          body: await request.text(),
        });
        return Response.json({ ok: true }, { status: 201 });
      }),
    });

    const response = await client.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/projects",
      query: { query: "docs", ignored: null },
      body: { name: "Docs" },
      retries: false,
    });

    expect(response).toMatchObject({ data: { ok: true }, status: 201 });
    expect(requests).toEqual([{
      url: "https://api.example.test/api/projects?query=docs",
      authorization: "Bearer tok_secret",
      workspace: "ws_1",
      body: JSON.stringify({ name: "Docs" }),
    }]);
  });

  it("retries reads and idempotent writes but not ordinary writes", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new CliApiClient({
      serverUrl: "https://api.example.test",
      maxRetries: 2,
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: (async () => {
        calls++;
        if (calls < 3) return Response.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "0" } });
        return Response.json({ ok: true });
      }),
    });
    expect((await client.request({ method: "GET", path: "/api/items" })).data).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([0, 0]);

    let ordinaryWrites = 0;
    const writeClient = new CliApiClient({
      serverUrl: "https://api.example.test",
      maxRetries: 2,
      sleep: async () => {},
      fetch: (async () => {
        ordinaryWrites++;
        return Response.json({ error: "busy" }, { status: 503 });
      }),
    });
    await expect(writeClient.request({ method: "POST", path: "/api/items", body: {} }))
      .rejects.toMatchObject({ code: "server", retryable: true });
    expect(ordinaryWrites).toBe(1);

    let idempotentWrites = 0;
    const idempotentClient = new CliApiClient({
      serverUrl: "https://api.example.test",
      maxRetries: 1,
      sleep: async () => {},
      fetch: (async (input, init) => {
        idempotentWrites++;
        expect(new Request(input, init).headers.get("Idempotency-Key")).toBe("op_1");
        return idempotentWrites === 1
          ? Response.json({ error: "busy" }, { status: 503 })
          : Response.json({ ok: true });
      }),
    });
    await idempotentClient.request({
      method: "POST",
      path: "/api/items",
      body: {},
      idempotencyKey: "op_1",
    });
    expect(idempotentWrites).toBe(2);
  });

  it("redacts structured server error details and detects timeout", async () => {
    const errorClient = new CliApiClient({
      serverUrl: "https://api.example.test",
      fetch: (async () => Response.json({
        error: "denied",
        token: "tok_leak",
        nested: { api_key: "key_leak", note: "Bearer credential" },
      }, { status: 403 })),
    });
    await expect(errorClient.request({ method: "GET", path: "/api/private", retries: false }))
      .rejects.toMatchObject({
        code: "forbidden",
        details: {
          error: "denied",
          token: "***",
          nested: { api_key: "***", note: "Bearer ***" },
        },
      });

    const timeoutClient = new CliApiClient({
      serverUrl: "https://api.example.test",
      timeoutMs: 5,
      maxRetries: 0,
      fetch: (async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })),
    });
    await expect(timeoutClient.request({ method: "GET", path: "/api/slow" }))
      .rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("paginates without mutating the caller query and caches capabilities", async () => {
    const urls: string[] = [];
    let capabilityCalls = 0;
    const client = new CliApiClient({
      serverUrl: "https://api.example.test",
      fetch: (async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        if (url.pathname === "/api/cli/capabilities") {
          capabilityCalls++;
          return Response.json({ protocol_version: 1 });
        }
        const cursor = url.searchParams.get("cursor");
        return Response.json(cursor
          ? { items: [2], next_cursor: null }
          : { items: [1], next_cursor: "next" });
      }),
    });
    const original = new URLSearchParams({ limit: "1" });
    const pages: number[][] = [];
    for await (const page of client.paginate<number>({
      method: "GET",
      path: "/api/items",
      query: original,
      page: (data) => {
        const value = data as { items: number[]; next_cursor: string | null };
        return { items: value.items, nextCursor: value.next_cursor };
      },
    })) pages.push([...page.items]);
    expect(pages).toEqual([[1], [2]]);
    expect(original.toString()).toBe("limit=1");
    expect(urls.slice(0, 2)).toEqual([
      "https://api.example.test/api/items?limit=1",
      "https://api.example.test/api/items?limit=1&cursor=next",
    ]);

    const [first, second] = await Promise.all([client.capabilities(), client.capabilities()]);
    expect(first).toEqual({ protocol_version: 1 });
    expect(second).toBe(first);
    expect(capabilityCalls).toBe(1);
  });
});

describe("CLI renderer and errors", () => {
  it("keeps diagnostics off stdout and renders table/json/jsonl contracts", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = new CliRenderer({ stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    const rows = [{ id: "prj_1", name: "Docs" }, { id: "prj_2", name: "API" }];
    renderer.render<(typeof rows)[number]>(rows, {
      mode: "table",
      columns: [
        { header: "ID", value: (row) => row.id },
        { header: "NAME", value: (row) => row.name },
      ],
    });
    renderer.render({ projects: rows }, { mode: "json" });
    renderer.render({ projects: rows }, {
      mode: "jsonl",
      rows: (value) => (value as { projects: typeof rows }).projects,
    });
    renderer.diagnostic("retrying request");

    expect(stdout[0]).toBe("ID     NAME\nprj_1  Docs\nprj_2  API");
    expect(JSON.parse(stdout[1]!)).toEqual({ projects: rows });
    expect(stdout.slice(2)).toEqual(rows.map((row) => JSON.stringify(row)));
    expect(stderr).toEqual(["retrying request"]);
  });

  it("redacts secret-shaped keys and bearer values", () => {
    expect(sanitizeCliDetails({
      token: "secret",
      safe: "Bearer top-secret",
      values: [{ password: "secret", name: "visible" }],
    })).toEqual({
      token: "***",
      safe: "Bearer ***",
      values: [{ password: "***", name: "visible" }],
    });
    const error = new CliError("conflict", "version mismatch", { status: 409, retryable: true });
    expect(error.toJSON()).toEqual({
      code: "conflict",
      message: "version mismatch",
      retryable: true,
      status: 409,
    });
  });
});

describe("CLI resource resolver", () => {
  const resources = [
    { id: "prj_alpha123", name: "Alpha" },
    { id: "prj_alpha456", name: "Alpha" },
    { id: "prj_beta123", name: "Beta Project" },
  ];

  function resolver(searchCalls: string[]): ResourceResolver<(typeof resources)[number]> {
    return new ResourceResolver({
      kind: "project",
      getById: async (ref) => resources.find((resource) => resource.id === ref) ?? null,
      search: async (query) => {
        searchCalls.push(query);
        return resources.filter((resource) => resource.id.startsWith(query)
          || resource.name.toLowerCase().includes(query.toLowerCase()));
      },
      id: (resource) => resource.id,
      name: (resource) => resource.name,
    });
  }

  it("resolves full ID, unique short ID, and normalized unique name with caching", async () => {
    const calls: string[] = [];
    const subject = resolver(calls);
    expect((await subject.resolve("prj_alpha123")).id).toBe("prj_alpha123");
    expect((await subject.resolve("prj_beta")).id).toBe("prj_beta123");
    expect((await subject.resolve(" beta   project ")).id).toBe("prj_beta123");
    await subject.resolve("PRJ_BETA".toLowerCase());
    expect(calls).toEqual(["prj_beta", "beta project"]);
  });

  it("rejects ambiguous and missing references without fuzzy selection", async () => {
    const subject = resolver([]);
    await expect(subject.resolve("prj_alpha")).rejects.toMatchObject({
      code: "ambiguous_ref",
      details: { candidates: expect.any(Array) },
    });
    await expect(subject.resolve("Alpha")).rejects.toMatchObject({ code: "ambiguous_ref" });
    await expect(subject.resolve("Gamma")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("CLI async operation controller", () => {
  it("waits through pending states and delegates status/cancel", async () => {
    let now = 0;
    let polls = 0;
    const controller = new AsyncOperationController({
      status: async (id) => ({ id, state: ++polls >= 3 ? "complete" : "running" }),
      cancel: async (id) => ({ id, state: "cancelled" }),
      state: (operation) => operation.state,
      terminalStates: ["complete", "failed", "cancelled"],
      successStates: ["complete"],
    });
    const result = await controller.wait("op_1", {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    expect(result).toEqual({ id: "op_1", state: "complete" });
    expect(await controller.status("op_2")).toMatchObject({ id: "op_2" });
    expect(await controller.cancel("op_2")).toEqual({ id: "op_2", state: "cancelled" });
  });

  it("returns stable failure and timeout errors", async () => {
    const failed = new AsyncOperationController({
      status: async () => ({ state: "failed", error: "build failed", token: "secret" }),
      cancel: async () => ({ state: "cancelled" }),
      state: (operation) => operation.state,
      terminalStates: ["failed", "cancelled"],
      successStates: [],
    });
    await expect(failed.wait("op_failed")).rejects.toMatchObject({
      code: "server",
      details: { state: "failed", error: "build failed", token: "***" },
    });

    let now = 0;
    const pending = new AsyncOperationController({
      status: async () => ({ state: "running" }),
      cancel: async () => ({ state: "cancelled" }),
      state: (operation) => operation.state,
      terminalStates: ["complete", "failed"],
      successStates: ["complete"],
    });
    await expect(pending.wait("op_slow", {
      timeoutMs: 20,
      pollIntervalMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    })).rejects.toMatchObject({ code: "timeout", retryable: true });
  });
});
