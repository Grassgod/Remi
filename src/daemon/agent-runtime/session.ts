/**
 * AgentSession — unified execution layer for agent interactions.
 *
 * Wraps a Provider and AgentSessionConfig to handle stream iteration,
 * error recovery (stale session, prompt-too-long), and result collection.
 * Both Remi (persistent) and Multiremi (ephemeral) use this to run an
 * agent turn.
 */

import type { Provider, AgentResponse, ProviderEvent, SendOptions } from "../../shared/contracts/provider-types.js";
import { createAgentResponse } from "../../shared/contracts/provider-types.js";
import type { AgentSessionConfig, AgentRunResult } from "./types.js";

export class AgentSession {
  private readonly provider: Provider;
  private readonly config: AgentSessionConfig;

  constructor(provider: Provider, config: AgentSessionConfig) {
    this.provider = provider;
    this.config = config;
  }

  async *run(prompt: string): AsyncGenerator<ProviderEvent, AgentRunResult, unknown> {
    const { provider, config } = this;
    const sendOptions = this.buildSendOptions();

    let resultResponse: AgentResponse | null = null;
    let streamedText = "";
    let streamedThinking = "";
    let promptTooLong = false;
    let staleSession = false;

    // First attempt
    let unhandledError: unknown = null;
    try {
      for await (const event of provider.sendStream!(prompt, sendOptions)) {
        this.accumulateText(event, (t) => (streamedText += t), (t) => (streamedThinking += t));
        yield event;
      }
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      if (/prompt.*(too long|too_long)|context.*(too long|exceed)/i.test(errText)) {
        promptTooLong = true;
      } else if (sendOptions.sessionId && /no conversation found/i.test(errText)) {
        staleSession = true;
      } else {
        unhandledError = err;
      }
    }

    resultResponse = provider.getLastResponse?.() ?? null;
    if (!resultResponse && streamedText) {
      resultResponse = createAgentResponse({ text: streamedText, thinking: streamedThinking || null });
    }

    // Detect issues from response
    if (!promptTooLong && resultResponse && /prompt.*(too long|too_long)|context.*(too long|exceed)/i.test(resultResponse.text)) {
      promptTooLong = true;
    }
    if (!staleSession && sendOptions.sessionId && resultResponse && resultResponse.inputTokens === 0 && resultResponse.durationMs === 0) {
      staleSession = true;
    }

    // Re-throw non-recoverable errors
    if (unhandledError) {
      throw unhandledError;
    }

    // Recovery
    if (config.recovery) {
      if (promptTooLong && config.recovery.retryOnPromptTooLong) {
        yield* this.retryAfterReset(prompt, sendOptions, "上下文过长，已自动重置会话。正在重新处理...\n\n");
        resultResponse = provider.getLastResponse?.() ?? null;
      } else if (staleSession && config.recovery.retryOnStaleSession) {
        yield* this.retryAfterReset(prompt, sendOptions, "会话已过期，自动重置。正在重新处理...\n\n");
        resultResponse = provider.getLastResponse?.() ?? null;
      }
    }

    return {
      response: resultResponse,
      sessionId: resultResponse?.sessionId ?? null,
      text: resultResponse?.text ?? streamedText,
      thinking: resultResponse?.thinking ?? streamedThinking,
    };
  }

  private buildSendOptions(): SendOptions {
    const c = this.config;
    return {
      systemPrompt: c.systemPrompt,
      chatId: c.chatId,
      sessionId: c.sessionId,
      cwd: c.cwd,
      media: c.media,
      allowedTools: c.allowedTools,
      addDirs: c.addDirs,
      permissionMode: c.permissionMode,
      traceId: c.traceId,
      signal: c.signal,
    };
  }

  private accumulateText(
    event: ProviderEvent,
    onText: (t: string) => void,
    onThinking: (t: string) => void,
  ): void {
    if (event.sessionUpdate === "agent_message_chunk") {
      const blocks = Array.isArray(event.content) ? event.content : [event.content];
      for (const block of blocks) {
        if (block.type === "text") onText(block.text);
      }
    } else if (event.sessionUpdate === "agent_thought_chunk") {
      const blocks = Array.isArray(event.content) ? event.content : [event.content];
      for (const block of blocks) {
        if (block.type === "text") onThinking(block.text);
      }
    }
  }

  private async *retryAfterReset(
    prompt: string,
    opts: SendOptions,
    message: string,
  ): AsyncGenerator<ProviderEvent> {
    // Clear session on provider if supported
    if ("clearSession" in this.provider && typeof (this.provider as any).clearSession === "function") {
      await (this.provider as any).clearSession(opts.chatId);
    }

    yield {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: message }],
    } as ProviderEvent;

    const retryOpts = { ...opts, sessionId: undefined };
    for await (const event of this.provider.sendStream!(prompt, retryOpts)) {
      yield event;
    }
  }
}
