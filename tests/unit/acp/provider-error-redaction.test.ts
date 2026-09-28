import { describe, expect, it, spyOn } from "bun:test";
import { inspect } from "node:util";
import { AcpProvider, AcpRpcError, AcpSessionFailureError, redactProviderErrorText } from "@acp/index.js";
import { classifyDaemonTaskFailure, TaskFailureReason } from "@multiremi/task-failure.js";

const marker = () => `privacy_${crypto.randomUUID().replaceAll("-", "")}`;
const failure = (title: string, details?: string) => ({
  id: "turn:error", revision: 1, category: "service", severity: "error" as const,
  title, ...(details ? { details } : {}),
});
const formats: Array<[string, (value: string) => string]> = [
  ["encoded API key", (value) => `https://gateway.example/v1?api%5Fkey=${value}`],
  ["encoded access token", (value) => `access%5Ftoken=${value}`],
  ["fully encoded key", (value) => `%61%70%69%5f%6b%65%79=${value}`],
  ["Basic authentication", (value) => `Basic ${value}`],
  ["Authorization scheme", (value) => `Authorization: Custom ${value}`],
  ["JSON Authorization", (value) => JSON.stringify({ Authorization: `Custom ${value}` })],
  ["Cookie header", (value) => `Cookie: preference=dark; session=${value}`],
  ["Set-Cookie header", (value) => `Set-Cookie: sessionid=${value}; HttpOnly; Path=/`],
  ["JSON Cookie", (value) => JSON.stringify({ Cookie: `preference=dark; sid=${value}` })],
  ["session parameter", (value) => `session=${value}`],
  ["sid parameter", (value) => `sid=${value}`],
  ["sessionid parameter", (value) => `sessionid=${value}`],
];

function leaks(value: unknown, secret: string): boolean {
  return [String(value), JSON.stringify(value), Bun.inspect(value), inspect(value)]
    .some((output) => output?.includes(secret));
}

