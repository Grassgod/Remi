/**
 * ADR 0025: the agent's command catalogue per agent lane.
 *
 * The daemon sends the latest catalogue the bridge advertised with an
 * attempt's terminal report (`available_commands`). The terminal transaction
 * keeps it on the attempt's lane, `multiremi_session_lanes.available_commands`
 * (one JSON value, null until a daemon reports one). An attempt never
 * overwrites the catalogue of a newer attempt of the same lane; an empty list
 * is stored as reported.
 *
 * The Chat menu reads it through `readChatSlashCommands`: the Chat's own lane,
 * or else the requesting user's latest other Chat with the agent on the same
 * provider and Runtime (a preview), never anyone else's.
 */
import {
  boundSlashCommands,
  visibleSlashCommands,
  type ChatSlashCommandsResponse,
  type SlashCommandCatalogue,
  type SlashCommandEntry,
} from "@multiremi/contracts/slash-commands.js";
import type { SqlDatabase } from "./db/postgres.js";
import { parseJson } from "./helpers.js";

export const LANE_SLASH_COMMANDS_MIGRATION = "20261020_lane_available_commands";
export const LANE_SLASH_COMMANDS_COLUMN = "available_commands TEXT";

/** What the lane column holds: the reported catalogue, and the attempt that reported it. */
export interface StoredLaneSlashCommands extends SlashCommandCatalogue {
  runtime_id: string | null;
  attempt_id: string;
  /** The attempt's `created_at`, which orders the attempts of one lane. */
  attempt_created_at: string;
}

/** How many of a user's other Chats with the agent a preview looks at, newest first. */
const PREVIEW_CANDIDATES = 50;

function storedCatalogue(value: unknown): StoredLaneSlashCommands | null {
  const parsed = parseJson<Record<string, unknown> | null>(value, null);
  if (!parsed || typeof parsed !== "object" || typeof parsed.provider !== "string"
    || typeof parsed.reported_at !== "string" || typeof parsed.attempt_id !== "string"
    || typeof parsed.attempt_created_at !== "string" || !Array.isArray(parsed.commands)) return null;
  return {
    provider: parsed.provider,
    reported_at: parsed.reported_at,
    runtime_id: typeof parsed.runtime_id === "string" ? parsed.runtime_id : null,
    attempt_id: parsed.attempt_id,
    attempt_created_at: parsed.attempt_created_at,
    commands: boundSlashCommands(parsed.commands),
  };
}

/**
 * Keep an attempt's reported catalogue on its lane, inside the terminal
 * transaction. Nothing happens without a catalogue (an older daemon, or an
 * agent that advertised none), without a lane, or when the lane already holds
 * the catalogue of a newer attempt. Returns whether it wrote.
 */
export function recordLaneSlashCommandsWithinTransaction(db: SqlDatabase, attemptId: string,
  catalogue: SlashCommandCatalogue | null | undefined): boolean {
  if (!catalogue) return false;
  const row = db.query(`SELECT t.session_id, t.agent_id, t.execution_scope, a.created_at, a.runtime_id, l.available_commands
    FROM multiremi_turn_attempts a
    JOIN multiremi_turns t ON t.id = a.turn_id
    JOIN multiremi_session_lanes l ON l.session_id = t.session_id AND l.reader_type = 'agent'
      AND l.reader_id = t.agent_id AND l.execution_scope = t.execution_scope
    WHERE a.id = ?`).get(attemptId) as {
      session_id: string; agent_id: string; execution_scope: string; created_at: string;
      runtime_id: string | null; available_commands: string | null;
    } | null;
  if (!row) return false;
  const stored = storedCatalogue(row.available_commands);
  if (stored && stored.attempt_id !== attemptId && stored.attempt_created_at > String(row.created_at)) return false;
  const value: StoredLaneSlashCommands = {
    provider: catalogue.provider,
    reported_at: catalogue.reported_at,
    runtime_id: row.runtime_id ?? null,
    attempt_id: attemptId,
    attempt_created_at: String(row.created_at),
    commands: boundSlashCommands(catalogue.commands),
  };
  // The lane's `updated_at` stays: it orders lane sweeps, and a catalogue is no lane progress.
  db.run(`UPDATE multiremi_session_lanes SET available_commands = ?
    WHERE session_id = ? AND reader_type = 'agent' AND reader_id = ? AND execution_scope = ?`,
  [JSON.stringify(value), row.session_id, row.agent_id, row.execution_scope]);
  return true;
}

/** The agent a Chat menu asks about: its id, current provider and Runtime. */
export interface SlashCommandsAgent {
  id: string;
  provider: string | null;
  runtimeId: string | null;
}

/**
 * The catalogue for a Chat menu, already filtered by the block and hide lists
 * of the agent's provider. `sessionId` is a Chat of `userId` with this agent
 * (the caller checked it), or null for a Chat not created yet.
 */
export function readChatSlashCommands(db: SqlDatabase, input: {
  agent: SlashCommandsAgent;
  userId: string;
  workspaceId: string;
  sessionId: string | null;
}): ChatSlashCommandsResponse {
  const provider = input.agent.provider || null;
  const sameProvider = (stored: StoredLaneSlashCommands) => !provider || stored.provider === provider;
  const answer = (state: "session" | "preview", stored: StoredLaneSlashCommands): ChatSlashCommandsResponse => ({
    state, provider: stored.provider, reported_at: stored.reported_at,
    commands: visibleSlashCommands(stored.provider, stored.commands),
  });
  if (input.sessionId) {
    const own = db.query(`SELECT available_commands FROM multiremi_session_lanes
      WHERE session_id = ? AND reader_type = 'agent' AND reader_id = ? AND execution_scope = ''`)
      .get(input.sessionId, input.agent.id) as { available_commands: string | null } | null;
    const stored = storedCatalogue(own?.available_commands);
    if (stored && sameProvider(stored)) return answer("session", stored);
  }
  const rows = db.query(`SELECT l.available_commands FROM multiremi_session_lanes l
    JOIN multiremi_chat_sessions c ON c.id = l.session_id
    WHERE COALESCE(c.creator_id, 'local') = ? AND c.workspace_id = ? AND c.agent_id = ? AND c.id <> ?
      AND l.reader_type = 'agent' AND l.reader_id = ? AND l.execution_scope = '' AND l.available_commands IS NOT NULL
    ORDER BY l.updated_at DESC LIMIT ${PREVIEW_CANDIDATES}`)
    .all(input.userId, input.workspaceId, input.agent.id, input.sessionId ?? "", input.agent.id) as Array<{ available_commands: string }>;
  let preview: StoredLaneSlashCommands | null = null;
  for (const row of rows) {
    const stored = storedCatalogue(row.available_commands);
    if (!stored || !sameProvider(stored) || (input.agent.runtimeId && stored.runtime_id !== input.agent.runtimeId)) continue;
    if (!preview || stored.reported_at > preview.reported_at) preview = stored;
  }
  if (preview) return answer("preview", preview);
  return { state: "none", provider, reported_at: null, commands: [] as SlashCommandEntry[] };
}
