interface SessionProjectionRaceInput {
  databaseUrl: string;
  sessionId: string;
  taskId: string;
  holdMs: number;
}

self.onmessage = async (message: MessageEvent<SessionProjectionRaceInput>) => {
  const { databaseUrl, sessionId, taskId, holdMs } = message.data;
  const sql = new Bun.SQL(databaseUrl, { max: 1 });
  let transactionOpen = false;
  try {
    await sql`BEGIN`;
    transactionOpen = true;
    await sql`
      UPDATE multiremi_issue_sessions
      SET updated_at = updated_at
      WHERE id = ${sessionId}
    `;
    self.postMessage({ phase: "locked" });
    await Bun.sleep(holdMs);
    await sql`
      UPDATE multiremi_tasks
      SET projection_from_seq = 0, projection_to_seq = 1, projection_mode = 'bootstrap'
      WHERE id = ${taskId}
    `;
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
    await sql.end();
  }
};
