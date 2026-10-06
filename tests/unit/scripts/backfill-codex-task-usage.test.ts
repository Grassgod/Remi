import { describe, expect, it } from "bun:test";
import { assignHistoricalUnit, parseNativeUsageEvidence, parseRawUsageEvidence, type HistoricalTaskBoundary } from "../../../scripts/usage-evidence.js";
import { unitActualTotal } from "../../../packages/acp/src/usage-collector.js";

const at = "2026-10-01T01:00:00.000Z";
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const counts = (input: number, output: number, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, total_tokens: input + output });
const token = (total: unknown, last = total, timestamp = at) => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });

describe("historical consumption evidence", () => {
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

  it("does not import whole resumed history, and uses valid last counts as partial after a reset", () => {
    const result = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "resumed" } },
      token(counts(100000, 2000, 90000), counts(30, 4, 10)), token(counts(100, 5, 80), counts(10, 5, 0))), "archive:resume");
    expect(result.units.map(unit => [unitActualTotal(unit), unit.accuracy])).toEqual([[34, "partial"], [15, "partial"]]);
  });

  it("does not let reordered replay corrupt later deltas or reuse prior-epoch identities", () => {
    const rows = [counts(100, 10), counts(200, 20), counts(100, 10), counts(300, 30)];
    const parsed = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "s" } }, ...rows.map(total => token(total, counts(100, 10)))), "reordered");
    expect(parsed.replayed).toBe(1);
    expect(parsed.units.reduce((sum, unit) => sum + unitActualTotal(unit), 0)).toBe(330);
    const reset = parseNativeUsageEvidence("codex", jsonl({ type: "session_meta", payload: { id: "s" } }, token(counts(100, 10)), token(counts(10, 1)), token(counts(100, 10))), "reset");
    expect(reset.units).toHaveLength(3);
    expect(new Set(reset.units.map(unit => unit.unitId)).size).toBe(3);
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
});
