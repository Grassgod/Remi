import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTerminalDaemonAuthorityError,
  MultiremiDaemonClient,
  MultiremiDaemonHttpError,
} from "@multiremi/client.js";

const originalFetch = globalThis.fetch;
const temporaryRoots: string[] = [];

async function readStreamingBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error("expected an AbortSignal"));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

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

describe("MultiremiDaemonClient daemon protocol", () => {
  it("normalizes pending bound Issue updates from a task claim", async () => {
    globalThis.fetch = (async () => Response.json({
      task: {
        id: "tsk_bound_updates",
        prompt: "Continue",
        status: "dispatched",
        agent_id: "agt_bound_updates",
        workspace_id: "local",
        bound_issue_updates: ["First update", "Second update"],
        bound_issue_updates_omitted_count: 7,
      },
    })) as unknown as typeof globalThis.fetch;

    const task = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .claimTask("runtime-1");

    expect(task).toMatchObject({
      boundIssueUpdates: ["First update", "Second update"],
      boundIssueUpdatesOmittedCount: 7,
    });
  });

  it("normalizes a bound Issue identity from either daemon wire casing", async () => {
    globalThis.fetch = (async () => Response.json({
      task: {
        id: "tsk_bound_issue",
        prompt: "Continue",
        status: "dispatched",
        agent_id: "agt_bound_issue",
        workspace_id: "local",
        bound_issue: {
          id: "iss_bound_issue",
          key: "MUL-236",
          title: "Caller ID",
          status: "in_progress",
        },
      },
    })) as unknown as typeof globalThis.fetch;

    const task = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .claimTask("runtime-1");

    expect(task?.boundIssue).toEqual({
      id: "iss_bound_issue",
      key: "MUL-236",
      title: "Caller ID",
      status: "in_progress",
    });

    globalThis.fetch = (async () => Response.json({
      task: {
        id: "tsk_bound_issue_camel",
        prompt: "Continue",
        status: "dispatched",
        agentId: "agt_bound_issue",
        workspaceId: "local",
        boundIssue: {
          id: "iss_bound_issue",
          key: "MUL-236",
          title: "Caller ID",
          status: "in_progress",
        },
      },
    })) as unknown as typeof globalThis.fetch;

    const camelTask = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .claimTask("runtime-1");
    expect(camelTask?.boundIssue).toEqual(task?.boundIssue);
  });

  it("falls back to the legacy status endpoint while the control plane rolls forward", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({ method: init?.method ?? "GET", path });
      if (path.endsWith("/dispatch-lease")) return new Response("Not Found", { status: 404 });
      return Response.json({ status: "running" });
    }) as unknown as typeof globalThis.fetch;

    const status = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .renewTaskDispatchLease("tsk_rolling");

    expect(status).toBe("running");
    expect(requests).toEqual([
      { method: "POST", path: "/api/daemon/tasks/tsk_rolling/dispatch-lease" },
      { method: "GET", path: "/api/daemon/tasks/tsk_rolling/status" },
    ]);
  });

  it("does not advertise the removed personal-bot side channel", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (String(input).endsWith("/api/daemon/register")) {
        return Response.json({
          workspace_id: "local",
          repos: [],
          repos_version: "none",
          runtimes: [{ id: "rt_bot", provider: "codex" }],
        });
      }
      return Response.json({ status: "ok" });
    }) as unknown as typeof globalThis.fetch;

    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token");
    await client.registerDaemonRuntime({
      workspaceId: "local",
      daemonId: "daemon-bot",
      runtime: { name: "", type: "codex", version: "1.0.0" },
    });
    await client.heartbeatRuntime("rt_bot");

    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies) {
      expect(body).not.toHaveProperty("bot_agent_id");
      expect(body).not.toHaveProperty("include_bot_projects");
    }
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
  it("checks an external identity through the authenticated daemon workspace route", async () => {
    let requestedUrl = "";
    let authorization = "";
    let requestBody: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ allowed: true });
    }) as unknown as typeof globalThis.fetch;

    const allowed = await new MultiremiDaemonClient("https://remi.example/", "daemon-token")
      .checkExternalWorkspaceMembership("workspace/a", "ou_member");

    expect(allowed).toBe(true);
    expect(requestedUrl).toBe(
      "https://remi.example/api/daemon/workspaces/workspace%2Fa/external-membership/check",
    );
    expect(authorization).toBe("Bearer daemon-token");
    expect(requestBody).toEqual({ external_id: "ou_member" });
  });

  it("advertises bot menu capability without personal-bot side-channel fields", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ status: "ok" });
    }) as unknown as typeof globalThis.fetch;

    await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .heartbeatRuntime("runtime-1", undefined, undefined, true);

    expect(requestBody).toMatchObject({
      runtime_id: "runtime-1",
      supports_bot_menu: true,
    });
    expect(requestBody).not.toHaveProperty("bot_agent_id");
    expect(requestBody).not.toHaveProperty("include_bot_projects");
  });

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
    const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
    let uploadedBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
      if (method === "PUT") uploadedBody = (await readStreamingBody(init?.body)).toString("utf8");
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
          upload_url: "/api/daemon/runtimes/runtime%2F1/issues/issue%2F1/session-archives/archive%2F1/content?attempt=7",
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
    expect(requests[4]?.headers.get("content-length")).toBe("13");
    expect(requests[4]?.body).not.toBeInstanceOf(Uint8Array);
    expect(uploadedBody).toBe("archive-bytes");
    expect(JSON.parse(String(requests[6]?.body))).toEqual({
      runtime_id: "runtime/1",
      archive_id: "archive/1",
      source_revision: "revision/1",
      sha256: "abc",
    });
  });

  it("refuses a large unconfigured proxy fallback and persists the explicit failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-proxy-limit-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, Buffer.alloc(8 * 1024 * 1024 + 1));
    let putCount = 0;
    let reportedError = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        return Response.json({
          archive: {
            id: "archive-large",
            status: "pending",
            source_revision: "revision-large",
            sha256: "abc",
            size_bytes: 8 * 1024 * 1024 + 1,
          },
          upload_attempt: 1,
          upload_url: "/api/daemon/runtimes/runtime-large/issues/issue-large/session-archives/archive-large/content?attempt=1",
        });
      }
      if (init?.method === "PUT") putCount += 1;
      if (url.includes("/failure?attempt=1")) {
        reportedError = String(JSON.parse(String(init?.body)).error);
        return Response.json({ archive: { id: "archive-large", status: "failed" } });
      }
      return Response.json({ archive: { id: "archive-large", status: "uploading" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token");
    await client.initIssueSessionArchive("runtime-large", "issue-large", {
      sourceRevision: "revision-large",
      sha256: "abc",
      sizeBytes: 8 * 1024 * 1024 + 1,
      fileCount: 1,
    });

    await expect(client.uploadIssueSessionArchive(
      "runtime-large",
      "issue-large",
      "archive-large",
      archivePath,
    )).rejects.toThrow("MULTIREMI_DAEMON_DIRECT_BASE_URL");
    expect(putCount).toBe(0);
    expect(reportedError).toContain("MULTIREMI_ARCHIVE_UPLOAD_BASE_URL");
  });

  it("rejects an unexpected advertised host before sending daemon authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-host-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "host-check");
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/init")) {
        return Response.json({
          archive: {
            id: "archive-host",
            status: "pending",
            source_revision: "revision-host",
            sha256: "abc",
            size_bytes: 10,
          },
          upload_attempt: 4,
          upload_url: "https://collector.example/api/daemon/runtimes/runtime-host/issues/issue-host/session-archives/archive-host/content?attempt=4",
        });
      }
      return Response.json({ archive: { id: "archive-host", status: "failed" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token");
    await client.initIssueSessionArchive("runtime-host", "issue-host", {
      sourceRevision: "revision-host",
      sha256: "abc",
      sizeBytes: 10,
      fileCount: 1,
    });

    await expect(client.uploadIssueSessionArchive(
      "runtime-host",
      "issue-host",
      "archive-host",
      archivePath,
    )).rejects.toThrow("unexpected host collector.example");
    expect(requestedUrls.some((url) => url.startsWith("https://collector.example"))).toBe(false);
    expect(requestedUrls.at(-1)).toContain("/failure?attempt=4");
  });

  it("uses an operator-trusted daemon override for the advertised upload path", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-override-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "override");
    let putUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        return Response.json({
          archive: {
            id: "archive-override",
            status: "pending",
            source_revision: "revision-override",
            sha256: "abc",
            size_bytes: 8,
          },
          upload_attempt: 2,
          upload_url: "https://server-direct.example/api/daemon/runtimes/runtime-override/issues/issue-override/session-archives/archive-override/content?attempt=2",
        });
      }
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 204,
          headers: { "X-Remi-Archive-Direct": "1" },
        });
      }
      if (init?.method === "PUT") {
        putUrl = url;
        await readStreamingBody(init.body);
      }
      return Response.json({
        archive: {
          id: "archive-override",
          status: "uploading",
          source_revision: "revision-override",
          sha256: "abc",
          size_bytes: 8,
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveUploadBaseUrl: "http://127.0.0.1:6120",
    });
    await client.initIssueSessionArchive("runtime-override", "issue-override", {
      sourceRevision: "revision-override",
      sha256: "abc",
      sizeBytes: 8,
      fileCount: 1,
    });
    await client.uploadIssueSessionArchive(
      "runtime-override",
      "issue-override",
      "archive-override",
      archivePath,
    );

    expect(putUrl).toBe(
      "http://127.0.0.1:6120/api/daemon/runtimes/runtime-override/issues/issue-override/session-archives/archive-override/content?attempt=2",
    );
    expect(() => new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveUploadBaseUrl: "file:///tmp/archive",
    })).toThrow("MULTIREMI_ARCHIVE_UPLOAD_BASE_URL");
  });

  it("fails closed for same-origin absolute URLs without an attested direct route and refreshes the cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-attestation-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "123456789");
    let initialized = 0;
    let directMarkerEnabled = false;
    let headCount = 0;
    let putCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        const archiveId = `archive-attestation-${++initialized}`;
        const uploadPath = `/api/daemon/runtimes/runtime-attestation/issues/issue-attestation/session-archives/${archiveId}/content?attempt=1`;
        return Response.json({
          archive: { id: archiveId, status: "pending", size_bytes: 9 },
          upload_attempt: 1,
          upload_url: new URL(uploadPath, url).toString(),
        });
      }
      if (init?.method === "HEAD") {
        headCount += 1;
        return new Response(null, {
          status: 204,
          headers: directMarkerEnabled ? { "X-Remi-Archive-Direct": "1" } : undefined,
        });
      }
      if (init?.method === "PUT") {
        putCount += 1;
        await readStreamingBody(init.body);
        return Response.json({ archive: { id: `archive-attestation-${initialized}`, status: "uploading" } });
      }
      return Response.json({ archive: { id: `archive-attestation-${initialized}`, status: "failed" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveProxyMaxBytes: 8,
      sessionArchiveDirectProbeTtlMs: 20,
    });
    const initAndUpload = async () => {
      const response = await client.initIssueSessionArchive("runtime-attestation", "issue-attestation", {
        sourceRevision: `revision-${initialized + 1}`,
        sha256: "abc",
        sizeBytes: 9,
        fileCount: 1,
      });
      return await client.uploadIssueSessionArchive(
        "runtime-attestation",
        "issue-attestation",
        response.archive.id,
        archivePath,
      );
    };

    await expect(initAndUpload()).rejects.toThrow("X-Remi-Archive-Direct: 1");
    directMarkerEnabled = true;
    await expect(initAndUpload()).rejects.toThrow("proxy fallback limit");
    expect(headCount).toBe(1);
    expect(putCount).toBe(0);

    await Bun.sleep(30);
    await expect(initAndUpload()).resolves.toMatchObject({ status: "uploading" });
    expect(headCount).toBe(2);
    expect(putCount).toBe(1);
  });

  it("treats a failed direct-route preflight as an unconfigured proxy fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-preflight-failure-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "123456789");
    let putCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        const uploadPath = "/api/daemon/runtimes/runtime-preflight/issues/issue-preflight/session-archives/archive-preflight/content?attempt=1";
        return Response.json({
          archive: { id: "archive-preflight", status: "pending", size_bytes: 9 },
          upload_attempt: 1,
          upload_url: new URL(uploadPath, url).toString(),
        });
      }
      if (init?.method === "HEAD") throw new Error("preflight connection reset");
      if (init?.method === "PUT") putCount += 1;
      return Response.json({ archive: { id: "archive-preflight", status: "failed" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveProxyMaxBytes: 8,
    });
    await client.initIssueSessionArchive("runtime-preflight", "issue-preflight", {
      sourceRevision: "revision-preflight",
      sha256: "abc",
      sizeBytes: 9,
      fileCount: 1,
    });

    await expect(client.uploadIssueSessionArchive(
      "runtime-preflight",
      "issue-preflight",
      "archive-preflight",
      archivePath,
    )).rejects.toThrow("proxy fallback limit");
    expect(putCount).toBe(0);
  });

  it("bounds upload failure reporting when the control plane does not respond", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-failure-timeout-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "too-large");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        return Response.json({
          archive: { id: "archive-failure-timeout", status: "pending", size_bytes: 9 },
          upload_attempt: 1,
          upload_url: "/api/daemon/runtimes/runtime-timeout/issues/issue-timeout/session-archives/archive-failure-timeout/content?attempt=1",
        });
      }
      if (url.includes("/failure?attempt=1")) return await rejectWhenAborted(init?.signal);
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveProxyMaxBytes: 8,
      sessionArchiveFailureReportTimeoutMs: 20,
    });
    await client.initIssueSessionArchive("runtime-timeout", "issue-timeout", {
      sourceRevision: "revision-timeout",
      sha256: "abc",
      sizeBytes: 9,
      fileCount: 1,
    });
    const started = Date.now();
    const result = await client.uploadIssueSessionArchive(
      "runtime-timeout",
      "issue-timeout",
      "archive-failure-timeout",
      archivePath,
    ).catch((value: unknown) => value as Error & { cause?: Error });
    expect(result).toBeInstanceOf(Error);
    const error = result as Error & { cause?: Error };

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error.message).toContain("additionally failed to persist archive upload failure");
    expect(error.cause?.message).toContain("proxy fallback limit");
  });

  it("keeps the original upload error when failure reporting sees a stale attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-stale-failure-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    writeFileSync(archivePath, "too-large");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        return Response.json({
          archive: { id: "archive-stale", status: "pending", size_bytes: 9 },
          upload_attempt: 1,
          upload_url: "/api/daemon/runtimes/runtime-stale/issues/issue-stale/session-archives/archive-stale/content?attempt=1",
        });
      }
      return new Response(JSON.stringify({
        error: "session archive upload attempt was superseded",
        code: "session_archive_attempt_conflict",
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveProxyMaxBytes: 8,
    });
    await client.initIssueSessionArchive("runtime-stale", "issue-stale", {
      sourceRevision: "revision-stale",
      sha256: "abc",
      sizeBytes: 9,
      fileCount: 1,
    });
    const result = await client.uploadIssueSessionArchive(
      "runtime-stale",
      "issue-stale",
      "archive-stale",
      archivePath,
    ).catch((value: unknown) => value as Error);
    expect(result).toBeInstanceOf(Error);
    const error = result as Error;

    expect(error.message).toContain("proxy fallback limit");
    expect(error.message).not.toContain("additionally failed");
    await expect(client.uploadIssueSessionArchive(
      "runtime-stale",
      "issue-stale",
      "archive-stale",
      archivePath,
    )).rejects.toThrow("must be initialized");
  });

  it("aborts a short archive stream within the configured upload timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-short-stream-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    const declaredBytes = 2 * 1024 * 1024;
    writeFileSync(archivePath, Buffer.alloc(declaredBytes, 0x61));
    let streamedBytes = declaredBytes;
    let reportedError = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        const uploadPath = "/api/daemon/runtimes/runtime-short/issues/issue-short/session-archives/archive-short/content?attempt=1";
        return Response.json({
          archive: { id: "archive-short", status: "pending", size_bytes: declaredBytes },
          upload_attempt: 1,
          upload_url: new URL(uploadPath, url).toString(),
        });
      }
      if (init?.method === "HEAD") {
        return new Response(null, { status: 204, headers: { "X-Remi-Archive-Direct": "1" } });
      }
      if (init?.method === "PUT") {
        truncateSync(archivePath, 0);
        streamedBytes = (await readStreamingBody(init.body)).byteLength;
        return await rejectWhenAborted(init.signal);
      }
      if (url.includes("/failure?attempt=1")) {
        reportedError = String(JSON.parse(String(init?.body)).error);
        return Response.json({ archive: { id: "archive-short", status: "failed" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token", {
      sessionArchiveProxyMaxBytes: 8,
      sessionArchiveUploadTimeoutMs: 25,
      sessionArchiveFailureReportTimeoutMs: 100,
    });
    await client.initIssueSessionArchive("runtime-short", "issue-short", {
      sourceRevision: "revision-short",
      sha256: "abc",
      sizeBytes: declaredBytes,
      fileCount: 1,
    });
    const started = Date.now();

    await expect(client.uploadIssueSessionArchive(
      "runtime-short",
      "issue-short",
      "archive-short",
      archivePath,
    )).rejects.toThrow("upload timed out after 25ms");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(streamedBytes).toBeLessThan(declaredBytes);
    expect(reportedError).toContain("upload timed out after 25ms");
  });

  it("streams a direct archive larger than 10 MiB through Bun 1.3.14 with the exact SHA-256", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-daemon-client-native-upload-"));
    temporaryRoots.push(root);
    const archivePath = join(root, "sessions.tar.gz");
    const archiveBytes = Buffer.alloc(12 * 1024 * 1024 + 17, 0x5a);
    writeFileSync(archivePath, archiveBytes);
    const expectedSha256 = createHash("sha256").update(archiveBytes).digest("hex");
    let uploadedBytes = 0;
    let uploadedChunks = 0;
    const uploadedHash = createHash("sha256");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/init")) {
          const uploadPath = "/api/daemon/runtimes/runtime-native/issues/issue-native/session-archives/archive-native/content?attempt=3";
          return Response.json({
            archive: {
              id: "archive-native",
              status: "pending",
              source_revision: "revision-native",
              sha256: "def",
              size_bytes: archiveBytes.byteLength,
            },
            upload_attempt: 3,
            upload_url: new URL(uploadPath, request.url).toString(),
          });
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 204,
            headers: { "X-Remi-Archive-Direct": "1" },
          });
        }
        if (request.method === "PUT") {
          const reader = request.body!.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            uploadedBytes += value.byteLength;
            uploadedChunks += 1;
            uploadedHash.update(value);
          }
        }
        return Response.json({
          archive: {
            id: "archive-native",
            status: "uploading",
            source_revision: "revision-native",
            sha256: "def",
            size_bytes: archiveBytes.byteLength,
          },
        });
      },
    });
    try {
      const client = new MultiremiDaemonClient(`http://127.0.0.1:${server.port}`, "daemon-token");
      await client.initIssueSessionArchive("runtime-native", "issue-native", {
        sourceRevision: "revision-native",
        sha256: "def",
        sizeBytes: archiveBytes.byteLength,
        fileCount: 1,
      });
      await client.uploadIssueSessionArchive(
        "runtime-native",
        "issue-native",
        "archive-native",
        archivePath,
      );
      expect(uploadedBytes).toBe(archiveBytes.byteLength);
      expect(uploadedChunks).toBeGreaterThan(1);
      expect(uploadedHash.digest("hex")).toBe(expectedSha256);
    } finally {
      server.stop(true);
    }
  });
});
