/**
 * Long-running Claude CLI subprocess manager.
 *
 * Manages the lifecycle of a `claude --input-format stream-json --output-format stream-json`
 * subprocess, providing async streaming I/O with tool call handling.
 */

import type { Subprocess } from "bun";
import {
  type ContentDelta,
  type ParsedMessage,
  type ResultMessage,
  type SystemMessage,
  type ThinkingDelta,
  type ToolResultMessage,
  type ToolUseRequest,
  formatToolResult,
  formatUserMessage,
  parseLine,
} from "./protocol.js";

/** Tool handler: async (ToolUseRequest) -> string (custom tool) or null (built-in, not handled). */
export type ToolHandler = (request: ToolUseRequest) => Promise<string | null>;

/** Simple promise-based mutex for serializing sends. */
class AsyncLock {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

export class ClaudeProcessManager {
  model: string | null;
  allowedTools: string[];
  systemPrompt: string | null;
  cwd: string | null;

  private _process: Subprocess | null = null;
  private _sessionId: string | null = null;
  private _lock = new AsyncLock();
  private _started = false;
  private _reader: ReadableStreamDefaultReader<string> | null = null;
  private _lineBuffer = "";

  constructor(options: {
    model?: string | null;
    allowedTools?: string[];
    systemPrompt?: string | null;
    cwd?: string | null;
  } = {}) {
    this.model = options.model ?? null;
    this.allowedTools = options.allowedTools ?? [];
    this.systemPrompt = options.systemPrompt ?? null;
    this.cwd = options.cwd ?? null;
  }

  get isAlive(): boolean {
    return this._process !== null && !this._process.killed;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  buildCommand(): string[] {
    const cmd = [
      "claude",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
    ];
    if (this.model) {
      cmd.push("--model", this.model);
    }
    if (this.allowedTools.length > 0) {
      cmd.push("--allowedTools", this.allowedTools.join(","));
    } else {
      cmd.push("--dangerously-skip-permissions");
    }
    if (this.systemPrompt) {
      cmd.push("--append-system-prompt", this.systemPrompt);
    }
    return cmd;
  }

  async start(): Promise<void> {
    if (this.isAlive) {
      throw new Error("Process already running");
    }

    const cmd = this.buildCommand();

    // Strip Claude env vars to avoid nested-session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    this._process = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.cwd ?? undefined,
      env,
    });

    // Set up line reader from stdout
    const decoder = new TextDecoderStream();
    this._process.stdout.pipeTo(decoder.writable).catch(() => {});
    this._reader = decoder.readable.getReader();
    this._lineBuffer = "";

    // Note: Claude CLI stream-json mode emits the system init message only after
    // the first user message is sent. We don't block here — the system message
    // will be captured in sendAndStream().
    this._started = true;
  }

