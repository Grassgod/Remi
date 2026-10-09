#!/usr/bin/env bun

import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const responsibilityMarker = (prompt: string): boolean => /PR404\/RESP\/(ASK|SUBMIT|PRESENTER)(?:\b|\/)/.test(prompt);
type Dependencies = {
  cli(args: string[]): Promise<any>;
  request(method: string, params: Record<string, unknown>): Promise<any>;
  cancelled(): boolean;
  evidenceDir: string;
  providerSessionId: string;
};

/** Dedicated PPE actions run under the daemon's existing task credential. */
async function responsibilityProbe(prompt: string, dependencies: Dependencies): Promise<string> {
  const { cli } = dependencies;
  const identity = prompt.match(/Turn: ([A-Za-z0-9_-]+); attempt: ([A-Za-z0-9_-]+);/);
  const turnId = identity?.[1] ?? process.env.MULTIREMI_TURN_ID;
  const attemptId = identity?.[2] ?? process.env.MULTIREMI_ATTEMPT_ID;
  if (!turnId || !attemptId || !/^[A-Za-z0-9_-]+$/.test(turnId + attemptId)) throw new Error("ppe_missing_identity");
  mkdirSync(dependencies.evidenceDir, { recursive: true, mode: 0o700 });
  const file = join(dependencies.evidenceDir, `${attemptId}-responsibility.jsonl`);
  const record = (event: string, facts: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ event, at: new Date().toISOString(), turn_id: turnId, attempt_id: attemptId, ...facts });
    appendFileSync(file, line + "\n", { mode: 0o600 }); process.stderr.write(line + "\n");
  };
  const assertActive = () => { if (dependencies.cancelled()) throw new Error("ppe_cancelled"); };
  const before = await cli(["turn", "get", turnId, "--attempts"]);
  const attempt = before.attempts?.find((value: any) => value.id === attemptId);
  if (!attempt || before.turn?.current_attempt_id !== attemptId) throw new Error("ppe_stale_attempt");
  const turn = before.turn;
  const from = Number(attempt.projection_from_seq ?? turn.input_from_seq ?? 0);
  const to = Number(attempt.projection_to_seq ?? turn.wake_seq ?? 0);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error("ppe_invalid_range");
  const entries = await cli(["message", "list", turn.session_id, "--from", String(from), "--to", String(to)]);
  if (!Array.isArray(entries)) throw new Error("ppe_invalid_range_result");
  const after = await cli(["turn", "get", turnId, "--attempts"]);
  const receipt = after.attempts?.find((value: any) => value.id === attemptId);
  if (!receipt || receipt.input_read_seq < to || receipt.input_read_offset !== 0) throw new Error("ppe_read_not_confirmed");
  record("responsibility_input_read", { conversation_id: turn.session_id, from_seq: from, to_seq: to,
    input_read_seq: receipt.input_read_seq, input_read_offset: receipt.input_read_offset });
  assertActive();
  const actions: Array<Record<string, unknown>> = [];
  if (prompt.includes("PR404/RESP/PRESENTER")) {
    const notifications = entries.filter((value: any) => value.metadata?.question_present_request === true);
    if (!notifications.length) throw new Error("ppe_presentation_notification_missing");
    for (const notification of notifications) {
      assertActive();
      const questionId = notification.metadata.root_question_id;
      if (typeof questionId !== "string") throw new Error("ppe_question_reference_missing");
      const view = await cli(["message", "question", "get", questionId]);
      const question = view.question;
      if (!question || question.route_revision !== notification.metadata.question_route_revision) {
        record("responsibility_presentation_stale", { question_id: questionId }); continue;
      }
      const presented = await cli(["message", "question", "present", questionId, "--revision", String(question.route_revision),
        "--summary", "PPE责任验收：请查看同一问题的原题、原选项与上下文，再作答。此总结不代替人类授权。"]);
      const result = presented.question;
      if (result?.id !== questionId || result.summary?.agent_id !== turn.agent_id) throw new Error("ppe_presentation_not_saved");
      const action = { question_id: questionId, route_revision: result.route_revision, action: "present" };
      actions.push(action); record("responsibility_presented", action);
    }
  } else if (prompt.includes("PR404/RESP/ASK")) {
    // Notifications inherit the original question text. They must not produce
    // another AUQ merely because that text contains the source marker.
    const trigger = entries.find((value: any) => value.id === turn.trigger_message_id);
    if (!trigger?.metadata?.root_question_id) {
      const message = "PR404/RESP/ASK: Should this PPE Issue continue?";
      const findQuestion = async () => {
        const listed = await cli(["message", "list", turn.session_id, "--limit", "100"]);
        const messages = Array.isArray(listed) ? listed : listed.messages;
        if (!Array.isArray(messages)) throw new Error("ppe_invalid_range_result");
        return messages.find((value: any) => value.message_kind === "decision" && value.body_md === message && value.sender_id === turn.agent_id);
      };
      let original = await findQuestion();
      if (!original) {
        record("responsibility_question_requested");
        const answer = await dependencies.request("elicitation/create", { sessionId: dependencies.providerSessionId, mode: "form", message,
          requestedSchema: { type: "object", properties: { answer: { type: "string", title: "PPE decision", enum: ["Continue", "Stop"] } }, required: ["answer"] } });
        assertActive();
        if (answer?.action !== "accept") throw new Error("ppe_question_not_answered");
        original = await findQuestion();
      }
      if (!original) throw new Error("ppe_question_not_saved");
      const view = await cli(["message", "question", "get", original.id]);
      if (view.question?.status !== "answered") throw new Error("ppe_question_not_answered");
      const action = { question_id: original.id, action: "answer_observed", answer_revision: view.question.answer_revision };
      actions.push(action); record("responsibility_answer_observed", action);
    }
  }
  if (prompt.includes("PR404/RESP/SUBMIT")) {
    assertActive();
    if (!turn.issue_id) throw new Error("ppe_delivery_issue_required");
    const submitted = await cli(["issue", "delivery", "submit", turn.issue_id, "--session", turn.session_id,
      "--dedupe-key", `ppe-responsibility:${attemptId}`, "--summary", "PR404/RESP/SUBMIT: PPE synthetic formal delivery, ready for responsible review."]);
    const delivery = submitted.delivery;
    if (!delivery?.id || delivery.issueId !== turn.issue_id) throw new Error("ppe_delivery_not_saved");
    const action = { issue_id: turn.issue_id, delivery_id: delivery.id, action: "submit" };
    actions.push(action); record("responsibility_submitted", action);
  }
  return `PPE_RESPONSIBILITY_EVIDENCE ${JSON.stringify({ turn_id: turnId, attempt_id: attemptId, actions, evidence_file: file })}`;
}

