import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSummaryPrompt,
  digestTaskMessage,
  parseSummaryText,
  PROGRESS_SUMMARY_DEFAULTS,
  readCodexAuthApiKey,
  resolveProgressSummaryConfig,
  resolveSummarizerCredentials,
  resolveTaskProgressSummaryConfig,
  TaskProgressSummarizer,
  TaskProgressTracker,
  type ProgressSummaryConfig,
  type ProgressSummaryResult,
  type SummaryCliSpawn,
} from "@multiremi/worker/progress-summarizer.js";
import type { TaskMessageInput } from "@multiremi/contracts/types.js";

function textMessage(content = "working on it"): TaskMessageInput {
  return { type: "text", content };
}

const CREDENTIALS = { baseUrl: "https://relay.example", authToken: "tok" };

function config(overrides: Partial<ProgressSummaryConfig> = {}): ProgressSummaryConfig {
  return {
    enabled: true,
    minNewMessages: 3,
    minIntervalMs: 1000,
    model: "test-model",
    maxDigestChars: 12_000,
    requestTimeoutMs: 5000,
    transport: "api",
    openAi: null,
    ...overrides,
  };
}

function byteStream(text = ""): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function successfulCliSpawn(
  summary: string,
  onSpawn?: (command: string[], options: Parameters<SummaryCliSpawn>[1]) => void,
): SummaryCliSpawn {
  return (command, options) => {
    onSpawn?.(command, options);
    return {
      stdout: byteStream(JSON.stringify({ summary })),
      stderr: byteStream(),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };
}

function modelResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function summaryResponse(summary: string, extra: Record<string, unknown> = {}): Response {
  return modelResponse({ content: [{ type: "text", text: JSON.stringify({ summary, ...extra }) }] });
}

describe("resolveProgressSummaryConfig", () => {
  it("uses documented defaults", () => {
    const resolved = resolveProgressSummaryConfig({});
    expect(resolved.enabled).toBe(true);
    expect(resolved.minNewMessages).toBe(PROGRESS_SUMMARY_DEFAULTS.minNewMessages);
    expect(resolved.minIntervalMs).toBe(PROGRESS_SUMMARY_DEFAULTS.minIntervalMs);
    expect(resolved.model).toBe(PROGRESS_SUMMARY_DEFAULTS.model);
    expect(resolved.transport).toBe("auto");
    expect(resolved.openAi).toBeNull();
  });

  it("honors N/T/model/disable overrides", () => {
    const resolved = resolveProgressSummaryConfig({
      MULTIREMI_PROGRESS_SUMMARY_DISABLED: "1",
      MULTIREMI_PROGRESS_SUMMARY_MESSAGES: "5",
      MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS: "9000",
      MULTIREMI_PROGRESS_SUMMARY_MODEL: "claude-x",
      MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "openai",
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL: "https://openai.example/v1/",
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL: "gpt-luna",
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY: "openai-key",
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.minNewMessages).toBe(5);
    expect(resolved.minIntervalMs).toBe(9000);
    expect(resolved.model).toBe("claude-x");
    expect(resolved.transport).toBe("openai");
    expect(resolved.openAi).toEqual({
      baseUrl: "https://openai.example/v1",
      model: "gpt-luna",
      apiKey: "openai-key",
    });
  });

  it("falls back to defaults on invalid numbers", () => {
    const resolved = resolveProgressSummaryConfig({
      MULTIREMI_PROGRESS_SUMMARY_MESSAGES: "not-a-number",
      MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS: "-5",
      MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "other",
    });
    expect(resolved.minNewMessages).toBe(PROGRESS_SUMMARY_DEFAULTS.minNewMessages);
    expect(resolved.minIntervalMs).toBe(PROGRESS_SUMMARY_DEFAULTS.minIntervalMs);
    expect(resolved.transport).toBe("auto");
  });

  it("treats an empty OpenAI key as unavailable", () => {
    const resolved = resolveProgressSummaryConfig({
      MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "openai",
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_BASE_URL: "https://openai.example",
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_MODEL: "gpt-luna",
      MULTIREMI_PROGRESS_SUMMARY_OPENAI_API_KEY: "  ",
    });
    expect(resolved.transport).toBe("openai");
    expect(resolved.openAi).toBeNull();
  });

  it("builds the zero-config OpenAI defaults from provider and process env", () => {
    const resolved = resolveProgressSummaryConfig(
      { OPENAI_API_KEY: "environment-key" },
      { providerEnv: { ANTHROPIC_BASE_URL: "https://relay.example/" } },
    );
    expect(resolved.transport).toBe("auto");
    expect(resolved.openAi).toEqual({
      baseUrl: "https://relay.example",
      model: "gpt-5.6-luna",
      apiKey: "environment-key",
    });
  });

  it("falls back to $HOME/.codex/auth.json when no OpenAI env key exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "multiremi-progress-home-"));
    try {
      await mkdir(join(home, ".codex"));
      await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "auth-file-key" }));
      expect(await readCodexAuthApiKey({ HOME: home })).toBe("auth-file-key");
      const resolved = await resolveTaskProgressSummaryConfig(
        { ANTHROPIC_BASE_URL: "https://relay.example/v1" },
        { HOME: home },
      );
      expect(resolved.openAi).toEqual({
        baseUrl: "https://relay.example/v1",
        model: "gpt-5.6-luna",
        apiKey: "auth-file-key",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ignores a missing or invalid Codex auth file", async () => {
    const home = await mkdtemp(join(tmpdir(), "multiremi-progress-empty-home-"));
    try {
      expect(await readCodexAuthApiKey({ HOME: home })).toBeNull();
      await mkdir(join(home, ".codex"));
      await writeFile(join(home, ".codex", "auth.json"), "not-json");
      const resolved = await resolveTaskProgressSummaryConfig(
        { ANTHROPIC_BASE_URL: "https://relay.example" },
        { HOME: home },
      );
      expect(resolved.openAi).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not read Codex auth for an explicit non-OpenAI transport", async () => {
    let authReads = 0;
    const resolved = await resolveTaskProgressSummaryConfig(
      { ANTHROPIC_BASE_URL: "https://relay.example" },
      { MULTIREMI_PROGRESS_SUMMARY_TRANSPORT: "api", HOME: "/unused" },
      async () => {
        authReads++;
        return "unexpected-key";
      },
    );
    expect(resolved.transport).toBe("api");
    expect(resolved.openAi).toBeNull();
    expect(authReads).toBe(0);
  });
});

describe("resolveSummarizerCredentials", () => {
  it("prefers the task's provider env and its base URL", () => {
    const credentials = resolveSummarizerCredentials(
      { ANTHROPIC_AUTH_TOKEN: "relay-token", ANTHROPIC_BASE_URL: "https://relay.example/" },
      { ANTHROPIC_API_KEY: "machine-key" },
    );
    expect(credentials).toEqual({ baseUrl: "https://relay.example", apiKey: undefined, authToken: "relay-token" });
  });

  it("skips tombstoned empty provider env values and falls back to the process env", () => {
    const credentials = resolveSummarizerCredentials(
      { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" },
      { ANTHROPIC_API_KEY: "machine-key" },
    );
    expect(credentials).toEqual({ baseUrl: "https://api.anthropic.com", apiKey: "machine-key", authToken: undefined });
  });

  it("returns null when no credential exists anywhere", () => {
    expect(resolveSummarizerCredentials({ OPENAI_API_KEY: "sk" }, {})).toBeNull();
  });
});

describe("digestTaskMessage", () => {
  it("compresses tool calls to name plus key input", () => {
    const line = digestTaskMessage({ type: "tool_use", tool: "Bash", input: { command: "bun test" } });
    expect(line).toBe('tool Bash {"command":"bun test"}');
  });

  it("keeps failed tool results but drops successful ones and usage", () => {
    expect(digestTaskMessage({ type: "tool_result", tool: "Bash", status: "failed", output: "boom" })).toContain("failed");
    expect(digestTaskMessage({ type: "tool_result", tool: "Bash", status: "completed", output: "ok" })).toBeNull();
    expect(digestTaskMessage({ type: "usage", meta: {} })).toBeNull();
  });

  it("truncates long assistant text", () => {
    const line = digestTaskMessage(textMessage("x".repeat(500)));
    expect(line!.length).toBeLessThan(320);
    expect(line!.endsWith("…")).toBe(true);
  });
});

describe("TaskProgressTracker", () => {
  it("triggers only when both N messages and T ms are satisfied", () => {
    const tracker = new TaskProgressTracker(3, 1000, 12_000, 0);
    tracker.record([textMessage(), textMessage()]);
    expect(tracker.shouldTrigger(5000)).toBe(false); // N not reached
    tracker.record([textMessage()]);
    expect(tracker.shouldTrigger(500)).toBe(false); // T not reached
    expect(tracker.shouldTrigger(1000)).toBe(true);
  });

  it("counts non-digestible messages toward N", () => {
    const tracker = new TaskProgressTracker(2, 0, 12_000, 0);
    tracker.record([{ type: "usage", meta: {} }, { type: "usage", meta: {} }]);
    expect(tracker.shouldTrigger(1)).toBe(true);
  });

  it("drain resets the window and reports the digest", () => {
    const tracker = new TaskProgressTracker(2, 1000, 12_000, 0);
    tracker.record([textMessage("step one"), { type: "tool_use", tool: "Read", input: { file: "a.ts" } }]);
    const { digest, messageCount } = tracker.drain(2000);
    expect(messageCount).toBe(2);
    expect(digest).toContain("assistant: step one");
    expect(digest).toContain("tool Read");
    expect(tracker.pendingMessageCount()).toBe(0);
    tracker.record([textMessage(), textMessage()]);
    expect(tracker.shouldTrigger(2500)).toBe(false); // debounce restarts at drain time
    expect(tracker.shouldTrigger(3000)).toBe(true);
  });

  it("evicts oldest digest lines beyond the char budget and notes the omission", () => {
    const tracker = new TaskProgressTracker(1, 0, 40, 0);
    tracker.record([textMessage("first entry"), textMessage("second entry"), textMessage("third entry")]);
    const { digest, messageCount } = tracker.drain(1);
    expect(messageCount).toBe(3);
    expect(digest).not.toContain("first entry");
    expect(digest).toContain("third entry");
    expect(digest).toContain("earlier entries omitted");
  });
});

describe("parseSummaryText", () => {
  it("parses plain JSON with step/total", () => {
    expect(parseSummaryText('{"summary": "正在跑测试", "step": 2, "total": 5}'))
      .toEqual({ summary: "正在跑测试", step: 2, total: 5 });
  });

  it("parses JSON wrapped in a code fence and drops invalid step/total", () => {
    expect(parseSummaryText('```json\n{"summary": "分析代码", "step": 9, "total": 3}\n```'))
      .toEqual({ summary: "分析代码" });
  });

  it("falls back to raw text when JSON is absent", () => {
    expect(parseSummaryText("正在编译前端")).toEqual({ summary: "正在编译前端" });
  });
});

describe("buildSummaryPrompt", () => {
  it("includes title, requirement, previous summary and digest", () => {
    const prompt = buildSummaryPrompt({
      taskTitle: "修复登录",
      taskPrompt: "用户报告登录失败，请排查并修复",
      previousSummary: "已定位到 token 过期问题",
      digest: "tool Bash {\"command\":\"bun test\"}",
    });
    expect(prompt).toContain("修复登录");
    expect(prompt).toContain("已定位到 token 过期问题");
    expect(prompt).toContain("bun test");
    expect(prompt).toContain("当前进度");
  });

  it("switches to terminal wording for outcomes", () => {
    const prompt = buildSummaryPrompt({
      taskTitle: "t",
      taskPrompt: "p",
      previousSummary: null,
      digest: "",
      outcome: "cancelled",
    });
    expect(prompt).toContain("任务已被取消");
    expect(prompt).toContain("终态摘要");
  });
});

describe("TaskProgressSummarizer", () => {
  it("reports a periodic summary once the dual trigger fires", async () => {
    const reported: Array<{ result: ProgressSummaryResult; final: boolean }> = [];
    let now = 0;
    const summarizer = new TaskProgressSummarizer({
      config: config(),
      credentials: CREDENTIALS,
      taskTitle: "标题",
      taskPrompt: "需求",
      report: async (result, { final }) => { reported.push({ result, final }); },
      fetchImpl: async () => summaryResponse("已完成初始探索，开始修改代码", { step: 1, total: 3 }),
      now: () => now,
    });
    summarizer.onMessages([textMessage(), textMessage()]);
    expect(reported.length).toBe(0);
    now = 2000;
    summarizer.onMessages([textMessage()]);
    await Bun.sleep(0);
    expect(reported).toEqual([{
      result: { summary: "已完成初始探索，开始修改代码", step: 1, total: 3 },
      final: false,
    }]);
  });

  it("keeps at most one summary call in flight", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let now = 10_000;
    const summarizer = new TaskProgressSummarizer({
      config: config({ minNewMessages: 1, minIntervalMs: 0 }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async () => {},
      fetchImpl: async () => {
        calls++;
        await gate;
        return summaryResponse("s");
      },
      now: () => now,
    });
    summarizer.onMessages([textMessage()]);
    now += 1000;
    summarizer.onMessages([textMessage()]);
    now += 1000;
    summarizer.onMessages([textMessage()]);
    release!();
    await Bun.sleep(0);
    expect(calls).toBe(1);
  });

  it("swallows model failures without reporting or throwing", async () => {
    const reported: unknown[] = [];
    let now = 0;
    const summarizer = new TaskProgressSummarizer({
      config: config({ minNewMessages: 1, minIntervalMs: 0 }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => { reported.push(result); },
      fetchImpl: async () => { throw new Error("network down"); },
      now: () => now,
    });
    summarizer.onMessages([textMessage()]);
    await Bun.sleep(0);
    expect(reported.length).toBe(0);
    // A later terminal summary still works if the model recovers.
    await summarizer.finalize("failed", "agent crashed");
    expect(reported.length).toBe(0); // fetch still failing — finalize also swallows
  });

  it("finalize produces a terminal summary marked final", async () => {
    const reported: Array<{ result: ProgressSummaryResult; final: boolean }> = [];
    const prompts: string[] = [];
    const summarizer = new TaskProgressSummarizer({
      config: config(),
      credentials: CREDENTIALS,
      taskTitle: "标题",
      taskPrompt: "需求",
      report: async (result, { final }) => { reported.push({ result, final }); },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { messages: Array<{ content: string }> };
        prompts.push(body.messages[0]!.content);
        return summaryResponse("任务已完成：修复了登录问题");
      },
      now: () => 0,
    });
    summarizer.onMessages([textMessage("fixed the bug")]);
    await summarizer.finalize("completed", "PR ready");
    expect(reported).toEqual([{ result: { summary: "任务已完成：修复了登录问题" }, final: true }]);
    expect(prompts[0]).toContain("任务已正常结束");
    // Once finalized, further messages and finalizes are ignored.
    summarizer.onMessages([textMessage()]);
    await summarizer.finalize("completed");
    await Bun.sleep(0);
    expect(reported.length).toBe(1);
  });

  it("sends relay bearer auth and the configured model", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; model: string }> = [];
    const summarizer = new TaskProgressSummarizer({
      config: config({ minNewMessages: 1, minIntervalMs: 0, model: "claude-haiku-test" }),
      credentials: { baseUrl: "https://relay.example", authToken: "tok", apiKey: "key" },
      taskTitle: "t",
      taskPrompt: "p",
      report: async () => {},
      fetchImpl: async (url, init) => {
        const headers = (init as RequestInit).headers as Record<string, string>;
        const body = JSON.parse(String((init as RequestInit).body)) as { model: string };
        requests.push({ url: String(url), headers, model: body.model });
        return summaryResponse("s");
      },
      now: () => 1000,
    });
    summarizer.onMessages([textMessage()]);
    await Bun.sleep(0);
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("https://relay.example/v1/messages");
    expect(requests[0]!.model).toBe("claude-haiku-test");
    expect(requests[0]!.headers.authorization).toBe("Bearer tok");
    expect(requests[0]!.headers["x-api-key"]).toBe("key");
  });

  it("calls an OpenAI-compatible chat completions endpoint", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: { model: string; messages: Array<{ role: string; content: string }> };
    }> = [];
    const reported: ProgressSummaryResult[] = [];
    const summarizer = new TaskProgressSummarizer({
      config: config({
        transport: "openai",
        openAi: {
          baseUrl: "https://openai.example/v1",
          model: "gpt-5.6-luna",
          apiKey: "openai-key",
        },
      }),
      taskTitle: "Luna 摘要",
      taskPrompt: "走 OpenAI 兼容接口",
      report: async (result) => { reported.push(result); },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          headers: (init as RequestInit).headers as Record<string, string>,
          body: JSON.parse(String((init as RequestInit).body)),
        });
        return modelResponse({
          choices: [{ message: { content: '{"summary":"Luna 摘要成功","step":2,"total":3}' } }],
        });
      },
      now: () => 0,
    });

    await summarizer.finalize("completed");

    expect(reported).toEqual([{ summary: "Luna 摘要成功", step: 2, total: 3 }]);
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("https://openai.example/v1/chat/completions");
    expect(requests[0]!.headers.authorization).toBe("Bearer openai-key");
    expect(requests[0]!.body.model).toBe("gpt-5.6-luna");
    expect(requests[0]!.body.messages[0]).toEqual({ role: "system", content: expect.any(String) });
    expect(requests[0]!.body.messages[0]!.content).toContain("任务进度播报员");
    expect(requests[0]!.body.messages[1]!.role).toBe("user");
    expect(requests[0]!.body.messages[1]!.content).toContain("Luna 摘要");
  });

  it("falls back to auto when OpenAI transport has no usable key", async () => {
    let apiCalls = 0;
    let cliCalls = 0;
    const reported: ProgressSummaryResult[] = [];
    const summarizer = new TaskProgressSummarizer({
      config: config({ transport: "openai", openAi: null }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => { reported.push(result); },
      fetchImpl: async () => {
        apiCalls++;
        return modelResponse({ error: "Claude Code clients only" }, 503);
      },
      whichImpl: () => "/opt/claude/bin/claude",
      spawnImpl: successfulCliSpawn("CLI fallback 摘要", () => { cliCalls++; }),
      now: () => 0,
    });

    await summarizer.finalize("completed");

    expect(reported).toEqual([{ summary: "CLI fallback 摘要" }]);
    expect(apiCalls).toBe(1);
    expect(cliCalls).toBe(1);
  });

  it("auto prefers OpenAI then remembers an HTTP fallback through API to CLI", async () => {
    const reports: string[] = [];
    let openAiCalls = 0;
    let anthropicCalls = 0;
    let cliCalls = 0;
    let reportReady: (() => void) | undefined;
    let waitForReport = new Promise<void>((resolve) => { reportReady = resolve; });
    let now = 1000;
    const summarizer = new TaskProgressSummarizer({
      config: config({
        minNewMessages: 1,
        minIntervalMs: 0,
        transport: "auto",
        openAi: { baseUrl: "https://relay.example", model: "gpt-5.6-luna", apiKey: "openai-key" },
      }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => {
        reports.push(result.summary);
        reportReady?.();
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith("/chat/completions")) openAiCalls++;
        else anthropicCalls++;
        return modelResponse({ error: "unavailable" }, 503);
      },
      whichImpl: () => "/opt/claude/bin/claude",
      spawnImpl: successfulCliSpawn("CLI final fallback", () => { cliCalls++; }),
      now: () => now,
    });

    summarizer.onMessages([textMessage("first")]);
    await waitForReport;
    await Bun.sleep(0);
    waitForReport = new Promise<void>((resolve) => { reportReady = resolve; });
    now++;
    summarizer.onMessages([textMessage("second")]);
    await waitForReport;

    expect(reports).toEqual(["CLI final fallback", "CLI final fallback"]);
    expect(openAiCalls).toBe(1);
    expect(anthropicCalls).toBe(1);
    expect(cliCalls).toBe(2);
  });

  it("auto falls back to the Anthropic API after an OpenAI timeout", async () => {
    const reported: ProgressSummaryResult[] = [];
    let calls = 0;
    const summarizer = new TaskProgressSummarizer({
      config: config({
        transport: "auto",
        openAi: { baseUrl: "https://relay.example", model: "gpt-5.6-luna", apiKey: "openai-key" },
      }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => { reported.push(result); },
      fetchImpl: async () => {
        calls++;
        if (calls === 1) throw new DOMException("request timed out", "TimeoutError");
        return summaryResponse("Anthropic fallback");
      },
      now: () => 0,
    });

    await summarizer.finalize("completed");

    expect(reported).toEqual([{ summary: "Anthropic fallback" }]);
    expect(calls).toBe(2);
  });

  it("auto-switches to Claude CLI after an API HTTP error and remembers the choice", async () => {
    const reports: string[] = [];
    let apiCalls = 0;
    let cliCalls = 0;
    let reportReady: (() => void) | undefined;
    let waitForReport = new Promise<void>((resolve) => { reportReady = resolve; });
    let now = 1000;
    const summarizer = new TaskProgressSummarizer({
      config: config({ minNewMessages: 1, minIntervalMs: 0, transport: "auto" }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => {
        reports.push(result.summary);
        reportReady?.();
      },
      fetchImpl: async () => {
        apiCalls++;
        return modelResponse({ error: "Claude Code clients only" }, 503);
      },
      whichImpl: () => "/opt/claude/bin/claude",
      spawnImpl: successfulCliSpawn("CLI 摘要", () => { cliCalls++; }),
      now: () => now,
    });

    summarizer.onMessages([textMessage("first")]);
    await waitForReport;
    await Bun.sleep(0);
    waitForReport = new Promise<void>((resolve) => { reportReady = resolve; });
    now++;
    summarizer.onMessages([textMessage("second")]);
    await waitForReport;

    expect(reports).toEqual(["CLI 摘要", "CLI 摘要"]);
    expect(apiCalls).toBe(1);
    expect(cliCalls).toBe(2);
  });

  it("runs the CLI in an isolated cwd with the provider env and combined prompt", async () => {
    const calls: Array<{ command: string[]; options: Parameters<SummaryCliSpawn>[1] }> = [];
    const reported: ProgressSummaryResult[] = [];
    const summarizer = new TaskProgressSummarizer({
      config: config({ transport: "cli", model: "claude-haiku-test" }),
      credentials: CREDENTIALS,
      providerEnv: { MULTIREMI_TEST_PROVIDER_ENV: "task-value" },
      taskTitle: "修复 Relay",
      taskPrompt: "增加 CLI 通道",
      report: async (result) => { reported.push(result); },
      fetchImpl: async () => { throw new Error("API should not be called"); },
      whichImpl: () => "/opt/claude/bin/claude",
      spawnImpl: successfulCliSpawn("已通过 CLI 生成摘要", (command, options) => {
        calls.push({ command, options });
      }),
      now: () => 0,
    });

    await summarizer.finalize("completed");

    expect(reported).toEqual([{ summary: "已通过 CLI 生成摘要" }]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.command[0]).toBe("/opt/claude/bin/claude");
    expect(calls[0]!.command.slice(-4)).toEqual(["--model", "claude-haiku-test", "--tools", ""]);
    expect(calls[0]!.command[2]).toContain("你是任务进度播报员");
    expect(calls[0]!.command[2]).toContain("修复 Relay");
    expect(calls[0]!.options.env.MULTIREMI_TEST_PROVIDER_ENV).toBe("task-value");
    expect(calls[0]!.options.cwd).toContain("multiremi-progress-");
    expect(calls[0]!.options.cwd).not.toContain(process.cwd());
  });

  it("kills a CLI subprocess when the request timeout expires", async () => {
    let kills = 0;
    const reported: ProgressSummaryResult[] = [];
    const spawnImpl: SummaryCliSpawn = () => ({
      stdout: byteStream(),
      stderr: byteStream(),
      exited: new Promise<number>(() => {}),
      kill: () => { kills++; },
    });
    const summarizer = new TaskProgressSummarizer({
      config: config({ transport: "cli", requestTimeoutMs: 5 }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => { reported.push(result); },
      whichImpl: () => "/opt/claude/bin/claude",
      spawnImpl,
      now: () => 0,
    });

    await summarizer.finalize("failed");

    expect(kills).toBe(1);
    expect(reported).toEqual([]);
  });

  it("falls back to the API when CLI transport cannot find the binary", async () => {
    let apiCalls = 0;
    let cliCalls = 0;
    const reported: ProgressSummaryResult[] = [];
    const summarizer = new TaskProgressSummarizer({
      config: config({ transport: "cli" }),
      credentials: CREDENTIALS,
      taskTitle: "t",
      taskPrompt: "p",
      report: async (result) => { reported.push(result); },
      fetchImpl: async () => {
        apiCalls++;
        return summaryResponse("API 摘要");
      },
      whichImpl: () => null,
      spawnImpl: successfulCliSpawn("unexpected", () => { cliCalls++; }),
      now: () => 0,
    });

    await summarizer.finalize("completed");

    expect(reported).toEqual([{ summary: "API 摘要" }]);
    expect(apiCalls).toBe(1);
    expect(cliCalls).toBe(0);
  });
});
