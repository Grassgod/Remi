import { normalizeCodexRequestUsage } from "./codex-request-usage.js";

/** Patches only upstream values, never context occupancy or inferred prices. */
export const CODEX_USAGE_PATCH_VERSION = "codex-usage-v6";
export const CLAUDE_USAGE_PATCH_VERSION = "claude-usage-v4";

export function codexUsagePatch(source: string): string | null {
  if (source.includes(`const CODEX_USAGE_PATCH = "${CODEX_USAGE_PATCH_VERSION}";`)) return source;
  const notificationAnchor = "  async createUpdateEvent(notification) {";
  const handlerAnchor = "  async handleNotification(notification) {";
  const childDispatchAnchor = "if (session.current.supportsSubagents) session.current.dispatch(childEvent);";
  // Require the pinned bridge's actual protocol branch; never install a patch
  // that silently falls back to the incomplete cumulative consumption meter.
  if (!source.includes(notificationAnchor) || !source.includes(handlerAnchor)
    || !source.includes('case "rawResponse/completed":') || !source.includes(childDispatchAnchor)) return null;
  // Provision also upgrades already patched bundles. Remove the previous
  // patch's compaction/epoch hook rather than retaining an unused state machine.
  source = source.replace(/\n    \/\/ Upstream's two explicit successful compaction notifications are reset[\s\S]*?\n    }\n/, "\n");
  source = source.replaceAll('      remiMeterEpochId: "sessionId" in request ? null : "initial",\n', "");
  // This callback is installed only for native child thread IDs discovered
  // from this root's spawn/activity events, and already verifies threadId.
  // Usage must still reach the parent when subagent transcript UI is disabled.
  source = source.replace(childDispatchAnchor, `if (childEvent.method === "rawResponse/completed") {
          session.current.dispatch({ ...childEvent, _remiUsageRootSessionId: session.current.rootSessionId });
        } else if (session.current.supportsSubagents) session.current.dispatch(childEvent);`);
  source = source.replace(handlerAnchor, handlerAnchor + `
    // Usage from subscribed native children belongs to the active parent task.
    // Keep the ACP envelope on the parent, but retain the native thread in the
    // request identity. Child rendering/lifecycle filters must not drop usage.
    if (notification.method === "rawResponse/completed") {
      const threadId = notification.params?.threadId;
      if (threadId !== this.sessionState.sessionId && notification._remiUsageRootSessionId !== this.sessionState.sessionId) return;
      const update = await this.createUpdateEvent(notification);
      if (update) await this.session.update(update);
      return;
    }
`);
  source = source.replace(notificationAnchor, notificationAnchor + `
    if (notification.method === "rawResponse/completed") {
      const p = notification.params;
      if (typeof p?.threadId !== "string" || !p.threadId || typeof p.responseId !== "string" || !p.responseId) return null;
      const normalize = ${normalizeCodexRequestUsage.toString()};
      const usage = normalize({ threadId: p.threadId, responseId: p.responseId, turnId: p.turnId, usage: p.usage, format: "protocol" });
      const requestedModel = p.threadId === this.sessionState.sessionId ? this.sessionState.currentModelId ?? null : null;
      // A missing/malformed request usage still proves a request occurred.
      // Keep that coverage gap without replacing it with the last-request or
      // thread cumulative counters, neither of which includes all compaction.
      const missing = usage ? undefined : {
        id: p.responseId, providerSessionId: p.threadId, providerRequestId: p.responseId,
        scope: "request_snapshot", source: "codex_response_usage", accuracy: "unknown", model: null,
        requestedModel, modelSource: requestedModel ? "session_acknowledged" : "unknown"
      };
      return { sessionUpdate: "usage_update", used: 0, size: 0, _meta: {
        remiUsagePatch: "${CODEX_USAGE_PATCH_VERSION}", remiUsageMode: "request",
        ...(usage ? { remiTokenUsage: { ...usage, requestedModel,
          modelSource: requestedModel ? "session_acknowledged" : "unknown" } } : { remiMissingRequestUsage: missing })
      } };
    }
`);
  const start = source.indexOf("  createUsageUpdate(params) {");
  const end = source.indexOf("\n  handleRateLimitsUpdated(params)", start);
  if (start < 0 || end < 0) return null;
  return source.slice(0, start) + `  createUsageUpdate(params) {
    const CODEX_USAGE_PATCH = "${CODEX_USAGE_PATCH_VERSION}";
    this.handleTokenUsageUpdated(params);
    const last = this.sessionState.lastTokenUsage;
    // The old thread counter is an active-context diagnostic, not a ledger of
    // every paid response. In particular it omits remote compaction requests.
    return {
      sessionUpdate: "usage_update",
      used: last?.totalTokens ?? 0,
      size: this.sessionState.modelContextWindow ?? 0,
      _meta: { remiUsagePatch: CODEX_USAGE_PATCH, remiUsageMode: "request" }
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
                const validFinalUsage = usage => [usage?.input_tokens, usage?.output_tokens,
                    usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0]
                    .every(value => Number.isSafeInteger(value) && value >= 0);
                const mergeUsage = (previous, next) => {
                    const usage = { ...previous };
                    for (const [key, value] of Object.entries(next ?? {})) {
                        if (value == null) continue;
                        usage[key] = typeof value === "number" && typeof usage[key] === "number" ? Math.max(usage[key], value) : value;
                    }
                    return usage;
                };
                let request = null;
                if (message.type === "stream_event") {
                    const event = message.event;
                    if (event.type === "message_start") {
                        session.remiUsageRequests.delete(lane);
                        if (event.message.model !== "<synthetic>") {
                            request = { id: event.message.id, sessionId: message.session_id, model: event.message.model, usage: { ...event.message.usage }, accuracy: "partial" };
                            session.remiUsageRequests.set(lane, request);
                        }
                    } else if (event.type === "message_delta") {
                        const previous = session.remiUsageRequests.get(lane);
                        if (previous) request = { ...previous, usage: mergeUsage(previous.usage, event.usage),
                            finalUsage: previous.finalUsage || (event.delta?.stop_reason != null && Number.isSafeInteger(event.usage?.output_tokens)
                                && event.usage.output_tokens >= 0 && validFinalUsage(mergeUsage(previous.usage, event.usage))) };
                        if (request) session.remiUsageRequests.set(lane, request);
                    } else if (event.type === "message_stop") {
                        const previous = session.remiUsageRequests.get(lane);
                        if (previous) request = { ...previous, accuracy: previous.finalUsage ? "exact" : previous.accuracy };
                        if (request) session.remiUsageRequests.set(lane, request);
                    }
                } else if (message.type === "assistant" && message.message.model !== "<synthetic>") {
                    const previous = session.remiUsageRequests.get(lane);
                    // Claude yields assistant blocks before message_delta and later
                    // mutates their usage in place without yielding them again.
                    const assistantUsage = message.message.usage;
                    const finalAssistantUsage = message.message.stop_reason != null && validFinalUsage(assistantUsage);
                    request = { id: message.message.id, sessionId: message.session_id, model: message.message.model, usage: assistantUsage && { ...assistantUsage },
                        accuracy: finalAssistantUsage ? "exact" : "partial" };
                    if (previous?.id === request.id && previous.sessionId === request.sessionId) {
                        request.usage = mergeUsage(previous.usage, request.usage);
                        request.finalUsage = previous.finalUsage;
                        if (previous.accuracy === "exact") request.accuracy = "exact";
                        session.remiUsageRequests.set(lane, request);
                    }
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
