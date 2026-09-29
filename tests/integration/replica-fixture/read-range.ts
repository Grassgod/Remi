/**
 * The fixture's stand-in for MUL-402's window read route (C4's
 * `GET /api/sessions/:id/log`).
 *
 * Neither B1's log route nor C4's read pool is on `agent/MUL-403` yet, so the
 * fixture reads windows from its own mock server: the same shape the real
 * implementation will have (`anchor` + `after`, returning display units in `seq`
 * order), and the replica under test cannot tell the difference.
 *
 * The check counts these requests, which is how "过程中没有发出全量 /log 请求" is
 * asserted: a catch-up that re-read the whole log would be many wide ranges, and
 * a catch-up that resumes from the stored head is one narrow range at most.
 */
import type { HubSeqRange } from "../../../packages/contracts/src/live-hub";
import type { SessionLogEntry } from "../../../frontend/packages/core/replica/port";

export type ReadRange = (sessionId: string, range: HubSeqRange) => Promise<SessionLogEntry[]>;

export function resolveReadRange(sessionId: string): ReadRange {
  return async (_sessionId: string, range: HubSeqRange) => {
    const url = new URL("/log", window.location.origin);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("anchor", String(range.from));
    url.searchParams.set("after", String(range.to - range.from + 1));
    const response = await fetch(url.toString());
    if (!response.ok) return [];
    const body = (await response.json()) as { entries?: SessionLogEntry[] };
    return body.entries ?? [];
  };
}
