import { describe, expect, it, spyOn } from "bun:test";
import { inspect } from "node:util";
import { AcpProvider, AcpRpcError, AcpSessionFailureError, redactProviderErrorText } from "@acp/index.js";
import { classifyDaemonTaskFailure, classifyTaskFailure, TaskFailureReason } from "@multiremi/task-failure.js";

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

  const sensitiveFields = [
    "x-api%5Fkey", "x%2Dapi%2Dkey", "x-access%5Ftoken", "refresh_token",
    "id_token", "client_secret", "clientSecret", "openai_api_key", "private_key",
    "x_api_key", "session_id", "passwd", "api%255Fkey", "APIKEY", "X-Api-Key",
    "x-goog-api-key", "privatePassphrase", "serviceCredentials", "gatewayAuth",
    "providerAuthorization", "browserCookie", "api%25255Fkey",
  ];
  const fieldFormats: Array<[string, (name: string, value: string) => string]> = [
    ["query", (name, value) => `https://invalid.local/?ok=1&${name}=${value}&request_id=req-1234`],
    ["JSON", (name, value) => JSON.stringify({ [name]: value, model: "gpt-6" })],
    ["header", (name, value) => `${name}: ${value}`],
    ["single quotes", (name, value) => `'${name}'='${value}'`],
    ["object", (name, value) => JSON.stringify({ [name]: { inner: value }, model: "gpt-6" })],
    ["array", (name, value) => JSON.stringify({ [name]: [{ inner: value }], model: "gpt-6" })],
  ];
  const fieldCases = sensitiveFields.flatMap((name) => fieldFormats.map(([label, format]) =>
    [name, label, format] as const));
  for (const path of ["direct", "RPC"] as const) {
    for (const [name, label, format] of fieldCases) {
      it(`redacts field ${name} in ${label} through ${path}`, () => {
        const secret = marker();
        const text = `unexpected status 503, ${format(name, secret)}`;
        const result = path === "direct" ? redactProviderErrorText(text)
          : new AcpRpcError(-32603, "Internal error", { errorKind: "server_error", details: text }).message;
        expect(result.includes(secret)).toBe(false);
        expect(result.includes("503")).toBe(true);
        expect(result.includes(name)).toBe(true);
      });
    }

    it(`redacts sensitive fields inside non-sensitive diagnostic containers through ${path}`, () => {
      const secret = marker();
      const text = JSON.stringify({ error: {
        type: "api_error", message: `unexpected status 503, https://invalid.local/?x-api%5Fkey=${secret}`,
        code: "invalid_api_key",
      }, model: "gpt-6", request_id: "req-1234" });
      const result = path === "direct" ? redactProviderErrorText(text)
        : new AcpRpcError(-32603, "Internal error", { details: text }).message;
      expect(result.includes(secret)).toBe(false);
      expect(result.includes("invalid_api_key")).toBe(true);
      expect(result.includes("req-1234")).toBe(true);
    });
  }

  it("preserves non-sensitive field values, status text and URL ports byte-for-byte", () => {
    const texts = [
      ...[401, 404, 429, 503].map((status) => `unexpected status ${status} from gateway, request id: req-1234, model: gpt-6`),
      JSON.stringify({ code: "invalid_api_key", type: "model_not_found", max_tokens: 4096,
        input_tokens: 128, request_id: "req-1234", model: "gpt-6" }),
      "https://host:8443/v1/responses?request_id=req-1234&model=gpt-6",
      "monkey=banana", "line 404:",
    ];
    for (const text of texts) {
      expect(redactProviderErrorText(text) === text).toBe(true);
      expect(new AcpRpcError(-32603, "Internal error", { details: text }).message.includes(JSON.stringify(text))).toBe(true);
    }
  });

  const classifiedFields = [
    [401, "invalid_request_error", "invalid_api_key", "Unauthorized", TaskFailureReason.AgentProviderAuthOrAccess],
    [404, "invalid_request_error", "model_not_found", "Model gpt-6 is not supported", TaskFailureReason.AgentModelNotFoundOrUnavailable],
    [429, "invalid_request_error", "too_many_requests", "Too Many Requests", TaskFailureReason.AgentProviderCapacityOrRateLimit],
    [503, "invalid_request_error", "server_error", "Service Unavailable", TaskFailureReason.AgentProviderServerError],
    [400, "invalid_request_error", "invalid_request", "model gpt-6: image input is not supported", TaskFailureReason.ApiInvalidRequest],
  ] as const;
  for (const entry of ["generic", "codex", "claude"] as const) {
    for (const [status, type, code, message, reason] of classifiedFields) {
      it(`preserves wrapped HTTP ${status} classification through ${entry}`, () => {
        const secret = marker();
        const text = `unexpected status ${status} from gateway: ${JSON.stringify({ error: {
          type, code, message: `${message}; https://invalid.local/?x-api%5Fkey=${secret}`,
          clientSecret: secret,
        }, max_tokens: 4096, input_tokens: 128, request_id: "req-1234", model: "gpt-6" })}`;
        const classify = entry === "generic" ? classifyTaskFailure : (value: string) => classifyDaemonTaskFailure(entry, value);
        expect(classify(text)).toBe(reason);
        for (const safe of [redactProviderErrorText(text), new AcpRpcError(-32603, "Gateway error", { details: text }).message]) {
          expect(safe.includes(secret)).toBe(false);
          expect(classify(safe)).toBe(classify(text));
        }
      });
    }
  }

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

  const shortCredentialStatuses = [
    [401, TaskFailureReason.AgentProviderAuthOrAccess],
    [404, TaskFailureReason.AgentModelNotFoundOrUnavailable],
    [429, TaskFailureReason.AgentProviderCapacityOrRateLimit],
    [503, TaskFailureReason.AgentProviderServerError],
  ] as const;
  for (const entry of ["text", "generic", "codex", "claude"] as const) {
    it.each(shortCredentialStatuses)(`preserves HTTP %s with short credentials through ${entry}`, (status, reason) => {
      const text = `unexpected status ${status} from gateway, request id: req-1234, model: model-true`;
      const safe = redactProviderErrorText(text, ["1", "true", "503", "404", "429", "   true   "]);
      if (entry === "text") {
        expect(safe === text).toBe(true);
      } else {
        const classify = entry === "generic" ? classifyTaskFailure : (value: string) => classifyDaemonTaskFailure(entry, value);
        expect(classify(text)).toBe(reason);
        expect(classify(safe)).toBe(classify(text));
      }
    });
  }

  it("skips every exact representation when the trimmed credential has fewer than eight characters", () => {
    const short = "short+?";
    const padded = `   ${short}   `;
    for (const value of [short, padded, encodeURIComponent(short), encodeURIComponent(padded),
      Buffer.from(short).toString("base64"), Buffer.from(short).toString("base64url"),
      Buffer.from(padded).toString("base64"), Buffer.from(padded).toString("base64url")]) {
      const text = `upstream detail ${value}`;
      expect(redactProviderErrorText(text, [padded]) === text).toBe(true);
    }
  });

  it("still redacts an eight-character credential and its exact representations", () => {
    const secret = `${marker().slice(-7)}+`;
    for (const value of [secret, encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")]) {
      const result = redactProviderErrorText(`upstream detail ${value}`, [`   ${secret}   `]);
      expect(result.includes(value)).toBe(false);
    }
  });

  it("keeps pattern-based redaction for short values and encoded or hyphenated field names", () => {
    const value = marker().slice(-1);
    for (const prefix of ["Bearer ", "Basic ", "api%5Fkey=", "x-api_key="]) {
      expect(redactProviderErrorText(`${prefix}${value}`).endsWith("[REDACTED]")).toBe(true);
    }
  });

  it.each([
    ["alphanumeric", () => "abc123".repeat(33_334).slice(0, 200_000)],
    ["hyphenated", () => "ab-".repeat(66_667).slice(0, 200_000)],
    ["percent-encoded", () => "%41".repeat(66_667).slice(0, 200_000)],
  ] as const)("redacts a 200k %s run within the synchronous time budget", (_label, makeText) => {
    const text = makeText();
    const startedAt = performance.now();
    const result = redactProviderErrorText(text);
    const elapsedMs = performance.now() - startedAt;
    expect(result === text).toBe(true);
    expect(elapsedMs).toBeLessThan(500);
  });

  it.each([
    ["dotted run", () => "ab.".repeat(66_667).slice(0, 200_000)],
    ["non-sensitive key", () => "keyx".repeat(50_000) + "="],
    ["encoded key", () => "%41".repeat(66_667).slice(0, 200_000) + ":"],
    ["quoted fields", () => '"a":"'.repeat(40_000)],
    ["encoded sensitive fields", () => "x_api%5Fkey= ".repeat(16_667).slice(0, 200_000)],
    ["unclosed objects", () => "a:{".repeat(66_667).slice(0, 200_000)],
    ["unclosed arrays", () => "a:[".repeat(66_667).slice(0, 200_000)],
    ["uppercase key", () => "A".repeat(200_000) + "="],
  ] as const)("scans 200k %s within the synchronous time budget", (_label, makeText) => {
    const startedAt = performance.now();
    redactProviderErrorText(makeText());
    expect(performance.now() - startedAt).toBeLessThan(500);
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
