import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture";

const resources: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
afterEach(async () => { for (const resource of resources.splice(0)) await resource.dispose(); });

async function setup() {
  const resource = await openHotspotDatabase(); resources.push(resource);
  const store = new MultiremiStore(resource.db);
  const fixture = seedFirstScreenHotspotsFixture(store, { sessions: 0, agents: 5, issues: 2, inboxRows: 0, run: (sql, params) => resource.db.run(sql, params) });
  const owner = await store.createAccessToken({ name: "list owner", type: "pat", userId: fixture.ownerUserId, workspaceId: "local" });
  const reader = await store.createAccessToken({ name: "list reader", type: "pat", userId: fixture.readerUserId, workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "list-fixture-root" });
  return { resource, store, fixture, owner, reader, app };
}

describe("S9-6 project summary projection", () => {
  it("projects preserve all summary fields/counts/order and errors while excluding instruction bodies", async () => {
    const { resource, store, fixture, owner, reader, app } = await setup();
    const a = store.createProject({ id: "prj_s96_a", title: "A", description: null, instructions: "large instructions", deltaInstructions: "delta", workspaceId: "local" });
    const b = store.createProject({ id: "prj_s96_b", title: "B", status: "completed", priority: "high", workspaceId: "local" });
    resource.db.run("UPDATE multiremi_issues SET project_id = ?, status = 'done' WHERE id = ?", [a.id, fixture.issueIds[0]!]);
    resource.db.run("UPDATE multiremi_issues SET project_id = ?, status = 'open' WHERE id = ?", [a.id, fixture.issueIds[1]!]);
    resource.db.run("UPDATE multiremi_projects SET updated_at = ? WHERE id = ?", ["2026-10-05T00:00:00Z", b.id]);
    const optimized = store.listProjectSummaries.bind(store);
    for (const token of [owner.token, reader.token, "list-fixture-root"]) {
      for (const query of ["", "?workspace_id=ws_missing"]) {
        const read = () => app.request(`/api/projects${query}`, { headers: { Authorization: `Bearer ${token}`, "X-Workspace-ID": "local" } });
        const actual = await read(); store.listProjectSummaries = workspaceId => store.listProjects(workspaceId);
        try { const legacy = await read(); expect(actual.status).toBe(legacy.status); expect(await actual.json()).toEqual(await legacy.json()); }
        finally { store.listProjectSummaries = optimized; }
      }
    }
    let bytes = 0;
    const originalQuery = resource.db.query.bind(resource.db);
    resource.db.query = ((sql: string) => { const statement = originalQuery(sql); if (!sql.includes("FROM multiremi_projects p")) return statement;
      return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key); if (key === "all") return (...params: unknown[]) => { const rows = value.apply(target, params); bytes += Buffer.byteLength(JSON.stringify(rows)); return rows; }; return typeof value === "function" ? value.bind(target) : value; } });
    }) as typeof resource.db.query;
    const summaries = optimized("local"); const small = bytes;
    expect(summaries.find(project => project.id === a.id)).toMatchObject({ issueCount: 2, doneCount: 1, description: null });
    resource.db.run("UPDATE multiremi_projects SET instructions = ?, delta_instructions = ? WHERE id = ?", ["x".repeat(65536), "y".repeat(65536), a.id]);
    bytes = 0; expect(optimized("local")).toEqual(summaries); expect(bytes).toBe(small);
    const detail = await app.request(`/api/projects/${a.id}`, { headers: { Authorization: `Bearer ${owner.token}`, "X-Workspace-ID": "local" } });
    expect(detail.status).toBe(200); expect((await detail.json()).instructions).toBe("x".repeat(65536));
  }, 30_000);
});
