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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { RemiConfig } from "@shared/config.js";
import { MEMORY_DIR, SESSIONS_FILE } from "@shared/config.js";
import { GroupConfigStore } from "./group/store.js";
import type { GroupConfig } from "./group/model.js";
import type { Connector, IncomingMessage } from "@connectors/base.js";
import { LaneScheduler, resolveSessionKey } from "@daemon/orchestrator.js";
import { createAgentResponse, type AgentResponse, type Provider, type ProviderEvent } from "@shared/contracts/provider-types.js";
import { AcpProvider } from "@acp/index.js";
import { AgentRuntime } from "@daemon/agent-runtime/runtime.js";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { MenuSyncer } from "@connectors/feishu/sdk.js";

import { AuthStore, FeishuAuthAdapter } from "@auth/index.js";
import type { TokenSyncRule } from "@auth/token-sync.js";
import { PluginRegistry } from "@daemon/agent-runtime/plugins/registry.js";
import { MemoryStore } from "@memory/store.js";
import { MetricsCollector } from "@shared/metrics/collector.js";
import { getDb } from "@shared/db/index.js";
import * as sessDb from "@shared/db/sessions.js";
import { createLogger, flushLogs } from "@shared/logger.js";
import { TraceCollector } from "@shared/tracing.js";

import { handleMessageStream, processStream } from "./core/message-stream.js";

const log = createLogger("core");

// AsyncLock + resolveSessionKey extracted to daemon/orchestrator.ts in D6.

// System prompt now lives in ~/.remi/soul.md (symlinked to ~/.claude/CLAUDE.md)
// Claude CLI loads it automatically — no need to inject via --append-system-prompt

export class Remi {
  config: RemiConfig;
  memory: MemoryStore;
  metrics: MetricsCollector;
  traceCollector: TraceCollector;
  authStore: AuthStore | null = null;
  _configManager: any = null; // ConfigManager instance
  _providers = new Map<string, Provider>();
  readonly _connectors: Connector[] = [];
  // Per-lane (per session-key) serialization. Unbounded by default, matching the
  // monolith's historical behavior; the shared LaneScheduler also caps total
  // concurrency, which is what the multiremi daemon uses via its SQL queue.
  readonly _scheduler = new LaneScheduler();
  readonly _activeAborts = new Map<string, AbortController>();
  readonly _runtime = new AgentRuntime();

  constructor(config: RemiConfig) {
    this.config = config;
    // Initialize VectorStore if embedding config is available
    let vectorStore: InstanceType<typeof import("@shared/db/vector-store.js").VectorStore> | null = null;
    if (config.embedding?.apiKey) {
      try {
        const { VectorStore } = require("@shared/db/vector-store.js");
        vectorStore = new VectorStore(config.embedding);
      } catch { /* vector search unavailable */ }
    }
    this.memory = new MemoryStore(MEMORY_DIR, vectorStore);
    this.metrics = new MetricsCollector(dirname(MEMORY_DIR));
    this.traceCollector = new TraceCollector();
    this._migrateSessionsJson();
  }

  // ── Provider management ──────────────────────────────────

  addProvider(provider: Provider): void {
    this._providers.set(provider.name, provider);
  }

