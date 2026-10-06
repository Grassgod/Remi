import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { agentCompatibilityResponse } from "@multiremi/api/wire/agents.js";
import { canCurrentUserAccessAgent, denyCurrentUserWorkspaceAccess, requestedAgentWorkspaceId } from "@multiremi/api/helpers.js";
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

describe("S9-6 compatibility list hot reads", () => {
  it("agents preserve old wire, structured/inline order, visibility, archive aliases and secret masks", async () => {
    const { resource, store, fixture, owner, reader, app } = await setup();
    const ids = fixture.agentIds;
    resource.db.run("UPDATE multiremi_agents SET skills = ?, custom_env = ?, mcp_config = ? WHERE id = ?", [JSON.stringify([{ name: "inline", description: "fallback", content: "inline body" }]), '{"fixture_key":"fixture_value"}', '{"servers":{}}', ids[1]!]);
    store.archiveAgent(ids[2]!);
    const foreign = store.createWorkspace({ id: "ws_s96_foreign", name: "Foreign" });
    store.createAgent({ id: "agt_s96_foreign", name: "Foreign", provider: "codex", workspaceId: foreign.id, ownerId: fixture.ownerUserId });
    app.get("/api/s96-legacy-agents", c => {
      const workspaceId = requestedAgentWorkspaceId(c, store);
      if (workspaceId instanceof Response) return workspaceId;
      const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId); if (denied) return denied;
      return c.json(store.listAgents({ includeArchived: c.req.query("include_archived") === "true" || c.req.query("includeArchived") === "true" })
        .filter(agent => agent.workspaceId === workspaceId && canCurrentUserAccessAgent(c, store, agent))
        .map(agent => agentCompatibilityResponse(store, agent, c)));
    });
    const member = store.findWorkspaceMemberForUser(fixture.readerUserId, "local")!;
    for (const role of ["member", "admin", "owner"] as const) {
      store.updateWorkspaceMember(member.id, { role });
      for (const redact of [false, true]) {
        resource.db.run("UPDATE multiremi_workspaces SET settings = ? WHERE id = 'local'", [JSON.stringify({ always_redact_env: redact })]);
        for (const token of [owner.token, reader.token, "list-fixture-root"]) {
          for (const query of ["", "?include_archived=true", "?includeArchived=true", "?workspace_id=ws_s96_foreign"]) {
            for (const agentHeader of [false, true]) {
              const headers = { Authorization: `Bearer ${token}`, "X-Workspace-ID": "local", ...(agentHeader ? { "X-Agent-ID": ids[1]! } : {}) };
              const actual = await app.request(`/api/agents${query}`, { headers });
              const legacy = await app.request(`/api/s96-legacy-agents${query}`, { headers });
              expect(actual.status).toBe(legacy.status);
              expect(await actual.json()).toEqual(await legacy.json());
            }
          }
        }
      }
    }
    let skillReads = 0, fileReads = 0;
    const originalQuery = resource.db.query.bind(resource.db);
    resource.db.query = ((sql: string) => { if (/FROM multiremi_skills s/.test(sql)) skillReads++; if (/FROM multiremi_skill_files/.test(sql)) fileReads++; return originalQuery(sql); }) as typeof resource.db.query;
    const response = await app.request("/api/agents?includeArchived=true", { headers: { Authorization: `Bearer ${owner.token}`, "X-Workspace-ID": "local" } });
    expect(response.status).toBe(200); expect(skillReads).toBe(1); expect(fileReads).toBe(0);
  }, 30_000);

});
