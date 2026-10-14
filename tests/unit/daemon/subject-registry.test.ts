import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryFile, registrySnapshotWikiDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import {
  deleteSubjectRecord,
  listSubjectRecords,
  readSubjectRecord,
  updateSubjectRecord,
  upsertSubjectRecord,
  writeSubjectRecord,
  type SubjectRecord,
} from "@daemon/agent-runtime/workspace/registry.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-registry-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const issue = { kind: "issue", id: "iss_1" } as const;

describe("subject registry", () => {
  test("first use creates an active record", () => {
    const root = tempRoot();
    const now = new Date("2026-10-13T00:00:00.000Z");
    const record = upsertSubjectRecord(root, { subject: issue, workspace_id: "local", issue_key: "MUL-1", now });
    expect(record).toEqual({
      version: 1, subject: issue, workspace_id: "local", issue_key: "MUL-1", external_work_dir: null, repos: [],
      state: "active", last_used_at: now.toISOString(), created_at: now.toISOString(), reclaimed_at: null, snapshot: null,
    });
    expect(readSubjectRecord(root, issue)).toEqual(record);
    expect(readdirSync(join(root, "registry"))).toEqual(["iss_1.json"]);
  });

  test("later use refreshes last_used_at and keeps what the caller did not mention", () => {
    const root = tempRoot();
    upsertSubjectRecord(root, {
      subject: issue, workspace_id: "local", issue_key: "MUL-1",
      repos: [{ repo_url: "https://example.test/a.git", dir: "a", branch: "agent/MUL-1" }],
      now: new Date("2026-10-13T00:00:00.000Z"),
    });
    const later = upsertSubjectRecord(root, { subject: issue, workspace_id: "local", now: new Date("2026-10-14T00:00:00.000Z") });
    expect(later.created_at).toBe("2026-10-13T00:00:00.000Z");
    expect(later.last_used_at).toBe("2026-10-14T00:00:00.000Z");
    expect(later.issue_key).toBe("MUL-1");
    expect(later.repos).toHaveLength(1);
  });

  test("an update applies to the record as it is now and does nothing for an unknown subject", () => {
    const root = tempRoot();
    expect(updateSubjectRecord(root, issue, (current) => ({ ...current, state: "reclaimed" }))).toBeNull();
    upsertSubjectRecord(root, { subject: issue, workspace_id: "local", now: new Date("2026-10-13T00:00:00.000Z") });
    // Another writer refreshed the record after the caller last looked at it.
    upsertSubjectRecord(root, { subject: issue, workspace_id: "local", now: new Date("2026-10-14T00:00:00.000Z") });

    const updated = updateSubjectRecord(root, issue, (current) => ({ ...current, state: "reclaimed" }));

    expect(updated).toMatchObject({ state: "reclaimed", last_used_at: "2026-10-14T00:00:00.000Z" });
    expect(readSubjectRecord(root, issue)).toEqual(updated);
  });

  test("upsert never changes state or snapshot, which belong to reclaim", () => {
    const root = tempRoot();
    const first = upsertSubjectRecord(root, { subject: issue, workspace_id: "local" });
    const snapshot = { created_at: "2026-10-13T00:00:00.000Z", git: [], wiki_files: 2 };
    writeSubjectRecord(root, { ...first, state: "reclaimed", reclaimed_at: "2026-10-13T00:00:00.000Z", snapshot });
    const touched = upsertSubjectRecord(root, { subject: issue, workspace_id: "local" });
    expect(touched.state).toBe("reclaimed");
    expect(touched.snapshot).toEqual(snapshot);
  });

  test("an external directory is recorded and can be cleared", () => {
    const root = tempRoot();
    const chat = { kind: "chat", id: "chat_1" } as const;
    expect(upsertSubjectRecord(root, { subject: chat, workspace_id: "local", external_work_dir: "/users/me/project" }).external_work_dir)
      .toBe("/users/me/project");
    expect(upsertSubjectRecord(root, { subject: chat, workspace_id: "local" }).external_work_dir).toBe("/users/me/project");
    expect(upsertSubjectRecord(root, { subject: chat, workspace_id: "local", external_work_dir: null }).external_work_dir).toBeNull();
  });

  test("list returns valid records in name order and reports unreadable ones", () => {
    const root = tempRoot();
    upsertSubjectRecord(root, { subject: { kind: "chat", id: "chat_b" }, workspace_id: "local" });
    upsertSubjectRecord(root, { subject: { kind: "chat", id: "chat_a" }, workspace_id: "local" });
    writeFileSync(join(root, "registry", "broken.json"), "{not json");
    writeFileSync(join(root, "registry", "stray.txt"), "ignored");
    const invalid: string[] = [];
    const records = listSubjectRecords(root, (path) => invalid.push(path));
    expect(records.map((record) => record.subject.id)).toEqual(["chat_a", "chat_b"]);
    expect(invalid).toEqual([join(root, "registry", "broken.json")]);
  });

  test("a missing registry lists nothing and reads null", () => {
    const root = tempRoot();
    expect(listSubjectRecords(root)).toEqual([]);
    expect(readSubjectRecord(root, issue)).toBeNull();
  });

  test("a corrupt record is an error rather than a silent reset", () => {
    const root = tempRoot();
    mkdirSync(join(root, "registry"));
    writeFileSync(registryFile(root, issue), JSON.stringify({ version: 2 }));
    expect(() => readSubjectRecord(root, issue)).toThrow(/unsupported version/);
    writeFileSync(registryFile(root, issue), "{");
    expect(() => upsertSubjectRecord(root, { subject: issue, workspace_id: "local" })).toThrow(/not valid JSON/);
  });

  test("writes leave no temporary file behind", () => {
    const root = tempRoot();
    for (let i = 0; i < 5; i++) upsertSubjectRecord(root, { subject: issue, workspace_id: "local" });
    expect(readdirSync(join(root, "registry"))).toEqual(["iss_1.json"]);
  });

  test("delete removes the record together with its snapshot files", () => {
    const root = tempRoot();
    const record: SubjectRecord = upsertSubjectRecord(root, { subject: issue, workspace_id: "local" });
    const wiki = registrySnapshotWikiDirectory(root, issue);
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "page.md"), "saved\n");
    deleteSubjectRecord(root, record.subject);
    expect(existsSync(registryFile(root, issue))).toBe(false);
    expect(existsSync(join(root, "registry", "iss_1.snapshot"))).toBe(false);
    deleteSubjectRecord(root, record.subject);
  });
});
