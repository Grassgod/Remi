/**
 * ACP JSON-RPC 2.0 client.
 * Spawns the ACP agent process and handles bidirectional communication over stdio.
 */

import { createLogger } from "../../logger.js";

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  PromptParams,
  PromptResult,
  SessionNotification,
  RequestPermissionParams,
  RequestPermissionResult,
  PermissionOutcome,
  SetSessionModeParams,
  CancelParams,
  ResumeSessionParams,
  LoadSessionParams,
  CloseSessionParams,
  McpServerConfig,
} from "./protocol.js";

export interface AcpClientOptions {
  /** Path to ACP agent executable (default: searches for claude-agent-acp binary). */
  executable?: string;
  /** Launch args for the executable (e.g. ["--experimental-acp"] for gemini). */
  args?: string[];
  /** Working directory for the agent process. */
  cwd?: string;
  /** Additional MCP servers to configure. */
  mcpServers?: McpServerConfig[];
  /** Claude Code SDK options to pass through (legacy; prefer sessionMeta). */
  claudeCodeOptions?: Record<string, unknown>;
  /** Full session meta — passed as _meta to session/new. Takes precedence over claudeCodeOptions. */
  sessionMeta?: import("./protocol.js").NewSessionMeta;
  /** Environment variables for the agent process. */
  env?: Record<string, string>;
  /** Handler for permission requests from the agent. */
  onPermissionRequest?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;
  /** Handler for session update notifications. */
  onSessionUpdate?: (notification: SessionNotification) => void;
  /** Logger. */
  log?: (...args: unknown[]) => void;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

const slog = createLogger("acp-client");

export class AcpClient {
  private _process: ReturnType<typeof Bun.spawn> | null = null;
  private _nextId = 1;
  private _pending = new Map<number | string, PendingRequest>();
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _decoder = new TextDecoder();
  private _buffer = "";
  private _initialized = false;
  private _readLoopRunning = false;
  private _options: AcpClientOptions;
  private _serverSessionId: string | null = null;

  constructor(options: AcpClientOptions = {}) {
    this._options = options;
  }

  get sessionId(): string | null {
    return this._serverSessionId;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  private _log(...args: unknown[]) {
    this._options.log?.("[AcpClient]", ...args);
  }

  // ── Process lifecycle ──────────────────────────────────────────

  async start(): Promise<void> {
    if (this._process) return;

    const executable = this._options.executable ?? (await resolveAcpExecutable());
    const args = this._options.args ?? [];
    const cwd = this._options.cwd ?? process.cwd();

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (this._options.env) Object.assign(env, this._options.env);

    this._log("spawning", executable, args.join(" "), "cwd:", cwd);

    this._process = Bun.spawn([executable, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env,
    });

    this._reader = (this._process.stdout as ReadableStream<Uint8Array>).getReader();
    this._startReadLoop();
    this._startStderrDrain();
  }

  async stop(): Promise<void> {
    if (!this._process) return;
    this._readLoopRunning = false;

    try { (this._process.stdin as any).end(); } catch {}
    this._process.kill();
    this._process = null;
    this._reader = null;
    this._initialized = false;
    this._serverSessionId = null;

    for (const [, pending] of this._pending) {
      pending.reject(new Error("ACP client stopped"));
    }
    this._pending.clear();
  }

  get alive(): boolean {
    return this._process != null && !this._process.killed;
  }

  // ── JSON-RPC transport ─────────────────────────────────────────

  private _send(msg: JsonRpcMessage): void {
    if (!this._process || this._process.killed) {
      throw new Error("ACP process not running");
    }
    const line = JSON.stringify(msg) + "\n";
    (this._process.stdin as any).write(line);
  }

  private async _request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this._nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this._send(msg);
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  private _notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this._send(msg);
  }

  private _respond(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this._send(msg);
  }

  // ── Read loop ──────────────────────────────────────────────────

  private _startReadLoop(): void {
    if (this._readLoopRunning) return;
    this._readLoopRunning = true;

    (async () => {
      while (this._readLoopRunning && this._reader) {
        try {
          const { done, value } = await this._reader.read();
          if (done) {
            this._log("stdout EOF");
            this._readLoopRunning = false;
            break;
          }
          this._buffer += this._decoder.decode(value, { stream: true });
          this._processBuffer();
        } catch (err) {
          if (this._readLoopRunning) {
            this._log("read error:", err);
          }
          break;
        }
      }
    })();
  }

