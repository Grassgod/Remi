// LLM progress summaries for running tasks (MUL-67). The daemon feeds every
// reported task-message batch into a per-task TaskProgressSummarizer; when
// enough new activity accumulates (≥N messages AND ≥T ms since the last
// summary — MoA-style dual trigger) it makes one stateless small-model call
// and writes the result through `reportProgress`. A terminal summary is forced
// when the run ends (completed / failed / cancelled) with `final: true`, which
// bypasses the server's terminal-status progress guard.
//
// Isolation contract: summarization is strictly fire-and-forget. Model or
// network failures are logged and swallowed; they must never affect task
// execution. At most one summary call is in flight per task.
import type { TaskMessageInput } from "@multiremi/contracts/types.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("multiremi-progress");

export interface ProgressSummaryConfig {
  enabled: boolean;
  /** Trigger floor: new task messages since the last summary (N). */
  minNewMessages: number;
  /** Debounce floor: milliseconds since the last summary (T). */
  minIntervalMs: number;
  model: string;
  /** Total character budget for the compressed activity digest sent to the model. */
  maxDigestChars: number;
  requestTimeoutMs: number;
}

export const PROGRESS_SUMMARY_DEFAULTS = {
  minNewMessages: 20,
  minIntervalMs: 45_000,
  model: "claude-haiku-4-5-20251001",
  maxDigestChars: 12_000,
  requestTimeoutMs: 30_000,
} as const;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * N/T and the model are env-tunable:
 *   MULTIREMI_PROGRESS_SUMMARY_DISABLED=1     turn the feature off
 *   MULTIREMI_PROGRESS_SUMMARY_MESSAGES=20    N — new messages per summary
 *   MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS=45000  T — debounce between summaries
 *   MULTIREMI_PROGRESS_SUMMARY_MODEL=...      summary model id
 */
export function resolveProgressSummaryConfig(env: Record<string, string | undefined> = process.env): ProgressSummaryConfig {
  const disabled = env.MULTIREMI_PROGRESS_SUMMARY_DISABLED;
  return {
    enabled: !(disabled === "1" || disabled === "true"),
    minNewMessages: positiveInt(env.MULTIREMI_PROGRESS_SUMMARY_MESSAGES, PROGRESS_SUMMARY_DEFAULTS.minNewMessages),
    minIntervalMs: positiveInt(env.MULTIREMI_PROGRESS_SUMMARY_INTERVAL_MS, PROGRESS_SUMMARY_DEFAULTS.minIntervalMs),
    model: env.MULTIREMI_PROGRESS_SUMMARY_MODEL?.trim() || PROGRESS_SUMMARY_DEFAULTS.model,
    maxDigestChars: positiveInt(env.MULTIREMI_PROGRESS_SUMMARY_MAX_DIGEST_CHARS, PROGRESS_SUMMARY_DEFAULTS.maxDigestChars),
    requestTimeoutMs: positiveInt(env.MULTIREMI_PROGRESS_SUMMARY_TIMEOUT_MS, PROGRESS_SUMMARY_DEFAULTS.requestTimeoutMs),
  };
}

export interface SummarizerCredentials {
  baseUrl: string;
  /** Anthropic `x-api-key` style credential. */
  apiKey?: string;
  /** `Authorization: Bearer` style credential (relay / gateway). */
  authToken?: string;
}

/**
 * Reuse the task's own provider credentials (workspace Relay overlay or the
 * machine's ~/.claude settings env that `loadIssueSessionProviderEnv` already
 * resolved), falling back to the daemon process env. No new auth system.
 * Returns null when no usable Anthropic-style credential exists — the
 * summarizer is then disabled for this task.
 */
export function resolveSummarizerCredentials(
  providerEnv: Record<string, string> | undefined,
  processEnv: Record<string, string | undefined> = process.env,
): SummarizerCredentials | null {
  for (const env of [providerEnv, processEnv]) {
    if (!env) continue;
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (!apiKey && !authToken) continue;
    const baseUrl = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
    return { baseUrl, apiKey: apiKey || undefined, authToken: authToken || undefined };
  }
  return null;
}

