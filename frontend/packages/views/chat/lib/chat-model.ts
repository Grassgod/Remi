import type { Agent, AgentTask, RuntimeModel, RuntimeModelThinking } from "@multiremi/core/types";
import { modelThinkingLevels } from "@multiremi/core/runtimes";
import { executionModel } from "@multiremi/shared/agent-execution";

/**
 * What the composer's read-only model chip shows: the model the chat runs on
 * and its reasoning effort. Pure; the chip localizes the default and the hints.
 */
export interface ChatModelDisplay {
  /** The model id; null when the agent sets none and the runtime's default decides. */
  modelId: string | null;
  /** The catalog's display name for `modelId`; null shows the id itself. */
  label: string | null;
  /** The effort's catalog label, or the raw token; null when none is set. */
  effort: string | null;
  /** The running turn switched to the agent's fallback model (ADR 0010 recovery). */
  fallback: boolean;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * The chat's running attempt in the workspace task snapshot, which carries the
 * attempt's own execution model and fallback flag. Matched by attempt id, or by
 * turn while the pending task still names the attempt a recovery replaced.
 */
export function runningChatTask(
  snapshot: readonly AgentTask[] | undefined,
  sessionId: string | null,
  pending: { task_id?: string; turn_id?: string } | null | undefined,
): AgentTask | null {
  if (!snapshot || !sessionId || !pending?.task_id) return null;
  const active = snapshot.filter((task) => task.chat_session_id === sessionId && !TERMINAL_TASK_STATUSES.has(task.status));
  return active.find((task) => task.id === pending.task_id)
    ?? (pending.turn_id ? active.find((task) => task.turn_id === pending.turn_id) : undefined)
    ?? null;
}

/**
 * The agent's configured model and effort, unless the running turn switched to
 * the fallback model: then the model that turn actually runs on. A switch is
 * read only from the task's own fields, never inferred from the agent's config.
 */
export function chatModelDisplay({
  agent,
  models = [],
  defaultThinking,
  runningTask,
}: {
  agent: Pick<Agent, "model" | "thinking_level">;
  /** The provider's catalog, as the agent settings read it; empty when unknown. */
  models?: readonly RuntimeModel[];
  defaultThinking?: RuntimeModelThinking;
  runningTask?: AgentTask | null;
}): ChatModelDisplay {
  const switchedModel = runningTask && (runningTask.fallback_switched === true || runningTask.fallbackSwitched === true)
    ? [runningTask.execution_model, runningTask.executionModel].map(executionModel).find(Boolean) ?? null
    : null;
  const fallback = !!switchedModel;
  const modelId = fallback ? switchedModel : executionModel(agent.model);
  const effortToken = fallback
    ? text(runningTask?.execution_thinking_level) ?? text(runningTask?.executionThinkingLevel)
    : text(agent.thinking_level);
  const entry = modelId ? models.find((model) => model.id === modelId) : undefined;
  const label = text(entry?.label);
  const effort = effortToken
    ? text(modelThinkingLevels([...models], modelId ?? "", defaultThinking)
      .find((level) => level.value === effortToken)?.label) ?? effortToken
    : null;
  return { modelId, label: label && label !== modelId ? label : null, effort, fallback };
}
