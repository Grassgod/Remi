/**
 * Remi orchestrator — the Hub in Hub-and-Spoke architecture.
 *
 * Responsibilities:
 * 1. Receive messages from any connector (IncomingMessage)
 * 2. Lane Queue — serialize per chatId to prevent race conditions
 * 3. Session management — chatId → sessionId mapping
 * 4. Assemble the Multiremi agent row into an ACP session
 * 5. Run the configured provider
 * 6. Response dispatch — return AgentResponse via originating connector
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RemiConfig } from "@shared/config.js";
import { REMI_HOME, SESSIONS_FILE } from "@shared/config.js";
import type { MultiremiAgent, MultiremiDaemonBotProject } from "@multiremi/contracts/types.js";
import type { Connector, IncomingMessage } from "@connectors/base.js";
import { LaneScheduler, resolveSessionKey } from "@daemon/orchestrator.js";
import { createAgentResponse, type AgentResponse, type Provider, type ProviderEvent } from "@shared/contracts/provider-types.js";
import { AcpProvider } from "@acp/index.js";
import { AgentRuntime } from "@daemon/agent-runtime/runtime.js";
import { buildAgentMcpServers } from "@daemon/agent-runtime/mcp/ephemeral.js";
import { FeishuConnector, type FeishuSenderAuthorizer } from "@connectors/feishu/index.js";

import { AuthStore, FeishuAuthAdapter } from "@auth/index.js";
import type { TokenSyncRule } from "@auth/token-sync.js";
import { PluginRegistry } from "@daemon/agent-runtime/plugins/registry.js";
import { MetricsCollector } from "@shared/metrics/collector.js";
import * as sessDb from "@shared/db/sessions.js";
import { createLogger, flushLogs } from "@shared/logger.js";
import { TraceCollector } from "@shared/tracing.js";

import { handleMessageStream, processStream } from "./core/message-stream.js";

const log = createLogger("core");

// AsyncLock + resolveSessionKey extracted to daemon/orchestrator.ts in D6.

export class Remi {
  config: RemiConfig;
  readonly agent: MultiremiAgent;
  metrics: MetricsCollector;
  traceCollector: TraceCollector;
  authStore: AuthStore | null = null;
  _configManager: any = null; // ConfigManager instance
  _providers = new Map<string, Provider>();
  readonly _connectors: Connector[] = [];
  // Per-lane (per session-key) serialization. Unbounded by default, matching the
  // monolith's historical behavior; the shared LaneScheduler also caps total
  // concurrency, which is what the multiremi daemon uses via its SQL queue.
  readonly _scheduler: LaneScheduler;
  readonly _activeAborts = new Map<string, AbortController>();
  readonly _runtime = new AgentRuntime();
  private _botProjects: Map<string, MultiremiDaemonBotProject> | null;
  private readonly _ensureTopicWorkspaceCallback: ((sessionKey: string, topicId: string) => Promise<string | null>) | null;

  constructor(
    config: RemiConfig,
    agent: MultiremiAgent,
    botProjects: MultiremiDaemonBotProject[] | null = null,
    ensureTopicWorkspace: ((sessionKey: string, topicId: string) => Promise<string | null>) | null = null,
  ) {
    this.config = config;
    this.agent = agent;
    this._botProjects = botProjects ? new Map(botProjects.map((project) => [project.id, project])) : null;
    this._ensureTopicWorkspaceCallback = ensureTopicWorkspace;
    if (agent.archivedAt) throw new Error(`Bot agent ${agent.id} is archived`);
    this._scheduler = new LaneScheduler({ maxConcurrency: agent.maxConcurrentTasks });
    this.metrics = new MetricsCollector(REMI_HOME);
    this.traceCollector = new TraceCollector();
    this._migrateSessionsJson();
  }

  // ── Provider management ──────────────────────────────────

  addProvider(provider: Provider): void {
    this._providers.set(provider.name, provider);
  }

  _getProvider(name?: string | null): Provider {
    const n = name ?? `acp:${this.agent.provider}`;
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

  setBotProjects(projects: MultiremiDaemonBotProject[]): void {
    this._botProjects = new Map(projects.map((project) => [project.id, project]));
  }

  _listBotProjects(): MultiremiDaemonBotProject[] | null {
    return this._botProjects ? [...this._botProjects.values()] : null;
  }

  _getBotProject(id: string): MultiremiDaemonBotProject | null {
    return this._botProjects?.get(id) ?? null;
  }

  async _ensureTopicWorkspace(sessionKey: string, topicId: string | null): Promise<string | null> {
    if (!topicId || !this._ensureTopicWorkspaceCallback) return null;
    return this._ensureTopicWorkspaceCallback(sessionKey, topicId);
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
  static boot(
    config: RemiConfig,
    agent: MultiremiAgent,
    botProjects: MultiremiDaemonBotProject[],
    options: {
      authorizeFeishuSender?: FeishuSenderAuthorizer;
      daemonPort?: number;
      workspacesRoot?: string;
      ensureTopicWorkspace?: (sessionKey: string, topicId: string) => Promise<string | null>;
    } = {},
  ): Remi {
    const remi = new Remi(config, agent, botProjects, options.ensureTopicWorkspace ?? null);

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

    // 2. Provider — one Multiremi agent row is the sole execution config.
    const provider = Remi._buildProvider(agent, {
      ...(options.daemonPort ? { MULTIREMI_DAEMON_PORT: String(options.daemonPort) } : {}),
      ...(options.workspacesRoot ? { MULTIREMI_WORKSPACES_ROOT: options.workspacesRoot } : {}),
    });
    remi.addProvider(provider);

    // 3. Feishu connector
    if (hasFeishuCreds) {
      if (!options.authorizeFeishuSender) {
        throw new Error("Feishu workspace membership authorizer is required");
      }
      const feishuConfig = { ...config.feishu };
      const feishu = new FeishuConnector(
        feishuConfig,
        { getByChatId: () => ({ monitor: false }) },
        options.authorizeFeishuSender,
      );
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
    }

    // 4. ConfigManager — symlinks
    const { configManager } = require("@shared/infra/config-manager");
    remi._configManager = configManager;
    configManager.ensureAllProjects();
    configManager.ensureGlobals();

    return remi;
  }

  private static _buildProvider(agent: MultiremiAgent, runtimeEnv: Record<string, string> = {}) {
    const rawType = agent.provider;
    const type = rawType.startsWith("acp:") ? rawType.slice("acp:".length) : rawType;
    if (type !== "claude" && type !== "codex") {
      throw new Error(`Unknown ACP provider: ${rawType}`);
    }
    return new AcpProvider({
      agentType: type,
      model: agent.model,
      allowedTools: agent.allowedTools,
      cwd: process.cwd(),
      executable: agent.executable ?? undefined,
      args: agent.customArgs,
      env: { ...agent.customEnv, ...runtimeEnv },
      getMcpServers: () => buildAgentMcpServers(agent.mcpConfig),
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