// F01 uses real CLI range reads under the daemon's attempt credential. Only
// dedicated markers, hashes and read receipts enter the evidence, never raw input.
// PPE_ACP_PAUSE: before-read,after-read,before-complete (comma-separated).
// Resume by writing the stage into the advertised control file, or ppe/resume.
const evidenceDir = process.env.PPE_ACP_EVIDENCE_DIR ?? "/tmp/remi-ppe-acp-probes";
const pauses = new Set((process.env.PPE_ACP_PAUSE ?? "").split(","));
const pauseTimeout = Number(process.env.PPE_ACP_PAUSE_TIMEOUT_MS ?? 120_000);
const markers = (text: string): string[] => [...new Set(text.match(/MUL-493\/PROBE\/[A-Za-z0-9_.:-]{1,128}/g) ?? [])];
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
type Probe = { sessionId: string; cancelled: boolean; stage: string | null; release: boolean; onCancelled?: () => void };
const active = new Map<string, Probe>();
const consumed = new Map<string, number>();
const providerRequests = new Map<string, { probe: Probe; resolve(value: unknown): void; reject(error: Error): void }>();
let providerRequestSequence = 0;
// A soft cancellation continues the same daemon attempt in another ACP prompt.
const readHistory = new Map<string, { attemptId: string; reads: Array<Record<string, unknown>> }>();

async function cli(args: string[]): Promise<any> {
  const entry = process.env.PPE_ACP_REMI_ENTRY ?? (existsSync("/app/apps/remi/main.ts") ? "/app/apps/remi/main.ts" : undefined);
  const command = [process.env.PPE_ACP_REMI_BIN ?? (entry ? process.execPath : "remi"),
    ...(entry ? [entry] : []), ...args, "--output", "json"];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error("ppe_cli_failed");
    try { return JSON.parse(stdout); } catch { throw new Error("ppe_cli_invalid_json"); }
  } finally { clearTimeout(timer); }
}

