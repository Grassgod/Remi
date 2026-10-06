import { afterEach, it } from "bun:test";
import { deserializeSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import { assertRecoveryRevisions, assertRecreatedLegacyReceipt } from "./usage-reconciliation-revision-cases.js";
afterEach(resetMultiremiTestEnv);
it("assigns stronger plan revisions, preserves receipts in a DB copy, and rejects stale/narrow plans", async () => {
  const store = createLocalStore(), agent = store.createAgent({ name: "revision", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "revision evidence" });
  await assertRecoveryRevisions(store, db!, task.id, () => deserializeSqliteDatabase(db!.serialize(), { readonly: false }));
});
it("recreates a provisional legacy aggregate above its retained receipt floor", async () => {
  const store = createLocalStore(), agent = store.createAgent({ name: "legacy receipt", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "retained legacy receipt" });
  await assertRecreatedLegacyReceipt(store, db!, task.id);
});
