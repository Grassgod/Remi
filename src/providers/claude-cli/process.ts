/**
 * Long-running Claude CLI subprocess manager.
 *
 * Manages the lifecycle of a `claude --input-format stream-json --output-format stream-json`
 * subprocess, providing async streaming I/O with tool call handling.
 */

import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ApiRetry,
  type AssistantBlocks,
  type CompactBoundary,
  type CompactingStatus,
  type ContentDelta,
  type MediaAttachment,
  type ParsedMessage,
  type ResultMessage,
  type SystemMessage,
  type ThinkingDelta,
  type ToolProgress,
  type ToolResultMessage,
  type ToolUseRequest,
  formatToolResult,
  formatUserMessage,
  parseLine,
} from "./protocol.js";
import { createLogger } from "../../logger.js";

const log = createLogger("claude-proc");

function getDescendantPids(pid: number): number[] {
  const result: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const p = stack.pop()!;
    try {
      const children = readFileSync(`/proc/${p}/task/${p}/children`, "utf-8")
        .trim().split(/\s+/).filter(Boolean).map(Number);
      for (const child of children) {
        result.push(child);
        stack.push(child);
      }
    } catch {}
  }
  return result;
}

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
  addDirs: string[];
  systemPrompt: string | null;
  cwd: string | null;
  resumeSessionId: string | null;
  permissionMode: string | null;

  private _process: Subprocess | null = null;
  private _sessionId: string | null = null;
  private _lock = new AsyncLock();
  private _started = false;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _decoder: TextDecoder | null = null;
  private _lineBuffer = "";
  /** Set to true when _readline detects EOF (stdout closed). */
  private _eofDetected = false;
  /** Dynamic timeout for _readline(), adjusted based on rate limits and tool execution. */
  private _dynamicTimeoutMs = ClaudeProcessManager.READLINE_TIMEOUT_MS;

  constructor(options: {
    model?: string | null;
    allowedTools?: string[];
    addDirs?: string[];
    systemPrompt?: string | null;
    cwd?: string | null;
    resumeSessionId?: string | null;
    permissionMode?: string | null;
  } = {}) {
    this.model = options.model ?? null;
    this.allowedTools = options.allowedTools ?? [];
    this.addDirs = options.addDirs ?? [];
    this.systemPrompt = options.systemPrompt ?? null;
    this.cwd = options.cwd ?? null;
    this.resumeSessionId = options.resumeSessionId ?? null;
    this.permissionMode = options.permissionMode ?? null;
  }

  get isAlive(): boolean {
    return this._process !== null && !this._process.killed && this._process.exitCode === null && !this._eofDetected;
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
      "--add-dir", join(homedir(), ".remi"),
    ];
    if (this.model) {
      cmd.push("--model", this.model);
    }
    if (this.allowedTools.length > 0) {
      cmd.push("--allowedTools", this.allowedTools.join(","));
    } else if (this.permissionMode && this.permissionMode !== "bypassPermissions") {
      cmd.push("--permission-mode", this.permissionMode);
    } else {
      cmd.push("--dangerously-skip-permissions");
    }
    if (this.systemPrompt) {
      cmd.push("--append-system-prompt", this.systemPrompt);
    }
    for (const dir of this.addDirs) {
      cmd.push("--add-dir", dir);
    }
    if (this.resumeSessionId) {
      cmd.push("--resume", this.resumeSessionId);
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

    // Read stdout directly — avoids pipeTo(TextDecoderStream) which can break mid-stream
    this._reader = this._process.stdout.getReader();
    this._decoder = new TextDecoder();
    this._lineBuffer = "";

    // Note: Claude CLI stream-json mode emits the system init message only after
    // the first user message is sent. We don't block here — the system message
    // will be captured in sendAndStream().
    this._started = true;
  }


  async *sendAndStream(
    text: string,
    toolHandler?: ToolHandler | null,
    media?: MediaAttachment[],
    signal?: AbortSignal,
  ): AsyncGenerator<ParsedMessage> {
    await this._lock.acquire();
    try {
      if (!this.isAlive) {
        throw new Error("Process not running — call start() first");
      }

      // Send user message (with optional media for multimodal)
      await this._writeLine(formatUserMessage(text, media));

      // Stream responses, handling tool calls inline
      let pendingTool: ToolUseRequest | null = null;
      let inputChunks: string[] = [];
      // Track built-in tool timing (tools not handled by Remi)
      let builtInToolPending: { toolUseId: string; name: string; t0: number } | null = null;
      // Reset dynamic state for this interaction
      this._dynamicTimeoutMs = ClaudeProcessManager.READLINE_TIMEOUT_MS;
      this._eofDetected = false;
      // Liveness-check retry: allow one extended wait before killing
      let retriedAfterTimeout = false;
      // Content timeout: kill if no actual content arrives for too long
      // (rate_limit events alone should NOT prevent this from firing)
      let lastContentAt = Date.now();
      const CONTENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min without content = stuck

      while (true) {
        const line = await this._readline(this._dynamicTimeoutMs, signal);
        if (line === null) {
          if (this._process && !this._process.killed) {
            // EOF detected — process closed stdout (crash/exit), don't retry
            if (this._eofDetected) {
              // Kill process first so stderr closes, then read it
              const pid = this._process.pid;
              this._process.kill();
              // Wait briefly for process to fully exit
              await new Promise((r) => setTimeout(r, 500));
              const exitCode = this._process.exitCode;
              const stderr = await this._readStderr();
              log.error(`CLI process crashed (EOF, exitCode=${exitCode}, pid=${pid})${stderr ? ` stderr: ${stderr}` : ""}`);
              yield {
                kind: "error",
                error: `CLI process exited unexpectedly (code ${exitCode}).${stderr ? ` ${stderr}` : ""}`,
                code: "process_crash",
              } as import("./protocol.js").ErrorEvent;
              break;
            }

            // True timeout (no EOF) — process still alive but not outputting
            if (!retriedAfterTimeout) {
              retriedAfterTimeout = true;
              const extendMs = 10 * 60 * 1000;
              log.warn(`readline timeout but process alive (pid=${this._process.pid}) — extending ${extendMs / 1000}s`);
              this._dynamicTimeoutMs = extendMs;
              continue;
            }
            log.error("readline returned null while process still alive — killing hung process");
            this._process.kill();
            yield {
              kind: "error",
              error: "CLI process stopped responding (timeout). The task may have exceeded context limits.",
              code: "process_hang",
            } as import("./protocol.js").ErrorEvent;
          }
          break;
        }

        const msg = parseLine(line);

        // Skip unparseable lines (bad JSON, etc.)
        if (msg.kind === "parse_error") {
          // Log more context for API errors (previously truncated at 100 chars)
          const isApiError = msg.rawLine.includes("API Error") || msg.rawLine.includes("invalid_request_error");
          const maxLen = isApiError ? 500 : 100;
          log.warn(`Parse error: ${msg.error} | line: ${msg.rawLine.slice(0, maxLen)}`);
          continue;
        }

        // Debug: log parsed message kind
        if ("kind" in msg) {
          log.debug(`event: ${msg.kind}`);
        } else {
          const rawType = (msg as Record<string, unknown>).type;
          if (rawType) log.debug(`raw: ${rawType}`);
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
            // Built-in tool done — reset timeout to default
            this._dynamicTimeoutMs = ClaudeProcessManager.READLINE_TIMEOUT_MS;
          }
        }

        // Reset content timer on tool_use (model produced real output)
        if (msg.kind === "tool_use") {
          lastContentAt = Date.now();
        }

        // Extend timeout when entering built-in tool execution (Bash, etc. can run long)
        if (msg.kind === "tool_use" && !builtInToolPending) {
          // Will be set to builtInToolPending after toolHandler returns null below;
          // preemptively extend timeout for the upcoming tool execution
          this._dynamicTimeoutMs = 30 * 60 * 1000; // 30 min for built-in tools (Agent can run long)
        }

        // Reset timeout on normal content (model is actively producing output)
        if (msg.kind === "content_delta" || msg.kind === "thinking_delta") {
          this._dynamicTimeoutMs = ClaudeProcessManager.READLINE_TIMEOUT_MS;
          lastContentAt = Date.now();
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
                result: resultText.slice(0, 1500),
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
                log.warn("Failed to parse tool input:", fullJson.slice(0, 200));
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
                  result: resultText.slice(0, 1500),
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
          const sysMsg = msg as SystemMessage;
          this._sessionId = sysMsg.sessionId;
          const mcpInfo = sysMsg.mcpServers
            .map((s) => `${s.name}:${s.status}`)
            .join(", ");
          log.info(`session=${sysMsg.sessionId.slice(0, 12)}... model=${sysMsg.model} mcp=[${mcpInfo}]`);
          yield msg;  // Pass to provider so it can capture model
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

        // Assistant blocks (non-streaming path with multiple content blocks)
        if (msg.kind === "assistant_blocks") {
          for (const block of (msg as AssistantBlocks).blocks) {
            if (block.kind === "thinking_delta" || block.kind === "content_delta") {
              yield block;
            } else if (block.kind === "tool_use") {
              yield block;
              if (toolHandler) {
                const t0 = Date.now();
                const resultText = await toolHandler(block as ToolUseRequest);
                if (resultText !== null) {
                  const elapsed = Date.now() - t0;
                  await this._writeLine(formatToolResult((block as ToolUseRequest).toolUseId, resultText));
                  yield {
                    kind: "tool_result",
                    toolUseId: (block as ToolUseRequest).toolUseId,
                    name: (block as ToolUseRequest).name,
                    result: resultText.slice(0, 1500),
                    durationMs: elapsed,
                  } as ToolResultMessage;
                } else {
                  builtInToolPending = {
                    toolUseId: (block as ToolUseRequest).toolUseId,
                    name: (block as ToolUseRequest).name,
                    t0: Date.now(),
                  };
                }
              }
            }
          }
          continue;
        }

        // Compacting status — CLI is about to compress context, extend timeout
        if (msg.kind === "compacting_status") {
          if ((msg as CompactingStatus).status === "compacting") {
            this._dynamicTimeoutMs = 15 * 60 * 1000; // 15 min for compaction
            retriedAfterTimeout = false; // reset retry so compaction gets a fresh chance
            log.info("Context compaction started — timeout extended to 15min");
          }
          continue;
        }

        // Compact boundary — compaction finished, reset timeout
        if (msg.kind === "compact_boundary") {
          const preTokens = (msg as CompactBoundary).preTokens;
          this._dynamicTimeoutMs = ClaudeProcessManager.READLINE_TIMEOUT_MS;
          log.info(`Context compaction completed (preTokens=${preTokens}) — timeout reset`);
          continue;
        }

        // Tool progress — bash heartbeat, proves process is alive
        if (msg.kind === "tool_progress") {
          this._dynamicTimeoutMs = 30 * 60 * 1000; // keep 30 min for active tool
          continue; // internal signal, don't yield to downstream
        }

        // API retry — extend timeout to cover retry delay
        if (msg.kind === "api_retry") {
          const retry = msg as ApiRetry;
          const extendMs = retry.retryDelayMs + 120_000;
          this._dynamicTimeoutMs = Math.max(extendMs, this._dynamicTimeoutMs);
          log.warn(`API retry ${retry.attempt}/${retry.maxRetries}: ${retry.error} — timeout extended to ${Math.round(this._dynamicTimeoutMs / 1000)}s`);
          continue;
        }

        // Rate limit — yield so downstream can show warning + extend timeout
        if (msg.kind === "rate_limit") {
          const retryMs = (msg as import("./protocol.js").RateLimitEvent).retryAfterMs ?? 0;
          log.warn(`Rate limited: retry after ${retryMs}ms`);
          // Extend readline timeout to accommodate CLI's internal retry wait
          this._dynamicTimeoutMs = Math.max(retryMs + 120_000, this._dynamicTimeoutMs);
          log.info(`Dynamic timeout extended to ${Math.round(this._dynamicTimeoutMs / 1000)}s (rate limit)`);

          // Check content timeout — kill if rate limit loop produces no real content
          const contentAge = Date.now() - lastContentAt;
          if (contentAge > CONTENT_TIMEOUT_MS) {
            log.error(`No content produced for ${Math.round(contentAge / 1000)}s despite rate limit activity — aborting`);
            this._process?.kill();
            yield {
              kind: "error",
              error: "CLI stuck in rate limit loop without producing content. Try again later.",
              code: "rate_limit_stall",
            } as import("./protocol.js").ErrorEvent;
            break;
          }

          yield msg;
          continue;
        }

        // Error event
        if (msg.kind === "error") {
          log.error(`CLI error event: ${msg.error} (${msg.code})`);
          yield msg;
          continue;
        }

        // Other events (content_block_start, etc.) — skip
      }
    } finally {
      this._lock.release();
    }
  }

  async stop(): Promise<void> {
    if (!this._process) return;

    if (this.isAlive) {
      const pid = this._process.pid;
      const descendants = getDescendantPids(pid);
      try {
        this._process.stdin.end();
        const timeout = setTimeout(() => {
          for (const dpid of descendants.reverse()) {
            try { process.kill(dpid, "SIGKILL"); } catch {}
          }
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
      // Kill any remaining descendants (MCP servers, etc.)
      for (const dpid of descendants.reverse()) {
        try { process.kill(dpid, "SIGTERM"); } catch {}
      }
    }

    this._process = null;
    this._started = false;
    this._reader = null;
    this._decoder = null;
  }

  // ── Internal I/O helpers ──────────────────────────────────

  private async _readStderr(): Promise<string> {
    if (!this._process) return "";
    try {
      const result = await Promise.race([
        new Response(this._process.stderr).text(),
        new Promise<string>((r) => setTimeout(() => r(""), 3000)), // 3s timeout
      ]);
      return result.trim().slice(0, 500);
    } catch {
      return "";
    }
  }

  /** Default read timeout: 10 minutes. Long enough for context compression and big tool calls. */
  private static READLINE_TIMEOUT_MS = 10 * 60 * 1000;

  private async _readline(timeoutMs = ClaudeProcessManager.READLINE_TIMEOUT_MS, signal?: AbortSignal): Promise<string | null> {
    if (!this._reader || !this._decoder) return null;

    // Check if process died while we're trying to read
    if (this._process && this._process.killed) {
      log.warn("Process already killed, aborting readline");
      return null;
    }

    // Check if already aborted
    if (signal?.aborted) {
      log.info("readline: signal already aborted");
      return null;
    }

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

        // Read more data with timeout to prevent permanent hangs
        // Also race against abort signal for immediate /esc response
        const races: Promise<any>[] = [
          this._reader.read(),
          new Promise<{ value: undefined; done: true; timedOut: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true, timedOut: true }), timeoutMs),
          ),
        ];
        if (signal && !signal.aborted) {
          races.push(new Promise<{ value: undefined; done: true; aborted: true }>((resolve) =>
            signal.addEventListener("abort", () => resolve({ value: undefined, done: true, aborted: true }), { once: true }),
          ));
        }
        const readResult = await Promise.race(races);

        if ("aborted" in readResult) {
          log.info("readline aborted by signal (/esc)");
          return null;
        }

        if ("timedOut" in readResult) {
          log.error(`readline timed out after ${timeoutMs}ms — process likely hung`);
          return null;
        }

        const { value, done } = readResult;
        if (done) {
          // True EOF — process closed stdout
          this._eofDetected = true;
          const exitCode = this._process?.exitCode;
          log.warn(`readline EOF — stdout closed (exitCode=${exitCode}, pid=${this._process?.pid})`);
          // Flush any remaining partial line in buffer
          if (this._lineBuffer.trim()) {
            const remaining = this._lineBuffer.trim();
            this._lineBuffer = "";
            return remaining;
          }
          return null;
        }

        // Decode Uint8Array chunk and append to line buffer
        // { stream: true } handles multi-byte UTF-8 chars split across chunks
        this._lineBuffer += this._decoder.decode(value, { stream: true });
      }
    } catch (e) {
      log.error("readline error:", e);
      return null;
    }
  }

  /**
   * Send /clear to the subprocess to reset conversation context.
   */
  async clearSession(): Promise<void> {
    if (!this.isAlive) return;
    await this._lock.acquire();
    try {
      await this._writeLine(formatUserMessage("/clear"));
      this._sessionId = null;
      // Drain any response lines until we get a result (the CLI will ack the clear)
      while (true) {
        const line = await this._readline();
        if (line === null) break;
        const msg = parseLine(line);
        if (msg.kind === "result") break;
      }
    } finally {
      this._lock.release();
    }
  }

  /** Send a tool result back to the CLI subprocess (public, for external tool handling). */
  async sendToolResult(toolUseId: string, result: string, isError = false): Promise<void> {
    await this._writeLine(formatToolResult(toolUseId, result, isError));
  }

  private async _writeLine(data: string): Promise<void> {
    if (!this._process || !this._process.stdin) {
      throw new Error("Process stdin not available");
    }
    this._process.stdin.write(data + "\n");
    await this._process.stdin.flush();
  }

}
