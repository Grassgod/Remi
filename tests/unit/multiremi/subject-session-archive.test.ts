import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MultiremiDaemonSessionArchiveStatus,
  MultiremiDaemonSessionArchiveWire,
} from "@multiremi/worker/client.js";
import {
  ensureSubjectSessionArchive,
  type EnsureSubjectSessionArchiveOptions,
  type SubjectSessionArchiveSubject,
} from "@multiremi/worker/subject-session-archive.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Chat and one-shot Task Session archive", () => {
  it("archives the subject's .runtime root once and removes the staged bytes", async () => {
    const root = tempRoot();
    const runtimeRoot = join(root, ".runtime", "tsk_one");
    mkdirSync(join(runtimeRoot, "agt_1", "1", "home"), { recursive: true });
    writeFileSync(join(runtimeRoot, "agt_1", "1", "home", "session.jsonl"), "{\"turn\":1}\n");
    const fake = fakeClient();

    const binding = await ensureSubjectSessionArchive(options(root, fake), { kind: "task", id: "tsk_one" }, runtimeRoot, false);

    expect(binding).toEqual({ archiveId: "sar_new", sourceRevision: fake.initialized[0]!.sourceRevision, sha256: fake.initialized[0]!.sha256 });
    expect(fake.subjects).toEqual(Array(fake.subjects.length).fill({ kind: "task", id: "tsk_one" }));
    expect(fake.initialized).toMatchObject([{ fileCount: 1, metadata: { source: ".runtime" } }]);
    expect(fake.uploaded).toHaveLength(1);
    expect(fake.uploadedExisted).toEqual([true]);
    expect(fake.completed).toEqual(["sar_new"]);
    expect(existsSync(fake.uploaded[0]!)).toBe(false);
    expect(readdirSync(join(runtimeRoot, ".multiremi", "archive-spool"))).toEqual([]);
  });

  it("reuses a ready archive of the same content without uploading again", async () => {
    const root = tempRoot();
    const runtimeRoot = join(root, ".runtime", "cs_same");
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, "history.jsonl"), "{}\n");
    const fake = fakeClient({ contentReady: true });

    const binding = await ensureSubjectSessionArchive(options(root, fake), { kind: "chat", id: "cs_same" }, runtimeRoot, true);

    expect(binding?.archiveId).toBe("sar_ready");
    expect(fake.verifyFlags).toEqual([false, true]);
    expect(fake.initialized).toEqual([]);
    expect(fake.uploaded).toEqual([]);
  });

  it("keeps the ready archive as the barrier once the .runtime root is gone", async () => {
    const root = tempRoot();
    const chatDir = join(root, "chats", "cs_gone");
    mkdirSync(chatDir, { recursive: true });
    const fake = fakeClient({ latestReady: wire("sar_history", "ready") });

    const binding = await ensureSubjectSessionArchive(options(root, fake), { kind: "chat", id: "cs_gone" }, chatDir, true);

    expect(binding).toEqual({ archiveId: "sar_history", sourceRevision: "c".repeat(64), sha256: "d".repeat(64) });
    expect(fake.requestedRevisions).toEqual([undefined, "c".repeat(64)]);
    expect(fake.verifyFlags).toEqual([false, true]);
    expect(fake.initialized).toEqual([]);
    expect(existsSync(join(chatDir, ".multiremi"))).toBe(false);
  });

  it("defers during archive retry backoff without preparing bytes", async () => {
    const root = tempRoot();
    const runtimeRoot = join(root, ".runtime", "tsk_backoff");
    mkdirSync(runtimeRoot, { recursive: true });
    const fake = fakeClient({ latest: { ...wire("sar_failed", "failed"), retry_state: "backoff" } });

    expect(await ensureSubjectSessionArchive(options(root, fake), { kind: "task", id: "tsk_backoff" }, runtimeRoot, true)).toBeNull();
    expect(fake.initialized).toEqual([]);
    expect(existsSync(join(runtimeRoot, ".multiremi"))).toBe(false);
  });

  it("returns no archive for a directory that is already gone", async () => {
    const root = tempRoot();
    const fake = fakeClient();

    expect(await ensureSubjectSessionArchive(options(root, fake), { kind: "task", id: "tsk_missing" }, join(root, "tasks", "tsk_missing"), true)).toBeNull();
    expect(fake.subjects).toEqual([]);
    expect(existsSync(join(root, "tasks"))).toBe(false);
  });

  it("returns no archive when the upload does not complete ready", async () => {
    const root = tempRoot();
    const runtimeRoot = join(root, ".runtime", "tsk_pending");
    mkdirSync(runtimeRoot, { recursive: true });
    const fake = fakeClient({ completeStatus: "uploading" });

    expect(await ensureSubjectSessionArchive(options(root, fake), { kind: "task", id: "tsk_pending" }, runtimeRoot, true)).toBeNull();
    expect(fake.completed).toEqual(["sar_new"]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-subject-archive-"));
  roots.push(root);
  return root;
}

function options(root: string, client: EnsureSubjectSessionArchiveOptions["client"]): EnsureSubjectSessionArchiveOptions {
  return { client, runtimeId: "rt_1", workspacesRoot: root, assertRootOwner: () => {} };
}

function wire(id: string, status: MultiremiDaemonSessionArchiveWire["status"]): MultiremiDaemonSessionArchiveWire {
  return { id, status, source_revision: "c".repeat(64), sha256: "d".repeat(64), size_bytes: 1 };
}

function fakeClient(config: {
  contentReady?: boolean;
  latest?: MultiremiDaemonSessionArchiveWire;
  latestReady?: MultiremiDaemonSessionArchiveWire;
  completeStatus?: MultiremiDaemonSessionArchiveWire["status"];
} = {}) {
  const state = {
    subjects: [] as SubjectSessionArchiveSubject[],
    requestedRevisions: [] as Array<string | undefined>,
    verifyFlags: [] as boolean[],
    initialized: [] as Array<{ sourceRevision: string; sha256: string; fileCount?: number | null; metadata?: Record<string, unknown> }>,
    uploaded: [] as string[],
    uploadedExisted: [] as boolean[],
    completed: [] as string[],
  };
  const client: EnsureSubjectSessionArchiveOptions["client"] = {
    async getSessionArchiveStatus(_runtimeId, subject, sourceRevision, sha256, verifyReady = false) {
      state.subjects.push(subject as SubjectSessionArchiveSubject);
      state.requestedRevisions.push(sourceRevision);
      state.verifyFlags.push(verifyReady);
      const status: MultiremiDaemonSessionArchiveStatus = {
        latest: config.latest ?? config.latestReady ?? null,
        latest_ready: config.latestReady ?? null,
        requested_ready: null,
        gc_ready: false,
      };
      if (!sourceRevision) return status;
      if (config.latestReady && sourceRevision === config.latestReady.source_revision) {
        return { ...status, requested_ready: config.latestReady, gc_ready: true };
      }
      if (config.contentReady) {
        const ready = { ...wire("sar_ready", "ready"), source_revision: sourceRevision, sha256: sha256! };
        return { ...status, requested_ready: ready, gc_ready: true };
      }
      return status;
    },
    async initSessionArchive(_runtimeId, subject, input) {
      state.subjects.push(subject as SubjectSessionArchiveSubject);
      state.initialized.push(input);
      return { archive: wire("sar_new", "pending"), upload_attempt: 1, upload_url: null };
    },
    async uploadSessionArchive(_runtimeId, subject, _archiveId, archivePath) {
      state.subjects.push(subject as SubjectSessionArchiveSubject);
      state.uploaded.push(archivePath);
      state.uploadedExisted.push(existsSync(archivePath));
      return wire("sar_new", "uploading");
    },
    async completeSessionArchive(_runtimeId, subject, archiveId) {
      state.subjects.push(subject as SubjectSessionArchiveSubject);
      state.completed.push(archiveId);
      return wire(archiveId, config.completeStatus ?? "ready");
    },
    async reportSessionArchiveFailure() {
      throw new Error("unexpected preparation failure");
    },
  };
  return Object.assign(client, state);
}
