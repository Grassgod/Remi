/**
 * Remi orchestrator — the Hub in Hub-and-Spoke architecture.
 *
 * Responsibilities:
 * 1. Receive messages from any connector (IncomingMessage)
 * 2. Lane Queue — serialize per chatId to prevent race conditions
 * 3. Session management — chatId → sessionId mapping
 * 4. Memory injection — assemble context before calling provider
 * 5. Provider routing — select provider + fallback
 * 6. Response dispatch — return AgentResponse via originating connector
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { RemiConfig } from "./config.js";
import type { Connector, IncomingMessage } from "./connectors/base.js";
import { createAgentResponse, type AgentResponse, type Provider, type StreamEvent } from "./providers/base.js";
import { MemoryStore } from "./memory/store.js";
import type { AuthStore } from "./auth/store.js";
import { createLogger } from "./logger.js";

const log = createLogger("core");

/** Simple promise-based mutex for per-lane serialization. */
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

export const SYSTEM_PROMPT = `\
你是 Remi，Jack的个人伙伴, 是我的协作者, 伙伴和监督者, 必要时可以问具有挑战性的问题

## 记忆系统
你拥有持久化记忆。每次对话开始时，相关记忆上下文自动注入在 <context> 标签中，
包含个人记忆、项目记忆、当日日志和可用实体目录。

你有两个记忆工具（通过 MCP 提供，已在工具列表中）：
- **recall** — 当注入的上下文不够时，搜索记忆获取更多信息。
- **remember** — 当用户告知值得长期记住的内容时立即保存（生日、偏好、重要决策）。
  项目级技术知识（架构、技术栈）会在对话结束后由维护 agent 自动整理，无需手动 remember。

<context> 末尾的"可用记忆"表格是摘要目录，使用 recall 可查看完整详情。
`;

