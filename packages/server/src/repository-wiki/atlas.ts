import type { MultiremiAgent, MultiremiAutopilot } from "@multiremi/contracts/types.js";

export const ATLAS_AGENT_NAME = "Atlas · LLM Wiki";
export const ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE = "Atlas · Repository Wiki";

/**
 * Resolve the server-owned Repository Wiki automation. Its identity is the
 * workspace's canonical Atlas agent plus the reserved title; the title alone
 * is user-controlled and is not an ownership boundary.
 */
export function resolveAtlasRepositoryWikiAutopilot(
  workspaceId: string,
  agents: readonly Pick<MultiremiAgent, "id" | "name" | "workspaceId">[],
  autopilots: readonly Pick<
    MultiremiAutopilot,
    "id" | "title" | "workspaceId" | "assigneeType" | "assigneeId"
  >[],
): Pick<
  MultiremiAutopilot,
  "id" | "title" | "workspaceId" | "assigneeType" | "assigneeId"
> | null {
  const atlas = agents.find((agent) =>
    agent.workspaceId === workspaceId && agent.name === ATLAS_AGENT_NAME
  );
  if (!atlas) return null;
  return autopilots.find((autopilot) =>
    autopilot.workspaceId === workspaceId
    && autopilot.title === ATLAS_REPOSITORY_WIKI_AUTOPILOT_TITLE
    && autopilot.assigneeType === "agent"
    && autopilot.assigneeId === atlas.id
  ) ?? null;
}
