// Sibling test for packages/server/src/store/repos/workspaces-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { WorkspacesRepo } from "@multiremi/store/repos/workspaces-repo.js";

let db: Database | null = null;

function createRepo(): WorkspacesRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  const store = new MultiremiStore(db);
  return new WorkspacesRepo(new StoreContext(db, () => store));
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("WorkspacesRepo", () => {
  it("creates a workspace with a derived slug and issue prefix", () => {
    const repo = createRepo();
    const workspace = repo.createWorkspace({ name: "Repo Carve Team" });

    expect(workspace.slug).toBe("repo-carve-team");
    expect(workspace.issuePrefix).toBe("REP");
    expect(repo.getWorkspace(workspace.id)?.name).toBe("Repo Carve Team");
    expect(repo.listWorkspaces().map((entry) => entry.id)).toContain(workspace.id);
  });

  it("adds and archives a workspace member", () => {
    const repo = createRepo();
    const workspace = repo.createWorkspace({ name: "Members" });
    const member = repo.createWorkspaceMember({ workspaceId: workspace.id, name: "Ada", email: "ada@example.com" });

    expect(repo.getWorkspaceMember(member.id)?.name).toBe("Ada");
    expect(repo.listWorkspaceMembers(workspace.id).map((entry) => entry.id)).toContain(member.id);

    // The creator is the owner, so a second member can be archived without orphaning the workspace.
    expect(repo.archiveWorkspaceMember(member.id).archivedAt).toBeTruthy();
    expect(repo.listWorkspaceMembers(workspace.id).map((entry) => entry.id)).not.toContain(member.id);
  });

  it("mutes a notification group and reads it back", () => {
    const repo = createRepo();
    const updated = repo.updateNotificationPreferences({ workspaceId: "local", preferences: { comments: "muted" } });

    expect(updated.preferences.comments).toBe("muted");
    expect(repo.getNotificationPreferences({ workspaceId: "local" }).preferences.comments).toBe("muted");
  });
});
