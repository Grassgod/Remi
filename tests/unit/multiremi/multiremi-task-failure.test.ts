import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { captureReports } from "../../fixtures/report-session.js";
import {
  classifyDaemonTaskFailure,
  classifyPoisonedError,
  classifyPoisonedOutput,
  classifyResumeUnsafeTimeout,
  classifyTaskFailure,
  TaskFailureReason,
} from "@multiremi/task-failure.js";

let previousFetch: typeof globalThis.fetch | null = null;

afterEach(() => {
  if (previousFetch) {
    globalThis.fetch = previousFetch;
    previousFetch = null;
  }
});

describe("Multiremi task failure classification", () => {
  it("classifies agent and provider failures using the Go Multica taxonomy", () => {
    expect(classifyTaskFailure("API Error: 401 Unauthorized")).toBe(TaskFailureReason.AgentProviderAuthOrAccess);
    expect(classifyTaskFailure("You've hit your org's monthly usage limit")).toBe(TaskFailureReason.AgentProviderQuotaLimit);
    expect(classifyTaskFailure("API Error: 429 rate limit reached")).toBe(TaskFailureReason.AgentProviderCapacityOrRateLimit);
    expect(classifyTaskFailure("got HTTP 503 from provider")).toBe(TaskFailureReason.AgentProviderServerError);
    expect(classifyTaskFailure("dial tcp 1.2.3.4:443: connect: connection refused")).toBe(TaskFailureReason.AgentProviderNetwork);
    expect(classifyTaskFailure("Error: model claude-3-opus-99 not found")).toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
    expect(classifyTaskFailure("claude timed out after 2h0m0s")).toBe(TaskFailureReason.AgentTimeout);
    expect(classifyTaskFailure("executable not found in $PATH")).toBe(TaskFailureReason.AgentRuntimeMissingExecutable);
    expect(classifyTaskFailure("agent exit status 137")).toBe(TaskFailureReason.AgentProcessFailure);
    expect(classifyTaskFailure("Stale provider session: no conversation found")).toBe(TaskFailureReason.AgentStaleSession);
    expect(classifyTaskFailure("the agent gave up for reasons unknown")).toBe(TaskFailureReason.AgentUnknown);
  });

  it("classifies repository sync failures ahead of network and timeout rules", () => {
    expect(classifyTaskFailure("repository sync timed out after 120000ms: git@code.byted.org:ies/sdma-deepwiki.git"))
      .toBe(TaskFailureReason.RepoSyncFailed);
    expect(classifyTaskFailure("repository sync failed: ssh: connect to host code.byted.org port 22: Connection refused"))
      .toBe(TaskFailureReason.RepoSyncFailed);
    expect(classifyTaskFailure("Intake workspace requires a fresh repository snapshot, but git@example.com:a/b.git is cached: fetch timed out after 30000ms"))
      .toBe(TaskFailureReason.RepoSyncFailed);
    expect(classifyTaskFailure("repo not found in cache: git@example.com:a/b.git (workspace: local)"))
      .toBe(TaskFailureReason.RepoSyncFailed);
    // Agent-phase timeouts must keep their original classification.
    expect(classifyTaskFailure("claude timed out after 2h0m0s")).toBe(TaskFailureReason.AgentTimeout);
  });

  it("recognizes an exhausted gateway account pool without guessing at bare 5xx", () => {
    // MUL-336 switches models on this marker, so it must survive the generic
    // 5xx rule that would otherwise swallow "503 … no available accounts".
    expect(classifyTaskFailure("503 from gateway: no available accounts for model gpt-5"))
      .toBe(TaskFailureReason.AgentProviderNoAvailableAccount);
    expect(classifyTaskFailure("{\"error\":{\"message\":\"No available channel for model deepseek-v3\"}}"))
      .toBe(TaskFailureReason.AgentProviderNoAvailableAccount);
    expect(classifyTaskFailure("无可用账号，请稍后重试"))
      .toBe(TaskFailureReason.AgentProviderNoAvailableAccount);
    // An ambiguous 503 carries no account-pool signal and must stay ambiguous
    // rather than be mistaken for a resource exhaustion we can switch away from.
    expect(classifyTaskFailure("got HTTP 503 from provider")).toBe(TaskFailureReason.AgentProviderServerError);
    expect(classifyTaskFailure("503 Service Unavailable")).toBe(TaskFailureReason.AgentProviderServerError);
  });

  it("keeps the 5xx detection bounded like the Go regex", () => {
    expect(classifyTaskFailure("upstream returned 504")).toBe(TaskFailureReason.AgentProviderServerError);
    expect(classifyTaskFailure("1500ms latency observed")).not.toBe(TaskFailureReason.AgentProviderServerError);
    expect(classifyTaskFailure("version 1.5.0 unsupported")).not.toBe(TaskFailureReason.AgentProviderServerError);
  });

  it.each([
    'unexpected status 404 Not Found: Model "deepseek-flash" is not supported by any configured account in this group, url: https://gateway.example/v1/responses, request id: 85faee39-512e-4013-a429-529123456789',
    "There's an issue with the selected model (deepseek-flash). It may not exist or you may not have access to it.",
    '[acp_model_unsupported] codex: cannot select model "deepseek-flash"',
    'Model "deepseek-flash" not supported',
    "Model deepseek-flash is not available",
    "The model is not found",
  ])("recognizes unavailable models ahead of auth and server rules: %s", (error) => {
    expect(classifyTaskFailure(error)).toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
  });

  it.each([
    'invalid_request_error: model gpt-6: image input is not supported',
    '{"error":{"type":"invalid_request_error","message":"model gpt-6: image input is not supported"}}',
    'invalid_request_error: model gpt-6: parameter not available for image input',
    'model gpt-6: image input is not supported',
  ])("keeps input-shape errors out of model fallback: %s", (error) => {
    expect(classifyTaskFailure(error)).toBe(TaskFailureReason.ApiInvalidRequest);
    expect(classifyDaemonTaskFailure("codex", error)).toBe(TaskFailureReason.ApiInvalidRequest);
  });

  describe.each(["generic", "codex", "claude"])("invalid-request wrapper precedence (%s)", (provider) => {
    it.each([
      ['unexpected status 401: {"type":"invalid_request_error","code":"invalid_api_key"}', TaskFailureReason.AgentProviderAuthOrAccess],
      ["API Error: 403 invalid_request_error", TaskFailureReason.AgentProviderAuthOrAccess],
      ["unexpected status 429 invalid_request_error", TaskFailureReason.AgentProviderCapacityOrRateLimit],
      ["unexpected status 502 invalid_request_error", TaskFailureReason.AgentProviderServerError],
      ["Your credit balance is too low (invalid_request_error)", TaskFailureReason.AgentProviderQuotaLimit],
      ["API Error: 400 invalid_request_error: model gpt-6: image input is not supported", TaskFailureReason.ApiInvalidRequest],
      ["invalid_request_error: model gpt-6: image input is not supported", TaskFailureReason.ApiInvalidRequest],
      ["unexpected status 402 invalid_request_error", TaskFailureReason.AgentProviderQuotaLimit],
      ["unexpected status 404 invalid_request_error", TaskFailureReason.AgentModelNotFoundOrUnavailable],
      ["unexpected status 529 invalid_request_error", TaskFailureReason.AgentProviderCapacityOrRateLimit],
      ["invalid_request_error: invalid api key", TaskFailureReason.AgentProviderAuthOrAccess],
      ["invalid_request_error: no available accounts", TaskFailureReason.AgentProviderNoAvailableAccount],
      ["invalid_request_error: rate limit reached", TaskFailureReason.AgentProviderCapacityOrRateLimit],
      ["invalid_request_error: service unavailable", TaskFailureReason.AgentProviderServerError],
      ["invalid_request_error: stream disconnected", TaskFailureReason.AgentProviderNetwork],
      ["API Error: 400, upstream HTTP 401: invalid_request_error", TaskFailureReason.AgentProviderAuthOrAccess],
      ["API Error: 400, upstream HTTP 502: image input not supported", TaskFailureReason.AgentProviderServerError],
      ["API Error: 409 invalid_request_error", TaskFailureReason.AgentUnknown],
      ["invalid_request_error: request id: 502", TaskFailureReason.ApiInvalidRequest],
      ["audio input not supported", TaskFailureReason.ApiInvalidRequest],
      ["API Error: 400 invalid_request_error: context_length_exceeded", TaskFailureReason.AgentContextOverflow],
      ["API Error: 400 invalid_request_error: context window unavailable", TaskFailureReason.ApiInvalidRequest],
    ])("classifies %s", (error, reason) => {
      expect(provider === "generic" ? classifyTaskFailure(error) : classifyDaemonTaskFailure(provider, error)).toBe(reason);
      expect(classifyPoisonedError(error)).toBe(reason === TaskFailureReason.ApiInvalidRequest ? reason : null);
    });
  });

  it.each(["401", "402", "403", "429", "529", "512"])("does not read HTTP %s from request identifiers", (code) => {
    expect(classifyTaskFailure(`request failed, request id: 0b3f-${code}e-abcd`)).toBe(TaskFailureReason.AgentUnknown);
    expect(classifyTaskFailure(`request failed a${code}b`)).toBe(TaskFailureReason.AgentUnknown);
    expect(classifyTaskFailure(`request failed, request id: ${code}`)).toBe(TaskFailureReason.AgentUnknown);
  });

  it.each([
    ["API Error: 401 Unauthorized", TaskFailureReason.AgentProviderAuthOrAccess],
    ["HTTP 403", TaskFailureReason.AgentProviderAuthOrAccess],
    ["status: 402", TaskFailureReason.AgentProviderQuotaLimit],
    ["HTTP 429", TaskFailureReason.AgentProviderCapacityOrRateLimit],
    ["unexpected status 529", TaskFailureReason.AgentProviderCapacityOrRateLimit],
    ["unexpected status 503", TaskFailureReason.AgentProviderServerError],
    ['{"status":500}', TaskFailureReason.AgentProviderServerError],
  ])("retains standalone HTTP status detection: %s", (error, reason) => {
    expect(classifyTaskFailure(error)).toBe(reason);
  });

  it("uses bridge failure hints before opaque RPC text", () => {
    expect(classifyDaemonTaskFailure("claude", "RPC error -32603: Internal error", { errorKind: "model_not_found" }))
      .toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
    expect(classifyDaemonTaskFailure("codex", "Internal error", { category: "quota" }))
      .toBe(TaskFailureReason.AgentProviderQuotaLimit);
    expect(classifyDaemonTaskFailure("claude", "Internal error", { errorKind: "rate_limit" }))
      .toBe(TaskFailureReason.AgentProviderCapacityOrRateLimit);
    expect(classifyDaemonTaskFailure("codex", "Internal error", { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } } }))
      .toBe(TaskFailureReason.AgentModelNotFoundOrUnavailable);
    expect(classifyDaemonTaskFailure("claude", "Compacting failed: unexpected status 503"))
      .toBe(TaskFailureReason.AgentProviderServerError);
  });

  it("classifies poisoned output, invalid requests, and Codex resume-unsafe timeouts", () => {
    expect(classifyPoisonedOutput("I reached the iteration limit and could not continue.")).toBe(TaskFailureReason.IterationLimit);
    expect(classifyPoisonedOutput("Put your final update inside the content string. Keep it concise.")).toBe(TaskFailureReason.AgentFallbackMessage);
    expect(classifyPoisonedOutput("Compacting...")).toBe(TaskFailureReason.AgentFallbackMessage);
    expect(classifyPoisonedOutput("\n\nCompacting completed.")).toBe(TaskFailureReason.AgentFallbackMessage);
    expect(classifyPoisonedOutput("Compacting...\n\nCompacting failed: context window unavailable"))
      .toBe(TaskFailureReason.AgentFallbackMessage);
    // codex-acp's `thread/compacted` banner — same failure mode, different bridge.
    expect(classifyPoisonedOutput("*Context compacted to fit the model's context window.*\n\n"))
      .toBe(TaskFailureReason.AgentFallbackMessage);
    expect(classifyPoisonedOutput("The final answer mentions Compacting... as diagnostic context.")).toBeNull();
    expect(classifyPoisonedOutput("Note: *Context compacted to fit the model's context window.* happened mid-run, but the fix landed."))
      .toBeNull();
    expect(classifyPoisonedOutput("Fixed the bug and added tests.")).toBeNull();
    expect(classifyPoisonedOutput("Fixed it. ".repeat(60) + "I reached the iteration limit earlier.")).toBeNull();

    expect(classifyPoisonedError(`API Error: 400 {"error":{"type":"invalid_request_error"}}`)).toBe(TaskFailureReason.ApiInvalidRequest);
    expect(classifyPoisonedError(`API Error: 429 {"error":{"type":"rate_limit_error"}}`)).toBeNull();

    expect(classifyResumeUnsafeTimeout("codex", "codex semantic inactivity timeout after 10m0s without agent progress")).toBe(TaskFailureReason.CodexSemanticInactivity);
    expect(classifyResumeUnsafeTimeout("codex", "codex app-server no progress timeout after 30s")).toBe(TaskFailureReason.CodexSemanticInactivity);
    expect(classifyResumeUnsafeTimeout("claude", "codex semantic inactivity timeout after 10m0s")).toBeNull();
  });

  it("prefers poisoned and resume-unsafe reasons before generic agent classification", () => {
    expect(classifyDaemonTaskFailure("claude", `API Error: 400 {"error":{"type":"invalid_request_error"}}`)).toBe(TaskFailureReason.ApiInvalidRequest);
    expect(classifyDaemonTaskFailure("codex", "codex semantic inactivity timeout after 10m0s without agent progress")).toBe(TaskFailureReason.CodexSemanticInactivity);
    expect(classifyDaemonTaskFailure("codex", "API Error: 401 Unauthorized")).toBe(TaskFailureReason.AgentProviderAuthOrAccess);
  });

  it("sends explicit failure_reason from the daemon client", async () => {
    const requests: string[] = [];
    previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const client = new MultiremiDaemonClient("https://remi.example", "tok_123");
    const calls = captureReports(client);
    await client.failTask("task_1", "API Error: 401 Unauthorized", "sess_1", "/tmp/work", TaskFailureReason.AgentProviderAuthOrAccess);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: "task.fail", partition: "task_1" });
    expect(calls[0]?.payload).toMatchObject({
      error: "API Error: 401 Unauthorized",
      session_id: "sess_1",
      work_dir: "/tmp/work",
      failure_reason: TaskFailureReason.AgentProviderAuthOrAccess,
    });
    expect(requests).toEqual([]);
  });
});
