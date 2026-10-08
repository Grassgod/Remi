import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

interface SteerRaceInput {
  databaseUrl: string;
  mode: "steer" | "complete";
  workspaceId: string;
  taskId: string;
  steerId: string;
  holdMs: number;
}

// #3: exercise canonical message/Turn writes on a real second connection.
self.onmessage = (message: MessageEvent<SteerRaceInput>) => {
  const { databaseUrl, mode, workspaceId, taskId, holdMs } = message.data;
  const db = new PostgresSyncDatabase(databaseUrl);
  try {
    const store = new MultiremiStore(db);
    db.transaction(() => {
      db.run("UPDATE multiremi_workspaces SET updated_at=updated_at WHERE id=?", [workspaceId]);
      if (mode === "steer") {
        store.createTaskSteerMessage({ taskId, kind: "steer", content: "race steer" });
      } else {
        store.completeTask(taskId, { output: "race complete" });
      }
      self.postMessage({ phase: "locked" });
      Bun.sleepSync(holdMs);
    })();
    self.postMessage({ phase: "committed" });
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    db.close();
  }
};
