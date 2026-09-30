/**
 * One arm of the MUL-405 lock-order interleave (see `mul405-lock-order.test.ts`).
 *
 * The arm replays, on its own Postgres connection, the lock sequence its real
 * store path takes — `workspace-row -> number` for Feishu ingest and
 * `number -> workspace-row` on the pre-fix Autopilot path. The sequence is
 * derived from the store in the test's first part, never hardcoded here, so a
 * future reorder of the store code changes what this arm executes.
 *
 * Timing: both arms announce readiness, take their first lock, then park until
 * the parent says `go`. Parking after the first lock is what forces the QA
 * interleaving: if the two orders disagree, both arms are already holding the
 * lock the other one needs the moment they resume, and Postgres has to resolve
 * the cycle. If the orders agree, the second arm is simply still blocked on its
 * first lock when `go` arrives, and the arm that went first releases it.
 */
type LockName = "workspace" | "number";

interface InterleaveInput {
  databaseUrl: string;
  workspaceId: string;
  issueId: string;
  lockOrder: LockName[];
}

let sql: any = null;
let resolveSignal: (() => void) | null = null;
const signals: string[] = [];

function post(phase: string, extra: Record<string, unknown> = {}): void {
  self.postMessage({ phase, ...extra });
}

/** Handshake from the parent: `go` releases this arm past its first lock. */
function waitForGo(): Promise<void> {
  if (signals.includes("go")) return Promise.resolve();
  return new Promise<void>((resolve) => {
    resolveSignal = () => resolve();
  });
}

self.onmessage = async (message: MessageEvent<InterleaveInput | { type: "go" }>) => {
  const data = message.data as InterleaveInput & { type?: string };
  if ((message.data as { type?: string }).type === "go") {
    signals.push("go");
    resolveSignal?.();
    resolveSignal = null;
    return;
  }

  const { databaseUrl, workspaceId, issueId, lockOrder } = data;
  sql = new Bun.SQL(databaseUrl, { max: 1 });
  let transactionOpen = false;
  const take = {
    workspace: () => sql.unsafe(
      "UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = $1",
      [workspaceId],
    ),
    number: () => sql.unsafe(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`multiremi:number:issue:${workspaceId}`],
    ),
  } satisfies Record<LockName, () => Promise<unknown>>;
  try {
    await sql`BEGIN`;
    transactionOpen = true;
    post("ready");

    for (let index = 0; index < lockOrder.length; index += 1) {
      await take[lockOrder[index]!]();
      if (index === 0) {
        // Hold the first lock and let the parent line the two arms up.
        post("first-lock");
        await waitForGo();
      }
    }

    // The read-then-write the number lock exists to protect.
    const [row] = await sql`
      SELECT COALESCE(MAX(issue_number), 0) + 1 AS next FROM multiremi_issues WHERE workspace_id = ${workspaceId}
    `;
    const next = Number(row?.next ?? 1);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO multiremi_issues (id, issue_number, issue_key, title, workspace_id, created_at, updated_at)
      VALUES (${issueId}, ${next}, ${`MUL-${next}`}, ${"lock-order interleave"}, ${workspaceId}, ${now}, ${now})
    `;
    await sql`COMMIT`;
    transactionOpen = false;
    post("committed", { issueNumber: next });
  } catch (error) {
    if (transactionOpen) {
      try { await sql`ROLLBACK`; } catch { /* preserve the original failure */ }
    }
    post("error", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    try { await sql.end(); } catch { /* already closed */ }
    sql = null;
  }
};
