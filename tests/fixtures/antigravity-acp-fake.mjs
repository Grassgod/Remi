// A stdio ACP agent shaped like Google's antigravity-acp 1.4.0 in gateway mode,
// for the daemon integration test. It contains nothing from the proprietary
// server: it reproduces the observable contract Remi relies on.
//
// - session/new and session/resume list the gateway's models over
//   `${AGY_LLM_GATEWAY_URL}/v1beta/models`, sending the placeholder key both as
//   Bearer and as `x-goog-api-key` (as the real harness does);
// - prompts call `:streamGenerateContent?alt=sse` the same way, report a native
//   `usage_update` whose `used` double-counts the cache, ask permission for a
//   shell command, and finish with `end_turn`;
// - a prompt containing ABORT_STREAM cuts its model stream after the first
//   chunk; one containing SUBAGENT_LAST also calls another model last;
// - BACKGROUND_CMD backgrounds a command, says so and never ends the turn,
//   ignoring session/cancel (server 1.4.0 while it waits on the command);
//   FOREGROUND_CMD runs a 1.5 s foreground command before answering;
// - STEER_ME streams a line and waits for session/cancel, which it
//   acknowledges with server 1.4.0's "The request was cancelled by the
//   client." text before answering `cancelled`; STEER_FOLLOW_UP answers at once.
// - LATE_CALL answers, then calls the gateway again after the turn ended (a
//   backgrounded command); CROSSING_CALL ends the turn while a slow model call
//   is still in flight.
// It never advertises `_session/steering` (server 1.4.0 has none). Like
// server 1.4.0, a refused or failed model listing falls back to built-in ids,
// and selecting a model it does not list leaves the current one.
//
// Everything it sees is appended as JSON lines to $FAKE_AGY_CAPTURE.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const CAPTURE = process.env.FAKE_AGY_CAPTURE;
const record = (entry) => { if (CAPTURE) appendFileSync(CAPTURE, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
const pick = (names) => Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
record({ kind: "env", cwd: process.cwd(), env: process.env, ...pick(["GEMINI_HOME", "AGY_LLM_GATEWAY_URL", "AGY_LLM_GATEWAY_API_KEY",
  "AGY_ACP_ENABLE_GATEWAY_AUTH", "AGY_ACP_DEFAULT_MODEL", "GEMINI_API_KEY", "NO_PROXY"]) });

const GATEWAY = process.env.AGY_LLM_GATEWAY_URL;
const KEY = process.env.AGY_LLM_GATEWAY_API_KEY;
const harnessHeaders = { authorization: `Bearer ${KEY}`, "x-goog-api-key": KEY, "content-type": "application/json" };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
let nextId = 5000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });

let models = [];
let current = null;
const configOptions = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: current ?? "none",
  options: models.map((value) => ({ value, name: value })) }];

const BUILT_IN_FALLBACK = ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"];

async function listModels() {
  const response = await fetch(`${GATEWAY}/v1beta/models?pageSize=1000&key=${KEY}`, { headers: harnessHeaders }).catch(() => null);
  record({ kind: "list", status: response?.status ?? 0 });
  models = response?.ok ? (await response.json()).models.map((model) => model.name.replace(/^models\//, "")) : BUILT_IN_FALLBACK;
  // The real server defaults to the gateway's first model until told otherwise.
  current ??= models[0] ?? null;
}

/** One model call; with `cutAfterFirstChunk` the stream is aborted like a cancelled harness request. */
async function generate(model, text, cutAfterFirstChunk = false) {
  const abort = new AbortController();
  const response = await fetch(`${GATEWAY}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${KEY}`, {
    method: "POST", headers: harnessHeaders, signal: abort.signal,
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }] }),
  });
  const reader = response.body.getReader();
  let body = "";
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    body += new TextDecoder().decode(chunk.value);
    if (cutAfterFirstChunk) {
      abort.abort();
      break;
    }
  }
  record({ kind: "generate", model, status: response.status, cut: cutAfterFirstChunk, bytes: body.length });
  return body;
}

async function shell(sid, toolCallId, command, extra = {}) {
  const call = { toolCallId, title: command, kind: "execute", status: "pending", rawInput: { CommandLine: command, Cwd: process.cwd(), ...extra } };
  update(sid, { sessionUpdate: "tool_call", ...call });
  const answer = await ask("session/request_permission", { sessionId: sid, toolCall: call, options: [
    { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ] });
  record({ kind: "permission", outcome: answer?.outcome ?? null });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawInput: { command_line: command, working_dir: process.cwd() } });
}