async function probeInput(request: RpcRequest, prompt: string, probe: Probe): Promise<string> {
  const identity = prompt.match(/Turn: ([A-Za-z0-9_-]+); attempt: ([A-Za-z0-9_-]+);/);
  const turnId = identity?.[1] ?? process.env.MULTIREMI_TURN_ID;
  const attemptId = identity?.[2] ?? process.env.MULTIREMI_ATTEMPT_ID;
  if (!turnId || !attemptId || !/^[A-Za-z0-9_-]+$/.test(turnId + attemptId)) throw new Error("ppe_missing_identity");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const stem = `${attemptId}-${randomUUID()}`;
  const evidenceFile = join(evidenceDir, `${stem}.jsonl`), controlFile = join(evidenceDir, `${stem}.resume`);
  const record = (event: string, data: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ event, at: new Date().toISOString(), provider_session_id: probe.sessionId,
      turn_id: turnId, attempt_id: attemptId, ...data });
    appendFileSync(evidenceFile, line + "\n", { mode: 0o600 });
    process.stderr.write(line + "\n");
  };
  probe.onCancelled = () => record("provider_cancelled", { request_id: request.id });
  const pause = async (stage: string): Promise<boolean> => {
    if (!pauses.has(stage)) return false;
    if (!Number.isFinite(pauseTimeout) || pauseTimeout <= 0) throw new Error("ppe_invalid_pause_timeout");
    probe.stage = stage; probe.release = false;
    record("paused", { stage, control_file: controlFile, evidence_file: evidenceFile });
    const deadline = Date.now() + pauseTimeout;
    while (!probe.release && !probe.cancelled) {
      try { probe.release = readFileSync(controlFile, "utf8").trim() === stage; } catch { /* Await QA's stage-specific signal. */ }
      if (Date.now() >= deadline) throw new Error("ppe_pause_timeout");
      if (!probe.release) await Bun.sleep(20);
    }
    probe.stage = null;
    if (probe.cancelled) throw new Error("ppe_cancelled");
    record("resumed", { stage });
    return true;
  };
  const detail = async () => {
    const value = await cli(["turn", "get", turnId, "--attempts"]);
    const attempt = value.attempts?.find((a: any) => a.id === attemptId);
    if (value.turn?.current_attempt_id !== attemptId || !attempt) throw new Error("ppe_stale_attempt");
    return { turn: value.turn, attempt };
  };
  record("provider_input", { prompt_sha256: digest(prompt), markers: markers(prompt), request_id: request.id });
  await pause("before-read");
  let history = readHistory.get(probe.sessionId);
  if (history?.attemptId !== attemptId) {
    history = { attemptId, reads: [] };
    readHistory.set(probe.sessionId, history);
  }
  const reads = history.reads;
  let readTo: number | undefined;
  const read = async () => {
    if (probe.cancelled) throw new Error("ppe_cancelled");
    const before = await detail();
    const from = readTo ?? Number(reads.at(-1)?.to_seq ?? before.attempt.projection_from_seq ?? before.turn.input_from_seq ?? 0);
    const to = Number(before.attempt.projection_to_seq ?? before.turn.wake_seq ?? 0);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error("ppe_invalid_range");
    const entries = await cli(["message", "list", before.turn.session_id, "--from", String(from), "--to", String(to)]);
    if (!Array.isArray(entries)) throw new Error("ppe_invalid_range_result");
    const observed = entries.filter(e => e.kind === "message" && !e.deleted_at).flatMap(e => {
      const found = markers(String(e.body_md ?? ""));
      if (!found.length) return [];
      const count = (consumed.get(e.id) ?? 0) + 1; consumed.set(e.id, count);
      return [{ message_id: e.id, seq: e.seq, markers: found, body_sha256: digest(String(e.body_md)), read_count: count }];
    });
    const after = await detail();
    const seq = after.attempt.input_read_seq, offset = after.attempt.input_read_offset;
    if (!Number.isSafeInteger(seq) || seq < to || offset !== 0) throw new Error("ppe_read_not_confirmed");
    const receipt = { conversation_id: after.turn.session_id, runtime_id: after.attempt.runtime_id,
      provider: after.attempt.provider, from_seq: from, to_seq: to,
      input_read_seq: seq, input_read_offset: offset, input_ack_seq: after.attempt.input_ack_seq,
      messages: observed };
    reads.push(receipt); record("actual_read", receipt);
    readTo = to;
  };
  await read();
  if (await pause("after-read")) await read();
  if (await pause("before-complete")) await read();
  if (!reads.some(r => (r.messages as any[]).length)) throw new Error("ppe_marker_not_read");
  if (probe.cancelled) throw new Error("ppe_cancelled");
  record("provider_complete", { evidence_file: evidenceFile, read_count: reads.length });
  return `PPE_PROBE_EVIDENCE ${JSON.stringify({ boundary: "real daemon + test provider", turn_id: turnId,
    attempt_id: attemptId, provider_session_id: probe.sessionId, reads, evidence_file: evidenceFile })}`;
}

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

