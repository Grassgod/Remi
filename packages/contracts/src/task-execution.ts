function trimmed(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * The model and reasoning level a task will ACTUALLY execute with (MUL-336).
 *
 * An Agent's primary selection is a default, not a per-task constant: a recovery
 * chain that ran out of gateway capacity carries its fallback model as a task
 * override. Every layer that routes, freezes or dispatches the task — capability
 * checks, execution profiles, the daemon claim payload — must resolve the target
 * through here, or the override silently degrades back to the primary model.
 */
export function taskExecutionTarget(
  agent: {
    model?: string | null;
    thinkingLevel?: string | null;
    thinking_level?: string | null;
  } | null | undefined,
  task: {
    executionModel?: string | null;
    execution_model?: string | null;
    executionThinkingLevel?: string | null;
    execution_thinking_level?: string | null;
  } | null | undefined,
): { model: string | null; thinkingLevel: string | null } {
  return {
    model: trimmed(task?.executionModel ?? task?.execution_model) ?? trimmed(agent?.model),
    thinkingLevel: trimmed(task?.executionThinkingLevel ?? task?.execution_thinking_level)
      ?? trimmed(agent?.thinkingLevel ?? agent?.thinking_level),
  };
}

/**
 * The Agent as this task will execute it. Callers that hand an Agent to another
 * layer (the daemon's claim payload, runtime capability checks) must use this
 * rather than the stored Agent, otherwise a task override is lost.
 */
export function agentAtTaskTarget<
  A extends { model?: string | null; thinkingLevel?: string | null; thinking_level?: string | null },
  T,
>(agent: A, task: T): A {
  const target = taskExecutionTarget(agent, task as never);
  return { ...agent, model: target.model, thinkingLevel: target.thinkingLevel };
}

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
