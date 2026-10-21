/**
 * A scripted ACP agent for native subagent sessions (PR 5), run as
 * `bun tests/fixtures/acp/fake-subagent-agent.ts`. It speaks newline-delimited
 * JSON-RPC on stdio, like `fake-steering-agent.ts`, and plays one script per
 * `session/prompt`: frames on the root or on child sessions, permission and
 * question requests (it waits for the answer), and the prompt's result. Steps
 * after the result are sent after `session/prompt` resolved, the way
 * claude-agent-acp 0.90 sends a task-notification follow-up (its result ends
 * with a `usage_update` carrying `_meta["_claude/origin"]`).
 *
 * The shapes mirror the pinned bridges (claude-agent-acp 0.90 AIR form, codex-acp
 * 2.2.2 with `nativeSubagentSessions`): see the live captures
 * `claude-090-native-subagent-*.json` and `codex-222-native-subagent-*.json`.
 *
 * Background tasks (PR 6): `asyncTask` steps announce, update and end AIR
 * `async_task_*` tasks on any session, the way both pinned bridges do once the
 * client lists `asyncTasks`; `_session/async_task/stop` (root session) stops a
 * running one with the bridge's notice and `stopped` state. A task's scripted
 * end is skipped when it already ended, and so is its `then` (Claude's
 * task-notification cycle, or nothing for Codex). Tasks belong to the process,
 * so a script's post-resolve steps keep running between prompts.
 *
 * Every request it receives and every answer to its own requests is logged to
 * `FAKE_SUBAGENT_LOG`, with the process id; the process logs `started` at boot
 * and `exited` on SIGTERM, so a test can count processes and prove two never
 * ran at once. Configured by `FAKE_SUBAGENT_CONFIG` (JSON) or `FAKE_SUBAGENT_CONFIG_FILE`.
 * Large scripts use a file to stay below OS environment-variable size limits.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type FakeSubagentStep = { delayMs?: number } & (
  /** A `session/update` on `session` (default: the root). */
  | { update: Record<string, unknown>; session?: string }
  /** A billed request: `usage_update` with `remiTokenUsage`, optionally Claude's result `_claude/origin`, a cost or a context size. */
  | { billing: { session?: string; parentToolUseId?: string; origin?: string; cost?: number; used?: number; size?: number } }
  /** `session/request_permission` on `session`; the script waits for the answer. */
  | { permission: { session?: string; toolCallId: string; title?: string } }
  /** `elicitation/create` (a form question) on `session`; the script waits for the answer. */
  | { elicitation: { session?: string; toolCallId?: string; message: string; options: string[] } }
  /** Resolve the `session/prompt`; later steps arrive after it resolved. */
  | { resolve: string }
  /** The bridge process dies. */
  | { exit: number }
  /** Wait until the client cancels the prompt (it then resolves `cancelled`). */
  | { hold: "cancel" }
  /**
   * A background task's frame (PR 6). `spawned` announces it (`async_task_spawned`),
   * `progress` updates it, `running`/`paused` and the ends send `async_task_state_update`.
   * An end of a task that already ended is skipped, with its `then` steps.
   */
  | { asyncTask: FakeAsyncTaskStep }
);

export interface FakeAsyncTaskStep {
  id: string;
  session?: string;
  event: "spawned" | "progress" | "running" | "paused" | "completed" | "failed" | "stopped";
  name?: string;
  taskType?: string;
  toolCallId?: string;
  outputFilePath?: string;
  summary?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  /** Steps that follow only if this end was sent (Claude's own task-notification cycle). */
  then?: FakeSubagentStep[];
}

export interface FakeSubagentConfig {
  /** `claude`: steering-free Claude shape; `codex`: also advertises the AIR capability list Codex sends. */
  advertise?: "claude" | "codex";
  sessionId?: string;
  /** One script per `session/prompt`, in order; the last one repeats. */
  prompts: FakeSubagentStep[][];
  /** The scripts of a process that resumed or loaded the session (a restarted bridge). */
  resumedPrompts?: FakeSubagentStep[][];
  /** Advertise native steering; a steer is always answered `promptRequired` (nothing runs it). */
  steering?: boolean;
  /** Steps run once `session/new` or `session/resume` answered, outside any prompt. */
  afterSession?: FakeSubagentStep[];
  /** Env variables the `started` line records (`env`), as the process got them; null when unset. */
  logEnv?: string[];
  /** A cancelled prompt resolves `cancelled` this long after `session/cancel` (a slow bridge). */
  cancelDelayMs?: number;
  /** A successful `_session/async_task/stop` sends its notice and `stopped` frame this long after the answer. */
  asyncTaskStopFramesDelayMs?: number;
}

