/** Pure, conservative historical parsers. No database writes or model fallback. */
import { createHash } from "node:crypto";
import type { TaskUsageUnit } from "../packages/contracts/src/usage-accounting.js";
import { actualUnit, meterObservationId, readMeterEvidence, requestUnitId, tokenCount } from "../packages/acp/src/usage-collector.js";
import { normalizeCodexRequestUsage } from "../packages/acp/src/codex-request-usage.js";

type Row = Record<string, any>;
export interface CompletedNativeTurn {
  providerSessionId: string; turnId: string; responseIds: string[]; completedAt: string;
  startedAt: string; startEvidenceRef: string;
  completionEvidenceRef: string; totalsEvidenceRef: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number;
}
export interface NativeSourceScope { unitId: string; providerSessionId: string; turnId: string | null; kind: "request" | "meter"; startedAt?: string; }
export interface UsageEvidenceResult { units: TaskUsageUnit[]; rejected: number; replayed: number; stableRequestIdentity?: boolean; completedTurns?: CompletedNativeTurn[]; sourceScopes?: NativeSourceScope[]; sourceUnits?: TaskUsageUnit[]; }
const record = (v: unknown): Row | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
const count = (v: unknown) => Number.isSafeInteger(v) ? tokenCount(v) : null;
const timestamp = (v: unknown): string | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export function mergeNativeUsageEvidence(old: TaskUsageUnit, next: TaskUsageUnit): TaskUsageUnit {
  if (old.provider !== next.provider || old.providerSessionId !== next.providerSessionId || old.providerRequestId !== next.providerRequestId || old.unitId !== next.unitId) return old;
  if (old.accuracy === "exact" && next.accuracy !== "exact") return old;
  const counters = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  if (counters.some(key => old[key] != null && (next[key] == null || next[key]! < old[key]!))) return old;
  if (old.model && next.model && old.model !== next.model) return old;
  const merged = { ...old, ...next, occurredAt: old.occurredAt, model: next.model ?? old.model };
  for (const key of counters) merged[key] = next[key];
  if (counters.every(key => merged[key] != null)) merged.reportedTotalTokens = counters.reduce((sum, key) => sum + merged[key]!, 0);
  return merged;
}
/** Resolve sources once more after combining archive members, never by numeric equality. */
export function reconcileNativeSourceEvidence(units: TaskUsageUnit[], scopes: NativeSourceScope[], proofs: CompletedNativeTurn[]): TaskUsageUnit[] {
  const requestScopes = scopes.filter(scope => scope.kind === "request");
  const requestsByTurn = new Set(requestScopes.map(scope => JSON.stringify([scope.providerSessionId, scope.turnId])));
  const sessionStarts = new Map<string, { count: number; starts: number; earliest: number }>();
  for (const scope of requestScopes) {
    const previous = sessionStarts.get(scope.providerSessionId) ?? { count: 0, starts: 0, earliest: Infinity };
    previous.count++;
    if (scope.startedAt) { previous.starts++; previous.earliest = Math.min(previous.earliest, Date.parse(scope.startedAt)); }
    sessionStarts.set(scope.providerSessionId, previous);
  }
  const requests = new Map(units.filter(unit => unit.providerRequestId).map(unit => [JSON.stringify([unit.providerSessionId, unit.providerRequestId]), unit]));
  const completeTurns = new Set(proofs.filter(proof => {
    const members = proof.responseIds.map(id => requests.get(JSON.stringify([proof.providerSessionId, id])));
    return members.length > 0 && members.every(value => value?.accuracy === "exact")
      && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every(key => members.reduce((sum, value) => sum + (value as any)[key], 0) === (proof as any)[key]);
  }).map(proof => JSON.stringify([proof.providerSessionId, proof.turnId])));
  const meterScopes = new Map(scopes.filter(scope => scope.kind === "meter").map(scope => [scope.unitId, scope]));
  return units.flatMap(unit => {
    const scope = meterScopes.get(unit.unitId);
    if (!scope) return [unit];
    const sessionStart = sessionStarts.get(scope.providerSessionId);
    const turnKey = JSON.stringify([scope.providerSessionId, scope.turnId]);
    if (!sessionStart || (scope.turnId != null && !requestsByTurn.has(turnKey))) return [unit];
    if (!scope.turnId) {
      if (sessionStart.starts === sessionStart.count && Date.parse(unit.occurredAt) < sessionStart.earliest) return [unit];
    } else if (completeTurns.has(turnKey)) return [];
    return [{ ...unit, scope: "turn" as const, source: "provider_turn" as const, accuracy: "unknown" as const,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, actualUnsplitTokens: null,
      providerSessionId: undefined, providerObservationId: undefined, identityKind: undefined, meterEvidence: undefined,
      costAmount: null, costCurrency: null, evidenceRef: `${unit.evidenceRef}#overlapping-unscoped-meter` }];
  });
}

