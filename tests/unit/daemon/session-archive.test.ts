import { afterEach, describe, expect, it } from "bun:test";
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
import { gunzipSync } from "node:zlib";
import {
  prepareIssueSessionArchive,
  readIssueSessionArchiveReceipt,
  resolveSessionArchiveFileDescriptorPath,
  writeIssueSessionArchiveReceipt,
} from "@daemon/agent-runtime/workspace/session-archive.js";

describe("Issue session archive", () => {
  const roots: string[] = [];
  const supportedPlatformIt = process.platform === "linux" ? it : it.skip;

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses the native descriptor filesystem on supported daemon platforms", () => {
    expect(resolveSessionArchiveFileDescriptorPath(17, "linux")).toBe("/proc/self/fd/17");
    expect(() => resolveSessionArchiveFileDescriptorPath(17, "darwin")).toThrow("unsupported on darwin");
    expect(() => resolveSessionArchiveFileDescriptorPath(17, "win32")).toThrow("unsupported on win32");
  });

  it("fails closed instead of emitting an empty archive on unsupported platforms", async () => {
    if (process.platform === "linux") return;
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-unsupported-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "history.jsonl"), "{\"message\":\"must-not-be-lost\"}\n");

    await expect(prepareIssueSessionArchive(root)).rejects.toThrow(
      `unsupported on ${process.platform}`,
    );
    expect(() => readdirSync(join(root, ".multiremi", "archive-spool"))).toThrow();
  });

  supportedPlatformIt("archives provider history deterministically without credentials or config", async () => {
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

    const first = await prepareIssueSessionArchive(root);
    const second = await prepareIssueSessionArchive(root);

    expect(first.sourceRevision).toBe(second.sourceRevision);
    expect(first.sha256).toBe(second.sha256);
    expect(first.fileCount).toBe(3);
    const files = readTarGzip(first.archivePath);
    expect(files.get("sessions/ises_1/agt_1/1/home/projects/history.jsonl")?.toString()).toContain("hello");
    expect(files.get("sessions/ises_1/agt_1/1/home/state_5.sqlite")).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(files.get("sessions/ises_1/agt_1/1/meta.json")?.toString()).toContain("codex");
    expect([...files.keys()].some((path) => /auth\.json|config\.toml|settings\.json/.test(path))).toBe(false);
    expect(gunzipSync(readFileSync(first.archivePath)).toString()).not.toContain("DO_NOT_ARCHIVE");
  });

  supportedPlatformIt("refuses unexpected symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-link-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(home, "rollout.jsonl"));

    await expect(prepareIssueSessionArchive(root)).rejects.toThrow("Refusing to archive symlink");
  });

  supportedPlatformIt("enforces the source byte limit against bytes read from regular files", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-limit-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "rollout.jsonl"), "123456789");

    await expect(prepareIssueSessionArchive(root, { maxSourceBytes: 8 }))
      .rejects.toThrow("Issue session history exceeds 8 bytes");
  });

  supportedPlatformIt("rejects a snapshot when a provider adds history during archive creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-late-file-"));
    roots.push(root);
    const home = join(root, ".multiremi", "sessions", "ises_1", "agt_1", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "a-slow.jsonl"), Buffer.alloc(64 * 1024 * 1024, 0x61));

    const pending = prepareIssueSessionArchive(root);
    await waitForArchivePartial(join(root, ".multiremi", "archive-spool"));
    writeFileSync(join(home, "late.jsonl"), "{\"message\":\"late\"}\n");

    await expect(pending).rejects.toThrow("history changed while archiving");
  });

  supportedPlatformIt("rejects an intermediate directory replaced by a symlink while archiving", async () => {
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

    const pending = prepareIssueSessionArchive(root);
    await waitForArchivePartial(join(root, ".multiremi", "archive-spool"));
    renameSync(home, movedHome);
    symlinkSync(outside, home);

    await expect(pending).rejects.toThrow(/symlink|changed while archiving/);
  });

  supportedPlatformIt("refuses a symlink in the provider history parent path", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-parent-link-"));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-parent-outside-"));
    roots.push(outside);
    mkdirSync(join(outside, "sessions", "ises_1"), { recursive: true });
    writeFileSync(join(outside, "sessions", "ises_1", "history.jsonl"), "outside\n");
    symlinkSync(outside, join(root, ".multiremi"));

    await expect(prepareIssueSessionArchive(root)).rejects.toThrow("must not contain symlinks");
  });

  supportedPlatformIt("produces a valid empty archive when an Issue has no provider history", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiremi-session-archive-empty-"));
    roots.push(root);
    const archive = await prepareIssueSessionArchive(root);
    const files = readTarGzip(archive.archivePath);

    expect(archive.fileCount).toBe(0);
    expect(files.get("manifest.json")?.toString()).toContain("multiremi.issue-sessions.v1");
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

  supportedPlatformIt("rejects a staging directory symlink or non-directory", async () => {
    const symlinkRoot = mkdtempSync(join(tmpdir(), "multiremi-session-staging-link-"));
    roots.push(symlinkRoot);
    const outside = mkdtempSync(join(tmpdir(), "multiremi-session-staging-outside-"));
    roots.push(outside);
    mkdirSync(join(symlinkRoot, ".multiremi"), { recursive: true });
    symlinkSync(outside, join(symlinkRoot, ".multiremi", "archive-spool"));
    await expect(prepareIssueSessionArchive(symlinkRoot)).rejects.toThrow("must not contain symlinks");

    const fileRoot = mkdtempSync(join(tmpdir(), "multiremi-session-staging-file-"));
    roots.push(fileRoot);
    mkdirSync(join(fileRoot, ".multiremi"), { recursive: true });
    writeFileSync(join(fileRoot, ".multiremi", "archive-spool"), "not a directory");
    await expect(prepareIssueSessionArchive(fileRoot)).rejects.toThrow("non-directories");
  });
});

function readTarGzip(path: string): Map<string, Buffer> {
  const tar = gunzipSync(readFileSync(path));
  const files = new Map<string, Buffer>();
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const size = Number.parseInt(tarString(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (type === "x") {
      const record = body.toString("utf8");
      const match = record.match(/ path=([^\n]+)\n/);
      paxPath = match?.[1] ?? null;
    } else {
      files.set(paxPath ?? name, Buffer.from(body));
      paxPath = null;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function tarString(value: Buffer): string {
  const zero = value.indexOf(0);
  return value.subarray(0, zero >= 0 ? zero : value.length).toString("utf8");
}

async function waitForArchivePartial(spool: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    try {
      if (readdirSync(spool).some((name) => name.endsWith(".partial"))) return;
    } catch {
      // The initial source scan creates the spool only after it completes.
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for session archive creation to start");
}
