interface TerminalIssueRaceInput {
  databaseUrl: string;
  issueId: string;
  eventId: string;
  holdMs: number;
}

self.onmessage = async (message: MessageEvent<TerminalIssueRaceInput>) => {
  const { databaseUrl, issueId, eventId, holdMs } = message.data;
  const sql = new Bun.SQL(databaseUrl, { max: 1 });
  let transactionOpen = false;
  try {
    await sql`BEGIN`;
    transactionOpen = true;
    const [current] = await sql`
      SELECT status, workspace_id, project_id
      FROM multiremi_issues
      WHERE id = ${issueId}
      FOR UPDATE
    `;
    if (!current) throw new Error(`Issue not found: ${issueId}`);
    const updatedAt = new Date().toISOString();
    await sql`
      UPDATE multiremi_issues
      SET status = 'done', updated_at = ${updatedAt}
      WHERE id = ${issueId}
    `;
    const payload = JSON.stringify({
      issue_id: issueId,
      workspace_id: current.workspace_id,
      project_id: current.project_id,
      previous_status: current.status,
      status: "done",
      actor_type: "member",
      actor_id: "pg-race-user",
    });
    await sql`
      INSERT INTO multiremi_system_events (
        id, workspace_id, resource, event, resource_id, project_id, payload,
        status, attempt_count, available_at, lease_until, last_error, created_at, processed_at
      ) VALUES (
        ${eventId}, ${current.workspace_id}, 'issue', 'status_changed', ${issueId},
        ${current.project_id}, ${payload}, 'pending', 0, ${updatedAt}, NULL, NULL, ${updatedAt}, NULL
      )
    `;
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
    await sql.end();
  }
};
