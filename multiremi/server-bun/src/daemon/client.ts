/**
 * Typed HTTP client the `remi` daemon uses to talk to the server — the OUTBOUND
 * side of the daemon API (register / claim / heartbeat / report / deregister).
 * Auth is a Bearer PAT (`mul_…`); the workspace is pinned via X-Workspace-ID.
 * Responses are parsed defensively (parse-don't-cast): a server that adds or
 * drops a field must never crash an older binary.
 *
 * No DB import here by design — this file (and everything it pulls in) must be
 * safe to `bun build --compile` without bundling postgres / DATABASE_URL.
 */

import { remiVersion } from "./version.js";

export interface DaemonClientOptions {
  serverUrl: string;
  token: string;
  workspaceId: string;
}

export interface RegisteredRuntime {
  id: string;
  provider: string;
  name: string;
  status: string;
}

/** The slice of a claimed task the remote daemon needs to run it (M1, thin). */
export interface ClaimedTask {
  id: string;
  issueId: string;
  instructions: string;
  model?: string;
  env: Record<string, string>;
  sessionId?: string;
  workDir?: string;
}

export type ReportOutcome =
  | { status: "completed"; text: string; sessionId: string }
  | { status: "failed"; error: string; failureReason?: string };

export interface TaskMessageInput {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "error";
  seq: number;
  tool?: string;
  content?: string;
  input?: unknown;
  output?: string;
}

export interface TaskUsageInput {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** HTTP error carrying the status so callers can branch (401 stop, 404 re-register). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(v))) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export class DaemonClient {
  private readonly base: string;
  private readonly token: string;
  private readonly workspaceId: string;

  constructor(opts: DaemonClientOptions) {
    this.base = opts.serverUrl.trim().replace(/\/+$/, "");
    this.token = opts.token;
    this.workspaceId = opts.workspaceId;
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-Workspace-ID": this.workspaceId,
        "X-Client-Platform": "daemon",
        "X-Client-Version": remiVersion,
        "X-Client-OS": process.platform,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `${method} ${path} → ${res.status} ${text}`.trim());
    }
    return res.json().catch(() => ({}));
  }

  /** Announce this daemon + its providers; returns the runtime rows to drive. */
  async register(
    daemonId: string,
    deviceName: string,
    providers: string[],
  ): Promise<RegisteredRuntime[]> {
    const out = asRecord(
      await this.req("POST", "/api/daemon/register", {
        daemon_id: daemonId,
        device_name: deviceName,
        cli_version: remiVersion,
        launched_by: "remi",
        runtimes: providers.map((p) => ({
          type: p,
          name: "",
          version: remiVersion,
          status: "online",
        })),
      }),
    );
    const arr = Array.isArray(out.runtimes) ? out.runtimes : [];
    const result: RegisteredRuntime[] = [];
    for (const r of arr) {
      const o = asRecord(r);
      if (asString(o.id) && asString(o.provider)) {
        result.push({
          id: asString(o.id),
          provider: asString(o.provider),
          name: asString(o.name),
          status: asString(o.status),
        });
      }
    }
    return result;
  }

  /** Claim the next queued task for a runtime, or null when the queue is empty. */
  async claim(runtimeId: string): Promise<ClaimedTask | null> {
    const out = asRecord(await this.req("POST", `/api/daemon/runtimes/${runtimeId}/tasks/claim`));
    const task = out.task;
    if (!task || typeof task !== "object") return null;
    const t = asRecord(task);
    const id = asString(t.id);
    if (!id) return null;
    const agent = asRecord(t.agent);
    return {
      id,
      issueId: asString(t.issue_id),
      instructions: asString(agent.instructions),
      model: asString(agent.model) || undefined,
      env: asStringMap(agent.custom_env),
      sessionId: asString(t.session_id) || undefined,
      workDir: asString(t.work_dir) || undefined,
    };
  }

  /** Heartbeat a runtime. Returns false on 404 (runtime gone → re-register). */
  async heartbeat(runtimeId: string): Promise<boolean> {
    try {
      await this.req("POST", `/api/runtimes/${runtimeId}/heartbeat`);
      return true;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return false;
      throw e;
    }
  }

  /** Report a task result (completed/failed). */
  async report(taskId: string, outcome: ReportOutcome): Promise<void> {
    if (outcome.status === "completed") {
      await this.completeTask(taskId, outcome.text, outcome.sessionId);
      return;
    }
    await this.failTask(taskId, outcome.error, outcome.failureReason);
  }

  async recoverOrphans(runtimeId: string): Promise<number> {
    const out = asRecord(await this.req("POST", `/api/daemon/runtimes/${runtimeId}/recover-orphans`));
    const count = out.recovered;
    return typeof count === "number" ? count : 0;
  }

  async startTask(taskId: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.req("POST", `/api/daemon/tasks/${taskId}/start`, {
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async reportProgress(taskId: string, message: string, current?: number, total?: number): Promise<void> {
    await this.req("POST", `/api/daemon/tasks/${taskId}/progress`, {
      message,
      current,
      total,
    });
  }

  async reportTaskMessages(taskId: string, messages: TaskMessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    await this.req("POST", `/api/daemon/tasks/${taskId}/messages`, { messages });
  }

  async pinTaskSession(taskId: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.req("POST", `/api/daemon/tasks/${taskId}/session`, {
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async reportTaskUsage(taskId: string, usage: TaskUsageInput[]): Promise<void> {
    if (usage.length === 0) return;
    await this.req("POST", `/api/daemon/tasks/${taskId}/usage`, { usage });
  }

  async completeTask(taskId: string, text: string, sessionId?: string | null, workDir?: string | null): Promise<void> {
    await this.req("POST", `/api/daemon/tasks/${taskId}/complete`, {
      status: "completed",
      text,
      session_id: sessionId ?? undefined,
      work_dir: workDir ?? undefined,
    });
  }

  async failTask(
    taskId: string,
    error: string,
    failureReason?: string,
    sessionId?: string | null,
    workDir?: string | null,
  ): Promise<void> {
    const body =
      { status: "failed", error, failure_reason: failureReason, session_id: sessionId ?? undefined, work_dir: workDir ?? undefined };
    await this.req("POST", `/api/daemon/tasks/${taskId}/fail`, body);
  }

  async getTaskStatus(taskId: string): Promise<string> {
    const out = asRecord(await this.req("GET", `/api/daemon/tasks/${taskId}/status`));
    return asString(out.status);
  }
}
