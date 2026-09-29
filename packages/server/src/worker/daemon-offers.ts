import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { normalizeDaemonClaimTask } from "./client.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";
import type { DaemonParsedFrame } from "../api/daemon-protocol/frames.js";

export type OfferRejection = "capacity" | "claims_paused" | "draining" | "binary_skill_files_unsupported";

export function registerDaemonOfferHandler(client: DaemonProtocolClient, options: {
  runtimeId(): string | null;
  rejection(): OfferRejection | null;
  run(task: MultiremiTaskWithAgent): void;
}): void {
  client.registerFrameHandler("task.offer", (frame: DaemonParsedFrame) => {
    if (!frame.rt || frame.rt !== options.runtimeId() || frame.seq === null) return;
    const task = normalizeDaemonClaimTask(frame.payload);
    if (!task?.id) throw new Error("invalid task.offer payload");
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
