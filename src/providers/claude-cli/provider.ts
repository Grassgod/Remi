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
  Provider,
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
  ThinkingDelta,
  ToolResultMessage,
  ToolUseRequest,
} from "./protocol.js";
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
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      cwd?: string | null;
      sessionId?: string | null;
      chatId?: string | null;
    },
  ): Promise<AgentResponse> {
    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;
    return this._sendStreaming(fullPrompt, {
      systemPrompt: options?.systemPrompt,
      chatId: options?.chatId,
    });
  }

  async *sendStream(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      chatId?: string | null;
      sessionId?: string | null;
      cwd?: string | null;
    },
  ): AsyncGenerator<StreamEvent> {
    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;

    const mgr = await this._ensureProcess(options?.chatId, options?.systemPrompt, options?.sessionId, options?.cwd);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    for await (const msg of mgr.sendAndStream(
      fullPrompt,
      this._handleToolCall.bind(this),
    )) {
      if (msg.kind === "thinking_delta") {
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
        yield { kind: "tool_use", name: tu.name, toolUseId: tu.toolUseId, input: tu.input } as StreamEvent;
      } else if (msg.kind === "tool_result") {
        const tr = msg as ToolResultMessage;
        log.debug(`yield tool_result: ${tr.name} (${tr.durationMs}ms)`);
        yield { kind: "tool_result", toolUseId: tr.toolUseId, name: tr.name, resultPreview: tr.result, durationMs: tr.durationMs } as StreamEvent;
      } else if (msg.kind === "rate_limit") {
        const rl = msg as RateLimitEvent;
        log.debug(`yield rate_limit: ${rl.retryAfterMs}ms`);
        yield { kind: "rate_limit", retryAfterMs: rl.retryAfterMs } as StreamEvent;
      } else if (msg.kind === "error") {
        const err = msg as ErrorEvent;
        log.debug(`yield error: ${err.error}`);
        yield { kind: "error", error: err.error, code: err.code } as StreamEvent;
      } else if (msg.kind === "result") {
        const resultMsg = msg as ResultMessage;
        const fullText = textParts.join("");
        const thinking = thinkingParts.length > 0 ? thinkingParts.join("") : null;
        yield {
          kind: "result",
          response: createAgentResponse({
            text: resultMsg.result || fullText,
            thinking,
            sessionId: resultMsg.sessionId,
            costUsd: resultMsg.costUsd,
            model: resultMsg.model,
            inputTokens: resultMsg.inputTokens,
            outputTokens: resultMsg.outputTokens,
            durationMs: resultMsg.durationMs,
            toolCalls,
          }),
        };
      }
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

  private async _ensureProcess(
    chatId?: string | null,
    systemPrompt?: string | null,
    sessionId?: string | null,
    cwd?: string | null,
  ): Promise<ClaudeProcessManager> {
    const key = chatId ?? ClaudeCLIProvider.DEFAULT_CHAT_ID;

    let mgr = this._pool.get(key);
    if (mgr && mgr.isAlive) {
      this._lastUsed.set(key, Date.now());
      return mgr;
    }

    mgr = new ClaudeProcessManager({
      model: this.model,
      allowedTools: this.allowedTools,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      cwd: cwd ?? this.cwd,
      resumeSessionId: sessionId,
    });
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
    options?: { systemPrompt?: string | null; chatId?: string | null },
  ): Promise<AgentResponse> {
    const mgr = await this._ensureProcess(options?.chatId, options?.systemPrompt);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    let resultMsg: ResultMessage | null = null;

    for await (const msg of mgr.sendAndStream(
      prompt,
      this._handleToolCall.bind(this),
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
