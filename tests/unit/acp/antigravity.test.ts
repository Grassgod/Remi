import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AntigravityProvider, filterAntigravityArgs, parseAntigravityModels, parseAntigravityTranscript } from "@acp/antigravity.js";
import { createRuntimeProvider } from "@acp/runtime-provider.js";

const roots: string[] = [];
const providers: AntigravityProvider[] = [];
const fixtureExecutable = Bun.which("node") ?? process.execPath;
afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
function fixture(mode = "stream") {
  const root = mkdtempSync(join(tmpdir(), "remi-agy-test-"));
  roots.push(root);
  const capture = join(root, "capture.json");
  const provider = new AntigravityProvider({
    executable: fixtureExecutable, args: [resolve("tests/fixtures/antigravity-cli.mjs")], cwd: root,
    env: { FAKE_AGY_MODE: mode, FAKE_AGY_CAPTURE: capture, FAKE_AGY_DATA_DIR: root, MULTIREMI_TOKEN: "task-scoped-token" },
  });
  providers.push(provider);
  return { root, capture, provider };
}

describe("Antigravity native provider", () => {
  it("selects native agy instead of an ACP connection", async () => {
    const provider = createRuntimeProvider({ agentType: "antigravity" });
    expect(provider).toBeInstanceOf(AntigravityProvider);
    await provider.close();
  }, 15_000);
  it("parses both model catalogs without inventing a default", () => {
    expect(parseAntigravityModels("model-one\tModel One\r\nmodel-one\tDuplicate\nLegacy Model (Thinking)\n")).toEqual([
      { id: "model-one", label: "Model One", default: false },
      { id: "Legacy Model (Thinking)", label: "Legacy Model (Thinking)", default: false },
    ]);
    expect(parseAntigravityModels("Fetching available models...\nError: Please sign in")).toEqual([]);
  }, 15_000);
  it("discovers installed models and reports authentication failure", async () => {
    expect(await fixture().provider.healthCheck()).toBe(true);
    expect((await fixture().provider.discoverModelCapabilities()).map(model => model.id)).toEqual(["model-one", "model-two"]);
    await expect(fixture("auth-error").provider.discoverModelCapabilities()).rejects.toThrow("sign in");
  }, 15_000);
  it("streams exact newlines, captures native session and real token usage", async () => {
    const { provider, capture } = fixture();
    const chunks = [];
    for await (const event of provider.sendStream("Hello", { systemPrompt: "System instructions", context: "Task context", model: "model-one" })) {
      if (event.sessionUpdate === "agent_message_chunk") chunks.push(...event.content.map(block => block.type === "text" ? block.text : ""));
    }
    expect(chunks.join("")).toBe("# Heading\n\n- Done\n");
    expect(provider.getLastResponse()).toMatchObject({ sessionId: "12345678-1234-1234-1234-123456789abc", inputTokens: 100, outputTokens: 20 });
    const invocation = JSON.parse(readFileSync(capture, "utf8"));
    expect(invocation.prompt).toBe("System instructions\n\nTask context\n\nHello");
    expect(invocation.args).not.toContain("-p");
    expect(invocation.token).toBe("task-scoped-token");
  }, 15_000);
  it("resumes only the explicit conversation and rejects unsupported models", async () => {
    const { provider, capture } = fixture();
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await provider.send("Next", { sessionId });
    expect(JSON.parse(readFileSync(capture, "utf8")).args).toContain(sessionId);
    expect(provider.getLastResponse()?.sessionId).toBe(sessionId);
    await expect(provider.send("Next", { model: "missing" })).rejects.toThrow("not available");
    await expect(provider.send("Next", { sessionId: "../other" })).rejects.toThrow("conversation ID");
  }, 15_000);
  it("normalizes native tool progress without duplicating assistant text", async () => {
    const { provider } = fixture("tool");
    const types = [];
    for await (const event of provider.sendStream("Run a tool")) types.push(event.sessionUpdate);
    expect(types).toEqual(["tool_call", "tool_call_update", "agent_message_chunk", "agent_message_chunk"]);
  }, 15_000);
  it.each(["wrong-session", "legacy-wrong-session"])("rejects a different resumed conversation in %s", async mode => {
    await expect(fixture(mode).provider.send("Next", { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })).rejects.toThrow("Stale provider session");
  }, 15_000);
  it.each(["missing-result", "result-error", "invalid-json", "legacy-error", "legacy-timeout", "legacy-empty"])("fails closed for %s instead of recording empty success", async mode => {
    await expect(fixture(mode).provider.send("Hello")).rejects.toThrow();
  }, 15_000);
  it("preserves legacy text and leaves unreported usage unknown", async () => {
    const response = await fixture("legacy-text").provider.send("Hello");
    expect(response.text).toBe("# Heading\n\n- First\n- Second\n");
    expect(response.inputTokens).toBeNull();
  }, 15_000);
  it("recovers only the current turn of an empty legacy stdout", async () => {
    const response = await fixture("legacy-recovery").provider.send("Hello");
    expect(response.text).toBe("Recovered current answer");
    expect(parseAntigravityTranscript('{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","content":"unowned"}')).toBe("");
  }, 15_000);
  it("cancels the process and preserves its session for steering", async () => {
    const { provider, capture } = fixture("hang");
    const controller = new AbortController();
    const result = provider.send("Wait", { signal: controller.signal }).then(() => null, error => error);
    for (let i = 0; i < 100; i++) {
      try { readFileSync(capture); break; } catch { await Bun.sleep(20); }
    }
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(provider.getLastResponse()?.sessionId).toBe("12345678-1234-1234-1234-123456789abc");
  }, 10_000);
  it("applies a task deadline", async () => {
    await expect(fixture("hang").provider.send("Wait", { deadlineMs: Date.now() + 600 })).rejects.toThrow("timed out");
  }, 15_000);
  it("rejects unsupported approvals and MCP before a task can run", async () => {
    await expect(fixture().provider.send("Hello", { permissionMode: "default" })).rejects.toThrow("interactive approvals");
    await expect(fixture().provider.send("Hello", { permissionMode: "dontAsk" })).rejects.toThrow("interactive approvals");
    await expect(fixture().provider.send("Hello", { allowedTools: ["Read"] })).rejects.toThrow("allowlist");
    const provider = new AntigravityProvider({ getMcpServers: () => [{ name: "test", command: "node", args: [], env: [] }] });
    await expect(provider.send("Hello")).rejects.toThrow("task-scoped MCP");
  }, 15_000);
  it("reads local context from the private directory without rewriting the user cwd", async () => {
    const { root } = fixture();
    writeFileSync(join(root, "AGENTS.md"), "Local instruction");
    const provider = new AntigravityProvider({ executable: fixtureExecutable, args: [resolve("tests/fixtures/antigravity-cli.mjs")], cwd: root, env: { MULTIREMI_ANTIGRAVITY_CONTEXT_DIR: root, FAKE_AGY_CAPTURE: join(root, "capture.json") } });
    providers.push(provider);
    await provider.send("Hello");
    expect(JSON.parse(readFileSync(join(root, "capture.json"), "utf8")).prompt).toContain("Local instruction");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Local instruction");
  }, 15_000);
  it("filters custom arguments that could replace daemon-owned settings", () => {
    expect(filterAntigravityArgs(["--", "-pX", "--model=other", "--conversation", "other", "--settings", "claude.json", "--print-timeout", "1s", "--agent", "reviewer", "--output-format", "text", "--continue"])).toEqual(["--agent", "reviewer"]);
  }, 15_000);
});