/** Max age for persisted sessions — 7 days. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class Remi {
  config: RemiConfig;
  memory: MemoryStore;
  authStore: AuthStore | null = null;
  _providers = new Map<string, Provider>();
  private _connectors: Connector[] = [];
  _sessions = new Map<string, string>(); // sessionKey → sessionId
  _sessionCwd = new Map<string, string>(); // sessionKey → project cwd
  private _laneLocks = new Map<string, AsyncLock>();
  private _onRestart: ((info: { chatId: string; connectorName?: string }) => void) | null = null;
  private _sessDirty = false;
  private _sessFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RemiConfig) {
    this.config = config;
    this.memory = new MemoryStore(config.memoryDir);
    this._loadSessions();
  }

  // ── Provider management ──────────────────────────────────

  addProvider(provider: Provider): void {
    this._providers.set(provider.name, provider);
  }

  _getProvider(name?: string | null): Provider {
    const n = name ?? this.config.provider.name;
    const provider = this._providers.get(n);
    if (!provider) {
      throw new Error(
        `Provider '${n}' not registered. Available: ${[...this._providers.keys()]}`,
      );
    }
    return provider;
  }

  // ── Connector management ─────────────────────────────────

  addConnector(connector: Connector): void {
    this._connectors.push(connector);
  }

  /** Register a callback that fires when /restart is invoked. */
  onRestart(cb: (info: { chatId: string; connectorName?: string }) => void): void {
    this._onRestart = cb;
  }

  // ── Lane Queue (per-chat serialization) ──────────────────

  private _getLaneLock(chatId: string): AsyncLock {
    if (!this._laneLocks.has(chatId)) {
      this._laneLocks.set(chatId, new AsyncLock());
    }
    return this._laneLocks.get(chatId)!;
  }

  // ── Session key resolution (thread-aware) ────────────────

  /**
   * Resolve session key for a message.
   * Thread messages (with rootId) get isolated sessions: `${chatId}:thread:${rootId}`.
   * Main chat messages use plain `chatId`.
   */
  _resolveSessionKey(msg: IncomingMessage): string {
    const rootId = msg.metadata?.rootId as string | undefined;
    if (rootId) {
      return `${msg.chatId}:thread:${rootId}`;
    }
    return msg.chatId;
  }

  // ── Message handling (the core loop) ─────────────────────

  async handleMessage(msg: IncomingMessage): Promise<AgentResponse> {
    const sessionKey = this._resolveSessionKey(msg);
    const lock = this._getLaneLock(sessionKey);
    await lock.acquire();
    try {
      return await this._process(msg);
    } finally {
      lock.release();
    }
  }

  async handleMessageStream(
    msg: IncomingMessage,
    consumer: (stream: AsyncIterable<StreamEvent>) => Promise<void>,
  ): Promise<void> {
    const sessionKey = this._resolveSessionKey(msg);
    const lock = this._getLaneLock(sessionKey);
    await lock.acquire();
    try {
      await consumer(this._processStream(msg));
    } finally {
      lock.release();
    }
  }

  private async *_processStream(msg: IncomingMessage): AsyncGenerator<StreamEvent> {
    // Handle slash commands — emit as immediate result
    const cmdResponse = await this._tryCommand(msg.text, msg);
    if (cmdResponse) {
      yield { kind: "result", response: cmdResponse };
      return;
    }

    // Handle report detail request
    const reportResponse = this._tryReportDetail(msg.text);
    if (reportResponse) {
      yield { kind: "result", response: reportResponse };
      return;
    }

    const sessionKey = this._resolveSessionKey(msg);
    const cwd = this._sessionCwd.get(sessionKey) ?? (msg.metadata?.cwd as string) ?? undefined;
    const context = this.memory.gatherContext(cwd);
    const existingSessionId = this._sessions.get(sessionKey) ?? undefined;
    log.info(`session lookup: key="${sessionKey}" → ${existingSessionId ? `resume="${existingSessionId.slice(0, 12)}..."` : "new session"}`);
    const streamOptions = {
      systemPrompt: SYSTEM_PROMPT,
      context: context || undefined,
      chatId: this._resolveSessionKey(msg),
      sessionId: existingSessionId,
      cwd: cwd ?? undefined,
    };

    const provider = this._getProvider();
    if (typeof provider.sendStream !== "function") {
      throw new Error(`Provider "${provider.name}" does not support streaming`);
    }

    log.debug("starting provider.sendStream iteration");
    let resultResponse: AgentResponse | null = null;
    for await (const event of provider.sendStream(msg.text, streamOptions)) {
      log.debug(`received event: ${event.kind}`);
      yield event;
      if (event.kind === "result") {
        resultResponse = event.response;
      }
    }

    // Fallback: if primary result was an error, try fallback provider
    if (
      resultResponse &&
      (resultResponse.text.startsWith("[Provider error") ||
        resultResponse.text.startsWith("[Provider timeout"))
    ) {
      const fallbackName = this.config.provider.fallback;
      if (fallbackName && this._providers.has(fallbackName)) {
        log.warn(`Primary provider failed, trying fallback: ${fallbackName}`);
        const fallback = this._providers.get(fallbackName)!;
        if (typeof fallback.sendStream === "function") {
          for await (const event of fallback.sendStream(msg.text, streamOptions)) {
            yield event;
            if (event.kind === "result") resultResponse = event.response;
          }
        } else {
          resultResponse = await fallback.send(msg.text, streamOptions);
          yield { kind: "result", response: resultResponse };
        }
      }
    }

    // Update session + daily notes
    if (resultResponse) {
      if (resultResponse.sessionId) {
        this._sessions.set(sessionKey, resultResponse.sessionId);
        log.debug(`session stored: key="${sessionKey}" → "${resultResponse.sessionId.slice(0, 12)}..."`);
        this._scheduleSessFlush();
      }
      this.memory.appendDaily(
        `[${msg.connectorName ?? ""}] ${msg.sender ?? ""}: ${msg.text.slice(0, 100)}`,
      );
    }
  }

  private async _process(msg: IncomingMessage): Promise<AgentResponse> {
    let lastResponse: AgentResponse | null = null;
    for await (const event of this._processStream(msg)) {
      if (event.kind === "result") {
        lastResponse = event.response;
      }
    }
    if (!lastResponse) {
      return createAgentResponse({ text: "[Error: no result from provider]" });
    }
    return lastResponse;
  }

  // ── Slash commands ───────────────────────────────────────

  private static COMMANDS = new Set(["clear", "new", "status", "restart", "p"]);

  private async _tryCommand(text: string, msg: IncomingMessage): Promise<AgentResponse | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();

    if (!Remi.COMMANDS.has(name)) return null; // Unknown command → pass to provider

    const sessionKey = this._resolveSessionKey(msg);
    const isThread = sessionKey !== msg.chatId;

    switch (name) {
      case "clear":
      case "new": {
        this._sessions.delete(sessionKey);
        this._scheduleSessFlush();
        // Also clear the underlying provider's conversation context
        const provider = this._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
        }
        return { text: "上下文已清除，开始新对话。" };
      }
      case "restart": {
        // Delay restart so the response gets sent first
        if (this._onRestart) {
          const info = { chatId: msg.chatId, connectorName: msg.connectorName };
          setTimeout(() => this._onRestart!(info), 500);
        }
        return { text: "正在重启 Remi..." };
      }
      case "p": {
        const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

        if (!arg) {
          // Show current project + list
          const currentCwd = this._sessionCwd.get(sessionKey);
          const projects = this.config.projects;
          const aliases = Object.keys(projects);
          const lines = [`📍 当前: ${currentCwd ?? "~ (默认)"}`];
          if (aliases.length > 0) {
            lines.push("", "可用项目:");
            for (const [alias, path] of Object.entries(projects)) {
              const marker = currentCwd === path ? " ◀" : "";
              lines.push(`  ${alias}  →  ${path}${marker}`);
            }
          } else {
            lines.push("", "暂无注册项目，请在 Dashboard → Projects 中添加。");
          }
          return { text: lines.join("\n") };
        }

        if (arg === "reset") {
          this._sessionCwd.delete(sessionKey);
          this._sessions.delete(sessionKey);
          this._scheduleSessFlush();
          const provider = this._getProvider();
          if ("clearSession" in provider && typeof provider.clearSession === "function") {
            await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
          }
          return { text: "已清除项目绑定，下条消息将在默认目录启动。" };
        }

        // Resolve alias or direct path
        let targetPath: string;
        if (this.config.projects[arg]) {
          targetPath = this.config.projects[arg];
        } else {
          // Treat as direct path, expand ~
          targetPath = arg.startsWith("~") ? arg.replace("~", homedir()) : resolve(arg);
        }

        if (!existsSync(targetPath)) {
          return { text: `路径不存在: ${targetPath}` };
        }

        // Kill old process, bind new cwd
        this._sessionCwd.set(sessionKey, targetPath);
        this._sessions.delete(sessionKey);
        this._scheduleSessFlush();
        const provider = this._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (chatId?: string) => Promise<void> }).clearSession(sessionKey);
        }

        // Find alias name for display
        const aliasName = Object.entries(this.config.projects).find(([, p]) => p === targetPath)?.[0];
        return { text: `项目已切换: ${aliasName ? `${aliasName} (${targetPath})` : targetPath}\n下条消息将在新目录启动 Claude。` };
      }
      case "status": {
        const hasSession = this._sessions.has(sessionKey);
        const sessionId = this._sessions.get(sessionKey);
        const providers = [...this._providers.keys()].join(", ");
        const connectors = this._connectors.map((c) => c.name).join(", ");
        const currentCwd = this._sessionCwd.get(sessionKey);
        const lines = [
          `**Remi Status**`,
          `- Session: ${hasSession ? sessionId?.slice(0, 12) + "..." : "无"}`,
          isThread ? `- Context: Thread (isolated)` : `- Context: Main chat`,
          currentCwd ? `- Project: ${currentCwd}` : `- Project: ~ (默认)`,
          `- Providers: ${providers}`,
          `- Connectors: ${connectors}`,
        ];
        if (this.authStore) {
          for (const s of this.authStore.status()) {
            const ttl = Math.round((s.expiresAt - Date.now()) / 1000 / 60);
            lines.push(
              `- Token ${s.service}/${s.type}: ${s.valid ? `valid (${ttl}min)` : "expired"}`,
            );
          }
        }
        return { text: lines.join("\n") };
      }
      default:
        return null;
    }
  }

  // ── Report detail on demand ─────────────────────────────

  private _tryReportDetail(text: string): AgentResponse | null {
    const trimmed = text.trim();
    if (!trimmed.includes("详细报告") && !trimmed.includes("完整报告")) return null;

    const today = new Date().toISOString().slice(0, 10);

    for (const skill of this.config.scheduledSkills) {
      if (!skill.enabled) continue;
      const reportPath = join(skill.outputDir, `${today}.md`);
      if (existsSync(reportPath)) {
        return { text: readFileSync(reportPath, "utf-8").trim() };
      }
    }

    return { text: `今天（${today}）还没有生成报告，请稍后再试。` };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._providers.size === 0) {
      throw new Error("No providers registered. Call addProvider() first.");
    }

    const tasks = this._connectors.map((c) =>
      c.start(this.handleMessage.bind(this), this.handleMessageStream.bind(this)),
    );
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  async stop(): Promise<void> {
    this.flushSessions();

    for (const connector of this._connectors) {
      await connector.stop();
    }

    for (const provider of this._providers.values()) {
      const closeable = provider as Provider & { close?: () => Promise<void> };
      if (typeof closeable.close === "function") {
        await closeable.close();
      }
    }
  }

  // ── Session persistence ───────────────────────────────────

  /** Load sessions from disk. Discard if older than TTL. */
  private _loadSessions(): void {
    try {
      if (!existsSync(this.config.sessionsFile)) return;
      const raw = readFileSync(this.config.sessionsFile, "utf-8");
      const data = JSON.parse(raw) as { entries?: [string, string][]; cwdMap?: [string, string][]; savedAt?: number };
      if (!data.entries || !Array.isArray(data.entries)) return;
      if (data.savedAt && Date.now() - data.savedAt > SESSION_TTL_MS) {
        log.info("Persisted sessions expired (>7d), discarding");
        return;
      }
      for (const [key, id] of data.entries) {
        this._sessions.set(key, id);
      }
      if (Array.isArray(data.cwdMap)) {
        for (const [key, cwd] of data.cwdMap) {
          this._sessionCwd.set(key, cwd);
        }
      }
      log.info(`Loaded ${data.entries.length} persisted session(s), ${this._sessionCwd.size} cwd mapping(s)`);
    } catch (e) {
      log.warn("Failed to load sessions file:", e);
    }
  }

  /** Schedule a debounced flush (2 s). */
  private _scheduleSessFlush(): void {
    this._sessDirty = true;
    if (this._sessFlushTimer) return;
    this._sessFlushTimer = setTimeout(() => {
      this._sessFlushTimer = null;
      this._flushSessionsSync();
    }, 2000);
    if (typeof this._sessFlushTimer.unref === "function") {
      this._sessFlushTimer.unref();
    }
  }

  /** Synchronously write sessions to disk. */
  private _flushSessionsSync(): void {
    if (!this._sessDirty) return;
    this._sessDirty = false;
    try {
      const dir = dirname(this.config.sessionsFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = {
        entries: [...this._sessions.entries()],
        cwdMap: [...this._sessionCwd.entries()],
        savedAt: Date.now(),
      };
      writeFileSync(this.config.sessionsFile, JSON.stringify(data), "utf-8");
      log.debug(`Flushed ${data.entries.length} session(s) to disk`);
    } catch (e) {
      log.warn("Failed to write sessions file:", e);
    }
  }

  /** Flush sessions to disk immediately. Called by stop(). */
  flushSessions(): void {
    if (this._sessFlushTimer) {
      clearTimeout(this._sessFlushTimer);
      this._sessFlushTimer = null;
    }
    this._sessDirty = true;
    this._flushSessionsSync();
  }
}
