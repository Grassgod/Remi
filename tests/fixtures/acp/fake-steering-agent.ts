/**
 * A scripted ACP agent for native steering tests (ADR 0020), run as
 * `bun tests/fixtures/acp/fake-steering-agent.ts`. It speaks newline-delimited
 * JSON-RPC on stdio and mimics the pinned bridges' `_session/steering`:
 * claude-agent-acp 0.90 injects into a running turn and, with the
 * `promptRequired` idle opt-in, answers `promptRequired` when idle
 * (dist/acp-agent.js:2380-2451); codex-acp 2.2.2 has no opt-in and starts a
 * turn of its own once the previous prompt completes (dist/index.js:43906-43960).
 *
 * It refuses an overlapping `session/prompt` with an error, so a client that
 * ever sends one fails loudly. Every frame it receives is logged to
 * `FAKE_STEER_LOG` for assertions. Configured by `FAKE_STEER_CONFIG` (JSON).
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface FakeSteerPromptPlan {
  /** Agent text sent as soon as the prompt starts. */
  chunks?: string[];
  /** Report a background Agent launch first, as Claude does before holding the turn for it. */
  background?: boolean;
  /** A top-level shell call that completes after `ms` (never when null). */
  tool?: { ms: number | null };
  /** A subagent's shell call (it carries `parentToolUseId`) that stays open. */
  childTool?: boolean;
  /** Billing frames every this many ms while the turn runs (turn-level updates for retries). */
  tickMs?: number;
  /** Ask the client a `session/request_permission` once the turn runs. */
  permission?: boolean;
  /** "steer": hold until a steer is injected; "cancel": hold until cancelled; "none": end now. */
  hold?: "steer" | "cancel" | "none";
  /** Text answering an injected steer. */
  answer?: string;
  /** Billing frames sent this long after the prompt resolved (a task-notification follow-up). */
  afterResolve?: { delayMs: number; frames: number };
}

/**
 * - `auto`: what the bridge does (inject, `promptRequired` with the opt-in, else `startedNewTurn`);
 * - `race`: the running prompt completes just before the steer is handled; then `auto` for an idle session;
 * - `error` / `failed` / `hang`: a JSON-RPC error, `{outcome:"failed"}`, or no answer at all;
 * - `notYet`: `promptRequired` (`noRunningTurn`) even while a turn runs;
 * - `afterPrompt`: answer only once the running prompt ended, then start a turn of
 *   its own (`startedNewTurn`), as codex-acp does for a steer it could not inject.
 */
export type FakeSteerPlan = "auto" | "race" | "error" | "failed" | "hang" | "notYet" | "afterPrompt";

export interface FakeSteerConfig {
  advertise: "claude" | "codex" | "none";
  /** One plan per `session/prompt`, in order; the last one repeats. */
  prompts: FakeSteerPromptPlan[];
  /** The plans of a process that resumed or loaded the session (a restarted bridge). */
  resumedPrompts?: FakeSteerPromptPlan[];
  /** One plan per `_session/steering`, in order; the last one repeats. Default `auto`. */
  steers?: FakeSteerPlan[];
  /** How long a cancelled prompt takes to answer `cancelled`. */
  cancelDelayMs?: number;
  /** A bridge-started turn keeps talking after cancel (never goes quiet). */
  detachedIgnoresCancel?: boolean;
  /**
   * The bridge registers a prompt's turn this long after `session/prompt`
   * arrived, sending no turn-level update before (codex-acp awaits before its
   * pending turn start, claude-agent-acp in `startTurn`). Until then a steer
   * finds no turn: Claude with the opt-in answers `promptRequired`; Codex
   * waits for the prompt to end and starts a turn of its own.
   */
  turnStartDelayMs?: number;
}

const config = JSON.parse(process.env.FAKE_STEER_CONFIG ?? "{}") as FakeSteerConfig;
const logPath = process.env.FAKE_STEER_LOG;
const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ ...entry, at: Date.now() }) + "\n");
};
const send = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId: string, value: Record<string, unknown>) =>
  send({ method: "session/update", params: { sessionId, update: value } });
