import { afterEach, describe, expect, it } from "bun:test";
import { resolveDefaultWorkspaceIdForUser } from "@multiremi/api/helpers/workspace-context.js";
import { localAuthResponse } from "@multiremi/api/helpers/login.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("default workspace resolution", () => {
  it("uses a user's only active membership", () => {
    const store = createStore();
    const user = store.getOrCreateUser({ email: "single@example.test", name: "Single" });
    const workspace = store.createWorkspace({ name: "Single workspace", slug: "single-workspace" }, user.id);

    expect(resolveDefaultWorkspaceIdForUser(store, user.id)).toBe(workspace.id);
  });

  it("prefers owners, then the earliest membership, when a user has multiple workspaces", () => {
    const store = createStore();
    const user = store.getOrCreateUser({ email: "multiple@example.test", name: "Multiple" });
    const memberWorkspace = store.createWorkspace({ name: "Member workspace", slug: "member-workspace" });
    store.createWorkspaceMember({
      workspaceId: memberWorkspace.id,
      userId: user.id,
      name: user.name,
      role: "member",
    });
    const laterOwner = store.createWorkspace({ name: "Later owner", slug: "later-owner" }, user.id);
    const earlierOwner = store.createWorkspace({ name: "Earlier owner", slug: "earlier-owner" }, user.id);
    db!.run("UPDATE multiremi_workspace_members SET created_at = ? WHERE id = ?", [
      "2026-09-14T02:00:00.000Z",
      `mem_${laterOwner.id}_${user.id}`,
    ]);
    db!.run("UPDATE multiremi_workspace_members SET created_at = ? WHERE id = ?", [
      "2026-09-14T01:00:00.000Z",
      `mem_${earlierOwner.id}_${user.id}`,
    ]);

    expect(resolveDefaultWorkspaceIdForUser(store, user.id)).toBe(earlierOwner.id);
  });

  it("falls back to local when the user has no active membership", () => {
    const store = createStore();
    const user = store.getOrCreateUser({ email: "none@example.test", name: "None" });

    expect(resolveDefaultWorkspaceIdForUser(store, user.id)).toBe("local");
  });

  it("does not infer identity from legacy member row ids without a user_id link", () => {
    const store = createStore();
    const user = store.getOrCreateUser({ email: "unlinked@example.test", name: "Unlinked" });
    const attacker = store.getOrCreateUser({ email: "attacker@example.test", name: "Attacker" });
    const directIdWorkspace = store.createWorkspace(
      { name: "Direct id workspace", slug: "direct-id-workspace" },
      attacker.id,
    );
    const encodedIdWorkspace = store.createWorkspace(
      { name: "Encoded id workspace", slug: "encoded-id-workspace" },
      attacker.id,
    );
    store.createWorkspaceMember({
      id: user.id,
      workspaceId: directIdWorkspace.id,
      name: "Unlinked direct id",
    });
    store.createWorkspaceMember({
      id: `mem_${encodedIdWorkspace.id}_${user.id}`,
      workspaceId: encodedIdWorkspace.id,
      name: "Unlinked encoded id",
    });

    expect(resolveDefaultWorkspaceIdForUser(store, user.id)).toBe("local");
  });

  it("mints login tokens for the resolved member workspace", async () => {
    const store = createStore();
    const user = store.getOrCreateUser({ email: "returning@example.test", name: "Returning" });
    const workspace = store.createWorkspace({ name: "Returning workspace", slug: "returning-workspace" }, user.id);

    const login = await localAuthResponse(store, {
      email: user.email,
      name: user.name,
    });

    expect(await store.verifyAccessToken(login.token)).toMatchObject({
      userId: user.id,
      workspaceId: workspace.id,
    });
  });
});
