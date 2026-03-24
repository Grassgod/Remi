/**
 * Aiden CLI provider — spawn-per-message with NDJSON streaming.
 *
 * Key differences from Claude CLI provider:
 * - No long-running process pool (each message spawns a new process)
 * - Uses --resume for session continuity
 * - No stdin protocol (prompt passed as CLI argument)
 * - No custom tool interception (Aiden handles all tools internally)
 * - No thinking_delta events
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentResponse,
  Provider,
  SendOptions,
  StreamEvent,
} from "../base.js";
import { createAgentResponse } from "../base.js";
import {
  parseAidenLine,
  type AidenContentDelta,
  type AidenDone,
  type AidenMessageUpdate,
  type AidenToolCallEnd,
  type AidenToolCallStart,
  type AidenUsage,
} from "./protocol.js";
import { createLogger } from "../../logger.js";

const log = createLogger("aiden");

export class AidenCLIProvider implements Provider {
  model: string | null;
  timeout: number;
  cwd: string | null;

  /** chatId → Aiden sessionId (for --resume). */
  private _sessions = new Map<string, string>();

  constructor(options: {
    model?: string | null;
    timeout?: number;
    cwd?: string | null;
  } = {}) {
    this.model = options.model ?? null;
    this.timeout = options.timeout ?? 300;
    this.cwd = options.cwd ?? null;
  }

  get name(): string {
    return "aiden_cli";
  }

  // ── Provider protocol ──────────────────────────────────────

  async send(
    message: string,
    options?: SendOptions,
  ): Promise<AgentResponse> {
    let result: AgentResponse | null = null;
    for await (const event of this.sendStream(message, options)) {
      if (event.kind === "result") {
        result = event.response;
      }
    }
    return result ?? createAgentResponse({ text: "[No response from Aiden CLI]" });
  }

  async *sendStream(
    message: string,
    options?: SendOptions,
  ): AsyncGenerator<StreamEvent> {
    const context = options?.context;
    const fullMessage = context ? `<context>\n${context}\n</context>\n\n${message}` : message;

    const cmd = this._buildCommand(fullMessage, options);
    const cwd = options?.cwd ?? this.cwd ?? undefined;
    const timeoutMs = (options?.deadlineMs ?? this.timeout * 1000);
    const deadline = Date.now() + timeoutMs;

    log.info(`Spawning aiden: cwd=${cwd} resume=${this._sessions.get(options?.chatId ?? "") ?? "none"}`);
    log.debug(`Command: ${cmd.join(" ").slice(0, 200)}...`);

    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });

    // Accumulate state across the stream
    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    let lastUsage: AidenUsage = { inputTokens: null, outputTokens: null, contextLength: null };
    let sessionId: string | null = null;
    let gotDone = false;
    let doneStatus = "completed";

    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        // Check deadline
        if (Date.now() > deadline) {
          log.error(`Aiden stream exceeded ${timeoutMs / 1000}s deadline, killing`);
          proc.kill();
          yield { kind: "error", error: `Task timed out (exceeded ${Math.round(timeoutMs / 60_000)} minute limit).` };
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const msg = parseAidenLine(trimmed);

          if (msg.kind === "session") {
            sessionId = msg.sessionId;
            if (options?.chatId && sessionId) {
              this._sessions.set(options.chatId, sessionId);
            }
            log.info(`Aiden session: ${sessionId}`);
            continue;
          }

          if (msg.kind === "content_delta") {
            const delta = msg as AidenContentDelta;
            textParts.push(delta.text);
            yield { kind: "content_delta", text: delta.text };
            continue;
          }

          if (msg.kind === "tool_use") {
            const tu = msg as AidenToolCallStart;
            toolCalls.push({ id: tu.toolUseId, name: tu.name, input: tu.input });
            yield { kind: "tool_use", name: tu.name, toolUseId: tu.toolUseId, input: tu.input };
            continue;
          }

          if (msg.kind === "tool_result") {
            const tr = msg as AidenToolCallEnd;
            yield { kind: "tool_result", toolUseId: tr.toolUseId, name: tr.name, resultPreview: tr.output };
            continue;
          }

          if (msg.kind === "message_update") {
            const mu = msg as AidenMessageUpdate;
            lastUsage = mu.usage;
            // Don't yield — message_update is the final full text, we already streamed deltas
            continue;
          }

          if (msg.kind === "done") {
            gotDone = true;
            doneStatus = (msg as AidenDone).status;
            continue;
          }

          if (msg.kind === "error") {
            yield { kind: "error", error: msg.error };
            continue;
          }

          // skip, parse_error → ignore
        }
      }
    } catch (e) {
      log.error("Aiden stream read error:", e);
      yield { kind: "error", error: `Stream read error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Wait for process to exit
    const exitCode = await proc.exited;
    if (exitCode !== 0 && !gotDone) {
      // Read stderr for diagnostics
      let stderr = "";
      try {
        stderr = await new Response(proc.stderr).text();
      } catch { /* ignore */ }
      log.warn(`Aiden exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // Synthesize result event
    const fullText = textParts.join("") || (doneStatus === "completed" ? "" : `[Aiden ${doneStatus}]`);
    yield {
      kind: "result",
      response: createAgentResponse({
        text: fullText,
        sessionId,
        inputTokens: lastUsage.inputTokens,
        outputTokens: lastUsage.outputTokens,
        contextWindow: lastUsage.contextLength,
        model: this.model,
        toolCalls,
      }),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = Bun.spawnSync(["aiden", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ── Session management ─────────────────────────────────────

  async clearSession(chatId?: string): Promise<void> {
    if (chatId) {
      this._sessions.delete(chatId);
      log.info(`Aiden session cleared for chatId="${chatId}"`);
    } else {
      this._sessions.clear();
      log.info("All Aiden sessions cleared");
    }
  }

  async close(): Promise<void> {
    this._sessions.clear();
  }

  // ── Command building ───────────────────────────────────────

  private _buildCommand(message: string, options?: SendOptions): string[] {
    // System prompt: prepend to message (Aiden has no --append-system-prompt)
    let prompt = message;
    if (options?.systemPrompt) {
      prompt = `<system-instructions>\n${options.systemPrompt}\n</system-instructions>\n\n${message}`;
    }

    const cmd = [
      "aiden",
      prompt,
      "--stream-json",
      "--one-shot",
      "--permission-mode", "agentFull",
      "--add-dir", join(homedir(), ".remi"),
    ];

    // Session resume
    const chatId = options?.chatId ?? "";
    const savedSessionId = options?.sessionId ?? this._sessions.get(chatId);
    if (savedSessionId) {
      cmd.push("--resume", savedSessionId);
    }

    // Model
    if (this.model) {
      cmd.push("--model", this.model);
    }

    // Additional directories
    for (const dir of options?.addDirs ?? []) {
      cmd.push("--add-dir", dir);
    }

    // Allowed tools (Aiden uses space-separated, not comma-separated)
    if (options?.allowedTools && options.allowedTools.length > 0) {
      cmd.push("--allowedTools", ...options.allowedTools);
    }

    return cmd;
  }
}