let waitingForCancel = null;

async function prompt(id, params) {
  const sid = params.sessionId;
  const text = params.prompt.map((block) => block.text ?? "").join("");
  if (text.includes("LATE_CALL")) {
    await generate(current, text);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answered before the late call." } });
    send({ id, result: { stopReason: "end_turn" } });
    // A backgrounded command reusing $AGY_LLM_GATEWAY_URL after the turn: shortly
    // after, or at the latest when Remi stops this process at the run's end.
    let fired = false;
    const lateCall = async () => {
      if (fired) return;
      fired = true;
      const response = await fetch(`${GATEWAY}/v1beta/models/${current}:streamGenerateContent?alt=sse`, {
        method: "POST", headers: harnessHeaders, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "late call" }] }] }),
      }).catch(() => null);
      record({ kind: "late_call", status: response?.status ?? 0 });
    };
    setTimeout(lateCall, 30);
    process.once("SIGTERM", () => { void lateCall().finally(() => process.exit(0)); });
    return;
  }
  if (text.includes("CROSSING_CALL")) {
    // The turn ends while this call is still streaming.
    const call = generate(current, "SLOW_RESPONSE crossing the end of the turn");
    // Let the call reach the gateway (it answers after 600 ms) before the turn ends.
    await new Promise((resolve) => setTimeout(resolve, 150));
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ended while a call was open." } });
    send({ id, result: { stopReason: "end_turn" } });
    await call;
    return;
  }
  if (text.includes("STEER_FOLLOW_UP")) {
    await generate(current, text);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Following the steer." } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text.includes("STEER_ME")) {
    await generate(current, text);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it." } });
    waitingForCancel = { id, sid };
    record({ kind: "waiting_for_steer", id });
    return;
  }
  if (text.includes("BACKGROUND_CMD")) {
    await shell(sid, "call-bg-1", "npm run dev", { WaitMsBeforeAsync: 0 });
    await generate(current, text);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Started it in the background; I will report when it finishes." } });
    record({ kind: "background_wait", id });
    return; // never answered
  }
  if (text.includes("FOREGROUND_CMD")) {
    await shell(sid, "call-fg-1", "make build");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call-fg-1", status: "completed", rawOutput: { exitCode: 0, combinedOutput: "ok\n" } });
    await generate(current, text);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Built." } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text.includes("ABORT_STREAM")) {
    await generate(current, text, true);
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Stopped early." } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  const call = { toolCallId: "call-ls-1", title: "ls -la", kind: "execute", status: "pending",
    rawInput: { CommandLine: "ls -la", Cwd: process.cwd(), WaitMsBeforeAsync: 5000 } };
  update(sid, { sessionUpdate: "tool_call", ...call });
  const answer = await ask("session/request_permission", { sessionId: sid, toolCall: call, options: [
    { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ] });
  record({ kind: "permission", outcome: answer?.outcome ?? null });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call-ls-1", status: "in_progress",
    rawInput: { command_line: "ls -la", working_dir: process.cwd() } });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "call-ls-1", status: "completed",
    rawOutput: { commandLine: "ls -la", exitCode: 0, combinedOutput: "README.md\n", formatted_output: "README.md\n" } });
  await generate(current, text);
  // The server's own report: `used` counts the cache twice and must never be billed.
  update(sid, { sessionUpdate: "usage_update", used: 999_999, size: 1_048_576 });
  await generate(current, `${text} (second step)`);
  if (text.includes("SUBAGENT_LAST")) await generate("gemini-test-lite", "browser subagent");
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id != null && !message.method) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  record({ kind: "request", method: message.method, params: message.params });
  const ok = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      return ok({ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.4.0" },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { resume: {}, list: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } });
    case "session/new":
    case "session/resume":
      await listModels();
      return ok({ sessionId: message.params.sessionId ?? "agy-fake-session-1", configOptions: configOptions(),
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto Edit" }, { id: "yolo", name: "YOLO" }] } });
    case "session/set_mode":
      return ok({});
    case "session/set_config_option":
      if (models.includes(message.params.value)) current = message.params.value;
      return ok({ configOptions: configOptions() });
    case "session/prompt":
      return void prompt(message.id, message.params);
    case "session/cancel":
      if (waitingForCancel) {
        const { id, sid } = waitingForCancel;
        waitingForCancel = null;
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The request was cancelled by the client." } });
        send({ id, result: { stopReason: "cancelled" } });
      }
      return;
    default:
      return send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