function contextUnit(provider: string, id: string, raw: Row, occurredAt: string, evidenceRef: string): TaskUsageUnit | null {
  const used = count(raw.used), size = count(raw.size);
  if (used === null || size === null || size <= 0) return null;
  return { ...actualUnit({ unitId: id, provider, scope: "turn", source: "context_snapshot", accuracy: "unknown" }),
    occurredAt, contextTokens: used, contextWindow: size, evidenceRef };
}

/** Legacy v1 details are last-request observations, never cumulative `used`. */
export function parseRawUsageEvidence(input: {
  provider: string; meta: unknown; evidenceRef: string; occurredAt: string;
}): UsageEvidenceResult {
  let parsed = input.meta;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return { units: [], rejected: 1, replayed: 0 }; } }
  const raw = record(parsed);
  if (!raw || !timestamp(input.occurredAt)) return { units: [], rejected: 1, replayed: 0 };
  const units: TaskUsageUnit[] = [];
  const context = contextUnit(input.provider, `context:${digest(input.evidenceRef)}`, raw, input.occurredAt, input.evidenceRef);
  if (context) units.push(context);
  const details = record(raw._meta?.remiTokenUsage);
  if (!details) return { units, rejected: 0, replayed: 0 };
  const split = [count(details.inputTokens), count(details.outputTokens), count(details.cachedInputTokens), count(details.cacheWriteTokens ?? 0)];
  const total = count(details.totalTokens);
  // Compaction estimates expose total > 0 with all detailed counts zero. They
  // do not prove any billable consumption, even when the old patch names them usage.
  if (split.some(n => n === null) || total === null || split.reduce<number>((sum, n) => sum + (n ?? 0), 0) !== total) {
    return { units, rejected: 1, replayed: 0 };
  }
  const stable = typeof details.id === "string" ? details.id : digest(input.evidenceRef);
  const meter = input.provider === "codex" && details.source === "codex_thread_token_usage" ? readMeterEvidence(details.meterEvidence) : undefined;
  const providerSessionId = meter ? details.threadId : details.providerSessionId ?? details.sessionId;
  const providerRequestId = details.providerRequestId
    ?? (input.provider === "claude" && typeof details.id === "string" ? details.id : null);
  const observationId = meter ? meterObservationId(meter.epochId, meter.after) : null;
  const strong = typeof providerSessionId === "string" && !!providerSessionId && (!!meter || typeof providerRequestId === "string" && !!providerRequestId);
  const connectionId = typeof details.connectionId === "string" && details.connectionId ? details.connectionId : null;
  const actual = actualUnit({ unitId: requestUnitId(observationId ?? stable, strong ? providerSessionId : null, connectionId), provider: input.provider,
    providerSessionId: strong ? providerSessionId : null, providerRequestId: strong ? providerRequestId : null,
    providerObservationId: observationId, meterEvidence: meter,
    model: typeof details.model === "string" ? details.model : null,
    requestedModel: typeof details.requestedModel === "string" ? details.requestedModel : null,
    modelSource: details.model ? "provider_reported" : details.requestedModel ? "session_acknowledged" : "unknown",
    scope: "request", source: "provider_request", accuracy: details.id && details.accuracy !== "partial" ? "exact" : "partial",
    inputTokens: split[0], outputTokens: split[1], cacheReadTokens: split[2], cacheWriteTokens: split[3], totalTokens: total,
    evidenceRef: input.evidenceRef });
  actual.occurredAt = timestamp(input.occurredAt)!;
  actual.timeProvenance = "observed_at";
  if (connectionId) actual.connectionId = connectionId;
  units.push(actual);
  return { units, rejected: 0, replayed: 0, stableRequestIdentity: strong };
}

