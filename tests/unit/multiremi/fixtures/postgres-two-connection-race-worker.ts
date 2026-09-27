/**
 * MUL-409 fix round 4 (QA round 3, suggestion 3): a genuine two-connection race
 * between a member's forced start and the automatic start.
 *
 * QA's round-3 probe used two independent Bun processes with their own Postgres
 * connections and a file barrier. This worker is the same shape inside a
 * `Worker`: its own `PostgresSyncDatabase`, its own connection, and a file
 * barrier so both sides issue their write at the same moment.
 *
 * Role `force` sends `{status: todo, force: true}` through the store; role `auto`
 * marks the prerequisite done, which is what triggers the automatic start. Both
 * arbitrate on the same conditional `backlog -> todo` claim, so exactly one may
 * queue a round and exactly one may write its start activity.
 */
import { existsSync } from "node:fs";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

interface RaceInput {
  databaseUrl: string;
  issueId: string;
  prerequisiteId: string;
  barrierPath: string;
  role: "force" | "auto";
}

self.onmessage = async (message: MessageEvent<RaceInput>) => {
  const { databaseUrl, issueId, prerequisiteId, barrierPath, role } = message.data;
  const db = new PostgresSyncDatabase(databaseUrl);
  const store = new MultiremiStore(db);
  try {
    self.postMessage({ phase: "ready" });
    // Wait for the parent to release both workers in the same tick.
    const deadline = Date.now() + 30_000;
    while (!existsSync(barrierPath)) {
      if (Date.now() > deadline) throw new Error("barrier timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (role === "force") {
      // The PRODUCT entry point: member PATCH through the real route, which is
      // the only place `force` is accepted from outside. Calling the store
      // directly would skip the route's assign-on-update step and measure a
      // shape no caller can produce.
      const app = createMultiremiApp({ store });
      const response = await app.request(`/api/issues/${issueId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "todo", force: true }),
      });
      if (response.status !== 200 && response.status !== 409) {
        throw new Error(`unexpected force response ${response.status}`);
      }
    } else {
      try {
        store.updateIssue(prerequisiteId, { status: "done" });
      } catch {
        // Same: a refusal is a valid outcome for the arbitration loser.
      }
    }
    self.postMessage({ phase: "done" });
  } catch (error) {
    self.postMessage({ phase: "error", error: String(error) });
  } finally {
    db.close();
  }
};
