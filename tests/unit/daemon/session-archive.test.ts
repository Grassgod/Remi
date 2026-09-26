import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import {
  assertTraversalSupported,
  prepareIssueSessionArchive,
  prepareSessionArchive,
  readIssueSessionArchiveReceipt,
  writeIssueSessionArchiveReceipt,
} from "@daemon/agent-runtime/workspace/session-archive.js";
import { readZipCentralDirectory, readZipMemberBody } from "@shared/zip/reader.js";
import { traceFileBody } from "../../unit/multiremi/session-archive-fixtures.js";
import {
  SESSION_ARCHIVE_INDEX_MEMBER,
  SESSION_ARCHIVE_V2_FORMAT,
  type SessionArchiveIndex,
} from "@multiremi/contracts/session-archive.js";

interface ArchiveContents {
  members: Map<string, Buffer>;
  index: SessionArchiveIndex;
  bytes: Buffer;
}

async function readArchive(path: string): Promise<ArchiveContents> {
  const bytes = readFileSync(path);
  const handle = await open(path, "r");
  try {
    const directory = await readZipCentralDirectory(handle);
    const members = new Map<string, Buffer>();
    for (const entry of directory.entries) {
      const member = await readZipMemberBody(handle, {
        dataOffset: entry.dataOffset,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
      });
      members.set(entry.path, member.bytes);
    }
    const index = JSON.parse(members.get(SESSION_ARCHIVE_INDEX_MEMBER)!.toString("utf8")) as SessionArchiveIndex;
    return { members, index, bytes };
  } finally {
    await handle.close();
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Session archive v2 writer", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects Windows, where a junction is not reported as a symlink", () => {
    expect(() => assertTraversalSupported("win32")).toThrow("unsupported on win32");
    expect(() => assertTraversalSupported("linux")).not.toThrow();
    expect(() => assertTraversalSupported("darwin")).not.toThrow();
  });

  it("archives legacy Issue sessions deterministically without credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(join(home, "projects"), { recursive: true });
    writeFileSync(join(home, "projects", "history.jsonl"), "{\"message\":\"hello\"}\n");
    writeFileSync(join(home, "state_5.sqlite"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(home, "auth.json"), "DO_NOT_ARCHIVE");
    writeFileSync(join(home, "config.toml"), "secret = 'DO_NOT_ARCHIVE'");
    writeFileSync(join(home, "settings.json"), "{\"token\":\"DO_NOT_ARCHIVE\"}");
    writeFileSync(join(dirname(home), "meta.json"), "{\"provider\":\"codex\"}\n");

    const first = await prepareIssueSessionArchive(root, { issueId: "iss_1" });
    const second = await prepareIssueSessionArchive(root, { issueId: "iss_1" });

    expect(first.sourceRevision).toBe(second.sourceRevision);
    expect(first.sha256).toBe(second.sha256);
    expect(first.fileCount).toBe(3);
    expect(first.metadata.format).toBe(SESSION_ARCHIVE_V2_FORMAT);
    expect(first.metadata.subject).toEqual({ kind: "issue", id: "iss_1" });
    const archive = await readArchive(first.archivePath);
    expect(archive.members.get("manifest.json")?.toString()).toContain(SESSION_ARCHIVE_V2_FORMAT);
    expect(archive.members.get("sessions/ises_1/agt_1/1/home/projects/history.jsonl")?.toString())
      .toContain("hello");
    expect(archive.members.get("sessions/ises_1/agt_1/1/home/state_5.sqlite")).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(archive.members.get("sessions/ises_1/agt_1/1/meta.json")?.toString()).toContain("codex");
    expect([...archive.members.keys()].some((path) => /auth\.json|config\.toml|settings\.json/.test(path))).toBe(false);
    expect(archive.bytes.toString("latin1")).not.toContain("DO_NOT_ARCHIVE");
  });

  it("records offsets, sizes and digests in index.json that match the container", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-index-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "big.jsonl"), "x".repeat(200_000));
    writeFileSync(join(home, "empty.txt"), "");

    const prepared = await prepareIssueSessionArchive(root, { issueId: "iss_1" });
    const archive = await readArchive(prepared.archivePath);
    const zipEntries = new Map(archive.index.members.map((entry) => [entry.path, entry]));
    expect(archive.index.format).toBe(SESSION_ARCHIVE_V2_FORMAT);
    expect(archive.index.subject).toEqual({ kind: "issue", id: "iss_1" });
    // index.json is the last member, manifest.json the first.
    expect([...archive.members.keys()].at(0)).toBe("manifest.json");
    expect([...archive.members.keys()].at(-1)).toBe("index.json");

    const handle = await open(prepared.archivePath, "r");
    try {
      const directory = await readZipCentralDirectory(handle);
      // index.json is the one member the index cannot describe: its own record
      // would have to contain the size of the bytes that describe it.
      expect(zipEntries.has("index.json")).toBe(false);
      expect(directory.entries.length).toBe(zipEntries.size + 1);
      for (const entry of directory.entries) {
        if (entry.path === "index.json") continue;
        const indexed = zipEntries.get(entry.path);
        expect(indexed).toBeDefined();
        expect(indexed!.local_header_offset).toBe(entry.localHeaderOffset);
        expect(indexed!.data_offset).toBe(entry.dataOffset);
        expect(indexed!.compressed_size).toBe(entry.compressedSize);
        expect(indexed!.uncompressed_size).toBe(entry.uncompressedSize);
        expect(indexed!.sha256).toBe(sha256(archive.members.get(entry.path)!));
      }
    } finally {
      await handle.close();
    }

    // A single trace member read must not exceed its compressed size plus 64 KiB.
    const traceMember = { path: "sessions/ises_1/agt_1/1/home/big.jsonl" };
    const big = archive.index.members.find((entry) => entry.path === traceMember.path)!;
    const handle2 = await open(prepared.archivePath, "r");
    try {
      const read = await readZipMemberBody(handle2, {
        dataOffset: big.data_offset,
        compressedSize: big.compressed_size,
        uncompressedSize: big.uncompressed_size,
        sha256: big.sha256,
      });
      expect(read.bytesRead).toBe(big.compressed_size);
      expect(read.bytesRead).toBeLessThanOrEqual(big.compressed_size + 64 * 1024);
    } finally {
      await handle2.close();
    }
  });

  it("hoists per-session traces to archive-level trace members with task ids", async () => {
    const storage = mkdtempSync(join(tmpdir(), "multiremi-runtime-session-archive-"));
    roots.push(storage);
    const issueRoot = join(storage, "issues", "MUL-2");
    const sessionRoot = join(storage, ".runtime", "ises_2");
    const home = join(sessionRoot, "agt_2", "4", "home");
    mkdirSync(issueRoot, { recursive: true });
    mkdirSync(join(home, "projects"), { recursive: true });
    mkdirSync(join(sessionRoot, "traces"), { recursive: true });
    mkdirSync(join(sessionRoot, ".multiremi"), { recursive: true });
    writeFileSync(join(home, "projects", "history.jsonl"), "{\"message\":\"runtime\"}\n");
    writeFileSync(join(home, "settings.json"), "DO_NOT_ARCHIVE");
    // Ruled trace shape: header and trailer carry no seq, events start at 1.
    writeFileSync(
      join(sessionRoot, "traces", "tsk_a.jsonl"),
      traceFileBody({ events: 3, taskId: "tsk_a" }),
    );
    writeFileSync(
      join(sessionRoot, "traces", "tsk_b.jsonl"),
      traceFileBody({ events: 2, taskId: "tsk_b", closed: false }),
    );
    const claudeCredentials = join(storage, "claude-credentials.json");
    writeFileSync(claudeCredentials, "CLAUDE_CREDENTIALS_MUST_NOT_BE_ARCHIVED");
    symlinkSync(claudeCredentials, join(home, ".credentials.json"));
    writeFileSync(join(sessionRoot, ".multiremi", "gc.json"), "DO_NOT_ARCHIVE");

    const prepared = await prepareIssueSessionArchive(issueRoot, {
      issueId: "iss_2",
      sessionRoots: [{ sessionId: "ises_2", root: sessionRoot }],
      sessionRootBoundary: storage,
    });
    const archive = await readArchive(prepared.archivePath);

    expect(archive.members.get("sessions/ises_2/agt_2/4/home/projects/history.jsonl")?.toString())
      .toContain("runtime");
    expect(archive.members.has("sessions/ises_2/traces/tsk_a.jsonl")).toBe(false);
    expect(archive.members.get("traces/tsk_a.jsonl")?.toString())
      .toBe(traceFileBody({ events: 3, taskId: "tsk_a" }));
    expect(archive.members.get("traces/tsk_b.jsonl")?.toString())
      .toBe(traceFileBody({ events: 2, taskId: "tsk_b", closed: false }));
    const traces = archive.index.members.filter((entry) => entry.kind === "trace");
    expect(traces.map((entry) => entry.task_id).sort()).toEqual(["tsk_a", "tsk_b"]);
    expect(prepared.traceCount).toBe(2);
    // The index records each trace's facts so readers and pointer writes need
    // no extra inflate: three events, sealed; the unsealed one is not closed.
    expect(traces.find((entry) => entry.task_id === "tsk_a"))
      .toMatchObject({ head: 3, event_count: 3, closed: true });
    expect(traces.find((entry) => entry.task_id === "tsk_b"))
      .toMatchObject({ head: 2, event_count: 2, closed: false });
    expect([...archive.members.keys()].some((path) => /\.credentials\.json|settings\.json|gc\.json/.test(path)))
      .toBe(false);
  });

  it("supports chat and one-shot task subjects", async () => {
    const storage = mkdtempSync(join(tmpdir(), "multiremi-subject-archive-"));
    roots.push(storage);
    const chatRoot = join(storage, ".runtime", "chat_1");
    const taskRoot = join(storage, ".runtime", "tsk_1");
    const workspaceRoot = join(storage, "issues", "MUL-3");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(join(chatRoot, "traces"), { recursive: true });
    mkdirSync(join(chatRoot, "agt_1", "1", "home"), { recursive: true });
    mkdirSync(join(taskRoot, "traces"), { recursive: true });
    writeFileSync(join(chatRoot, "traces", "tsk_chat.jsonl"), "{\"seq\":0}\n");
    writeFileSync(join(chatRoot, "agt_1", "1", "home", "history.jsonl"), "chat history\n");
    writeFileSync(join(taskRoot, "traces", "tsk_1.jsonl"), "{\"seq\":0}\n");

    const chat = await prepareSessionArchive(workspaceRoot, {
      subject: { kind: "chat", id: "chat_1" },
      providerRoots: [{ sessionId: "chat_1", root: chatRoot }],
      storageBoundary: storage,
    });
    const task = await prepareSessionArchive(workspaceRoot, {
      subject: { kind: "task", id: "tsk_1" },
      providerRoots: [{ sessionId: "tsk_1", root: taskRoot }],
      storageBoundary: storage,
    });
    const chatArchive = await readArchive(chat.archivePath);
    const taskArchive = await readArchive(task.archivePath);

    expect(chatArchive.index.subject).toEqual({ kind: "chat", id: "chat_1" });
    expect(chatArchive.index.members.find((entry) => entry.kind === "trace")?.task_id).toBe("tsk_chat");
    expect(taskArchive.index.subject).toEqual({ kind: "task", id: "tsk_1" });
    expect(taskArchive.index.members.find((entry) => entry.kind === "trace")?.task_id).toBe("tsk_1");
    expect(taskArchive.members.get("traces/tsk_1.jsonl")?.toString()).toBe("{\"seq\":0}\n");
  });

  it("refuses unexpected symlinks in provider history", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-link-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(home, "rollout.jsonl"));

    await expect(prepareIssueSessionArchive(root, { issueId: "iss_1" }))
      .rejects.toThrow("Refusing to archive symlink");
  });

  it("enforces the source byte limit against bytes read from regular files", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-limit-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "rollout.jsonl"), "123456789");

    await expect(prepareIssueSessionArchive(root, { issueId: "iss_1", maxSourceBytes: 8 }))
      .rejects.toThrow("exceed 8 bytes");
  });

  it("detects a file added while the archive is being written", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-late-file-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "a-slow.jsonl"), Buffer.alloc(64 * 1024 * 1024, 0x61));

    const pending = prepareIssueSessionArchive(root, { issueId: "iss_1" });
    await waitForArchivePartial(join(root, ".multiremi", "archive-spool"));
    writeFileSync(join(home, "late.jsonl"), "{\"message\":\"late\"}\n");

    await expect(pending).rejects.toThrow("changed while");
  });

  it("detects a file modified while the archive is being written", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-modified-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    const target = join(home, "a-slow.jsonl");
    writeFileSync(target, Buffer.alloc(64 * 1024 * 1024, 0x61));

    const pending = prepareIssueSessionArchive(root, { issueId: "iss_1" });
    await waitForArchivePartial(join(root, ".multiremi", "archive-spool"));
    writeFileSync(target, Buffer.alloc(64 * 1024 * 1024, 0x62));

    await expect(pending).rejects.toThrow("changed while");
  });

  it("rejects an intermediate directory replaced by a symlink while archiving", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-parent-race-"));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-archive-parent-race-outside-"));
    roots.push(outside);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    const movedHome = `${home}-moved`;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "a-slow.jsonl"), Buffer.alloc(64 * 1024 * 1024, 0x61));
    writeFileSync(join(home, "z-history.jsonl"), "inside\n");
    writeFileSync(join(outside, "a-slow.jsonl"), "outside\n");
    writeFileSync(join(outside, "z-history.jsonl"), "outside-secret\n");

    const pending = prepareIssueSessionArchive(root, { issueId: "iss_1" });
    await waitForArchivePartial(join(root, ".multiremi", "archive-spool"));
    renameSync(home, movedHome);
    symlinkSync(outside, home);

    await expect(pending).rejects.toThrow(/symlink|changed while/);
  });

  it("refuses a symlink in the legacy sessions parent path", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-parent-link-"));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-parent-outside-"));
    roots.push(outside);
    mkdirSync(join(outside, "sessions", "ises_1"), { recursive: true });
    writeFileSync(join(outside, "sessions", "ises_1", "history.jsonl"), "outside\n");
    symlinkSync(outside, join(root, ".multiremi"));

    await expect(prepareIssueSessionArchive(root, { issueId: "iss_1" }))
      .rejects.toThrow("must not contain symlinks");
  });

  it("produces a valid empty archive when a subject has no history", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-empty-"));
    roots.push(root);
    const prepared = await prepareIssueSessionArchive(root, { issueId: "iss_1" });
    const archive = await readArchive(prepared.archivePath);

    expect(prepared.fileCount).toBe(0);
    expect(prepared.traceCount).toBe(0);
    expect(archive.members.get("manifest.json")?.toString()).toContain(SESSION_ARCHIVE_V2_FORMAT);
    expect([...archive.members.keys()]).toEqual(["manifest.json", "index.json"]);
    // The index describes the manifest; it cannot describe its own bytes.
    expect(archive.index.members.map((entry) => entry.path)).toEqual(["manifest.json"]);
  });

  it("persists and reads an atomic server-verified receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-receipt-"));
    roots.push(root);
    const digest = "a".repeat(64);
    await writeIssueSessionArchiveReceipt(root, {
      issueId: "iss_1",
      sourceRevision: digest,
      sha256: "b".repeat(64),
      archiveId: "isar_1",
      archivedAt: "2026-08-19T00:00:00.000Z",
    });

    expect(await readIssueSessionArchiveReceipt(root)).toEqual({
      version: 1,
      issueId: "iss_1",
      sourceRevision: digest,
      sha256: "b".repeat(64),
      archiveId: "isar_1",
      archivedAt: "2026-08-19T00:00:00.000Z",
    });
  });

  it("rejects a staging directory symlink or non-directory", async () => {
    const symlinkRoot = mkdtempSync(join(tmpdir(), "multiremi-session-staging-link-"));
    roots.push(symlinkRoot);
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-staging-outside-"));
    roots.push(outside);
    mkdirSync(join(symlinkRoot, ".multiremi"), { recursive: true });
    symlinkSync(outside, join(symlinkRoot, ".multiremi", "archive-spool"));
    await expect(prepareIssueSessionArchive(symlinkRoot, { issueId: "iss_1" }))
      .rejects.toThrow("must not contain symlinks");

    const fileRoot = mkdtempSync(join(tmpdir(), "multiremi-session-staging-file-"));
    roots.push(fileRoot);
    mkdirSync(join(fileRoot, ".multiremi"), { recursive: true });
    writeFileSync(join(fileRoot, ".multiremi", "archive-spool"), "not a directory");
    await expect(prepareIssueSessionArchive(fileRoot, { issueId: "iss_1" }))
      .rejects.toThrow("non-directories");
  });
});

async function waitForArchivePartial(spool: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    try {
      if (readdirSync(spool).some((name) => name.endsWith(".partial"))) return;
    } catch {
      // The spool directory only appears once the initial scan finishes.
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the session archive writer to start");
}
