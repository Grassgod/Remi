import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { RelationLockInput } from "./fixtures/postgres-relation-lock-worker.js";

interface WorkerResult {
  phase: string;
  ok: boolean;
  error?: string;
  code?: string;
  maxTransactionDepth: number;
}

function phase(worker: Worker, wanted: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${wanted}`)); }, 30_000);
    const onMessage = ({ data }: MessageEvent<WorkerResult>) => {
      if (data.phase === "error") { cleanup(); reject(new Error(data.error)); }
      if (data.phase === wanted) { cleanup(); resolve(data); }
    };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message)); };
    function cleanup() {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  const pgUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
  describe.skipIf(backend === "PostgreSQL" && !pgUrl)(`MUL-476 relation locks (${backend})`, () => {
    let db: Database | PostgresSyncDatabase;
    let store: MultiremiStore;
    let admin: Bun.SQL | undefined;
    let databaseUrl = "";
    let serial = 0;
    const databaseName = `mul476_locks_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

    beforeAll(async () => {
      if (backend === "PostgreSQL") {
        admin = new Bun.SQL(pgUrl!, { max: 1 });
        await admin.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(pgUrl!);
        url.pathname = `/${databaseName}`;
        databaseUrl = url.toString();
        db = new PostgresSyncDatabase(databaseUrl);
      } else db = new Database(":memory:");
      store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
    });

    afterAll(async () => {
      db?.close();
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        await admin.end();
      }
    });

    function fixture(reverse = false) {
      const tag = `locks-${backend.toLowerCase()}-${++serial}`;
      const a = store.createWorkspace({ id: `wa-${tag}`, slug: `a-${tag}`, name: `A ${tag}` });
      const b = store.createWorkspace({ id: `wb-${tag}`, slug: `b-${tag}`, name: `B ${tag}` });
      const source = reverse ? b.id : a.id;
      const target = reverse ? a.id : b.id;
      const parent = store.createIssue({ id: `iss_a_${tag}`, title: "Parent", workspaceId: source });
      const child = store.createIssue({ id: `iss_z_${tag}`, title: "Unrelated child", workspaceId: source });
      return { source, target, parent, child };
    }

    function assertNoForeignEdges() {
      expect(db.query(`SELECT child.id FROM multiremi_issues child
        JOIN multiremi_issues parent ON parent.id = child.parent_issue_id
        WHERE child.workspace_id <> parent.workspace_id`).all()).toEqual([]);
      expect(db.query(`SELECT d.id FROM multiremi_issue_dependencies d
        JOIN multiremi_issues a ON a.id = d.issue_id JOIN multiremi_issues b ON b.id = d.depends_on_issue_id
        WHERE a.workspace_id <> b.workspace_id OR d.workspace_id <> a.workspace_id`).all()).toEqual([]);
    }

    it("S1: sequential move-before-add refuses all relation writes; add-before-move refuses the move", () => {
      const f = fixture();
      store.updateIssue(f.parent.id, { workspaceId: f.target });
      expect(() => store.createIssue({ title: "Invalid", parentIssueId: f.parent.id, workspaceId: f.source })).toThrow("another workspace");
      expect(() => store.updateIssue(f.child.id, { parentIssueId: f.parent.id })).toThrow("another workspace");
      expect(() => store.createIssueDependency(f.child.id, { dependsOnIssueId: f.parent.id })).toThrow("within a workspace");
      const other = fixture();
      store.updateIssue(other.child.id, { parentIssueId: other.parent.id });
      expect(() => store.updateIssue(other.parent.id, { workspaceId: other.target })).toThrow("Detach");
      assertNoForeignEdges();
    });

    for (const action of ["create", "reparent", "dependency"] as const) {
      it(`S2: ${action} locks all existing endpoints in ascending order before reading their state`, () => {
        const f = fixture();
        const events: Array<{ kind: "lock" | "read"; id: string }> = [];
        const originalRun = db.run.bind(db);
        const originalQuery = db.query.bind(db);
        const runSpy = spyOn(db, "run").mockImplementation((sql: string, params?: Array<string | number | bigint | boolean | null | Uint8Array>) => {
          if (sql === "UPDATE multiremi_issues SET id = id WHERE id = ?") events.push({ kind: "lock", id: String(params?.[0]) });
          return originalRun(sql, params ?? []);
        });
        const querySpy = spyOn(db, "query").mockImplementation((sql: string) => {
          const stmt = originalQuery(sql);
          if (sql === "SELECT * FROM multiremi_issues WHERE id = ?") {
            const get = stmt.get.bind(stmt);
            stmt.get = (...params) => { events.push({ kind: "read", id: String(params[0]) }); return get(...params); };
          }
          return stmt;
        });
        try {
          if (action === "create") store.createIssue({ title: "Locked child", workspaceId: f.source,
            parentIssueId: f.parent.id, blockedBy: [f.child.key] });
          if (action === "reparent") store.updateIssue(f.child.id, { parentIssueId: f.parent.id });
          if (action === "dependency") store.createIssueDependency(f.child.id, { dependsOnIssueId: f.parent.key });
        } finally { querySpy.mockRestore(); runSpy.mockRestore(); }
        const expected = [f.parent.id, f.child.id].sort();
        expect(events.filter((event) => event.kind === "lock").map((event) => event.id)).toEqual(expected);
        const lastLock = events.findLastIndex((event) => event.kind === "lock");
        for (const id of expected) expect(events.findIndex((event) => event.kind === "read" && event.id === id)).toBeGreaterThan(lastLock);
      });
    }

    if (backend !== "PostgreSQL") return;

    async function hold(input: Omit<RelationLockInput, "databaseUrl">, action: () => void) {
      const worker = new Worker(new URL("./fixtures/postgres-relation-lock-worker.ts", import.meta.url).href);
      const locked = phase(worker, "locked");
      const finished = Promise.all([phase(worker, "done"), phase(worker, "closed")]);
      worker.postMessage({ ...input, databaseUrl });
      try {
        await locked;
        let failure: unknown;
        try { action(); } catch (error) { failure = error; }
        expect((await finished)[0]!.ok).toBe(true);
        if (failure) throw failure;
      }
      finally { worker.terminate(); }
    }

    for (const reverse of [false, true]) {
      for (const action of ["create", "reparent", "dependency", "dependency-source"] as const) {
        it(`PG-L1 ${reverse ? "B -> A" : "A -> B"}: ${action} waits for a moving endpoint and re-reads`, async () => {
          const f = fixture(reverse);
          const before = store.listIssues({ workspaceId: f.source });
          await hold({ mode: "hold-move", role: "move", issueId: f.parent.id, otherId: f.child.id,
            sourceWorkspace: f.source, targetWorkspace: f.target }, () => {
            if (action === "create") expect(() => store.createIssue({ title: "Refused child", workspaceId: f.source, parentIssueId: f.parent.id })).toThrow("another workspace");
            if (action === "reparent") expect(() => store.updateIssue(f.child.id, { parentIssueId: f.parent.id })).toThrow("another workspace");
            if (action === "dependency") expect(() => store.createIssueDependency(f.child.id, { dependsOnIssueId: f.parent.id })).toThrow("within a workspace");
            if (action === "dependency-source") expect(() => store.createIssueDependency(f.parent.id, { dependsOnIssueId: f.child.id })).toThrow("within a workspace");
          });
          expect(store.getIssue(f.child.id)?.parentIssueId).toBeNull();
          expect(store.listIssues({ workspaceId: f.source })).toHaveLength(before.length - 1);
          const next = store.createIssue({ title: "No consumed number", workspaceId: f.source });
          expect(next.number).toBe(Math.max(...before.filter((issue) => issue.id !== f.parent.id).map((issue) => issue.number)) + 1);
          assertNoForeignEdges();
        }, 15_000);
      }

      it(`PG-L2 ${reverse ? "B -> A" : "A -> B"}: move inspects raw children after obtaining its own row lock`, async () => {
        const f = fixture(reverse);
        await hold({ mode: "hold-child", role: "create", issueId: f.parent.id, otherId: `${f.child.id}_new`,
          sourceWorkspace: f.source, targetWorkspace: f.target }, () => {
          expect(() => store.updateIssue(f.parent.id, { workspaceId: f.target })).toThrow("Detach");
        });
        expect(store.getIssue(f.parent.id)?.workspaceId).toBe(f.source);
        assertNoForeignEdges();
      }, 15_000);
    }

    async function race(inputs: Array<Omit<RelationLockInput, "databaseUrl" | "mode" | "barrierPath">>) {
      const directory = mkdtempSync(join(tmpdir(), "mul476-relation-"));
      const barrierPath = join(directory, "go");
      const workers = inputs.map(() => new Worker(new URL("./fixtures/postgres-relation-lock-worker.ts", import.meta.url).href));
      try {
        const ready = workers.map((worker) => phase(worker, "ready"));
        const done = workers.map((worker) => Promise.all([phase(worker, "done"), phase(worker, "closed")]));
        workers.forEach((worker, i) => worker.postMessage({ ...inputs[i], databaseUrl, mode: "race", barrierPath }));
        await Promise.all(ready);
        writeFileSync(barrierPath, "go");
        const outcomes = (await Promise.all(done)).map(([result]) => result!);
        for (const outcome of outcomes) {
          expect(outcome.error ?? "").not.toMatch(/40P01|deadlock/i);
          expect(outcome.maxTransactionDepth).toBe(1);
        }
        assertNoForeignEdges();
        return outcomes;
      } finally { workers.forEach((worker) => worker.terminate()); rmSync(directory, { recursive: true, force: true }); }
    }

    for (const reverse of [false, true]) {
      for (const role of ["create", "reparent", "dependency", "dependency-source"] as const) {
        it(`PG-L3 ${reverse ? "B -> A" : "A -> B"}: move vs ${role} permits exactly one writer`, async () => {
          const f = fixture(reverse);
          const common = { sourceWorkspace: f.source, targetWorkspace: f.target };
          const results = await race([
            { ...common, role: "move", issueId: f.parent.id, otherId: f.child.id },
            { ...common, role: role === "dependency-source" ? "dependency" : role,
              issueId: role === "dependency-source" ? f.parent.id : f.child.id,
              otherId: role === "dependency-source" ? f.child.id : f.parent.id },
          ]);
          expect(results.filter((result) => result.ok)).toHaveLength(1);
          expect(results.filter((result) => !result.ok)).toHaveLength(1);
        }, 15_000);
      }
    }

    for (const role of ["reparent", "dependency"] as const) {
      it(`PG-L4: opposing ${role} writes reject cycles without deadlock (10 rounds)`, async () => {
        for (let round = 0; round < 10; round++) {
          const f = fixture();
          const common = { role, sourceWorkspace: f.source, targetWorkspace: f.target };
          const results = await race([
            { ...common, issueId: f.child.id, otherId: f.parent.id },
            { ...common, issueId: f.parent.id, otherId: f.child.id },
          ]);
          expect(results.filter((result) => result.ok)).toHaveLength(1);
          const rejected = results.find((result) => !result.ok)!;
          expect(rejected.code === "dependency_cycle" || rejected.error === "Circular parent issue relationship detected").toBe(true);
        }
      }, 30_000);
    }
  });
}