  private _startStderrDrain(): void {
    if (!this._process) return;
    (async () => {
      const reader = (this._process!.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text.trim()) this._log("stderr:", text.trim());
        }
      } catch {}
    })();
  }

  private _processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, newlineIdx).trim();
      this._buffer = this._buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (err: any) {
        this._log("JSON parse error:", err.message, "line:", line.slice(0, 100));
        continue;
      }
      try {
        this._handleMessage(parsed as JsonRpcMessage);
      } catch (err: any) {
        this._log("handle error:", err.message, "method:", parsed?.method);
      }
    }
  }

  private _handleMessage(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id != null) {
      if ("method" in msg && msg.method) {
        this._handleServerRequest(msg as JsonRpcRequest);
      } else {
        this._handleResponse(msg as JsonRpcResponse);
      }
    } else if ("method" in msg) {
      this._handleNotification(msg as JsonRpcNotification);
    }
  }

  private _handleResponse(msg: JsonRpcResponse): void {
    const pending = this._pending.get(msg.id);
    if (!pending) {
      this._log("orphan response id:", msg.id);
      return;
    }
    this._pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private _handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === "session/update") {
      const notification = msg.params as unknown as SessionNotification;
      this._options.onSessionUpdate?.(notification);
    }
  }

  private async _handleServerRequest(msg: JsonRpcRequest): Promise<void> {
    if (msg.method === "session/request_permission") {
      const params = msg.params as unknown as RequestPermissionParams;
      const toolName = params.toolCall?.toolName ?? params.toolCall?.title ?? "unknown";
      slog.info(`session/request_permission received: tool=${toolName} sessionId=${params.sessionId} id=${msg.id}`);
      const handler = this._options.onPermissionRequest;
      if (handler) {
        try {
          const outcome = await handler(params);
          slog.info(`session/request_permission resolved: tool=${toolName} outcome=${outcome.outcome}`);
          this._respond(msg.id, { outcome });
        } catch (err) {
          slog.info(`session/request_permission error: tool=${toolName} err=${err}`);
          this._respond(msg.id, { outcome: { outcome: "cancelled" } });
        }
      } else {
        slog.info(`session/request_permission no handler: tool=${toolName}`);
        this._respond(msg.id, { outcome: { outcome: "cancelled" } });
      }
      return;
    }

    if (msg.method === "fs/readTextFile" || msg.method === "fs/writeTextFile") {
      // Delegate file operations to local filesystem
      await this._handleFsRequest(msg);
      return;
    }

    this._log("unhandled server request:", msg.method);
    this._send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }

  private async _handleFsRequest(msg: JsonRpcRequest): Promise<void> {
    const { readFileSync, writeFileSync } = await import("node:fs");
    try {
      if (msg.method === "fs/readTextFile") {
        const { path } = msg.params as { path: string };
        const content = readFileSync(path, "utf-8");
        this._respond(msg.id, { content });
      } else if (msg.method === "fs/writeTextFile") {
        const { path, content } = msg.params as { path: string; content: string };
        writeFileSync(path, content, "utf-8");
        this._respond(msg.id, {});
      }
    } catch (err: any) {
      this._send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err.message },
      });
    }
  }

  // ── ACP protocol methods ───────────────────────────────────────

  async initialize(): Promise<InitializeResult> {
    const params = {
      protocolVersion: 1,
      clientInfo: { name: "remi", version: "0.1.0" },
      clientCapabilities: {
        _meta: { terminal_output: true },
        fs: { readTextFile: true, writeTextFile: true },
      },
    };

    const result = await this._request<InitializeResult>("initialize", params as unknown as Record<string, unknown>);
    this._initialized = true;
    return result;
  }

  async newSession(params?: Partial<NewSessionParams>): Promise<NewSessionResult> {
    const meta = params?._meta
      ?? this._options.sessionMeta
      ?? (this._options.claudeCodeOptions ? { claudeCode: { options: this._options.claudeCodeOptions } } : undefined);
    const fullParams: NewSessionParams = {
      cwd: params?.cwd ?? this._options.cwd ?? process.cwd(),
      mcpServers: params?.mcpServers ?? this._options.mcpServers ?? [],
      _meta: meta,
    };

    const result = await this._request<NewSessionResult>(
      "session/new",
      fullParams as unknown as Record<string, unknown>,
    );
    this._serverSessionId = result.sessionId;
    return result;
  }

  async prompt(sessionId: string, text: string, media?: Array<{ type: string; data: string; mimeType: string }>): Promise<PromptResult> {
    const prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [{ type: "text", text }];
    if (media) {
      for (const m of media) {
        prompt.push({ type: "image", data: m.data, mimeType: m.mimeType });
      }
    }

    const params = { sessionId, prompt };
    return this._request<PromptResult>("session/prompt", params as unknown as Record<string, unknown>);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const params: SetSessionModeParams = { sessionId, modeId };
    await this._request("session/set_mode", params as unknown as Record<string, unknown>);
  }

  async cancel(sessionId: string): Promise<void> {
    const params: CancelParams = { sessionId };
    this._notify("session/cancel", params as unknown as Record<string, unknown>);
  }

  async resumeSession(sessionId: string, cwd?: string, mcpServers?: McpServerConfig[]): Promise<NewSessionResult> {
    const params: ResumeSessionParams = { sessionId, cwd: cwd ?? this._options.cwd, mcpServers };
    const result = await this._request<NewSessionResult>(
      "session/resume",
      params as unknown as Record<string, unknown>,
    );
    this._serverSessionId = result.sessionId ?? sessionId;
    return { ...result, sessionId: result.sessionId ?? sessionId };
  }

  async loadSession(sessionId: string, cwd?: string): Promise<NewSessionResult> {
    const params: LoadSessionParams = { sessionId, cwd: cwd ?? this._options.cwd };
    const result = await this._request<NewSessionResult>(
      "session/load",
      params as unknown as Record<string, unknown>,
    );
    this._serverSessionId = result.sessionId ?? sessionId;
    return { ...result, sessionId: result.sessionId ?? sessionId };
  }

  async closeSession(sessionId: string): Promise<void> {
    const params: CloseSessionParams = { sessionId };
    await this._request("session/close", params as unknown as Record<string, unknown>);
    if (this._serverSessionId === sessionId) this._serverSessionId = null;
  }
}

// ── Resolve ACP executable ───────────────────────────────────────

async function resolveAcpExecutable(): Promise<string> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  // Check common locations for the ACP binary
  const candidates = [
    // npm global install
    join(homedir(), ".npm-global", "bin", "claude-agent-acp"),
    // npx-installed via @agentclientprotocol/claude-agent-acp
    join(homedir(), ".npm-global", "lib", "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Fallback: assume it's in PATH
  return "claude-agent-acp";
}
