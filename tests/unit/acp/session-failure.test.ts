import { describe, expect, it, spyOn } from "bun:test";
import { AcpClient, AcpProvider, AcpRpcError, AcpSessionFailureError } from "@acp/index.js";
import { classifyDaemonTaskFailure, TaskFailureReason } from "@multiremi/task-failure.js";

const failure = { id: "turn:error", revision: 1, category: "service", severity: "error", title: "unexpected status 503" };
const meta = (value: unknown) => ({ jetbrains: { air: { sessionFailure: value } } });

async function drain(provider: AcpProvider) {
  for await (const _event of provider.sendStream("Do the work")) { /* drain */ }
}

describe("ACP typed session failure", () => {
  it.each(["claude", "codex"])("fails %s turns that resolve end_turn with an error notification", async (agentType) => {
    const provider = new AcpProvider({ agentType });
    let turn = 0;
    const client = {
      typedSessionFailures: true,
      _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        if (turn++ === 0) client._options.onSessionUpdate({ sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: meta(failure) } });
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    await expect(drain(provider)).rejects.toBeInstanceOf(AcpSessionFailureError);
    expect(provider.typedSessionFailures).toBe(true);
    expect(provider.getLastResponse()?.metadata?.sessionFailure).toEqual(failure);
    // Failure state is per prompt, even when the same ACP session is reused.
    await drain(provider);
    expect(provider.getLastResponse()?.metadata?.sessionFailure).toBeUndefined();
  });

  it("consumes failures carried only by the prompt result", async () => {
    const provider = new AcpProvider({ agentType: "codex" });
    const client = { typedSessionFailures: true, _options: {}, prompt: async () => ({ stopReason: "end_turn", _meta: meta(failure) }) };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    await expect(drain(provider)).rejects.toThrow("unexpected status 503");
  });

  it("does not turn retry warnings or unrelated session notifications into failure", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "other", update: { sessionUpdate: "session_info_update", _meta: meta(failure) } });
        client._options.onSessionUpdate({ sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: meta({ ...failure, severity: "warning" }) } });
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    await drain(provider);
    expect(provider.getLastResponse()?.metadata?.sessionFailure).toMatchObject({ severity: "warning" });
  });

  it("keeps Claude RPC errorKind when the AIR category is coarser than the failure reason", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: meta({ ...failure, category: "request", title: "Internal error" }) } });
        throw new AcpRpcError(-32603, "Internal error", { errorKind: "model_not_found" });
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    let error: AcpSessionFailureError | null = null;
    try { await drain(provider); } catch (caught) { error = caught as AcpSessionFailureError; }
    expect(error).toBeInstanceOf(AcpSessionFailureError);
    expect(classifyDaemonTaskFailure("claude", error!.message, error!.hint))
      .toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
  });

  it("records negotiated support and preserves bounded RPC details plus structured data", async () => {
    const client = new AcpClient({ agentType: "codex" });
    const result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } } };
    (client as any)._initializeResult = result;
    expect(client.typedSessionFailures).toBe(false);
    (client as any)._request = async () => result;
    await client.initialize();
    expect(client.typedSessionFailures).toBe(true);
    const data = { errorKind: "model_not_found", details: "x".repeat(800) };
    const rejected = new Promise<never>((_resolve, reject) => (client as any)._pending.set(17, { reject }));
    (client as any)._handleResponse({ id: 17, error: { code: -32603, message: "Internal error", data } });
    try {
      await rejected;
      throw new Error("Expected RPC rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AcpRpcError);
      expect((error as AcpRpcError).data).toBe(data);
      expect((error as Error).message).toContain('"errorKind":"model_not_found"');
      expect((error as Error).message.length).toBeLessThanOrEqual(534);
    }
  });

  it.each(["claude", "codex"])("negotiates %s support from InitializeResult metadata", async (agentType) => {
    const client = new AcpClient({ agentType });
    (client as any)._request = async () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
    });
    await client.initialize();
    expect(client.typedSessionFailures).toBe(true);
  });

  it("uses nested metadata only as a compatibility fallback", async () => {
    const client = new AcpClient({ agentType: "codex" });
    (client as any)._request = async () => ({
      protocolVersion: 1,
      agentCapabilities: { _meta: { jetbrains: { air: { capabilities: ["sessionFailure"] } } } },
    });
    await client.initialize();
    expect(client.typedSessionFailures).toBe(true);
    (client as any)._initializeResult._meta = { jetbrains: { air: { capabilities: [] } } };
    expect(client.typedSessionFailures).toBe(false);
  });

  it.each(["negotiated", "legacy"])("fails native Claude compaction independently of negotiation (%s)", async (negotiation) => {
    const provider = new AcpProvider({ agentType: "claude" });
    let turn = 0;
    const client = {
      typedSessionFailures: negotiation === "negotiated",
      _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        const update = (value: unknown) => client._options.onSessionUpdate({ sessionId: "s", update: value });
        if (turn++ === 1) {
          update({ sessionUpdate: "tool_call_update", toolCallId: "compact:1", status: "failed",
            _meta: { contextCompaction: { version: 1, error: "Error during compaction: API Error: 503 Service Unavailable" }, claudeCode: { toolName: "compact" } } });
        } else {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Completed earlier work" } });
        }
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    await drain(provider);
    let error: AcpSessionFailureError | null = null;
    try { await drain(provider); } catch (caught) { error = caught as AcpSessionFailureError; }
    expect(error).toBeInstanceOf(AcpSessionFailureError);
    expect(error!.failure.details).toBe("Error during compaction: API Error: 503 Service Unavailable");
    expect(classifyDaemonTaskFailure("claude", error!.message, error!.hint)).toBe(TaskFailureReason.AgentProviderServerError);
    await drain(provider);
    expect(provider.getLastResponse()?.metadata?.sessionFailure).toBeUndefined();
  });

  it.each(["before", "after"])("only assistant output after compaction failure recovers the turn (%s)", async (order) => {
    const provider = new AcpProvider({ agentType: "claude" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        const update = (value: unknown) => client._options.onSessionUpdate({ sessionId: "s", update: value });
        const text = () => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Work completed" } });
        if (order === "before") text();
        update({ sessionUpdate: "tool_call_update", toolCallId: "compact:2", status: "failed",
          _meta: { contextCompaction: { version: 1, error: "Model missing-model not supported" } } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Compacting..." } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about recovery" } });
        if (order === "after") text();
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    try {
      if (order === "before") {
        await expect(drain(provider)).rejects.toThrow("Model missing-model not supported");
        expect(warn).not.toHaveBeenCalled();
      } else {
        await drain(provider);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(provider.getLastResponse()?.metadata?.sessionFailure).toBeUndefined();
      }
    } finally { warn.mockRestore(); }
  });

  it("does not confuse ordinary failed tools with compaction or clear AIR errors on recovery text", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    let turn = 0;
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        const update = (value: unknown) => client._options.onSessionUpdate({ sessionId: "s", update: value });
        update({ sessionUpdate: "tool_call_update", toolCallId: "ordinary", status: "failed", _meta: { claudeCode: { toolName: "Bash" } } });
        client._options.onSessionUpdate({ sessionId: "other", update: { sessionUpdate: "tool_call_update", status: "failed", _meta: { contextCompaction: { error: "API Error: 503" } } } });
        if (turn++ > 0) update({ sessionUpdate: "session_info_update", _meta: meta(failure) });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Normal text" } });
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    await drain(provider);
    await expect(drain(provider)).rejects.toThrow("unexpected status 503");
  });

  it("appends only whitelisted RPC fields and redacts credentials before truncation", () => {
    const secret = "synthetic-credential-value";
    const error = new AcpRpcError(-32603, `Internal error Bearer ${secret}`, {
      errorKind: "model_not_found",
      message: `Authorization: Bearer ${secret}; key=${secret}&token=${secret}`,
      details: `sk-${secret} ${"x".repeat(440)} token=${secret}`,
      baseUrl: "https://unsafe.example/private", stderr: "UNSAFE_STDERR", headers: { Authorization: secret },
    });
    expect(error.message).toContain('"errorKind":"model_not_found"');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("unsafe.example");
    expect(error.message).not.toContain("UNSAFE_STDERR");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("unsafe.example");
    const stringError = new AcpRpcError(-32603, "Internal error", `API Error: 503 token=${secret}`);
    expect(stringError.message).toContain("503");
    expect(stringError.message).not.toContain(secret);
    const nestedError = new AcpRpcError(-32603, "Internal error", { details: { headers: { Authorization: secret } } });
    expect(nestedError.message).not.toContain(secret);
  });

  it("keeps useful whitelisted details without copying other RPC fields", () => {
    const error = new AcpRpcError(-32603, "Internal error", {
      errorKind: "server_error", message: "Compaction failed", details: "API Error: 503 Service Unavailable",
      baseUrl: "https://unsafe.example", stderr: "discard this stderr",
    });
    expect(error.message).toContain("server_error");
    expect(error.message).toContain("Compaction failed");
    expect(error.message).toContain("503 Service Unavailable");
    expect(error.message).not.toContain("unsafe.example");
    expect(error.message).not.toContain("discard this stderr");
  });

  it.each([
    'key="fixture credential"', "token='fixture credential'", '"api_key":"fixture credential"',
    "password=fixturecredential", "https://user:fixturecredential@example.test/api",
    "ghp_fixturecredential", "fixturexx.fixtureyy.fixturenonce",
  ])("redacts credential formats inside whitelisted RPC details: %s", (detail) => {
    const error = new AcpRpcError(-32603, "Internal error", { details: detail });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("fixture");
  });
});
