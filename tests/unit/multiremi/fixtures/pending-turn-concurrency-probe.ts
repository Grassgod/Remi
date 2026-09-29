import { writeFileSync } from "node:fs";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";

const url = process.env.MULTIREMI_TEST_DATABASE_URL!;
if (new URL(url).hostname !== "127.0.0.1") throw new Error("Probe requires the local test server");
const db = new PostgresSyncDatabase(url);
try {
  const store = new MultiremiStore(db);
  writeFileSync(process.argv[2]!, "ready");
  const input = JSON.parse(await Bun.stdin.text());
  db.resetTransactionDepthStats();
  const wrapped = (store as unknown as { db: SqlDatabase }).db;
  let entryId: string | null = null;
  const result = wrapped.transaction(() => {
    if (input.envelope) {
      const delivery = store.sendEnvelopeWithinTransaction(input.envelope, [], createCommitEventQueue())[0]!;
      entryId = delivery.entry.id;
      return delivery;
    }
    return store.ensurePendingTurnWithinTransaction({
      ...input, childStatusChanges: [], deferredEvents: createCommitEventQueue(),
    });
  })();
  console.log(JSON.stringify({ taskId: result.task?.id, created: result.created, depth: db.maxTransactionDepth,
    entryId }));
} finally { db.close(); }
