import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { openRuntimeDownlinks } from "../../fixtures/runtime-downlinks.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const database = `mul419_downlinks_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
type Request = { id: string; status: string };
type Family = { kind: string; create(store: MultiremiStore, rt: string): Request;
  read(store: MultiremiStore, rt: string, id: string): Request | null;
  report(store: MultiremiStore, rt: string, id: string, status: "completed" | "failed"): unknown };
const families: Family[] = [
  { kind: "update", create: (store, rt) => store.createRuntimeUpdateRequest(rt, { targetVersion: "9.9.9" }),
    read: (store, rt, id) => store.getRuntimeUpdateRequest(rt, id),
    report: (store, rt, id, status) => store.reportRuntimeUpdateResult(rt, id, { status, error: "Duplicate must not win" }) },
  { kind: "model_list", create: (store, rt) => store.createRuntimeModelListRequest(rt),
    read: (store, rt, id) => store.getRuntimeModelListRequest(rt, id),
    report: (store, rt, id, status) => store.reportRuntimeModelListResult(rt, id, { status, models: [], error: "Duplicate must not win" }) },
  { kind: "command", create: (store, rt) => store.createRuntimeCommandRequest(rt, { command: "printf stable", args: [] }),
    read: (store, rt, id) => store.getRuntimeCommandRequest(rt, id),
    report: (store, rt, id, status) => store.reportRuntimeCommandResult(rt, id, { status, exitCode: 0, stdout: "stable", error: "Duplicate must not win" }) },
  { kind: "local_skills", create: (store, rt) => store.createRuntimeLocalSkillListRequest(rt, {}),
    read: (store, rt, id) => store.getRuntimeLocalSkillListRequest(rt, id),
    report: (store, rt, id, status) => store.reportRuntimeLocalSkillListResult(rt, id, { status, supported: true, skills: [], error: "Duplicate must not win" }) },
  { kind: "directory_scan", create: (store, rt) => store.createRuntimeDirectoryScanRequest(rt, { root: "/tmp" }),
    read: (store, rt, id) => store.getRuntimeDirectoryScanRequest(rt, id),
    report: (store, rt, id, status) => store.reportRuntimeDirectoryScanResult(rt, id, { status, supported: true, candidates: [], error: "Duplicate must not win" }) },
  { kind: "local_skill_import", create: (store, rt) => store.createRuntimeLocalSkillImportRequest(rt, { skillKey: "pg-skill" }),
    read: (store, rt, id) => store.getRuntimeLocalSkillImportRequest(rt, id),
    report: (store, rt, id, status) => store.reportRuntimeLocalSkillImportResult(rt, id, { status,
      skill: { name: "PG skill", content: "# PG skill", files: [{ path: "notes.md", content: "Notes" }] }, error: "Duplicate must not win" }) },
  { kind: "bot_menu", create: (store, rt) => store.createBotMenuPublishRequest(rt, { workspaceId: "local", config: { default: [] }, dryRun: true }),
    read: (store, rt, id) => store.getBotMenuPublishRequest(rt, id),
    report: (store, rt, id, status) => store.reportBotMenuPublishResult(rt, id, { status,
      result: { dryRun: true, defaultPublished: false, userMenuCount: 0 }, error: "Duplicate must not win" }) },
];

describe.skipIf(!adminUrl)("A-4 pending state machines on real PostgreSQL", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  beforeAll(async () => {
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
    const url = new URL(adminUrl!); url.pathname = `/${database}`;
    db = new PostgresSyncDatabase(url.toString()); store = new MultiremiStore(db); store.ensureLocalWorkspace();
  });
  afterAll(async () => {
    db?.close(); await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin?.end();
  });
  for (const family of families) it(`${family.kind}: pre-ACK pending, disconnect, replay, claim and one result`, async () => {
    const rt = `rt_pg_downlink_${family.kind}`;
    store.registerRuntime({ id: rt, name: rt, provider: "claude", workspaceId: "local", daemonId: rt,
      ownerId: "local", metadata: { feishu_bot_menu: true, agent_plugin_protocol: 1 } });
    const request = family.create(store, rt);
    const first = await openRuntimeDownlinks(store, rt);
    try {
      const offer = first.frames.find(frame => frame.t === `runtime.${family.kind}` && frame.p.id === request.id)!;
      expect(offer).toBeDefined();
      expect(family.read(store, rt, request.id)?.status).toBe("pending");
      await first.close();
      expect(family.read(store, rt, request.id)?.status).toBe("pending");
      const second = await openRuntimeDownlinks(store, rt);
      try {
        const replay = second.frames.find(frame => frame.t === `runtime.${family.kind}` && frame.p.id === request.id)!;
        expect(replay.p).toEqual(offer.p);
        await second.ack(); await second.ack();
        expect(family.read(store, rt, request.id)?.status).toBe("running");
        family.report(store, rt, request.id, "completed");
        const settled = family.read(store, rt, request.id);
        expect(settled?.status).toBe("completed");
        family.report(store, rt, request.id, "failed");
        expect(family.read(store, rt, request.id)).toEqual(settled);
      } finally { await second.close(); }
    } finally { await first.close(); }
  });
});
