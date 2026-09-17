import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { MultiremiChatSession } from "@multiremi/contracts/types.js";
import { selectChatLocalDirectory } from "@multiremi/contracts/chat-local-directory.js";
import type { StoreContext } from "@multiremi/store/context.js";

const PREFIX = "chat-workspace:";
export interface ChatWorkspaceLineage {
  executionFingerprint?: string | null;
  workDir?: string | null;
  runtimeId?: string | null;
}

export function parseChatWorkspaceFingerprint(value: string | null | undefined): { revision: string; mode: "local" | "managed"; base: string } | null {
  if (value?.startsWith("chat-workspace-transition-")) value = value.slice(value.indexOf(":") + 1);
  if (!value?.startsWith(PREFIX)) return null;
  const match = /^chat-workspace:([a-f0-9]+):(local|managed):(.*)$/.exec(value);
  return match ? { revision: match[1]!, mode: match[2] as "local" | "managed", base: match[3]! } : null;
}

/** Project resources are mutable even though a Chat's Project binding is fixed.
 * Capture the assignment in the existing execution fingerprint. A changed
 * assignment retires that Chat's local-directory use; it never grants access to
 * a replacement path or host. Only newly created Chats adopt that assignment. */
export function resolveChatWorkspace(ctx: StoreContext, chat: MultiremiChatSession | null, source?: ChatWorkspaceLineage) {
  if (!chat?.projectId || ctx.feishuBot().getFeishuIssueIdForChatSession(chat.id)) return null;
  const project = ctx.projects().getProject(chat.projectId);
  const available = Boolean(project && !project.archivedAt && project.workspaceId === chat.workspaceId);
  const resources = available ? ctx.projects().listProjectResources(chat.projectId) : [];
  const selected = selectChatLocalDirectory(resources);
  const assignment = selected ? { ...selected, path: posix.normalize(selected.path) } : null;
  const revision = createHash("sha256").update(JSON.stringify({ project: chat.projectId, available, assignment })).digest("hex");
  let lineage: ChatWorkspaceLineage = source ?? { executionFingerprint: chat.sessionExecutionFingerprint,
    workDir: chat.workDir, runtimeId: chat.sessionRuntimeId };
  if (!lineage.executionFingerprint && !lineage.workDir) {
    const previous = ctx.db.query(`SELECT execution_fingerprint, work_dir, runtime_id FROM multiremi_tasks
      WHERE chat_session_id = ? AND issue_id IS NULL AND execution_fingerprint IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(chat.id) as Record<string, unknown> | null;
    if (previous) lineage = { executionFingerprint: String(previous.execution_fingerprint),
      workDir: previous.work_dir ? String(previous.work_dir) : null, runtimeId: previous.runtime_id ? String(previous.runtime_id) : null };
  }
  const snapshot = parseChatWorkspaceFingerprint(lineage.executionFingerprint);
  const runtime = lineage.runtimeId ? ctx.runtimes().getRuntime(lineage.runtimeId) : null;
  const matchesAssignment = Boolean(lineage.workDir && assignment &&
    assignment.path === posix.normalize(lineage.workDir!)
      && (assignment.daemon === runtime?.daemonId || assignment.daemon === runtime?.legacyDaemonId));
  // Legacy rows do not record the assignment. This is only a migration hint;
  // the daemon separately proves containment in its own root before any use.
  const legacyManaged = Boolean(lineage.workDir?.replaceAll("\\", "/").endsWith(`/chats/${chat.id}`));
  const hasLegacyLineage = Boolean(lineage.executionFingerprint || lineage.workDir);
  const changed = snapshot ? snapshot.revision !== revision || Boolean(snapshot.mode === "local" && lineage.workDir && !matchesAssignment)
    : hasLegacyLineage && (!available || Boolean(lineage.workDir && !matchesAssignment && !legacyManaged));
  const mode = !available || changed || snapshot?.mode === "managed" || legacyManaged || !assignment ? "managed" : "local";
  return { revision, mode, changed, available, assignment,
    fingerprint: (base: string) => `${PREFIX}${revision}:${mode}:${parseChatWorkspaceFingerprint(base)?.base ?? base}` };
}

export function chatWorkspaceLineageCurrent(ctx: StoreContext, chat: MultiremiChatSession | null, source?: ChatWorkspaceLineage): boolean {
  return !resolveChatWorkspace(ctx, chat, source)?.changed;
}
