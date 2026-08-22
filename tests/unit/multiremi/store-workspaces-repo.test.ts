// Sibling test for packages/server/src/store/repos/workspaces-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { WorkspacesRepo } from "@multiremi/store/repos/workspaces-repo.js";

let db: Database | null = null;
const previousScmEncryptionKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;

function createFixture(): { repo: WorkspacesRepo; store: MultiremiStore } {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  const store = new MultiremiStore(db);
  return { repo: new WorkspacesRepo(new StoreContext(db, () => store)), store };
}

function createRepo(): WorkspacesRepo {
  return createFixture().repo;
}

afterEach(() => {
  db?.close();
  db = null;
  if (previousScmEncryptionKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = previousScmEncryptionKey;
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

  it("does not overwrite repositories when a concurrent partial workspace update commits", () => {
    const repo = createRepo();
    const workspace = repo.createWorkspace({
      name: "Concurrent workspace",
      repos: [{ id: "repo_original", url: "https://github.com/acme/original.git" }],
    });
    db!.exec(`
      CREATE TRIGGER inject_repository_update
      BEFORE UPDATE OF description ON multiremi_workspaces
      WHEN OLD.id = '${workspace.id}'
      BEGIN
        UPDATE multiremi_workspaces
        SET repos = '[{"id":"repo_concurrent","url":"https://github.com/acme/concurrent.git"}]'
        WHERE id = OLD.id;
      END
    `);

    repo.updateWorkspace(workspace.id, { description: "updated independently" });

    expect(repo.getWorkspace(workspace.id)).toMatchObject({
      description: "updated independently",
      repos: [{ id: "repo_concurrent", url: "https://github.com/acme/concurrent.git" }],
    });
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

  it("deletes every workspace SCM record in the workspace deletion transaction", () => {
    const { repo, store } = createFixture();
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    const workspace = repo.createWorkspace({ id: "ws_scm_cleanup", name: "SCM Cleanup" });
    store.updateWorkspace(workspace.id, {
      repos: [{
        id: "repo_cleanup",
        name: "cleanup",
        url: "git@github.com:acme/cleanup.git",
        source: "github",
        default_branch: "main",
      }],
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    const connection = store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
      accessToken: "workspace-secret",
    });
    store.upsertScmSyncCursor({
      connectionId: connection.id,
      repositoryId: "repo_cleanup",
      stream: "change_requests",
      baselineCompletedAt: "2026-08-22T00:00:00.000Z",
    });
    const issue = store.createIssue({ title: "Clean SCM state", workspaceId: workspace.id });
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_cleanup",
      entityType: "change_request",
      externalId: "17",
      revisionAt: "2026-08-22T00:00:01.000Z",
      revision: "17-merged",
      contentHash: "17-merged",
      payload: {
        number: 17,
        title: `${issue.key} merged cleanup`,
        state: "merged",
        source_branch: "feature/cleanup",
        target_branch: "main",
      },
    });
    const event = store.recordScmCanonicalEvent({
      workspaceId: workspace.id,
      connectionId: connection.id,
      repositoryId: "repo_cleanup",
      type: "change.merged",
      subjectType: "change_request",
      subjectId: "17",
      logicalKey: "change.merged:repo_cleanup:17:merge-sha",
      fidelity: "inferred",
      observedAt: "2026-08-22T00:00:02.000Z",
      payload: { id: "17", number: 17, branch: "main" },
      evidence: { source: "poll", dedupeKey: "poll:repo_cleanup:17:merge-sha" },
    }).event;
    const agent = store.createAgent({
      name: "Cleanup observer",
      provider: "codex",
      workspaceId: workspace.id,
    });
    const autopilot = store.createAutopilot({
      title: "Cleanup automation",
      workspaceId: workspace.id,
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "scm_event",
      eventConfig: { resource: "scm", events: ["change.merged"], repositoryIds: ["repo_cleanup"] },
    });
    db!.run(
      `INSERT INTO multiremi_scm_event_deliveries (
        id, event_id, trigger_id, status, attempt_count, available_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ["sed_cleanup", event.id, trigger.id, event.observedAt, event.createdAt, event.createdAt],
    );

    expect(store.listScmConnections({ workspaceId: workspace.id })).toHaveLength(1);
    expect(repo.deleteWorkspace(workspace.id)).toBe(true);
    expect(repo.getWorkspace(workspace.id)).toBeNull();
    expect(store.listScmConnections({ workspaceId: workspace.id })).toEqual([]);
    for (const table of [
      "multiremi_scm_connections",
      "multiremi_scm_repository_bindings",
      "multiremi_scm_sync_cursors",
      "multiremi_scm_entity_snapshots",
      "multiremi_scm_change_requests",
      "multiremi_scm_issue_links",
      "multiremi_scm_events",
      "multiremi_scm_effects",
      "multiremi_scm_event_evidence",
      "multiremi_scm_event_deliveries",
    ]) {
      expect(db!.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("rolls back SCM cleanup when workspace deletion cannot finish", () => {
    const { repo, store } = createFixture();
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
    const workspace = repo.createWorkspace({ id: "ws_scm_rollback", name: "SCM Rollback" });
    store.updateWorkspace(workspace.id, {
      repos: [{ id: "repo_rollback", name: "rollback", url: "git@github.com:acme/rollback.git", source: "github" }],
    });
    const connection = store.createScmConnection({
      workspaceId: workspace.id,
      name: "GitHub",
      provider: "github",
      mode: "poll",
      accessToken: "workspace-secret",
    });
    store.upsertScmSyncCursor({
      connectionId: connection.id,
      repositoryId: "repo_rollback",
      stream: "change_requests",
    });
    db!.exec(`
      CREATE TRIGGER fail_workspace_scm_cleanup
      BEFORE DELETE ON multiremi_scm_connections
      WHEN OLD.workspace_id = 'ws_scm_rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced SCM cleanup failure');
      END
    `);

    expect(() => repo.deleteWorkspace(workspace.id)).toThrow("forced SCM cleanup failure");
    expect(repo.getWorkspace(workspace.id)).not.toBeNull();
    expect(store.getScmConnection(connection.id)).toMatchObject({ enabled: true });
    expect(store.getScmSyncCursor(connection.id, "repo_rollback", "change_requests")).not.toBeNull();
  });
});
