import { existsSync } from "node:fs";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

export interface RelationLockInput {
  databaseUrl: string;
  mode: "hold-move" | "hold-child" | "race";
  role: "move" | "create" | "reparent" | "dependency";
  issueId: string;
  otherId: string;
  sourceWorkspace: string;
  targetWorkspace: string;
  barrierPath?: string;
}

self.onmessage = async ({ data: input }: MessageEvent<RelationLockInput>) => {
  const db = new PostgresSyncDatabase(input.databaseUrl);
  try {
    const store = new MultiremiStore(db);
    db.resetTransactionDepthStats();
    if (input.mode !== "race") {
      db.transaction(() => {
        db.run("UPDATE multiremi_issues SET id = id WHERE id = ?", [input.issueId]);
        self.postMessage({ phase: "locked" });
        Bun.sleepSync(300);
        if (input.mode === "hold-move") {
          db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [input.targetWorkspace, input.issueId]);
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
      if (input.role === "move") store.updateIssue(input.issueId, { workspaceId: input.targetWorkspace });
      if (input.role === "create") store.createIssue({ title: "Racing child", workspaceId: input.sourceWorkspace, parentIssueId: input.otherId });
      if (input.role === "reparent") store.updateIssue(input.issueId, { parentIssueId: input.otherId });
      if (input.role === "dependency") store.createIssueDependency(input.issueId, { dependsOnIssueId: input.otherId, type: "blocked_by" });
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
