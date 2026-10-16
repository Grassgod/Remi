/**
 * The credential and turn a `remi` command run inside a task uses (PR 6
 * §2.4). A Chat lane's process can outlive the attempt that spawned it, so
 * its `MULTIREMI_TOKEN` may belong to an attempt that already completed; the
 * daemon keeps the current attempt's in `MULTIREMI_TASK_CONTEXT_FILE`. The
 * file wins when it is readable; otherwise the environment, as before.
 */
import { resolveTaskContext, TASK_CONTEXT_PARKED_MESSAGE } from "@shared/task-context-file.js";
import { CliError } from "./errors.js";

/**
 * The task's token: the context file's, else `MULTIREMI_TOKEN` as set (an
 * empty tombstone stays empty, so no other credential stands in for it);
 * undefined outside a task. A parked lane has none.
 */
export function taskCredential(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const context = resolveTaskContext(env);
  if (context.parked) throw new CliError("auth_required", TASK_CONTEXT_PARKED_MESSAGE);
  return context.source === "file" ? context.token ?? undefined : env.MULTIREMI_TOKEN?.trim();
}

/** The task's turn: the context file's, else `MULTIREMI_TURN_ID`; null outside a task. */
export function taskTurnId(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return resolveTaskContext(env).turnId;
}