const chunk = (sessionId: string, text: string) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
let requestSeq = 0;
const billing = (sessionId: string) => {
  const id = `req-${process.pid}-${++requestSeq}`;
  update(sessionId, { sessionUpdate: "usage_update", used: 1000 + requestSeq, size: 200_000, _meta: {
    remiTokenUsage: { id, providerSessionId: sessionId, providerRequestId: id,
      inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15 },
  } });
};

interface ActivePrompt {
  id: number | string;
  sessionId: string;
  plan: FakeSteerPromptPlan;
  settled: boolean;
  registered: boolean;
  onSettle: Array<() => void>;
  timers: Array<ReturnType<typeof setInterval>>;
}
let active: ActivePrompt | null = null;
let detached: { stop: () => void } | null = null;
let promptCount = 0;
let resumed = false;
let steerCount = 0;

const pick = <T>(list: T[] | undefined, index: number, fallback: T): T =>
  list?.length ? list[Math.min(index, list.length - 1)]! : fallback;

let requestId = 1_000_000;
function settle(prompt: ActivePrompt, stopReason: string): void {
  if (prompt.settled) return;
  prompt.settled = true;
  if (active === prompt) active = null;
  for (const timer of prompt.timers) clearInterval(timer);
  send({ id: prompt.id, result: { stopReason } });
  for (const callback of prompt.onSettle.splice(0)) callback();
  const after = prompt.plan.afterResolve;
  if (after) {
    setTimeout(() => { for (let index = 0; index < after.frames; index++) billing(prompt.sessionId); }, after.delayMs);
  }
}

function startPrompt(id: number | string, sessionId: string): void {
  const plan = pick(resumed && config.resumedPrompts ? config.resumedPrompts : config.prompts, promptCount++,
    { hold: "none" } as FakeSteerPromptPlan);
  const prompt: ActivePrompt = { id, sessionId, plan, settled: false, registered: false, onSettle: [], timers: [] };
  active = prompt;
  if (config.turnStartDelayMs) setTimeout(() => runTurn(prompt), config.turnStartDelayMs);
  else runTurn(prompt);
}

