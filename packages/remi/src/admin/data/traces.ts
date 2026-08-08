/**
 * RemiData — Traces.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { type TraceData, rowToTraceData } from "@shared/tracing.js";
import { extractToolCalls, type ToolCallData } from "../../conversation/tool-calls.js";
import { stripContextTags } from "../../conversation/parser.js";
import { getDb } from "@shared/db/index.js";
import { RemiDataContext } from "./context.js";

export class TracesData {
  constructor(private readonly ctx: RemiDataContext) {}

  getTraces(opts: {
    date: string;
    limit: number;
    offset?: number;
    status?: string;
    search?: string;
  }): { items: Array<{
    id: number;
    status: string;
    durationMs: number;
    model: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    connector: string | null;
    chatId: string | null;
    messageId: string | null;
    userMessage: string | null;
    createdAt: string;
  }>; hasMore: boolean } {
    const db = getDb();
    let where = `WHERE DATE(created_at) = ?`;
    const params: any[] = [opts.date];

    if (opts.status) {
      where += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts.search) {
      where += ` AND (user_message LIKE ? OR chat_id LIKE ? OR message_id LIKE ? OR CAST(id AS TEXT) = ?)`;
      const like = `%${opts.search}%`;
      params.push(like, like, like, opts.search);
    }

    const countRow = db.query(`SELECT COUNT(*) as cnt FROM conversations ${where}`).get(...params) as any;
    const total = countRow?.cnt ?? 0;

    const offset = opts.offset ?? 0;
    const fetchLimit = opts.limit + 1; // fetch one extra to detect hasMore
    const rows = db.query(`
      SELECT id, status, duration_ms, model, cost_usd,
             input_tokens, output_tokens, connector, chat_id, message_id,
             user_message, created_at
      FROM conversations
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, fetchLimit, offset) as any[];

    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map(r => ({
      id: r.id,
      status: r.status,
      durationMs: r.duration_ms ?? 0,
      model: r.model,
      costUsd: r.cost_usd,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      connector: r.connector,
      chatId: r.chat_id,
      messageId: r.message_id,
      userMessage: r.user_message ? stripContextTags(r.user_message as string).slice(0, 100) : null,
      createdAt: r.created_at,
    }));

    return { items, hasMore };
  }

  getTrace(traceId: string): TraceData | null {
    const db = getDb();
    // Try by message_id first (traceId = feishu messageId), fall back to conversations.id
    const row = (
      db.query("SELECT * FROM conversations WHERE message_id = ?").get(traceId) ??
      db.query("SELECT * FROM conversations WHERE id = ?").get(Number(traceId))
    ) as any | null;
    return row ? rowToTraceData(row) : null;
  }

  getTraceStats(date: string): {
    total: number;
    processing: number;
    errors: number;
    errorRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
  } {
    const db = getDb();
    const row = db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as errors,
        AVG(CASE WHEN status = 'completed' THEN duration_ms END) as avg_duration
      FROM conversations
      WHERE DATE(created_at) = ?
    `).get(date) as any;

    const completedCount = (row.total ?? 0) - (row.processing ?? 0) - (row.errors ?? 0);
    let p95 = 0;
    if (completedCount > 0) {
      const offset = Math.max(0, Math.ceil(completedCount * 0.95) - 1);
      const p95Row = db.query(`
        SELECT duration_ms FROM conversations
        WHERE DATE(created_at) = ? AND status = 'completed' AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC
        LIMIT 1 OFFSET ?
      `).get(date, offset) as any;
      p95 = p95Row?.duration_ms ?? 0;
    }

    const total = row.total ?? 0;
    const errors = row.errors ?? 0;
    return {
      total,
      processing: row.processing ?? 0,
      errors,
      errorRate: total > 0 ? Math.round((errors / total) * 10000) / 100 : 0,
      avgDurationMs: Math.round(row.avg_duration ?? 0),
      p95DurationMs: p95,
    };
  }

  getTraceDetail(id: number): {
    meta: {
      status: string;
      durationMs: number;
      model: string | null;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      connector: string | null;
      chatId: string;
      threadId: string | null;
      messageId: string | null;
      senderName: string | null;
      sessionId: string | null;
    };
    userMessage: string | null;
    toolCalls: ToolCallData[];
    jsonlAvailable: boolean;
    remiSpans: Array<{ op: string; ms: number }>;
    timeline: Array<{
      name: string;
      startMs: number;
      durationMs: number;
      depth: number;
      toolIndex?: number;
    }>;
  } | null {
    const db = getDb();
    const row = db.query(`
      SELECT id, status, error, chat_id, thread_id, sender_id, connector,
             cli_session_id, message_id, cost_usd, duration_ms, model,
             input_tokens, output_tokens, spans, user_message,
             created_at, cli_round_start, cli_round_end
      FROM conversations WHERE id = ?
    `).get(id) as any | null;
    if (!row) return null;

    let remiSpans: Array<{ op: string; ms: number }> = [];
    try { remiSpans = JSON.parse(row.spans ?? "[]"); } catch {}

    let toolCalls: ToolCallData[] = [];
    let jsonlAvailable = false;
    if (row.cli_session_id) {
      const result = extractToolCalls(row.cli_session_id, row.cli_round_start, row.cli_round_end);
      toolCalls = result.toolCalls;
      jsonlAvailable = result.jsonlAvailable;
    }

    // Build unified timeline: remiSpans (sequential) + link tool calls by index
    const timeline: Array<{
      name: string;
      startMs: number;
      durationMs: number;
      depth: number;
      toolIndex?: number;
    }> = [];
    let elapsed = 0;
    let toolIdx = 0;
    for (const s of remiSpans) {
      const ms = s.ms ?? 0;
      const isToolSpan = s.op.startsWith("tool.");
      timeline.push({
        name: s.op,
        startMs: elapsed,
        durationMs: ms,
        depth: isToolSpan ? 1 : 0,
        toolIndex: isToolSpan && toolIdx < toolCalls.length ? toolIdx++ : undefined,
      });
      elapsed += ms;
    }

    return {
      meta: {
        status: row.status,
        durationMs: row.duration_ms ?? 0,
        model: row.model,
        costUsd: row.cost_usd,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        connector: row.connector,
        chatId: row.chat_id,
        threadId: row.thread_id,
        messageId: row.message_id,
        senderName: row.sender_id,
        sessionId: row.cli_session_id,
      },
      userMessage: row.user_message ? stripContextTags(row.user_message) : null,
      toolCalls,
      jsonlAvailable,
      remiSpans,
      timeline,
    };
  }

  getTraceDetailByMessageId(messageId: string): ReturnType<TracesData["getTraceDetail"]> {
    const db = getDb();
    const row = db.query("SELECT id FROM conversations WHERE message_id = ? LIMIT 1").get(messageId) as { id: number } | null;
    if (!row) return null;
    return this.getTraceDetail(row.id);
  }
}
