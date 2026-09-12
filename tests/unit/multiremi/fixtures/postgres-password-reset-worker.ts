import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

let db: PostgresSyncDatabase;
let store: MultiremiStore;
let state: Int32Array;

self.onmessage = async (event: MessageEvent<{
  type: "init" | "reset";
  databaseUrl?: string;
  control?: SharedArrayBuffer;
  email?: string;
  password?: string;
}>) => {
  try {
    if (event.data.type === "init") {
      state = new Int32Array(event.data.control!);
      db = new PostgresSyncDatabase(event.data.databaseUrl!);
      store = new MultiremiStore(db);
      const run = db.run.bind(db);
      db.run = (sql, ...params) => {
        if (sql.includes("INSERT INTO multiremi_password_credentials")) {
          Atomics.store(state, 0, 1);
          Atomics.notify(state, 0);
        }
        return run(sql, ...params);
      };
      self.postMessage({ phase: "ready" });
      return;
    }
    await store.configurePasswordAccount({ email: event.data.email!, password: event.data.password! });
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
    self.postMessage({ phase: "reset" });
  } catch (error) {
    self.postMessage({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
};
