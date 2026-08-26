import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { createStore, db, readyArchiveBinding, resetMultiremiTestEnv } from "./helpers.js";

let archiveRoot: string | null = null;

afterEach(() => {
  resetMultiremiTestEnv();
  if (archiveRoot) rmSync(archiveRoot, { recursive: true, force: true });
  archiveRoot = null;
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(daemonDirectBaseUrl?: string | null, maxBytes = 1024 * 1024) {
  const store = createStore();
  store.ensureLocalWorkspace();
  const daemonId = "dmn_archive";
  const runtime = store.registerRuntime({
    id: "rt_archive",
    name: "archive runtime",
    provider: "codex",
    daemonId,
    workspaceId: "local",
  });
  const issue = store.createIssue({ title: "Archive sessions", workspaceId: "local" });
  store.reportIssueWorkspace({
    issueId: issue.id,
    runtimeId: runtime.id,
    rootPath: `/tmp/${issue.key}`,
    branchName: `agent/${issue.key}`,
    status: "ready",
  });
  const token = await store.createAccessToken({
    name: "archive daemon",
    type: "daemon",
    purpose: "daemon",
    workspaceId: "local",
    daemonId,
  });
  archiveRoot = mkdtempSync(join(tmpdir(), "multiremi-session-archives-"));
  const sessionArchives = new SessionArchiveService(store, {
    root: archiveRoot,
    maxBytes,
    minFreeBytes: 0,
  });
  const app = createMultiremiApp({
    store,
    authToken: "root-secret",
    sessionArchives,
    ...(daemonDirectBaseUrl === undefined ? {} : { daemonDirectBaseUrl }),
  });
  const daemonHeaders = {
    Authorization: `Bearer ${token.token}`,
    "Content-Type": "application/json",
  };
  const base = `/api/daemon/runtimes/${runtime.id}/issues/${issue.id}/session-archives`;
  return { store, app, issue, runtime, token, daemonHeaders, base, sessionArchives };
}

async function createPhysicalReadyArchive(
  sessionArchives: SessionArchiveService,
  issueId: string,
  runtimeId: string,
  daemonId: string,
  bytes: Uint8Array,
) {
  const initialized = sessionArchives.initialize({
    workspaceId: "local",
    issueId,
    runtimeId,
    daemonId,
    sourceRevision: `physical-${sha256(bytes)}`,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
  }).archive;
  const claimed = await sessionArchives.claimUploadAttempt(runtimeId, issueId, initialized.id);
  await sessionArchives.upload(
    runtimeId,
    issueId,
    initialized.id,
    claimed.uploadAttempt!,
    new Response(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ).body,
  );
  const ready = await sessionArchives.complete(
    runtimeId,
    issueId,
    initialized.id,
    claimed.uploadAttempt!,
  );
  return { archiveId: ready.id, sourceRevision: ready.sourceRevision, sha256: ready.sha256 };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Multiremi session archives", () => {
  it("advertises a configured direct API origin and rejects malformed origins", async () => {
    const { app, daemonHeaders, base } = await fixture("https://api-direct.example:7443");
    const initialized = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "direct-origin-v1",
        sha256: sha256(Buffer.from("direct")),
        size_bytes: 6,
      }),
    });

    expect(initialized.status).toBe(201);
    expect((await initialized.json() as any).upload_url).toStartWith(
      `https://api-direct.example:7443${base}/`,
    );

    await expect(fixture("https://api-direct.example/prefixed"))
      .rejects.toThrow("MULTIREMI_DAEMON_DIRECT_BASE_URL");
    await expect(fixture("file:///tmp/archive"))
      .rejects.toThrow("MULTIREMI_DAEMON_DIRECT_BASE_URL");
  });

  it("streams a 12 MiB daemon upload directly into the API and completes SHA-256 verification", async () => {
    const { store, app, issue, runtime, token } = await fixture(null, 64 * 1024 * 1024);
    const archivePath = join(archiveRoot!, "daemon-source.tar.gz");
    const bytes = Buffer.alloc(12 * 1024 * 1024 + 29, 0x41);
    const digest = sha256(bytes);
    writeFileSync(archivePath, bytes);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const client = new MultiremiDaemonClient(origin, token.token, {
        sessionArchiveUploadBaseUrl: origin,
      });
      const initialized = await client.initIssueSessionArchive(runtime.id, issue.id, {
        sourceRevision: "api-stream-v1",
        sha256: digest,
        sizeBytes: bytes.byteLength,
        fileCount: 1,
      });
      const uploaded = await client.uploadIssueSessionArchive(
        runtime.id,
        issue.id,
        initialized.archive.id,
        archivePath,
      );
      const completed = await client.completeIssueSessionArchive(
        runtime.id,
        issue.id,
        initialized.archive.id,
      );

      expect(uploaded).toMatchObject({ status: "uploading", size_bytes: bytes.byteLength });
      expect(completed).toMatchObject({ status: "ready", sha256: digest, size_bytes: bytes.byteLength });
      expect(store.getSessionArchive(initialized.archive.id)).toMatchObject({
        status: "ready",
        sha256: digest,
        uploadedSizeBytes: bytes.byteLength,
      });
    } finally {
      server.stop(true);
    }
  });

  it("reports pre-init preparation failures to the control plane and retries without forging ready", async () => {
    const { store, app, issue, daemonHeaders, base } = await fixture();
    const body = JSON.stringify({
      stage: "prepare",
      error: "Refusing to archive symlink: sessions/escape.jsonl",
    });

    const unauthenticated = await app.request(`${base}/failure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(unauthenticated.status).toBe(401);

    const forged = await app.request(`${base}/failure`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        stage: "prepare",
        error: "pack failed",
        status: "ready",
      }),
    });
    expect(forged.status).toBe(400);

    const first = await app.request(`${base}/failure`, {
      method: "POST",
      headers: daemonHeaders,
      body,
    });
    expect(first.status).toBe(201);
    const failed = (await first.json() as any).archive;
    expect(failed).toMatchObject({
      issue_id: issue.id,
      status: "failed",
      source_revision: "preparation-failed",
      sha256: "0".repeat(64),
      size_bytes: 0,
      uploaded_size_bytes: 0,
      attempt_count: 0,
      last_error: "Refusing to archive symlink: sessions/escape.jsonl",
      metadata: {
        kind: "preparation_failure",
        stage: "prepare",
        source: ".multiremi/sessions",
      },
    });
    expect(store.getSessionArchiveStatus(issue.id)).toMatchObject({
      latest: { id: failed.id, status: "failed" },
      latestReady: null,
      gcReady: false,
    });

    const issueView = await app.request(`/api/issues/${issue.key}/session-archives`, {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(issueView.status).toBe(200);
    expect(await issueView.json()).toMatchObject({
      latest: { id: failed.id, status: "failed" },
      latest_ready: null,
      archives: [{ id: failed.id, status: "failed" }],
    });

    const settingsView = await app.request("/api/workspaces/local/session-archive", {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(settingsView.status).toBe(200);
    expect(await settingsView.json()).toMatchObject({
      usage: { failed_archives: 1, ready_archives: 0 },
      last_failure: {
        archive_id: failed.id,
        issue_id: issue.id,
        issue_key: issue.key,
        error: "Refusing to archive symlink: sessions/escape.jsonl",
      },
    });

    const retry = await app.request(`/api/issues/${issue.key}/session-archives/${failed.id}/retry`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).archive).toMatchObject({ id: failed.id, status: "pending" });

    const repeated = await app.request(`${base}/failure`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({ stage: "prepare", error: "archive remains unsafe" }),
    });
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as any).archive).toMatchObject({
      id: failed.id,
      status: "failed",
      last_error: "archive remains unsafe",
    });
    expect(store.listSessionArchives(issue.id)).toHaveLength(1);

    const emptyDigest = sha256(Buffer.alloc(0));
    const resolved = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "empty-sessions-v1",
        sha256: emptyDigest,
        size_bytes: 0,
        file_count: 0,
      }),
    });
    expect(resolved.status).toBe(201);
    expect(store.getSessionArchive(failed.id)).toBeNull();
    expect(store.getSessionArchiveWorkspaceUsage("local").lastFailure).toBeNull();
  });

  it("uploads, durably completes, verifies, and exposes an exact GC barrier", async () => {
    const { store, app, issue, daemonHeaders, base } = await fixture();
    const bytes = Buffer.from("provider-native-session-history\n", "utf8");
    const digest = sha256(bytes);
    const init = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "sessions-v1",
        sha256: digest,
        size_bytes: bytes.byteLength,
        file_count: 3,
        metadata: { providers: ["claude", "codex"] },
      }),
    });
    expect(init.status).toBe(201);
    const initialized = await init.json() as any;
    expect(initialized.archive).toMatchObject({
      issue_id: issue.id,
      source_revision: "sessions-v1",
      status: "pending",
      relative_path: expect.not.stringContaining(".."),
    });
    expect(initialized.upload_attempt).toBe(1);
    expect(initialized.upload_url).toEndWith(`/${initialized.archive.id}/content?attempt=1`);
    expect(initialized.upload_url).toStartWith("/");

    const idempotent = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "sessions-v1",
        sha256: digest,
        size_bytes: bytes.byteLength,
      }),
    });
    expect(idempotent.status).toBe(200);
    const resumed = await idempotent.json() as any;
    expect(resumed.archive.id).toBe(initialized.archive.id);
    expect(resumed.upload_attempt).toBe(2);

    const staleUpload = await app.request(initialized.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(staleUpload.status).toBe(409);

    const upload = await app.request(resumed.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(upload.status).toBe(200);
    expect((await upload.json() as any).archive).toMatchObject({
      status: "uploading",
      uploaded_size_bytes: bytes.byteLength,
    });

    const completed = await app.request(`${base}/${initialized.archive.id}/complete?attempt=2`, {
      method: "POST",
      headers: daemonHeaders,
    });
    expect(completed.status).toBe(200);
    const ready = (await completed.json() as any).archive;
    expect(ready.status).toBe("ready");
    const storedPath = join(archiveRoot!, ready.relative_path);
    expect(readFileSync(storedPath)).toEqual(bytes);
    expect(existsSync(`${storedPath}.1.partial`)).toBe(false);
    expect(existsSync(`${storedPath}.2.partial`)).toBe(false);
    expect(JSON.parse(readFileSync(join(storedPath, "..", "manifest.json"), "utf8"))).toMatchObject({
      schema_version: 1,
      archive_id: ready.id,
      sha256: digest,
      size_bytes: bytes.byteLength,
    });

    const status = await app.request(
      `${base}/status?source_revision=sessions-v1&sha256=${digest}`,
      { headers: { Authorization: daemonHeaders.Authorization } },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      gc_ready: true,
      requested_ready: { id: ready.id, status: "ready" },
    });

    rmSync(storedPath);
    const lightweightStatus = await app.request(
      `${base}/status?source_revision=sessions-v1&sha256=${digest}`,
      { headers: { Authorization: daemonHeaders.Authorization } },
    );
    expect(await lightweightStatus.json()).toMatchObject({
      gc_ready: true,
      requested_ready: { id: ready.id, status: "ready" },
    });

    const verifiedStatus = await app.request(
      `${base}/status?source_revision=sessions-v1&sha256=${digest}&verify_ready=1`,
      { headers: { Authorization: daemonHeaders.Authorization } },
    );
    expect(verifiedStatus.status).toBe(200);
    expect(await verifiedStatus.json()).toMatchObject({
      latest: { id: ready.id, status: "failed" },
      latest_ready: null,
      requested_ready: null,
      gc_ready: false,
    });
    expect(store.getSessionArchive(ready.id)?.metadata).toEqual({ providers: ["claude", "codex"] });
  });

  it("persists an upload failure against only the current claimed attempt", async () => {
    const { store, app, daemonHeaders, base } = await fixture();
    const init = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "proxy-limit-v1",
        sha256: sha256(Buffer.from("proxy-limit")),
        size_bytes: 11,
      }),
    });
    const initialized = await init.json() as any;
    const failureUrl = `${base}/${initialized.archive.id}/failure?attempt=${initialized.upload_attempt}`;
    const failed = await app.request(failureUrl, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({ error: "Direct archive upload is not configured" }),
    });

    expect(failed.status).toBe(200);
    expect((await failed.json() as any).archive).toMatchObject({
      status: "failed",
      last_error: "Direct archive upload is not configured",
    });
    expect(store.getSessionArchive(initialized.archive.id)).toMatchObject({
      status: "failed",
      lastError: "Direct archive upload is not configured",
    });

    const resumed = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "proxy-limit-v1",
        sha256: sha256(Buffer.from("proxy-limit")),
        size_bytes: 11,
      }),
    });
    expect((await resumed.json() as any).upload_attempt).toBe(initialized.upload_attempt + 1);
    const stale = await app.request(failureUrl, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({ error: "stale failure" }),
    });
    expect(stale.status).toBe(409);
  });

  it("reclaims a crashed same-Runtime upload with a fenced attempt and removes its partial", async () => {
    const { store, app, runtime, daemonHeaders, base } = await fixture();
    const bytes = Buffer.from("crash-safe-provider-history\n", "utf8");
    const body = JSON.stringify({
      source_revision: "crash-v1",
      sha256: sha256(bytes),
      size_bytes: bytes.byteLength,
    });
    const firstResponse = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body,
    });
    const first = await firstResponse.json() as any;
    expect(first.upload_attempt).toBe(1);
    expect(store.beginSessionArchiveUploadAttempt(first.archive.id, runtime.id, 1)).toMatchObject({
      status: "uploading",
      attemptCount: 1,
    });
    const finalPath = join(archiveRoot!, first.archive.relative_path);
    const stalePartial = `${finalPath}.1.partial`;
    writeFileSync(stalePartial, "interrupted upload");
    expect(existsSync(stalePartial)).toBe(true);

    const resumedResponse = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body,
    });
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json() as any;
    expect(resumed).toMatchObject({
      upload_attempt: 2,
      archive: { id: first.archive.id, status: "pending", attempt_count: 2 },
    });
    expect(existsSync(stalePartial)).toBe(false);

    const stalePut = await app.request(first.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(stalePut.status).toBe(409);
    expect(await stalePut.json()).toMatchObject({ code: "session_archive_attempt_conflict" });

    const upload = await app.request(resumed.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(upload.status).toBe(200);

    const staleComplete = await app.request(`${base}/${first.archive.id}/complete?attempt=1`, {
      method: "POST",
      headers: daemonHeaders,
    });
    expect(staleComplete.status).toBe(409);
    expect(store.getSessionArchive(first.archive.id)).toMatchObject({
      status: "uploading",
      attemptCount: 2,
      lastError: null,
    });

    const completed = await app.request(`${base}/${first.archive.id}/complete?attempt=2`, {
      method: "POST",
      headers: daemonHeaders,
    });
    expect(completed.status).toBe(200);
    expect((await completed.json() as any).archive).toMatchObject({ status: "ready", attempt_count: 2 });
    expect(store.markSessionArchiveFailedAttempt(
      first.archive.id,
      runtime.id,
      1,
      "late crash callback",
    )).toBeNull();
    expect(store.getSessionArchive(first.archive.id)).toMatchObject({
      status: "ready",
      attemptCount: 2,
      lastError: null,
    });
  });

  it("repairs a corrupt ready object through verify and a fenced reupload", async () => {
    const { app, daemonHeaders, base } = await fixture();
    const bytes = Buffer.from("repairable-provider-history");
    const init = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "repair-v1",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      }),
    });
    const first = await init.json() as any;
    await app.request(first.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    await app.request(
      `${base}/${first.archive.id}/complete?attempt=${first.upload_attempt}`,
      { method: "POST", headers: daemonHeaders },
    );
    const storedPath = join(archiveRoot!, first.archive.relative_path);
    writeFileSync(storedPath, Buffer.alloc(bytes.byteLength, 0x78));

    const failed = await app.request(
      `${base}/status?source_revision=repair-v1&sha256=${sha256(bytes)}&verify_ready=1`,
      { headers: { Authorization: daemonHeaders.Authorization } },
    );
    expect(await failed.json()).toMatchObject({ gc_ready: false, latest: { status: "failed" } });

    const retryInit = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "repair-v1",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      }),
    });
    const retry = await retryInit.json() as any;
    expect(retry.upload_attempt).toBe(2);
    expect((await app.request(retry.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    })).status).toBe(200);
    expect((await app.request(
      `${base}/${retry.archive.id}/complete?attempt=${retry.upload_attempt}`,
      { method: "POST", headers: daemonHeaders },
    )).status).toBe(200);
    expect(readFileSync(storedPath)).toEqual(bytes);

    const ready = await app.request(
      `${base}/status?source_revision=repair-v1&sha256=${sha256(bytes)}&verify_ready=1`,
      { headers: { Authorization: daemonHeaders.Authorization } },
    );
    expect(await ready.json()).toMatchObject({ gc_ready: true, requested_ready: { status: "ready" } });
  });

  it("rejects a ready archive replaced by a symlink without following it", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    const bytes = Buffer.from("ready archive before replacement");
    const binding = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      bytes,
    );
    const archive = store.getSessionArchive(binding.archiveId)!;
    const storedPath = join(archiveRoot!, archive.relativePath);
    const originalPath = `${storedPath}.original`;
    const outsidePath = join(archiveRoot!, "outside-ready-archive");
    renameSync(storedPath, originalPath);
    writeFileSync(outsidePath, bytes);
    symlinkSync(outsidePath, storedPath, "file");

    const verified = await sessionArchives.verify(binding.archiveId);

    expect(verified).toMatchObject({ valid: false, actualSha256: null, actualSizeBytes: null });
    expect(verified.error).toContain("regular file");
    expect(store.getSessionArchive(binding.archiveId)).toMatchObject({ status: "failed" });
    expect(readFileSync(outsidePath)).toEqual(bytes);
    expect(readFileSync(originalPath)).toEqual(bytes);
  });

  it("finishes idempotently when another Server process already promoted the partial", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    const bytes = Buffer.from("cross-process completion");
    const initialized = sessionArchives.initialize({
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "multi-server-v1",
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    });
    const claim = await sessionArchives.claimUploadAttempt(runtime.id, issue.id, initialized.archive.id);
    await sessionArchives.upload(
      runtime.id,
      issue.id,
      initialized.archive.id,
      claim.uploadAttempt!,
      new Response(bytes).body,
    );
    const finalPath = join(archiveRoot!, initialized.archive.relativePath);
    renameSync(`${finalPath}.${claim.uploadAttempt}.partial`, finalPath);

    const otherServer = new SessionArchiveService(store, {
      root: archiveRoot!,
      maxBytes: 1024 * 1024,
      minFreeBytes: 0,
    });
    await expect(otherServer.complete(
      runtime.id,
      issue.id,
      initialized.archive.id,
      claim.uploadAttempt!,
    )).resolves.toMatchObject({ status: "ready", attemptCount: claim.uploadAttempt });
    expect(readFileSync(finalPath)).toEqual(bytes);
  });

  it("purges archive bytes and metadata on an explicit Issue hard delete", async () => {
    const { store, app, issue, daemonHeaders, base } = await fixture();
    const bytes = Buffer.from("delete-me-after-explicit-hard-delete");
    const init = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "delete-v1",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      }),
    });
    const initialized = await init.json() as any;
    expect((await app.request(initialized.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    })).status).toBe(200);
    expect((await app.request(
      `${base}/${initialized.archive.id}/complete?attempt=${initialized.upload_attempt}`,
      { method: "POST", headers: daemonHeaders },
    )).status).toBe(200);
    const storedPath = join(archiveRoot!, initialized.archive.relative_path);
    expect(existsSync(storedPath)).toBe(true);
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: "rt_archive",
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: "rt_archive",
      ...readyArchiveBinding(store, issue.id, "rt_archive"),
    });

    const deleted = await app.request(`/api/issues/${issue.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(deleted.status).toBe(204);
    expect(existsSync(storedPath)).toBe(false);
    expect(store.getIssue(issue.id)).toBeNull();
    expect(store.listSessionArchives(issue.id)).toEqual([]);
  });

  it("does not hard-delete an Issue before its workspace is archived and cleaned", async () => {
    const { store, app, issue, runtime, sessionArchives } = await fixture();
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });

    const blocked = await app.request(`/api/issues/${issue.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "issue_workspace_not_cleaned" });
    expect(store.getIssue(issue.id)?.id).toBe(issue.id);

    const binding = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("delete barrier"),
    );
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...binding,
    });
    expect((await app.request(`/api/issues/${issue.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    })).status).toBe(204);
  });

  it("binds a cleaned workspace acknowledgement to the physically verified exact archive", async () => {
    const { store, app, issue, runtime, daemonHeaders, sessionArchives } = await fixture();
    const binding = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("exact cleaned acknowledgement"),
    );
    const endpoint = `/api/daemon/issues/${issue.id}/workspace/cleaned`;
    const mismatch = await app.request(endpoint, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        runtime_id: runtime.id,
        archive_id: binding.archiveId,
        source_revision: binding.sourceRevision,
        sha256: "0".repeat(64),
      }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: "issue_workspace_archive_invalid" });
    expect(store.getIssueWorkspace(issue.id)?.status).toBe("ready");

    const acknowledged = await app.request(endpoint, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        runtime_id: runtime.id,
        archive_id: binding.archiveId,
        source_revision: binding.sourceRevision,
        sha256: binding.sha256,
      }),
    });
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toMatchObject({
      status: "cleaned",
      archive_id: binding.archiveId,
      source_revision: binding.sourceRevision,
      sha256: binding.sha256,
    });
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({
      cleanedArchiveId: binding.archiveId,
      cleanedArchiveSourceRevision: binding.sourceRevision,
      cleanedArchiveSha256: binding.sha256,
    });
  });

  it("physically verifies every exact archive before atomically batch deleting Issues", async () => {
    const { store, app, issue, runtime, sessionArchives } = await fixture();
    const second = store.createIssue({ title: "Second atomic delete", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: second.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${second.key}`,
      branchName: `agent/${second.key}`,
      status: "ready",
    });
    const firstBinding = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("first intact archive"),
    );
    const secondBinding = await createPhysicalReadyArchive(
      sessionArchives,
      second.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("second archive to corrupt"),
    );
    store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id, ...firstBinding });
    store.markIssueWorkspaceCleaned({ issueId: second.id, runtimeId: runtime.id, ...secondBinding });
    const firstPath = join(archiveRoot!, store.getSessionArchive(firstBinding.archiveId)!.relativePath);
    const secondPath = join(archiveRoot!, store.getSessionArchive(secondBinding.archiveId)!.relativePath);
    writeFileSync(secondPath, "corrupt");

    const response = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer root-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ issue_ids: [issue.id, second.id] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "issue_workspace_archive_invalid" });
    expect(store.getIssue(issue.id)?.id).toBe(issue.id);
    expect(store.getIssue(second.id)?.id).toBe(second.id);
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
  });

  it("does not hard-delete an Issue with an active task before a workspace is reported", async () => {
    const { store, app, issue } = await fixture();
    const agent = store.createAgent({ name: "Archive worker", provider: "codex" });
    store.createTask({
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      agentId: agent.id,
      prompt: "still running",
    });

    const blocked = await app.request(`/api/issues/${issue.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "issue_has_active_tasks" });
    expect(store.getIssue(issue.id)?.id).toBe(issue.id);
  });

  it("keeps archive bytes until the Issue delete commits and recovers committed purge receipts", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    sessionArchives.stopIssueArchivePurgeRecovery();
    const bytes = Buffer.from("durable purge outbox");
    const initialized = sessionArchives.initialize({
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "purge-v1",
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    });
    const claim = await sessionArchives.claimUploadAttempt(runtime.id, issue.id, initialized.archive.id);
    await sessionArchives.upload(
      runtime.id,
      issue.id,
      initialized.archive.id,
      claim.uploadAttempt!,
      new Response(bytes).body,
    );
    await sessionArchives.complete(runtime.id, issue.id, initialized.archive.id, claim.uploadAttempt!);
    const storedPath = join(archiveRoot!, initialized.archive.relativePath);
    const uncommitted = await sessionArchives.prepareIssueArchivePurge(issue.id);
    await expect(sessionArchives.completeIssueArchivePurge(uncommitted)).rejects.toMatchObject({
      code: "session_archive_purge_not_committed",
    });
    expect(existsSync(storedPath)).toBe(true);
    await sessionArchives.abortIssueArchivePurge(uncommitted);

    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });
    await sessionArchives.prepareIssueArchivePurge(issue.id);
    expect(store.deleteIssue(issue.id)).toBe(true);
    expect(await sessionArchives.recoverIssueArchivePurges(0)).toBe(1);
    expect(existsSync(storedPath)).toBe(false);
  });

  it("isolates purge receipt failures and periodically converges committed cleanup", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    sessionArchives.stopIssueArchivePurgeRecovery();
    const second = store.createIssue({ title: "Second purge receipt", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: second.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${second.key}`,
      branchName: `agent/${second.key}`,
      status: "ready",
    });
    const firstBinding = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("first periodic purge"),
    );
    const secondBinding = await createPhysicalReadyArchive(
      sessionArchives,
      second.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("second isolated purge"),
    );
    const firstArchive = store.getSessionArchive(firstBinding.archiveId)!;
    const secondArchive = store.getSessionArchive(secondBinding.archiveId)!;
    const firstPath = join(archiveRoot!, firstArchive.relativePath);
    const secondPath = join(archiveRoot!, secondArchive.relativePath);
    store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id, ...firstBinding });
    store.markIssueWorkspaceCleaned({ issueId: second.id, runtimeId: runtime.id, ...secondBinding });
    expect(store.beginIssueDeletion(issue.id)).toEqual({ ok: true });
    expect(store.beginIssueDeletion(second.id)).toEqual({ ok: true });
    await sessionArchives.prepareIssueArchivePurge(issue.id);
    await sessionArchives.prepareIssueArchivePurge(second.id);
    expect(store.deleteIssuesAtomically([issue.id, second.id])).toEqual({ deleted: 2 });

    const internal = sessionArchives as unknown as {
      purgeArchivePaths(paths: string[]): Promise<number>;
    };
    const originalPurge = internal.purgeArchivePaths.bind(sessionArchives);
    internal.purgeArchivePaths = async (paths) => {
      if (paths.includes(firstArchive.relativePath)) throw new Error("transient first receipt failure");
      return await originalPurge(paths);
    };
    expect(await sessionArchives.recoverIssueArchivePurges()).toBe(1);
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(false);

    internal.purgeArchivePaths = originalPurge;
    sessionArchives.startIssueArchivePurgeRecovery(10);
    await waitUntil(() => !existsSync(firstPath));
    sessionArchives.stopIssueArchivePurgeRecovery();
    expect(readdirSync(join(archiveRoot!, ".issue-purge-outbox"))
      .filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("discovers purge receipts published by another Server after an empty recovery pass", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    sessionArchives.stopIssueArchivePurgeRecovery();
    sessionArchives.startIssueArchivePurgeRecovery(10);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const binding = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("cross-server periodic purge"),
    );
    const archive = store.getSessionArchive(binding.archiveId)!;
    const storedPath = join(archiveRoot!, archive.relativePath);
    store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id, ...binding });
    expect(store.beginIssueDeletion(issue.id)).toEqual({ ok: true });

    const otherServer = new SessionArchiveService(store, {
      root: archiveRoot!,
      maxBytes: 1024 * 1024,
      minFreeBytes: 0,
    });
    await otherServer.prepareIssueArchivePurge(issue.id);
    expect(store.deleteIssuesAtomically([issue.id])).toEqual({ deleted: 1 });

    await waitUntil(() => !existsSync(storedPath));
    sessionArchives.stopIssueArchivePurgeRecovery();
    expect(readdirSync(join(archiveRoot!, ".issue-purge-outbox"))
      .filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("fails closed when a materialized Issue is missing its workspace cleanup record", async () => {
    const { store, app, runtime, sessionArchives } = await fixture();
    const neverMaterialized = store.createIssue({
      title: "Never materialized",
      workspaceId: "local",
    });
    expect((await app.request(`/api/issues/${neverMaterialized.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer root-secret" },
    })).status).toBe(204);

    const taskIssue = store.createIssue({ title: "Task evidence", workspaceId: "local" });
    const agent = store.createAgent({ name: "Evidence agent", provider: "codex" });
    const task = store.createTask({
      workspaceId: "local",
      issueId: taskIssue.id,
      agentId: agent.id,
      prompt: "finish before delete",
    });
    store.cancelTask(task.id);

    const sessionIssue = store.createIssue({ title: "Session evidence", workspaceId: "local" });
    store.createIssueSession(sessionIssue.id, { title: "Materialized session" });

    const archiveIssue = store.createIssue({ title: "Archive evidence", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: archiveIssue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${archiveIssue.key}`,
      branchName: `agent/${archiveIssue.key}`,
      status: "ready",
    });
    sessionArchives.initialize({
      workspaceId: "local",
      issueId: archiveIssue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "evidence-v1",
      sha256: sha256(Buffer.from("evidence")),
      sizeBytes: Buffer.byteLength("evidence"),
    });
    db!.run("DELETE FROM multiremi_issue_workspaces WHERE issue_id = ?", [archiveIssue.id]);

    for (const issueId of [taskIssue.id, sessionIssue.id, archiveIssue.id]) {
      const blocked = await app.request(`/api/issues/${issueId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer root-secret" },
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: "issue_workspace_not_cleaned" });
      expect(store.getIssue(issueId)?.id).toBe(issueId);
    }
  });

  it("fences archive init, upload, and completion once an Issue is deleting or cleaned", async () => {
    const { store, app, issue, runtime, daemonHeaders, base } = await fixture();
    const bytes = Buffer.from("lifecycle-fence");
    const initializedResponse = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "fence-v1",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      }),
    });
    expect(initializedResponse.status).toBe(201);
    const initialized = await initializedResponse.json() as any;

    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...readyArchiveBinding(store, issue.id, runtime.id),
    });

    const blockedUpload = await app.request(initialized.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(blockedUpload.status).toBe(409);
    expect(await blockedUpload.json()).toMatchObject({ code: "issue_archive_lifecycle_closed" });

    const blockedComplete = await app.request(
      `${base}/${initialized.archive.id}/complete?attempt=${initialized.upload_attempt}`,
      { method: "POST", headers: daemonHeaders },
    );
    expect(blockedComplete.status).toBe(409);
    expect(await blockedComplete.json()).toMatchObject({ code: "issue_archive_lifecycle_closed" });

    const blockedInit = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "fence-v2",
        sha256: sha256(Buffer.from("new")),
        size_bytes: 3,
      }),
    });
    expect(blockedInit.status).toBe(409);
    expect(await blockedInit.json()).toMatchObject({ code: "issue_archive_lifecycle_closed" });

    const deleting = store.createIssue({ title: "Deleting archive fence", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: deleting.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${deleting.key}`,
      branchName: `agent/${deleting.key}`,
      status: "ready",
    });
    db!.run("UPDATE multiremi_issues SET lifecycle_state = 'deleting' WHERE id = ?", [deleting.id]);
    const deletingBase = `/api/daemon/runtimes/${runtime.id}/issues/${deleting.id}/session-archives`;
    const deletingInit = await app.request(`${deletingBase}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "deleting-v1",
        sha256: sha256(Buffer.from("blocked")),
        size_bytes: 7,
      }),
    });
    expect(deletingInit.status).toBe(409);
    expect(await deletingInit.json()).toMatchObject({ code: "issue_archive_lifecycle_closed" });
    expect(store.listSessionArchives(deleting.id)).toEqual([]);
    store.abortIssueDeletion(deleting.id);
  });

  it("fences a delayed upload failure callback after the workspace is cleaned", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    const ready = await createPhysicalReadyArchive(
      sessionArchives,
      issue.id,
      runtime.id,
      runtime.daemonId!,
      Buffer.from("durable cleanup barrier"),
    );
    const stale = sessionArchives.initialize({
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "stale-upload-after-ready",
      sha256: sha256(Buffer.from("stale upload")),
      sizeBytes: Buffer.byteLength("stale upload"),
    }).archive;
    const claimed = await sessionArchives.claimUploadAttempt(runtime.id, issue.id, stale.id);
    expect(store.beginSessionArchiveUploadAttempt(
      stale.id,
      runtime.id,
      claimed.uploadAttempt!,
    )).toMatchObject({ status: "uploading" });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: runtime.id,
      ...ready,
    });

    expect(store.markSessionArchiveFailedAttempt(
      stale.id,
      runtime.id,
      claimed.uploadAttempt!,
      "late upload callback",
    )).toBeNull();
    expect(store.getSessionArchive(stale.id)).toMatchObject({
      status: "uploading",
      lastError: null,
    });
  });

  it("supersedes a stale Retry when the daemon observes a newer snapshot", async () => {
    const { store, issue, runtime, sessionArchives } = await fixture();
    const first = sessionArchives.initialize({
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "old-revision",
      sha256: sha256(Buffer.from("old")),
      sizeBytes: 3,
    }).archive;
    store.markSessionArchiveFailed(first.id, "initial failure");
    expect(sessionArchives.retry(first.id)).toMatchObject({ status: "pending" });

    const current = sessionArchives.initialize({
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "current-revision",
      sha256: sha256(Buffer.from("current")),
      sizeBytes: 7,
    }).archive;
    expect(store.getSessionArchive(first.id)).toMatchObject({ status: "superseded" });
    expect(current.status).toBe("pending");
    expect(store.getSessionArchiveWorkspaceUsage(issue.workspaceId).pendingArchives).toBe(1);
  });

  it("rejects wrong daemon identity and never accepts a client file path", async () => {
    const { store, app, issue, base, daemonHeaders } = await fixture();
    const otherDaemon = "dmn_other";
    store.registerRuntime({
      id: "rt_other",
      name: "other runtime",
      provider: "codex",
      daemonId: otherDaemon,
      workspaceId: "local",
    });
    const otherToken = await store.createAccessToken({
      name: "other daemon",
      type: "daemon",
      purpose: "daemon",
      workspaceId: "local",
      daemonId: otherDaemon,
    });
    const bytes = Buffer.from("x");
    const otherHeaders = {
      Authorization: `Bearer ${otherToken.token}`,
      "Content-Type": "application/json",
    };
    const initBody = JSON.stringify({
        source_revision: "v1",
        sha256: sha256(bytes),
        size_bytes: 1,
        path: "../../outside",
    });
    const forbiddenRequests: Array<[string, RequestInit]> = [
      [`${base}/status?source_revision=v1&sha256=${sha256(bytes)}`, { headers: otherHeaders }],
      [`${base}/init`, { method: "POST", headers: otherHeaders, body: initBody }],
      [`${base}/sar_missing/content`, { method: "PUT", headers: otherHeaders, body: bytes }],
      [`${base}/sar_missing/complete`, { method: "POST", headers: otherHeaders }],
    ];
    for (const [path, init] of forbiddenRequests) {
      const response = await app.request(path, init);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "daemon_identity_forbidden" });
    }

    const accepted = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: initBody,
    });
    expect(accepted.status).toBe(201);
    const relativePath = (await accepted.json() as any).archive.relative_path as string;
    expect(relativePath).not.toContain("outside");
    expect(relativePath).not.toContain(issue.id);
  });

  it("rejects human and task credentials on daemon archive routes", async () => {
    const { store, app, base } = await fixture();
    const human = await store.createAccessToken({
      name: "archive human",
      type: "pat",
      workspaceId: "local",
      userId: "archive-human",
    });
    const task = await store.createAccessToken({
      name: "archive task",
      type: "task",
      workspaceId: "local",
      userId: "archive-human",
      taskId: "tsk_archive",
      agentId: "agt_archive",
    });
    for (const token of [human.token, task.token]) {
      const response = await app.request(`${base}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(403);
    }
  });

  it("marks integrity failures failed and supports an explicit retry", async () => {
    const { app, daemonHeaders, base } = await fixture();
    const declared = Buffer.from("declared");
    const uploaded = Buffer.from("uploaded");
    const init = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "bad-v1",
        sha256: sha256(declared),
        size_bytes: uploaded.byteLength,
      }),
    });
    const initialized = await init.json() as any;
    const archive = initialized.archive;
    expect((await app.request(initialized.upload_url, {
      method: "PUT",
      headers: {
        Authorization: daemonHeaders.Authorization,
        "Content-Type": "application/octet-stream",
      },
      body: uploaded,
    })).status).toBe(200);
    const complete = await app.request(`${base}/${archive.id}/complete?attempt=${initialized.upload_attempt}`, {
      method: "POST",
      headers: daemonHeaders,
    });
    expect(complete.status).toBe(422);

    const list = await app.request(`/api/issues/${(archive as any).issue_id}/session-archives`, {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect((await list.json() as any).latest.status).toBe("failed");
    const retry = await app.request(
      `/api/issues/${(archive as any).issue_id}/session-archives/${archive.id}/retry`,
      { method: "POST", headers: { Authorization: "Bearer root-secret" } },
    );
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).archive.status).toBe("pending");
  });

  it("rejects intermediate symlinks before writing outside the generated archive tree", async () => {
    const { app, daemonHeaders, base, issue } = await fixture();
    const bytes = Buffer.from("do-not-follow");
    const issueDirectory = join(
      archiveRoot!,
      "workspaces",
      Buffer.from("local", "utf8").toString("base64url"),
      "issues",
      Buffer.from(issue.id, "utf8").toString("base64url"),
    );
    const outside = join(archiveRoot!, "outside");
    mkdirSync(join(issueDirectory, ".."), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, issueDirectory, "dir");
    const init = await app.request(`${base}/init`, {
      method: "POST",
      headers: daemonHeaders,
      body: JSON.stringify({
        source_revision: "symlink-v1",
        sha256: sha256(bytes),
        size_bytes: bytes.byteLength,
      }),
    });
    expect(init.status).toBe(409);
    expect(await init.json()).toMatchObject({ code: "unsafe_archive_path" });
    expect(existsSync(join(outside, "sessions.tar.gz"))).toBe(false);
  });

  it("protects and validates workspace archive settings", async () => {
    const { store, app } = await fixture();
    store.createWorkspaceMember({
      id: "member_archive",
      workspaceId: "local",
      userId: "member_archive",
      name: "Archive Member",
      role: "member",
    });
    const member = await store.createAccessToken({
      name: "member",
      type: "pat",
      workspaceId: "local",
      userId: "member_archive",
    });
    expect((await app.request("/api/workspaces/local/session-archive", {
      headers: { Authorization: `Bearer ${member.token}` },
    })).status).toBe(403);

    const invalid = await app.request("/api/workspaces/local/session-archive", {
      method: "PUT",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_ttl_ms: 3_600_000, gc_interval_ms: 30_000 }),
    });
    expect(invalid.status).toBe(400);

    const excessive = await app.request("/api/workspaces/local/session-archive", {
      method: "PUT",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_ttl_ms: 366 * 24 * 60 * 60 * 1000,
        gc_interval_ms: 60_000,
      }),
    });
    expect(excessive.status).toBe(400);

    const updated = await app.request("/api/workspaces/local/session-archive", {
      method: "PUT",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_ttl_ms: 7_200_000, gc_interval_ms: 120_000 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      config: {
        backend: "local",
        require_archive: true,
        workspace_ttl_ms: 7_200_000,
        gc_interval_ms: 120_000,
      },
      usage: { total_archives: 0, total_bytes: 0 },
      last_failure: null,
    });
    expect((store.getWorkspace("local")!.settings.session_archive as any)).toEqual({
      workspace_ttl_ms: 7_200_000,
      gc_interval_ms: 120_000,
    });
  });

  it("retains Runtime provenance without blocking Runtime deletion", async () => {
    const { store, runtime, issue, sessionArchives } = await fixture();
    const bytes = Buffer.from("historical provenance");
    const initialized = sessionArchives.initialize({
      workspaceId: "local",
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "provenance-v1",
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    });
    db!.exec("PRAGMA foreign_keys = ON");
    expect(db!.run("DELETE FROM multiremi_runtimes WHERE id = ?", [runtime.id]).changes).toBeGreaterThanOrEqual(1);
    expect(store.getSessionArchive(initialized.archive.id)).toMatchObject({
      runtimeId: runtime.id,
      status: "pending",
    });
  });

  it("lets a replacement Runtime adopt an incomplete idempotent upload", async () => {
    const { store, runtime, issue, sessionArchives } = await fixture();
    const bytes = Buffer.from("adopt after runtime loss");
    const input = {
      workspaceId: "local",
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "adopt-v1",
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    };
    const first = sessionArchives.initialize(input).archive;
    store.markSessionArchiveFailed(first.id, "runtime offline");
    const replacement = store.registerRuntime({
      id: "rt_archive_replacement",
      name: "replacement archive runtime",
      provider: "codex",
      daemonId: runtime.daemonId!,
      workspaceId: "local",
    });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: replacement.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const adopted = sessionArchives.initialize({
      ...input,
      runtimeId: replacement.id,
      daemonId: replacement.daemonId!,
    });
    expect(adopted.created).toBe(false);
    expect(adopted.archive).toMatchObject({
      id: first.id,
      runtimeId: replacement.id,
      daemonId: replacement.daemonId,
      status: "pending",
      lastError: null,
    });
  });

  it("prevents a superseded Runtime attempt from downgrading the replacement result", async () => {
    const { store, runtime, issue, sessionArchives } = await fixture();
    const bytes = Buffer.from("attempt ownership");
    const input = {
      workspaceId: "local",
      issueId: issue.id,
      runtimeId: runtime.id,
      daemonId: runtime.daemonId!,
      sourceRevision: "attempt-v1",
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    };
    const archive = sessionArchives.initialize(input).archive;
    const oldClaim = store.claimSessionArchiveUploadAttempt(archive.id, runtime.id)!;
    const oldAttempt = store.beginSessionArchiveUploadAttempt(
      archive.id,
      runtime.id,
      oldClaim.attemptCount,
    )!;
    expect(oldAttempt.attemptCount).toBe(1);

    const replacement = store.registerRuntime({
      id: "rt_archive_attempt_replacement",
      name: "replacement archive runtime",
      provider: "codex",
      daemonId: runtime.daemonId!,
      workspaceId: "local",
    });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: replacement.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const adopted = sessionArchives.initialize({
      ...input,
      runtimeId: replacement.id,
      daemonId: replacement.daemonId!,
    }).archive;
    expect(adopted).toMatchObject({ runtimeId: replacement.id, status: "pending" });

    const newClaim = store.claimSessionArchiveUploadAttempt(archive.id, replacement.id)!;
    const newAttempt = store.beginSessionArchiveUploadAttempt(
      archive.id,
      replacement.id,
      newClaim.attemptCount,
    )!;
    expect(newAttempt.attemptCount).toBe(2);
    expect(store.markSessionArchiveUploadedAttempt(
      archive.id,
      replacement.id,
      newAttempt.attemptCount,
      bytes.byteLength,
    )).not.toBeNull();
    expect(store.markSessionArchiveReadyAttempt(
      archive.id,
      replacement.id,
      newAttempt.attemptCount,
      bytes.byteLength,
    )).toMatchObject({ status: "ready", runtimeId: replacement.id });

    expect(store.markSessionArchiveFailedAttempt(
      archive.id,
      runtime.id,
      oldAttempt.attemptCount,
      "late old Runtime failure",
    )).toBeNull();
    expect(store.getSessionArchive(archive.id)).toMatchObject({
      status: "ready",
      runtimeId: replacement.id,
      attemptCount: 2,
      lastError: null,
    });
  });

  it("rejects another Runtime on the same daemon when it does not own the Issue workspace", async () => {
    const { store, app, issue, runtime, daemonHeaders } = await fixture();
    const sibling = store.registerRuntime({
      id: "rt_archive_sibling",
      name: "same-daemon sibling",
      provider: "claude",
      daemonId: runtime.daemonId,
      workspaceId: "local",
    });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const siblingBase = `/api/daemon/runtimes/${sibling.id}/issues/${issue.id}/session-archives`;
    const response = await app.request(`${siblingBase}/status`, {
      headers: { Authorization: daemonHeaders.Authorization },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "issue archive scope not found" });
  });

  it("rejects daemon archive operations when the Issue workspace is missing or unbound", async () => {
    const { store, app, issue, runtime, daemonHeaders, base } = await fixture();
    db!.run("DELETE FROM multiremi_issue_workspaces WHERE issue_id = ?", [issue.id]);
    for (const [path, method, body] of [
      [`${base}/status`, "GET", undefined],
      [`${base}/init`, "POST", JSON.stringify({
        source_revision: "missing-workspace",
        sha256: "0".repeat(64),
        size_bytes: 0,
      })],
      [`${base}/failure`, "POST", JSON.stringify({ stage: "prepare", error: "missing" })],
    ] as const) {
      const response = await app.request(path, { method, headers: daemonHeaders, body });
      expect(response.status).toBe(404);
    }

    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    db!.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL WHERE issue_id = ?", [issue.id]);
    expect((await app.request(`${base}/status`, { headers: daemonHeaders })).status).toBe(404);
  });
});
