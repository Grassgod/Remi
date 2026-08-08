// Wire serializers for the workspaces domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import { createHash } from "node:crypto";
import type { MultiremiWorkspaceMember } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { relayForDaemonWire } from "./runtimes.js";

export function workspaceMemberToGoResponse(member: MultiremiWorkspaceMember, options: { includeUser?: boolean; includeName?: boolean } = {}): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: member.id,
    workspace_id: member.workspaceId,
    user_id: workspaceMemberUserId(member),
    role: member.role,
    created_at: member.createdAt,
  };
  // List responses include the display name (the web member/assignee filters call
  // member.name.toLowerCase()) but NOT email — the Go-compat list omits email.
  // Full user fields (incl. email) are only returned on the single-member update path.
  if (options.includeUser || options.includeName) {
    response.name = member.name;
    response.avatar_url = null;
  }
  if (options.includeUser) {
    response.email = member.email ?? "";
  }
  return response;
}

function workspaceMemberUserId(member: MultiremiWorkspaceMember): string {
  const prefix = `mem_${member.workspaceId}_`;
  return member.id.startsWith(prefix) ? member.id.slice(prefix.length) || member.id : member.id;
}

export function acceptedInvitationMemberToGoResponse(
  store: MultiremiStore,
  invitation: { workspaceId: string },
): Record<string, unknown> | { error: string; status: 500 } {
  const user = store.getCurrentUser();
  const member = store.getWorkspaceMember(`mem_${invitation.workspaceId}_${user.id}`);
  if (!member) return { error: "failed to accept invitation", status: 500 };
  return workspaceMemberToGoResponse(member, { includeUser: true });
}

// The success arm is a Record<string, unknown> (index signature), so `"error" in x`
// cannot discriminate the error sentinel; check the literal status instead.
export function isMemberResponseError(
  value: Record<string, unknown> | { error: string; status: 500 },
): value is { error: string; status: 500 } {
  return typeof value.error === "string" && value.status === 500;
}

export function memberRemovedPayload(member: MultiremiWorkspaceMember): Record<string, unknown> {
  return {
    member_id: member.id,
    workspace_id: member.workspaceId,
    user_id: workspaceMemberUserId(member),
  };
}

export function workspaceNamePayload(store: MultiremiStore, workspaceId: string): Record<string, unknown> {
  const workspace = store.getWorkspace(workspaceId);
  return workspace ? { workspace_name: workspace.name } : {};
}

export type WorkspaceRepoData = {
  url: string;
  description?: string;
};

export function workspaceReposResponse(
  store: MultiremiStore,
  workspaceId: string,
  includeRelaySecrets: boolean,
): {
  workspace_id: string;
  repos: WorkspaceRepoData[];
  repos_version: string;
  settings: Record<string, unknown>;
  relay: Record<string, unknown>;
} | null {
  const workspace = workspaceId === "local" ? store.ensureLocalWorkspace() : store.getWorkspace(workspaceId);
  if (!workspace) return null;
  const repos = normalizeWorkspaceRepos(workspace.repos);
  return {
    workspace_id: workspace.id,
    repos,
    repos_version: workspaceReposVersion(repos),
    settings: workspace.settings,
    // The relay payload carries PLAINTEXT gateway tokens — only a daemon token
    // may receive it. A human JWT hitting this path (member, not admin) must not.
    relay: includeRelaySecrets ? relayForDaemonWire(store, workspace.id) : {},
  };
}

function normalizeWorkspaceRepos(rawRepos: unknown[]): WorkspaceRepoData[] {
  const repos: WorkspaceRepoData[] = [];
  const seen = new Set<string>();
  for (const raw of rawRepos) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const description = typeof record.description === "string" ? record.description : "";
    repos.push(description ? { url, description } : { url });
  }
  return repos;
}

function workspaceReposVersion(repos: WorkspaceRepoData[]): string {
  const urls = repos.map((repo) => repo.url).filter(Boolean).sort();
  return createHash("sha256").update(urls.join("\n")).digest("hex");
}
