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

import type { RemiConfig } from "./config.js";
import type { Connector, IncomingMessage } from "./connectors/base.js";
import type { AgentResponse, Provider } from "./providers/base.js";
import { MemoryStore } from "./memory/store.js";

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
你是 Remi，Jack 的个人 AI 助手。

## 记忆系统
你拥有持久化记忆。每次对话开始时，相关记忆上下文自动注入在 <context> 标签中，
包含个人记忆、项目记忆、当日日志和可用实体目录。

你有两个记忆工具：
- recall(query, cwd?) — 搜索所有记忆（实体、历史日志、项目记忆）。
  当注入的上下文不够时使用。精确匹配实体名或别名返回全文，否则返回摘要列表。
- remember(entity, type, observation, scope?, cwd?) — 即时保存关于实体的重要信息。
  当用户告知值得长期记住的内容时使用（生日、偏好、重要决策）。
  scope="project" 时写入当前项目的实体目录，默认写入个人实体目录。
  注意：项目级技术知识（架构、技术栈）会在对话结束后由维护 agent 自动整理。

<context> 末尾的"可用记忆"表格是摘要目录，使用 recall(名称) 可查看完整详情。
`;

export class Remi {
  config: RemiConfig;
  memory: MemoryStore;
  _providers = new Map<string, Provider>();
  private _connectors: Connector[] = [];
  _sessions = new Map<string, string>(); // sessionKey → sessionId
  private _laneLocks = new Map<string, AsyncLock>();
  private _onRestart: ((info: { chatId: string; connectorName?: string }) => void) | null = null;
  /** Current message being processed — available to tool handlers. */
  private _currentMsg: IncomingMessage | null = null;
  /** Pending restart request set by triggerRestart(), executed after response. */
  private _pendingRestart: { chatId: string; connectorName?: string } | null = null;

  constructor(config: RemiConfig) {
    this.config = config;
    this.memory = new MemoryStore(config.memoryDir);
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

  /**
   * Trigger a restart — callable from tools (natural language) or slash commands.
   * Queues the restart to execute after the current response is sent.
   */
  triggerRestart(reason?: string): string {
    if (!this._onRestart) {
      return "重启功能未配置（仅 daemon 模式支持重启）。";
    }
    const msg = this._currentMsg;
    if (!msg) {
      return "无法确定当前消息上下文，重启取消。";
    }
    this._pendingRestart = { chatId: msg.chatId, connectorName: msg.connectorName };
    const reasonStr = reason ? `（原因：${reason}）` : "";
    return `重启已排队，将在回复发送后执行${reasonStr}。`;
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
    const lock = this._getLaneLock(msg.chatId);
    await lock.acquire();
    try {
      this._currentMsg = msg;
      const response = await this._process(msg);

      // Execute pending restart (queued by restart_remi tool) after response is ready
      if (this._pendingRestart && this._onRestart) {
        const info = this._pendingRestart;
        this._pendingRestart = null;
        setTimeout(() => this._onRestart!(info), 500);
      }

      return response;
    } finally {
      this._currentMsg = null;
      lock.release();
    }
  }

  private async _process(msg: IncomingMessage): Promise<AgentResponse> {
    // 0. Handle slash commands (thread-aware)
    const cmdResponse = this._tryCommand(msg.text, msg);
    if (cmdResponse) return cmdResponse;

    // 1. Resolve session key (threads get isolated sessions)
    const sessionKey = this._resolveSessionKey(msg);

    // 2. Assemble memory context
    const cwd = (msg.metadata?.cwd as string) ?? undefined;
    const context = this.memory.gatherContext(cwd);

    // 3. Get session for multi-turn
    const sessionId = this._sessions.get(sessionKey) ?? undefined;

    // 4. Route to provider
    const provider = this._getProvider();
    let response = await provider.send(msg.text, {
      systemPrompt: SYSTEM_PROMPT,
      context: context || undefined,
      sessionId,
    });

    // 5. Fallback if primary fails
    if (
      response.text.startsWith("[Provider error") ||
      response.text.startsWith("[Provider timeout")
    ) {
      const fallbackName = this.config.provider.fallback;
      if (fallbackName && this._providers.has(fallbackName)) {
        console.warn(`Primary provider failed, trying fallback: ${fallbackName}`);
        const fallback = this._providers.get(fallbackName)!;
        response = await fallback.send(msg.text, {
          systemPrompt: SYSTEM_PROMPT,
          context: context || undefined,
        });
      }
    }

    // 6. Update session mapping
    if (response.sessionId) {
      this._sessions.set(sessionKey, response.sessionId);
    }

    // 7. Append to daily notes
    this.memory.appendDaily(
      `[${msg.connectorName ?? ""}] ${msg.sender ?? ""}: ${msg.text.slice(0, 100)}`,
    );

    return response;
  }

  // ── Slash commands ───────────────────────────────────────

  private static COMMANDS = new Set(["clear", "new", "status", "restart"]);

  private _tryCommand(text: string, msg: IncomingMessage): AgentResponse | null {
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
      case "status": {
        const hasSession = this._sessions.has(sessionKey);
        const sessionId = this._sessions.get(sessionKey);
        const providers = [...this._providers.keys()].join(", ");
        const connectors = this._connectors.map((c) => c.name).join(", ");
        return {
          text: [
            `**Remi Status**`,
            `- Session: ${hasSession ? sessionId?.slice(0, 12) + "..." : "无"}`,
            isThread ? `- Context: Thread (isolated)` : `- Context: Main chat`,
            `- Providers: ${providers}`,
            `- Connectors: ${connectors}`,
          ].join("\n"),
        };
      }
      default:
        return null;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._providers.size === 0) {
      throw new Error("No providers registered. Call addProvider() first.");
    }

    const tasks = this._connectors.map((c) => c.start(this.handleMessage.bind(this)));
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  async stop(): Promise<void> {
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
}
