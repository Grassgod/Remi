import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RemiConfig } from "../src/config.js";
import type { IncomingMessage } from "../src/connectors/base.js";
import type { AgentResponse, Provider } from "../src/providers/base.js";
import { createAgentResponse } from "../src/providers/base.js";
import { Remi } from "../src/core.js";

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

  async healthCheck(): Promise<boolean> {
    return false;
  }
}

function makeConfig(tmpDir: string): RemiConfig {
  return {
    provider: {
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
    },
    scheduler: {
      memoryCompactCron: "0 3 * * *",
      heartbeatInterval: 300,
    },
    memoryDir: join(tmpDir, "memory"),
    pidFile: join(tmpDir, "remi.pid"),
    logLevel: "INFO",
    contextWarnThreshold: 6000,
    queueDir: join(tmpDir, "queue"),
  };
}

let tmpDir: string;
let config: RemiConfig;

beforeEach(() => {
  tmpDir = makeTmpDir();
  config = makeConfig(tmpDir);
});

afterEach(() => {
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

  it("tracks sessions", async () => {
    const remi = new Remi(config);
    remi.addProvider(new MockProvider());
    const msg: IncomingMessage = {
      text: "Hello",
      chatId: "test-1",
      sender: "user",
      connectorName: "cli",
    };
    await remi.handleMessage(msg);
    expect(remi._sessions.get("test-1")).toBe("sess-mock");
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
    expect(remi._sessions.get("chat-1")).toBe("sess-mock");

    // Thread message (has rootId)
    await remi.handleMessage({
      text: "Hello thread",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-2", rootId: "msg-root-1" },
    });
    expect(remi._sessions.get("chat-1:thread:msg-root-1")).toBe("sess-mock");

    // Both sessions exist independently
    expect(remi._sessions.has("chat-1")).toBe(true);
    expect(remi._sessions.has("chat-1:thread:msg-root-1")).toBe(true);
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

    expect(remi._sessions.get("chat-1")).toBe("sess-mock");
    expect(remi._sessions.size).toBe(1);
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

    expect(remi._sessions.has("chat-1")).toBe(true);
    expect(remi._sessions.has("chat-1:thread:msg-root-1")).toBe(true);

    // Clear in thread
    const response = await remi.handleMessage({
      text: "/clear",
      chatId: "chat-1",
      sender: "user",
      connectorName: "feishu",
      metadata: { messageId: "msg-3", rootId: "msg-root-1" },
    });

    expect(response.text).toContain("上下文已清除");
    // Thread session cleared, main session untouched
    expect(remi._sessions.has("chat-1:thread:msg-root-1")).toBe(false);
    expect(remi._sessions.has("chat-1")).toBe(true);
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
    expect(remi._sessions.get("chat-1:thread:root-1")).toBe("sess-mock");
    // Only 1 thread session created
    const threadSessions = [...remi._sessions.keys()].filter(k => k.includes(":thread:"));
    expect(threadSessions.length).toBe(1);
  });
});