  async *sendAndStream(
    text: string,
    toolHandler?: ToolHandler | null,
  ): AsyncGenerator<ParsedMessage> {
    await this._lock.acquire();
    try {
      if (!this.isAlive) {
        throw new Error("Process not running — call start() first");
      }

      // Send user message
      await this._writeLine(formatUserMessage(text));

      // Stream responses, handling tool calls inline
      let pendingTool: ToolUseRequest | null = null;
      let inputChunks: string[] = [];
      // Track built-in tool timing (tools not handled by Remi)
      let builtInToolPending: { toolUseId: string; name: string; t0: number } | null = null;

      while (true) {
        const line = await this._readline();
        if (line === null) break;

        const msg = parseLine(line);

        // Debug: log parsed message kind
        if ("kind" in msg) {
          console.log(`[claude-proc] event: ${msg.kind}`);
        } else {
          const rawType = (msg as Record<string, unknown>).type;
          if (rawType) console.log(`[claude-proc] raw: ${rawType}`);
        }

        // Emit tool_result for built-in tools when meaningful content arrives
        // (indicates the CLI finished executing the tool and Claude resumed)
        if (builtInToolPending) {
          const isContentEvent =
            msg.kind === "thinking_delta" ||
            msg.kind === "content_delta" ||
            msg.kind === "tool_use" ||
            msg.kind === "result";
          // Also detect content_block_start for text/thinking (new content after tool)
          const isBlockStart =
            !("kind" in msg) &&
            (msg as Record<string, unknown>).type === "content_block_start" &&
            ((msg as Record<string, unknown>).content_block as Record<string, unknown>)?.type !== "tool_use";
          if (isContentEvent || isBlockStart) {
            const elapsed = Date.now() - builtInToolPending.t0;
            yield {
              kind: "tool_result",
              toolUseId: builtInToolPending.toolUseId,
              name: builtInToolPending.name,
              result: "",
              durationMs: elapsed,
            } as ToolResultMessage;
            builtInToolPending = null;
          }
        }

        // Tool use start (streaming — input comes via deltas)
        if (msg.kind === "tool_use" && Object.keys(msg.input).length === 0) {
          pendingTool = msg;
          inputChunks = [];
          continue;
        }

        // Tool use with complete input (non-streaming assistant message)
        if (msg.kind === "tool_use" && Object.keys(msg.input).length > 0) {
          yield msg;
          if (toolHandler) {
            const t0 = Date.now();
            const resultText = await toolHandler(msg);
            if (resultText !== null) {
              // Custom tool handled by Remi
              const elapsed = Date.now() - t0;
              await this._writeLine(formatToolResult(msg.toolUseId, resultText));
              yield {
                kind: "tool_result",
                toolUseId: msg.toolUseId,
                name: msg.name,
                result: resultText.slice(0, 200),
                durationMs: elapsed,
              } as ToolResultMessage;
            } else {
              // Built-in tool — CLI handles it; track timing
              builtInToolPending = { toolUseId: msg.toolUseId, name: msg.name, t0 };
            }
          }
          continue;
        }

        // Input JSON delta accumulation
        if (
          !("kind" in msg) &&
          (msg as Record<string, unknown>).type === "content_block_delta"
        ) {
          const delta = ((msg as Record<string, unknown>).delta as Record<string, unknown>) ?? {};
          if (delta.type === "input_json_delta" && pendingTool) {
            inputChunks.push((delta.partial_json as string) ?? "");
            continue;
          }
        }

        // Content block stop — finalize pending tool if any
        if (
          !("kind" in msg) &&
          (msg as Record<string, unknown>).type === "content_block_stop"
        ) {
          if (pendingTool) {
            const fullJson = inputChunks.join("");
            if (fullJson) {
              try {
                pendingTool.input = JSON.parse(fullJson);
              } catch {
                console.warn("Failed to parse tool input:", fullJson.slice(0, 200));
              }
            }

            yield pendingTool;
            if (toolHandler) {
              const t0 = Date.now();
              const resultText = await toolHandler(pendingTool);
              if (resultText !== null) {
                // Custom tool handled by Remi
                const elapsed = Date.now() - t0;
                await this._writeLine(formatToolResult(pendingTool.toolUseId, resultText));
                yield {
                  kind: "tool_result",
                  toolUseId: pendingTool.toolUseId,
                  name: pendingTool.name,
                  result: resultText.slice(0, 200),
                  durationMs: elapsed,
                } as ToolResultMessage;
              } else {
                // Built-in tool — CLI handles it; track timing
                builtInToolPending = { toolUseId: pendingTool.toolUseId, name: pendingTool.name, t0 };
              }
            }

            pendingTool = null;
            inputChunks = [];
          }
          continue;
        }

        // System init (emitted before first response)
        if (msg.kind === "system") {
          this._sessionId = (msg as SystemMessage).sessionId;
          continue;
        }

        // Thinking delta
        if (msg.kind === "thinking_delta") {
          yield msg;
          continue;
        }

        // Text delta
        if (msg.kind === "content_delta") {
          yield msg;
          continue;
        }

        // Result — end of turn
        if (msg.kind === "result") {
          this._sessionId = msg.sessionId || this._sessionId;
          yield msg;
          return;
        }

        // Other events (content_block_start, rate_limit_event, etc.) — skip
      }
    } finally {
      this._lock.release();
    }
  }

  async stop(): Promise<void> {
    if (!this._process) return;

    if (this.isAlive) {
      try {
        this._process.stdin.end();
        // Wait up to 5s for graceful exit
        const timeout = setTimeout(() => {
          if (this._process && !this._process.killed) {
            this._process.kill();
          }
        }, 5000);
        await this._process.exited;
        clearTimeout(timeout);
      } catch {
        if (this._process && !this._process.killed) {
          this._process.kill();
        }
      }
    }

    this._process = null;
    this._started = false;
    this._reader = null;
  }

  // ── Internal I/O helpers ──────────────────────────────────

  private async _readStderr(): Promise<string> {
    if (!this._process) return "";
    try {
      const text = await new Response(this._process.stderr).text();
      return text.trim().slice(0, 500);
    } catch {
      return "";
    }
  }

  private async _readline(): Promise<string | null> {
    if (!this._reader) return null;

    try {
      while (true) {
        // Check if we already have a full line in buffer
        const newlineIdx = this._lineBuffer.indexOf("\n");
        if (newlineIdx !== -1) {
          const line = this._lineBuffer.slice(0, newlineIdx).trim();
          this._lineBuffer = this._lineBuffer.slice(newlineIdx + 1);
          if (line) return line;
          continue;
        }

        // Read more data
        const { value, done } = await this._reader.read();
        if (done) return null;
        this._lineBuffer += value;
      }
    } catch {
      return null;
    }
  }

  private async _writeLine(data: string): Promise<void> {
    if (!this._process || !this._process.stdin) {
      throw new Error("Process stdin not available");
    }
    this._process.stdin.write(data + "\n");
    await this._process.stdin.flush();
  }

}
