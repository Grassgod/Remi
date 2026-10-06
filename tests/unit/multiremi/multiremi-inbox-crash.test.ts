import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { inboxFlowFixture, inboxFlowStatus, triggerInboxFlow, inboxWakeSeq,
  type InboxFlowFixture, type InboxFlowScenario } from "./fixtures/inbox-flow-fixture.js";

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const probePath = new URL("./fixtures/inbox-crash-probe.ts", import.meta.url).pathname;
const phases = ["before-turn", "after-turn", "after-commit"] as const;

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(backend === "PostgreSQL" && !adminUrl)(`D1 inbox crash recovery (${backend})`, () => {
    let admin: Bun.SQL | undefined;
    let databaseName: string | undefined;
    let directory: string;
    let database: string;
    let db: SqlDatabase;
    let store: MultiremiStore;
    const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];

    beforeAll(async () => {
      if (backend !== "PostgreSQL") return;
      if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl!).hostname)) {
        throw new Error("D1 crash tests require a local dedicated PostgreSQL server");
      }
      admin = new Bun.SQL(adminUrl!, { max: 1, connectionTimeout: 2 });
      try { await admin`SELECT 1`; }
      catch { throw new Error("Configured D1 crash test PostgreSQL is unreachable"); }
    });
    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "mul483-inbox-crash-"));
      if (backend === "PostgreSQL") {
        databaseName = `mul483_crash_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
        await admin!.unsafe(`CREATE DATABASE ${databaseName}`);
        const url = new URL(adminUrl!);
        url.pathname = `/${databaseName}`;
        database = url.toString();
      } else database = join(directory, "store.sqlite");
      openStore();
    }, 30_000);
    afterEach(async () => {
      for (const child of children.splice(0)) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      db?.close();
      if (databaseName) {
        await admin!.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        databaseName = undefined;
      }
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    afterAll(async () => { await admin?.end(); });

    function openStore(): void {
      db = backend === "PostgreSQL" ? new PostgresSyncDatabase(database) : openSqliteDatabase(database);
      store = new MultiremiStore(db);
    }
    function restart(): void { db.close(); openStore(); }
    function queued(f: InboxFlowFixture) {
      return store.listTasksForIssue(f.targetIssueId).filter(task => task.agentId === f.agentId && task.status === "queued");
    }
    function envelopes(f: InboxFlowFixture) {
      return db.query("SELECT id, seq, body_md, metadata, to_agent_id FROM multiremi_conversation_log WHERE session_id = ? ORDER BY seq")
        .all(f.issueSessionId).map(row => ({ ...row, metadata: JSON.parse(String(row.metadata)) }))
        .filter(row => row.to_agent_id === f.agentId);
    }
    function spawn(f: InboxFlowFixture, phase: string, ordinal = 0) {
      const file = join(directory, `fixture-${ordinal}.json`);
      writeFileSync(file, JSON.stringify(f));
      const url = backend === "PostgreSQL" ? new URL(database) : null;
      const name = `mul483_crash_${process.pid}_${ordinal}`;
      url?.searchParams.set("application_name", name);
      const child = Bun.spawn([process.execPath, "run", probePath, file, phase], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, MULTIREMI_TEST_DATABASE_URL: url?.toString() ?? database },
      });
      children.push(child);
      return { child, name };
    }
    async function waitPhase(child: Bun.Subprocess<"pipe", "pipe", "pipe">, phase: string) {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        while (!output.split("\n").includes(phase)) {
          const read = await reader.read();
          if (read.done) throw new Error(`Inbox probe did not reach ${phase}: ${output}; ${await new Response(child.stderr).text()}`);
          output += decoder.decode(read.value, { stream: true });
        }
      } finally { clearTimeout(timer); reader.releaseLock(); }
    }

    for (const scenario of ["e2", "e3", "e4", "human"] as InboxFlowScenario[]) {
      for (const phase of phases) {
        it(`${scenario}: state and wake survive together at ${phase}`, async () => {
          const f = inboxFlowFixture(store, scenario);
          const initialStatus = inboxFlowStatus(store, f);
          const { child } = spawn(f, phase);
          await waitPhase(child, "ready");
          child.stdin.write("run");
          child.stdin.end();
          await waitPhase(child, phase);
          child.kill("SIGKILL");
          await child.exited;
          restart();
          const committed = phase === "after-commit";
          if (scenario === "human") {
            const comments = store.listIssueComments(f.targetIssueId).filter(comment => comment.body === f.humanBody);
            expect(comments).toHaveLength(committed ? 1 : 0);
            expect(queued(f).map(task => task.id)).toEqual([f.seededTaskId!]);
            const wakeSeq = inboxWakeSeq(db, f.seededTaskId!);
            if (committed) {
              const log = db.query("SELECT seq FROM multiremi_conversation_log WHERE id = ?").get(comments[0]!.id);
              expect(wakeSeq).toBe(Number(log!.seq));
              expect(wakeSeq).toBeGreaterThan(f.seededWakeSeq!);
            } else expect(wakeSeq).toBe(f.seededWakeSeq!);
            expect(inboxFlowStatus(store, f)).toBe(committed ? "todo" : initialStatus);
            return;
          }
          const finalStatus = scenario === "e2" ? "done" : scenario === "e3" ? "blocked" : "answered";
          expect(inboxFlowStatus(store, f)).toBe(committed ? finalStatus : initialStatus);
          expect(queued(f)).toHaveLength(committed ? 1 : 0);
          expect(envelopes(f)).toHaveLength(committed ? 1 : 0);
          expect(store.listIssueComments(f.targetIssueId).filter(comment => comment.authorType === "system"))
            .toHaveLength(committed ? 1 : 0);
          if (committed) {
            const taskId = queued(f)[0]!.id;
            const entry = envelopes(f)[0]!;
            expect(inboxWakeSeq(db, taskId)).toBe(Number(entry.seq));
            triggerInboxFlow(store, f);
            expect(queued(f).map(task => task.id)).toEqual([taskId]);
            expect(envelopes(f).map(row => row.id)).toEqual([entry.id]);
            const duplicate = store.createTask({ agentId: f.agentId, issueId: f.targetIssueId,
              issueSessionId: f.issueSessionId, prompt: "Forced second platform turn", wakeSource: "forced_duplicate",
               });
            expect(duplicate.id).toBe(taskId);
            expect(queued(f)).toHaveLength(1);
          }
        }, 30_000);
      }
    }

    if (backend === "PostgreSQL") it("two concurrent E2 processes leave exactly one pending turn", async () => {
      const f = inboxFlowFixture(store, "e2");
      const probes = [0, 1].map(i => spawn(f, "run", i));
      await Promise.all(probes.map(({ child }) => waitPhase(child, "ready")));
      const blocker = new Bun.SQL(database, { max: 1 });
      const observer = new Bun.SQL(database, { max: 1 });
      try {
        await blocker.begin(async tx => {
          await tx`UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = 'local'`;
          for (const { child } of probes) { child.stdin.write("run"); child.stdin.end(); }
          const deadline = Date.now() + 20_000;
          let waiting = 0;
          while (Date.now() < deadline) {
            const rows = await observer`SELECT COUNT(*)::int AS n FROM pg_stat_activity
              WHERE application_name IN (${probes[0]!.name}, ${probes[1]!.name}) AND wait_event_type = 'Lock'`;
            waiting = rows[0]!.n;
            if (waiting === 2) break;
            await Bun.sleep(20);
          }
          expect(waiting).toBe(2);
        });
        for (const { child } of probes) {
          expect(await child.exited).toBe(0);
          expect(await new Response(child.stderr).text()).toBe("");
        }
        restart();
        expect(inboxFlowStatus(store, f)).toBe("done");
        expect(queued(f)).toHaveLength(1);
        expect(envelopes(f)).toHaveLength(1);
        expect(inboxWakeSeq(db, queued(f)[0]!.id)).toBe(Number(envelopes(f)[0]!.seq));
      } finally { await blocker.end(); await observer.end(); }
    }, 40_000);
  });
}
