import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const name = `mul405_select_lock_${process.pid}_${Date.now()}`;
let admin: InstanceType<typeof Bun.SQL>;
let db: PostgresSyncDatabase;
let observer: PostgresSyncDatabase;
const workspaceLock = "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ?";

function observeRowLock(table: "multiremi_issues" | "multiremi_workspaces", id: string) {
  return observer.transaction(() => observer.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE NOWAIT`).get(id))();
}

describe.skipIf(!adminUrl)("MUL-405 native PG locking SELECT", () => {
  beforeAll(async () => {
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    db = new PostgresSyncDatabase(url.toString());
    observer = new PostgresSyncDatabase(url.toString());
    db.exec("CREATE TABLE multiremi_workspaces (id TEXT PRIMARY KEY, updated_at TEXT); CREATE TABLE multiremi_issues (id TEXT PRIMARY KEY, workspace_id TEXT)");
    db.run("INSERT INTO multiremi_workspaces VALUES ('workspace', 'original')");
    db.run("INSERT INTO multiremi_issues VALUES ('issue', 'workspace')");
  });

  afterAll(async () => {
    db?.close();
    observer?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  for (const clause of ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"]) {
    it(`negative control: ${clause} before W is rejected after the row lock is confirmed`, () => {
      let rowLockConfirmed = false;
      expect(() => db.transaction(() => {
        expect(db.query(`SELECT id FROM multiremi_issues WHERE id = ? ${clause}`).get("issue")?.id).toBe("issue");
        // Reuse QA's independent NOWAIT proof, rather than trusting the classifier.
        expect(() => observeRowLock("multiremi_issues", "issue"))
          .toThrow("could not obtain lock on row");
        rowLockConfirmed = true;
        db.run(workspaceLock, "workspace");
      })()).toThrow("MUL-405 lock order violated");
      expect(rowLockConfirmed).toBe(true);
      expect(observeRowLock("multiremi_issues", "issue")?.id).toBe("issue");
    });

    it(`positive control: W before ${clause} commits and releases the row lock`, () => {
      expect(() => db.transaction(() => {
        db.run(workspaceLock, "workspace");
        expect(db.query(`SELECT id FROM multiremi_issues WHERE id = ? ${clause}`).get("issue")?.id).toBe("issue");
        expect(() => observeRowLock("multiremi_issues", "issue"))
          .toThrow("could not obtain lock on row");
      })()).not.toThrow();
      expect(observeRowLock("multiremi_issues", "issue")?.id).toBe("issue");
    });
  }

  it("OF locks only the named alias: reading a joined workspace does not take W", () => {
    expect(() => db.transaction(() => {
      db.query(`SELECT i.id FROM multiremi_issues i
        JOIN multiremi_workspaces w ON w.id = i.workspace_id FOR UPDATE OF i SKIP LOCKED`).get();
      expect(observeRowLock("multiremi_workspaces", "workspace")?.id).toBe("workspace");
      db.run(workspaceLock, "workspace");
    })()).toThrow("MUL-405 lock order violated");
  });

  it("OF workspace takes W without a D lock on the joined Issue", () => {
    expect(() => db.transaction(() => {
      db.query(`SELECT i.id FROM multiremi_issues i
        JOIN multiremi_workspaces w ON w.id = i.workspace_id FOR UPDATE OF w NOWAIT`).get();
      expect(observeRowLock("multiremi_issues", "issue")?.id).toBe("issue");
      db.advisoryXactLock("multiremi:number:select-lock-control");
    })()).not.toThrow();
  });
});
