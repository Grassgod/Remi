import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTerminalDaemonAuthorityError,
  MultiremiDaemonClient,
  MultiremiDaemonHttpError,
} from "@multiremi/client.js";

const originalFetch = globalThis.fetch;
const temporaryRoots: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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

describe("MultiremiDaemonClient workspace configuration", () => {
  it("returns heartbeat-delivered settings and Relay configuration", async () => {
    globalThis.fetch = (async () => Response.json({
      status: "ok",
      workspace_settings: {
        session_archive: { workspace_ttl_ms: 7_200_000, gc_interval_ms: 120_000 },
      },
      relay: {
        claude: {
          fragment: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay.example" } }),
          auth_token: "relay-secret",
          revision: 3,
        },
        codex: null,
      },
    })) as unknown as typeof globalThis.fetch;

    const ack = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .heartbeatRuntime("runtime-1");

    expect(ack.workspace_settings).toEqual({
      session_archive: { workspace_ttl_ms: 7_200_000, gc_interval_ms: 120_000 },
    });
    expect(ack.relay?.claude).toMatchObject({ revision: 3, auth_token: "relay-secret" });
  });
});

describe("MultiremiDaemonClient Issue session archive wire", () => {
  it("supports a lightweight archive status preflight without snapshot fields", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({
        latest: { id: "sar_1", status: "failed", retry_state: "backoff" },
        latest_ready: null,
        requested_ready: null,
        gc_ready: false,
      });
    }) as unknown as typeof globalThis.fetch;

    const client = new MultiremiDaemonClient("https://remi.example/", "daemon-token");
    await expect(client.getIssueSessionArchiveStatus("runtime/1", "issue/1")).resolves.toMatchObject({
      latest: { retry_state: "backoff" },
    });
    expect(requests).toEqual([
      "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/status",
    ]);
  });

  it("encodes archive scope and uploads the prepared bytes with daemon auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-archive-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "archive-bytes");
    const requests: Array<{ url: string; method: string; headers: Headers; body: BodyInit | null | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
      if (url.includes("/status?source_revision=revision%2F1&sha256=abc")) {
        return Response.json({ latest: null, latest_ready: null, requested_ready: null, gc_ready: false });
      }
      if (url.endsWith("/init")) {
        return Response.json({
          archive: {
            id: "archive/1",
            status: "pending",
            source_revision: "revision/1",
            sha256: "abc",
            size_bytes: 13,
          },
          upload_attempt: 7,
          upload_url: "/unused-by-client?attempt=7",
        });
      }
      return Response.json({
        archive: {
          id: "archive/1",
          status: url.includes("/complete?attempt=") ? "ready" : "uploading",
          source_revision: "revision/1",
          sha256: "abc",
          size_bytes: 13,
        },
      });
    }) as unknown as typeof globalThis.fetch;

    const client = new MultiremiDaemonClient("https://remi.example/", "daemon-token");
    await client.getIssueSessionArchiveStatus("runtime/1", "issue/1", "revision/1", "abc");
    await client.getIssueSessionArchiveStatus("runtime/1", "issue/1", "revision/1", "abc", true);
    await client.initIssueSessionArchive("runtime/1", "issue/1", {
      sourceRevision: "revision/1",
      sha256: "abc",
      sizeBytes: 13,
      fileCount: 2,
    });
    await client.reportIssueSessionArchiveFailure("runtime/1", "issue/1", {
      stage: "prepare",
      error: "pack failed",
    });
    await client.uploadIssueSessionArchive("runtime/1", "issue/1", "archive/1", archivePath);
    await client.completeIssueSessionArchive("runtime/1", "issue/1", "archive/1");
    await client.reportIssueWorkspaceCleaned("issue/1", "runtime/1", {
      archiveId: "archive/1",
      sourceRevision: "revision/1",
      sha256: "abc",
    });

    expect(requests.map(({ url, method }) => [method, url])).toEqual([
      ["GET", "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/status?source_revision=revision%2F1&sha256=abc"],
      ["GET", "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/status?source_revision=revision%2F1&sha256=abc&verify_ready=1"],
      ["POST", "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/init"],
      ["POST", "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/failure"],
      ["PUT", "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/archive%2F1/content?attempt=7"],
      ["POST", "https://remi.example/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/archive%2F1/complete?attempt=7"],
      ["POST", "https://remi.example/api/daemon/issues/issue%2F1/workspace/cleaned"],
    ]);
    expect(requests.every(({ headers }) => headers.get("authorization") === "Bearer daemon-token")).toBe(true);
    expect(JSON.parse(String(requests[3]?.body))).toEqual({
      stage: "prepare",
      error: "pack failed",
    });
    expect(requests[4]?.headers.get("content-type")).toBe("application/octet-stream");
    expect(requests[4]?.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(requests[4]?.body as Uint8Array).toString("utf8")).toBe("archive-bytes");
    expect(JSON.parse(String(requests[6]?.body))).toEqual({
      runtime_id: "runtime/1",
      archive_id: "archive/1",
      source_revision: "revision/1",
      sha256: "abc",
    });
  });

  it("uploads archive bytes through Bun native fetch without a file-backed body", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-native-upload-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "native-fetch-archive");
    let uploaded = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/init")) {
          return Response.json({
            archive: {
              id: "archive-native",
              status: "pending",
              source_revision: "revision-native",
              sha256: "def",
              size_bytes: 20,
            },
            upload_attempt: 3,
          });
        }
        if (request.method === "PUT") {
          uploaded = Buffer.from(await request.arrayBuffer()).toString("utf8");
        }
        return Response.json({
          archive: {
            id: "archive-native",
            status: "uploading",
            source_revision: "revision-native",
            sha256: "def",
            size_bytes: 20,
          },
        });
      },
    });
    try {
      const client = new MultiremiDaemonClient(`http://127.0.0.1:${server.port}`, "daemon-token");
      await client.initIssueSessionArchive("runtime-native", "issue-native", {
        sourceRevision: "revision-native",
        sha256: "def",
        sizeBytes: 20,
        fileCount: 1,
      });
      await client.uploadIssueSessionArchive(
        "runtime-native",
        "issue-native",
        "archive-native",
        archivePath,
      );
      expect(uploaded).toBe("native-fetch-archive");
    } finally {
      server.stop(true);
    }
  });
});
