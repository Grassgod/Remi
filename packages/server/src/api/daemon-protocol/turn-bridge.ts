import type { DaemonTurnInput, DaemonTurnMessagePayload, DaemonTurnWrapUpPayload,
  DaemonTurnCompletePayload, DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";

export type DaemonTurnRpc = "turn.input" | "turn.decision" | "turn.decision.get" | "turn.decision.expire";
export interface DaemonTurnScope { runtimeId: string; daemonId: string; workspaceId: string }

/**
 * The protocol owns transport validation; the unified store owns transactions.
 * Every write must verify turn/current-attempt/runtime association and apply
 * the lane machine in the same transaction. Never adapt to old steer/request tables.
 */
export interface DaemonTurnBridge {
  offerInput(attempt: MultiremiTaskWithAgent): DaemonTurnInput;
  snapshot(scope: DaemonTurnScope, activeAttemptIds: ReadonlySet<string>): {
    messages: DaemonTurnMessagePayload[];
    wrapUps: DaemonTurnWrapUpPayload[];
  };
  rpc(type: DaemonTurnRpc, payload: Record<string, unknown>, scope: DaemonTurnScope):
    Record<string, unknown> | Promise<Record<string, unknown>>;
  complete(input: { payload: DaemonTurnCompletePayload; completionFields: DaemonTaskCompletionFields | null;
    traceEventCount?: number }, scope: DaemonTurnScope): Record<string, unknown> | Promise<Record<string, unknown>>;
}
