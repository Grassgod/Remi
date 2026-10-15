import { open, readdir, stat } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeCodexRequestUsage } from "./codex-request-usage.js";

/**
 * app-server emits rawResponse/completed only on threads whose thread/start
 * opted into raw events. Resumed and forked threads cannot opt in, but Codex
 * still persists one `token_usage_record` per upstream response in the native
 * rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`), including native
 * child threads under their root `session_id`. A cursor lives as long as the
 * pooled session and each read advances it, so every record is read once:
 * a prompt also reads turns the bridge ran since the previous read, as idle
 * usage frames are billed to the next prompt. Requests have the same shape
 * as the bridge patch emits.
 */
export interface CodexRolloutCursor {
  sessionsDir: string;
  threadId: string;
  /** Start of the first prompt read through this cursor; earlier records are history. */
  sinceMs: number;
  /** Bytes already read per rollout (sizes at creation); files absent here are read whole. */
  offsets: Map<string, number>;
}

export interface CodexRolloutRequestUsage {
  usage: Record<string, unknown>;
  /** Native thread that sent the request; the root or one of its children. */
  threadId: string;
}

const DAY_MS = 86_400_000;
const POLL_MS = 50;
const MTIME_SLACK_MS = 2_000;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Only an explicit CODEX_HOME is read (the daemon gives every Codex task its
 * own); never fall back to scanning the user's personal ~/.codex history.
 */
export function codexHomeFor(explicit: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  return explicit || env.CODEX_HOME || null;
}

/** Milliseconds encoded in a UUIDv7 thread ID, or null for other formats. */
function uuidV7Ms(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return null;
  return parseInt(hex.slice(0, 12), 16);
}

/** Rollouts are stored under the local creation date; ±1 day covers any offset. */
function dayDirs(sessionsDir: string, times: number[]): string[] {
  const dirs = new Set<string>();
  for (const time of times) {
    for (const delta of [-DAY_MS, 0, DAY_MS]) {
      const date = new Date(time + delta);
      dirs.add(join(sessionsDir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")));
    }
  }
  return [...dirs];
}

function candidateTimes(cursor: Pick<CodexRolloutCursor, "threadId" | "sinceMs">, now: number): number[] {
  const created = uuidV7Ms(cursor.threadId);
  return [cursor.sinceMs, now, ...(created === null ? [] : [created])];
}

function isRollout(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** Synchronous and stat-only: taken before the session's first read prompt is sent. */
export function beginCodexRolloutUsage(codexHome: string, threadId: string, sinceMs = Date.now()): CodexRolloutCursor {
  const cursor: CodexRolloutCursor = { sessionsDir: join(codexHome, "sessions"), threadId, sinceMs, offsets: new Map() };
  for (const dir of dayDirs(cursor.sessionsDir, candidateTimes(cursor, sinceMs))) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!isRollout(name)) continue;
      try { cursor.offsets.set(join(dir, name), statSync(join(dir, name)).size); } catch {}
    }
  }
  return cursor;
}

/** Calls `onLine` per complete line after `from`; returns the offset past the last one. */
async function readAppendedLines(path: string, from: number, size: number, onLine: (line: string) => void): Promise<number> {
  const handle = await open(path, "r");
  try {
    let position = from, next = from, carry = Buffer.alloc(0);
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
        onLine(data.toString("utf8", start, end));
        start = end + 1;
      }
      next = position - (data.length - start);
      // An unterminated tail is still being written; a later read sees it whole.
      carry = Buffer.from(data.subarray(start));
    }
    return next;
  } finally {
    await handle.close();
  }
}

interface ScanState {
  consumed: Map<string, number>;
  requests: Map<string, CodexRolloutRequestUsage>;
  /** The root rollout changed since the last read; only then is there a turn end to wait for. */
  rootSeen: boolean;
  /** The root rollout's last complete line is a turn end and nothing follows it. */
  rootTerminal: boolean;
}

