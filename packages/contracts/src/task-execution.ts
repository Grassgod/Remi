/** Independent delegations must not share a provider session or its context cursor. */
export function taskExecutionScope(task: {
  agentId?: string | null;
  agent_id?: string | null;
  delegatedByAgentId?: string | null;
  delegated_by_agent_id?: string | null;
  delegationId?: string | null;
  delegation_id?: string | null;
}): string {
  const delegator = task.delegatedByAgentId ?? task.delegated_by_agent_id;
  const agent = task.agentId ?? task.agent_id;
  return delegator && agent !== delegator
    ? task.delegationId ?? task.delegation_id ?? ""
    : "";
}