/** One compressed line per interesting message; null = not digest-worthy. */
export function digestTaskMessage(message: TaskMessageInput): string | null {
  const clip = (value: string, max: number): string => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  if (message.type === "text" && message.content) return `assistant: ${clip(message.content, 300)}`;
  if (message.type === "thinking" && message.content) return `thinking: ${clip(message.content, 160)}`;
  if (message.type === "plan" && message.content) return `plan: ${clip(message.content, 120)}`;
  if (message.type === "tool_use") {
    const input = message.input ? clip(JSON.stringify(message.input), 200) : "";
    return `tool ${message.tool ?? "?"}${input ? ` ${input}` : ""}`;
  }
  if (message.type === "tool_result" && message.status === "failed") {
    const output = message.output ? ` ${clip(message.output, 200)}` : "";
    return `tool ${message.tool ?? "?"} failed${output}`;
  }
  // usage snapshots, successful tool_results (their tool_use already tells the
  // story), permission/question traffic: skip.
  return null;
}

/**
 * Pure trigger/accumulation state, unit-testable without any I/O. Counts every
 * reported message toward the N trigger but stores only digest-worthy lines,
 * keeping the newest ones within the character budget.
 */
export class TaskProgressTracker {
  private pendingCount = 0;
  private pendingLines: string[] = [];
  private pendingChars = 0;
  private droppedLines = 0;
  private lastSummaryAtMs: number;

  constructor(
    private readonly minNewMessages: number,
    private readonly minIntervalMs: number,
    private readonly maxDigestChars: number,
    nowMs: number,
  ) {
    this.lastSummaryAtMs = nowMs;
  }

  record(messages: TaskMessageInput[]): void {
    for (const message of messages) {
      this.pendingCount++;
      const line = digestTaskMessage(message);
      if (!line) continue;
      this.pendingLines.push(line);
      this.pendingChars += line.length;
      while (this.pendingLines.length > 1 && this.pendingChars > this.maxDigestChars) {
        const evicted = this.pendingLines.shift()!;
        this.pendingChars -= evicted.length;
        this.droppedLines++;
      }
    }
  }

  pendingMessageCount(): number {
    return this.pendingCount;
  }

  shouldTrigger(nowMs: number): boolean {
    return this.pendingCount >= this.minNewMessages
      && nowMs - this.lastSummaryAtMs >= this.minIntervalMs;
  }

  /** Digest of everything since the last summary; resets the trigger window. */
  drain(nowMs: number): { digest: string; messageCount: number } {
    const prefix = this.droppedLines > 0 ? [`… (${this.droppedLines} earlier entries omitted)`] : [];
    const digest = [...prefix, ...this.pendingLines].join("\n");
    const messageCount = this.pendingCount;
    this.pendingCount = 0;
    this.pendingLines = [];
    this.pendingChars = 0;
    this.droppedLines = 0;
    this.lastSummaryAtMs = nowMs;
    return { digest, messageCount };
  }
}

export type ProgressRunOutcome = "completed" | "failed" | "cancelled";

