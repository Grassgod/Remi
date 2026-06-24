import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RemiConfig } from "../src/config.js";
import type { IncomingMessage } from "../src/connectors/base.js";
import type { AgentResponse, Provider, ProviderEvent } from "../src/providers/base.js";
import { createAgentResponse } from "../src/providers/base.js";
import { Remi } from "../src/core.js";
import * as sessDb from "../src/db/sessions.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-core-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

class MockProvider implements Provider {
  lastMessage: string | null = null;
  lastContext: string | null = null;
  closed = false;

  constructor(private _responseText: string = "Mock response") {}

  get name(): string {
    return "mock";
  }

  async send(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      cwd?: string | null;
      sessionId?: string | null;
    },
  ): Promise<AgentResponse> {
    this.lastMessage = message;
    this.lastContext = options?.context ?? null;
    return createAgentResponse({
      text: this._responseText,
      sessionId: "sess-mock",
    });
  }

  private _lastResponse: AgentResponse | null = null;

  async *sendStream(
    message: string,
    options?: {
      systemPrompt?: string | null;
      context?: string | null;
      chatId?: string | null;
    },
  ): AsyncGenerator<ProviderEvent> {
    this.lastMessage = message;
    this.lastContext = options?.context ?? null;
    this._lastResponse = createAgentResponse({ text: this._responseText, sessionId: "sess-mock" });
    yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: this._responseText }] };
  }

  getLastResponse(): AgentResponse | null { return this._lastResponse; }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockFailProvider implements Provider {
  get name(): string {
    return "fail";
  }

  async send(_message: string): Promise<AgentResponse> {
    return createAgentResponse({ text: "[Provider error: boom]" });
  }

  async *sendStream(
    _message: string,
    _options?: {
      systemPrompt?: string | null;
      context?: string | null;
      chatId?: string | null;
    },
  ): AsyncGenerator<ProviderEvent> {
    yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: "[Provider error: boom]" }] };
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}

function makeConfig(tmpDir: string): RemiConfig {
  return {
    provider: {
      default: "claude",
      claude: { timeout: 300, allowedTools: [] },
      codex: { timeout: 300, allowedTools: [] },
      name: "mock",
      fallback: null,
      allowedTools: [],
      model: null,
      timeout: 300,
    },
    feishu: {
      appId: "",
      appSecret: "",
      verificationToken: "",
      encryptKey: "",
      port: 9000,
      domain: "feishu",
      connectionMode: "websocket",
      userAccessToken: "",
      triggerUserIds: [],
    },
    tokenSync: [],
    scheduler: {
      memoryCompactCron: "0 3 * * *",
      heartbeatInterval: 300,
    },
    scheduledSkills: [],
    cronJobs: [],
    services: [],
    botMenu: {},
    proxy: { http: "", noProxy: "" },
    plugins: { dir: join(tmpDir, "plugins"), enabled: [], allowExternal: true },
    pluginConfigs: {},
    auth: { adminEmails: [] },
    configHub: { enabled: false, configDir: join(tmpDir, "config-hub") },
    tracing: {
      enabled: false,
      logsDir: join(tmpDir, "logs"),
      tracesDir: join(tmpDir, "traces"),
      retentionDays: 7,
    },
    memoryDir: join(tmpDir, "memory"),
    pidFile: join(tmpDir, "remi.pid"),
    logLevel: "INFO",
    contextWarnThreshold: 6000,
    queueDir: join(tmpDir, "queue"),
    sessionsFile: join(tmpDir, "sessions.json"),
  };
}

let tmpDir: string;
let config: RemiConfig;

beforeEach(() => {
  tmpDir = makeTmpDir();
  config = makeConfig(tmpDir);
  // Isolate tests from production DB — use a temp DB file
  const { setDbPath } = require("../src/db/index.js");
  setDbPath(join(tmpDir, "test.db"));
});