function runTurn(prompt: ActivePrompt): void {
  if (prompt.settled) return;
  const { plan, sessionId } = prompt;
  prompt.registered = true;
  log({ kind: "turn_registered" });
  if (plan.background) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "toolu_bg", title: "Count files", kind: "think",
      status: "pending", _meta: { claudeCode: { toolName: "Agent" } } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "toolu_bg", status: "completed",
      _meta: { claudeCode: { toolName: "Agent", toolResponse: { status: "async_launched", isAsync: true } } } });
  }
  for (const text of plan.chunks ?? []) chunk(sessionId, text);
  if (plan.childTool) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "toolu_child", title: "ls", kind: "execute", status: "pending",
      _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "toolu_bg" } } });
  }
  if (plan.tool) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "toolu_sleep", title: "sleep", kind: "execute", status: "pending",
      _meta: { claudeCode: { toolName: "Bash" } } });
    const ms = plan.tool.ms;
    if (ms !== null) {
      setTimeout(() => {
        if (prompt.settled) return;
        log({ kind: "tool_completed" });
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "toolu_sleep", status: "completed" });
      }, ms);
    }
  }
  billing(sessionId);
  if (plan.tickMs) prompt.timers.push(setInterval(() => billing(sessionId), plan.tickMs));
  if (plan.permission) {
    send({ id: ++requestId, method: "session/request_permission", params: { sessionId,
      toolCall: { toolCallId: "toolu_perm", title: "Write file" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
  }
  if ((plan.hold ?? "none") === "none") settle(prompt, "end_turn");
}

/** A turn the bridge started itself: it talks until cancelled. */
function startDetachedTurn(sessionId: string): void {
  chunk(sessionId, "Detached turn. ");
  billing(sessionId);
  const timer = setInterval(() => billing(sessionId), 40);
  detached = {
    stop: () => {
      if (config.detachedIgnoresCancel) return;
      clearInterval(timer);
      billing(sessionId);
      detached = null;
    },
  };
}

function inject(prompt: ActivePrompt, text: string): void {
  const answer = prompt.plan.answer ?? `Steered: ${text.split("\n")[0]}`;
  setTimeout(() => {
    if (prompt.settled) return;
    chunk(prompt.sessionId, answer);
    billing(prompt.sessionId);
    if (prompt.plan.hold === "steer") settle(prompt, "end_turn");
  }, 20);
}

function steer(id: number | string, params: Record<string, any>): void {
  const plan = pick(config.steers, steerCount++, "auto" as FakeSteerPlan);
  const text = String(params?.prompt?.[0]?.text ?? "");
  if (plan === "hang") return;
  if (plan === "error") {
    send({ id, error: { code: -32603, message: "Internal error: steer refused (token sk-fake-secret)" } });
    return;
  }
  if (plan === "failed") {
    send({ id, result: { outcome: "failed" } });
    return;
  }
  if (plan === "notYet") {
    send({ id, result: { outcome: "promptRequired", reason: "noRunningTurn" } });
    return;
  }
  if (plan === "afterPrompt" || (active && !active.settled && !active.registered
    && params?._meta?.steering?.idleBehavior !== "promptRequired")) {
    // Queued behind the running prompt, then a turn of its own.
    const startOwn = () => {
      startDetachedTurn(params.sessionId);
      send({ id, result: { outcome: "startedNewTurn" } });
    };
    if (active && !active.settled) active.onSettle.push(() => setTimeout(startOwn, 10));
    else startOwn();
    return;
  }
  if (plan === "race") {
    // The running turn finished just before the steer was handled: Claude with
    // the opt-in leaves the text to the client; Codex starts a turn of its own.
    const prompt = active;
    if (prompt) settle(prompt, "end_turn");
    setTimeout(() => {
      if (params?._meta?.steering?.idleBehavior === "promptRequired") {
        send({ id, result: { outcome: "promptRequired", reason: "noRunningTurn" } });
        return;
      }
      startDetachedTurn(params.sessionId);
      send({ id, result: { outcome: "startedNewTurn" } });
    }, 30);
    return;
  }
  if (active && !active.settled && active.registered) {
    inject(active, text);
    send({ id, result: { outcome: "injected" } });
    return;
  }
  if (params?._meta?.steering?.idleBehavior === "promptRequired") {
    send({ id, result: { outcome: "promptRequired", reason: "noRunningTurn" } });
    return;
  }
  startDetachedTurn(params.sessionId);
  send({ id, result: { outcome: "startedNewTurn" } });
}

const advertisement = config.advertise === "claude"
  ? { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } }, steering: { supported: true } }
  : config.advertise === "codex"
    ? { steering: { supported: true }, jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } }
    : { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } };

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, any> };
  if (!message.method) {
    log({ kind: "response", id: message.id ?? null, result: (message as { result?: unknown }).result ?? null });
    return;
  }
  log({ kind: "request", method: message.method, params: message.params ?? null });
  const ok = (result: unknown) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      return ok({ protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: advertisement });
    case "session/new":
      return ok({ sessionId: "sess-steer" });
    case "session/resume":
    case "session/load":
      resumed = true;
      return ok({ sessionId: message.params?.sessionId ?? "sess-steer" });
    case "session/set_mode":
    case "session/set_config_option":
    case "session/close":
      return ok({});
    case "session/prompt":
      // A turn the bridge started itself is as busy as a prompt.
      if ((active && !active.settled) || detached) {
        log({ kind: "overlap" });
        return send({ id: message.id, error: { code: -32000, message: "overlapping session/prompt" } });
      }
      return startPrompt(message.id!, message.params?.sessionId ?? "sess-steer");
    case "session/cancel": {
      detached?.stop();
      const prompt = active;
      if (prompt) setTimeout(() => settle(prompt, "cancelled"), config.cancelDelayMs ?? 0);
      return;
    }
    case "_session/steering":
      return steer(message.id!, message.params ?? {});
    default:
      if (message.id != null) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
