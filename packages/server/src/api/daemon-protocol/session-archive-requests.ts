// MUL-432 segment 2 (ADR 0006 Decision 8): the server half of on-demand session
// archives. `runtime.archive_sessions` is re-derived from
// `multiremi_session_archive_requests` on every downlink snapshot and
// `runtime.archive_sessions_result` closes the row. Both plug into the A-4
// layer through its public hooks; neither frame needs a change there.
import type { DaemonArchiveSessionsPayload } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonDownlinkEntity } from "./downlinks.js";
import type { DaemonParsedFrame } from "./frames.js";
import type { DaemonProtocolLayer } from "./index.js";
import { authorizeReportRuntime } from "./report-handlers.js";
import type { DaemonProtocolSession } from "./session.js";

const failure = (code: string) => ({ ok: false, code, retryable: false });

/** One `runtime.archive_sessions` entity per open request, keyed by request id. */
export function sessionArchiveRequestSnapshot(store: MultiremiStore, runtimeId: string): DaemonDownlinkEntity[] {
  return store.dispatchSessionArchiveRequests(runtimeId).map((request) => {
    const payload: DaemonArchiveSessionsPayload = {
      request_id: request.id,
      subjects: [{ kind: request.subject_kind, id: request.subject_id }],
    };
    return {
      key: `runtime.archive_sessions:${request.id}`,
      type: "runtime.archive_sessions",
      payload: { ...payload },
      claimed: () => { store.acknowledgeSessionArchiveRequest(runtimeId, request.id); },
      discard: () => {
        store.failSessionArchiveRequest(runtimeId, request.id);
        console.warn(JSON.stringify({ event: "session_archive_request_discarded", runtime_id: runtimeId,
          request_id: request.id }));
      },
    };
  });
}

export function registerSessionArchiveRequestHandlers(layer: DaemonProtocolLayer, store: MultiremiStore): void {
  layer.registerEventHandler("runtime.archive_sessions_result", (frame: DaemonParsedFrame, session: DaemonProtocolSession) => {
    const p = frame.payload;
    const runtimeId = frame.rt ?? (typeof p.runtime_id === "string" ? p.runtime_id : "");
    try {
      authorizeReportRuntime(store, session, runtimeId);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "authority_revoked") return failure("authority_revoked");
      throw error;
    }
    const requestId = typeof p.request_id === "string" ? p.request_id : "";
    const status = p.status;
    if (
      !requestId
      || (status !== "completed" && status !== "failed")
      || !Array.isArray(p.archive_ids)
      || !p.archive_ids.every((id) => typeof id === "string")
    ) return failure("invalid_report");
    const outcome = store.reportSessionArchiveRequestResult(runtimeId, requestId, status);
    if (outcome === "not_found") return failure("task_not_found");
    if (outcome === "applied" && status === "failed") {
      console.warn(JSON.stringify({ event: "session_archive_request_failed", runtime_id: runtimeId,
        request_id: requestId, error: typeof p.error === "string" ? p.error.slice(0, 500) : null }));
    }
    return { ok: true };
  });
}
