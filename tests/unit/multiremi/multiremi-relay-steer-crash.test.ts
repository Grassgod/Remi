import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { redactDiagnostic } from "../../helpers/two-process.js";

const probePath = new URL("./fixtures/relay-steer-crash-probe.ts", import.meta.url).pathname;
const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const marker = "MUL486_CRASH_STEER";

for (const backend of ["SQLite", "PostgreSQL"] as const) {
  describe.skipIf(backend === "PostgreSQL" && !pgAdminUrl)(`MUL-486 relay steer crash (${backend})`, () => {
    let directory: string;
    let database: string;
    let pgName: string | null;
    let db: SqlDatabase;
    let store: MultiremiStore;
    let admin: Bun.SQL | null;

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "mul486-crash-"));
      pgName = null;
      admin = null;
      if (backend === "PostgreSQL") {
        const url = new URL(pgAdminUrl!);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Crash tests require a local PostgreSQL server");
        admin = new Bun.SQL(pgAdminUrl!, { max: 1, connectionTimeout: 2 });
        try { await admin`SELECT 1`; }
        catch { throw new Error("Configured MUL-486 test PostgreSQL is unavailable"); }
        pgName = `mul486_${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
        await admin.unsafe(`CREATE DATABASE ${pgName}`);
        url.pathname = `/${pgName}`;
        database = url.toString();
      } else database = join(directory, "store.sqlite");
      open();
      store.ensureLocalWorkspace();
    }, 30_000);

    afterEach(async () => {
      db?.close();
      if (pgName) await admin!.unsafe(`DROP DATABASE IF EXISTS ${pgName} WITH (FORCE)`);
      await admin?.end();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    function open(): void {
      db = backend === "PostgreSQL" ? new PostgresSyncDatabase(database)
        : openSqliteDatabase(database);
      store = new MultiremiStore(db);
    }

    async function killAt(phase: string, issueId: string): Promise<void> {
      db.close();
      const probe = Bun.spawn([process.execPath, "run", probePath, database, issueId, phase], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env },
      });
      const diagnostic = new Response(probe.stderr).text();
      const reader = probe.stdout.getReader();
      const timeout = setTimeout(() => probe.kill("SIGKILL"), 30_000);
      let output = "";
      try {
        while (!output.split("\n").includes(phase)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`Crash probe exited before ${phase}: ${redactDiagnostic(await diagnostic)}`);
          output += new TextDecoder().decode(value);
        }
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
        if (probe.exitCode === null) probe.kill("SIGKILL");
        await probe.exited;
      }
      open();
    }

    for (const phase of ["before-insert", "after-insert", "after-commit"] as const) {
      it(`${phase}: relay message and running turn input commit together`, async () => {
        const agent = store.createAgent({ name: "Crash relay", provider: "codex" });
        const issue = store.createIssue({ title: "Crash relay", status: "in_progress" });
        const chat = store.createChatSession({ agentId: agent.id });
        bindFeishuTopicFixture(store, db, chat.id, issue.id);
        const initial = db.transaction(() => store.sendEnvelopeWithinTransaction({
          to: { role: "relay", issueId: issue.id }, kind: "report", wake: "now",
          body: "Initial report", source: { issueId: issue.id },
        }, [], createCommitEventQueue()))()[0]!;
        expect(initial.action).toBe("created");
        const runtime = store.registerRuntime({ id: "relay-crash", name: "relay-crash", provider: "codex" });
        expect(store.claimTask(runtime.id)?.id).toBe(initial.task!.id);
        store.startTask(initial.task!.id);
        await killAt(phase, issue.id);
        const system = db.query("SELECT id FROM multiremi_conversation_log WHERE session_id = ? AND kind = 'message' AND body_md = ?")
          .all(chat.id, marker);
        const input = store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(initial.task!.id)!);
        const steers = input.input_messages.filter(row => system.some((message: any) => message.id === row.id));
        expect(system).toHaveLength(phase === "after-commit" ? 1 : 0);
        expect(steers).toHaveLength(system.length);
      }, 40_000);
    }
  });
}