function providerRequest(probe: Probe, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `ppe-responsibility-${++providerRequestSequence}`;
  return new Promise((resolve, reject) => {
    providerRequests.set(id, { probe, resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let sequence = 0;
const sessions = new Set<string>();

createInterface({ input: process.stdin }).on("line", (line) => {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    return;
  }
  if (!request.method && request.id != null) {
    const pending = providerRequests.get(String(request.id));
    if (pending) {
      providerRequests.delete(String(request.id));
      const response = request as RpcRequest & { result?: unknown; error?: unknown };
      if (response.error) pending.reject(new Error("ppe_provider_request_failed")); else pending.resolve(response.result);
    }
    return;
  }
  if (request.method === "session/cancel") {
    const probe = active.get(String(request.params?.sessionId));
    if (probe) {
      probe.cancelled = true;
      for (const [id, pending] of providerRequests) if (pending.probe === probe) {
        providerRequests.delete(id); pending.reject(new Error("ppe_cancelled"));
      }
    }
    return;
  }
  if (request.id == null) return;

  const result = (value: unknown): void => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      return;
    case "session/new": {
      const sessionId = `ppe-${++sequence}`;
      sessions.add(sessionId);
      result({ sessionId });
      return;
    }
    case "session/resume":
    case "session/load": {
      const sessionId = String(request.params?.sessionId ?? `ppe-${++sequence}`);
      sessions.add(sessionId);
      result({ sessionId });
      return;
    }
    case "session/set_mode":
    case "session/set_config_option":
    case "session/close":
      result({});
      return;
    case "ppe/resume": {
      const probe = active.get(String(request.params?.sessionId));
      const resumed = !!probe?.stage && probe.stage === request.params?.stage;
      if (resumed) probe!.release = true;
      result({ resumed });
      return;
    }
    case "session/prompt": {
      const sessionId = String(request.params?.sessionId ?? "");
      if (!sessions.has(sessionId)) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "unknown PPE session" } });
        return;
      }
      if (active.has(sessionId)) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "ppe_session_busy" } });
        return;
      }
      const prompt = Array.isArray(request.params?.prompt)
        ? request.params.prompt.filter((block: any) => block.type === "text").map((block: any) => String(block.text ?? "")).join("\n") : "";
      const probe: Probe = { sessionId, cancelled: false, stage: null, release: false };
      active.set(sessionId, probe);
      void (async () => {
        try {
          const text = responsibilityMarker(prompt) ? await responsibilityProbe(prompt, { cli,
            request: (method, params) => providerRequest(probe, method, params), cancelled: () => probe.cancelled,
            evidenceDir, providerSessionId: sessionId })
            : markers(prompt).length ? await probeInput(request, prompt, probe) : "PPE daemon ACP smoke test completed.";
          if (probe.cancelled) { probe.onCancelled?.(); result({ stopReason: "cancelled" }); return; }
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
          result({ stopReason: "end_turn" });
        } catch (error) {
          if (probe.cancelled) { probe.onCancelled?.(); result({ stopReason: "cancelled" }); }
          else send({ jsonrpc: "2.0", id: request.id, error: { code: -32000,
            message: error instanceof Error && /^ppe_[a-z_]+$/.test(error.message) ? error.message : "ppe_probe_failed" } });
        } finally { active.delete(sessionId); }
      })();
      return;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `method not supported by PPE fake ACP: ${request.method ?? "unknown"}` },
      });
  }
});
