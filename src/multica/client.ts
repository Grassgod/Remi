import type { MulticaTaskStatus, RegisterRuntimeInput, TaskMessageInput, TaskUsageEntry } from "./types.js";

export class MulticaDaemonClient {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string, token?: string | null) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token ?? null;
  }

  async registerRuntime(input: RegisterRuntimeInput): Promise<{ runtime: { id: string } }> {
    return this.post("/api/multica/runtimes", input);
  }

  async recoverOrphans(runtimeId: string): Promise<void> {
    await this.post(`/api/daemon/runtimes/${runtimeId}/recover-orphans`, {});
  }

  async claimTask(runtimeId: string): Promise<any | null> {
    const resp = await this.post<{ task: any | null }>(`/api/daemon/runtimes/${runtimeId}/tasks/claim`, {});
    return resp.task;
  }

  async startTask(taskId: string): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/start`, {});
  }

  async reportProgress(taskId: string, summary: string, step?: number, total?: number): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/progress`, { summary, step, total });
  }

  async reportTaskMessages(taskId: string, messages: TaskMessageInput[]): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/messages`, { messages });
  }

  async pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/session`, {
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async completeTask(taskId: string, output: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/complete`, {
      output,
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async failTask(taskId: string, error: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.post(`/api/daemon/tasks/${taskId}/fail`, {
      error,
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async reportTaskUsage(taskId: string, usage: TaskUsageEntry[]): Promise<void> {
    if (usage.length === 0) return;
    await this.post(`/api/daemon/tasks/${taskId}/usage`, { usage });
  }

  async getTaskStatus(taskId: string): Promise<MulticaTaskStatus> {
    const resp = await this.get<{ status: MulticaTaskStatus }>(`/api/daemon/tasks/${taskId}/status`);
    return resp.status;
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(this.baseUrl + path, { headers: this.headers() });
    return parseResponse<T>(resp, "GET", path);
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify(body),
    });
    return parseResponse<T>(resp, "POST", path);
  }

  private headers(contentType?: string): HeadersInit {
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }
}

async function parseResponse<T>(resp: Response, method: string, path: string): Promise<T> {
  if (resp.ok) return await resp.json() as T;
  const text = await resp.text();
  throw new Error(`${method} ${path} returned ${resp.status}: ${text}`);
}