  _getProvider(name?: string | null): Provider {
    const n = name ?? `acp:${this.config.provider.default}`;
    let provider = this._providers.get(n);
    if (!provider) {
      // "acp" → match first "acp:*" variant
      for (const [key, p] of this._providers) {
        if (key.startsWith(`${n}:`)) {
          provider = p;
          break;
        }
      }
    }
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

  /** Abort active processing for a session (called by /esc). */
  abortSession(sessionKey: string): void {
    const ac = this._activeAborts.get(sessionKey);
    if (ac) {
      ac.abort();
      log.info(`abortSession: aborted "${sessionKey}"`);
    }
  }

  // ── Session key resolution (thread-aware) ────────────────

  /**
   * Resolve session key for a message.
   * Thread messages (with rootId) get isolated sessions: `${chatId}:thread:${rootId}`.
   * Group messages without rootId use messageId as thread key (they will become thread roots).
   * P2P messages use plain `chatId` for continuous conversation.
   */
  _resolveSessionKey(msg: IncomingMessage): string {
    return resolveSessionKey(msg);
  }

  // ── Group config resolution ──────────────────────────────

  /** Look up group config from DB by chatId. Returns all routing info in one query. */
  _getGroupConfig(chatId: string): GroupConfig | null {
    try {
      const store = new GroupConfigStore();
      return store.getByChatId(chatId);
    } catch {
      return null;
    }
  }

  // ── Message handling (the core loop) ─────────────────────

  async handleMessage(msg: IncomingMessage): Promise<AgentResponse> {
    const sessionKey = this._resolveSessionKey(msg);
    return this._scheduler.run(sessionKey, () => this._process(msg));
  }

  async handleMessageStream(
    msg: IncomingMessage,
    consumer: (stream: AsyncIterable<ProviderEvent>, meta: import("@connectors/base.js").StreamMeta) => Promise<void>,
  ): Promise<void> {
    return handleMessageStream(this, msg, consumer);
  }

  private async _process(msg: IncomingMessage): Promise<AgentResponse> {
    let returnedResponse: AgentResponse | null = null;
    let text = "";
    let thinking = "";
    const stream = processStream(this, msg);
    while (true) {
      const next = await stream.next();
      if (next.done) {
        returnedResponse = next.value ?? null;
        break;
      }
      const event = next.value;
      if (event.sessionUpdate === "agent_message_chunk") {
        for (const block of event.content) {
          if (block.type === "text") text += block.text;
        }
      } else if (event.sessionUpdate === "agent_thought_chunk") {
        for (const block of event.content) {
          if (block.type === "text") thinking += block.text;
        }
      }
    }
    if (returnedResponse) {
      return returnedResponse;
    } else if (text) {
      return createAgentResponse({ text, thinking: thinking || null });
    } else {
      return createAgentResponse({ text: "[Error: no result from provider]" });
    }
  }

  // ── Static factory ─────────────────────────────────────────

  /**
   * Build a fully-wired Remi instance from config.
   * Replaces the old RemiDaemon._buildRemi() — all component assembly in one place.
   */
  static boot(config: RemiConfig): Remi {
    const remi = new Remi(config);

    // 1. AuthStore (1Passport) with token sync rules
    const syncRules: TokenSyncRule[] | undefined =
      config.tokenSync.length > 0
        ? (config.tokenSync as TokenSyncRule[])
        : undefined;
    const authStore = new AuthStore(join(homedir(), ".remi", "auth"), syncRules);
    const hasFeishuCreds = !!(config.feishu.appId && config.feishu.appSecret);
    if (hasFeishuCreds) {
      authStore.registerAdapter(
        new FeishuAuthAdapter({
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          domain: config.feishu.domain,
          userAccessToken: config.feishu.userAccessToken || undefined,
        }),
      );
    }
    remi.authStore = authStore;

    // Plugins (core surface) — auth adapters contributed by in-tree or external
    // (~/.remi/plugins) plugins. ByteDance SSO is an external plugin. Best-effort:
    // a broken plugin must never block the daemon from booting.
    try {
      new PluginRegistry().load(config).dispatchCore({ authStore, config });
    } catch (e) {
      log.warn("Plugin core dispatch failed:", e);
    }

    // 2. Providers — register primary + both ACP agents
    const provider = Remi._buildProvider(config);
    remi.addProvider(provider);

    // Register both configured ACP agents for group-level provider routing.
    const otherType = config.provider.default === "claude" ? "codex" : "claude";
    if (!remi._providers.has(`acp:${otherType}`)) {
      try {
        remi.addProvider(Remi._buildProvider(config, otherType));
      } catch (e) {
        log.warn(`Failed to build acp:${otherType} provider:`, e);
      }
    }

    // 3. Feishu connector
    if (hasFeishuCreds) {
      const feishuConfig = { ...config.feishu };
      // Inject the group-policy lookup so the connector (L1) never imports the
      // remi-product GroupConfigStore (L3) itself.
      const gcStore = new GroupConfigStore();
      const feishu = new FeishuConnector(feishuConfig, {
        getByChatId: (chatId) => gcStore.getByChatId(chatId),
      });
      feishu.setTokenProvider(() => authStore.getToken("feishu", "tenant"));
      // Wire /esc abort: (1) signal abort to unblock readline, (2) kill CLI process
      feishu.setAbortHandler(async (chatId: string) => {
        remi.abortSession(chatId);  // Immediately unblock _readline via AbortSignal
        const provider = remi._getProvider();
        if ("clearSession" in provider && typeof provider.clearSession === "function") {
          await (provider as Provider & { clearSession: (k?: string) => Promise<void> }).clearSession(chatId);
        }
      });
      remi.addConnector(feishu);
      log.info("Registered Feishu connector (with 1Passport)");

      // Bot menu sync (fire-and-forget on startup)
      const menuSyncer = new MenuSyncer({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        domain: config.feishu.domain,
      });
      menuSyncer.syncAll(config.botMenu, config.feishu.triggerUserIds).catch((err) => {
        log.warn(`Bot menu sync failed: ${err.message}`);
      });
    }

    // 4. ConfigManager — symlinks
    const { configManager } = require("@shared/infra/config-manager");
    remi._configManager = configManager;
    configManager.ensureAllProjects();
    configManager.ensureGlobals();

    return remi;
  }

  private static _buildProvider(config: RemiConfig, agentType?: string) {
    const rawType = agentType ?? config.provider.default;
    const type = rawType.startsWith("acp:") ? rawType.slice("acp:".length) : rawType;
    if (type !== "claude" && type !== "codex") {
      throw new Error(`Unknown ACP provider: ${rawType}`);
    }
    const agentCfg = config.provider[type] ?? config.provider.claude;
    return new AcpProvider({
      agentType: type,
      model: agentCfg.model,
      timeout: agentCfg.timeout,
      allowedTools: agentCfg.allowedTools,
      cwd: homedir(),
      executable: agentCfg.executable,
      // ACP wire shape: `args`/`env` are required and `env` is an
      // EnvVariable[] — a Record env makes the agent drop the server silently.
      getMcpServers: () => config.mcp
        .filter((e) => !e.agents || e.agents.includes(type))
        .map((e) => ({
          name: e.name,
          command: e.command,
          args: e.args ?? [],
          env: Object.entries(e.env ?? {}).map(([name, value]) => ({ name, value })),
        })),
    });
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
    flushLogs();

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

  // ── Session migration (sessions.json → DB) ─────────────────

  /** One-time migration from sessions.json to SQLite. */
  private _migrateSessionsJson(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) return;
      const raw = readFileSync(SESSIONS_FILE, "utf-8");
      const data = JSON.parse(raw) as sessDb.LegacySessionData;
      if (!data.entries || !Array.isArray(data.entries) || data.entries.length === 0) return;

      const count = sessDb.migrateFromJson(data);
      log.info(`Migrated ${count} session(s) from sessions.json to DB`);

      // Rename old file as backup (presence of .migrated = migration done)
      const { renameSync } = require("node:fs");
      renameSync(SESSIONS_FILE, SESSIONS_FILE + ".migrated");
      log.info(`Renamed sessions.json → sessions.json.migrated`);
    } catch (e) {
      log.warn("Failed to migrate sessions.json:", e);
    }
  }

  /** Get session display name for a session key. */
  getSessionDisplayName(sessionKey: string): string | null {
    return sessDb.getDisplayName(sessionKey);
  }
}
