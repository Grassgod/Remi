/**
 * ACP JSON-RPC 2.0 client.
 * Spawns the ACP agent process and handles bidirectional communication over stdio.
 */

const _log = { info: (...a: unknown[]) => console.log("[acp-client]", ...a), warn: (...a: unknown[]) => console.warn("[acp-client]", ...a), error: (...a: unknown[]) => console.error("[acp-client]", ...a), debug: () => {} };
function createLogger(_: string) { return _log; }

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
  ElicitationCreateParams,
  ElicitationResult,
  SetSessionModeParams,
  SetSessionConfigOptionParams,
  SetSessionConfigOptionResult,
  CancelParams,
  CancelRequestParams,
  ResumeSessionParams,
  LoadSessionParams,
  CloseSessionParams,
  McpServerConfig,
  PromptContent,
} from "./protocol.js";

export interface AcpClientOptions {
  /** Path to ACP agent executable (default: searches for claude-agent-acp binary). */
  executable?: string;
  /** Agent flavor ("claude" | "codex"); gates claude-only client capabilities. */
  agentType?: string;
  /** Working directory for the agent process. */
  cwd?: string;
  /** Additional MCP servers to configure. */
  mcpServers?: McpServerConfig[];
  /** Environment variables for the agent process. */
  env?: Record<string, string>;
  /** Handler for permission requests from the agent. */
  onPermissionRequest?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;
  /** Handler for form elicitation requests (e.g. AskUserQuestion) from the agent. */
  onElicitationRequest?: (params: ElicitationCreateParams) => Promise<ElicitationResult>;
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
  private _initializeResult: InitializeResult | null = null;
  /**
   * Inbound requests we are serving and haven't answered yet, keyed by the
   * agent's request id. The value settles the request as cancelled; the agent
   * abandons `session/request_permission` / `elicitation/create` by sending
   * `$/cancel_request` (claude-agent-acp dist/acp-agent.js:552-567 wires a
   * `cancellationSignal` into both), and without this the dialog would stay
   * pending forever.
   */
  private _inflightServerRequests = new Map<number | string, () => void>();

  constructor(options: AcpClientOptions = {}) {
    this._options = options;
  }

  get sessionId(): string | null {
    return this._serverSessionId;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /** The agent's `initialize` response (protocol version + advertised capabilities). */
  get initializeResult(): InitializeResult | null {
    return this._initializeResult;
  }

  private _log(...args: unknown[]) {
    this._options.log?.("[AcpClient]", ...args);
  }

  // ── Process lifecycle ──────────────────────────────────────────

  async start(): Promise<void> {
    if (this._process) return;

    const executable = this._options.executable ?? (await resolveAcpExecutable());
    const cwd = this._options.cwd ?? process.cwd();

    const env: Record<string, string> = { ...process.env as Record<string, string> };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (this._options.env) Object.assign(env, this._options.env);

    this._log("spawning", executable, "cwd:", cwd);

    this._process = Bun.spawn([executable], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env,
    });

    const proc = this._process;
    proc.exited.then(
      (code) => {
        if (this._process === proc) this._handleUnexpectedDeath(`exit code ${code}`);
      },
      () => {},
    );

    this._reader = (this._process.stdout as ReadableStream<Uint8Array>).getReader();
    this._startReadLoop();
    this._startStderrDrain();
  }

