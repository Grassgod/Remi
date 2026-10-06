/** Patches only upstream values, never context occupancy or inferred prices. */
export const CODEX_USAGE_PATCH_VERSION = "codex-usage-v5";
export const CLAUDE_USAGE_PATCH_VERSION = "claude-usage-v3";

export function codexUsagePatch(source: string): string | null {
  if (source.includes(`const CODEX_USAGE_PATCH = "${CODEX_USAGE_PATCH_VERSION}";`)) return source;
  const notificationAnchor = "  async createUpdateEvent(notification) {";
  if (!source.includes(notificationAnchor)) return null;
  // Only opening a genuinely new upstream session proves the initial epoch.
  // Resuming/forking a session without its reset history leaves epoch unknown.
  source = source.replaceAll("const sessionState = {\n      sessionId,\n      currentModelId,", "const sessionState = {\n      sessionId,\n      remiMeterEpochId: \"sessionId\" in request ? null : \"initial\",\n      currentModelId,");
  source = source.replace(notificationAnchor, notificationAnchor + `
    // Upstream's two explicit successful compaction notifications are reset
    // evidence. Error/start notifications and display text are not evidence.
    if (notification.method === "thread/compacted" || (notification.method === "item/completed" && notification.params?.item?.type === "contextCompaction")) {
      const p = notification.params ?? {};
      const threadId = String(p.threadId ?? this.sessionState.sessionId);
      const key = threadId + ":" + String(p.item?.id ?? p.turnId ?? this.sessionState.currentTurnId ?? "thread-compacted");
      const seen = this.sessionState.remiUsageCompactions ??= new Set();
      if (!seen.has(key)) {
        seen.add(key);
        this.sessionState.remiUsageCompactionPending = { threadId,
          epochId: typeof p.item?.id === "string" ? "compaction-item:" + p.item.id
            : typeof p.turnId === "string" ? "compaction-turn:" + p.turnId : null };
      }
    }
`);
  const start = source.indexOf("  createUsageUpdate(params) {");
  const end = source.indexOf("\n  handleRateLimitsUpdated(params)", start);
  if (start < 0 || end < 0) return null;
  return source.slice(0, start) + `  createUsageUpdate(params) {
    const CODEX_USAGE_PATCH = "${CODEX_USAGE_PATCH_VERSION}";
    const previous = this.sessionState.remiUsageAccounting?.baseline ?? this.sessionState.totalTokenUsage;
    this.handleTokenUsageUpdated(params);
    const current = this.sessionState.totalTokenUsage;
    const last = this.sessionState.lastTokenUsage;
    if (!current || !last) return null;
    const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
    const valid = value => value && fields.filter(key => key !== "reasoningOutputTokens").every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      && value.inputTokens + value.cachedInputTokens + value.outputTokens === value.totalTokens;
    const threadId = String(params.threadId ?? this.sessionState.sessionId);
    const state = this.sessionState.remiUsageAccounting ??= { baseline: previous, seen: new Set(previous ? [JSON.stringify(previous)] : []), epoch: 0, threadId };
    // A different upstream thread proves a new counter identity. A smaller
    // total within one thread can be a previously unseen delayed notification.
    if (state.threadId !== threadId) { state.threadId = threadId; state.epoch++; state.baseline = null; state.seen.clear(); this.sessionState.remiMeterEpochId = null; }
    const fingerprint = JSON.stringify(current);
    if (!valid(current) || !valid(last)) {
      this.sessionState.totalTokenUsage = state.baseline;
      return { sessionUpdate: "usage_update", used: last.totalTokens, size: this.sessionState.modelContextWindow ?? 0,
        _meta: { remiUsagePatch: CODEX_USAGE_PATCH, remiUncertainUsage: { reportedTotalTokens: current.totalTokens, reason: "ambiguous_compaction_total" } } };
    }
    // On session/load the bridge has no baseline but thread totals include
    // previous prompts. Only last belongs to the newly observed request.
    const hadBaseline = !!state.baseline;
    let delta = hadBaseline ? Object.fromEntries(fields.map(key => [key, current[key] - state.baseline[key]])) : last;
    const decreasing = fields.filter(key => key !== "reasoningOutputTokens").some(key => delta[key] < 0);
    const reset = decreasing && this.sessionState.remiUsageCompactionPending?.threadId === threadId;
    if (state.seen.has(fingerprint) && !reset) { this.sessionState.totalTokenUsage = state.baseline; return null; }
    // Identical cumulative notifications are replay, not another request.
    if (fields.every(key => delta[key] === 0)) return null;
    if (decreasing && !reset) {
      this.sessionState.totalTokenUsage = state.baseline;
      return { sessionUpdate: "usage_update", used: last.totalTokens, size: this.sessionState.modelContextWindow ?? 0,
        _meta: { remiUsagePatch: CODEX_USAGE_PATCH, remiUncertainUsage: { reportedTotalTokens: current.totalTokens, reason: "non_monotonic_cumulative_usage" } } };
    }
    if (reset) {
      state.epoch++; state.seen.clear(); delta = last;
      this.sessionState.remiMeterEpochId = this.sessionState.remiUsageCompactionPending.epochId;
    }
    this.sessionState.remiUsageCompactionPending = null;
    state.seen.add(fingerprint);
    state.baseline = current;
    return {
      sessionUpdate: "usage_update",
      used: last.totalTokens,
      size: this.sessionState.modelContextWindow ?? 0,
      _meta: {
        remiUsagePatch: CODEX_USAGE_PATCH,
        remiTokenUsage: {
          ...delta,
          scope: "delta",
          source: "codex_thread_token_usage",
          accuracy: hadBaseline && !reset ? "exact" : "partial",
          // Thread totals carry no per-model breakdown. The selected model
          // is evidence of routing, not proof that child requests used it.
          model: null,
          requestedModel: this.sessionState.currentModelId ?? null,
          modelSource: this.sessionState.currentModelId ? "session_acknowledged" : "unknown",
          id: threadId + ":epoch:" + state.epoch + ":" + fingerprint,
          threadId,
          turnId: params.turnId ?? this.sessionState.currentTurnId,
          cumulative: current,
          meterEvidence: typeof this.sessionState.remiMeterEpochId === "string" ? {
            epochId: this.sessionState.remiMeterEpochId,
            before: { inputTokens: current.inputTokens - delta.inputTokens, outputTokens: current.outputTokens - delta.outputTokens,
              cacheReadTokens: current.cachedInputTokens - delta.cachedInputTokens, cacheWriteTokens: 0, totalTokens: current.totalTokens - delta.totalTokens },
            after: { inputTokens: current.inputTokens, outputTokens: current.outputTokens, cacheReadTokens: current.cachedInputTokens,
              cacheWriteTokens: 0, totalTokens: current.totalTokens },
            last: { inputTokens: last.inputTokens, outputTokens: last.outputTokens, cacheReadTokens: last.cachedInputTokens,
              cacheWriteTokens: 0, totalTokens: last.totalTokens }
          } : null
        }
      }
    };
  }` + source.slice(end);
}

