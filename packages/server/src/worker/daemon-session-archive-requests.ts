import {
  SESSION_ARCHIVE_SUBJECT_KINDS,
  type SessionArchiveSubjectKind,
} from "@multiremi/contracts/trace-file.js";
import type {
  DaemonArchiveSessionsResultPayload,
  DaemonArchiveSubject,
} from "@multiremi/contracts/daemon-protocol.js";
import type { DaemonProtocolClient } from "./daemon-protocol-client.js";

const TYPE = "runtime.archive_sessions";

export type DaemonSessionArchiveRequestResult = Omit<DaemonArchiveSessionsResultPayload, "request_id">;

function parseSubject(value: unknown): DaemonArchiveSubject | null {
  if (!value || typeof value !== "object") return null;
  const { kind, id } = value as Record<string, unknown>;
  if (!SESSION_ARCHIVE_SUBJECT_KINDS.includes(kind as SessionArchiveSubjectKind)) return null;
  if (typeof id !== "string" || !id) return null;
  return { kind: kind as SessionArchiveSubjectKind, id };
}

/**
 * The daemon half of on-demand session archives (ADR 0006 Decision 8).
 *
 * A `runtime.archive_sessions` frame is acknowledged before any work, its
 * subjects are archived one at a time through `archive` (the same barrier
 * workspace GC uses), and one result goes back per request: `completed` with
 * every archive id, or `failed` with the archives that did finish and the
 * errors of those that did not. `archive` returns null when no ready archive
 * came of it (a deferred retry, an upload that did not reach `ready`).
 *
 * Returns a drain that waits for the requests in flight.
 */
export function registerDaemonSessionArchiveRequests(
  client: Pick<DaemonProtocolClient, "registerFrameHandler" | "dedupe" | "send">,
  runtimeId: () => string | null,
  archive: (subject: DaemonArchiveSubject) => Promise<string | null>,
  report: (runtimeId: string, requestId: string, result: DaemonSessionArchiveRequestResult) => Promise<void>,
): () => Promise<void> {
  const running = new Set<Promise<void>>();
  client.registerFrameHandler(TYPE, async (frame) => {
    const requestId = frame.payload.request_id;
    const rt = frame.rt;
    if (!rt || rt !== runtimeId() || typeof requestId !== "string" || !requestId) return;
    const key = `${rt}:${requestId}`;
    if (!client.dedupe.claim(TYPE, key)) return;
    const run = (async () => {
      client.send({ t: "ack", p: {} });
      const archiveIds: string[] = [];
      const errors: string[] = [];
      const subjects = Array.isArray(frame.payload.subjects) ? frame.payload.subjects : [];
      if (!subjects.length) errors.push("request has no subjects");
      for (const value of subjects) {
        const subject = parseSubject(value);
        if (!subject) {
          errors.push("invalid subject");
          continue;
        }
        try {
          const archiveId = await archive(subject);
          if (archiveId) archiveIds.push(archiveId);
          else errors.push(`${subject.kind} ${subject.id}: no ready archive`);
        } catch (error) {
          errors.push(`${subject.kind} ${subject.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await report(rt, requestId, errors.length
        ? { status: "failed", archive_ids: archiveIds, error: errors.join("; ") }
        : { status: "completed", archive_ids: archiveIds });
    })();
    running.add(run);
    try {
      await run;
    } catch (error) {
      client.dedupe.release(TYPE, key);
      throw error;
    } finally {
      running.delete(run);
    }
  });
  return async () => { await Promise.allSettled([...running]); };
}
