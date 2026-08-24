import { afterEach, describe, expect, it } from "bun:test";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { contextCommandSpec } from "../../../apps/remi/cli/commands/context.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const savedEnv = {
  server: process.env.MULTIREMI_SERVER_URL,
  workspace: process.env.MULTIREMI_WORKSPACE_ID,
  token: process.env.MULTIREMI_TOKEN,
};

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  restoreEnv("MULTIREMI_SERVER_URL", savedEnv.server);
  restoreEnv("MULTIREMI_WORKSPACE_ID", savedEnv.workspace);
  restoreEnv("MULTIREMI_TOKEN", savedEnv.token);
});

describe("remi context", () => {
  it("merges cwd locally and renders table, JSON, and JSONL contracts", async () => {
    const registry = new CommandRegistry();
    registry.register(contextCommandSpec());
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(request.url.endsWith("/api/cli/capabilities")
        ? capabilitiesResponse()
        : contextResponse());
    }) as typeof fetch;

    for (const mode of ["table", "json", "jsonl"] as const) {
      const output: string[] = [];
      console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); };
      await registry.execute([
        "context",
        "--server", "https://api.example.test",
        "--token", "human-credential",
        "--workspace", "ws_1",
        "--output", mode,
      ]);
      const rendered = output.join("\n");
      if (mode === "table") {
        expect(rendered).toContain("TYPE");
        expect(rendered).toContain("workspace");
        expect(rendered).toContain(process.cwd());
      } else {
        const parsed = JSON.parse(rendered);
        expect(parsed.local.cwd).toBe(process.cwd());
        expect(parsed.workspace.id).toBe("ws_1");
      }
    }

    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.url).toMatch(/^https:\/\/api\.example\.test\/api\/cli\/(?:capabilities|context)$/);
      expect(request.headers.get("Authorization")).toBe("Bearer human-credential");
      expect(request.headers.get("X-Workspace-ID")).toBe("ws_1");
    }
  });

  it("sends signed share credentials only in the dedicated header", async () => {
    const registry = new CommandRegistry();
    registry.register(contextCommandSpec());
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(request.url.endsWith("/api/cli/capabilities")
        ? capabilitiesResponse()
        : contextResponse());
    }) as typeof fetch;
    console.log = () => {};

    await registry.execute([
      "context", "--server", "https://api.example.test", "--share", "signed-share", "--output", "json",
    ]);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.get("Authorization")).toBeNull();
      expect(request.headers.get("X-Remi-Share")).toBe("signed-share");
    }
    expect(() => registry.resolve([
      "context", "--token", "human", "--share", "signed-share",
    ])).toThrow("--token conflicts with --share");
  });
});

function contextResponse() {
  return {
    protocol_version: 1,
    identity: { type: "human" },
    workspace: { id: "ws_1", name: "Workspace", description: null },
    current: { agent: null, task: null, chat: null, issue: null, session: null, project: null, runtime: null, runtimes: [] },
    catalog: { projects: [], repositories: [], next_cursor: null },
    allowed_operations: ["context.read"],
  };
}

function capabilitiesResponse() {
  return {
    protocol_version: 1,
    manifest_version: "1",
    server_version: "test",
    identity: "human",
    features: { capability_negotiation: true },
    commands: [{ id: "context.get", allowed: true }],
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
