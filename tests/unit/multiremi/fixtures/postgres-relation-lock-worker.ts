import { createResponsibleTestIssue } from '../helpers.js';
import { existsSync } from "node:fs";
import { numberAllocationLockKey } from "@multiremi/store/advisory-locks.js";
import { advisoryXactLock, PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

export interface RelationLockInput {
  databaseUrl: string;
  mode: "hold-move" | "hold-child" | "hold-reparent" | "hold-number" | "hold-report" | "race";
  role: "move" | "create" | "reparent" | "dependency" | "reopen" | "assign" | "task" | "runtime-delete";
  issueId: string;
  otherId: string;
  ownerId?: string;
  sourceWorkspace: string;
  targetWorkspace: string;
  targetResponsibleMemberId?: string;
  barrierPath?: string;
  /** Hold modes: start once gate[0] is set, and set gate[1] after locking. */
  gate?: SharedArrayBuffer;
}

/** A peer waiting on a row this transaction holds, not a timed sleep. */
function waitForBlockedPeer(db: PostgresSyncDatabase): void {
  const deadline = Date.now() + 15_000;
  while (!db.query("SELECT 1 FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))").get()) {
    if (Date.now() > deadline) throw new Error("no peer waited on the held rows");
    Bun.sleepSync(5);
  }
}

self.onmessage = async ({ data: input }: MessageEvent<RelationLockInput>) => {
  const db = new PostgresSyncDatabase(input.databaseUrl);
  try {
    const store = new MultiremiStore(db);
    db.resetTransactionDepthStats();
    if (input.mode !== "race") {
      const gate = input.gate ? new Int32Array(input.gate) : null;
      if (gate) {
        self.postMessage({ phase: "ready" });
        if (Atomics.wait(gate, 0, 0, 15_000) === "timed-out") throw new Error("relation gate timeout");
      }
      if (input.mode === "hold-report") {
        const originalRun = db.run.bind(db);
        db.run = (sql, params = []) => {
          const result = originalRun(sql, params);
          if (/INSERT INTO multiremi_issue_workspaces/.test(sql)) {
            self.postMessage({ phase: "locked" });
            waitForBlockedPeer(db);
          }
          return result;
        };
        const issue = store.getIssue(input.issueId)!;
        store.reportIssueWorkspace({ issueId: issue.id, runtimeId: input.ownerId!,
          rootPath: `/worker/${issue.key}`, branchName: `agent/${issue.key}`, status: "ready" });
        self.postMessage({ phase: "done", ok: true, maxTransactionDepth: db.maxTransactionDepth });
        return;
      }
      db.transaction(() => {
        if (input.mode === "hold-number") {
          // A creation in the target workspace, paused after its number lock.
          advisoryXactLock(db, numberAllocationLockKey(`issue:${input.targetWorkspace}`));
        } else {
          // hold-reparent takes the same sorted set as a real re-parent: the child and its new parent.
          const locked = input.mode === "hold-reparent" ? [input.issueId, input.otherId].sort() : [input.issueId];
          for (const id of locked) db.run("UPDATE multiremi_issues SET id = id WHERE id = ?", [id]);
        }
        self.postMessage({ phase: "locked" });
        if (gate) { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); }
        // Commit only once the peer is queued behind these rows, so it must re-read.
        waitForBlockedPeer(db);
        if (input.mode === "hold-move") {
          db.run("UPDATE multiremi_issues SET workspace_id = ?, responsible_member_id=? WHERE id = ?", [input.targetWorkspace,input.targetResponsibleMemberId!, input.issueId]);
        } else if (input.mode === "hold-reparent") {
          db.run("UPDATE multiremi_issues SET parent_issue_id = ? WHERE id = ?", [input.otherId, input.issueId]);
        } else if (input.mode === "hold-number") {
          const { next } = db.query(
            "SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multiremi_issues WHERE workspace_id = ?",
          ).get(input.targetWorkspace) as { next: number | string };
          const now = new Date().toISOString();
          db.run(
            `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, status, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, 'Concurrent creation', 'todo', ?, ?, ?)`,
            [input.otherId, Number(next), `MUL-${next}`, input.targetWorkspace, now, now],
          );
        } else {
          db.run(
            `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, status, workspace_id,
              parent_issue_id, created_at, updated_at)
             VALUES (?, 9999, 'MUL-9999', 'Concurrent child', 'todo', ?, ?, ?, ?)`,
            [input.otherId, input.sourceWorkspace, input.issueId, new Date().toISOString(), new Date().toISOString()],
          );
        }
      })();
      self.postMessage({ phase: "done", ok: true, maxTransactionDepth: db.maxTransactionDepth });
      return;
    }
    self.postMessage({ phase: "ready" });
    const deadline = Date.now() + 30_000;
    while (!existsSync(input.barrierPath!)) {
      if (Date.now() > deadline) throw new Error("relation barrier timeout");
      await Bun.sleep(5);
    }
    try {
      if (input.role === "move") store.updateIssue(input.issueId, { workspaceId: input.targetWorkspace,responsibleMemberId:input.targetResponsibleMemberId!,actorType:'member',actorId:input.targetResponsibleMemberId! });
      if (input.role === "create") createResponsibleTestIssue(store, { title: "Racing child", workspaceId: input.sourceWorkspace, parentIssueId: input.otherId });
      if (input.role === "reparent") store.updateIssue(input.issueId, { parentIssueId: input.otherId });
      if (input.role === "dependency") store.createIssueDependency(input.issueId, { dependsOnIssueId: input.otherId, type: "blocked_by" });
      if (input.role === "reopen") store.updateIssue(input.issueId, { status: "in_progress" });
      if (input.role === "assign") store.assignIssue(input.issueId, { assigneeType: "agent", assigneeId: input.ownerId! });
      if (input.role === "task") store.createTask({ agentId: input.ownerId!, issueId: input.issueId, workspaceId: input.sourceWorkspace, prompt: "Racing task" });
      if (input.role === "runtime-delete") {
        const result = store.deleteRuntimeWithArchivedAgentCleanup(input.ownerId!, { abandonIssueWorkspaces: true });
        if (result.status !== "deleted") throw new Error(`Runtime delete refused: ${result.status}`);
      }
      self.postMessage({ phase: "done", ok: true, maxTransactionDepth: db.maxTransactionDepth });
    } catch (error) {
      const failure = error as Error & { code?: string };
      self.postMessage({ phase: "done", ok: false, error: failure.message, code: failure.code, maxTransactionDepth: db.maxTransactionDepth });
    }
  } catch (error) {
    self.postMessage({ phase: "error", error: String(error) });
  } finally {
    db.close();
    self.postMessage({ phase: "closed" });
  }
};
