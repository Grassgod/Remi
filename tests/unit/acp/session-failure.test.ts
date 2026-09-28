import { describe, expect, it } from "bun:test";
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
    const result = { protocolVersion: 1, agentCapabilities: { _meta: { jetbrains: { air: { capabilities: ["sessionFailure"] } } } } };
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
});
