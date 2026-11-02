import { afterEach, describe, expect, it } from "bun:test";
import { prepareCursorDaemonRuntime } from "../../../apps/remi/cli/multiremi/daemon-health.js";

const servers: Bun.Server<unknown>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const input = { provider: null, serverUrl: "http://unused.invalid", workspaceId: "workspace", token: "daemon-fixture" } as const;

describe("Cursor preparation before daemon registration", () => {
  it("bootstraps an empty machine from its workspace Cursor key before completing preparation", async () => {
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("Authorization") });
        return Response.json({ workspace_id: "workspace", repos: [], repos_version: "1", relay: {
          claude: null, codex: null, cursor: { fragment: "{}", auth_token: "cursor-fixture-key", revision: 1 },
        } });
      },
    });
    servers.push(server);
    const calls: string[] = [];
    const ready = await prepareCursorDaemonRuntime({ ...input, serverUrl: `http://127.0.0.1:${server.port}` }, {
      detectProviders: () => [],
      ensureCursor: async () => { await Promise.resolve(); calls.push("installed"); },
      log: message => calls.push(message),
    });
    expect(ready).toBe(true);
    expect(calls).toEqual(["installed"]);
    expect(requests).toEqual([{ path: "/api/daemon/workspaces/workspace/repos", authorization: "Bearer daemon-fixture" }]);
  });

  it("prepares explicitly selected Cursor without requiring a gateway or existing installation", async () => {
    let installed = false;
    expect(await prepareCursorDaemonRuntime({ ...input, provider: "cursor" }, {
      detectProviders: () => { throw new Error("explicit selection must not need local detection"); },
      readRelay: async () => { throw new Error("explicit selection must not need gateway discovery"); },
      ensureCursor: async () => { installed = true; },
    })).toBe(true);
    expect(installed).toBe(true);
  });

  it("prepares a locally detected Cursor for the machine's existing login", async () => {
    let installed = false;
    expect(await prepareCursorDaemonRuntime(input, {
      detectProviders: () => ["claude", "cursor"],
      readRelay: async () => { throw new Error("local login does not require workspace gateway discovery"); },
      ensureCursor: async () => { installed = true; },
    })).toBe(true);
    expect(installed).toBe(true);
  });

  it("respects an explicit different provider and a workspace without a Cursor key", async () => {
    const unexpected = async () => { throw new Error("Cursor must not be installed"); };
    expect(await prepareCursorDaemonRuntime({ ...input, provider: "codex" }, {
      detectProviders: () => { throw new Error("explicit provider must not need local detection"); },
      readRelay: unexpected, ensureCursor: unexpected,
    })).toBe(false);
    for (const cursor of [undefined, null, { fragment: '{"default_model":"auto"}', auth_token: "", revision: 2 }]) {
      expect(await prepareCursorDaemonRuntime(input, {
        detectProviders: () => [], readRelay: async () => ({ claude: null, codex: null, cursor }), ensureCursor: unexpected,
      })).toBe(false);
    }
  });

  it("surfaces an installation failure and keeps bootstrap diagnostics free of response secrets", async () => {
    await expect(prepareCursorDaemonRuntime({ ...input, provider: "cursor" }, {
      ensureCursor: async () => { throw new Error("Cursor download failed"); },
    })).rejects.toThrow("Cursor download failed");
    const messages: string[] = [];
    expect(await prepareCursorDaemonRuntime(input, {
      detectProviders: () => ["claude"],
      readRelay: async () => { throw new Error("server response with cursor-fixture-key"); },
      ensureCursor: async () => { throw new Error("Cursor must not be installed"); },
      log: message => messages.push(message),
    })).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("cursor-fixture-key");
  });
});
