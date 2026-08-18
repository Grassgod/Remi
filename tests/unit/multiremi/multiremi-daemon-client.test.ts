import { afterEach, describe, expect, it } from "bun:test";
import {
  isTerminalDaemonAuthorityError,
  MultiremiDaemonClient,
  MultiremiDaemonHttpError,
} from "@multiremi/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("MultiremiDaemonClient HTTP failures", () => {
  it.each([401, 403, 410])("classifies HTTP %s as a terminal daemon authority failure", async (status) => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "daemon is no longer authorized", code: "daemon_retired" }),
      { status, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;

    const error = await new MultiremiDaemonClient("https://remi.example", "retired-token")
      .heartbeatRuntime("runtime-1")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MultiremiDaemonHttpError);
    expect(error).toMatchObject({ status, code: "daemon_retired" });
    expect(isTerminalDaemonAuthorityError(error)).toBe(true);
  });

  it("keeps transient server failures retryable", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "temporarily unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;

    const error = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .heartbeatRuntime("runtime-1")
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ status: 503 });
    expect(isTerminalDaemonAuthorityError(error)).toBe(false);
  });

  it("treats an old server without Agent Plugin routes as protocol zero", async () => {
    globalThis.fetch = (async () => new Response("404 Not Found", { status: 404 })) as unknown as typeof globalThis.fetch;

    await expect(new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .getRuntimeAgentPluginDesired("runtime-1"))
      .resolves.toEqual({
        runtime_id: "runtime-1",
        revision: "unsupported",
        plugins: [],
      });
  });

  it("does not hide a structured runtime-not-found Agent Plugin response", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: "runtime not found", code: "runtime_not_found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;

    const error = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .getRuntimeAgentPluginDesired("runtime-1")
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ status: 404, code: "runtime_not_found" });
  });
});

describe("MultiremiDaemonClient SSH Mesh wire", () => {
  it("advertises the protocol and reports machine state on heartbeat", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ status: "ok" });
    }) as unknown as typeof globalThis.fetch;

    await new MultiremiDaemonClient("https://remi.example", "daemon-token").heartbeatRuntime("runtime-1", {
      status: "ready",
      key_version: 3,
      config_revision: "rev-3",
      probe_revision: 4,
      hostname: "n37-206-133",
      ssh_user: "hehuajie",
      port: 22,
      addresses: ["10.37.206.133"],
      host_keys: [`ssh-ed25519 ${"A".repeat(64)}`],
      peers: [{ daemon_id: "daemon-peer", status: "ready", latency_ms: 8 }],
    });

    expect(requestBody).toMatchObject({
      runtime_id: "runtime-1",
      ssh_mesh_protocol: 1,
      ssh_mesh_status: {
        status: "ready",
        key_version: 3,
        probe_revision: 4,
        peers: [{ daemon_id: "daemon-peer", status: "ready" }],
      },
    });
  });

  it("fetches private configuration only from the authenticated daemon route", async () => {
    let requestedUrl = "";
    let authorization = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        protocol_version: 1,
        enabled: false,
        key_version: 0,
        config_revision: "disabled",
        rotation_state: "stable",
        probe_revision: 0,
        probe_target_daemon_ids: [],
        authorized_public_keys: [],
        hosts: [],
      });
    }) as unknown as typeof globalThis.fetch;

    await new MultiremiDaemonClient("https://remi.example/", "daemon-token").getSshMeshConfig("runtime/a");

    expect(requestedUrl).toBe("https://remi.example/api/daemon/ssh-mesh/config?runtime_id=runtime%2Fa");
    expect(authorization).toBe("Bearer daemon-token");
  });

  it("forwards cancellation to the SSH Mesh configuration request", async () => {
    let requestSignal: AbortSignal | null = null;
    let requestReleased = false;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          requestReleased = true;
          reject(requestSignal?.reason);
        }, { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    const controller = new AbortController();
    const request = new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .getSshMeshConfig("runtime-1", controller.signal);

    controller.abort(new Error("test cancellation"));

    await expect(request).rejects.toThrow("test cancellation");
    expect(requestSignal).not.toBeNull();
    expect(requestSignal as unknown as AbortSignal).toBe(controller.signal);
    expect(requestReleased).toBe(true);
  });
});
