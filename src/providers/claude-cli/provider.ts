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
  ResultMessage,
  ThinkingDelta,
  ToolUseRequest,
} from "./protocol.js";

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

  private _processMgr: ClaudeProcessManager | null = null;
  private _tools = new Map<string, ToolDefinition>();
  private _preHooks: PreToolHook[] = [];
  private _postHooks: PostToolHook[] = [];

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
    },
  ): Promise<AgentResponse> {
    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;
    try {
      return await this._sendStreaming(fullPrompt, { systemPrompt: options?.systemPrompt });
    } catch (e) {
      console.warn(`Streaming send failed, falling back to one-shot subprocess: ${e}`);
      return this._sendFallback(message, options);
    }
  }

  async *sendStream(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
    },
  ): AsyncGenerator<StreamEvent> {
    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;

    await this._ensureProcess(options?.systemPrompt);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    for await (const msg of this._processMgr!.sendAndStream(
      fullPrompt,
      this._handleToolCall.bind(this),
    )) {
      if (msg.kind === "thinking_delta") {
        const text = (msg as ThinkingDelta).thinking;
        thinkingParts.push(text);
        yield { kind: "thinking_delta", text };
      } else if (msg.kind === "content_delta") {
        const text = (msg as ContentDelta).text;
        textParts.push(text);
        yield { kind: "content_delta", text };
      } else if (msg.kind === "tool_use") {
        const tu = msg as ToolUseRequest;
        toolCalls.push({ id: tu.toolUseId, name: tu.name, input: tu.input });
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

  async close(): Promise<void> {
    if (this._processMgr) {
      await this._processMgr.stop();
      this._processMgr = null;
    }
  }

  // ── Internal: streaming path ──────────────────────────────

  private async _ensureProcess(systemPrompt?: string | null): Promise<void> {
    if (this._processMgr && this._processMgr.isAlive) {
      return;
    }

    this._processMgr = new ClaudeProcessManager({
      model: this.model,
      allowedTools: this.allowedTools,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      cwd: this.cwd,
    });
    await this._processMgr.start();
  }

  private async _sendStreaming(
    prompt: string,
    options?: { systemPrompt?: string | null },
  ): Promise<AgentResponse> {
    await this._ensureProcess(options?.systemPrompt);

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    let resultMsg: ResultMessage | null = null;

    for await (const msg of this._processMgr!.sendAndStream(
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

  // ── Internal: fallback path (original subprocess) ─────────

  private async _sendFallback(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      cwd?: string | null;
      sessionId?: string | null;
    },
  ): Promise<AgentResponse> {
    const cmd = ["claude", "-p", "--output-format", "json"];

    if (options?.sessionId) {
      cmd.push("--resume", options.sessionId);
    }
    if (this.model) {
      cmd.push("--model", this.model);
    }
    if (this.allowedTools.length > 0) {
      cmd.push("--allowedTools", this.allowedTools.join(","));
    } else {
      cmd.push("--dangerously-skip-permissions");
    }
    if (this.mcpConfig) {
      cmd.push("--mcp-config", JSON.stringify(this.mcpConfig));
    }
    if (options?.systemPrompt) {
      cmd.push("--append-system-prompt", options.systemPrompt);
    }

    const context = options?.context;
    const fullPrompt = context ? `<context>\n${context}\n</context>\n\n${message}` : message;
    cmd.push(fullPrompt);

    try {
      // Strip CLAUDECODE env var to avoid nested-session detection
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: options?.cwd ?? undefined,
        env,
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderrTrimmed = stderr.trim();
        console.error(`claude CLI error (rc=${exitCode}): ${stderrTrimmed}`);
        return createAgentResponse({
          text: `[Provider error: ${stderrTrimmed || "unknown error"}]`,
        });
      }

      try {
        const data = JSON.parse(stdout) as Record<string, unknown>;
        const usage = (data.usage as Record<string, unknown>) ?? {};
        return createAgentResponse({
          text: (data.result as string) ?? stdout.trim(),
          sessionId: (data.session_id as string) ?? null,
          costUsd: (data.cost_usd as number) ?? (data.total_cost_usd as number) ?? null,
          inputTokens: (usage.input_tokens as number) ?? null,
          outputTokens: (usage.output_tokens as number) ?? null,
          durationMs: (data.duration_ms as number) ?? null,
          model: (data.model as string) ?? null,
        });
      } catch {
        return createAgentResponse({ text: stdout.trim() });
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("ENOENT")) {
        return createAgentResponse({
          text: "[Error: `claude` CLI not found. Is Claude Code installed?]",
        });
      }
      return createAgentResponse({
        text: `[Provider error: ${err instanceof Error ? err.message : String(err)}]`,
      });
    }
  }

  // ── Internal: tool handling ───────────────────────────────

  async _handleToolCall(request: ToolUseRequest): Promise<string> {
    const toolName = request.name;
    const toolInput = request.input;

    // Pre-hooks
    for (const hook of this._preHooks) {
      const result = hook(toolName, toolInput);
      if (result === false) {
        return `[Tool call blocked by hook: ${toolName}]`;
      }
    }

    // Find and execute tool
    const toolDef = this._tools.get(toolName);
    if (!toolDef) {
      return `[Unknown tool: ${toolName}]`;
    }

    let resultStr: string;
    try {
      const result = toolDef.handler(...Object.values(toolInput));
      // Support both sync and async handlers
      const resolved = result instanceof Promise ? await result : result;
      resultStr = String(resolved);
    } catch (e) {
      console.error(`Tool ${toolName} failed:`, e);
      resultStr = `[Tool error: ${e instanceof Error ? e.message : String(e)}]`;
    }

    // Post-hooks
    for (const hook of this._postHooks) {
      hook(toolName, toolInput, resultStr);
    }

    return resultStr;
  }
}