describe("provider error privacy", () => {
  it("redacts typed messages and the stored failure without mutating the bridge payload", () => {
    const secret = marker();
    const original = failure(`unexpected status 503 Bearer ${secret}`, `token=${secret}`);
    const error = new AcpSessionFailureError(original);
    expect(leaks(error, secret)).toBe(false);
    expect(leaks(error.failure, secret)).toBe(false);
    expect(original.title.includes(secret)).toBe(true);
    expect(classifyDaemonTaskFailure("codex", error.message, error.hint))
      .toBe(TaskFailureReason.AgentProviderServerError);
  });

  it("does not expose a raw cause or structured error diagnostics during inspection", () => {
    const secret = marker();
    const error = new AcpSessionFailureError({
      ...failure("unexpected status 503"), codexErrorInfo: { stderr: `Bearer ${secret}` },
    }, new Error(`Authorization: Custom ${secret}`));
    expect(leaks(error, secret)).toBe(false);
    expect(leaks(error.failure, secret)).toBe(false);
  });

  it.each(formats)("redacts %s inside allowed RPC text", (_label, format) => {
    const secret = marker();
    const error = new AcpRpcError(-32603, "Internal error", {
      errorKind: "server_error", details: `unexpected status 503: ${format(secret)}`,
    });
    expect(leaks(error, secret)).toBe(false);
    expect(error.message.includes("503")).toBe(true);
    expect(error.message.includes("server_error")).toBe(true);
  });

  it("preserves diagnostic text including status, request ID, model and URL hostname", () => {
    const text = "unexpected status 503 Service Unavailable; request id: req-512e; model: gpt-6; url: https://gateway.example/v1/responses";
    const error = new AcpSessionFailureError(failure(text));
    expect(error.message).toBe(text);
  });

  it("does not mistake a URL hostname with long labels for a JWT", () => {
    const text = "unexpected status 503; model: gpt-6; request id: req-512e; url: https://gatewayprovider.examplehost.internal/v1/responses";
    expect(redactProviderErrorText(text)).toBe(text);
  });

  it("redacts injected credential values and their URL and Base64 representations", () => {
    const secret = `${marker()}: /+?=`;
    const encoded = encodeURIComponent(secret);
    const variants = [secret, encoded, encoded.replace(/%20/g, "+"),
      encoded.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()),
      Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")];
    for (const value of variants) {
      const result = redactProviderErrorText(`unexpected status 503; upstream detail ${value}`, [secret]);
      expect(result.includes(value)).toBe(false);
      expect(result.includes("503")).toBe(true);
    }
  });

  it("is idempotent and tolerates malformed URL escapes and credential Unicode", () => {
    const text = "unexpected status 503 api%5Fkey=opaque; Cookie: sid=opaque";
    const safe = redactProviderErrorText(text);
    expect(redactProviderErrorText(safe)).toBe(safe);
    expect(redactProviderErrorText("model gpt-6; url: https://gateway.example/?bad%name=value")).toContain("gateway.example");
    const secret = `${marker()}\uD800`;
    expect(redactProviderErrorText(`unexpected status 503 ${secret}`, [secret]).includes(secret)).toBe(false);
  });

  it("keeps structured status hints while redacting typed diagnostics", () => {
    const secret = marker();
    const error = new AcpSessionFailureError({ ...failure("Internal error"), codexErrorInfo: {
      httpConnectionFailed: { httpStatusCode: 404 }, details: `Bearer ${secret}`,
    } });
    expect(leaks(error, secret)).toBe(false);
    expect(classifyDaemonTaskFailure("codex", error.message, error.hint))
      .toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
  });

  it.each(["claude", "codex"])("redacts %s AIR event and response metadata", async (agentType) => {
    const secret = marker();
    const provider = new AcpProvider({ agentType });
    const original = failure(`unexpected status 503 Bearer ${secret}`, `session=${secret}`);
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "s", update: {
          sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: original } } },
        } });
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    const events: unknown[] = [];
    let caught: unknown;
    try { for await (const event of provider.sendStream("Do the work")) events.push(event); }
    catch (error) { caught = error; }
    expect(caught instanceof AcpSessionFailureError).toBe(true);
    expect(leaks(caught, secret)).toBe(false);
    expect(leaks(events, secret)).toBe(false);
    expect(leaks(provider.getLastResponse(), secret)).toBe(false);
  });

  it("redacts native compaction error details and failed tool output", async () => {
    const secret = marker();
    const provider = new AcpProvider({ agentType: "claude" });
    const detail = `Error during compaction: API Error: 503 Bearer ${secret}`;
    const client = {
      typedSessionFailures: true, _options: { onSessionUpdate: (_event: unknown) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "s", update: {
          sessionUpdate: "tool_call_update", toolCallId: "compact:1", status: "failed",
          content: [{ type: "content", content: { type: "text", text: detail } }],
          _meta: { contextCompaction: { version: 1, error: detail } },
        } });
        return { stopReason: "end_turn" };
      },
    };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    const events: unknown[] = [];
    let caught: unknown;
    try { for await (const event of provider.sendStream("/compact")) events.push(event); }
    catch (error) { caught = error; }
    expect(caught instanceof AcpSessionFailureError).toBe(true);
    expect(leaks(caught, secret)).toBe(false);
    expect(leaks(events, secret)).toBe(false);
    expect(leaks(provider.getLastResponse(), secret)).toBe(false);
  });

  it("redacts generic prompt failures before provider logging and rejection", async () => {
    const secret = marker();
    const provider = new AcpProvider({ agentType: "claude" });
    const logs: unknown[] = [];
    const errorLog = spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
    const client = { typedSessionFailures: true, _options: {}, prompt: async () => {
      throw new Error(`unexpected status 503 Bearer ${secret}`);
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    let caught: unknown;
    try { for await (const _event of provider.sendStream("Do the work")) { /* drain */ } }
    catch (error) { caught = error; }
    finally { errorLog.mockRestore(); }
    expect(caught instanceof Error).toBe(true);
    expect(leaks(caught, secret)).toBe(false);
    expect(leaks(logs, secret)).toBe(false);
  });

  it("redacts an opaque injected provider key even without a credential label", async () => {
    const secret = marker();
    const provider = new AcpProvider({ agentType: "claude", env: { ANTHROPIC_AUTH_TOKEN: secret } });
    const logs: unknown[] = [];
    const errorLog = spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
    const client = { typedSessionFailures: true, _options: {}, prompt: async () => {
      throw new AcpRpcError(-32603, "Internal error", { errorKind: "model_not_found", details: `upstream detail ${secret}` });
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s" });
    let caught: unknown;
    try { for await (const _event of provider.sendStream("Do the work")) { /* drain */ } }
    catch (error) { caught = error; }
    finally { errorLog.mockRestore(); }
    expect(caught instanceof AcpRpcError).toBe(true);
    expect(leaks(caught, secret)).toBe(false);
    expect(leaks(logs, secret)).toBe(false);
    const error = caught as AcpRpcError;
    expect(classifyDaemonTaskFailure("claude", error.message, error.data as any))
      .toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
  });
});
