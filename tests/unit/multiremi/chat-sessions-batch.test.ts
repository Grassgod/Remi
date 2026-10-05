import { expect, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { chatSessionCompatibilityResponse } from "../../../packages/server/src/api/wire/chat.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { hotspotProbe, instrumentHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-pr2-fixture.js";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture.js";

test("chat lists batch access reads and preserve every native/compatibility field and order", async () => {
  const database = await openHotspotDatabase();
  const probe = hotspotProbe();
  const db = instrumentHotspotDatabase(database.db, probe);
  const store = new MultiremiStore(db);
  try {
    const f = seedFirstScreenHotspotsFixture(store, { sessions: 100, agents: 20, issues: 3, inboxRows: 0,
      skillBodyBytes: 16384, run: (sql, params) => db.run(sql, params) });
    store.updateChatSession(f.sessionIds[1]!, { status: "archived", pinned: true });
    store.updateChatSession(f.sessionIds[2]!, { pinned: true });
    const credential = await store.createAccessToken({ name: "batch golden", type: "pat", userId: f.readerUserId, workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "batch-golden" });
    for (const status of ["", "all", "archived"]) {
      // The pre-optimization path is the reference, including private Agent denial.
      const expected = store.listChatSessions("local", { creatorId: f.readerUserId, includeArchived: Boolean(status) })
        .filter(s => (!status || status !== "archived" || s.status === "archived") && !store.isFeishuTransportChatSession(s.id))
        .filter(s => {
          const a = store.getAgent(s.agentId);
          return a && a.workspaceId === s.workspaceId && (a.visibility !== "private" || a.ownerId === f.readerUserId);
        });
      for (const native of [false, true]) {
        probe.reset();
        const response = await app.request(`${native ? "/api/multiremi/chats" : "/api/chat/sessions"}${status ? `?status=${status}` : ""}`, {
          headers: { Authorization: `Bearer ${credential.token}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(JSON.parse(JSON.stringify(native
          ? { sessions: expected, total: expected.length } : expected.map(chatSessionCompatibilityResponse))));
        expect(probe.statements).toBeLessThanOrEqual(20);
        expect(probe.sql.some(sql => sql.includes("multiremi_skill_files"))).toBe(false);
        expect(probe.sql.filter(sql => sql.includes("FROM multiremi_agents"))).toHaveLength(1);
      }
    }
  } finally { await database.dispose(); }
});
