import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { runMigrations } from "@multiremi/store/migrations.js";

interface Input {
  databaseUrl: string;
  role: "backfill" | "merge";
  originalId: string;
  replacementId: string;
  barrier: SharedArrayBuffer;
  pauseAfterRead: boolean;
}

self.onmessage = ({ data }: MessageEvent<Input>) => {
  let db: PostgresSyncDatabase | undefined;
  try {
    // A fixture-only key shared by these workers; never an inherited credential.
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 79).toString("base64");
    db = new PostgresSyncDatabase(data.databaseUrl);
    const store = new MultiremiStore(db);
    const activeDb = db;
    self.onmessage = () => {
      try {
        const query = activeDb.query.bind(activeDb);
        let paused = false;
        activeDb.query = (sql: string) => {
          const statement = query(sql);
          const ownershipRead = data.role === "backfill"
            ? /SELECT c\.(?:runtime_id|id)[\s\S]*FROM multiremi_runtime_provider_credentials c/.test(sql)
            : /SELECT id, ciphertext FROM multiremi_runtime_provider_credentials/.test(sql);
          if (!ownershipRead || !data.pauseAfterRead) return statement;
          const pause = () => {
            if (paused) return;
            paused = true;
            self.postMessage({ phase: "owner-read" });
            const signal = new Int32Array(data.barrier);
            if (Atomics.wait(signal, 0, 0, 20_000) === "timed-out") {
              throw new Error("Timed out awaiting provenance race barrier");
            }
          };
          return {
            get: (...params: unknown[]) => { const result = statement.get(...params); pause(); return result; },
            all: (...params: unknown[]) => { const result = statement.all(...params); pause(); return result; },
            values: (...params: unknown[]) => statement.values(...params),
            run: (...params: unknown[]) => statement.run(...params),
          };
        };
        if (data.role === "backfill") runMigrations(activeDb);
        else store.mergeRuntimeInto(data.originalId, data.replacementId);
        self.postMessage({ phase: "committed" });
      } catch (error) {
        self.postMessage({ phase: "error", error: String(error) });
      } finally {
        activeDb.close();
      }
    };
    self.postMessage({ phase: "ready" });
  } catch (error) {
    db?.close();
    self.postMessage({ phase: "error", error: String(error) });
  }
};