async function scan(cursor: CodexRolloutCursor, requestedModel: string | null, state: ScanState): Promise<void> {
  for (const dir of dayDirs(cursor.sessionsDir, candidateTimes(cursor, Date.now()))) {
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!isRollout(name)) continue;
      const path = join(dir, name);
      const from = state.consumed.get(path) ?? cursor.offsets.get(path) ?? 0;
      let info;
      try { info = await stat(path); } catch { continue; }
      // Unchanged since the last read, or untouched since the cursor began
      // (with slack for coarse mtimes; record timestamps are filtered exactly).
      if (info.size <= from || info.mtimeMs < cursor.sinceMs - MTIME_SLACK_MS) continue;
      const root = name.endsWith(`-${cursor.threadId}.jsonl`);
      if (root) state.rootSeen = true;
      const onLine = (line: string): void => {
        // Codex writes the turn end as the root rollout's last line; anything
        // after it (a later turn) means the prompt's work is still landing.
        if (root) state.rootTerminal = false;
        // Most rollout lines are transcript items; parse only usage and turn ends.
        const usageLine = line.includes("token_usage_record");
        const terminalLine = root && (line.includes("\"task_complete\"") || line.includes("\"turn_aborted\""));
        if (!usageLine && !terminalLine) return;
        let row: any;
        try { row = JSON.parse(line); } catch { return; }
        const at = typeof row?.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(at) || at < cursor.sinceMs) return;
        if (terminalLine && row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(row.payload?.type)) {
          state.rootTerminal = true;
          return;
        }
        const record = row.type === "token_usage_record" ? row.payload
          : row.type === "compacted" ? row.payload?.latest_token_usage_record : null;
        if (!record || typeof record !== "object") return;
        const threadId = record.thread_id, responseId = record.response_id;
        if (typeof threadId !== "string" || !threadId || typeof responseId !== "string" || !responseId) return;
        // Children carry the root thread as session_id; other threads in a
        // shared CODEX_HOME are not this prompt's work.
        if (threadId !== cursor.threadId && record.session_id !== cursor.threadId) return;
        const ownModel = threadId === cursor.threadId ? requestedModel : null;
        const modelSource = ownModel ? "session_acknowledged" : "unknown";
        const normalized = normalizeCodexRequestUsage({ threadId, responseId, turnId: record.turn_id, usage: record.usage, format: "native" });
        const key = JSON.stringify([threadId, responseId]);
        // A malformed duplicate never replaces exact counters for the response.
        if (!normalized && state.requests.has(key)) return;
        // Same identity, shape and gap semantics as the bridge's rawResponse hook.
        state.requests.set(key, { threadId, usage: normalized
          ? { ...normalized, requestedModel: ownModel, modelSource }
          : { id: responseId, providerSessionId: threadId, providerRequestId: responseId, scope: "request_snapshot",
            source: "codex_response_usage", accuracy: "unknown", model: null, requestedModel: ownModel, modelSource } });
      };
      let next: number;
      try { next = await readAppendedLines(path, from, info.size, onLine); } catch { continue; }
      state.consumed.set(path, next);
      // A torn tail is a line still being written.
      if (root && next < info.size) state.rootTerminal = false;
    }
  }
}

/**
 * Codex appends the turn's last records shortly after the prompt resolves.
 * Wait (bounded) for the root rollout's own turn end before the final read.
 */
export async function collectCodexRolloutUsage(cursor: CodexRolloutCursor, options: {
  requestedModel?: string | null; waitMs?: number;
} = {}): Promise<CodexRolloutRequestUsage[]> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  const state: ScanState = { consumed: new Map(), requests: new Map(), rootSeen: false, rootTerminal: false };
  for (;;) {
    await scan(cursor, options.requestedModel ?? null, state);
    if (!state.rootSeen || state.rootTerminal || Date.now() >= deadline) {
      for (const [path, offset] of state.consumed) cursor.offsets.set(path, offset);
      return [...state.requests.values()];
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
