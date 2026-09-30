import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import type { Envelope } from "@multiremi/contracts/inbox.js";
import { installPendingTurnTestConstraints, pendingTurnBackendTests } from "./pending-turn-test-backends.js";

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Concurrent pending-turn probes did not reach their lock barrier");
}

pendingTurnBackendTests("pending turn concurrency", (fixture, backend) => {
  for (const kind of ["issue", "chat"] as const) {
    it.skipIf(backend !== "PostgreSQL")(`keeps the ${kind} session-before-head lock order alongside legacy appenders`, async () => {
      installPendingTurnTestConstraints(fixture());
      const f = fixture();
      const agent = f.store.createAgent({ name: "Lock-order owner", provider: "codex" });
      const issue = f.store.createIssue({ title: "Lock-order inbox" });
      const session = kind === "issue" ? f.store.getOrCreateDefaultIssueSession(issue.id)
        : f.store.createChatSession({ agentId: agent.id });
      const beforeHead = Number(f.db.query("SELECT head_seq FROM multiremi_conversation_heads WHERE session_id = ?").get(session.id).head_seq);
      const envelope: Envelope = {
        to: kind === "issue" ? { role: "agent", agentId: agent.id, issueSessionId: session.id }
          : { role: "chat", agentId: agent.id, chatSessionId: session.id },
        kind: "report", wake: "now", body: "Lock-order report", source: {}, dedupeKey: "legacy-order",
      };
      const dir = mkdtempSync(join(tmpdir(), "mul483-inbox-lock-"));
      const name = `mul483_inbox_lock_${process.pid}_${kind}`;
      const url = new URL(f.databaseUrl!);
      url.searchParams.set("application_name", name);
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/pending-turn-concurrency-probe.ts"), join(dir, "ready")], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, MULTIREMI_TEST_DATABASE_URL: url.toString() },
      });
      const output = (async () => ({ code: await child.exited,
        stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }))();
      const blocker = new Bun.SQL(f.databaseUrl!, { max: 1 });
      const observer = new Bun.SQL(f.databaseUrl!, { max: 1 });
      try {
        await waitFor(() => existsSync(join(dir, "ready")));
        await blocker.begin(async tx => {
          if (kind === "issue") {
            await tx`UPDATE multiremi_issue_sessions SET updated_at = updated_at WHERE id = ${session.id}`;
          } else {
            await tx`UPDATE multiremi_chat_sessions SET updated_at = updated_at WHERE id = ${session.id}`;
          }
          child.stdin.write(JSON.stringify({ envelope }));
          child.stdin.end();
          await waitFor(async () => {
            const rows = await observer`SELECT COUNT(*)::int AS n FROM pg_stat_activity
              WHERE application_name = ${name} AND wait_event_type = 'Lock'`;
            return rows[0]!.n === 1;
          });
          // A legacy appender reaches the head after locking its session. If
          // the envelope writer held that head first, this would deadlock.
          await tx`UPDATE multiremi_conversation_heads SET updated_at = updated_at WHERE session_id = ${session.id}`;
        });
        const result = await output;
        expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
        const returned = JSON.parse(result.stdout);
        expect(returned.action).toBe("created");
        expect(f.db.query("SELECT seq, body_md FROM multiremi_conversation_log WHERE session_id = ? AND id = ?").all(session.id, returned.entryId))
          .toEqual([{ seq: beforeHead + 1, body_md: envelope.body }]);
      } finally {
        if (child.exitCode === null) child.kill();
        await output;
        await blocker.end();
        await observer.end();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 40_000);
  }

  for (const reason of ["concurrent", "re_ring"] as const) {
  it.skipIf(backend !== "PostgreSQL")(`coalesces two concurrent ${reason} transactions under the workspace lock without a unique violation`, async () => {
    installPendingTurnTestConstraints(fixture());
    const f = fixture();
    const agent = f.store.createAgent({ name: "Concurrent owner", provider: "codex" });
    const issue = f.store.createIssue({ title: "Concurrent inbox" });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const entry = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "agent", agentId: agent.id, issueSessionId: session.id }, kind: "report",
      wake: "inbox_only", body: "Concurrent pointer", source: {},
    }, [], createCommitEventQueue()))[0]!.entry;
    const dir = mkdtempSync(join(tmpdir(), `mul483-${reason}-pending-`));
    const blocker = new Bun.SQL(f.databaseUrl!, { max: 1 });
    const observer = new Bun.SQL(f.databaseUrl!, { max: 1 });
    const names = [0, 1].map(i => `mul483_${reason}_${process.pid}_${i}`);
    const children = names.map((name, i) => {
      const url = new URL(f.databaseUrl!);
      url.searchParams.set("application_name", name);
      return Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/pending-turn-concurrency-probe.ts"), join(dir, String(i))], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, MULTIREMI_TEST_DATABASE_URL: url.toString() },
      });
    });
    const output = children.map(async child => ({ code: await child.exited,
      stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }));
    try {
      await waitFor(() => names.every((_, i) => existsSync(join(dir, String(i)))));
      await blocker.begin(async tx => {
        await tx`UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ${agent.workspaceId}`;
        for (const [i, child] of children.entries()) {
          child.stdin.write(JSON.stringify({ lane: { kind: "issue", agentId: agent.id, issueSessionId: session.id, executionScope: "" },
            wake: { seq: 10 + i * 10, reason } }));
          child.stdin.end();
        }
        await waitFor(async () => {
          const rows = await observer`SELECT COUNT(*)::int AS n FROM pg_stat_activity
            WHERE application_name IN (${names[0]}, ${names[1]}) AND wait_event_type = 'Lock'`;
          return rows[0]!.n === 2;
        });
      });
      const results = await Promise.all(output);
      expect(results.map(result => ({ code: result.code, stderr: result.stderr })))
        .toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
      const returned = results.map(result => JSON.parse(result.stdout));
      expect(returned.map(result => result.action).sort()).toEqual(["coalesced", "created"]);
      expect(returned[0].taskId).toBe(returned[1].taskId);
      expect(returned.map(result => result.depth)).toEqual([1, 1]);
      const rows = f.db.query("SELECT wake_seq FROM multiremi_tasks WHERE issue_session_id = ? AND agent_id = ? AND status = 'queued'")
        .all(session.id, agent.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.wake_seq)).toBe(20);
      if (reason === "re_ring") {
        expect(f.db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'pending_turn_coalesced'").all(issue.id)
          .map(row => JSON.parse(String(row.data)))).toContainEqual(expect.objectContaining({ reason: "re_ring" }));
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(output);
      await blocker.end();
      await observer.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
  }
});
