// Second Postgres connection for the steer-vs-completion race tests. Replays
// the store's own lock discipline (workspace lifecycle row lock first, then
// re-read) from a genuinely separate connection so the test exercises real
// two-connection serialization, not SQLite's single-writer coincidence.
interface SteerRaceInput {
  databaseUrl: string;
  mode: "steer" | "complete";
  workspaceId: string;
  taskId: string;
  steerId: string;
  holdMs: number;
}

self.onmessage = async (message: MessageEvent<SteerRaceInput>) => {
  const { databaseUrl, mode, workspaceId, taskId, steerId, holdMs } = message.data;
  const sql = new Bun.SQL(databaseUrl, { max: 1 });
  let transactionOpen = false;
  try {
    await sql`BEGIN`;
    transactionOpen = true;
    // The same lock createTaskSteerMessage/completeTask take in the store.
    await sql`UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ${workspaceId}`;
    const [task] = await sql`SELECT status FROM multiremi_tasks WHERE id = ${taskId}`;
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    if (mode === "steer") {
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        throw new Error(`unexpected terminal status before steer insert: ${task.status}`);
      }
      await sql`
        INSERT INTO multiremi_task_steer_messages (id, task_id, author_type, author_id, kind, content, created_at)
        VALUES (${steerId}, ${taskId}, 'user', NULL, 'steer', 'race steer', ${now})
      `;
    } else {
      const [pending] = await sql`
        SELECT COUNT(*)::int AS n FROM multiremi_task_steer_messages
        WHERE task_id = ${taskId} AND consumed_at IS NULL
      `;
      if (Number(pending?.n ?? 0) > 0) throw new Error("unexpected pending steer before completion");
      await sql`
        UPDATE multiremi_tasks
        SET status = 'completed', result = '"race complete"', completed_at = ${now}, updated_at = ${now}
        WHERE id = ${taskId} AND status = 'running'
      `;
    }
    self.postMessage({ phase: "locked" });
    await Bun.sleep(holdMs);
    await sql`COMMIT`;
    transactionOpen = false;
    self.postMessage({ phase: "committed" });
  } catch (error) {
    if (transactionOpen) {
      try {
        await sql`ROLLBACK`;
      } catch {
        // Preserve the original failure.
      }
    }
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    await sql.end().catch(() => {});
  }
};
