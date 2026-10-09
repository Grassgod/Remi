/**
 * MUL-409 fix round 4 (QA round 3, suggestion 3): a genuine two-connection race
 * between a member's forced start and the automatic start.
 *
 * QA's round-3 probe used two independent Bun processes with their own Postgres
 * connections and a file barrier. This worker is the same shape inside a
 * `Worker`: its own `PostgresSyncDatabase`, its own connection, and a file
 * barrier so both sides issue their write at the same moment.
 *
 * Role `force` sends `{status: todo, force: true}`; `comment` and `rerun` drive
 * MUL-458's real HTTP entry points; role `auto` accepts the prerequisite's
 * submitted delivery as its designated human.
 * Every worker owns its own bridge and connection and reports its maximum
 * transaction depth to the parent.
 */
import { existsSync } from "node:fs";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

interface RaceInput {
  databaseUrl: string;
  issueId: string;
  prerequisiteId: string;
  agentId?: string;
  prerequisiteDelivery?: { id: string; revision: string; memberId: string } | null;
  barrierPath: string;
  role: "force" | "comment" | "rerun" | "owner_request" | "auto";
}

self.onmessage = async (message: MessageEvent<RaceInput>) => {
  const { databaseUrl, issueId, prerequisiteId, agentId, prerequisiteDelivery, barrierPath, role } = message.data;
  const db = new PostgresSyncDatabase(databaseUrl);
  const store = new MultiremiStore(db);
  try {
    db.resetTransactionDepthStats();
    self.postMessage({ phase: "ready" });
    // Wait for the parent to release both workers in the same tick.
    const deadline = Date.now() + 30_000;
    while (!existsSync(barrierPath)) {
      if (Date.now() > deadline) throw new Error("barrier timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let responseStatus: number | null = null;
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
      responseStatus = response.status;
      if (response.status !== 200 && response.status !== 409) {
        throw new Error(`unexpected force response ${response.status}`);
      }
    } else if (role === "comment") {
      const app = createMultiremiApp({ store });
      const response = await app.request(`/api/sessions/${store.getOrCreateDefaultIssueSession(issueId).id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body_md: "Concurrent human comment", message_kind: "request", to: { type: "role", ref: "issue_owner" } }),
      });
      responseStatus = response.status;
      if (response.status !== 200) throw new Error(`unexpected comment response ${response.status}`);
    } else if (role === "rerun" || role === "owner_request") {
      if (!agentId) throw new Error("rerun role requires agentId");
      const app = createMultiremiApp({ store });
      const response = await app.request(`/api/sessions/${store.getOrCreateDefaultIssueSession(issueId).id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body_md: "Concurrent rerun", message_kind: "request", to: role === "owner_request" ? { type: "role", ref: "issue_owner" } : { type: "agent", ref: agentId } }),
      });
      responseStatus = response.status;
      if (response.status !== 200) throw new Error(`unexpected rerun response ${response.status}`);
    } else {
      if (!prerequisiteDelivery) throw new Error("auto role requires an explicit submitted prerequisite delivery");
      try {
        store.respondIssueDelivery(prerequisiteId, prerequisiteDelivery.id,
          { action: "accept", revision: prerequisiteDelivery.revision },
          { type: "member", id: prerequisiteDelivery.memberId });
        responseStatus = 200;
      } catch {
        // Same: a refusal is a valid outcome for the arbitration loser.
        responseStatus = 409;
      }
    }
    self.postMessage({ phase: "done", role, responseStatus, maxTransactionDepth: db.maxTransactionDepth });
  } catch (error) {
    self.postMessage({ phase: "error", error: String(error) });
  } finally {
    db.close();
  }
};
