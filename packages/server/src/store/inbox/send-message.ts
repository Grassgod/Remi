import type { SendMessageInput, SendMessageResult } from "@multiremi/contracts/unified-model.js";
import type { CommitEventQueue, StoreContext } from "../context.js";

/**
 * Unified writer boundary. S1 fixes the signature; the lane state machine and
 * producer routing implement this body in the next storage integration stage.
 * Never silently append a message without applying its wake policy.
 */
export function sendMessageWithinTransaction(
  ctx: StoreContext,
  input: SendMessageInput,
  deferredEvents: CommitEventQueue,
): SendMessageResult {
  void input;
  void deferredEvents;
  if (!ctx.db.inTransaction) throw new Error("sendMessageWithinTransaction requires a transaction");
  throw new Error("Unified message lane machine has not been installed");
}
