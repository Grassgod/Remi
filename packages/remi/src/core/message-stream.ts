/**
 * Remi core — the streaming message pipeline.
 *
 * `handleMessageStream` (lane scheduling, trace root span, conversation row)
 * and `processStream` (slash commands, session resolution, AgentSession run,
 * metrics/conversation persistence) were moved verbatim out of `core.ts`;
 * `Remi` delegates to them.
 */

import type { Remi } from "../core.js";
import type { IncomingMessage } from "@connectors/base.js";
import { createAgentResponse, type AgentResponse, type Provider, type ProviderEvent } from "@shared/contracts/provider-types.js";
import type { ToolCallUpdate, ToolCallProgressUpdate } from "@shared/contracts/acp-protocol.js";
import { resolveAcpPermissionMode } from "@acp/index.js";
import { AgentSession } from "@daemon/agent-runtime/session.js";
import type { AgentRunResult } from "@daemon/agent-runtime/types.js";
import { insertConversationProcessing, completeConversation, failConversation } from "@shared/db/index.js";
import * as sessDb from "@shared/db/sessions.js";
import { createLogger } from "@shared/logger.js";
import { type TraceContext, type Span } from "@shared/tracing.js";
import { tryCommand } from "./commands.js";

const log = createLogger("core");

export async function handleMessageStream(
  remi: Remi,
  msg: IncomingMessage,
  consumer: (stream: AsyncIterable<ProviderEvent>, meta: import("@connectors/base.js").StreamMeta) => Promise<void>,
): Promise<void> {
  const sessionKey = remi._resolveSessionKey(msg);
  await remi._scheduler.run(sessionKey, async () => {
    const topicCwd = await remi._ensureTopicWorkspace(sessionKey, incomingTopicId(msg));
    // Create root trace span
    const msgPreview = msg.text.slice(0, 50).replace(/\n/g, " ");
    const rootSpan = remi.traceCollector.startTrace(`handle: ${msgPreview}`, {
      "chat.id": msg.chatId,
      "session.key": sessionKey,
      "connector.name": msg.connectorName ?? "",
      "message.text": msg.text.slice(0, 200),
    });
    const existingSessionId = sessDb.getSessionId(sessionKey);

  // Phase 1: record "processing" immediately so we know this message exists
  let convId: number | null = null;
  const startMs = Date.now();
  try {
    // Resolve thread_id: rootId if reply, messageId if new group msg, null for P2P
    const _rootId = msg.metadata?.rootId as string | undefined;
    const _msgId = msg.metadata?.messageId as string | undefined;
    const _chatType = msg.metadata?.chatType as string | undefined;
    const threadId = _rootId ?? (_chatType === "group" ? _msgId : undefined);

    convId = insertConversationProcessing({
      chatId: msg.chatId,
      senderId: msg.sender,
      connector: msg.connectorName,
      messageId: _msgId,
      cliSessionId: existingSessionId ?? undefined,
      cliCwd: (msg.metadata?.cwd as string) ?? undefined,
      cliRoundStart: new Date().toISOString(),
      threadId,
      userMessage: msg.text,
      sessionKey,
    });
  } catch (e) {
    log.warn("insert conversation (processing) failed:", e);
  }

  // Create request-scoped logger with traceId = feishu messageId (available from the start)
  const traceId = (msg.metadata?.messageId as string) ?? undefined;
  const rlog = traceId ? log.child({ traceId }) : log;

  try {
    const existingDisplayName = sessDb.getDisplayName(sessionKey);
    const sessRow = sessDb.getSession(sessionKey);
    const provider = remi._getProvider();
    const setPermHandler = typeof (provider as any).setPermissionHandler === "function"
      ? (handler: any) => (provider as any).setPermissionHandler(handler, sessionKey)
      : undefined;
    const setElicHandler = typeof (provider as any).setElicitationHandler === "function"
      ? (handler: any) => (provider as any).setElicitationHandler(handler, sessionKey)
      : undefined;
    const agentType = typeof (provider as any).adapter?.agentType === "string"
      ? (provider as any).adapter.agentType
      : provider.name.startsWith("acp:")
        ? provider.name.slice("acp:".length)
        : null;
    const effectiveMode = agentType
      ? resolveAcpPermissionMode(agentType, sessRow?.mode)
      : sessRow?.mode ?? null;
    await consumer(processStream(remi, msg, rootSpan.context(), convId, startMs, rlog, topicCwd), {
      sessionId: existingSessionId,
      displayName: existingDisplayName,
      providerName: provider.name,
      agentType,
      mode: effectiveMode,
      setPermissionHandler: setPermHandler,
      setElicitationHandler: setElicHandler,
    });
    rootSpan.end();
  } catch (e) {
    rootSpan.endWithError(e instanceof Error ? e.message : String(e));
    // Phase 2b: mark failed
    if (convId != null) {
      try { failConversation(convId, e instanceof Error ? e.message : String(e), Date.now() - startMs); } catch {}
    }
    throw e;
  } finally {
    // Guarantee span is always recorded — SpanImpl._ended prevents double-write
    rootSpan.end();
    remi._activeAborts.delete(sessionKey);
  }
  });
}

