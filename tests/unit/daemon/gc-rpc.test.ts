import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiDaemonClient, MultiremiDaemonHttpError } from "@multiremi/client.js";
import { DaemonProtocolRpcError } from "@multiremi/worker/daemon-protocol-client.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { SessionArchiveService } from "@multiremi/session-archive/service.js";
import { runWorkspaceGcOnce } from "@daemon/agent-runtime/workspace/gc.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { legacyGcHttp } from "../../fixtures/legacy-gc-http.js";
import { buildArchiveFixture } from "../multiremi/session-archive-fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
// Each parity case migrates a fresh SQLite store and awaits both HTTP and v2 RPC.
// Match the archive test budget so CI load cannot close the DB mid-request on timeout.
const GC_RPC_CASE_TIMEOUT_MS = 30_000;

async function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), "mul421-gc-rpc-"));
  const db = new Database(join(root, "store.db"));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "runtime", name: "GC", provider: "codex", daemonId: "daemon-gc" });
  const issue = store.createIssue({ title: "GC parity", workspaceId: "local" });
  const archives = new SessionArchiveService(store, { root: join(root, "archives"), minFreeBytes: 0 });
  const workspace = (runtimeId: string) => store.reportIssueWorkspace({ issueId: issue.id, runtimeId,
    rootPath: `/tmp/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
  let archive = { archiveId: "archive", sourceRevision: "revision", sha256: "a".repeat(64) };
  if (code === "issue_workspace_runtime_mismatch") {
    const sibling = store.registerRuntime({ name: "Sibling", provider: "claude", daemonId: "daemon-gc" });
    workspace(sibling.id);
  }
  if (code === "issue_workspace_archive_invalid") {
    workspace(runtime.id);
    // MUL-432: ingest only accepts a v2 session archive, so the physically
    // verified blob is a real (trace-less) v2 container.
    const blob = await buildArchiveFixture({ subject: { kind: "issue", id: issue.id } });
    const initialized = archives.initialize({ workspaceId: "local", subjectKind: "issue", subjectId: issue.id, issueId: issue.id, runtimeId: runtime.id,
      daemonId: "daemon-gc", sourceRevision: blob.sourceRevision, sha256: blob.sha256, sizeBytes: blob.sizeBytes }).archive;
    const claimed = await archives.claimUploadAttempt(runtime.id, issue.id, initialized.id);
    await archives.upload(runtime.id, issue.id, initialized.id, claimed.uploadAttempt!, new Response(blob.bytes).body);
    await archives.complete(runtime.id, issue.id, initialized.id, claimed.uploadAttempt!);
    archive = { archiveId: initialized.id, sourceRevision: blob.sourceRevision, sha256: "b".repeat(64) };
  }
  const issueId = code === "issue_not_found" ? "deleted-issue" : issue.id;
  const httpApp = legacyGcHttp(store, archives);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => httpApp.fetch(request) });
  const http = new MultiremiDaemonClient(`http://127.0.0.1:${server.port}`, "fixture");
  http.reportIssueWorkspaceCleaned = async (id, runtimeId, binding) => {
    await http["post"](`/api/daemon/issues/${encodeURIComponent(id)}/workspace/cleaned`, { runtime_id: runtimeId,
      archive_id: binding.archiveId, source_revision: binding.sourceRevision, sha256: binding.sha256 });
  };
  const rpc = new MultiremiDaemonClient("http://unused");
  const box = new MultiremiTaskReportOutbox({ path: join(root, "outbox.db"), canSend: () => false, deliver: async () => {} });
  box.enqueue(issueId, "complete", { runtime_id: runtime.id, output: "must remain pending" });
  rpc.setReportTransport({
    report: async () => { throw new Error("GC must not enter the report outbox"); },
    bestEffort: () => {}, upgradeWaiting: () => false,
    rpc: async (type, payload) => {
      const reply = await reportFrame(store, type, { runtime_id: runtime.id, ...payload }, { runtimeId: runtime.id, archives });
      if (reply.ok === false) throw new DaemonProtocolRpcError(reply.code, reply.retryable, reply.operation_error);
      return reply;
    },
  });
  cleanup.push(async () => {
    await box.close();
    await server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, runtime, issueId, archive, http, rpc, box };
}

async function errorOf(action: () => Promise<unknown>): Promise<MultiremiDaemonHttpError> {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(MultiremiDaemonHttpError);
    return error as MultiremiDaemonHttpError;
  }
  throw new Error("GC operation unexpectedly succeeded");
}

describe("GC RPC preserves HTTP operation errors without report partition handling", () => {
  for (const code of ["issue_not_found", "issue_workspace_not_found", "issue_workspace_runtime_mismatch", "issue_workspace_archive_invalid"]) {
    it(`makes the same GC receipt decision for HTTP and RPC: ${code}`, async () => {
      const f = await fixture(code);
      const invoke = (client: MultiremiDaemonClient) => client.reportIssueWorkspaceCleaned(f.issueId, f.runtime.id, f.archive);
      const previous = await errorOf(() => invoke(f.http));
      const current = await errorOf(() => invoke(f.rpc));
      expect(current.status).toBe(previous.status);
      expect(current.code).toBe(previous.code);
      expect(current.code).toBe(code);
      expect(JSON.parse(current.responseBody)).toEqual(JSON.parse(previous.responseBody));
      const decisions: Array<{ retained: boolean; errors: number }> = [];
      for (const [name, client] of [["http", f.http], ["rpc", f.rpc]] as const) {
        const root = join(f.root, name); mkdirSync(join(root, ".gc-cleaned-outbox"), { recursive: true });
        const receipt = join(root, ".gc-cleaned-outbox", "receipt.json");
        writeFileSync(receipt, JSON.stringify({ version: 2, issue_id: f.issueId, runtime_id: f.runtime.id,
          workspace_dir: join(root, "already-removed"), archive_id: f.archive.archiveId,
          source_revision: f.archive.sourceRevision, sha256: f.archive.sha256 }));
        const errors: unknown[] = [];
        expect(await runWorkspaceGcOnce({ root, ttlMs: 0, orphanTtlMs: 0, runtimeId: f.runtime.id, client,
          onError: (_path, error) => errors.push(error) })).toEqual({ cleaned: 0, orphaned: 0, skipped: 0 });
        decisions.push({ retained: existsSync(receipt), errors: errors.length });
      }
      expect(decisions[1]).toEqual(decisions[0]!);
      expect(decisions[1]).toEqual({ retained: code !== "issue_not_found", errors: code === "issue_not_found" ? 0 : 1 });
      expect(f.box.stats()).toMatchObject({ pending: 1, blocked: 0 });
      expect(f.box.pendingTaskIds()).toContain(f.issueId);
    }, GC_RPC_CASE_TIMEOUT_MS);
  }

  it("takes the existing generic status failure path when operation_error is absent", async () => {
    const client = new MultiremiDaemonClient("http://unused");
    client.setReportTransport({ report: async () => { throw new Error("no outbox"); }, bestEffort: () => {},
      upgradeWaiting: () => false, rpc: async () => { throw new DaemonProtocolRpcError("task_not_found", false); } });
    const error = await errorOf(() => client.reportIssueWorkspaceCleaned("issue", "runtime", {
      archiveId: "archive", sourceRevision: "revision", sha256: "a".repeat(64),
    }));
    expect(error).toMatchObject({ status: 404, code: null });
    expect(error.message).toContain("404");
  });
});