const config = JSON.parse(process.env.FAKE_SUBAGENT_CONFIG_FILE
  ? readFileSync(process.env.FAKE_SUBAGENT_CONFIG_FILE, "utf8")
  : process.env.FAKE_SUBAGENT_CONFIG ?? "{}") as FakeSubagentConfig;
const logPath = process.env.FAKE_SUBAGENT_LOG;
const ROOT = config.sessionId ?? "sess_root";
const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ ...entry, pid: process.pid, at: Date.now() }) + "\n");
};
log({ kind: "started", ...(config.logEnv ? { env: Object.fromEntries(config.logEnv.map((key) => [key, process.env[key] ?? null])) } : {}) });
process.on("SIGTERM", () => process.exit(0));
// However it ends (SIGTERM, stdin closed, a scripted exit): SIGKILL alone leaves no line.
process.on("exit", (code) => log({ kind: "exited", code }));
const send = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, value: Record<string, unknown>) =>
  send({ method: "session/update", params: { sessionId, update: value } });

let requestSeq = 0;
function billing(step: Extract<FakeSubagentStep, { billing: unknown }>["billing"]): void {
  const id = `req-${process.pid}-${++requestSeq}`;
  update(step.session ?? ROOT, {
    sessionUpdate: "usage_update", used: step.used ?? 0, size: step.size ?? 0,
    ...(step.cost !== undefined ? { cost: { amount: step.cost, currency: "USD" } } : {}),
    _meta: {
      remiTokenUsage: { id, providerSessionId: ROOT, providerRequestId: id, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5,
        totalTokens: 15, ...(step.parentToolUseId ? { parentToolUseId: step.parentToolUseId } : {}) },
      ...(step.origin ? { "_claude/origin": { kind: step.origin } } : {}),
    },
  });
}

let outgoing = 1_000_000;
const answers = new Map<number, (result: unknown) => void>();
function ask(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = ++outgoing;
  return new Promise((resolve) => {
    answers.set(id, resolve);
    send({ id, method, params });
  });
}

interface Running { id: number | string; resolved: boolean; cancelled: boolean; onCancel: Array<() => void> }

/** Background tasks of this process, by id: whether each still runs (PR 6). */
const asyncTasks = new Map<string, { session: string; running: boolean }>();

/** Send one task frame; false when it is the end of a task that already ended. */
function asyncTaskFrame(step: FakeAsyncTaskStep): boolean {
  const session = step.session ?? asyncTasks.get(step.id)?.session ?? ROOT;
  const fields = {
    ...(step.toolCallId ? { toolCallId: step.toolCallId } : {}),
    ...(step.outputFilePath ? { outputFilePath: step.outputFilePath } : {}),
  };
  if (step.event === "spawned") {
    asyncTasks.set(step.id, { session, running: true });
    update(session, { sessionUpdate: "async_task_spawned", asyncTaskId: step.id, name: step.name ?? step.id,
      taskType: step.taskType ?? "shell", description: step.name ?? step.id, showInTranscript: false, canStop: true, ...fields });
    return true;
  }
  if (step.event === "progress") {
    update(session, { sessionUpdate: "async_task_progress", asyncTaskId: step.id,
      ...(step.summary ? { summary: step.summary } : {}), ...(step.usage ? { usage: step.usage } : {}), ...fields });
    return true;
  }
  const task = asyncTasks.get(step.id);
  const ends = step.event === "completed" || step.event === "failed" || step.event === "stopped";
  if (ends) {
    if (task && !task.running) {
      log({ kind: "async_task_end_skipped", id: step.id });
      return false;
    }
    if (task) task.running = false;
  }
  update(session, { sessionUpdate: "async_task_state_update", asyncTaskId: step.id, state: step.event,
    ...(step.summary ? { summary: step.summary } : {}), ...fields });
  return true;
}
let active: Running | null = null;
let promptCount = 0;
let resumed = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolvePrompt(prompt: Running, stopReason: string): void {
  if (prompt.resolved) return;
  prompt.resolved = true;
  if (active === prompt) active = null;
  log({ kind: "resolved", stopReason });
  send({ id: prompt.id, result: { stopReason } });
}

