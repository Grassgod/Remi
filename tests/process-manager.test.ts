import { describe, it, expect } from "bun:test";
import { ClaudeProcessManager } from "../src/providers/claude-cli/process.js";

describe("BuildCommand", () => {
  it("builds basic command", () => {
    const mgr = new ClaudeProcessManager({ model: "claude-sonnet-4-5-20250929" });
    const cmd = mgr.buildCommand();
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("--input-format");
    const idx = cmd.indexOf("--input-format");
    expect(cmd[idx + 1]).toBe("stream-json");
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("--verbose");
  });

  it("includes model", () => {
    const mgr = new ClaudeProcessManager({ model: "claude-sonnet-4-5-20250929" });
    const cmd = mgr.buildCommand();
    expect(cmd).toContain("--model");
    const idx = cmd.indexOf("--model");
    expect(cmd[idx + 1]).toBe("claude-sonnet-4-5-20250929");
  });

  it("includes allowed tools", () => {
    const mgr = new ClaudeProcessManager({ allowedTools: ["Read", "Write"] });
    const cmd = mgr.buildCommand();
    expect(cmd).toContain("--allowedTools");
    const idx = cmd.indexOf("--allowedTools");
    expect(cmd[idx + 1]).toBe("Read,Write");
  });

  it("includes system prompt", () => {
    const mgr = new ClaudeProcessManager({ systemPrompt: "Be helpful" });
    const cmd = mgr.buildCommand();
    expect(cmd).toContain("--append-system-prompt");
    const idx = cmd.indexOf("--append-system-prompt");
    expect(cmd[idx + 1]).toBe("Be helpful");
  });

  it("minimal command", () => {
    const mgr = new ClaudeProcessManager();
    const cmd = mgr.buildCommand();
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--allowedTools");
    expect(cmd).not.toContain("--append-system-prompt");
    expect(cmd).not.toContain("--resume");
  });

  it("includes --resume when resumeSessionId is set", () => {
    const mgr = new ClaudeProcessManager({ resumeSessionId: "sess-abc123" });
    const cmd = mgr.buildCommand();
    expect(cmd).toContain("--resume");
    const idx = cmd.indexOf("--resume");
    expect(cmd[idx + 1]).toBe("sess-abc123");
  });

  it("does not include --resume when resumeSessionId is null", () => {
    const mgr = new ClaudeProcessManager({ resumeSessionId: null });
    const cmd = mgr.buildCommand();
    expect(cmd).not.toContain("--resume");
  });
});

describe("InitialState", () => {
  it("not alive initially", () => {
    const mgr = new ClaudeProcessManager();
    expect(mgr.isAlive).toBe(false);
    expect(mgr.sessionId).toBeNull();
  });
});

describe("SendAndStream", () => {
  it("throws when not running", async () => {
    const mgr = new ClaudeProcessManager();
    let error: Error | null = null;
    try {
      for await (const _ of mgr.sendAndStream("test")) {
        // Should not reach here
      }
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("not running");
  });
});
