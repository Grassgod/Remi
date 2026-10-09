import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

/**
 * One process, one Postgres connection (MUL-409 fix round 3).
 *
 * The concurrency blocker is only reproducible with genuinely separate
 * connections, so this worker exists to be spawned twice: both instances wait
 * on a file barrier and then accept their own prerequisite delivery at the same
 * moment, which is exactly the race the atomic start claim has to arbitrate.
 */
type WorkerMessage =
  | { type: "init"; databaseUrl: string; issueId: string; barrierPath: string;
      delivery: {id:string;revision:string;memberId:string} }
  | { type: "close" };

let db: PostgresSyncDatabase | null = null;
let store: MultiremiStore | null = null;
let issueId = "";
let barrierPath = "";

self.onmessage = async (message: MessageEvent<WorkerMessage>) => {
  try {
    if (message.data.type === "init") {
      db = new PostgresSyncDatabase(message.data.databaseUrl);
      store = new MultiremiStore(db);
      issueId = message.data.issueId;
      barrierPath = message.data.barrierPath;
      self.postMessage({ phase: "ready" });
      // Wait for the parent to release both workers together, then flip this
      // worker's own prerequisite. Staying inside this handler keeps the race
      // tight: both connections are already open when the barrier drops.
      while (!(await Bun.file(barrierPath).exists())) await Bun.sleep(1);
      const delivery=message.data.delivery;
      store.respondIssueDelivery(issueId,delivery.id,{action:'accept',revision:delivery.revision},{type:'member',id:delivery.memberId});
      self.postMessage({ phase: "done" });
      return;
    }
    if (!store) throw new Error("complete-issue worker is not initialized");
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