afterEach(() => {
  const { closeDb } = require("../src/db/index.js");
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("RemiCore", () => {
  it("handles message", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());
    const msg: IncomingMessage = {
      text: "Hello",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    const response = await remi.handleMessage(msg);
    expect(response.text).toBe("Mock response");
    expect(response.sessionId).toBe("sess-mock");
  });

  it("tracks sessions in DB", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());
    const msg: IncomingMessage = {
      text: "Hello",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    await remi.handleMessage(msg);
    expect(sessDb.getSessionId("test-1")).toBe("sess-mock");
    // display_name should be generated
    const row = sessDb.getSession("test-1");
    expect(row).not.toBeNull();
    expect(row!.display_name).toContain("Remi");
    expect(row!.display_name).toContain("·"); // has genus separator
  });

  it("appends daily note", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());
    const msg: IncomingMessage = {
      text: "Hello",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    await remi.handleMessage(msg);
    const daily = remi.memory.readDaily();
    expect(daily).toContain("Hello");
  });

  it("injects memory context", async () => {
    const remi = new Remi(config);
    const provider = new MockProvider();
    remi.addProvider(provider);
    remi.memory.writeMemory("User prefers uv");
    const msg: IncomingMessage = {
      text: "Hello",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
      metadata: { cwd: undefined },
    };
    await remi.handleMessage(msg);
    expect(provider.lastContext).not.toBeNull();
    expect(provider.lastContext).toContain("uv");
  });

  it("uses fallback provider", async () => {
    config.provider.name = "fail";
    config.provider.fallback = "mock";
    const remi = new Remi(config);
    remi.addProvider(new MockFailProvider());
    remi.addProvider(new MockProvider("Fallback worked"));

    const msg: IncomingMessage = {
      text: "Hello",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    const response = await remi.handleMessage(msg);
    expect(response.text).toBe("Fallback worked");
  });

  it("serializes lane messages", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());
    const msg1: IncomingMessage = {
      text: "First",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    const msg2: IncomingMessage = {
      text: "Second",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    // Both should complete without errors
    await Promise.all([remi.handleMessage(msg1), remi.handleMessage(msg2)]);
  });

  it("throws when no providers", async () => {
    const remi = new Remi(config);
    expect(remi.start()).rejects.toThrow("No providers registered");
  });

  it("stop closes providers", async () => {
    const remi = new Remi(config);
    const provider = new MockProvider();
    remi.addProvider(provider);
    await remi.stop();
    expect(provider.closed).toBe(true);
  });

  it("stop works without close method", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockFailProvider());
    // MockFailProvider has no close() — should not throw
    await remi.stop();
  });

  // ── Thread-aware session isolation ──────────────────────

  it("thread messages get isolated session", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    // Main chat message
    await remi.handleMessage({
      text: "Hello main",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
    });
    expect(sessDb.getSessionId("chat-1")).toBe("sess-mock");

    // Thread message (has rootId)
    await remi.handleMessage({
      text: "Hello thread",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-2", rootId: "msg-root-1" },
    });
    expect(sessDb.getSessionId("chat-1:thread:msg-root-1")).toBe("sess-mock");

    // Both sessions exist independently
    expect(sessDb.getSessionId("chat-1")).not.toBeNull();
    expect(sessDb.getSessionId("chat-1:thread:msg-root-1")).not.toBeNull();
  });

  it("non-thread messages use main session", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    await remi.handleMessage({
      text: "Hello",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-1" }, // no rootId
    });

    expect(sessDb.getSessionId("chat-1")).toBe("sess-mock");
  });

  it("/clear in thread clears only thread session", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    // Create main session
    await remi.handleMessage({
      text: "hello",
      chatId: "chat-1",
      sender: "user",
      connectorName: "cli",
    });

    // Create thread session
    await remi.handleMessage({
      text: "hello thread",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-2", rootId: "msg-root-1" },
    });

    expect(sessDb.getSessionId("chat-1")).not.toBeNull();
    expect(sessDb.getSessionId("chat-1:thread:msg-root-1")).not.toBeNull();

    // Clear in thread
    const response = await remi.handleMessage({
      text: "/clear",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-3", rootId: "msg-root-1" },
    });

    expect(response.text).toContain("上下文已清除");
    // Thread session cleared (session_id empty), main session untouched
    expect(sessDb.getSessionId("chat-1:thread:msg-root-1")).toBeNull();
    expect(sessDb.getSessionId("chat-1")).not.toBeNull();
  });

  it("/status in thread shows thread context", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    const response = await remi.handleMessage({
      text: "/status",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-1", rootId: "msg-root-1" },
    });

    expect(response.text).toContain("Thread (isolated)");
  });

  it("/status in main chat shows main context", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    const response = await remi.handleMessage({
      text: "/status",
      chatId: "chat-1",
      sender: "user",
      connectorName: "cli",
    });

    expect(response.text).toContain("Main chat");
  });

  it("same thread shares session across messages", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    // First message in thread
    await remi.handleMessage({
      text: "First",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-1", rootId: "root-1" },
    });

    // Second message in same thread
    await remi.handleMessage({
      text: "Second",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-2", rootId: "root-1" },
    });

    // Should use the same session key
    expect(sessDb.getSessionId("chat-1:thread:root-1")).toBe("sess-mock");
    // Display name should be consistent
    const row = sessDb.getSession("chat-1:thread:root-1");
    expect(row).not.toBeNull();
    expect(row!.display_name).toContain("Remi·");
  });

  // ── Session DB persistence ─────────────────────────────

  it("sessions persist in DB after handling message", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    await remi.handleMessage({
      text: "Hello",
      chatId: "chat-persist",
      sender: "user",
      connectorName: "cli",
    });

    const row = sessDb.getSession("chat-persist");
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("sess-mock");
    expect(row!.display_name).toContain("Remi·");
  });

  it("migrates sessions.json on first load", async () => {
    // Write a legacy sessions file
    const sessData = {
      entries: [["restored-chat", "sess-restored"]],
      savedAt: Date.now(),
    };
    writeFileSync(config.sessionsFile, JSON.stringify(sessData), "utf-8");

    const remi = new Remi(config);
    const row = sessDb.getSession("restored-chat");
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("sess-restored");
    expect(row!.display_name).toContain("Remi·");

    // Original file renamed
    expect(existsSync(config.sessionsFile)).toBe(false);
    expect(existsSync(config.sessionsFile + ".migrated")).toBe(true);
  });

  it("/clear clears session_id but keeps display_name", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    // Create a session
    await remi.handleMessage({
      text: "Hello",
      chatId: "chat-clear",
      sender: "user",
      connectorName: "cli",
    });
    const nameBefore = sessDb.getDisplayName("chat-clear");
    expect(nameBefore).not.toBeNull();

    // Clear it
    await remi.handleMessage({
      text: "/clear",
      chatId: "chat-clear",
      sender: "user",
      connectorName: "cli",
    });

    // session_id cleared but display_name preserved
    expect(sessDb.getSessionId("chat-clear")).toBeNull();
    expect(sessDb.getDisplayName("chat-clear")).toBe(nameBefore);
  });

  // ── Session display name uniqueness ────────────────────

  it("generates unique display names with genus", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    // Create multiple sessions — they should all get unique names
    for (let i = 0; i < 5; i++) {
      await remi.handleMessage({
        text: `Hello ${i}`,
        chatId: `chat-${i}`,
        sender: "user",
        connectorName: "cli",
      });
    }

    const names = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const name = sessDb.getDisplayName(`chat-${i}`);
      expect(name).not.toBeNull();
      expect(names.has(name!)).toBe(false);
      names.add(name!);
    }
  });

  // ── /sessions command ──────────────────────────────────

  it("/sessions lists active sessions", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());

    await remi.handleMessage({
      text: "Hello",
      chatId: "chat-1",
      sender: "user",
      connectorName: "cli",
    });

    const response = await remi.handleMessage({
      text: "/sessions",
      chatId: "chat-1",
      sender: "user",
      connectorName: "cli",
    });

    expect(response.text).toContain("活跃 Sessions");
    expect(response.text).toContain("Remi·");
    expect(response.text).toContain("当前");
  });
});
