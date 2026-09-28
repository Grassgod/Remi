import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase, type SqlDatabase, type SqlStatement } from "@multiremi/store/db/postgres.js";

export const STATUS_PAGE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];

export class StatusPagesProbe implements SqlDatabase {
  readonly dialect: SqlDatabase["dialect"];
  statements: string[] = [];
  dbMs = 0;
  bytes = 0;
  afterRead?: (sql: string) => void;
  constructor(readonly inner: SqlDatabase) { this.dialect = inner.dialect ?? "sqlite"; }
  get inTransaction() { return this.inner.inTransaction; }
  reset() { this.statements = []; this.dbMs = 0; this.bytes = 0; }
  private measure<T>(sql: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    this.dbMs += performance.now() - start;
    this.statements.push(sql);
    if (result != null) this.bytes += Buffer.byteLength(JSON.stringify(result));
    if (/^\s*SELECT/i.test(sql)) this.afterRead?.(sql);
    return result;
  }
  private wrap(sql: string, statement: SqlStatement): SqlStatement {
    return {
      all: (...args) => this.measure(sql, () => statement.all(...args)),
      get: (...args) => this.measure(sql, () => statement.get(...args)),
      run: (...args) => this.measure(sql, () => statement.run(...args)),
      values: (...args) => this.measure(sql, () => statement.values(...args)),
    };
  }
  query(sql: string) { return this.wrap(sql, this.inner.query(sql)); }
  prepare(sql: string) { return this.wrap(sql, this.inner.prepare(sql)); }
  run(sql: string, ...args: unknown[]) { return this.measure(sql, () => this.inner.run(sql, ...args)); }
  exec(sql: string) { this.measure(sql, () => this.inner.exec(sql)); }
  transaction<T>(fn: (...args: any[]) => T) {
    return this.inner.transaction((...args: any[]) => {
      this.statements.push("BEGIN");
      try { return fn(...args); } finally { this.statements.push("COMMIT"); }
    });
  }
  close() { this.inner.close(); }
}

export async function createStatusPagesHarness(pgUrl?: string) {
  let cleanup = async () => {};
  let writer: () => SqlDatabase;
  let db: SqlDatabase;
  if (pgUrl) {
    const name = `mul395_status_pages_${process.pid}_${Math.floor(Math.random() * 1e8)}`;
    const admin = new Bun.SQL(pgUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(pgUrl);
    url.pathname = `/${name}`;
    db = new PostgresSyncDatabase(url.toString());
    writer = () => new PostgresSyncDatabase(url.toString());
    cleanup = async () => {
      const admin = new Bun.SQL(pgUrl, { max: 1 });
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    };
  } else {
    const directory = mkdtempSync(join(tmpdir(), "mul395-status-pages-"));
    const path = join(directory, "fixture.sqlite");
    const sqlite = new Database(path);
    sqlite.exec("PRAGMA journal_mode = WAL");
    db = sqlite as unknown as SqlDatabase;
    writer = () => new Database(path) as unknown as SqlDatabase;
    cleanup = async () => { rmSync(directory, { recursive: true, force: true }); };
  }
  const probe = new StatusPagesProbe(db);
  const store = new MultiremiStore(probe);
  store.ensureLocalWorkspace();
  store.createWorkspace({ id: "foreign", name: "Invisible workspace" });
  const reader = store.getOrCreateUser({ externalId: "mul395-status-reader", name: "Status reader", email: "status-reader@example.test" });
  const memberId = `mem_local_${reader.id}`;
  store.createWorkspaceMember({ id: memberId, workspaceId: "local", userId: reader.id, name: reader.name, role: "member" });
  store.createAgent({ id: "agt_status_pages", name: "Status agent", provider: "codex", workspaceId: "local" });
  const insert = db.query(`INSERT INTO multiremi_issues
    (id, issue_key, title, description, status, priority, workspace_id, project_id, assignee_type, assignee_id,
     created_by, metadata, created_at, updated_at, archived_at, parent_issue_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seed = (prefix: string, project: string | null, count: number, workspace = "local", archived = false, tied = false) => {
    for (const status of STATUS_PAGE_STATUSES) {
      for (let index = 0; index < count; index++) {
        const id = `iss_${prefix}_${status}_${index}`;
        const stamp = new Date(Date.UTC(2026, 8, 20) + (tied ? 0 : index * 1000)).toISOString();
        const agent = index % 2 === 1;
        const noAssignee = index % 11 === 10;
        insert.run(id, `FIX-${prefix}-${status}-${index}`, `${prefix} ${status} ${index}`, "fixture description".repeat(20),
          status, index % 3 === 0 ? "high" : "none", workspace, project,
          noAssignee ? null : agent ? "agent" : "member", noAssignee ? null : agent ? "agt_status_pages" : memberId,
          reader.id, JSON.stringify({ lane: index % 3, reviewed: index % 2 === 0 }), stamp, stamp,
          archived ? stamp : null, index % 5 === 0 ? "iss_parent_status" : null);
      }
    }
  };
  db.transaction(() => {
    seed("primary", "prj_status_primary", 120);
    seed("other", "prj_status_other", 60);
    seed("unprojected", null, 3);
    seed("ties", "prj_status_ties", 60, "local", false, true);
    for (const count of [1, 60, 300]) seed(`scale${count}`, `prj_status_scale${count}`, count);
    seed("archive", "prj_status_archive", 3, "local", true);
    seed("hidden", "prj_status_primary", 1, "foreign");
    db.run(`UPDATE multiremi_issues SET updated_at = ? WHERE workspace_id = ?`, "2099-01-01T00:00:00.000Z", "foreign");
    db.run(`INSERT INTO multiremi_issue_labels (id, workspace_id, name, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`, "lbl_status", "local", "Status label", "#00aa88", "2026-09-20", "2026-09-20");
    db.run(`INSERT INTO multiremi_issue_to_labels (issue_id, label_id)
      SELECT id, ? FROM multiremi_issues WHERE project_id = ?`, "lbl_status", "prj_status_primary");
  })();
  const app = createMultiremiApp({ store, authToken: "mul395-local-test" });
  const credential = await store.createAccessToken({ name: "Status pages fixture", type: "pat", userId: reader.id, workspaceId: "local", purpose: "session" });
  const headers = { Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": "local" };
  const request = async (path: string) => {
    probe.reset();
    const response = await app.request(path, { headers });
    const text = await response.text();
    return {
      status: response.status, text, body: JSON.parse(text) as any,
      dbq: probe.statements.length, dbMs: probe.dbMs, dbBytes: probe.bytes,
      responseBytes: Buffer.byteLength(text), timing: response.headers.get("server-timing"),
      statements: [...probe.statements],
    };
  };
  return { db, probe, store, app, headers, request, writer, memberId, userId: reader.id,
    async close() { db.close(); await cleanup(); } };
}