interface CodexCounts { input: number; output: number; cached: number; total: number; }
function codexCounts(value: unknown): CodexCounts | null {
  const v = record(value);
  if (!v) return null;
  const input = count(v.input_tokens), output = count(v.output_tokens), cached = count(v.cached_input_tokens ?? 0), total = count(v.total_tokens);
  // Codex native input includes cached input; reasoning is already in output.
  if (input === null || output === null || cached === null || total === null || cached > input || input + output !== total) return null;
  return { input, output, cached, total };
}

/** Parses individual provider members; caller must establish task ownership. */
export function parseNativeUsageEvidence(provider: "claude" | "codex", body: string, evidenceRef: string): UsageEvidenceResult {
  const units = new Map<string, TaskUsageUnit>();
  let rejected = 0, replayed = 0;
  let sessionId: string | null = null, requestedModel: string | null = null;
  let activeTurnId: string | null = null;
  const meterTurns = new Map<string, string | null>();
  const meterSessions = new Map<string, string>();
  const turnStarts = new Map<string, { at: string; ref: string }>();
  const requestScopes: NativeSourceScope[] = [];
  let meterEpochId: string | null = null, pendingMeterEpochId: string | null = null;
  let parentSessionId: string | null = null, forkedAt: number | null = null;
  let previous: CodexCounts | null = null;
  let epoch = 0;
  let compactionAt: number | null = null;
  const seenCompactions = new Set<string>();
  const seenCumulative = new Set<string>();
  const conflictingRequests = new Set<string>();
  const nativeTurns = new Map<string, { sessionId: string; turnId: string; ids: Set<string>; total: ReturnType<typeof normalizeCodexRequestUsage>; at: string; ref: string }>();
  const completedTurns = new Map<string, { at: string; ref: string }>();
  // A final unterminated JSONL append may have been torn by process death.
  const lines = body.split("\n");
  if (lines.at(-1) !== "") { lines.pop(); rejected++; }
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    let row: Row;
    try { row = JSON.parse(lines[index]!); } catch { rejected++; continue; }
    if (!record(row)) { rejected++; continue; }
    const occurredAt = timestamp(row.timestamp);
    const ref = `${evidenceRef}#line=${index + 1}`;
    if (provider === "claude") {
      if (row.type !== "assistant") continue;
      const message = record(row.message), usage = record(message?.usage);
      if (!message || !usage || typeof message.id !== "string" || !occurredAt || message.model === "<synthetic>") { if (usage) rejected++; continue; }
      const input = count(usage.input_tokens), output = count(usage.output_tokens);
      const cached = count(usage.cache_read_input_tokens ?? 0), write = count(usage.cache_creation_input_tokens ?? 0);
      if ([input, output, cached, write].some(v => v === null)) { rejected++; continue; }
      const nativeSessionId = typeof row.sessionId === "string" ? row.sessionId : typeof row.session_id === "string" ? row.session_id : null;
      const unitId = nativeSessionId ? requestUnitId(message.id, nativeSessionId) : `claude:${message.id}`;
      const old = units.get(unitId);
      const final = typeof message.stop_reason === "string" && message.stop_reason.length > 0;
      if (old?.accuracy === "exact" && !final) { replayed++; continue; }
      if (old && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].some((key, index) => (old as any)[key] != null && [input, output, cached, write][index]! < (old as any)[key])) { rejected++; continue; }
      const next = actualUnit({ unitId, provider, model: typeof message.model === "string" ? message.model : null,
        providerSessionId: nativeSessionId, providerRequestId: message.id,
        accuracy: final ? "exact" : "partial",
        scope: "request", source: "provider_request", inputTokens: Math.max(old?.inputTokens ?? 0, input!),
        outputTokens: Math.max(old?.outputTokens ?? 0, output!), cacheReadTokens: Math.max(old?.cacheReadTokens ?? 0, cached!),
        cacheWriteTokens: Math.max(old?.cacheWriteTokens ?? 0, write!),
        totalTokens: Math.max(old?.inputTokens ?? 0, input!) + Math.max(old?.outputTokens ?? 0, output!)
          + Math.max(old?.cacheReadTokens ?? 0, cached!) + Math.max(old?.cacheWriteTokens ?? 0, write!), evidenceRef: ref });
      next.occurredAt = old?.occurredAt ?? occurredAt;
      next.timeProvenance = "provider_timestamp";
      if (old && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "model", "accuracy"].every(k => (old as any)[k] === (next as any)[k])) { replayed++; continue; }
      // Consolidated native requests have final disjoint counters. Replayed
      // archive snapshots use stable request IDs and the same plan revision.
      next.revision = 1;
      units.set(unitId, next);
      continue;
    }
    if (row.type === "session_meta" && typeof row.payload?.id === "string") {
      const changed = sessionId !== row.payload.id;
      if (sessionId && sessionId !== row.payload.id) { epoch++; previous = null; seenCumulative.clear(); requestedModel = null; compactionAt = null; activeTurnId = null; }
      sessionId = row.payload.id;
      if (changed) {
        meterEpochId = "initial"; pendingMeterEpochId = null;
        parentSessionId = typeof row.payload.forked_from_id === "string" ? row.payload.forked_from_id : null;
        forkedAt = parentSessionId && occurredAt ? Date.parse(occurredAt) : null;
        if (parentSessionId && forkedAt === null) meterEpochId = null;
      }
    }
    if ((row.type === "compacted" || (row.type === "event_msg" && row.payload?.type === "context_compacted")) && occurredAt) {
      const identity = `${sessionId}:${occurredAt}`;
      if (!seenCompactions.has(identity)) {
        seenCompactions.add(identity);
        compactionAt = Date.parse(occurredAt);
        pendingMeterEpochId = typeof row.payload?.item_id === "string" ? `compaction-item:${row.payload.item_id}`
          : typeof row.payload?.turn_id === "string" ? `compaction-turn:${row.payload.turn_id}` : `compaction-timestamp:${occurredAt}`;
      }
    }
    if (row.type === "turn_context" && typeof row.payload?.model === "string") requestedModel = row.payload.model;
    if (row.type === "event_msg" && row.payload?.type === "task_started" && typeof row.payload.turn_id === "string") {
      activeTurnId = row.payload.turn_id;
      if (sessionId && occurredAt) turnStarts.set(JSON.stringify([sessionId, activeTurnId]), { at: occurredAt, ref });
    }
    if (row.type === "turn_context" && typeof row.payload?.turn_id === "string") activeTurnId = row.payload.turn_id;
    if (row.type === "event_msg" && row.payload?.type === "task_complete" && typeof row.payload.turn_id === "string" && sessionId && occurredAt) {
      completedTurns.set(JSON.stringify([sessionId, row.payload.turn_id]), { at: occurredAt, ref });
      if (activeTurnId === row.payload.turn_id) activeTurnId = null;
    }
    const nativeRecord = row.type === "token_usage_record" ? record(row.payload)
      : row.type === "compacted" ? record(row.payload?.latest_token_usage_record) : null;
    if (nativeRecord) {
      const threadId = nativeRecord.thread_id;
      const responseId = nativeRecord.response_id;
      const normalized = typeof threadId === "string" && typeof responseId === "string"
        ? normalizeCodexRequestUsage({ threadId, responseId, turnId: nativeRecord.turn_id, usage: nativeRecord.usage, format: "native" }) : null;
      if (!normalized || !occurredAt || (sessionId && threadId !== sessionId)) { rejected++; continue; }
      const unitId = requestUnitId(responseId, threadId);
      if (conflictingRequests.has(unitId)) { rejected++; continue; }
      const unit = actualUnit({ unitId, provider, providerSessionId: threadId, providerRequestId: responseId,
        scope: "request", source: "provider_request", accuracy: "exact", requestedModel,
        modelSource: requestedModel ? "session_acknowledged" : "unknown",
        inputTokens: normalized.inputTokens, outputTokens: normalized.outputTokens,
        cacheReadTokens: normalized.cachedInputTokens, cacheWriteTokens: normalized.cacheWriteTokens,
        totalTokens: normalized.totalTokens, evidenceRef: ref });
      unit.occurredAt = occurredAt;
      unit.timeProvenance = "provider_timestamp";
      const old = units.get(unitId);
      if (old) {
        if (["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reportedTotalTokens"].every(key => (old as any)[key] === (unit as any)[key])) replayed++;
        else { rejected++; units.delete(unitId); conflictingRequests.add(unitId); }
        continue;
      }
      units.set(unitId, unit);
      requestScopes.push({ unitId, providerSessionId: threadId, turnId: typeof nativeRecord.turn_id === "string" ? nativeRecord.turn_id : null, kind: "request" });
      if (row.type === "token_usage_record" && sessionId === threadId && typeof nativeRecord.turn_id === "string") activeTurnId = nativeRecord.turn_id;
      if (row.type === "token_usage_record" && typeof nativeRecord.turn_id === "string") {
        const key = JSON.stringify([threadId, nativeRecord.turn_id]);
        const turn = nativeTurns.get(key) ?? { sessionId: threadId, turnId: nativeRecord.turn_id, ids: new Set<string>(), total: null, at: occurredAt, ref };
        turn.ids.add(responseId);
        turn.total = normalizeCodexRequestUsage({ threadId, responseId, usage: nativeRecord.turn_token_usage, format: "native" });
        turn.at = occurredAt;
        turn.ref = ref;
        nativeTurns.set(key, turn);
      }
      continue;
    }
    if (row.type !== "event_msg" || row.payload?.type !== "token_count" || !row.payload.info) continue;
    const info = row.payload.info;
    const cumulative = codexCounts(info.total_token_usage), last = codexCounts(info.last_token_usage);
    if (!occurredAt || !sessionId || !cumulative) { rejected++; continue; }
    const fingerprint = JSON.stringify(cumulative);
    // A replay must not move the delta baseline backwards. Counter epochs
    // distinguish genuine resets from identities observed in prior epochs.
    let delta: CodexCounts | null = previous ? {
      input: cumulative.input - previous.input, output: cumulative.output - previous.output,
      cached: cumulative.cached - previous.cached, total: cumulative.total - previous.total,
    } : null;
    const decreasing = delta && Object.values(delta).some(n => n < 0);
    const reset = decreasing && compactionAt !== null && Date.parse(occurredAt) >= compactionAt;
    if (seenCumulative.has(fingerprint) && !reset) { replayed++; continue; }
    const exact = delta && !reset && Object.values(delta).every(n => n >= 0) && delta.cached <= delta.input && delta.input + delta.output === delta.total;
    // A decrease does not prove reset: an unseen notification can arrive late.
    // A new session identity or explicit successful compaction proves an epoch.
    if (decreasing && !reset) { rejected++; continue; }
    if (!exact) delta = last;
    const firstWholeRequest = !previous && last && JSON.stringify(last) === JSON.stringify(cumulative);
    if (!delta) { rejected++; continue; }
    if (reset) { epoch++; seenCumulative.clear(); meterEpochId = pendingMeterEpochId; }
    compactionAt = null;
    seenCumulative.add(fingerprint);
    previous = cumulative;
    const vector = (value: CodexCounts) => ({ inputTokens: value.input - value.cached, outputTokens: value.output,
      cacheReadTokens: value.cached, cacheWriteTokens: 0, totalTokens: value.total });
    const meter = meterEpochId ? readMeterEvidence({ epochId: meterEpochId,
      before: vector({ input: cumulative.input - delta.input, output: cumulative.output - delta.output,
        cached: cumulative.cached - delta.cached, total: cumulative.total - delta.total }),
      after: vector(cumulative), ...(last ? { last: vector(last) } : {}) }) : undefined;
    // Forked archives can contain copied parent history. Real timestamps before
    // the explicit fork metadata belong to the origin session, never the child.
    const originSessionId = parentSessionId && forkedAt !== null && Date.parse(occurredAt) < forkedAt ? parentSessionId : sessionId;
    const observationId = meter ? meterObservationId(meter.epochId, meter.after) : null;
    const unitId = observationId ? requestUnitId(observationId, originSessionId) : `codex:${sessionId}:epoch:${epoch}:${digest(cumulative)}`;
    const unit = actualUnit({ unitId, provider, requestedModel, modelSource: requestedModel ? "session_acknowledged" : "unknown",
      scope: "request", source: "provider_request", providerSessionId: meter ? originSessionId : null,
      providerObservationId: observationId, meterEvidence: meter,
      accuracy: exact || firstWholeRequest ? "exact" : "partial",
      inputTokens: delta.input - delta.cached, outputTokens: delta.output, cacheReadTokens: delta.cached,
      cacheWriteTokens: 0, totalTokens: delta.total, evidenceRef: ref });
    unit.occurredAt = occurredAt;
    unit.timeProvenance = "provider_timestamp";
    if (units.has(unitId)) { replayed++; continue; }
    units.set(unitId, unit);
    meterTurns.set(unitId, activeTurnId ? JSON.stringify([originSessionId, activeTurnId]) : null);
    meterSessions.set(unitId, originSessionId);
  }
  // Request records and the old cumulative stream observe overlapping work.
  // Mixing them would count ordinary responses twice and omit compaction scope.
  const proofs: CompletedNativeTurn[] = [];
  for (const [key, turn] of nativeTurns) {
    const completion = completedTurns.get(key), completedAt = completion?.at, total = turn.total;
    const start = turnStarts.get(key);
    if (!completedAt || !start || !total || Date.parse(completedAt) < Date.parse(turn.at) || Date.parse(start.at) > Date.parse(turn.at)) continue;
    const requests = [...turn.ids].map(id => units.get(requestUnitId(id, turn.sessionId)));
    if (requests.some(unit => !unit)) continue;
    const sums = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reportedTotalTokens"].map(field => requests.reduce((sum, unit) => sum + (unit as any)[field], 0));
    if (JSON.stringify(sums) !== JSON.stringify([total.inputTokens, total.outputTokens, total.cachedInputTokens, total.cacheWriteTokens, total.totalTokens])) continue;
    proofs.push({ providerSessionId: turn.sessionId, turnId: turn.turnId, responseIds: [...turn.ids].sort(), completedAt,
      startedAt: start.at, startEvidenceRef: start.ref,
      completionEvidenceRef: completion!.ref, totalsEvidenceRef: turn.ref,
      inputTokens: total.inputTokens, outputTokens: total.outputTokens, cacheReadTokens: total.cachedInputTokens, cacheWriteTokens: total.cacheWriteTokens, totalTokens: total.totalTokens });
  }
  const sourceScopes: NativeSourceScope[] = [...requestScopes.map(scope => ({ ...scope, startedAt: scope.turnId ? turnStarts.get(JSON.stringify([scope.providerSessionId, scope.turnId]))?.at : undefined })),
    ...[...meterSessions].map(([unitId, providerSessionId]) => ({ unitId, providerSessionId, turnId: meterTurns.get(unitId) ? JSON.parse(meterTurns.get(unitId)!)[1] as string : null, kind: "meter" as const }))];
  return { units: reconcileNativeSourceEvidence([...units.values()], sourceScopes, proofs), rejected, replayed, completedTurns: proofs, sourceScopes, sourceUnits: [...units.values()] };
}

export interface HistoricalTaskBoundary {
  id: string; provider: string | null; session_id: string | null; issue_session_id: string | null;
  started_at: string | null; completed_at: string | null; failed_at: string | null; cancelled_at: string | null;
}

/** No whole-session attribution: an event must fall in exactly one task interval. */
export function assignHistoricalUnit(unit: TaskUsageUnit, tasks: HistoricalTaskBoundary[]): HistoricalTaskBoundary | null {
  const at = Date.parse(unit.occurredAt);
  const eligible = tasks.filter(t => {
    const start = t.started_at && Date.parse(t.started_at);
    const finish = t.completed_at ?? t.failed_at ?? t.cancelled_at;
    const end = finish && Date.parse(finish);
    return t.provider === unit.provider && typeof start === "number" && typeof end === "number"
      && at >= start && at < end;
  });
  return eligible.length === 1 ? eligible[0]! : null;
}
