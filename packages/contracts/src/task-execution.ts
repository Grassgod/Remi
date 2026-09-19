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
  const agentModel = trimmed(agent?.model);
  const executionModel = trimmed(task?.executionModel ?? task?.execution_model);
  const explicitLevel = trimmed(task?.executionThinkingLevel ?? task?.execution_thinking_level);
  // The Agent's reasoning level belongs to the Agent's OWN model. A task that
  // executes a different model (a fallback recovery) must not inherit it: the
  // level was chosen for the primary model and the model this task really runs
  // may not support it, which leaves the task with no Runtime able to claim it
  // and it waits forever instead of recovering. A null level means "whatever
  // the model's own default is", which is exactly what a switched task needs.
  const runsAgentModel = executionModel == null || executionModel === agentModel;
  return {
    model: executionModel ?? agentModel,
    thinkingLevel: explicitLevel
      ?? (runsAgentModel ? trimmed(agent?.thinkingLevel ?? agent?.thinking_level) : null),
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
