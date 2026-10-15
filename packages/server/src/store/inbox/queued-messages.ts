import type { MultiremiChatSession } from '@multiremi/contracts/types.js';
import {
  QUEUE_MAX_ATTACHMENTS, QUEUE_MAX_LIVE_ITEMS, QUEUED_MESSAGE_DEDUPE_PREFIX,
  type QueuedMessage, type QueuedMessageAttachment, type QueuedMessageErrorCode, type QueuedMessageRelease, type QueuedMessageReleaseVia,
  type QueuePause, type QueuePauseReason, type SessionQueue,
} from '@multiremi/contracts/queued-message.js';
import { createId, nowIso } from '@multiremi/ids.js';
import { createCommitEventQueue, type CommitEventQueue, type StoreContext } from '../context.js';
import { afterCommit, withSavepoint } from '../db/postgres.js';
import { getMessage, sendMessageWithinTransaction } from './send-message.js';
import { lockLane } from './lane-machine.js';
import { createLogger } from '@shared/logger.js';

const log = createLogger('multiremi-store');

/** Carries the HTTP status the queue routes answer with. */
export class QueuedMessageError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: QueuedMessageErrorCode, message: string) {
    super(message);
    this.name = 'QueuedMessageError';
  }
}

interface QueueRow {
  id: string; workspace_id: string; session_id: string; agent_id: string; execution_scope: string; seq: number;
  sender_member_id: string; body_md: string; attachment_ids: string; client_id: string;
  status: QueuedMessage['status']; error: string | null; released_message_id: string | null;
  released_via: QueuedMessageReleaseVia | null; released_at: string | null; revision: number;
  created_at: string; updated_at: string;
}

/** The agent lane a Chat's queue belongs to. */
export interface QueueLane { workspaceId: string; sessionId: string; agentId: string; scope: string }

export interface EnqueueQueuedMessageInput {
  session_id: string;
  sender_member_id: string;
  body_md: string;
  attachment_ids?: string[];
  /** Idempotency key within the Chat; the HTTP route requires it. */
  client_id?: string;
}

export interface UpdateQueuedMessageInput { body_md: string; attachment_ids?: string[]; expected_revision?: number }

export type SteerQueuedMessageResult =
  | ({ item: QueuedMessage } & QueuedMessageRelease)
  | { item: QueuedMessage; message: null; error: string };

interface ReleaseOutcome { released: Array<{ id: string } & QueuedMessageRelease>; failed: { id: string; error: string } | null }

const LIVE = "status IN ('queued','failed')";
const LANE_SQL = 'session_id=? AND agent_id=? AND execution_scope=?';
const laneParams = (lane: QueueLane) => [lane.sessionId, lane.agentId, lane.scope];
const AGENT_LANE_SQL = "session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?";

function laneOf(row: Pick<QueueRow, 'workspace_id' | 'session_id' | 'agent_id' | 'execution_scope'>): QueueLane {
  return { workspaceId: row.workspace_id, sessionId: row.session_id, agentId: row.agent_id, scope: row.execution_scope };
}

function chatLane(chat: MultiremiChatSession): QueueLane {
  return { workspaceId: chat.workspaceId, sessionId: chat.id, agentId: chat.agentId, scope: '' };
}

/** Workspace lifecycle lock first, then the same lane mutex completion and send use. */
function lockQueueLane(ctx: StoreContext, lane: QueueLane): void {
  ctx.lockWorkspaceRuntimeLifecycle(lane.workspaceId);
  lockLane(ctx, lane.sessionId, lane.agentId, lane.scope);
}

function readRow(ctx: StoreContext, id: string): QueueRow | null {
  return ctx.db.query('SELECT * FROM multiremi_queued_messages WHERE id=?').get(id) as QueueRow | null;
}

function pauseOf(ctx: StoreContext, lane: QueueLane): QueuePause | null {
  const row = ctx.db.query(`SELECT queue_paused_at,queue_pause_reason FROM multiremi_session_lanes WHERE ${AGENT_LANE_SQL}`)
    .get(...laneParams(lane)) as { queue_paused_at: string | null; queue_pause_reason: QueuePauseReason | null } | null;
  return row?.queue_paused_at && row.queue_pause_reason ? { reason: row.queue_pause_reason, at: row.queue_paused_at } : null;
}

