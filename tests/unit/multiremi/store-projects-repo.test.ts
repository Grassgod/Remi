// Sibling test for packages/server/src/store/repos/projects-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { ProjectsRepo } from "@multiremi/store/repos/projects-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): ProjectsRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new ProjectsRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("ProjectsRepo", () => {
  it("creates a project and finds it by search", () => {
    const repo = createRepo();
    const project = repo.createProject({ title: "Atlas", description: "mapping the fleet", workspaceId: "local" });

    expect(repo.getProject(project.id)?.title).toBe("Atlas");
    expect(repo.listProjects("local").map((entry) => entry.id)).toContain(project.id);
    expect(repo.searchProjects({ q: "atlas", workspaceId: "local" }).projects.map((entry) => entry.id)).toEqual([project.id]);
    expect(repo.updateProject(project.id, { status: "in_progress" }).status).toBe("in_progress");
  });

  it("binds, resolves and clears a project default assignee", () => {
    const repo = createRepo();
    const agent = store!.createAgent({ name: "Claude", provider: "claude" });
    const squad = store!.createSquad({ name: "Ops squad", leaderId: agent.id });

    // Type is inferred from the sqd_ prefix when omitted.
    const project = repo.createProject({ title: "Atlas", workspaceId: "local", defaultAssigneeId: squad.id });
    expect(project.defaultAssigneeType).toBe("squad");
    expect(project.defaultAssigneeId).toBe(squad.id);

    // Unrelated updates leave the binding alone.
    expect(repo.updateProject(project.id, { title: "Atlas 2" }).defaultAssigneeId).toBe(squad.id);

    // Snake-case (compat wire) fields switch the default to an agent.
    const switched = repo.updateProject(project.id, { default_assignee_type: "agent", default_assignee_id: agent.id });
    expect(switched.defaultAssigneeType).toBe("agent");
    expect(switched.defaultAssigneeId).toBe(agent.id);

    // Explicit nulls clear it.
    const cleared = repo.updateProject(project.id, { defaultAssigneeType: null, defaultAssigneeId: null });
    expect(cleared.defaultAssigneeType).toBeNull();
    expect(cleared.defaultAssigneeId).toBeNull();

    // Unknown or half-specified refs are rejected.
    expect(() => repo.createProject({ title: "Bad", defaultAssigneeType: "squad", defaultAssigneeId: "sqd_missing" }))
      .toThrow("Squad not found: sqd_missing");
    expect(() => repo.updateProject(project.id, { defaultAssigneeType: "agent", defaultAssigneeId: null }))
      .toThrow("Assignee id is required when assignee type is provided");
  });

  it("keeps legacy project status writes in sync with archive state", () => {
    const repo = createRepo();
    const archived = repo.createProject({ title: "Legacy archive", status: "cancelled" });
    expect(archived.archivedAt).not.toBeNull();
    expect(repo.searchProjects({ q: "legacy archive" }).total).toBe(0);

    const restored = repo.updateProject(archived.id, { status: "in_progress" });
    expect(restored.archivedAt).toBeNull();
    expect(repo.searchProjects({ q: "legacy archive" }).total).toBe(1);

    const completed = repo.updateProject(archived.id, { status: "completed" });
    expect(completed.archivedAt).not.toBeNull();
  });

  it("revisions a project doc and seeds the reserved _schema doc", () => {
    const repo = createRepo();
    const project = repo.createProject({ title: "Docs", workspaceId: "local" });

    const doc = repo.createProjectDoc(project.id, { kind: "wiki", title: "Deploy runbook", body: "step one" });
    expect(doc.version).toBe(1);
    // Writing the first real doc seeds `_schema` alongside it.
    expect(repo.getProjectDocByRef(project.id, "_schema")).not.toBeNull();

    const updated = repo.updateProjectDoc(project.id, doc.slug, { body: "step one\nstep two" });
    expect(updated.version).toBe(2);
    expect(repo.listProjectDocRevisions(doc.id).map((rev) => rev.version)).toEqual([2, 1]);
    expect(repo.searchProjectDocs(project.id, "runbook").map((entry) => entry.id)).toEqual([doc.id]);
  });

  it("pins a project and rejects a cross-workspace target", () => {
    const repo = createRepo();
    const project = repo.createProject({ title: "Pinned", workspaceId: "local" });

    const pin = repo.createPinnedItem({ itemType: "project", itemId: project.id, workspaceId: "local", userId: "local" });
    expect(repo.listPinnedItems("local", "local").map((entry) => entry.id)).toEqual([pin.id]);
    expect(() => repo.createPinnedItem({ itemType: "project", itemId: project.id, workspaceId: "local", userId: "local" }))
      .toThrow("Item already pinned");
    expect(() => repo.createPinnedItem({ itemType: "project", itemId: project.id, workspaceId: "other", userId: "local" }))
      .toThrow(`Project not found: ${project.id}`);

    repo.deletePinnedItem("local", "local", "project", project.id);
    expect(repo.listPinnedItems("local", "local")).toEqual([]);
  });
});