/** Narrow fetch shape so tests can inject a plain async function. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ProgressSummaryResult {
  summary: string;
  step?: number;
  total?: number;
}

const OUTCOME_LABEL: Record<ProgressRunOutcome, string> = {
  completed: "任务已正常结束",
  failed: "任务已失败",
  cancelled: "任务已被取消",
};

export function buildSummaryPrompt(input: {
  taskTitle: string;
  taskPrompt: string;
  previousSummary: string | null;
  digest: string;
  outcome?: ProgressRunOutcome;
  outcomeDetail?: string;
}): string {
  const requirement = input.taskPrompt.replace(/\s+/g, " ").trim().slice(0, 600);
  const parts = [
    `任务标题：${input.taskTitle || "(无标题)"}`,
    requirement ? `原始需求（截断）：${requirement}` : "",
    input.previousSummary ? `上一条进度：${input.previousSummary}` : "",
    input.digest ? `自上一条进度以来的执行活动（压缩视图，每行一条）：\n${input.digest}` : "（自上一条进度以来没有新的执行活动）",
  ];
  if (input.outcome) {
    parts.push(`运行状态：${OUTCOME_LABEL[input.outcome]}${input.outcomeDetail ? `。详情：${input.outcomeDetail.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`);
    parts.push("请输出一句终态摘要：任务最终做成了什么/为什么失败/取消前进行到哪。");
  } else {
    parts.push("请输出一句当前进度：正在做什么、已完成什么。");
  }
  return parts.filter(Boolean).join("\n\n");
}

const SUMMARY_SYSTEM_PROMPT = [
  "你是任务进度播报员。根据任务信息和最近的执行活动，用一句简洁的中文（不超过60字）概括进度，让不了解细节的人一眼看懂。",
  "要求：说人话，讲阶段性成果和当前动作，不要逐条转述工具调用，不要提及内部消息格式。",
  '只输出 JSON（不要 markdown 代码块）：{"summary": "一句话进度", "step": 可选的当前阶段序号, "total": 可选的总阶段数}。step/total 只在能合理估计整体阶段时给出。',
].join("\n");

async function callSummaryModel(
  credentials: SummarizerCredentials,
  model: string,
  prompt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<ProgressSummaryResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (credentials.apiKey) headers["x-api-key"] = credentials.apiKey;
  if (credentials.authToken) headers.authorization = `Bearer ${credentials.authToken}`;
  const response = await fetchImpl(`${credentials.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 300,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`summary model HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = (payload.content ?? [])
    .map((block) => (block?.type === "text" ? block.text ?? "" : ""))
    .join("")
    .trim();
  if (!text) throw new Error("summary model returned no text");
  return parseSummaryText(text);
}

export function parseSummaryText(text: string): ProgressSummaryResult {
  // Lenient parse: models occasionally wrap JSON in a code fence or prose.
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      if (summary) {
        const step = Number(parsed.step);
        const total = Number(parsed.total);
        const result: ProgressSummaryResult = { summary: summary.slice(0, 200) };
        if (Number.isInteger(step) && step > 0 && Number.isInteger(total) && total >= step) {
          result.step = step;
          result.total = total;
        }
        return result;
      }
    } catch {
      // fall through to raw text
    }
  }
  return { summary: text.replace(/\s+/g, " ").trim().slice(0, 200) };
}

export interface TaskProgressSummarizerOptions {
  config: ProgressSummaryConfig;
  credentials: SummarizerCredentials;
  taskTitle: string;
  taskPrompt: string;
  report: (result: ProgressSummaryResult, options: { final: boolean }) => Promise<void>;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/**
 * Per-task glue: trigger evaluation + single-flight summary calls. `onMessages`
 * is synchronous and cheap on the hot path; the model call runs detached from
 * the run loop. `finalize` produces the terminal summary and resolves once the
 * write finished (callers fire-and-forget it).
 */
export class TaskProgressSummarizer {
  private readonly tracker: TaskProgressTracker;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private inFlight: Promise<void> | null = null;
  private lastSummary: string | null = null;
  private finalized = false;

  constructor(private readonly options: TaskProgressSummarizerOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tracker = new TaskProgressTracker(
      options.config.minNewMessages,
      options.config.minIntervalMs,
      options.config.maxDigestChars,
      this.now(),
    );
  }

  onMessages(messages: TaskMessageInput[]): void {
    if (this.finalized) return;
    this.tracker.record(messages);
    if (this.inFlight || !this.tracker.shouldTrigger(this.now())) return;
    const { digest } = this.tracker.drain(this.now());
    this.inFlight = this.summarizeAndReport(digest, undefined, undefined)
      .finally(() => { this.inFlight = null; });
  }

  /**
   * Forced terminal summary. Waits for an in-flight periodic call first so the
   * final write always lands last, then summarizes regardless of thresholds.
   */
  async finalize(outcome: ProgressRunOutcome, detail?: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    const { digest } = this.tracker.drain(this.now());
    await this.summarizeAndReport(digest, outcome, detail);
  }

  private async summarizeAndReport(digest: string, outcome?: ProgressRunOutcome, detail?: string): Promise<void> {
    try {
      const prompt = buildSummaryPrompt({
        taskTitle: this.options.taskTitle,
        taskPrompt: this.options.taskPrompt,
        previousSummary: this.lastSummary,
        digest,
        outcome,
        outcomeDetail: detail,
      });
      const result = await callSummaryModel(
        this.options.credentials,
        this.options.config.model,
        prompt,
        this.options.config.requestTimeoutMs,
        this.fetchImpl,
      );
      this.lastSummary = result.summary;
      await this.options.report(result, { final: outcome !== undefined });
    } catch (err) {
      // Never let summarization failures touch task execution.
      log.warn(`Progress summary skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
