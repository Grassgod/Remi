import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiDaemonClient } from "../../../src/multiremi/client.js";
import {
  classifyDaemonTaskFailure,
  classifyPoisonedError,
  classifyPoisonedOutput,
  classifyResumeUnsafeTimeout,
  classifyTaskFailure,
  TaskFailureReason,
} from "../../../src/multiremi/task-failure.js";

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
    expect(classifyTaskFailure("the agent gave up for reasons unknown")).toBe(TaskFailureReason.AgentUnknown);
  });

  it("keeps 5xx detection bounded like the Go regex", () => {
    expect(classifyTaskFailure("upstream returned 504")).toBe(TaskFailureReason.AgentProviderServerError);
    expect(classifyTaskFailure("1500ms latency observed")).not.toBe(TaskFailureReason.AgentProviderServerError);
    expect(classifyTaskFailure("version 1.5.0 unsupported")).not.toBe(TaskFailureReason.AgentProviderServerError);
  });

  it("classifies poisoned output, invalid requests, and Codex resume-unsafe timeouts", () => {
    expect(classifyPoisonedOutput("I reached the iteration limit and could not continue.")).toBe(TaskFailureReason.IterationLimit);
    expect(classifyPoisonedOutput("Put your final update inside the content string. Keep it concise.")).toBe(TaskFailureReason.AgentFallbackMessage);
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
    const calls: Array<{ url: string; body: any; headers: HeadersInit | undefined }> = [];
    previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: init?.headers,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const client = new MultiremiDaemonClient("https://remi.example", "tok_123");
    await client.failTask("task_1", "API Error: 401 Unauthorized", "sess_1", "/tmp/work", TaskFailureReason.AgentProviderAuthOrAccess);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://remi.example/api/daemon/tasks/task_1/fail");
    expect(calls[0]?.body).toMatchObject({
      error: "API Error: 401 Unauthorized",
      session_id: "sess_1",
      work_dir: "/tmp/work",
      failure_reason: TaskFailureReason.AgentProviderAuthOrAccess,
    });
    expect((calls[0]?.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
  });
});