  /**
   * The agent process died without stop() being called. Tear down transport
   * state and reject all in-flight requests so callers fail fast instead of
   * hanging forever (which would also keep the per-chat AsyncLock held).
   */
  private _handleUnexpectedDeath(reason: string): void {
    if (!this._process) return; // graceful stop() already cleaned up
    this._log("agent died:", reason);
    slog.warn(`ACP agent died unexpectedly (${reason}); rejecting ${this._pending.size} in-flight request(s)`);

    try { this._process.kill(); } catch {}
    this._process = null;
    this._reader = null;
    this._readLoopRunning = false;
    this._initialized = false;
    this._serverSessionId = null;
    this._initializeResult = null;
    this._inflightServerRequests.clear();

    const err = new Error(`ACP agent died unexpectedly (${reason})`);
    for (const [, pending] of this._pending) {
      pending.reject(err);
    }
    this._pending.clear();
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
    this._initializeResult = null;
    this._inflightServerRequests.clear();

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

  private async _request<T>(method: string, params?: unknown): Promise<T> {
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

  private _notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this._send(msg);
  }

  private _respond(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this._send(msg);
  }

  /**
   * Answer an inbound request exactly once. Returns false when the request was
   * already settled (e.g. cancelled by the agent while our handler was still
   * waiting on a human), so the late answer is dropped instead of writing a
   * duplicate response the agent would discard.
   */
  private _settleServerRequest(id: number | string, result: unknown): boolean {
    if (!this._inflightServerRequests.delete(id)) return false;
    this._respond(id, result);
    return true;
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
            this._handleUnexpectedDeath("stdout EOF");
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
      const notification = msg.params as SessionNotification;
      this._options.onSessionUpdate?.(notification);
      return;
    }

    if (msg.method === "$/cancel_request") {
      const { requestId } = (msg.params ?? {}) as Partial<CancelRequestParams>;
      if (requestId == null) return;
      const cancel = this._inflightServerRequests.get(requestId);
      if (!cancel) return;
      slog.info(`$/cancel_request received: id=${requestId}`);
      cancel();
    }
  }