async function run(prompt: Running, steps: FakeSubagentStep[], resolveAtEnd = true): Promise<void> {
  for (const step of steps) {
    if (step.delayMs) await sleep(step.delayMs);
    // Only a prompt cancelled while it ran is marked; steps after its result keep running.
    if (prompt.cancelled) return;
    if ("update" in step) update(step.session ?? ROOT, step.update);
    else if ("billing" in step) billing(step.billing);
    else if ("permission" in step) {
      const result = await ask("session/request_permission", {
        sessionId: step.permission.session ?? ROOT,
        toolCall: { toolCallId: step.permission.toolCallId, title: step.permission.title ?? "Write file" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      });
      log({ kind: "permission_answer", toolCallId: step.permission.toolCallId, result });
    } else if ("elicitation" in step) {
      const result = await ask("elicitation/create", {
        mode: "form", sessionId: step.elicitation.session ?? ROOT, toolCallId: step.elicitation.toolCallId,
        message: step.elicitation.message,
        requestedSchema: { type: "object", properties: { question_0: { type: "string", title: step.elicitation.message,
          oneOf: step.elicitation.options.map((option) => ({ const: option, title: option })) } } },
      });
      log({ kind: "elicitation_answer", result });
    } else if ("resolve" in step) resolvePrompt(prompt, step.resolve);
    else if ("exit" in step) process.exit(step.exit);
    else if ("hold" in step) await new Promise<void>((resolve) => prompt.onCancel.push(resolve));
    else if ("asyncTask" in step) {
      if (asyncTaskFrame(step.asyncTask) && step.asyncTask.then?.length) await run(prompt, step.asyncTask.then, false);
    }
  }
  if (resolveAtEnd) resolvePrompt(prompt, "end_turn");
}

// Both pinned bridges list `asyncTasks` for any AIR client (PR 6 §1).
const advertisement = {
  jetbrains: { air: { version: 1, capabilities: config.advertise === "codex"
    ? ["sessionFailure", "nativeSubagentSessions", "recommendedValue", "asyncTasks"] : ["sessionFailure", "asyncTasks"] } },
  ...(config.steering ? { steering: { supported: true } } : {}),
};

function afterSession(): void {
  if (!config.afterSession?.length) return;
  const idle: Running = { id: "after-session", resolved: true, cancelled: false, onCancel: [] };
  void run(idle, config.afterSession, false);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, any>; result?: unknown };
  if (!message.method) {
    const answer = typeof message.id === "number" ? answers.get(message.id) : undefined;
    if (answer) {
      answers.delete(message.id as number);
      answer(message.result ?? null);
    }
    return;
  }
  log({ kind: "request", method: message.method, params: message.params ?? null });
  const ok = (result: unknown) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      // Both pinned bridges advertise child sessions whether or not the client asked (live probe).
      return ok({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { subagents: {} } },
        _meta: advertisement });
    case "session/new":
      ok({ sessionId: ROOT });
      return afterSession();
    case "session/resume":
    case "session/load":
      resumed = true;
      ok({ sessionId: message.params?.sessionId ?? ROOT });
      return afterSession();
    case "session/set_mode":
    case "session/set_config_option":
    case "session/close":
      return ok({});
    case "session/prompt": {
      if (active && !active.resolved) {
        log({ kind: "overlap" });
        return send({ id: message.id, error: { code: -32000, message: "overlapping session/prompt" } });
      }
      const scripts = resumed && config.resumedPrompts ? config.resumedPrompts : config.prompts;
      const steps = scripts[Math.min(promptCount++, scripts.length - 1)] ?? [];
      const prompt: Running = { id: message.id!, resolved: false, cancelled: false, onCancel: [] };
      active = prompt;
      void run(prompt, steps);
      return;
    }
    case "session/cancel": {
      const prompt = active;
      if (prompt && !prompt.resolved) {
        prompt.cancelled = true;
        const finish = () => {
          resolvePrompt(prompt, "cancelled");
          for (const release of prompt.onCancel.splice(0)) release();
        };
        if (config.cancelDelayMs) setTimeout(finish, config.cancelDelayMs);
        else finish();
      }
      return;
    }
    case "_session/steering":
      return ok({ outcome: "promptRequired", reason: "noRunningTurn" });
    case "_session/async_task/stop": {
      // Both bridges address the root session, even for a child's task (PR 6 §1).
      const id = String(message.params?.asyncTaskId ?? "");
      const task = asyncTasks.get(id);
      const stopped = message.params?.sessionId === ROOT && !!task?.running;
      log({ kind: "async_task_stop", id, stopped });
      if (!stopped) return ok({ stopped: false });
      task!.running = false;
      // The answer goes first; its frames are separate writes, so a reader can see the answer alone.
      ok({ stopped: true });
      const frames = () => {
        update(ROOT, { sessionUpdate: "notice", severity: "info", title: "Task stopped by user" });
        update(task!.session, { sessionUpdate: "async_task_state_update", asyncTaskId: id, state: "stopped" });
      };
      if (config.asyncTaskStopFramesDelayMs) setTimeout(frames, config.asyncTaskStopFramesDelayMs);
      else frames();
      return;
    }
    default:
      if (message.id != null) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
