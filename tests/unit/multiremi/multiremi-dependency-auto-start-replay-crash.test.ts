import { createResponsibleTestIssue } from './helpers.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiIssue, MultiremiSystemEvent } from "@multiremi/contracts/types.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { resolveMigrationReportDirectory } from "@multiremi/store/migration-report-directory.js";
import { MultiremiStore } from "@multiremi/store.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const PG_DATABASE = `multiremi_replay_${process.pid}_${Date.now()}`;
const PROBE = new URL("./fixtures/postgres-autostart-crash-probe.ts", import.meta.url).pathname;

async function postgresAvailable(): Promise<boolean> {
  const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1, connectionTimeout: 2 });
  try {
    await admin`SELECT 1`;
    return true;
  } catch {
    if (process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Configured replay test PostgreSQL is unreachable");
    return false;
  } finally {
    await admin.end();
  }
}

const hasPostgres = await postgresAvailable();

for (const dialect of ["sqlite", "postgres"] as const) {
  const suite = dialect === "postgres" && !hasPostgres ? describe.skip : describe;
  suite(`MUL-452 crash recovery (${dialect})`, () => {
    let db: SqlDatabase;
    let store: MultiremiStore;
    let directory: string;
    let database: string;
    const probes: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];

    beforeAll(async () => {
      if (dialect !== "postgres") return;
      const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
      try {
        await admin.unsafe(`CREATE DATABASE ${PG_DATABASE}`);
      } finally {
        await admin.end();
      }
    });

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "mul452-replay-"));
      const url = new URL(PG_ADMIN_URL);
      url.pathname = `/${PG_DATABASE}`;
      database = dialect === "postgres" ? url.toString() : join(directory, "store.sqlite");
      openStore();
      store.ensureLocalWorkspace();
    });

    afterEach(async () => {
      for (const probe of probes.splice(0)) {
        if (probe.exitCode === null) probe.kill("SIGKILL");
        await probe.exited;
      }
      db?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    afterAll(async () => {
      if (dialect !== "postgres") return;
      const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${PG_DATABASE} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });

    function openStore(): void {
      db = dialect === "postgres"
        ? new PostgresSyncDatabase(database)
        : openSqliteDatabase(database);
      store = new MultiremiStore(db);
    }

    function restartStore(): void {
      db.close();
      openStore();
    }

    function chain(owner: "agent" | "squad" = "agent") {
      const runtime = store.registerRuntime({ name: `Replay ${directory}`, provider: "claude", maxConcurrency: 4 });
      const agent = store.createAgent({ name: `Replay ${directory}`, provider: "claude", runtimeId: runtime.id });
      const squad = owner === "squad" ? store.createSquad({ name: `Replay ${directory}`, leaderId: agent.id }) : null;
      const prerequisite = createResponsibleTestIssue(store, { title: "Crash prerequisite", status: "in_progress" });
      const dependent = createResponsibleTestIssue(store, {
        title: "Crash dependent", status: "backlog", blockedBy: [prerequisite.id],
        assigneeType: owner, assigneeId: squad?.id ?? agent.id,
      });
      return { prerequisite, dependent };
    }

    function spawnProbe(
      prerequisite: MultiremiIssue, dependent: MultiremiIssue, mode: string,
      replayAt?: Date, resumeFile?: string,
    ) {
      const probe = Bun.spawn([
        process.execPath, "run", PROBE, database, prerequisite.id, dependent.id, mode,
        replayAt?.toISOString() ?? "", resumeFile ?? "", resolveMigrationReportDirectory(),
      ], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      probes.push(probe);
      return probe;
    }

    async function waitForPhase(probe: Bun.Subprocess<"ignore", "pipe", "pipe">, phase: string): Promise<void> {
      const reader = probe.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const timeout = setTimeout(() => probe.kill("SIGKILL"), 30_000);
      try {
        while (!seen.split("\n").includes(phase)) {
          const { value, done } = await reader.read();
          if (done) {
            const stderr = await new Response(probe.stderr).text();
            throw new Error(`probe did not reach ${phase}; stdout=${seen}; stderr=${stderr}`);
          }
          seen += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
      }
    }

    async function killAt(prerequisite: MultiremiIssue, dependent: MultiremiIssue, mode: string, replayAt?: Date) {
      const probe = spawnProbe(prerequisite, dependent, mode, replayAt);
      await waitForPhase(probe, mode);
      probe.kill("SIGKILL");
      await probe.exited;
      restartStore();
    }

    function checkEvent(prerequisite: MultiremiIssue): MultiremiSystemEvent {
      const row = db.query(
        "SELECT id FROM multiremi_system_events WHERE resource_id = ? AND event = 'dependency_auto_start_check'",
      ).get(prerequisite.id) as { id: string };
      return store.getSystemEvent(row.id)!;
    }

    function activities(dependent: MultiremiIssue, type: string) {
      return db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = ?")
        .all(dependent.id, type) as Array<{ data: string }>;
    }

    function assertWaiting(dependent: MultiremiIssue): void {
      expect(store.getIssue(dependent.id)?.status).toBe("backlog");
      expect(store.listTasksForIssue(dependent.id)).toEqual([]);
      expect(activities(dependent, "dependency_auto_started")).toEqual([]);
      expect(activities(dependent, "issue_assigned")).toEqual([]);
    }

    function assertStarted(dependent: MultiremiIssue, event: MultiremiSystemEvent, replayed: boolean): void {
      expect(store.getIssue(dependent.id)?.status).toBe("todo");
      const tasks = store.listTasksForIssue(dependent.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe("queued");
      const started = activities(dependent, "dependency_auto_started");
      expect(started).toHaveLength(1);
      const data = JSON.parse(started[0]!.data);
      expect(data).toMatchObject({ dependencyCheckEventId: event.id, dependency_check_event_id: event.id });
      if (replayed) expect(data).toMatchObject({ replayed: true });
      else expect(data.replayed).toBeUndefined();
      expect(activities(dependent, "issue_assigned")).toHaveLength(1);
      expect(activities(dependent, "dependency_auto_start_skipped")).toEqual([]);
    }

    function notificationRows() {
      return {
        inbox: db.query("SELECT id FROM multiremi_inbox_items ORDER BY id").all(),
        comments: db.query("SELECT id FROM multiremi_issue_comments ORDER BY id").all(),
      };
    }

    it.each(["agent", "squad"] as const)("P1 recovers done committed before auto-start exactly once (%s)", async (owner) => {
      const { prerequisite, dependent } = chain(owner);
      await killAt(prerequisite, dependent, "after-done-commit");
      expect(store.getIssue(prerequisite.id)?.status).toBe("done");
      assertWaiting(dependent);
      const rows = db.query("SELECT event, status FROM multiremi_system_events WHERE resource_id = ? ORDER BY event")
        .all(prerequisite.id);
      expect(rows).toEqual([
        { event: "dependency_auto_start_check", status: "pending" },
        { event: "status_changed", status: "pending" },
      ]);
      const check = checkEvent(prerequisite);
      const before = notificationRows();
      store.dispatchPendingSystemEvents(new Date(check.availableAt));
      assertStarted(dependent, check, true);
      expect(notificationRows()).toEqual(before);
      expect(store.getSystemEvent(check.id)?.status).toBe("processed");
      store.dispatchPendingSystemEvents(new Date(check.availableAt));
      assertStarted(dependent, check, true);
      expect(notificationRows()).toEqual(before);
    }, 60_000);

    it("P2 preserves normal auto-start committed before live events", async () => {
      const { prerequisite, dependent } = chain();
      await killAt(prerequisite, dependent, "after-commit");
      const check = checkEvent(prerequisite);
      assertStarted(dependent, check, false);
      const before = notificationRows();
      store.dispatchPendingSystemEvents(new Date(check.availableAt));
      assertStarted(dependent, check, false);
      expect(notificationRows()).toEqual(before);
      expect(store.getSystemEvent(check.id)?.status).toBe("processed");
    }, 60_000);

    it("P3 recovers a killed replay transaction only after its lease expires", async () => {
      const { prerequisite, dependent } = chain();
      await killAt(prerequisite, dependent, "after-done-commit");
      const check = checkEvent(prerequisite);
      const replayAt = new Date(check.availableAt);
      await killAt(prerequisite, dependent, "replay-before-commit", replayAt);
      assertWaiting(dependent);
      expect(store.getSystemEvent(check.id)).toMatchObject({ status: "processing", attemptCount: 1 });
      expect(store.getSystemEvent(check.id)?.leaseUntil).toBe(new Date(replayAt.getTime() + 60_000).toISOString());
      store.dispatchPendingSystemEvents(replayAt);
      assertWaiting(dependent);
      store.dispatchPendingSystemEvents(new Date(replayAt.getTime() + 61_000));
      assertStarted(dependent, check, true);
      expect(store.getSystemEvent(check.id)).toMatchObject({ status: "processed", attemptCount: 2, leaseUntil: null });
    }, 60_000);

    it("P4 keeps one round when replay commits before marking the check processed", async () => {
      const { prerequisite, dependent } = chain();
      await killAt(prerequisite, dependent, "after-done-commit");
      const check = checkEvent(prerequisite);
      const replayAt = new Date(check.availableAt);
      await killAt(prerequisite, dependent, "replay-after-commit", replayAt);
      assertStarted(dependent, check, true);
      expect(store.getSystemEvent(check.id)).toMatchObject({ status: "processing", attemptCount: 1 });
      const before = notificationRows();
      store.dispatchPendingSystemEvents(new Date(replayAt.getTime() + 61_000));
      assertStarted(dependent, check, true);
      expect(notificationRows()).toEqual(before);
      expect(store.getSystemEvent(check.id)).toMatchObject({ status: "processed", attemptCount: 2, leaseUntil: null });
    }, 60_000);

    if (dialect === "postgres") {
      it("P5 arbitrates normal and replay auto-starts across real PG processes", async () => {
        const { prerequisite, dependent } = chain();
        const resumeFile = join(directory, "resume-normal");
        const normal = spawnProbe(prerequisite, dependent, "after-done-commit", undefined, resumeFile);
        await waitForPhase(normal, "after-done-commit");
        assertWaiting(dependent);
        const check = checkEvent(prerequisite);
        // Hold the workspace lock until both processes are released into the
        // auto-start. This makes their transactions compete at the real lock.
        const replay = spawnProbe(prerequisite, dependent, "replay-before-commit", new Date(check.availableAt), join(directory, "resume-replay"));
        await waitForPhase(replay, "replay-before-commit");
        const blocker = new Bun.SQL(database, { max: 1 });
        try {
          await blocker.begin(async (tx) => {
            await tx`SELECT id FROM multiremi_workspaces WHERE id = 'local' FOR UPDATE`;
            writeFileSync(resumeFile, "resume");
            writeFileSync(join(directory, "resume-replay"), "resume");
            // Both processes must reach the same PG lock before it is released.
            const deadline = Date.now() + 10_000;
            let waiting = 0;
            while (Date.now() < deadline) {
              await tx`SELECT pg_stat_clear_snapshot()`;
              const rows = await tx`SELECT COUNT(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%multiremi_workspaces%'`;
              waiting = Number(rows[0]?.count);
              if (waiting >= 2) break;
              await Bun.sleep(10);
            }
            expect(waiting).toBeGreaterThanOrEqual(2);
          });
        } finally {
          await blocker.end();
        }
        expect(await normal.exited).toBe(0);
        expect(await replay.exited).toBe(0);
        restartStore();
        const started = activities(dependent, "dependency_auto_started");
        expect(started).toHaveLength(1);
        assertStarted(dependent, check, JSON.parse(started[0]!.data).replayed === true);
        expect(store.getSystemEvent(check.id)?.status).toBe("processed");
      }, 60_000);

      it("P6 records one skip when normal and replay starts race for an unavailable owner", async () => {
        const { prerequisite, dependent } = chain();
        db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [
          new Date().toISOString(), dependent.assigneeId,
        ]);
        const normalResume = join(directory, "resume-normal");
        const replayResume = join(directory, "resume-replay");
        const normal = spawnProbe(prerequisite, dependent, "after-done-commit", undefined, normalResume);
        await waitForPhase(normal, "after-done-commit");
        const check = checkEvent(prerequisite);
        const replay = spawnProbe(prerequisite, dependent, "replay-before-commit", new Date(check.availableAt), replayResume);
        await waitForPhase(replay, "replay-before-commit");
        const blocker = new Bun.SQL(database, { max: 1 });
        try {
          await blocker.begin(async (tx) => {
            await tx`SELECT id FROM multiremi_workspaces WHERE id = 'local' FOR UPDATE`;
            writeFileSync(normalResume, "resume");
            writeFileSync(replayResume, "resume");
            const deadline = Date.now() + 10_000;
            let waiting = 0;
            while (Date.now() < deadline) {
              await tx`SELECT pg_stat_clear_snapshot()`;
              const rows = await tx`SELECT COUNT(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%multiremi_workspaces%'`;
              waiting = Number(rows[0]?.count);
              if (waiting >= 2) break;
              await Bun.sleep(10);
            }
            expect(waiting).toBeGreaterThanOrEqual(2);
          });
        } finally {
          await blocker.end();
        }
        expect(await normal.exited).toBe(0);
        expect(await replay.exited).toBe(0);
        restartStore();
        assertWaiting(dependent);
        expect(activities(dependent, "dependency_auto_start_skipped")).toHaveLength(1);
        expect(JSON.parse(activities(dependent, "dependency_auto_start_skipped")[0]!.data))
          .toMatchObject({ dependency_check_event_id: check.id });
        expect(store.getSystemEvent(check.id)?.status).toBe("processed");
      }, 60_000);
    }
  });
}
