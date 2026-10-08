import { describe, expect, it } from "bun:test";
import { assignHistoricalUnit, parseNativeUsageEvidence, parseRawUsageEvidence, mergeNativeUsageEvidence, reconcileNativeSourceEvidence, type HistoricalTaskBoundary } from "../../../scripts/usage-evidence.js";
import { unitActualTotal } from "../../../packages/acp/src/usage-collector.js";

const at = "2026-10-01T01:00:00.000Z";
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const counts = (input: number, output: number, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, total_tokens: input + output });
const token = (total: unknown, last = total, timestamp = at) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });

describe("historical consumption evidence", () => {
  it("prefers native response identities, includes compaction requests and deduplicates compacted snapshots", () => {
    const payload = (response_id: string, input: number, output: number, cached: number) => ({ thread_id: "native-thread", turn_id: "native-turn", session_id: "native-session", root_turn_id: "root-turn", response_id,
      usage: counts(input, output, cached), turn_token_usage: counts(300, 30, 120), thread_token_usage: counts(3000, 300, 1200) });
    const compaction = payload("compact-response", 200, 20, 80);
    const parsed = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "native-thread" } },
      { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "native-turn" } },
      token(counts(100, 10, 40)), { type: "token_usage_record", timestamp: at, payload: payload("normal-response", 100, 10, 40) },
      { type: "token_usage_record", timestamp: at, payload: compaction },
      { type: "compacted", timestamp: at, payload: { latest_token_usage_record: compaction } }), "archive:synthetic");
    expect(parsed.replayed).toBe(1);
    expect(parsed.units).toHaveLength(3);
    expect(parsed.units.filter(unit => unit.providerRequestId).every(unit => unit.identityKind === "request" && !unit.meterEvidence)).toBe(true);
    expect(parsed.units.filter(unit => unit.providerRequestId).map(unit => [unit.providerRequestId, unitActualTotal(unit)])).toEqual([["normal-response", 110], ["compact-response", 220]]);
    expect(parsed.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(330);
    expect(parsed.completedTurns).toEqual([]);
    const complete = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "native-thread" } },
      { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "native-turn" } },
      { type: "token_usage_record", timestamp: at, payload: payload("normal-response", 100, 10, 40) },
      { type: "token_usage_record", timestamp: at, payload: compaction },
      { type: "event_msg", timestamp: at, payload: { type: "task_complete", turn_id: "native-turn" } }), "archive:complete");
    expect(complete.completedTurns).toHaveLength(1);
    expect(complete.completedTurns![0]!.responseIds).toEqual(["compact-response", "normal-response"]);
    const truncated = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "native-thread" } },
      { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "native-turn" } },
      { type: "token_usage_record", timestamp: at, payload: payload("normal-response", 100, 10, 40) },
      { type: "event_msg", timestamp: at, payload: { type: "task_complete", turn_id: "native-turn" } }), "archive:missing-request");
    expect(truncated.completedTurns).toEqual([]);
  });
  it("keeps old meter-only turns on a session that later gains native request records, without unscoped double counting", () => {
    const native = { type: "token_usage_record", timestamp: at, payload: { thread_id: "shared-thread", turn_id: "new-turn", response_id: "new-response", usage: counts(200, 20, 80) } };
    const meta = { type: "session_meta", payload: { id: "shared-thread" } };
    const oldAt = "2026-09-01T01:00:00Z";
    const result = parseNativeUsageEvidence("codex", jsonl(meta,
      { type: "event_msg", timestamp: oldAt, payload: { type: "task_started", turn_id: "old-turn" } }, token(counts(100, 10, 40), counts(100, 10, 40), oldAt),
      { type: "event_msg", timestamp: oldAt, payload: { type: "task_complete", turn_id: "old-turn" } },
      { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "new-turn" } }, token(counts(300, 30, 120), counts(200, 20, 80)), native), "archive:mixed");
    expect(result.units.map(unit => unitActualTotal(unit))).toEqual([110, 0, 220]);
    expect(result.units[0]!.identityKind).toBe("cumulative_meter");
    const unscoped = parseNativeUsageEvidence("codex", jsonl(meta, token(counts(200, 20, 80)), native), "archive:unscoped");
    expect(unscoped.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(220);
    expect(unscoped.units.find(unit => !unit.providerRequestId)).toMatchObject({ source: "provider_turn", accuracy: "unknown", inputTokens: null });
    const meterOnly = parseNativeUsageEvidence("codex", jsonl(meta, token(counts(200, 20, 80))), "archive:meter-only");
    const requestOnly = parseNativeUsageEvidence("codex", jsonl(meta, native), "archive:request-only");
    const combined = reconcileNativeSourceEvidence([...meterOnly.sourceUnits!, ...requestOnly.sourceUnits!], [...meterOnly.sourceScopes!, ...requestOnly.sourceScopes!], []);
    expect(combined.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(220);
    expect(combined.find(unit => !unit.providerRequestId)).toMatchObject({ accuracy: "unknown", source: "provider_turn" });
  });
  it("keeps incomplete Claude assistant snapshots partial and merges stronger native archive evidence", () => {
    const row = (output: number, stop_reason: string | null) => ({ type: "assistant", sessionId: "real-session", timestamp: at, message: { id: "real-response", model: "actual-model", stop_reason, usage: { input_tokens: 10, output_tokens: output } } });
    const early = parseNativeUsageEvidence("claude", jsonl(row(1, null)), "archive:early").units[0]!;
    const final = parseNativeUsageEvidence("claude", jsonl(row(10, "end_turn")), "archive:final").units[0]!;
    expect(early.accuracy).toBe("partial");
    expect(final.accuracy).toBe("exact");
    expect(mergeNativeUsageEvidence(early, final)).toMatchObject({ accuracy: "exact", outputTokens: 10 });
    expect(mergeNativeUsageEvidence(final, early)).toEqual(final);
    const conflict = { ...early, inputTokens: 9, outputTokens: 2 };
    expect(mergeNativeUsageEvidence(early, conflict)).toEqual(early);
    const replay = parseNativeUsageEvidence("claude", jsonl(row(10, "end_turn"), row(20, null)), "archive:reordered");
    expect(replay.units[0]).toMatchObject({ accuracy: "exact", outputTokens: 10 });
    const firstPartial = row(10, null), conflictingPartial = row(20, null);
    firstPartial.message.usage.input_tokens = 100;
    conflictingPartial.message.usage.input_tokens = 90;
    const conflicted = parseNativeUsageEvidence("claude", jsonl(firstPartial, conflictingPartial), "archive:conflicted");
    expect(conflicted.units[0]).toMatchObject({ accuracy: "partial", inputTokens: 100, outputTokens: 10 });
    expect(conflicted.rejected).toBe(1);
  });
  it("preserves context peaks as diagnostics and rejects all-zero compaction pseudo usage", () => {
    const context = parseRawUsageEvidence({ provider: "codex", meta: { used: 78048, size: 200000,
      _meta: { remiTokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 78048 } } }, occurredAt: at, evidenceRef: "raw:1" });
    expect(context.rejected).toBe(1);
    expect(context.units).toHaveLength(1);
    expect(context.units[0]).toMatchObject({ source: "context_snapshot", contextTokens: 78048, inputTokens: null, actualUnsplitTokens: null });
    expect(context.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(0);
    const raw = parseRawUsageEvidence({ provider: "codex", meta: { used: 120, size: 200000,
      _meta: { remiTokenUsage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 100, totalTokens: 120 } } }, occurredAt: at, evidenceRef: "raw:2" });
    expect(raw.units[1]).toMatchObject({ model: null, requestedModel: null, accuracy: "partial", inputTokens: 10, cacheReadTokens: 100 });
    expect(raw.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(120);
  });

  it("recovers Claude requests once with actual child models and cumulative output revisions", () => {
    const message = (id: string, model: string, output: number, timestamp = at) => ({ type: "assistant", timestamp,
      sessionId: "session-one", message: { id, model, usage: { input_tokens: 10, output_tokens: output,
        cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } } });
    const result = parseNativeUsageEvidence("claude", jsonl(message("main", "opus", 1), message("main", "opus", 8),
      message("main", "opus", 8), message("child", "haiku", 4)), "archive:test");
    expect(result.replayed).toBe(1);
    expect(result.units.map(unit => [unit.model, unitActualTotal(unit)])).toEqual([["opus", 53], ["haiku", 49]]);
    expect(result.units.every(unit => unit.modelSource === "provider_reported" && unit.evidenceRef?.startsWith("archive:test#line="))).toBe(true);
    expect(parseNativeUsageEvidence("claude", jsonl(message("main", "opus", 8)).trimEnd(), "crashed").units).toEqual([]);
  });

  it("recovers Codex cumulative deltas without cache or reasoning double counting and skips replays", () => {
    const first = counts(100, 20, 80), second = counts(130, 27, 90);
    const result = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "thread-one" } },
      { type: "turn_context", payload: { model: "gateway-request" } }, token(first), token(first),
      token({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 90000 }),
      token(second, counts(30, 7, 10))), "archive:codex");
    expect(result.replayed).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.units.map(unit => unitActualTotal(unit))).toEqual([120, 37]);
    expect(result.units[1]).toMatchObject({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 10,
      actualUnsplitTokens: 0, model: null, requestedModel: "gateway-request", modelSource: "session_acknowledged" });
  });

  it("does not import whole resumed history or infer a reset from a decrease", () => {
    const result = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "resumed" } },
      token(counts(100000, 2000, 90000), counts(30, 4, 10)), token(counts(100, 5, 80), counts(10, 5, 0))), "archive:resume");
    expect(result.units.map(unit => [unitActualTotal(unit), unit.accuracy])).toEqual([[34, "partial"]]);
    expect(result.rejected).toBe(1);
  });

  it("does not let reordered replay corrupt later deltas or reuse prior-epoch identities", () => {
    const rows = [counts(100, 10), counts(200, 20), counts(100, 10), counts(300, 30)];
    const parsed = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "s" } }, ...rows.map(total => token(total, counts(100, 10)))), "reordered");
    expect(parsed.replayed).toBe(1);
    expect(parsed.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(330);
    const reset = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "s" } }, token(counts(100, 10)),
      { type: "session_meta", payload: { id: "different-thread" } }, token(counts(10, 1)), token(counts(100, 10))), "reset");
    expect(reset.units).toHaveLength(3);
    expect(new Set(reset.units.map(unit => unit.unitId)).size).toBe(3);
  });

  it("keeps the native cumulative high-water mark across unseen out-of-order notifications", () => {
    const parsed = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "s" } },
      ...[1, 3, 2, 4].map(n => token(counts(n * 100, n * 10), counts(100, 10)))), "unseen-reordered");
    expect(parsed.rejected).toBe(1);
    expect(parsed.units.map(unit => unitActualTotal(unit))).toEqual([110, 220, 110]);
    expect(parsed.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(440);
  });

  it.each(["compacted", "context_compacted"])("counts new valid requests after the explicit native %s marker, excluding its pseudo total", type => {
    const marker = type === "compacted" ? { type, timestamp: at, payload: { message: "context replacement" } }
      : { type: "event_msg", timestamp: at, payload: { type } };
    const parsed = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "s" } },
      token(counts(300, 30), counts(100, 10)), marker,
      token({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 78048 }),
      token(counts(100, 10)), token(counts(200, 20), counts(100, 10)), marker,
      token(counts(100, 10))), "explicit-compaction");
    expect(parsed.rejected).toBe(1);
    expect(parsed.units.map(unit => [unitActualTotal(unit), unit.accuracy])).toEqual([[110, "partial"], [110, "partial"], [110, "exact"]]);
    expect(parsed.units[1]!.meterEvidence!.epochId).toBe(`compaction-timestamp:${at}`);
    expect(parsed.replayed).toBe(1);
  });

  it("assigns shared session history only within one unambiguous task interval", () => {
    const boundary = (id: string, start: string, finish: string): HistoricalTaskBoundary => ({ id, provider: "claude",
      session_id: "native-session", issue_session_id: "root", started_at: start, completed_at: finish, failed_at: null, cancelled_at: null });
    const unit = parseNativeUsageEvidence("claude", jsonl({ type: "assistant", timestamp: at,
      message: { id: "r", model: "opus", usage: { input_tokens: 1, output_tokens: 1 } } }), "archive:shared").units[0]!;
    const first = boundary("first", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z");
    const second = boundary("second", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z");
    expect(assignHistoricalUnit(unit, [first, second])?.id).toBe("second");
    expect(assignHistoricalUnit(unit, [second, { ...second, id: "overlap" }])).toBeNull();
    expect(assignHistoricalUnit(unit, [{ ...second, started_at: null }])).toBeNull();
  });

  it("identifies cumulative meter observations without claiming a request UID and preserves forked history's origin", () => {
    const first = token(counts(100, 10), counts(100, 10), "2026-10-01T00:30:00.000Z");
    const parent = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", timestamp: "2026-10-01T00:00:00Z", payload: { id: "parent" } }, first), "parent-member");
    const fork = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", timestamp: at, payload: { id: "child", forked_from_id: "parent" } }, first,
      token(counts(200, 20), counts(100, 10), "2026-10-01T01:30:00.000Z")), "fork-member");
    expect(parent.units[0]).toMatchObject({ identityKind: "cumulative_meter", providerSessionId: "parent" });
    expect(parent.units[0]!.providerRequestId).toBeUndefined();
    expect(fork.units[0]!.providerSessionId).toBe("parent");
    expect(fork.units[0]!.providerObservationId).toBe(parent.units[0]!.providerObservationId);
    expect(fork.units[1]!.providerSessionId).toBe("child");
    expect(fork.units[1]!.meterEvidence).toMatchObject({ epochId: "initial", before: { totalTokens: 110 }, after: { totalTokens: 220 } });
  });
});