/** Keeps an earlier pause and its reason; returns whether this call paused the lane. */
function pauseLane(ctx: StoreContext, lane: QueueLane, reason: QueuePauseReason): boolean {
  lockLane(ctx, lane.sessionId, lane.agentId, lane.scope);
  return ctx.db.run(`UPDATE multiremi_session_lanes SET queue_paused_at=?,queue_pause_reason=?
    WHERE ${AGENT_LANE_SQL} AND queue_paused_at IS NULL`, [nowIso(), reason, ...laneParams(lane)]).changes > 0;
}

function clearPause(ctx: StoreContext, lane: QueueLane): boolean {
  return ctx.db.run(`UPDATE multiremi_session_lanes SET queue_paused_at=NULL,queue_pause_reason=NULL
    WHERE ${AGENT_LANE_SQL} AND queue_paused_at IS NOT NULL`, laneParams(lane)).changes > 0;
}

function countRows(ctx: StoreContext, lane: QueueLane, status: 'live' | 'failed'): number {
  return Number((ctx.db.query(`SELECT COUNT(*) AS n FROM multiremi_queued_messages WHERE ${LANE_SQL}
    AND ${status === 'live' ? LIVE : "status='failed'"}`).get(...laneParams(lane)) as { n: number }).n);
}

function hasLiveRows(ctx: StoreContext, lane: QueueLane): boolean {
  return !!ctx.db.query(`SELECT 1 FROM multiremi_queued_messages WHERE ${LANE_SQL} AND ${LIVE} LIMIT 1`).get(...laneParams(lane));
}

/** Same active-turn predicate as ensurePendingTurn. */
function laneIdle(ctx: StoreContext, lane: QueueLane): boolean {
  return !ctx.db.query(`SELECT 1 FROM multiremi_turns WHERE ${LANE_SQL}
    AND status IN ('pending','running','awaiting_human') LIMIT 1`).get(...laneParams(lane));
}

/** One invalidation per Chat per transaction, published by the owner after COMMIT. */
function queueUpdated(events: CommitEventQueue, lane: QueueLane): void {
  if (events.workspace.some(event => event.type === 'chat:queue_updated' && event.chatSessionId === lane.sessionId)) return;
  events.workspace.push({ type: 'chat:queue_updated', workspaceId: lane.workspaceId, chatSessionId: lane.sessionId,
    actorType: 'system', actorId: null, payload: { chat_session_id: lane.sessionId } });
}