export async function *processStream(
  remi: Remi,
  msg: IncomingMessage,
  traceCtx?: TraceContext,
  convId?: number | null,
  startMs?: number,
  rlog?: import("@shared/logger.js").Logger,
  resolvedTopicCwd?: string | null,
): AsyncGenerator<ProviderEvent, AgentResponse | null, unknown> {
  const _log = rlog ?? log; // request-scoped logger (with traceId) or fallback to global

  let resultResponse: AgentResponse | null = null;

  // Handle slash commands — use rawContent (without speaker prefix) for detection
  const rawContent = (msg.metadata?.rawContent as string) ?? msg.text;
  const cmdResponse = await tryCommand(remi, rawContent, msg);
  if (cmdResponse) {
    yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: cmdResponse.text }] };
    resultResponse = cmdResponse;
    return resultResponse;
  }

  const sessionKey = remi._resolveSessionKey(msg);
  const topicCwd = resolvedTopicCwd === undefined
    ? await remi._ensureTopicWorkspace(sessionKey, incomingTopicId(msg))
    : resolvedTopicCwd;
  const sessRow = sessDb.getSession(sessionKey);
  const existingSessionId = sessRow?.session_id || undefined;
  _log.info(`session lookup: key="${sessionKey}" → ${existingSessionId ? `resume="${existingSessionId.slice(0, 12)}..."` : "new session"}`);

  // AbortController for /esc — allows immediate readline interruption
  const abortController = new AbortController();
  remi._activeAborts.set(sessionKey, abortController);

  // Assemble config via AgentRuntime
  const runtimeCtx: import("@daemon/agent-runtime/types.js").PersistentContext = {
    kind: "persistent",
    message: msg,
    agent: remi.agent,
    sessionRow: sessRow,
    sessionKey,
    topicCwd,
  };
  const sessionConfig = remi._runtime.assemble(runtimeCtx);

  const cwd = sessionConfig.cwd;

  const provider = remi._getProvider();

  if (typeof provider.sendStream !== "function") {
    throw new Error(`Provider "${provider.name}" does not support streaming`);
  }

  // Span: provider chat
  const providerSpan = traceCtx?.startSpan("provider.chat", {
    "provider.name": provider.name,
    "session.id": existingSessionId ?? "new",
  });

  // Run the turn through the shared AgentSession — the same execution wrapper
  // the multiremi worker uses — so stream iteration + auto-recovery
  // (prompt-too-long / stale-session) live in one place. onSessionReset drops
  // Remi's own session-DB mapping when AgentSession resets the provider session.
  _log.debug("starting AgentSession.run iteration");
  const toolSpans = new Map<string, Span>(); // toolUseId → Span
  const toolCallMap = new Map<string, { name: string; toolUseId: string; input?: Record<string, unknown>; resultPreview?: string; durationMs?: number }>();
  let streamedText = "";
  let streamedThinking = "";

  const session = new AgentSession(provider, {
    ...sessionConfig,
    signal: abortController.signal,
    recovery: {
      retryOnPromptTooLong: true,
      retryOnStaleSession: true,
      onSessionReset: () => { sessDb.clearSessionId(sessionKey); },
    },
  });

  let runResult: AgentRunResult | null = null;
  try {
    const iter = session.run(msg.text);
    let step = await iter.next();
    while (!step.done) {
      const event = step.value;
      _log.debug(`received event: ${event.sessionUpdate}`);
      if (event.sessionUpdate === "agent_message_chunk") {
        const blocks = Array.isArray(event.content) ? event.content : [event.content];
        for (const block of blocks) {
          if (block.type === "text") streamedText += block.text;
        }
      } else if (event.sessionUpdate === "agent_thought_chunk") {
        const blocks = Array.isArray(event.content) ? event.content : [event.content];
        for (const block of blocks) {
          if (block.type === "text") streamedThinking += block.text;
        }
      }
      yield event;

      if (event.sessionUpdate === "tool_call") {
        const tc = event as ToolCallUpdate;
        const toolName = (tc._meta as any)?.claudeCode?.toolName ?? tc.title ?? "unknown";
        toolCallMap.set(tc.toolCallId, { name: toolName, toolUseId: tc.toolCallId, input: tc.rawInput as Record<string, unknown> });
        if (providerSpan) {
          const toolSpan = providerSpan.context().startSpan(`tool.${toolName}`, {
            "tool.name": toolName,
            "tool.use_id": tc.toolCallId,
            "tool.input": JSON.stringify(tc.rawInput ?? {}).slice(0, 4096),
          });
          toolSpans.set(tc.toolCallId, toolSpan);
        }
      } else if (event.sessionUpdate === "tool_call_update") {
        const tc = event as ToolCallProgressUpdate;
        if (tc.status === "completed" || tc.status === "failed") {
          const existing = toolCallMap.get(tc.toolCallId);
          if (existing) {
            existing.resultPreview = tc.rawOutput ? String(tc.rawOutput).slice(0, 2048) : undefined;
          }
          const toolSpan = toolSpans.get(tc.toolCallId);
          if (toolSpan) {
            if (tc.rawOutput) toolSpan.setAttribute("tool.output", String(tc.rawOutput).slice(0, 4096));
            toolSpan.end();
            toolSpans.delete(tc.toolCallId);
          }
        }
      }
      step = await iter.next();
    }
    runResult = step.value;
  } catch (streamErr) {
    // Preserve prior behavior: an unrecoverable stream error degrades
    // gracefully (use whatever the provider already produced) rather than
    // aborting the turn.
    _log.error(`Stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`);
  }

  resultResponse = runResult?.response
    ?? provider.getLastResponse?.()
    ?? (streamedText ? createAgentResponse({ text: streamedText, thinking: streamedThinking || null }) : null);

  // End any unclosed tool spans
  for (const [, s] of toolSpans) s.end();
  toolSpans.clear();

  if (runResult?.recovered === "prompt_too_long") {
    _log.warn(`Prompt too long for "${sessionKey}", auto-reset and retried`);
    providerSpan?.endWithError("prompt_too_long");
  } else if (runResult?.recovered === "stale_session") {
    _log.warn(`Stale session for "${sessionKey}", auto-reset and retried`);
    providerSpan?.endWithError("stale_session");
  } else {
    // Attach result attributes to provider span
    if (resultResponse && providerSpan) {
      providerSpan.setAttributes({
        "llm.model": resultResponse.model ?? "unknown",
        "llm.input_tokens": resultResponse.inputTokens ?? 0,
        "llm.output_tokens": resultResponse.outputTokens ?? 0,
        "llm.cost_usd": resultResponse.costUsd ?? 0,
        "llm.duration_ms": resultResponse.durationMs ?? 0,
        "llm.response": resultResponse.text.slice(0, 4096),
        "llm.thinking": (resultResponse.thinking ?? "").slice(0, 4096),
      });
    }

    providerSpan?.end();
  }

  // Update the persistent ACP session mapping.
  if (resultResponse) {
    if (resultResponse.sessionId) {
      const displayName = sessDb.upsertSession(sessionKey, resultResponse.sessionId);
      _log.debug(`session stored: key="${sessionKey}" → "${resultResponse.sessionId.slice(0, 12)}..." (${displayName})`);
    }
    // Record token metrics
    if (resultResponse.inputTokens || resultResponse.outputTokens) {
      remi.metrics.record({
        ts: new Date().toISOString(),
        src: "remi",
        sid: resultResponse.sessionId ?? null,
        model: resultResponse.model ?? null,
        in: resultResponse.inputTokens ?? 0,
        out: resultResponse.outputTokens ?? 0,
        cacheCreate: resultResponse.cacheCreateInputTokens ?? 0,
        cacheRead: resultResponse.cacheReadInputTokens ?? 0,
        cost: resultResponse.costUsd ?? null,
        dur: resultResponse.durationMs ?? null,
        project: cwd ?? null,
        connector: msg.connectorName ?? null,
      });
    }

    // Write conversation record to SQLite (Remi business context + CLI correlation)
    // CLI JSONL (~/.claude/projects/) is the full trace; this table is the index.
    try {
      const spans: Array<Record<string, unknown>> = [];

      // Provider chat span
      spans.push({
        op: "provider.chat",
        ms: resultResponse.durationMs ?? 0,
        model: resultResponse.model,
        tool_count: toolCallMap.size,
      });

      // Tool call details
      for (const tc of toolCallMap.values()) {
        spans.push({ op: `tool.${tc.name}`, ms: tc.durationMs ?? 0 });
      }

      // Phase 2a: update to "completed" with full results
      if (convId != null) {
        completeConversation({
          id: convId,
          costUsd: resultResponse.costUsd ?? undefined,
          durationMs: startMs ? Date.now() - startMs : resultResponse.durationMs ?? undefined,
          cliSessionId: resultResponse.sessionId ?? undefined,
          cliRoundEnd: new Date().toISOString(),
          cliMessageIds: (resultResponse.metadata?.messageIds as string[]) ?? undefined,
          model: resultResponse.model ?? undefined,
          inputTokens: resultResponse.inputTokens ?? undefined,
          outputTokens: resultResponse.outputTokens ?? undefined,
          cacheCreateTokens: resultResponse.cacheCreateInputTokens ?? undefined,
          cacheReadTokens: resultResponse.cacheReadInputTokens ?? undefined,
          spans,
        });
      }
    } catch (e) {
      _log.warn("insert conversation failed:", e);
    }
  }

  return resultResponse;
}

function incomingTopicId(message: IncomingMessage): string | null {
  if (message.connectorName !== "feishu") return null;
  const rootId = stringMetadata(message.metadata?.rootId);
  if (rootId) return rootId;
  const chatType = stringMetadata(message.metadata?.chatType);
  const messageId = stringMetadata(message.metadata?.messageId);
  if (chatType === "group" && messageId) return messageId;
  return stringMetadata(message.chatId);
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