export function claudeUsagePatch(source: string): string | null {
  if (source.includes(`const CLAUDE_USAGE_PATCH = "${CLAUDE_USAGE_PATCH_VERSION}";`)) return source;
  const anchor = "                if (session.emitRawSDKMessages &&";
  if (!source.includes(anchor)) return null;
  const oldHook = source.indexOf("                const CLAUDE_USAGE_PATCH = ");
  if (oldHook >= 0) {
    const oldEnd = source.indexOf(anchor, oldHook);
    if (oldEnd < 0) return null;
    source = source.slice(0, oldHook) + source.slice(oldEnd);
  }
  const hook = `                const CLAUDE_USAGE_PATCH = "${CLAUDE_USAGE_PATCH_VERSION}";
                // Preserve each upstream request snapshot before any cancellation
                // or failure handling can abandon the active prompt.
                session.remiUsageRequests ??= new Map();
                if (message.type === "result" && Number.isFinite(message.total_cost_usd) && message.total_cost_usd >= 0) {
                    await this.client.sessionUpdate({ sessionId: params.sessionId, update: {
                        sessionUpdate: "usage_update", used: 0, size: 0,
                        cost: { amount: message.total_cost_usd, currency: "USD" },
                        _meta: { remiUsagePatch: CLAUDE_USAGE_PATCH, remiCostUsage: { scope: "turn", source: "sdk_estimate" } }
                    } });
                }
                const lane = message.parent_tool_use_id ?? "main";
                let request = null;
                if (message.type === "stream_event") {
                    const event = message.event;
                    if (event.type === "message_start" && event.message.model !== "<synthetic>") {
                        request = { id: event.message.id, sessionId: message.session_id, model: event.message.model, usage: event.message.usage, accuracy: "partial" };
                        session.remiUsageRequests.set(lane, request);
                    } else if (event.type === "message_delta") {
                        const previous = session.remiUsageRequests.get(lane);
                        if (previous) request = { ...previous, usage: { ...previous.usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, value]) => value != null)) } };
                        if (request) session.remiUsageRequests.set(lane, request);
                    }
                } else if (message.type === "assistant" && message.message.model !== "<synthetic>") {
                    request = { id: message.message.id, sessionId: message.session_id, model: message.message.model, usage: message.message.usage, accuracy: "exact" };
                    if (session.remiUsageRequests.get(lane)?.id === request.id) session.remiUsageRequests.delete(lane);
                }
                if (request?.id && request.usage) {
                    const usage = request.usage;
                    const inputTokens = usage.input_tokens ?? 0;
                    const outputTokens = usage.output_tokens ?? 0;
                    const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
                    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
                    await this.client.sessionUpdate({ sessionId: params.sessionId, update: {
                        sessionUpdate: "usage_update", used: 0, size: 0,
                        _meta: { remiUsagePatch: CLAUDE_USAGE_PATCH, remiTokenUsage: {
                            id: request.id, model: request.model, scope: "request_snapshot",
                            providerSessionId: request.sessionId ?? message.session_id ?? null,
                            providerRequestId: request.sessionId || message.session_id ? request.id : null,
                            source: "claude_assistant_usage", accuracy: request.accuracy,
                            parentToolUseId: message.parent_tool_use_id ?? null,
                            inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens,
                            totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheWriteTokens
                        } }
                    } });
                }
`;
  return source.replace(anchor, hook + anchor);
}
