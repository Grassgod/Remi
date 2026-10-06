import { normalizeDaemonClaimTask } from "./client.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";
import type { DaemonParsedFrame } from "../api/daemon-protocol/frames.js";
import type { DaemonTurnInput } from "@multiremi/contracts/daemon-protocol.js";

export type DaemonTurnTask = NonNullable<ReturnType<typeof normalizeDaemonClaimTask>> & DaemonTurnInput;

/** No prompt/id fallback: old offers cannot enter the execution loop. */
export function normalizeDaemonTurnOffer(payload: Record<string, unknown>): DaemonTurnTask {
  const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if ("prompt" in payload || typeof payload.turn_id !== "string" || !payload.turn_id
    || typeof payload.attempt_id !== "string" || !payload.attempt_id
    || !seq(payload.input_from_seq) || !seq(payload.input_to_seq)
    || payload.input_from_seq > payload.input_to_seq || !Array.isArray(payload.input_messages)) {
    throw new Error("invalid turn offer payload");
  }
  let previous = payload.input_from_seq;
  for (const input of payload.input_messages) {
    if (!input || typeof input !== "object" || input.kind !== "message" || typeof input.id !== "string"
      || typeof input.body_md !== "string" || !seq(input.seq)
      || input.seq <= previous || input.seq > payload.input_to_seq) throw new Error("invalid turn offer input range");
    previous = input.seq;
  }
  const task = normalizeDaemonClaimTask({ ...payload, id: payload.attempt_id,
    prompt: payload.input_messages.map(message => message.body_md).join("\n\n") });
  if (!task) throw new Error("invalid turn offer payload");
  return task as DaemonTurnTask;
}

export type OfferRejection = "capacity" | "claims_paused" | "draining" | "binary_skill_files_unsupported";

export function registerDaemonOfferHandler(client: DaemonProtocolClient, options: {
  runtimeId(): string | null;
  rejection(): OfferRejection | null;
  run(task: DaemonTurnTask): void;
}): void {
  client.registerFrameHandler("task.offer", (frame: DaemonParsedFrame) => {
    if (!frame.rt || frame.rt !== options.runtimeId() || frame.seq === null) return;
    let task: DaemonTurnTask;
    try { task = normalizeDaemonTurnOffer(frame.payload); }
    catch {
      client.send({ t: "res", re: String(frame.seq), p: { ok: false, code: "report_shape_retired", retryable: false } });
      return;
    }
    // A replay of an accepted entity stays accepted even after local capacity filled.
    const key = "task.offer";
    if (!client.dedupe.claim(key, task.id)) {
      client.send({ t: "res", re: String(frame.seq), p: { ok: true } });
      return;
    }
    const code = options.rejection();
    if (code) {
      client.dedupe.release(key, task.id);
      client.send({ t: "res", re: String(frame.seq), p: { ok: false, code } });
      return;
    }
    try {
      client.send({ t: "res", re: String(frame.seq), p: { ok: true } });
      options.run(task);
    } catch (error) {
      client.dedupe.release(key, task.id);
      throw error;
    }
  });
}
