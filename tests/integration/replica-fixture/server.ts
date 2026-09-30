/**
 * The mock C3 server for the replica check (MUL-403 C7 acceptance).
 *
 * C3 has not merged into `agent/MUL-403`, so the plan's instruction is to mock
 * its frames against C0's contract. This server is that mock: it speaks the v2
 * browser frames verbatim (`packages/contracts/src/live-hub.ts`), keeps a real
 * conversation log in memory, and counts what the pages ask for — which is how
 * "only 1 page is subscribed" and "no full `/log` request during catch-up" are
 * asserted rather than eyeballed.
 *
 * It also serves the fixture page and the Worker bundle the check builds, so the
 * whole thing runs on one origin (OPFS is per origin, and the leader election is
 * per origin too).
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

export interface LogRow {
  seq: number;
  id: string;
  kind: string;
  visibility: "shown" | "hidden";
  revision: number;
  body_md: string;
  body_html: string | null;
  render_version: string | null;
}

/** The log a session starts with: `count` display units, seq 1..count. */
export function seedLog(count: number, upTo = count): LogRow[] {
  const rows: LogRow[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    rows.push({
      seq,
      id: `cmt_${seq}`,
      kind: "comment",
      visibility: "shown",
      revision: 1,
      body_md: `body ${seq}`,
      body_html: `<p>body ${seq}</p>`,
      render_version: "v1",
    });
  }
  return rows.slice(0, upTo);
}

export interface MockHubState {
  /** The session id the pages subscribe to. */
  sessionId: string;
  rows: LogRow[];
  head: number;
  logVersion: number;
  /** Every `stream.subscribe` received, with the origin page's marker. */
  subscribes: Array<{ fromSeq: number; at: number }>;
  unsubscribes: number;
  /** Live subscriber count, i.e. sockets with at least one active subscription. */
  activeSubscriptions: number;
  globalSubscriptions: number;
  /** Every `/log` read, so a full re-read is visible. */
  logReads: Array<{ from: number; to: number; at: number }>;
}

export function newMockHub(sessionId: string, rows: LogRow[]): MockHubState {
  return {
    sessionId,
    rows,
    head: rows.length > 0 ? rows[rows.length - 1]!.seq : 0,
    logVersion: 1,
    subscribes: [],
    unsubscribes: 0,
    activeSubscriptions: 0,
    globalSubscriptions: 0,
    logReads: [],
  };
}

/** Append `count` rows, returning the frames the hub would fan out. */
export function appendRows(state: MockHubState, count: number, overrides: Partial<LogRow> = {}): LogRow[] {
  const appended: LogRow[] = [];
  for (let index = 0; index < count; index += 1) {
    state.head += 1;
    const row: LogRow = {
      seq: state.head,
      id: `cmt_${state.head}`,
      kind: "comment",
      visibility: "shown",
      revision: 1,
      body_md: `body ${state.head}`,
      body_html: `<p>body ${state.head}</p>`,
      render_version: "v1",
      ...overrides,
    };
    state.rows.push(row);
    appended.push(row);
  }
  return appended;
}

/** Patch a row in place: same seq, new revision — the case `head` alone cannot see. */
export function patchRow(state: MockHubState, seq: number, body: string): LogRow | null {
  const row = state.rows.find((candidate) => candidate.seq === seq);
  if (!row) return null;
  row.revision += 1;
  row.body_md = body;
  row.body_html = `<p>${body}</p>`;
  return row;
}

/** The `stream.ack` payload for a subscribe, from the hub's current state. */
export function ackFor(state: MockHubState, fromSeq: number): Record<string, unknown> {
  const tail = state.rows.length > 0 ? state.rows[0]!.seq : 1;
  const gap = fromSeq < tail ? { from: fromSeq, to: tail - 1 } : null;
  return { stream: "log", id: state.sessionId, first_seq: tail, head_seq: state.head, log_version: state.logVersion, gap };
}

export function frameFor(row: LogRow): { seq: number; kind: string; payload: unknown } {
  return { seq: row.seq, kind: "entry", payload: { session_id: "sess_1", ...row } };
}

export function patchFrameFor(row: LogRow): { seq: number; kind: string; payload: unknown } {
  return {
    seq: row.seq,
    kind: "patch",
    payload: {
      session_id: "sess_1",
      target_seq: row.seq,
      revision: row.revision,
      fields: { body_md: row.body_md, body_html: row.body_html },
    },
  };
}

/** Static asset helper: read a built file, or 404 rather than throwing. */
export async function readAsset(dir: string, name: string): Promise<Uint8Array | null> {
  try {
    return await readFile(join(dir, name));
  } catch {
    return null;
  }
}
