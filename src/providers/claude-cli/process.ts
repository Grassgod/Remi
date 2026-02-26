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
  type ToolUseRequest,
  formatToolResult,
  formatUserMessage,
  parseLine,
} from "./protocol.js";

/** Tool handler: async (ToolUseRequest) -> string */
export type ToolHandler = (request: ToolUseRequest) => Promise<string>;

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

  async start(): Promise<SystemMessage> {
    if (this.isAlive) {
      throw new Error("Process already running");
    }

    const cmd = this.buildCommand();

    // Strip CLAUDECODE env var to avoid nested-session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

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

    // Wait for system init message
    const initMsg = await this._readUntilType("system", 10000);

    if (!initMsg || initMsg.kind !== "system") {
      const stderr = await this._readStderr();
      throw new Error(
        `Streaming init failed: expected SystemMessage${stderr ? ` — stderr: ${stderr}` : ""}`,
      );
    }

    this._sessionId = initMsg.sessionId;
    this._started = true;
    return initMsg;
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

      while (true) {
        const line = await this._readline();
        if (line === null) break;

        const msg = parseLine(line);

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
            const resultText = await toolHandler(msg);
            await this._writeLine(formatToolResult(msg.toolUseId, resultText));
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
              const resultText = await toolHandler(pendingTool);
              await this._writeLine(formatToolResult(pendingTool.toolUseId, resultText));
            }

            pendingTool = null;
            inputChunks = [];
          }
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

        // Other events (content_block_start for text, etc.) — skip
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

  private async _readUntilType(
    targetKind: string,
    timeoutMs: number = 30000,
  ): Promise<ParsedMessage | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const line = await this._readline();
      if (line === null) {
        throw new Error("Process stdout closed before receiving expected message");
      }
      const msg = parseLine(line);
      if ("kind" in msg && msg.kind === targetKind) {
        return msg;
      }
    }

    throw new Error("Timeout waiting for expected message");
  }
}
