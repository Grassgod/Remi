import { writeFileSync } from "node:fs";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";

const url = process.env.MULTIREMI_TEST_DATABASE_URL!;
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Probe requires the local test server");
}
const db = new PostgresSyncDatabase(url);
try {
  const store = new MultiremiStore(db);
  writeFileSync(process.argv[2]!, "ready");
  const input = JSON.parse(await Bun.stdin.text());
  db.resetTransactionDepthStats();
  if (input.operation === "sweep") {
    console.log(JSON.stringify(store.sweepIdleIssueLanes(input.now)));
    db.close();
    process.exit(0);
  }
  if (input.operation === "replay") {
    store.dispatchPendingSystemEvents(new Date(input.now));
    console.log(JSON.stringify({ depth: db.maxTransactionDepth }));
    db.close();
    process.exit(0);
  }
  const wrapped = (store as unknown as { db: SqlDatabase }).db;
  let entryId: string | null = null;
  const result = wrapped.transaction(() => {
    if (input.envelope) {
      const delivery = store.sendEnvelopeWithinTransaction(input.envelope, [], createCommitEventQueue())[0]!;
      entryId = delivery.entry.id;
      return delivery;
    }
    return store.ensurePendingTurnWithinTransaction({ ...input, create: () => store.createTaskWithinTransaction({
      agentId: input.lane.agentId, issueSessionId: input.lane.issueSessionId,
      issueId: store.getIssueSession(input.lane.issueSessionId)?.issueId,
      prompt: "Read the inbox", wakeSource: input.wake.reason,
    }, [], createCommitEventQueue()) });
  })();
  console.log(JSON.stringify({ taskId: result.task?.id, action: result.action, depth: db.maxTransactionDepth,
    entryId }));
} finally { db.close(); }
