// Mid-run steering support for the task worker: a per-run feed that polls the
// server for unconsumed steer messages, the injection prompt the run loop
// sends into the live provider session, and multi-turn usage accumulation.
import type { MultiremiTaskSteerMessage, TaskUsageEntry } from "@multiremi/contracts/types.js";

export const DEFAULT_STEER_POLL_MS = 2500;
export const DEFAULT_FORCE_ANSWER_GRACE_MS = 3 * 60 * 1000;

export interface TaskSteerSource {
  listPendingTaskSteerMessages(taskId: string): Promise<MultiremiTaskSteerMessage[]>;
}

/**
 * Polls the server for unconsumed steer messages during one task run.
 *
 * The run loop drains arrivals with {@link take} between provider turns and
 * registers an interrupt callback while a turn is streaming so a mid-turn
 * steer can soft-cancel the turn (ACP `session/cancel`) and be injected as
 * the next prompt on the same provider session. The feed only observes —
 * marking messages consumed stays with the run loop, after injection.
 */
export class TaskSteerFeed {
  private queue: MultiremiTaskSteerMessage[] = [];
  private seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;
  private interrupt: (() => void) | null = null;

  constructor(
    private readonly source: TaskSteerSource,
    private readonly taskId: string,
    private readonly pollMs: number = DEFAULT_STEER_POLL_MS,
    private readonly onError?: (err: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    // Poll immediately: a steer submitted before the run reached this point
    // must not wait a full interval (or be missed entirely by a short run).
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, Math.max(250, this.pollMs));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.interrupt = null;
  }

  /**
   * Register the current turn's soft-interrupt (or null between turns). Fires
   * immediately when messages already queued up between turns, so a steer
   * that raced the previous drain still interrupts promptly.
   */
  setInterrupt(fn: (() => void) | null): void {
    this.interrupt = fn;
    if (fn && this.queue.length) fn();
  }

  /** Drain everything received so far, oldest first. */
  take(): MultiremiTaskSteerMessage[] {
    return this.queue.splice(0);
  }

  /**
   * Mark ids handled outside the feed (the run loop's authoritative fetch
   * observed and processed them directly). Pins them in `seen` and drops any
   * queued copies, so a poll that was already in flight when the ids were
   * handled cannot re-enqueue them — a stale duplicate in the queue would
   * fire the next turn's interrupt and cancel it for nothing.
   */
  markHandled(ids: Iterable<string>): void {
    const handled = new Set(ids);
    if (!handled.size) return;
    for (const id of handled) this.seen.add(id);
    if (this.queue.length) this.queue = this.queue.filter((m) => !handled.has(m.id));
  }

  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  private async poll(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const messages = await this.source.listPendingTaskSteerMessages(this.taskId);
      let arrived = false;
      for (const message of messages) {
        if (this.seen.has(message.id)) continue;
        this.seen.add(message.id);
        this.queue.push(message);
        arrived = true;
      }
      if (arrived) this.interrupt?.();
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.fetching = false;
    }
  }
}

/**
 * The prompt injected into the live provider session for a batch of steer
 * messages. The session keeps its full transcript, so the wrapper only has to
 * reframe: apply the user's mid-run directive and keep going — or, for
 * force-answer, stop and deliver.
 */
export function buildSteerInjectionPrompt(messages: MultiremiTaskSteerMessage[]): string {
  const steers = messages.filter((m) => m.kind !== "force_answer");
  const force = messages.filter((m) => m.kind === "force_answer");
  const parts: string[] = [];
  if (steers.length) {
    parts.push(
      "[Mid-run user steering] The user sent new instructions while this task was running:",
      ...steers.map((m) => `- ${m.content}`),
    );
  }
  if (force.length) {
    const notes = force.map((m) => m.content.trim()).filter(Boolean);
    parts.push(
      "[Deliver now] The user asked for the result immediately. Stop exploring and stop making new changes. "
        + "Based on the work completed so far, produce your best final conclusion and wrap up the task now.",
      ...(notes.length ? notes.map((note) => `- ${note}`) : []),
    );
  }
  parts.push(
    force.length
      ? "Close out directly: summarize what was done, state your conclusion, and finish."
      : "Incorporate these instructions and continue the task. Keep and build on the work already completed.",
  );
  return parts.join("\n\n");
}

/** Sum usage across turns per provider+model (one run may span several provider turns after steering). */
export function mergeTaskUsageEntries(total: TaskUsageEntry[], add: TaskUsageEntry[]): TaskUsageEntry[] {
  const merged = new Map<string, TaskUsageEntry>();
  for (const entry of [...total, ...add]) {
    const key = `${entry.provider}\u0000${entry.model}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry });
      continue;
    }
    existing.inputTokens += entry.inputTokens;
    existing.outputTokens += entry.outputTokens;
    existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (entry.cacheReadTokens ?? 0);
    existing.cacheWriteTokens = (existing.cacheWriteTokens ?? 0) + (entry.cacheWriteTokens ?? 0);
    existing.totalTokens = (existing.totalTokens ?? 0) + (entry.totalTokens ?? 0);
  }
  return [...merged.values()];
}