function attachmentIdsOf(row: Pick<QueueRow, 'attachment_ids'>): string[] {
  try {
    const ids = JSON.parse(row.attachment_ids);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** One read for every attachment of a page of rows. */
function attachmentsById(ctx: StoreContext, rows: QueueRow[]): Map<string, QueuedMessageAttachment> {
  const ids = [...new Set(rows.flatMap(attachmentIdsOf))];
  if (!ids.length) return new Map();
  const found = ctx.db.query(`SELECT id,filename,content_type,size_bytes FROM multiremi_attachments WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: string; filename: string | null; content_type: string | null; size_bytes: number | string | null }>;
  return new Map(found.map(row => [row.id, { id: row.id, filename: String(row.filename ?? ''),
    content_type: String(row.content_type ?? 'application/octet-stream'), size: Number(row.size_bytes ?? 0) }]));
}

function toQueuedMessage(ctx: StoreContext, row: QueueRow, attachmentIndex = attachmentsById(ctx, [row])): QueuedMessage {
  const attachments = attachmentIdsOf(row).flatMap(id => attachmentIndex.get(id) ?? []);
  return {
    id: row.id, session_id: row.session_id, body_md: row.body_md, attachments, client_id: row.client_id,
    status: row.status, error: row.error, revision: Number(row.revision),
    released_message_id: row.released_message_id, released_via: row.released_via, released_at: row.released_at,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function releaseOf(ctx: StoreContext, row: QueueRow): QueuedMessageRelease | null {
  const message = row.released_message_id ? getMessage(ctx, row.released_message_id) : null;
  if (!message) return null;
  const turnId = message.metadata.delivery_turn_id;
  return { message, ...(typeof turnId === 'string' ? { turn_id: turnId } : {}) };
}

function listRows(ctx: StoreContext, lane: QueueLane, where = LIVE, params: unknown[] = []): QueueRow[] {
  return ctx.db.query(`SELECT * FROM multiremi_queued_messages WHERE ${LANE_SQL} AND ${where} ORDER BY seq,id`)
    .all(...laneParams(lane), ...params) as QueueRow[];
}

function sessionQueue(ctx: StoreContext, lane: QueueLane): SessionQueue {
  const rows = listRows(ctx, lane), index = attachmentsById(ctx, rows);
  return { items: rows.map(row => toQueuedMessage(ctx, row, index)), paused: pauseOf(ctx, lane) };
}

/**
 * Release queued rows of one lane in send order. Each row becomes an ordinary
 * member `wake=now` request through the single message writer, inside its own
 * savepoint and event queue. The first release creates the pending turn, the
 * rest merge into it. A failure marks that row failed, pauses the lane with
 * `send_failed` and stops, so later rows never overtake it. Caller holds the
 * workspace and lane locks.
 */
export function releaseQueuedMessagesWithinTransaction(ctx: StoreContext, lane: QueueLane, events: CommitEventQueue,
  via: QueuedMessageReleaseVia, onlyId?: string): ReleaseOutcome {
  if (!ctx.db.inTransaction) throw new Error('releaseQueuedMessagesWithinTransaction requires a transaction');
  const outcome: ReleaseOutcome = { released: [], failed: null };
  // A member send reopens an archived Chat; a queue release never does.
  if (ctx.chat().getChatSession(lane.sessionId)?.status === 'archived') return outcome;
  const rows = onlyId ? listRows(ctx, lane, `${LIVE} AND id=?`, [onlyId]) : listRows(ctx, lane, "status='queued'");
  for (const row of rows) {
    const rowEvents = createCommitEventQueue();
    let sent;
    try {
      sent = withSavepoint(ctx.db, () => sendMessageWithinTransaction(ctx, {
        session_id: row.session_id, sender: { type: 'member', id: row.sender_member_id },
        to: { type: 'agent', ref: row.agent_id }, message_kind: 'request', wake_requested: 'now',
        body_md: row.body_md, attachment_ids: attachmentIdsOf(row), execution_scope: row.execution_scope,
        dedupe_key: `${QUEUED_MESSAGE_DEDUPE_PREFIX}${row.id}`,
        metadata: { queued_message_id: row.id, queued_at: row.created_at },
      }, rowEvents));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Any send error becomes a failed row, including transient database errors; keep them visible.
      log.warn(`queued message ${row.id} in ${row.session_id} failed to release: ${message}`);
      ctx.db.run(`UPDATE multiremi_queued_messages SET status='failed',error=?,revision=revision+1,updated_at=? WHERE id=?`,
        [message, nowIso(), row.id]);
      pauseLane(ctx, lane, 'send_failed');
      queueUpdated(events, lane);
      outcome.failed = { id: row.id, error: message };
      break;
    }
    const at = nowIso();
    ctx.db.run(`UPDATE multiremi_queued_messages SET status='released',error=NULL,released_message_id=?,released_via=?,
      released_at=?,revision=revision+1,updated_at=? WHERE id=?`, [sent.message.id, via, at, at, row.id]);
    events.workspace.push(...rowEvents.workspace);
    events.enqueuedTasks.push(...rowEvents.enqueuedTasks);
    events.issueActivities.push(...rowEvents.issueActivities);
    queueUpdated(events, lane);
    outcome.released.push({ id: row.id, message: sent.message, ...(sent.turn_id ? { turn_id: sent.turn_id } : {}) });
  }
  if (!countRows(ctx, lane, 'live') && clearPause(ctx, lane)) queueUpdated(events, lane);
  return outcome;
}

/**
 * Turn-end hook, called by reRingAfterTurnEnd under the lane lock after its
 * archived checks. A failed or cancelled turn pauses the queue (`turn_ended`)
 * so a failing agent does not swallow queued instructions. Any completed turn
 * in the lane, including a successful retry, clears a `turn_ended` pause and
 * releases the queue; `interrupted` and `send_failed` stay until resume or the
 * failed row is fixed. Returns the turn the release created or joined.
 */
export function settleQueueAfterTurnEndWithinTransaction(ctx: StoreContext,
  turn: { workspace_id: string; session_id: string; agent_id: string; execution_scope: string; status: string },
  events: CommitEventQueue): string | undefined {
  const lane = laneOf(turn);
  if (!hasLiveRows(ctx, lane)) return;
  const pause = pauseOf(ctx, lane);
  if (turn.status !== 'completed') {
    if (!pause && pauseLane(ctx, lane, 'turn_ended')) queueUpdated(events, lane);
    return;
  }
  if (pause && pause.reason !== 'turn_ended') return;
  if (pause) { clearPause(ctx, lane); queueUpdated(events, lane); }
  return releaseQueuedMessagesWithinTransaction(ctx, lane, events, 'turn').released[0]?.turn_id;
}

/** A member stopping the turn pauses the queue before the cancel runs. Caller holds the lane lock. */
export function pauseQueueForMemberStopWithinTransaction(ctx: StoreContext,
  turn: { workspace_id: string; session_id: string; agent_id: string; execution_scope: string },
  events: CommitEventQueue): void {
  const lane = laneOf(turn);
  if (hasLiveRows(ctx, lane) && pauseLane(ctx, lane, 'interrupted')) queueUpdated(events, lane);
}

export class QueuedMessages {
  constructor(private ctx: StoreContext) {}

  private transaction<T>(fn: (events: CommitEventQueue) => T): T {
    const events = createCommitEventQueue();
    const write = () => fn(events);
    const result = this.ctx.db.inTransaction ? write() : this.ctx.db.transaction(write)();
    afterCommit(this.ctx.db, () => this.ctx.emitCommitEvents(events));
    return result;
  }

  private chat(sessionId: string): MultiremiChatSession {
    const chat = this.ctx.chat().getChatSession(sessionId);
    if (!chat) throw new QueuedMessageError(400, 'not_a_chat', 'The follow-up queue is only available in a Chat');
    return chat;
  }

  /** Re-read under the lock; a Chat archived meanwhile cannot release new work. */
  private lockActiveChat(sessionId: string): { chat: MultiremiChatSession; lane: QueueLane } {
    const initial = this.chat(sessionId);
    const lane = chatLane(initial);
    lockQueueLane(this.ctx, lane);
    const chat = this.chat(sessionId);
    if (chat.status === 'archived') throw new QueuedMessageError(409, 'chat_archived', 'Chat session is archived');
    return { chat, lane };
  }

  private lockRow(sessionId: string, id: string, memberId: string): { row: QueueRow; lane: QueueLane } {
    const initial = readRow(this.ctx, id);
    if (!initial || initial.session_id !== sessionId) throw new QueuedMessageError(404, 'queued_message_not_found', 'Queued message not found');
    const lane = laneOf(initial);
    lockQueueLane(this.ctx, lane);
    const row = readRow(this.ctx, id)!;
    this.activeMember(memberId, lane.workspaceId);
    if (row.sender_member_id !== memberId) throw new QueuedMessageError(403, 'not_queued_message_sender', 'Only the sender may change a queued message');
    return { row, lane };
  }

  private activeMember(memberId: string, workspaceId: string): void {
    const member = this.ctx.workspaces().getWorkspaceMember(memberId);
    if (!member || member.archivedAt || member.workspaceId !== workspaceId) {
      throw new QueuedMessageError(403, 'queue_actor_required', 'An active workspace member is required');
    }
  }

  private content(lane: QueueLane, input: { body_md: unknown; attachment_ids?: unknown }, exceptId?: string): { body: string; attachments: string[] } {
    if (typeof input.body_md !== 'string') throw new QueuedMessageError(400, 'invalid_queue_input', 'body_md must be a string');
    const raw = input.attachment_ids ?? [];
    if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !id)) throw new QueuedMessageError(400, 'invalid_queue_input', 'invalid attachment_ids');
    const attachments = [...new Set(raw as string[])];
    if (!input.body_md.trim() && !attachments.length) throw new QueuedMessageError(400, 'invalid_queue_input', 'message content is required');
    if (attachments.length > QUEUE_MAX_ATTACHMENTS) {
      throw new QueuedMessageError(400, 'invalid_queue_input', `at most ${QUEUE_MAX_ATTACHMENTS} attachments are allowed per message`);
    }
    const held = new Set(listRows(this.ctx, lane).filter(row => row.id !== exceptId).flatMap(attachmentIdsOf));
    for (const id of attachments) {
      const attachment = this.ctx.issues().getAttachment(id);
      // Same ownership rules the release send enforces, checked before the row is stored.
      if (!attachment || attachment.workspaceId !== lane.workspaceId || attachment.commentId || attachment.chatMessageId
        || attachment.chatSessionId && attachment.chatSessionId !== lane.sessionId) {
        throw new QueuedMessageError(400, 'invalid_queue_input', 'attachment not found');
      }
      if (held.has(id)) throw new QueuedMessageError(400, 'invalid_queue_input', 'attachment already belongs to another queued message');
    }
    return { body: input.body_md, attachments };
  }

  /** Live rows only: send order, then the lane pause. */
  list(sessionId: string): SessionQueue {
    return sessionQueue(this.ctx, chatLane(this.chat(sessionId)));
  }

  enqueue(input: EnqueueQueuedMessageInput): { item: QueuedMessage; released: QueuedMessageRelease | null } {
    return this.transaction(events => {
      const initial = this.chat(input.session_id);
      const lane = chatLane(initial);
      lockQueueLane(this.ctx, lane);
      const chat = this.chat(input.session_id);
      this.activeMember(input.sender_member_id, chat.workspaceId);
      const clientId = input.client_id ?? createId('qcl');
      const existing = this.ctx.db.query('SELECT * FROM multiremi_queued_messages WHERE session_id=? AND client_id=?')
        .get(chat.id, clientId) as QueueRow | null;
      if (existing) {
        if (existing.sender_member_id !== input.sender_member_id) {
          throw new QueuedMessageError(403, 'not_queued_message_sender', 'Only the sender may change a queued message');
        }
        // A deleted row keeps its client_id; reusing it must not look like a stored message.
        if (existing.status === 'deleted') throw new QueuedMessageError(409, 'queued_message_deleted', 'The queued message with this client_id was deleted');
        return { item: toQueuedMessage(this.ctx, existing), released: existing.status === 'released' ? releaseOf(this.ctx, existing) : null };
      }
      if (chat.status === 'archived') throw new QueuedMessageError(409, 'chat_archived', 'Chat session is archived');
      const { body, attachments } = this.content(lane, input);
      if (countRows(this.ctx, lane, 'live') >= QUEUE_MAX_LIVE_ITEMS) {
        throw new QueuedMessageError(400, 'queue_full', `a Chat queue holds at most ${QUEUE_MAX_LIVE_ITEMS} messages`);
      }
      const seq = Number((this.ctx.db.query(`SELECT COALESCE(MAX(seq),0)+1 AS seq FROM multiremi_queued_messages WHERE ${LANE_SQL}`)
        .get(...laneParams(lane)) as { seq: number }).seq);
      const id = createId('qmsg'), at = nowIso();
      this.ctx.db.run(`INSERT INTO multiremi_queued_messages(id,workspace_id,session_id,agent_id,execution_scope,seq,sender_member_id,
        body_md,attachment_ids,client_id,status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',1,?,?)`,
      [id, lane.workspaceId, lane.sessionId, lane.agentId, lane.scope, seq, input.sender_member_id, body, JSON.stringify(attachments), clientId, at, at]);
      queueUpdated(events, lane);
      let released: QueuedMessageRelease | null = null;
      if (!pauseOf(this.ctx, lane) && laneIdle(this.ctx, lane)) {
        const outcome = releaseQueuedMessagesWithinTransaction(this.ctx, lane, events, 'turn');
        const own = outcome.released.find(entry => entry.id === id);
        if (own) released = { message: own.message, ...(own.turn_id ? { turn_id: own.turn_id } : {}) };
      }
      return { item: toQueuedMessage(this.ctx, readRow(this.ctx, id)!), released };
    });
  }

  update(sessionId: string, id: string, memberId: string, input: UpdateQueuedMessageInput): QueuedMessage {
    return this.transaction(events => {
      const { row, lane } = this.lockRow(sessionId, id, memberId);
      if (row.status === 'deleted') throw new QueuedMessageError(404, 'queued_message_not_found', 'Queued message not found');
      if (row.status === 'released') throw new QueuedMessageError(409, 'queued_message_consumed', 'The queued message was already sent');
      if (input.expected_revision !== undefined && input.expected_revision !== Number(row.revision)) {
        throw new QueuedMessageError(409, 'revision_conflict', 'The queued message changed since it was read');
      }
      const { body, attachments } = this.content(lane, { body_md: input.body_md, attachment_ids: input.attachment_ids ?? attachmentIdsOf(row) }, row.id);
      this.ctx.db.run(`UPDATE multiremi_queued_messages SET body_md=?,attachment_ids=?,status='queued',error=NULL,
        revision=revision+1,updated_at=? WHERE id=?`, [body, JSON.stringify(attachments), nowIso(), id]);
      queueUpdated(events, lane);
      if (row.status === 'failed') this.continueAfterFailedRow(lane, events);
      return toQueuedMessage(this.ctx, readRow(this.ctx, id)!);
    });
  }

  delete(sessionId: string, id: string, memberId: string): QueuedMessage {
    return this.transaction(events => {
      const { row, lane } = this.lockRow(sessionId, id, memberId);
      if (row.status === 'released') throw new QueuedMessageError(409, 'queued_message_consumed', 'The queued message was already sent');
      if (row.status === 'deleted') return toQueuedMessage(this.ctx, row);
      this.ctx.db.run(`UPDATE multiremi_queued_messages SET status='deleted',error=NULL,revision=revision+1,updated_at=? WHERE id=?`, [nowIso(), id]);
      queueUpdated(events, lane);
      if (row.status === 'failed') this.continueAfterFailedRow(lane, events);
      if (!countRows(this.ctx, lane, 'live')) clearPause(this.ctx, lane);
      return toQueuedMessage(this.ctx, readRow(this.ctx, id)!);
    });
  }

  /** Release one row now, whatever the lane state: the send steers, merges or creates a turn. */
  steer(sessionId: string, id: string, memberId: string): SteerQueuedMessageResult {
    return this.transaction(events => {
      const { row, lane } = this.lockRow(sessionId, id, memberId);
      if (row.status === 'deleted') throw new QueuedMessageError(404, 'queued_message_not_found', 'Queued message not found');
      if (row.status === 'released') {
        const release = row.released_via === 'steer' ? releaseOf(this.ctx, row) : null;
        if (!release) throw new QueuedMessageError(409, 'queued_message_consumed', 'The queued message was already sent');
        return { item: toQueuedMessage(this.ctx, row), ...release };
      }
      if (this.chat(sessionId).status === 'archived') throw new QueuedMessageError(409, 'chat_archived', 'Chat session is archived');
      const outcome = releaseQueuedMessagesWithinTransaction(this.ctx, lane, events, 'steer', row.id);
      const item = toQueuedMessage(this.ctx, readRow(this.ctx, id)!);
      if (outcome.failed) return { item, message: null, error: outcome.failed.error };
      if (row.status === 'failed') this.continueAfterFailedRow(lane, events);
      const own = outcome.released[0]!;
      return { item, message: own.message, ...(own.turn_id ? { turn_id: own.turn_id } : {}) };
    });
  }

  /** Clear the pause, retry failed rows and release everything when the lane is idle. */
  resume(sessionId: string, memberId: string): SessionQueue & { released: QueuedMessageRelease[] } {
    return this.transaction(events => {
      const { chat, lane } = this.lockActiveChat(sessionId);
      this.activeMember(memberId, chat.workspaceId);
      const cleared = clearPause(this.ctx, lane);
      const retried = this.ctx.db.run(`UPDATE multiremi_queued_messages SET status='queued',error=NULL,revision=revision+1,updated_at=?
        WHERE ${LANE_SQL} AND status='failed'`, [nowIso(), ...laneParams(lane)]).changes;
      if (cleared || retried) queueUpdated(events, lane);
      const released = laneIdle(this.ctx, lane)
        ? releaseQueuedMessagesWithinTransaction(this.ctx, lane, events, 'turn').released.map(({ id: _id, ...release }) => release) : [];
      return { ...sessionQueue(this.ctx, lane), released };
    });
  }

  /**
   * Editing, deleting or steering the failed row is the documented remedy for
   * `send_failed`: once no failed row remains the queue continues by itself.
   * Other pause reasons wait for an explicit resume. Edits and deletes stay
   * allowed in an archived Chat so the queue can be tidied; there the pause is
   * cleared but nothing is released, so the Chat is not reopened.
   */
  private continueAfterFailedRow(lane: QueueLane, events: CommitEventQueue): void {
    if (pauseOf(this.ctx, lane)?.reason !== 'send_failed' || countRows(this.ctx, lane, 'failed')) return;
    clearPause(this.ctx, lane);
    queueUpdated(events, lane);
    if (this.chat(lane.sessionId).status === 'archived') return;
    if (laneIdle(this.ctx, lane)) releaseQueuedMessagesWithinTransaction(this.ctx, lane, events, 'turn');
  }
}