  private async _handleServerRequest(msg: JsonRpcRequest): Promise<void> {
    if (msg.method === "session/request_permission") {
      const params = msg.params as RequestPermissionParams;
      const toolName = params.toolCall?._meta?.claudeCode?.toolName ?? params.toolCall?.title ?? "unknown";
      slog.info(`session/request_permission received: tool=${toolName} sessionId=${params.sessionId} id=${msg.id}`);
      // The agent may abandon the dialog mid-flight; a `cancelled` outcome is
      // exactly what it expects then (claude-agent-acp dist/acp-agent.js:3641-3647).
      this._inflightServerRequests.set(msg.id, () =>
        this._settleServerRequest(msg.id, { outcome: { outcome: "cancelled" } }),
      );
      const handler = this._options.onPermissionRequest;
      if (handler) {
        try {
          const outcome = await handler(params);
          slog.info(`session/request_permission resolved: tool=${toolName} outcome=${outcome.outcome}`);
          this._settleServerRequest(msg.id, { outcome });
        } catch (err) {
          slog.info(`session/request_permission error: tool=${toolName} err=${err}`);
          this._settleServerRequest(msg.id, { outcome: { outcome: "cancelled" } });
        }
      } else {
        slog.info(`session/request_permission no handler: tool=${toolName}`);
        this._settleServerRequest(msg.id, { outcome: { outcome: "cancelled" } });
      }
      return;
    }

    if (msg.method === "elicitation/create") {
      const params = msg.params as ElicitationCreateParams;
      slog.info(`elicitation/create received: mode=${params.mode} sessionId=${params.sessionId} id=${msg.id}`);
      this._inflightServerRequests.set(msg.id, () => this._settleServerRequest(msg.id, { action: "cancel" }));
      const handler = this._options.onElicitationRequest;
      if (handler) {
        try {
          const result = await handler(params);
          slog.info(`elicitation/create resolved: action=${result.action}`);
          this._settleServerRequest(msg.id, result);
        } catch (err) {
          slog.info(`elicitation/create error: ${err}`);
          this._settleServerRequest(msg.id, { action: "cancel" });
        }
      } else {
        slog.info("elicitation/create no handler");
        this._settleServerRequest(msg.id, { action: "cancel" });
      }
      return;
    }

    // ACP file-system method names are snake_case (sdk CLIENT_METHODS:
    // `fs/read_text_file` / `fs/write_text_file`, dist/schema/index.js:35-36).
    // No bridge ever sends the camelCase spelling.
    if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
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
      if (msg.method === "fs/read_text_file") {
        // `line` is 1-based and `limit` caps the returned line count
        // (sdk schema.json ReadTextFileRequest); both are optional.
        const { path, line, limit } = msg.params as { path: string; line?: number | null; limit?: number | null };
        let content = readFileSync(path, "utf-8");
        if (line != null || limit != null) {
          const start = line != null && line > 0 ? line - 1 : 0;
          const lines = content.split("\n");
          content = lines.slice(start, limit != null ? start + limit : undefined).join("\n");
        }
        this._respond(msg.id, { content });
      } else if (msg.method === "fs/write_text_file") {
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
    const params: InitializeParams = {
      protocolVersion: 1,
      clientInfo: { name: "remi", version: "0.1.0" },
      clientCapabilities: {
        // `subagent-transcript` opts into subagent prose: claude-agent-acp >= 0.66
        // strips a subagent's text/thinking chunks unless the client declares it
        // (the bridge checks `capabilities?._meta?.["subagent-transcript"] === true`).
        // codex-acp reads exactly one client `_meta` key — `terminal_output`
        // (dist/index.js:22754-22760) — so the claude-only key is left out there.
        _meta: {
          terminal_output: true,
          ...(this._options.agentType === "codex" ? {} : { "subagent-transcript": true }),
        },
        fs: { readTextFile: true, writeTextFile: true },
        // Form-elicitation support: the agent keeps AskUserQuestion enabled and
        // sends it to us as `elicitation/create` instead of disabling the tool.
        // NOTE: `form` must be an object — the agent's zod schema silently
        // drops a boolean here.
        elicitation: { form: {} },
      },
    };

    const result = await this._request<InitializeResult>("initialize", params);
    this._initialized = true;
    this._initializeResult = result;
    return result;
  }

  async newSession(params?: Partial<NewSessionParams>): Promise<NewSessionResult> {
    const meta = params?._meta;
    const fullParams: NewSessionParams = {
      cwd: params?.cwd ?? this._options.cwd ?? process.cwd(),
      mcpServers: params?.mcpServers ?? this._options.mcpServers ?? [],
      ...(params?.additionalDirectories?.length ? { additionalDirectories: params.additionalDirectories } : {}),
      _meta: meta,
    };

    const result = await this._request<NewSessionResult>("session/new", fullParams);
    this._serverSessionId = result.sessionId;
    return result;
  }

  async prompt(sessionId: string, text: string, media?: Array<{ type: string; data: string; mimeType: string }>): Promise<PromptResult> {
    const prompt: PromptContent[] = [{ type: "text", text }];
    if (media) {
      for (const m of media) {
        prompt.push({ type: "image", data: m.data, mimeType: m.mimeType });
      }
    }

    const params: PromptParams = { sessionId, prompt };
    return this._request<PromptResult>("session/prompt", params);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const params: SetSessionModeParams = { sessionId, modeId };
    await this._request("session/set_mode", params);
  }

  /**
   * Change one of the agent's advertised config options (model, effort, …).
   * The agent returns its refreshed option list, which callers should keep:
   * changing the model rewrites the effort option's valid values on both
   * bridges (claude-agent-acp dist/acp-agent.js:4084-4100, codex-acp
   * dist/index.js:29369-29374).
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<SetSessionConfigOptionResult> {
    const params: SetSessionConfigOptionParams = { sessionId, configId, value };
    return this._request<SetSessionConfigOptionResult>("session/set_config_option", params);
  }

  async cancel(sessionId: string): Promise<void> {
    const params: CancelParams = { sessionId };
    this._notify("session/cancel", params);
  }

  async resumeSession(
    sessionId: string,
    cwd?: string,
    mcpServers?: McpServerConfig[],
    extra?: Pick<ResumeSessionParams, "additionalDirectories" | "_meta">,
  ): Promise<NewSessionResult> {
    const params: ResumeSessionParams = {
      sessionId,
      cwd: cwd ?? this._options.cwd,
      mcpServers,
      ...(extra?.additionalDirectories?.length ? { additionalDirectories: extra.additionalDirectories } : {}),
      _meta: extra?._meta,
    };
    const result = await this._request<NewSessionResult>("session/resume", params);
    this._serverSessionId = result.sessionId ?? sessionId;
    return { ...result, sessionId: result.sessionId ?? sessionId };
  }

  /**
   * `cwd` and `mcpServers` are required by the schema — callers must supply
   * both or the agent rejects the load with -32602 (see {@link LoadSessionParams}).
   */
  async loadSession(sessionId: string, cwd: string, mcpServers: McpServerConfig[]): Promise<NewSessionResult> {
    const params: LoadSessionParams = { sessionId, cwd, mcpServers };
    const result = await this._request<NewSessionResult>("session/load", params);
    this._serverSessionId = result.sessionId ?? sessionId;
    return { ...result, sessionId: result.sessionId ?? sessionId };
  }

  async closeSession(sessionId: string): Promise<void> {
    const params: CloseSessionParams = { sessionId };
    await this._request("session/close", params);
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
