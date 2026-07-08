import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RemiConfig } from "@shared/config.js";
import { SESSIONS_FILE } from "@shared/config.js";
import type { IncomingMessage } from "@connectors/base.js";
import type { AgentResponse, Provider, ProviderEvent } from "@shared/contracts/provider-types.js";
import { createAgentResponse } from "@shared/contracts/provider-types.js";
import { Remi } from "@remi/core.js";
import * as sessDb from "@shared/db/sessions.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `remi-test-core-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

class MockProvider implements Provider {
  lastMessage: string | null = null;
  lastContext: string | null = null;
  closed = false;

  constructor(private _responseText: string = "Mock response", private _name: string = "acp:claude") {}

  get name(): string {
    return this._name;
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
    cronJobs: [],
    services: [],
    botMenu: {},
    mcp: [],
    proxy: { http: "", noProxy: "" },
    plugins: { dir: join(tmpDir, "plugins"), enabled: [], allowExternal: true },
    pluginConfigs: {},
    auth: { adminEmails: [] },
    tracing: {
      enabled: false,
      logsDir: join(tmpDir, "logs"),
      tracesDir: join(tmpDir, "traces"),
      retentionDays: 7,
    },
    logLevel: "INFO",
  };
}

let tmpDir: string;
let config: RemiConfig;

beforeEach(() => {
  tmpDir = makeTmpDir();
  config = makeConfig(tmpDir);
  // Isolate tests from production DB — use a temp DB file
  const { setDbPath } = require("@shared/db/index.js");
  setDbPath(join(tmpDir, "test.db"));
});

afterEach(() => {
  const { closeDb } = require("@shared/db/index.js");
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
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessData), "utf-8");

    const remi = new Remi(config);
    const row = sessDb.getSession("restored-chat");
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("sess-restored");
    expect(row!.display_name).toContain("Remi·");

    // Original file renamed
    expect(existsSync(SESSIONS_FILE)).toBe(false);
    expect(existsSync(SESSIONS_FILE + ".migrated")).toBe(true);
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

// Characterization tests for the streaming auto-recovery path (prompt-too-long /
// stale-session). They lock the observable behavior so the Stage-2 refactor
// (routing the Feishu path through AgentSession) can be verified as a no-op.
describe("RemiCore auto-recovery", () => {
  function textsOf(e: ProviderEvent): string[] {
    if (e.sessionUpdate === "agent_message_chunk" || e.sessionUpdate === "agent_thought_chunk") {
      const blocks = Array.isArray(e.content) ? e.content : [e.content];
      return blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    }
    return [];
  }

  async function collectStream(remi: Remi, msg: IncomingMessage): Promise<string[]> {
    const texts: string[] = [];
    await remi.handleMessageStream(msg, async (stream) => {
      for await (const e of stream) texts.push(...textsOf(e));
    });
    return texts;
  }

  class PromptTooLongProvider implements Provider {
    calls = 0;
    cleared: string[] = [];
    private _last: AgentResponse | null = null;
    get name(): string { return "acp:claude"; }
    async send(): Promise<AgentResponse> { return createAgentResponse({ text: "x" }); }
    async *sendStream(): AsyncGenerator<ProviderEvent> {
      this.calls += 1;
      const text = this.calls === 1 ? "prompt is too long, reset please" : "recovered answer";
      this._last = createAgentResponse({ text, sessionId: this.calls === 1 ? null : "sess-new" });
      yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text }] };
    }
    getLastResponse(): AgentResponse | null { return this._last; }
    async clearSession(key?: string): Promise<void> { this.cleared.push(key ?? ""); }
    async healthCheck(): Promise<boolean> { return true; }
  }

  class StaleProvider implements Provider {
    calls = 0;
    cleared: string[] = [];
    private _last: AgentResponse | null = null;
    get name(): string { return "acp:claude"; }
    async send(): Promise<AgentResponse> { return createAgentResponse({ text: "x" }); }
    async *sendStream(): AsyncGenerator<ProviderEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        this._last = createAgentResponse({ text: "first", sessionId: "sess-1", inputTokens: 5, durationMs: 10 });
        yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: "first" }] };
      } else if (this.calls === 2) {
        // Stale: existing session + zero tokens / zero duration.
        this._last = createAgentResponse({ text: "stale", sessionId: "sess-1", inputTokens: 0, durationMs: 0 });
        yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: "stale" }] };
      } else {
        this._last = createAgentResponse({ text: "fresh answer", sessionId: "sess-2", inputTokens: 3, durationMs: 8 });
        yield { sessionUpdate: "agent_message_chunk" as const, content: [{ type: "text" as const, text: "fresh answer" }] };
      }
    }
    getLastResponse(): AgentResponse | null { return this._last; }
    async clearSession(key?: string): Promise<void> { this.cleared.push(key ?? ""); }
    async healthCheck(): Promise<boolean> { return true; }
  }

  it("auto-resets and retries when the response is prompt-too-long", async () => {
    const remi = new Remi(config);
    const provider = new PromptTooLongProvider();
    remi.addProvider(provider);
    const texts = await collectStream(remi, { text: "hi", chatId: "ptl-1", sender: "u", connectorName: "cli" });
    expect(provider.calls).toBe(2); // retried once
    expect(provider.cleared.length).toBeGreaterThanOrEqual(1); // provider session cleared
    expect(texts.some((t) => t.includes("自动重置"))).toBe(true); // recovery notice yielded
    expect(texts.some((t) => t.includes("recovered answer"))).toBe(true); // retry output yielded
  });

  it("auto-resets and retries on a stale session, clearing the session DB", async () => {
    const remi = new Remi(config);
    const provider = new StaleProvider();
    remi.addProvider(provider);
    await collectStream(remi, { text: "first", chatId: "stale-1", sender: "u", connectorName: "cli" });
    expect(sessDb.getSessionId("stale-1")).toBe("sess-1");
    const texts = await collectStream(remi, { text: "second", chatId: "stale-1", sender: "u", connectorName: "cli" });
    expect(provider.calls).toBe(3); // turn 2 (stale) + retry
    expect(provider.cleared.length).toBeGreaterThanOrEqual(1);
    expect(texts.some((t) => t.includes("会话已过期"))).toBe(true);
    expect(sessDb.getSessionId("stale-1")).toBe("sess-2"); // session updated to the fresh one
  });
});
