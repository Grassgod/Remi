import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { pendingTurnBackendTests, type PendingTurnTestFixture } from "./pending-turn-test-backends.js";

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("MUL-492 child processes did not reach the database lock barrier");
}

async function race(f: PendingTurnTestFixture, operation: string, input: Record<string, unknown>,
  lock: (tx: Bun.TransactionSQL) => Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mul492-race-"));
  const names = [0, 1].map(i => `mul492_${operation}_${process.pid}_${i}`);
  const children = names.map((name, i) => {
    const url = new URL(f.databaseUrl!);
    url.searchParams.set("application_name", name);
    return Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/pending-turn-concurrency-probe.ts"), join(dir, String(i))], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, MULTIREMI_TEST_DATABASE_URL: url.toString() },
    });
  });
  const outputs = children.map(async child => ({ code: await child.exited,
    stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }));
  const blocker = new Bun.SQL(f.databaseUrl!, { max: 1 });
  const observer = new Bun.SQL(f.databaseUrl!, { max: 1 });
  try {
    await waitFor(() => names.every((_, i) => existsSync(join(dir, String(i)))));
    await blocker.begin(async tx => {
      await lock(tx);
      for (const child of children) {
        child.stdin.write(JSON.stringify({ ...input, operation }));
        child.stdin.end();
      }
      await waitFor(async () => {
        const rows = await observer`SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE application_name IN (${names[0]}, ${names[1]}) AND wait_event_type = 'Lock'`;
        return rows[0]!.n === 2;
      });
    });
    const results = await Promise.all(outputs);
    expect(results.map(r => ({ code: r.code, stderr: r.stderr }))).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(outputs);
    await blocker.end();
    await observer.end();
    rmSync(dir, { recursive: true, force: true });
  }
}

pendingTurnBackendTests("MUL-492 wake recovery concurrency", (fixture, backend) => {
  if (backend !== "PostgreSQL") return;
  it("13: two independent sweeps blocked on W create exactly one turn", async () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Race owner", provider: "codex" });
    const issue = f.store.createIssue({ title: "Concurrent sweep" });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "agent", agentId: agent.id,
      issueSessionId: session.id }, kind: "report", wake: "now", body: "Lost wake", source: {} }, [], createCommitEventQueue()))[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
    const before = f.store.listTasksForIssue(issue.id).length;
    await race(f, "sweep", { now: Date.now() + 61_000 }, tx => tx`UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ${agent.workspaceId}`);
    const tasks = f.store.listTasksForIssue(issue.id);
    expect(tasks).toHaveLength(before + 1);
    expect(tasks.filter(t => t.status === "queued")).toHaveLength(1);
    expect(f.store.listIssueActivity(issue.id).filter(a => a.type === "re_ring")).toHaveLength(1);
    f.store.sweepIdleIssueLanes(Date.now() + 121_000);
    expect(f.store.listTasksForIssue(issue.id)).toHaveLength(before + 1);
  }, 40_000);
});
