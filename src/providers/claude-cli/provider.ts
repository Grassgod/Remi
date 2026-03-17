/**
 * Claude CLI provider — streaming JSONL protocol with fallback.
 *
 * Uses Claude Code subscription — no API key needed.
 *
 * Supports:
 * - Streaming output via long-running subprocess
 * - Custom tool registration and execution
 * - Pre/Post tool hooks
 * - Fallback to single-shot subprocess
 */

import type {
  AgentResponse,
  AskUserQuestionData,
  PlanReviewData,
  Provider,
  SendOptions,
  StreamEvent,
  ToolDefinition,
} from "../base.js";
import { createAgentResponse } from "../base.js";
import { ClaudeProcessManager } from "./process.js";
import type {
  ContentDelta,
  ErrorEvent,
  RateLimitEvent,
  ResultMessage,
  SystemMessage,
  ThinkingDelta,
  ToolResultMessage,
  ToolUseRequest,
} from "./protocol.js";
import { consumeMessageIds, resetMessageIds } from "./protocol.js";
import { createLogger } from "../../logger.js";

const log = createLogger("provider");

/** Pre-hook: (toolName, input) -> allow? Return false to block. */
export type PreToolHook = (toolName: string, input: Record<string, unknown>) => boolean | void;

/** Post-hook: (toolName, input, result) */
export type PostToolHook = (
  toolName: string,
  input: Record<string, unknown>,
  result: string,
) => void;

export class ClaudeCLIProvider implements Provider {
  allowedTools: string[];
  model: string | null;
  timeout: number;
  systemPrompt: string | null;
  cwd: string | null;
  mcpConfig: Record<string, unknown> | null;

  private _pool = new Map<string, ClaudeProcessManager>();
  private _lastUsed = new Map<string, number>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _tools = new Map<string, ToolDefinition>();
  private _preHooks: PreToolHook[] = [];
  private _postHooks: PostToolHook[] = [];

  private static DEFAULT_CHAT_ID = "__default__";
  private static IDLE_TIMEOUT_MS = 10 * 60 * 1000;    // 10 minutes
  private static CLEANUP_INTERVAL_MS = 60 * 1000;      // check every minute

  constructor(options: {
    allowedTools?: string[];
    model?: string | null;
    timeout?: number;
    systemPrompt?: string | null;
    cwd?: string | null;
    mcpConfig?: Record<string, unknown> | null;
  } = {}) {
    this.allowedTools = options.allowedTools ?? [];
    this.model = options.model ?? null;
    this.timeout = options.timeout ?? 300;
    this.systemPrompt = options.systemPrompt ?? null;
    this.cwd = options.cwd ?? null;
    this.mcpConfig = options.mcpConfig ?? null;
  }

  get name(): string {
    return "claude_cli";
  }

  // ── Tool registration ─────────────────────────────────────

  registerTool(tool: ToolDefinition): void {
    this._tools.set(tool.name, tool);
  }

