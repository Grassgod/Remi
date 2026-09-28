import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { openHotspotDatabase } from "./first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "./first-screen-hotspots-fixture.js";
import { installFirstScreenHotspotIds } from "./first-screen-hotspots-normalize.js";

export function hotspotProbe() {
  return {
    statements: 0, bytes: 0, ms: 0,
    sql: [] as string[],
    reset() { this.statements = 0; this.bytes = 0; this.ms = 0; this.sql = []; },
  };
}

export function instrumentHotspotDatabase(raw: SqlDatabase, probe: ReturnType<typeof hotspotProbe>): SqlDatabase {
  const record = (sql: string, rows: unknown[], start: number) => {
    probe.statements += 1;
    probe.ms += performance.now() - start;
    probe.sql.push(sql.replace(/\s+/g, " ").trim());
    if (rows.length) probe.bytes += Buffer.byteLength(JSON.stringify({ rows, count: rows.length }));
  };
  const wrap = (statement: SqlStatement, sql: string) => new Proxy(statement, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (["get", "all", "run", "values"].includes(String(key))) return (...params: unknown[]) => {
        const start = performance.now();
        const result = value.apply(target, params);
        const rows = key === "get" ? (result == null ? [] : [result]) : key === "all" || key === "values" ? result : [];
        record(sql, rows, start);
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(raw, {
    get(target, key) {
      if (key === "query" || key === "prepare") return (sql: string) => wrap(target[key](sql), sql);
      if (key === "run" || key === "exec") return (sql: string, ...params: unknown[]) => {
        const start = performance.now();
        const result = (target[key] as Function).call(target, sql, ...params);
        record(sql, [], start);
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function createPr2Harness(options: { inboxRows?: number; runtimes?: number; foreignRuntimes?: number; attachmentBytes?: number } = {}) {
  const database = await openHotspotDatabase();
  const probe = hotspotProbe();
  const db = instrumentHotspotDatabase(database.db, probe);
  const store = new MultiremiStore(db);
  const fixture = seedFirstScreenHotspotsFixture(store, {
    inboxRows: options.inboxRows ?? 300,
    run: (sql, params) => { db.run(sql, ...params); },
  });
  // Older unread rows and archived rows distinguish a full summary from a page.
  for (const [index, type, issueId, read, archived, createdAt, details] of [
    [0, "issue_comment", null, 0, 0, "2026-09-01T12:00:00.000Z", null],
    [1, "autopilot_run_failed", null, 0, 1, "2026-09-26T14:00:00.000Z", null],
    [2, "autopilot_run_completed", null, 0, 0, "2026-09-25T01:00:00.000Z", '{"autopilot_id":"atp_date"}'],
    [3, "autopilot_run_completed", null, 1, 0, "2026-09-25T01:00:00.000Z", '{"autopilot_id":"atp_date"}'],
    [4, "autopilot_run_completed", null, 0, 0, "2026-09-22T12:00:00.000Z", '{"autopilot_id":"atp_date"}'],
    [5, "autopilot_run_completed", null, 0, 0, "2026-09-01T12:00:00.000Z", "invalid JSON"],
  ] as const) {
    db.run(`INSERT INTO multiremi_inbox_items
      (id, workspace_id, issue_id, member_id, recipient_type, recipient_id, severity, actor_type, type, title, body, details, read, archived, created_at)
      VALUES (?, 'local', ?, ?, 'member', ?, 'attention', 'system', ?, 'PR2 sentinel', '', ?, ?, ?, ?)`,
      `inb_pr2_sentinel_${index}`, issueId, fixture.readerMemberId, fixture.readerMemberId, type, details, read, archived, createdAt);
  }
  const other = store.createWorkspace({ id: "ws_pr2_foreign", name: "Foreign fleet", slug: "pr2-foreign" });
  const runtimeIds = [fixture.runtimeId];
  for (let index = 1; index < (options.runtimes ?? 20); index++) {
    const id = `rt_pr2_${index}`;
    store.registerRuntime({ id, name: `Runtime ${index}`, workspaceId: "local", provider: "codex", ownerId: fixture.readerUserId });
    store.updateRuntimeModels(id, [
      { id: "model-default", label: "Default model", provider: "codex", default: true },
      { id: "model-extra", label: "Extra model", provider: "codex", default: false },
    ]);
    // Existing tasks supply every status and usage format without inventing new tasks.
    const taskId = fixture.taskIds[index % fixture.taskIds.length]!;
    db.run("UPDATE multiremi_tasks SET runtime_id = ?, usage = ? WHERE id = ?", id,
      JSON.stringify([{ model: "model-default", input_tokens: index, output_tokens: index * 2 }]), taskId);
    runtimeIds.push(id);
  }
  for (let index = 0; index < (options.foreignRuntimes ?? 30); index++) {
    store.registerRuntime({ id: `rt_pr2_foreign_${index}`, name: `Foreign ${index}`, workspaceId: other.id, provider: "claude" });
    store.updateRuntimeModels(`rt_pr2_foreign_${index}`, [{ id: "foreign-model", label: "Foreign", provider: "claude", default: true }]);
  }
  const uploadRoot = mkdtempSync(join(tmpdir(), "mul473-pr2-upload-"));
  const previousUploadDir = process.env.MULTIREMI_UPLOAD_DIR;
  process.env.MULTIREMI_UPLOAD_DIR = uploadRoot;
  mkdirSync(join(uploadRoot, "local"));
  const attachmentId = "att_pr2_content";
  const privateAttachmentId = "att_pr2_private";
  const attachmentBytes = Buffer.alloc(options.attachmentBytes ?? 2048, 7);
  for (const id of [attachmentId, privateAttachmentId]) {
    store.createAttachment({ id, workspaceId: "local", issueId: fixture.issueIds[0],
      chatSessionId: id === privateAttachmentId ? fixture.sessionIds[0] : undefined,
      uploaderType: "member", uploaderId: fixture.readerUserId, filename: "hotspot.bin",
      url: `/api/attachments/${id}/content`, contentType: "application/octet-stream", sizeBytes: attachmentBytes.length });
    writeFileSync(join(uploadRoot, "local", `${id}.bin`), attachmentBytes, { flag: "wx" });
  }
  const viewer = store.getOrCreateUser({ externalId: "pr2-viewer", name: "Other member" });
  store.createWorkspaceMember({ id: `mem_local_${viewer.id}`, workspaceId: "local", userId: viewer.id, name: "Other member", role: "member" });
  const headersFor = async (userId: string) => {
    const credential = await store.createAccessToken({ name: "PR2 fixture", type: "pat", userId, workspaceId: "local" });
    return { Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": "local" };
  };
  const headers = await headersFor(fixture.readerUserId);
  const viewerHeaders = await headersFor(viewer.id);
  const app = createMultiremiApp({ store, authToken: "pr2-fixture-auth" });
  return {
    db, store, fixture, probe, app, headers, viewerHeaders, attachmentId, privateAttachmentId, attachmentBytes, runtimeIds,
    async dispose() {
      if (previousUploadDir === undefined) delete process.env.MULTIREMI_UPLOAD_DIR;
      else process.env.MULTIREMI_UPLOAD_DIR = previousUploadDir;
      rmSync(uploadRoot, { recursive: true, force: true });
      await database.dispose();
    },
  };
}

export type Pr2Harness = Awaited<ReturnType<typeof createPr2Harness>>;

export async function capturePr2QueryCounts() {
  const observations = [];
  for (const [inboxRows, runtimes, foreignRuntimes] of [[300, 1, 1], [600, 20, 30], [900, 60, 100]]) {
    const harness = await createPr2Harness({ inboxRows, runtimes, foreignRuntimes });
    try {
      const routes: Record<string, number> = {};
      for (const path of ["/api/inbox/summary", `/api/attachments/${harness.attachmentId}/content`, "/api/runtimes"]) {
        harness.probe.reset();
        const response = await harness.app.request(path, { headers: harness.headers });
        await response.arrayBuffer();
        if (response.status !== 200) throw new Error(`query golden: HTTP ${response.status}`);
        routes[path.replace(harness.attachmentId, ":id")] = harness.probe.statements;
        if (path === "/api/runtimes") {
          for (const table of ["multiremi_tasks", "multiremi_execution_group_members", "multiremi_runtime_models"]) {
            const reads = harness.probe.sql.filter(sql => sql.includes(`FROM ${table}`));
            if (reads.length !== 1) throw new Error(`${table}: expected one batch, got ${reads.length}`);
          }
        }
      }
      observations.push({ sessions: 50, agents: 20, inboxRows: inboxRows + 6, runtimes, foreignRuntimes, routes });
    } finally { await harness.dispose(); }
  }
  return observations;
}

export async function capturePr2Responses() {
  const restore = installFirstScreenHotspotIds();
  const harness = await createPr2Harness();
  try {
    const { app, headers, viewerHeaders, fixture } = harness;
    const json = async (path: string, requestHeaders: Record<string, string> = headers) => {
      const response = await app.request(path, { headers: requestHeaders });
      return { status: response.status, body: await response.text() };
    };
    const inbox = [];
    for (const offset of [0, 480, -300, 840]) inbox.push(await json(`/api/inbox/summary?timezone_offset=${offset}`));
    const response = await app.request(`/api/attachments/${harness.attachmentId}/content`, { headers });
    const attachment = { status: response.status,
      headers: Object.fromEntries(["content-type", "content-length", "content-disposition", "x-content-type-options"].map(key => [key, response.headers.get(key)])),
      body: Buffer.from(await response.arrayBuffer()).toString("base64") };
    const denied = await json(`/api/attachments/${harness.privateAttachmentId}/content`, {
      ...viewerHeaders, "If-None-Match": `"${harness.privateAttachmentId}"`,
    });
    const unauthorized = await json(`/api/attachments/${harness.attachmentId}/content`, {} as typeof headers);
    // Keep wire bodies as strings so key order and every response byte are checked.
    const runtimes = await json("/api/runtimes");
    const owned = await json("/api/runtimes?owner=me");
    const hydrated = harness.runtimeIds.map(id => harness.store.getRuntime(id));
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>"));
    return normalize({ source: "pre-PR2 main 7bd32800", fixture: { sessions: fixture.counts.sessions,
      agents: fixture.counts.agents, inboxRows: fixture.counts.inboxRows + 6 }, inbox, attachment, denied, unauthorized, runtimes, owned, hydrated });
  } finally { await harness.dispose(); restore(); }
}
