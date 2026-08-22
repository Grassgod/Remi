import type { FeishuMultiremiConfig } from "@shared/config.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FeishuMultiremiClientOptions {
  fetch?: FetchLike;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export function shouldRouteFeishuMessageToMultiremi(
  config: FeishuMultiremiConfig | null | undefined,
  chatType: "p2p" | "group",
): boolean {
  return config?.enabled === true && chatType === "p2p";
}

export class FeishuMultiremiClient {
  private readonly serverUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly enqueueTails = new Map<string, Promise<void>>();

  constructor(
    private readonly config: FeishuMultiremiConfig,
    options: FeishuMultiremiClientOptions = {},
  ) {
    this.serverUrl = config.serverUrl.trim().replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendMessage(externalChatId: string, content: string): Promise<string> {
    this.validateConfig();
    const deadline = Date.now() + this.timeoutMs;
    const { sessionId, taskId } = await this.enqueueMessage(externalChatId, content, deadline);

    await this.waitForTask(taskId, deadline);
    const messages = await this.requestJson<unknown>(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      {},
      deadline,
    );
    if (!Array.isArray(messages)) throw new Error("Multiremi chat messages response is invalid");
    const assistant = [...messages].reverse().find((message) => {
      if (!message || typeof message !== "object") return false;
      const row = message as Record<string, unknown>;
      return row.role === "assistant" && row.task_id === taskId;
    }) as Record<string, unknown> | undefined;
    return requiredString(assistant?.content, "assistant message content");
  }

  private enqueueMessage(
    externalChatId: string,
    content: string,
    deadline: number,
  ): Promise<{ sessionId: string; taskId: string }> {
    const previous = this.enqueueTails.get(externalChatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      return this.resolveAndSend(externalChatId, content, deadline);
    });
    const tail = current.then(() => undefined, () => undefined);
    this.enqueueTails.set(externalChatId, tail);
    void tail.then(() => {
      if (this.enqueueTails.get(externalChatId) === tail) this.enqueueTails.delete(externalChatId);
    });
    return current;
  }

  private async resolveAndSend(
    externalChatId: string,
    content: string,
    deadline: number,
  ): Promise<{ sessionId: string; taskId: string }> {
    const workspaceId = this.config.workspaceId.trim();
    const session = await this.requestJson<{ id?: unknown }>(
      `/api/chat/external/resolve?workspace_id=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        body: JSON.stringify({ source: "feishu", external_chat_id: externalChatId }),
      },
      deadline,
    );
    const sessionId = requiredString(session.id, "resolve response session id");
    const sent = await this.requestJson<{ task_id?: unknown }>(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: JSON.stringify({ content }) },
      deadline,
    );
    const taskId = requiredString(sent.task_id, "send response task id");
    return { sessionId, taskId };
  }

  private async waitForTask(taskId: string, deadline: number): Promise<void> {
    while (true) {
      const response = await this.requestJson<{ task?: Record<string, unknown> }>(
        `/api/multiremi/tasks/${encodeURIComponent(taskId)}`,
        {},
        deadline,
      );
      const task = response.task;
      const status = requiredString(task?.status, "task status");
      if (TERMINAL_TASK_STATUSES.has(status)) {
        if (status === "completed") return;
        const reason = optionalString(task?.error) ?? optionalString(task?.failureReason) ?? status;
        throw new Error(`Multiremi task ${taskId} ${status}: ${reason}`);
      }
      if (Date.now() >= deadline) {
        throw this.timeoutError();
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now())));
      });
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, deadline: number): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw this.timeoutError();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = this.timeoutError();
        controller.abort(error);
        reject(error);
      }, remainingMs);
    });

    let response: Response;
    let raw: string;
    try {
      ({ response, raw } = await Promise.race([
        (async () => {
          const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
            ...init,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.config.token}`,
              "Content-Type": "application/json",
              ...init.headers,
            },
          });
          return { response, raw: await response.text() };
        })(),
        timeout,
      ]));
    } catch (error) {
      if (controller.signal.aborted || Date.now() >= deadline) throw this.timeoutError();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error(`Multiremi returned invalid JSON (${response.status})`);
      }
    }
    if (!response.ok) {
      const detail = body && typeof body === "object"
        ? optionalString((body as Record<string, unknown>).error)
        : null;
      throw new Error(`Multiremi request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return body as T;
  }

  private timeoutError(): Error {
    return new Error(`Multiremi request timed out after ${this.timeoutMs}ms`);
  }

  private validateConfig(): void {
    if (!this.serverUrl) throw new Error("feishu.multiremi.serverUrl is required");
    if (!this.config.token.trim()) throw new Error("feishu.multiremi.token is required");
    if (!this.config.workspaceId.trim()) throw new Error("feishu.multiremi.workspaceId is required");
  }
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`Multiremi ${label} is missing`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}