  registerToolsFromDict(tools: Record<string, (...args: unknown[]) => string | Promise<string>>): void {
    for (const [name, handler] of Object.entries(tools)) {
      // Infer parameters from function length (limited but functional)
      const params: Record<string, unknown> = {};
      // Use function source to extract parameter names if possible
      const fnStr = handler.toString();
      const match = fnStr.match(/\(([^)]*)\)/);
      if (match && match[1]) {
        const paramNames = match[1].split(",").map((p) => p.trim().split(/[=:]/)[0].trim());
        for (const pName of paramNames) {
          if (pName) {
            params[pName] = { type: "string" };
          }
        }
      }

      const tool: ToolDefinition = {
        name,
        description: (handler as { __doc__?: string }).__doc__ ?? `Tool: ${name}`,
        parameters: params,
        handler,
      };
      this.registerTool(tool);
    }
  }

  // ── Hook registration ─────────────────────────────────────

  addPreToolHook(hook: PreToolHook): void {
    this._preHooks.push(hook);
  }

  addPostToolHook(hook: PostToolHook): void {
    this._postHooks.push(hook);
  }

  // ── Provider protocol ─────────────────────────────────────

  async send(
    message: string,
    options?: SendOptions,
  ): Promise<AgentResponse> {
    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;
    return this._sendStreaming(fullPrompt, {
      systemPrompt: options?.systemPrompt,
      chatId: options?.chatId,
      media: options?.media,
    });
  }

  /** Max wall-clock time for a single stream interaction (15 min). */
  private static STREAM_DEADLINE_MS = 15 * 60 * 1000;

  async *sendStream(
    message: string,
    options?: SendOptions,
  ): AsyncGenerator<StreamEvent> {
    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;

    const mgr = await this._ensureProcess(
      options?.chatId, options?.systemPrompt, options?.sessionId, options?.cwd,
      { allowedTools: options?.allowedTools, addDirs: options?.addDirs },
    );

    // Reset message ID accumulator for this turn
    resetMessageIds();

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    let sessionModel: string | null = null;
    const deadlineMs = options?.deadlineMs ?? ClaudeCLIProvider.STREAM_DEADLINE_MS;
    const deadline = Date.now() + deadlineMs;
    let gotResult = false;

    for await (const msg of mgr.sendAndStream(
      fullPrompt,
      this._handleToolCall.bind(this),
      options?.media,
    )) {
      // Check wall-clock deadline
      if (Date.now() > deadline) {
        log.error(`Stream exceeded ${deadlineMs / 1000}s deadline, aborting`);
        yield { kind: "error", error: `Task timed out (exceeded ${Math.round(deadlineMs / 60_000)} minute limit).` } as StreamEvent;
        break;
      }

      if (msg.kind === "system") {
        const sys = msg as SystemMessage;
        if (sys.model) sessionModel = sys.model;
        continue;
      } else if (msg.kind === "thinking_delta") {
        const text = (msg as ThinkingDelta).thinking;
        thinkingParts.push(text);
        log.debug(`yield thinking_delta (${text.length} chars)`);
        yield { kind: "thinking_delta", text } as StreamEvent;
      } else if (msg.kind === "content_delta") {
        const text = (msg as ContentDelta).text;
        textParts.push(text);
        log.debug(`yield content_delta (${text.length} chars)`);
        yield { kind: "content_delta", text } as StreamEvent;
      } else if (msg.kind === "tool_use") {
        const tu = msg as ToolUseRequest;
        toolCalls.push({ id: tu.toolUseId, name: tu.name, input: tu.input });
        log.debug(`yield tool_use: ${tu.name}`);

        // Interactive tools: yield special events for user interaction
        if (tu.name === "AskUserQuestion" && tu.input?.questions) {
          const questions = tu.input.questions as AskUserQuestionData["questions"];
          const { promise, resolve, reject } = Promise.withResolvers<Record<string, string>>();
          yield {
            kind: "ask_user",
            data: { toolUseId: tu.toolUseId, questions, resolve, reject },
          } as StreamEvent;
          // Wait for user response (up to 30 min timeout set in process.ts)
          try {
            const answers = await promise;
            log.info(`AskUserQuestion resolved: ${JSON.stringify(answers).slice(0, 200)}`);
            await mgr.sendToolResult(tu.toolUseId, JSON.stringify({ answers }));
            log.info(`AskUserQuestion tool result sent to CLI`);
          } catch (err) {
            log.warn(`AskUserQuestion rejected: ${String(err)}`);
            await mgr.sendToolResult(tu.toolUseId, `User did not respond: ${String(err)}`, true);
          }
          continue;
        }
        if (tu.name === "ExitPlanMode") {
          const { promise, resolve, reject } = Promise.withResolvers<string>();
          yield {
            kind: "plan_review",
            data: { toolUseId: tu.toolUseId, resolve, reject },
          } as StreamEvent;
          try {
            const result = await promise;
            log.info(`ExitPlanMode resolved: ${result}`);
            await mgr.sendToolResult(tu.toolUseId, JSON.stringify({ decision: result }));
            log.info(`ExitPlanMode tool result sent to CLI`);
          } catch (err) {
            log.warn(`ExitPlanMode rejected: ${String(err)}`);
            await mgr.sendToolResult(tu.toolUseId, `User did not respond: ${String(err)}`, true);
          }
          continue;
        }

        yield { kind: "tool_use", name: tu.name, toolUseId: tu.toolUseId, input: tu.input } as StreamEvent;
      } else if (msg.kind === "tool_result") {
        const tr = msg as ToolResultMessage;
        log.debug(`yield tool_result: ${tr.name} (${tr.durationMs}ms)`);
        yield { kind: "tool_result", toolUseId: tr.toolUseId, name: tr.name, resultPreview: tr.result, durationMs: tr.durationMs } as StreamEvent;
      } else if (msg.kind === "rate_limit") {
        const rl = msg as RateLimitEvent;
        log.debug(`yield rate_limit: ${rl.retryAfterMs}ms type=${rl.rateLimitType} status=${rl.status}`);
        yield { kind: "rate_limit", retryAfterMs: rl.retryAfterMs, rateLimitType: rl.rateLimitType, resetsAt: rl.resetsAt, status: rl.status } as StreamEvent;
      } else if (msg.kind === "error") {
        const err = msg as ErrorEvent;
        log.debug(`yield error: ${err.error}`);
        yield { kind: "error", error: err.error, code: err.code } as StreamEvent;
      } else if (msg.kind === "result") {
        gotResult = true;
        const resultMsg = msg as ResultMessage;
        const fullText = textParts.join("");
        const thinking = thinkingParts.length > 0 ? thinkingParts.join("") : null;
        yield {
          kind: "result",
          response: createAgentResponse({
            text: resultMsg.result || fullText,
            thinking,
            sessionId: resultMsg.sessionId,
            requestId: resultMsg.requestId,
            costUsd: resultMsg.costUsd,
            model: resultMsg.model || sessionModel || null,
            inputTokens: resultMsg.inputTokens,
            outputTokens: resultMsg.outputTokens,
            durationMs: resultMsg.durationMs,
            toolCalls,
            metadata: { messageIds: consumeMessageIds() },
          }),
        };
      }
    }

    // If stream ended without a result event, synthesize one so downstream always gets a result
    if (!gotResult) {
      const fullText = textParts.join("") || "[Task ended without result — the CLI process may have crashed or timed out]";
      const thinking = thinkingParts.length > 0 ? thinkingParts.join("") : null;
      log.warn("Stream ended without result event, synthesizing fallback result");
      yield {
        kind: "result",
        response: createAgentResponse({ text: fullText, thinking, toolCalls }),
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = Bun.spawnSync(["claude", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async clearSession(chatId?: string): Promise<void> {
    if (chatId) {
      const mgr = this._pool.get(chatId);
      if (mgr) {
        await mgr.stop();
        this._pool.delete(chatId);
        this._lastUsed.delete(chatId);
        log.info(`Session cleared for chatId="${chatId}" (process killed, will respawn on next message)`);
      }
    } else {
      // Clear all sessions
      const stops = [...this._pool.values()].map((mgr) => mgr.stop());
      await Promise.all(stops);
      this._pool.clear();
      this._lastUsed.clear();
      log.info("All sessions cleared (processes killed)");
    }
  }

  async close(): Promise<void> {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    const stops = [...this._pool.values()].map((mgr) => mgr.stop());
    await Promise.all(stops);
    this._pool.clear();
    this._lastUsed.clear();
  }

  // ── Internal: streaming path ──────────────────────────────

  /** Tool names that require user interaction (handled externally via card actions). */
  private static INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

  /** Get the process manager for a chat (for sending tool results externally). */
  getProcessManager(chatId?: string | null): ClaudeProcessManager | null {
    const key = chatId ?? ClaudeCLIProvider.DEFAULT_CHAT_ID;
    return this._pool.get(key) ?? null;
  }

  private async _ensureProcess(
    chatId?: string | null,
    systemPrompt?: string | null,
    sessionId?: string | null,
    cwd?: string | null,
    overrides?: { allowedTools?: string[]; addDirs?: string[] },
  ): Promise<ClaudeProcessManager> {
    const key = chatId ?? ClaudeCLIProvider.DEFAULT_CHAT_ID;

    let mgr = this._pool.get(key);
    if (mgr && mgr.isAlive) {
      this._lastUsed.set(key, Date.now());
      return mgr;
    }

    mgr = new ClaudeProcessManager({
      model: this.model,
      allowedTools: overrides?.allowedTools ?? this.allowedTools,
      addDirs: overrides?.addDirs,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      cwd: cwd ?? this.cwd,
      resumeSessionId: sessionId,
    });
    mgr.interactiveTools = ClaudeCLIProvider.INTERACTIVE_TOOLS;
    await mgr.start();

    this._pool.set(key, mgr);
    this._lastUsed.set(key, Date.now());
    this._ensureCleanupTimer();

    log.info(`Process started for chatId="${key}" (pool size: ${this._pool.size})`);
    return mgr;
  }

  private _ensureCleanupTimer(): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(
      () => this._cleanupIdleProcesses(),
      ClaudeCLIProvider.CLEANUP_INTERVAL_MS,
    );
    if (typeof this._cleanupTimer.unref === "function") {
      this._cleanupTimer.unref();
    }
  }

  private async _cleanupIdleProcesses(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, lastUsed] of this._lastUsed) {
      if (now - lastUsed > ClaudeCLIProvider.IDLE_TIMEOUT_MS) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      const mgr = this._pool.get(key);
      if (mgr) {
        log.info(`Cleaning up idle process for chatId="${key}"`);
        await mgr.stop();
      }
      this._pool.delete(key);
      this._lastUsed.delete(key);
    }

    if (this._pool.size === 0 && this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  private async _sendStreaming(
    prompt: string,
    options?: { systemPrompt?: string | null; chatId?: string | null; media?: import("./protocol.js").MediaAttachment[] },
  ): Promise<AgentResponse> {
    const mgr = await this._ensureProcess(options?.chatId, options?.systemPrompt);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    let resultMsg: ResultMessage | null = null;

    for await (const msg of mgr.sendAndStream(
      prompt,
      this._handleToolCall.bind(this),
      options?.media,
    )) {
      if (msg.kind === "thinking_delta") {
        thinkingParts.push((msg as ThinkingDelta).thinking);
      } else if (msg.kind === "content_delta") {
        textParts.push((msg as ContentDelta).text);
      } else if (msg.kind === "tool_use") {
        const tu = msg as ToolUseRequest;
        toolCalls.push({
          id: tu.toolUseId,
          name: tu.name,
          input: tu.input,
        });
      } else if (msg.kind === "tool_result") {
        // Non-streaming path — tool_result not needed for final AgentResponse
      } else if (msg.kind === "result") {
        resultMsg = msg as ResultMessage;
      }
    }

    const fullText = textParts.join("");
    const thinking = thinkingParts.length > 0 ? thinkingParts.join("") : null;

    if (resultMsg) {
      return createAgentResponse({
        text: resultMsg.result || fullText,
        thinking,
        sessionId: resultMsg.sessionId,
        costUsd: resultMsg.costUsd,
        model: resultMsg.model,
        inputTokens: resultMsg.inputTokens,
        outputTokens: resultMsg.outputTokens,
        durationMs: resultMsg.durationMs,
        toolCalls,
      });
    }

    return createAgentResponse({ text: fullText, thinking, toolCalls });
  }

  // ── Internal: tool handling ───────────────────────────────

  async _handleToolCall(request: ToolUseRequest): Promise<string | null> {
    const toolName = request.name;
    const toolInput = request.input;

    // Pre-hooks
    for (const hook of this._preHooks) {
      const result = hook(toolName, toolInput);
      if (result === false) {
        return `[Tool call blocked by hook: ${toolName}]`;
      }
    }

    // Find and execute tool (return null for unregistered/built-in tools)
    const toolDef = this._tools.get(toolName);
    if (!toolDef) {
      return null;
    }

    let resultStr: string;
    try {
      const result = toolDef.handler(...Object.values(toolInput));
      // Support both sync and async handlers
      const resolved = result instanceof Promise ? await result : result;
      resultStr = String(resolved);
    } catch (e) {
      log.error(`Tool ${toolName} failed:`, e);
      resultStr = `[Tool error: ${e instanceof Error ? e.message : String(e)}]`;
    }

    // Post-hooks
    for (const hook of this._postHooks) {
      hook(toolName, toolInput, resultStr);
    }

    return resultStr;
  }
}
