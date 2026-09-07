// Workspaces / members / users / invitations / notification preferences domain, plus the
// workspace-scoped model-gateway relay config. Extracted verbatim from MultiremiStore
// (the facade delegates every public method here).
import { createId, nowIso } from "@multiremi/ids.js";
import {
  cleanOptionalString,
  hasAnyField,
  normalizeOptionalTimezone,
  nullableString,
  parseJson,
  toJson,
  uniqueRefMatch,
} from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import type {
  CreateWorkspaceInput,
  CreateWorkspaceInvitationInput,
  CreateWorkspaceMemberInput,
  MultiremiNotificationGroupKey,
  MultiremiNotificationPreferenceResponse,
  MultiremiNotificationPreferences,
  MultiremiUser,
  MultiremiWorkspace,
  MultiremiWorkspaceInvitation,
  MultiremiWorkspaceMember,
  UpdateMultiremiUserInput,
  UpdateWorkspaceMemberInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export type RelayEngine = "claude" | "codex";
export interface RelayEngineConfig {
  fragment: string;
  authToken: string;
  revision: number;
}
export interface RelayEngineBrowser {
  fragment: string;
  hasToken: boolean;
  revision: number;
}
export interface RelayConfigForDaemon {
  claude: RelayEngineConfig | null;
  codex: RelayEngineConfig | null;
  modelDiscovery: boolean;
}
export interface RelayConfigForBrowser {
  claude: RelayEngineBrowser | null;
  codex: RelayEngineBrowser | null;
  modelDiscovery: boolean;
}
export interface GatewayModelsSnapshot {
  models: Array<{ id: string; label: string }>;
  sourceRevision: number;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export class WorkspaceDaemonRetirementRequiredError extends Error {
  readonly code = "daemon_retirement_required";

  constructor(readonly daemonIds: string[]) {
    super(`Retire active daemons before deleting the workspace: ${daemonIds.join(", ")}`);
    this.name = "WorkspaceDaemonRetirementRequiredError";
  }
}

export class WorkspaceSshMeshCleanupRequiredError extends Error {
  readonly code = "ssh_mesh_cleanup_required";

  constructor(
    readonly enabled: boolean,
    readonly rotationState: string,
    readonly daemonIds: string[],
  ) {
    super(
      "Disable SSH Mesh and wait for every daemon to report disabled before deleting the workspace",
    );
    this.name = "WorkspaceSshMeshCleanupRequiredError";
  }
}

export class WorkspacesRepo {
  constructor(private ctx: StoreContext) {}

  createWorkspaceMember(input: CreateWorkspaceMemberInput): MultiremiWorkspaceMember {
    if (!input.name?.trim()) throw new Error("Member name is required");
    const id = input.id ?? createId("mem");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_workspace_members (
        id, workspace_id, user_id, name, email, role, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        input.workspaceId ?? "local",
        cleanOptionalString(input.userId) ?? null,
        input.name.trim(),
        input.email ?? null,
        input.role ?? "member",
        now,
        now,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  getWorkspaceMember(id: string): MultiremiWorkspaceMember | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_workspace_members WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspaceMember(row) : null;
  }

  getWorkspaceMemberByRef(ref: string, workspaceId?: string | null): MultiremiWorkspaceMember | null {
    const value = ref.trim();
    if (!value) return null;
    const exact = this.getWorkspaceMember(value);
    if (exact && !exact.archivedAt && (!workspaceId || exact.workspaceId === workspaceId)) return exact;
    return uniqueRefMatch(
      this.listWorkspaceMembers(workspaceId),
      value,
      (member) => member.id,
      (member) => [member.name, member.email],
    );
  }

  listWorkspaceMembers(workspaceId?: string | null): MultiremiWorkspaceMember[] {
    const rows = workspaceId
      ? this.ctx.db.query("SELECT * FROM multiremi_workspace_members WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name ASC").all(workspaceId) as Row[]
      : this.ctx.db.query("SELECT * FROM multiremi_workspace_members WHERE archived_at IS NULL ORDER BY workspace_id ASC, name ASC").all() as Row[];
    return rows.map(toWorkspaceMember);
  }

  updateWorkspaceMember(id: string, input: UpdateWorkspaceMemberInput): MultiremiWorkspaceMember {
    const current = this.getWorkspaceMember(id);
    if (!current) throw new Error(`Member not found: ${id}`);
    const nextWorkspaceId = input.workspaceId ?? current.workspaceId;
    const nextRole = input.role ?? current.role;
    if (!current.archivedAt && nextWorkspaceId !== current.workspaceId) {
      this.assertMemberHasNoActiveDaemonIdentity(current);
    }
    if (current.role === "owner" && (nextRole !== "owner" || nextWorkspaceId !== current.workspaceId)) {
      this.assertWorkspaceKeepsOwner(current);
    }
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_workspace_members SET
        workspace_id = ?,
        name = ?,
        email = ?,
        role = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        nextWorkspaceId,
        input.name ?? current.name,
        input.email === undefined ? current.email : input.email,
        nextRole,
        now,
        id,
      ],
    );
    return this.getWorkspaceMember(id)!;
  }

  archiveWorkspaceMember(id: string): MultiremiWorkspaceMember {
    const current = this.getWorkspaceMember(id);
    if (!current) throw new Error(`Member not found: ${id}`);
    if (!current.archivedAt) this.assertMemberHasNoActiveDaemonIdentity(current);
    if (current.role === "owner" && !current.archivedAt) this.assertWorkspaceKeepsOwner(current);
    const now = nowIso();
    const affectedProjects: Array<{ id: string; workspace_id: string }> = [];
    const tx = this.ctx.db.transaction(() => {
      affectedProjects.push(...this.ctx.db.query(
        `SELECT id, workspace_id FROM multiremi_projects
         WHERE default_assignee_type = 'member' AND default_assignee_id = ?`,
      ).all(id) as Array<{ id: string; workspace_id: string }>);
      this.ctx.db.run("UPDATE multiremi_workspace_members SET archived_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
      this.ctx.db.run(
        `UPDATE multiremi_projects
         SET default_assignee_type = NULL, default_assignee_id = NULL, updated_at = ?
         WHERE default_assignee_type = 'member' AND default_assignee_id = ?`,
        [now, id],
      );
    });
    tx();
    for (const project of affectedProjects) {
      this.ctx.emitWorkspaceEvent({
        type: "project:updated",
        workspaceId: project.workspace_id,
        actorType: "system",
        actorId: null,
        payload: {
          project: {
            id: project.id,
            default_assignee_type: null,
            default_assignee_id: null,
            updated_at: now,
          },
        },
      });
    }
    return this.getWorkspaceMember(id)!;
  }

  private assertMemberHasNoActiveDaemonIdentity(member: MultiremiWorkspaceMember): void {
    const ownerIds = [...new Set([member.userId, member.id].filter((value): value is string => Boolean(value)))];
    if (!ownerIds.length) return;
    const placeholders = ownerIds.map(() => "?").join(",");
    const rows = this.ctx.db.query(
      `SELECT daemon_id
       FROM multiremi_daemon_lifecycle_locks lifecycle
       WHERE lifecycle.workspace_id = ?
         AND lifecycle.owner_user_id IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_daemon_retirements retired
           WHERE retired.workspace_id = lifecycle.workspace_id
             AND retired.daemon_id = lifecycle.daemon_id
         )
       ORDER BY daemon_id ASC`,
    ).all(member.workspaceId, ...ownerIds) as Array<{ daemon_id: string }>;
    const daemonIds = [...new Set(rows.map((row) => String(row.daemon_id)).filter(Boolean))];
    if (daemonIds.length) {
      throw new Error(`member owns active daemons: ${daemonIds.join(", ")}; retire them before removing the member`);
    }
  }

  private assertWorkspaceKeepsOwner(member: MultiremiWorkspaceMember): void {
    const ownerCount = this.listWorkspaceMembers(member.workspaceId).filter((item) => item.role === "owner").length;
    if (ownerCount <= 1) throw new Error("workspace must have at least one owner");
  }

  getCurrentUser(userId?: string | null): MultiremiUser {
    const requestedId = cleanOptionalString(userId);
    if (requestedId && requestedId !== "local") {
      const user = this.getUser(requestedId);
      if (!user) throw new Error("user not found");
      return user;
    }
    const existing = this.getUser("local");
    if (existing) return existing;
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_users (
        id, name, email, avatar_url, language, timezone, onboarded_at,
        onboarding_questionnaire, starter_content_state, profile_description,
        created_at, updated_at
      ) VALUES ('local', 'Local User', 'local@multiremi.local', NULL, NULL, NULL, NULL, '{}', NULL, '', ?, ?)`,
      [now, now],
    );
    return this.getUser("local")!;
  }

  getUser(id: string): MultiremiUser | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_users WHERE id = ?").get(id) as Row | null;
    return row ? toUser(row) : null;
  }

  getUserByExternalId(externalId: string | null | undefined): MultiremiUser | null {
    const value = cleanOptionalString(externalId);
    if (!value) return null;
    const row = this.ctx.db.query("SELECT * FROM multiremi_users WHERE external_id = ?").get(value) as Row | null;
    return row ? toUser(row) : null;
  }

  getUserByFeishuUnionId(unionId: string | null | undefined): MultiremiUser | null {
    const value = cleanOptionalString(unionId);
    if (!value) return null;
    const row = this.ctx.db.query("SELECT * FROM multiremi_users WHERE feishu_union_id = ?").get(value) as Row | null;
    return row ? toUser(row) : null;
  }

  getUserByEmail(email: string | null | undefined): MultiremiUser | null {
    const value = cleanOptionalString(email)?.toLowerCase();
    if (!value) return null;
    const row = this.ctx.db.query("SELECT * FROM multiremi_users WHERE lower(email) = ?").get(value) as Row | null;
    return row ? toUser(row) : null;
  }

  // Resolve (or provision) the distinct user record behind a login identity.
  // Match order: cross-app Feishu union_id → legacy app-scoped open_id → email
  // → mint a new user. The open_id remains for compatibility with accounts
  // created before union_id was persisted.
  // Never rewrites a different user's id — each identity keeps its own record so
  // concurrent logins can't overwrite one another.
  getOrCreateUser(identity: {
    externalId?: string | null;
    feishuUnionId?: string | null;
    email?: string | null;
    name?: string | null;
  }): MultiremiUser {
    const externalId = cleanOptionalString(identity.externalId);
    const feishuUnionId = cleanOptionalString(identity.feishuUnionId);
    const email = cleanOptionalString(identity.email)?.toLowerCase() ?? null;
    const name = cleanOptionalString(identity.name);
    const byUnionId = feishuUnionId ? this.getUserByFeishuUnionId(feishuUnionId) : null;
    const byExternalId = externalId ? this.getUserByExternalId(externalId) : null;
    if (byUnionId && byExternalId && byUnionId.id !== byExternalId.id) {
      throw new Error("Feishu identity is already linked to another user");
    }
    let user = byUnionId ?? byExternalId;
    // Legacy/seed users may predate external_id; claim by email so we don't fork.
    // But never let an email match resolve to an account already bound to a
    // DIFFERENT external identity — that would let email login hijack an SSO user.
    if (!user && email) {
      const byEmail = this.getUserByEmail(email);
      if (byEmail && (!byEmail.externalId || byEmail.externalId === externalId)) user = byEmail;
    }
    if (user) return this.reconcileUserIdentity(user, { externalId, feishuUnionId, email, name });
    const id = createId("usr");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_users (
        id, external_id, feishu_union_id, name, email, avatar_url, language, timezone, onboarded_at,
        onboarding_questionnaire, starter_content_state, profile_description,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '{}', NULL, '', ?, ?)`,
      [id, externalId ?? null, feishuUnionId ?? null, name || email || "User", email ?? `${id}@multiremi.local`, now, now],
    );
    return this.getUser(id)!;
  }

  private reconcileUserIdentity(
    user: MultiremiUser,
    identity: {
      externalId?: string | null;
      feishuUnionId?: string | null;
      email?: string | null;
      name?: string | null;
    },
  ): MultiremiUser {
    const updates: string[] = [];
    const params: unknown[] = [];
    if (identity.externalId && user.externalId !== identity.externalId) {
      updates.push("external_id = ?");
      params.push(identity.externalId);
    }
    if (identity.feishuUnionId) {
      const current = this.ctx.db.query("SELECT feishu_union_id FROM multiremi_users WHERE id = ?").get(user.id) as Row | null;
      if (cleanOptionalString(current?.feishu_union_id) !== identity.feishuUnionId) {
        updates.push("feishu_union_id = ?");
        params.push(identity.feishuUnionId);
      }
    }
    if (identity.email && user.email.toLowerCase() !== identity.email) {
      updates.push("email = ?");
      params.push(identity.email);
    }
    const newName = identity.name && user.name !== identity.name ? identity.name : null;
    if (newName) {
      updates.push("name = ?");
      params.push(newName);
    }
    if (!updates.length) return user;
    updates.push("updated_at = ?");
    params.push(nowIso());
    params.push(user.id);
    this.ctx.db.run(`UPDATE multiremi_users SET ${updates.join(", ")} WHERE id = ?`, params);
    // Member rows denormalize the display name; sync them so pickers/member
    // lists don't keep showing a stale seed snapshot (e.g. "Local User").
    if (newName) {
      this.ctx.db.run(
        "UPDATE multiremi_workspace_members SET name = ?, updated_at = ? WHERE user_id = ? AND name <> ?",
        [newName, nowIso(), user.id, newName],
      );
    }
    return this.getUser(user.id)!;
  }

  // Real role of a user in a workspace, or null when they are not a member.
  // Matches on the explicit user_id link, falling back to the legacy
  // `mem_<ws>_<userId>` id convention for members created before user_id existed.
  getUserRoleInWorkspace(userId: string | null | undefined, workspaceId: string): string | null {
    return this.findWorkspaceMemberForUser(userId, workspaceId)?.role ?? null;
  }

  // Active member row for a user in a workspace, or null when they are not a
  // member. Accepts a user id, a member row id, or the legacy `mem_<ws>_<userId>`
  // convention — request identities carry user ids while subscriber/inbox APIs
  // key on member row ids, so callers must translate through here.
  findWorkspaceMemberForUser(userId: string | null | undefined, workspaceId: string): MultiremiWorkspaceMember | null {
    const uid = cleanOptionalString(userId);
    if (!uid) return null;
    return this.listWorkspaceMembers(workspaceId).find((m) =>
      m.userId === uid || m.id === uid || m.id === `mem_${workspaceId}_${uid}`
    ) ?? null;
  }

  listWorkspacesForUser(userId: string | null | undefined): MultiremiWorkspace[] {
    const uid = cleanOptionalString(userId);
    if (!uid) return [];
    return this.listWorkspaces().filter((ws) => this.getUserRoleInWorkspace(uid, ws.id) !== null);
  }

  updateCurrentUser(input: UpdateMultiremiUserInput, userId?: string | null): MultiremiUser {
    const current = this.getCurrentUser(userId);
    const name = input.name === undefined ? current.name : String(input.name).trim();
    if (!name) throw new Error("name is required");
    const email = input.email === undefined ? current.email : normalizeEmail(input.email);
    const language = hasAnyField(input, "language")
      ? normalizeOptionalLanguage(input.language)
      : current.language;
    const timezone = hasAnyField(input, "timezone")
      ? normalizeOptionalTimezone(input.timezone)
      : current.timezone;
    const profileDescription = hasAnyField(input, "profileDescription", "profile_description")
      ? String(input.profileDescription ?? input.profile_description ?? "").trim()
      : current.profileDescription;
    if ([...profileDescription].length > 2000) throw new Error("profile_description exceeds 2000 characters");
    const onboardingQuestionnaire = input.onboardingQuestionnaire ?? input.onboarding_questionnaire ?? current.onboardingQuestionnaire;
    const starterContentState = hasAnyField(input, "starterContentState", "starter_content_state")
      ? cleanOptionalString(input.starterContentState ?? input.starter_content_state)
      : current.starterContentState;
    const avatarUrl = hasAnyField(input, "avatarUrl", "avatar_url")
      ? cleanOptionalString(input.avatarUrl ?? input.avatar_url)
      : current.avatarUrl;
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_users SET
        name = ?,
        email = ?,
        avatar_url = ?,
        language = ?,
        timezone = ?,
        onboarding_questionnaire = ?,
        starter_content_state = ?,
        profile_description = ?,
        updated_at = ?
       WHERE id = ?`,
      [
        name,
        email,
        avatarUrl,
        language,
        timezone,
        toJson(onboardingQuestionnaire ?? {}),
        starterContentState,
        profileDescription,
        now,
        current.id,
      ],
    );
    return this.getUser(current.id)!;
  }

  patchCurrentUserOnboarding(questionnaire: Record<string, unknown>, userId?: string | null): MultiremiUser {
    return this.updateCurrentUser({ onboardingQuestionnaire: questionnaire }, userId);
  }

  markCurrentUserOnboarded(userId?: string | null): MultiremiUser {
    const id = this.getCurrentUser(userId).id;
    const now = nowIso();
    this.ctx.db.run(
      "UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?",
      [now, now, id],
    );
    return this.getUser(id)!;
  }

  listWorkspaces(): MultiremiWorkspace[] {
    const rows = this.ctx.db.query("SELECT * FROM multiremi_workspaces ORDER BY created_at ASC").all() as Row[];
    if (!rows.length) return [this.ensureLocalWorkspace()];
    return rows.map(toWorkspace);
  }

  getWorkspace(id: string): MultiremiWorkspace | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_workspaces WHERE id = ?").get(id) as Row | null;
    return row ? toWorkspace(row) : null;
  }

  createWorkspace(input: CreateWorkspaceInput, actingUserId?: string | null): MultiremiWorkspace {
    const name = String(input.name ?? "").trim();
    const slug = normalizeWorkspaceSlug(input.slug ?? slugifyWorkspaceName(name));
    if (!name || !slug) throw new Error("name and slug are required");
    const id = input.id ?? (slug === "local" ? "local" : createId("ws"));
    const now = nowIso();
    const issuePrefix = String(input.issuePrefix ?? input.issue_prefix ?? generateIssuePrefix(name)).trim().toUpperCase() || "MUL";
    this.ctx.db.run(
      `INSERT INTO multiremi_workspaces (
        id, name, slug, description, context, settings, repos, issue_prefix, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        slug,
        input.description ?? null,
        input.context ?? null,
        toJson(input.settings ?? {}),
        toJson(input.repos ?? []),
        issuePrefix,
        now,
        now,
      ],
    );
    // The authenticated creator (not the legacy "local" user) becomes the owner,
    // otherwise a new user could create a workspace they cannot access.
    const user = this.resolveActingUser(actingUserId);
    const memberId = `mem_${id}_${user.id}`;
    if (!this.getWorkspaceMember(memberId)) {
      this.createWorkspaceMember({
        id: memberId,
        workspaceId: id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: "owner",
      });
    }
    this.ctx.db.run("UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?", [now, now, user.id]);
    return this.getWorkspace(id)!;
  }

  updateWorkspace(id: string, input: Partial<CreateWorkspaceInput>): MultiremiWorkspace {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      const name = String(input.name ?? "").trim();
      if (!name) throw new Error("name is required");
      assignments.push("name = ?");
      values.push(name);
    }
    if (input.slug !== undefined) {
      assignments.push("slug = ?");
      values.push(normalizeWorkspaceSlug(input.slug));
    }
    if (input.description !== undefined) {
      assignments.push("description = ?");
      values.push(input.description);
    }
    if (input.context !== undefined) {
      assignments.push("context = ?");
      values.push(input.context);
    }
    if (input.settings !== undefined) {
      assignments.push("settings = ?");
      values.push(toJson(input.settings));
    }
    if (input.repos !== undefined) {
      assignments.push("repos = ?");
      values.push(toJson(input.repos));
    }
    if (input.issuePrefix !== undefined || input.issue_prefix !== undefined) {
      const issuePrefix = input.issuePrefix ?? input.issue_prefix;
      assignments.push("issue_prefix = ?");
      values.push(String(issuePrefix ?? "MUL").trim().toUpperCase() || "MUL");
    }
    assignments.push("updated_at = ?");
    values.push(nowIso(), id);
    const result = this.ctx.db.run(
      `UPDATE multiremi_workspaces SET ${assignments.join(", ")} WHERE id = ?`,
      values,
    );
    if (result.changes === 0) throw new Error(`Workspace not found: ${id}`);
    return this.getWorkspace(id)!;
  }

  deleteWorkspace(id: string): boolean {
    if (id === "local") throw new Error("local workspace cannot be deleted");
    return this.ctx.db.transaction(() => {
      if (!this.getWorkspace(id)) return false;
      this.ctx.lockWorkspaceRuntimeLifecycle(id);
      this.assertWorkspaceDaemonTrustRevoked(id);
      this.deleteWorkspaceScmState(id);
      const result = this.ctx.db.run("DELETE FROM multiremi_workspaces WHERE id = ?", [id]);
      if (result.changes === 0) return false;
      this.ctx.db.run("DELETE FROM multiremi_daemon_ssh_mesh_states WHERE workspace_id = ?", [id]);
      this.ctx.db.run("DELETE FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?", [id]);
      const now = nowIso();
      this.ctx.db.run("UPDATE multiremi_workspace_members SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE workspace_id = ?", [
        now,
        now,
        id,
      ]);
      return true;
    })();
  }

  private deleteWorkspaceScmState(workspaceId: string): void {
    const connectionIds = "SELECT id FROM multiremi_scm_connections WHERE workspace_id = ?";
    const eventIds = `SELECT id FROM multiremi_scm_events
      WHERE workspace_id = ? OR connection_id IN (${connectionIds})`;
    const changeRequestIds = `SELECT id FROM multiremi_scm_change_requests
      WHERE workspace_id = ? OR connection_id IN (${connectionIds})`;
    const now = nowIso();

    // Updating first takes the same connection-row lock used by polling claims.
    // Once this transaction commits, stale pollers cannot acquire another lease.
    this.ctx.db.run(
      "UPDATE multiremi_scm_connections SET enabled = 0, updated_at = ? WHERE workspace_id = ?",
      [now, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_event_deliveries WHERE event_id IN (${eventIds})`,
      [workspaceId, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_event_evidence WHERE event_id IN (${eventIds})`,
      [workspaceId, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_effects WHERE event_id IN (${eventIds})`,
      [workspaceId, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_events
       WHERE workspace_id = ? OR connection_id IN (${connectionIds})`,
      [workspaceId, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_issue_links
       WHERE workspace_id = ? OR change_request_id IN (${changeRequestIds})`,
      [workspaceId, workspaceId, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_change_requests
       WHERE workspace_id = ? OR connection_id IN (${connectionIds})`,
      [workspaceId, workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_sync_cursors WHERE connection_id IN (${connectionIds})`,
      [workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_entity_snapshots WHERE connection_id IN (${connectionIds})`,
      [workspaceId],
    );
    this.ctx.db.run(
      `DELETE FROM multiremi_scm_repository_bindings
       WHERE workspace_id = ? OR connection_id IN (${connectionIds})`,
      [workspaceId, workspaceId],
    );
    this.ctx.db.run("DELETE FROM multiremi_scm_connections WHERE workspace_id = ?", [workspaceId]);
  }

  private assertWorkspaceDaemonTrustRevoked(workspaceId: string): void {
    const activeDaemonRows = this.ctx.db.query(
      `SELECT identities.daemon_id
       FROM (
         SELECT daemon_id FROM multiremi_daemon_lifecycle_locks WHERE workspace_id = ?
         UNION
         SELECT daemon_id FROM multiremi_runtimes
         WHERE COALESCE(workspace_id, 'local') = ? AND daemon_id IS NOT NULL AND daemon_id != ''
         UNION
         SELECT daemon_id FROM multiremi_access_tokens
         WHERE workspace_id = ? AND type = 'daemon' AND daemon_id IS NOT NULL AND daemon_id != ''
           AND revoked_at IS NULL
       ) identities
       WHERE NOT EXISTS (
         SELECT 1 FROM multiremi_daemon_retirements retired
         WHERE retired.workspace_id = ? AND retired.daemon_id = identities.daemon_id
       )
       ORDER BY identities.daemon_id ASC`,
    ).all(workspaceId, workspaceId, workspaceId, workspaceId) as Array<{ daemon_id: string }>;
    const activeDaemonIds = [...new Set(activeDaemonRows.map((row) => String(row.daemon_id)).filter(Boolean))];
    if (activeDaemonIds.length) throw new WorkspaceDaemonRetirementRequiredError(activeDaemonIds);

    const config = this.ctx.db.query(
      `SELECT enabled, rotation_state,
              active_private_key_encrypted, active_public_key, active_fingerprint,
              previous_private_key_encrypted, previous_public_key, previous_fingerprint
       FROM multiremi_workspace_ssh_mesh WHERE workspace_id = ?`,
    ).get(workspaceId) as {
      enabled: number | boolean;
      rotation_state: string;
      active_private_key_encrypted: string | null;
      active_public_key: string | null;
      active_fingerprint: string | null;
      previous_private_key_encrypted: string | null;
      previous_public_key: string | null;
      previous_fingerprint: string | null;
    } | null;
    const unclearedStates = this.ctx.db.query(
      `SELECT daemon_id
       FROM multiremi_daemon_ssh_mesh_states
       WHERE workspace_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_daemon_retirements retired
           WHERE retired.workspace_id = multiremi_daemon_ssh_mesh_states.workspace_id
             AND retired.daemon_id = multiremi_daemon_ssh_mesh_states.daemon_id
         )
         AND (status NOT IN ('disabled', 'cleaned')
           OR public_key_installed != 0
           OR config_installed != 0)
       ORDER BY daemon_id ASC`,
    ).all(workspaceId) as Array<{ daemon_id: string }>;
    const unclearedDaemonIds = [...new Set(unclearedStates.map((row) => String(row.daemon_id)).filter(Boolean))];
    const enabled = Boolean(config?.enabled);
    const rotationState = String(config?.rotation_state ?? "stable");
    const hasKeyMaterial = Boolean(
      config?.active_private_key_encrypted
      || config?.active_public_key
      || config?.active_fingerprint
      || config?.previous_private_key_encrypted
      || config?.previous_public_key
      || config?.previous_fingerprint,
    );
    if (
      enabled
      || rotationState === "rolling_out"
      || (rotationState === "rekey_required" && hasKeyMaterial)
      || unclearedDaemonIds.length
    ) {
      throw new WorkspaceSshMeshCleanupRequiredError(enabled, rotationState, unclearedDaemonIds);
    }
  }

  leaveWorkspace(id: string, memberId = `mem_${id}_local`): boolean {
    const member = this.getWorkspaceMember(memberId) ?? this.listWorkspaceMembers(id).find((item) => item.email === this.getCurrentUser().email);
    if (!member || member.workspaceId !== id) return false;
    this.archiveWorkspaceMember(member.id);
    return true;
  }

  ensureLocalWorkspace(): MultiremiWorkspace {
    const existing = this.getWorkspace("local");
    if (existing) return existing;
    return this.createWorkspace({ id: "local", name: "Local Workspace", slug: "local", issuePrefix: "MUL" });
  }

  // ── Workspace env (task-session environment variables) ─────────
  // Stored in a dedicated column, NOT in `settings`: the settings object is
  // serialized verbatim to every member (GET /api/workspaces/:id) and to
  // daemons (workspaceReposResponse), while env values are secrets that only
  // workspace admins and the task claim path may read.

  getWorkspaceEnv(workspaceId: string): Record<string, string> {
    const row = this.ctx.db.query("SELECT env FROM multiremi_workspaces WHERE id = ?").get(workspaceId) as Row | null;
    if (!row) return {};
    const parsed = parseJson<Record<string, unknown>>(row.env, {});
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.trim()) env[key] = String(value ?? "");
    }
    return env;
  }

  setWorkspaceEnv(workspaceId: string, env: Record<string, string>): Record<string, string> {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    this.ctx.db.run(
      "UPDATE multiremi_workspaces SET env = ?, updated_at = ? WHERE id = ?",
      [toJson(env), nowIso(), workspaceId],
    );
    return this.getWorkspaceEnv(workspaceId);
  }

  // ── Model gateway: relay config ────────────────────────────────

  private relayRow(workspaceId: string, engine: RelayEngine): RelayEngineConfig | null {
    const row = this.ctx.db
      .query("SELECT fragment, auth_token, revision FROM multiremi_relay_config WHERE workspace_id = ? AND engine = ?")
      .get(workspaceId, engine) as Row | null;
    if (!row) return null;
    return {
      fragment: String(row.fragment ?? ""),
      authToken: String(row.auth_token ?? ""),
      revision: Number(row.revision ?? 0),
    };
  }

  /** Full config incl. plaintext tokens — daemon-facing only. */
  getRelayConfigForDaemon(workspaceId: string): RelayConfigForDaemon {
    return {
      claude: this.relayRow(workspaceId, "claude"),
      codex: this.relayRow(workspaceId, "codex"),
      modelDiscovery: this.getRelayModelDiscovery(workspaceId),
    };
  }

  /** Browser-facing: fragment (non-secret) is returned, token is masked to a boolean. */
  getRelayConfigForBrowser(workspaceId: string): RelayConfigForBrowser {
    const mask = (r: RelayEngineConfig | null): RelayEngineBrowser | null =>
      r ? { fragment: r.fragment, hasToken: r.authToken.length > 0, revision: r.revision } : null;
    return {
      claude: mask(this.relayRow(workspaceId, "claude")),
      codex: mask(this.relayRow(workspaceId, "codex")),
      modelDiscovery: this.getRelayModelDiscovery(workspaceId),
    };
  }

  revealRelayToken(workspaceId: string, engine: RelayEngine): string | null {
    return this.relayRow(workspaceId, engine)?.authToken ?? null;
  }

  /** Fragment must be pre-validated by the caller (whitelist + JSON/TOML). Returns the new revision. */
  upsertRelayConfig(
    workspaceId: string,
    engine: RelayEngine,
    input: { fragment: string; tokenOp: "keep" | "set" | "clear"; authToken?: string; actor?: string | null },
  ): number {
    const now = nowIso();
    let revision = 1;
    // Bump revision atomically at the DB so concurrent writers stay monotonic
    // (never two writers computing the same "existing + 1" in JS). The token for
    // "keep" is read inside the same transaction to avoid a lost update.
    this.ctx.db.transaction(() => {
      const existing = this.relayRow(workspaceId, engine);
      let token = existing?.authToken ?? "";
      if (input.tokenOp === "set") token = String(input.authToken ?? "");
      else if (input.tokenOp === "clear") token = "";
      this.ctx.db.run(
        `INSERT INTO multiremi_relay_config (workspace_id, engine, fragment, auth_token, revision, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(workspace_id, engine) DO UPDATE SET
           fragment = excluded.fragment,
           auth_token = excluded.auth_token,
           revision = multiremi_relay_config.revision + 1,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [workspaceId, engine, input.fragment, token, now, input.actor ?? null],
      );
      const row = this.ctx.db
        .query("SELECT revision FROM multiremi_relay_config WHERE workspace_id = ? AND engine = ?")
        .get(workspaceId, engine) as Row | null;
      revision = Number(row?.revision ?? 1);
    })();
    return revision;
  }

  getRelayModelDiscovery(workspaceId: string): boolean {
    const settings = this.getWorkspace(workspaceId)?.settings as Record<string, unknown> | undefined;
    return Boolean(settings?.relay_model_discovery);
  }

  setRelayModelDiscovery(workspaceId: string, enabled: boolean): void {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const settings = { ...(workspace.settings as Record<string, unknown>), relay_model_discovery: !!enabled };
    this.updateWorkspace(workspaceId, { settings });
  }

  // ── Model gateway: server-discovered model snapshot ────────────

  getGatewayModels(workspaceId: string, engine: RelayEngine): GatewayModelsSnapshot | null {
    const row = this.ctx.db
      .query("SELECT * FROM multiremi_gateway_models WHERE workspace_id = ? AND engine = ?")
      .get(workspaceId, engine) as Row | null;
    if (!row) return null;
    return {
      models: parseJson<Array<{ id: string; label: string }>>(row.models, []),
      sourceRevision: Number(row.source_revision ?? 0),
      lastSuccessAt: nullableString(row.last_success_at),
      lastError: nullableString(row.last_error),
    };
  }

  /** Revision fencing: never let a stale discovery run overwrite a newer config's result. */
  saveGatewayModels(
    workspaceId: string,
    engine: RelayEngine,
    input: { models?: Array<{ id: string; label: string }>; sourceRevision: number; error?: string | null },
  ): void {
    const now = nowIso();
    // Read the fence and write in one transaction so a slow, stale discovery run
    // can never overwrite a newer config's result (TOCTOU on source_revision).
    this.ctx.db.transaction(() => {
      const existing = this.getGatewayModels(workspaceId, engine);
      if (existing && input.sourceRevision < existing.sourceRevision) return;
      const success = input.models !== undefined;
      const models = success ? input.models! : existing?.models ?? [];
      const lastSuccessAt = success ? now : existing?.lastSuccessAt ?? null;
      // On a FAILED discovery keep the source_revision of the last SUCCESS, so a
      // stale catalog can never masquerade as freshly discovered for a new config.
      const sourceRevision = success ? input.sourceRevision : (existing?.sourceRevision ?? input.sourceRevision);
      this.ctx.db.run(
        `INSERT INTO multiremi_gateway_models (workspace_id, engine, models, source_revision, last_success_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, engine) DO UPDATE SET
           models = excluded.models,
           source_revision = excluded.source_revision,
           last_success_at = excluded.last_success_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
        [workspaceId, engine, toJson(models), sourceRevision, lastSuccessAt, input.error ?? null, now],
      );
    })();
  }

  createWorkspaceInvitation(workspaceId: string, input: CreateWorkspaceInvitationInput, inviterUserId?: string | null): MultiremiWorkspaceInvitation {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const email = String(input.email ?? input.inviteeEmail ?? input.invitee_email ?? "").trim().toLowerCase();
    if (!email) throw new Error("email is required");
    const role = normalizeWorkspaceInvitationRole(input.role ?? "member");
    if (role === "owner") throw new Error("cannot invite as owner");
    const currentUser = this.resolveActingUser(inviterUserId);
    if (email === currentUser.email.toLowerCase()) {
      const existingMember = this.listWorkspaceMembers(workspaceId).find((member) => member.email?.toLowerCase() === email);
      if (existingMember) throw new Error("user is already a member");
    }
    this.expireStalePendingInvitations(workspaceId, email);
    const now = nowIso();
    const pending = this.ctx.db.query(
      `SELECT * FROM multiremi_workspace_invitations
       WHERE workspace_id = ? AND invitee_email = ? AND status = 'pending' AND expires_at > ?`,
    ).get(workspaceId, email, now) as Row | null;
    if (pending) throw new Error("invitation already pending for this email");
    const id = createId("inv");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.ctx.db.run(
      `INSERT INTO multiremi_workspace_invitations (
        id, workspace_id, inviter_id, invitee_email, invitee_user_id, role, status,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        workspaceId,
        currentUser.id,
        email,
        email === currentUser.email.toLowerCase() ? currentUser.id : null,
        role,
        expiresAt,
        now,
        now,
      ],
    );
    return this.hydrateInvitation(this.getInvitation(id)!)!;
  }

  listWorkspaceInvitations(workspaceId: string): MultiremiWorkspaceInvitation[] {
    const now = nowIso();
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_workspace_invitations
       WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC`,
    ).all(workspaceId, now) as Row[];
    return rows.map((row) => this.hydrateInvitation(toInvitation(row))!);
  }

  // Resolve the user acting on a request. The API passes the authenticated user
  // id so invitation accept/decline/list operate on the real person; falling back
  // to the local user keeps CLI/single-user flows working.
  private resolveActingUser(actingUserId?: string | null): MultiremiUser {
    const uid = cleanOptionalString(actingUserId);
    if (uid) {
      const user = this.getUser(uid);
      if (user) return user;
    }
    return this.getCurrentUser();
  }

  listCurrentUserInvitations(actingUserId?: string | null): MultiremiWorkspaceInvitation[] {
    const user = this.resolveActingUser(actingUserId);
    const now = nowIso();
    const rows = this.ctx.db.query(
      `SELECT * FROM multiremi_workspace_invitations
       WHERE status = 'pending' AND (invitee_user_id = ? OR invitee_email = ?)
       AND expires_at > ?
       ORDER BY created_at DESC`,
    ).all(user.id, user.email.toLowerCase(), now) as Row[];
    return rows.map((row) => this.hydrateInvitation(toInvitation(row))!);
  }

  getInvitation(id: string): MultiremiWorkspaceInvitation | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_workspace_invitations WHERE id = ?").get(id) as Row | null;
    return row ? toInvitation(row) : null;
  }

  revokeWorkspaceInvitation(workspaceId: string, invitationId: string): boolean {
    const invitation = this.getInvitation(invitationId);
    if (!invitation || invitation.workspaceId !== workspaceId || invitation.status !== "pending") return false;
    this.updateInvitationStatus(invitationId, "revoked");
    return true;
  }

  acceptInvitation(invitationId: string, actingUserId?: string | null): MultiremiWorkspaceInvitation | null {
    const invitation = this.hydrateInvitation(this.getInvitation(invitationId));
    if (!invitation || invitation.status !== "pending") return null;
    const user = this.resolveActingUser(actingUserId);
    if (invitation.inviteeEmail !== user.email.toLowerCase() && invitation.inviteeUserId !== user.id) {
      throw new Error("invitation does not belong to you");
    }
    if (Date.parse(invitation.expiresAt) <= Date.now()) throw new Error("invitation has expired");
    const memberId = `mem_${invitation.workspaceId}_${user.id}`;
    if (this.getWorkspaceMember(memberId)) throw new Error("you are already a member of this workspace");
    const accepted = this.updateInvitationStatus(invitationId, "accepted");
    this.createWorkspaceMember({
      id: memberId,
      workspaceId: invitation.workspaceId,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: invitation.role,
    });
    const now = nowIso();
    this.ctx.db.run("UPDATE multiremi_users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?", [now, now, user.id]);
    return this.hydrateInvitation(accepted)!;
  }

  declineInvitation(invitationId: string, actingUserId?: string | null): MultiremiWorkspaceInvitation | null {
    const invitation = this.getInvitation(invitationId);
    if (!invitation || invitation.status !== "pending") return null;
    const user = this.resolveActingUser(actingUserId);
    if (invitation.inviteeEmail !== user.email.toLowerCase() && invitation.inviteeUserId !== user.id) {
      throw new Error("invitation does not belong to you");
    }
    return this.hydrateInvitation(this.updateInvitationStatus(invitationId, "declined"))!;
  }

  private updateInvitationStatus(invitationId: string, status: MultiremiWorkspaceInvitation["status"]): MultiremiWorkspaceInvitation {
    const now = nowIso();
    this.ctx.db.run("UPDATE multiremi_workspace_invitations SET status = ?, updated_at = ? WHERE id = ?", [status, now, invitationId]);
    return this.getInvitation(invitationId)!;
  }

  private expireStalePendingInvitations(workspaceId: string, email: string): void {
    const now = nowIso();
    this.ctx.db.run(
      `UPDATE multiremi_workspace_invitations
       SET status = 'expired', updated_at = ?
       WHERE workspace_id = ? AND invitee_email = ? AND status = 'pending' AND expires_at <= ?`,
      [now, workspaceId, email, now],
    );
  }

  private hydrateInvitation(invitation: MultiremiWorkspaceInvitation | null): MultiremiWorkspaceInvitation | null {
    if (!invitation) return null;
    const inviter = this.getUser(invitation.inviterId);
    const workspace = this.getWorkspace(invitation.workspaceId);
    return {
      ...invitation,
      inviterName: inviter?.name,
      inviter_name: inviter?.name,
      inviterEmail: inviter?.email,
      inviter_email: inviter?.email,
      workspaceName: workspace?.name,
      workspace_name: workspace?.name,
    };
  }

  getNotificationPreferences(input: { workspaceId?: string | null; memberId?: string | null } = {}): MultiremiNotificationPreferenceResponse {
    const workspaceId = input.workspaceId ?? "local";
    const memberId = input.memberId ?? null;
    const row = this.ctx.db.query(
      "SELECT * FROM multiremi_notification_preferences WHERE workspace_id = ? AND member_id = ?",
    ).get(workspaceId, memberId ?? "") as Row | null;
    return {
      workspaceId,
      memberId,
      preferences: row ? normalizeNotificationPreferences(parseJson(row.preferences, {})) : {},
      updatedAt: row ? String(row.updated_at ?? "") : null,
    };
  }

  updateNotificationPreferences(input: {
    workspaceId?: string | null;
    memberId?: string | null;
    preferences: MultiremiNotificationPreferences;
  }): MultiremiNotificationPreferenceResponse {
    const workspaceId = input.workspaceId ?? "local";
    const memberId = input.memberId ?? null;
    const preferences = normalizeNotificationPreferences(input.preferences);
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO multiremi_notification_preferences (workspace_id, member_id, preferences, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, member_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`,
      [workspaceId, memberId ?? "", toJson(preferences), now],
    );
    return this.getNotificationPreferences({ workspaceId, memberId });
  }
}

const NOTIFICATION_GROUPS: MultiremiNotificationGroupKey[] = [
  "assignments",
  "status_changes",
  "comments",
  "updates",
  "feishu_messages",
  "agent_activity",
  "system_notifications",
];

function normalizeNotificationPreferences(value: unknown): MultiremiNotificationPreferences {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const normalized: MultiremiNotificationPreferences = {};
  for (const group of NOTIFICATION_GROUPS) {
    const pref = raw[group];
    if (pref === "all" || pref === "muted") normalized[group] = pref;
  }
  return normalized;
}

const SUPPORTED_USER_LANGUAGES = new Set(["en", "zh-Hans", "zh-Hant", "ja", "ko"]);
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeOptionalLanguage(value: unknown): string | null {
  const language = String(value ?? "").trim();
  if (!language) return null;
  if (!SUPPORTED_USER_LANGUAGES.has(language)) throw new Error("unsupported language");
  return language;
}

function normalizeWorkspaceSlug(value: unknown): string {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!slug) return "";
  if (!WORKSPACE_SLUG_RE.test(slug)) throw new Error("slug must contain only lowercase letters, numbers, and hyphens");
  return slug;
}

function slugifyWorkspaceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function generateIssuePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  if (!letters) return "WS";
  return letters.slice(0, Math.min(letters.length, 3));
}

function normalizeWorkspaceInvitationRole(value: unknown): string {
  const role = String(value ?? "member").trim().toLowerCase() || "member";
  if (role === "owner" || role === "admin" || role === "member") return role;
  throw new Error("invalid member role");
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) throw new Error("email is required");
  if (email.length > 254) throw new Error("email is too long");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  return email;
}

function toWorkspaceMember(row: Row): MultiremiWorkspaceMember {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id ?? "local"),
    userId: nullableString(row.user_id),
    name: String(row.name),
    email: nullableString(row.email),
    role: String(row.role ?? "member"),
    archivedAt: nullableString(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toUser(row: Row): MultiremiUser {
  const onboardingQuestionnaire = parseJson<Record<string, unknown>>(row.onboarding_questionnaire, {});
  return {
    id: String(row.id),
    externalId: nullableString(row.external_id),
    external_id: nullableString(row.external_id),
    name: String(row.name),
    email: String(row.email),
    avatarUrl: nullableString(row.avatar_url),
    avatar_url: nullableString(row.avatar_url),
    language: nullableString(row.language),
    timezone: nullableString(row.timezone),
    onboardedAt: nullableString(row.onboarded_at),
    onboarded_at: nullableString(row.onboarded_at),
    onboardingQuestionnaire,
    onboarding_questionnaire: onboardingQuestionnaire,
    starterContentState: nullableString(row.starter_content_state),
    starter_content_state: nullableString(row.starter_content_state),
    profileDescription: String(row.profile_description ?? ""),
    profile_description: String(row.profile_description ?? ""),
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
  };
}

function toWorkspace(row: Row): MultiremiWorkspace {
  const settings = parseJson<Record<string, unknown>>(row.settings, {});
  const repos = parseJson<unknown[]>(row.repos, []);
  const issuePrefix = String(row.issue_prefix ?? "MUL");
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: nullableString(row.description),
    context: nullableString(row.context),
    settings,
    repos,
    issuePrefix,
    issue_prefix: issuePrefix,
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
  };
}

function toInvitation(row: Row): MultiremiWorkspaceInvitation {
  const status = String(row.status ?? "pending") as MultiremiWorkspaceInvitation["status"];
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspace_id: String(row.workspace_id),
    inviterId: String(row.inviter_id),
    inviter_id: String(row.inviter_id),
    inviteeEmail: String(row.invitee_email),
    invitee_email: String(row.invitee_email),
    inviteeUserId: nullableString(row.invitee_user_id),
    invitee_user_id: nullableString(row.invitee_user_id),
    role: String(row.role ?? "member"),
    status,
    createdAt: String(row.created_at),
    created_at: String(row.created_at),
    updatedAt: String(row.updated_at),
    updated_at: String(row.updated_at),
    expiresAt: String(row.expires_at),
    expires_at: String(row.expires_at),
  };
}
