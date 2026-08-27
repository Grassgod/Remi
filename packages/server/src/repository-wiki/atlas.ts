import type { MultiremiAgent, MultiremiAutopilot } from "@multiremi/contracts/types.js";
import { agentRoleAtLeast } from "@multiremi/store/agent-role.js";

export const ATLAS_AGENT_NAME = "Atlas · LLM Wiki";
export const ATLAS_PROJECT_AUTOPILOT_TITLE = "Atlas · Project Knowledge";
export const ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE = "Atlas · Repository Wiki";
export const ATLAS_PROJECT_AUTOPILOT_KIND = "atlas_project_knowledge" as const;
export const ATLAS_REPOSITORY_WIKI_AUTOPILOT_KIND = "atlas_repository_wiki" as const;

/**
 * Resolve the server-owned Repository Wiki automation. Authorization comes
 * from its stable server-managed kind and the assigned Agent's role. Names and
 * titles are deliberately display-only.
 */
export function resolveAtlasRepositoryWikiAutopilot(
  workspaceId: string,
  agents: readonly Pick<MultiremiAgent, "id" | "role" | "workspaceId">[],
  autopilots: readonly Pick<
    MultiremiAutopilot,
    "id" | "title" | "managedKind" | "workspaceId" | "assigneeType" | "assigneeId"
  >[],
): Pick<
  MultiremiAutopilot,
  "id" | "title" | "managedKind" | "workspaceId" | "assigneeType" | "assigneeId"
> | null {
  const autopilot = autopilots.find((candidate) =>
    candidate.workspaceId === workspaceId
    && candidate.managedKind === ATLAS_REPOSITORY_WIKI_AUTOPILOT_KIND
    && candidate.assigneeType === "agent"
  ) ?? null;
  if (!autopilot) return null;
  const assignee = agents.find((agent) =>
    agent.id === autopilot.assigneeId && agent.workspaceId === workspaceId
  );
  return assignee && agentRoleAtLeast(assignee.role, "maintainer") ? autopilot : null;
}
