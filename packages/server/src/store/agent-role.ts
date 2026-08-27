import type { MultiremiAgentRole } from "@multiremi/contracts/types.js";

export const AGENT_ROLES = ["normal", "maintainer", "supervisor"] as const;

const AGENT_ROLE_RANK: Record<MultiremiAgentRole, number> = {
  normal: 0,
  maintainer: 1,
  supervisor: 2,
};

export function isAgentRole(value: unknown): value is MultiremiAgentRole {
  return typeof value === "string" && AGENT_ROLES.includes(value as MultiremiAgentRole);
}

export function normalizeStoredAgentRole(value: unknown, legacySupervisor = false): MultiremiAgentRole {
  if (isAgentRole(value)) return value;
  return legacySupervisor ? "supervisor" : "normal";
}

export function agentRoleAtLeast(role: MultiremiAgentRole, required: MultiremiAgentRole): boolean {
  return AGENT_ROLE_RANK[role] >= AGENT_ROLE_RANK[required];
}
