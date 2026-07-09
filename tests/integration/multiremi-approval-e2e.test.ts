import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElicitationCreateParams, PermissionOutcome, RequestPermissionParams } from "@acp/protocol.js";
import type { AgentResponse } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon, type MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTaskHumanRequest, MultiremiTaskStatus } from "@multiremi/contracts/types.js";

let db: Database | null = null;
let workDir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

const PERMISSION_PARAMS: RequestPermissionParams = {
  sessionId: "sess-approval",
  toolCall: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: "Bash: rm -rf ./dist" },
  options: [
    { kind: "allow_once", name: "Allow once", optionId: "opt-allow-once" },
    { kind: "allow_always", name: "Always allow", optionId: "opt-allow-always" },
    { kind: "reject_once", name: "Deny", optionId: "opt-reject" },
  ],
};

const ELICITATION_PARAMS: ElicitationCreateParams = {
  mode: "form",
  sessionId: "sess-approval",
  message: "Which environment should I deploy to?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Environment",
        description: "Which environment should I deploy to?",
        oneOf: [
          { const: "staging", title: "staging — pre-production" },
          { const: "production", title: "production — live traffic" },
        ],
      },
      customAnswer: { type: "string" },
    },
  },
};

interface Harness {
  store: MultiremiStore;
  server: ReturnType<typeof startMultiremiServer>;
  daemon: MultiremiDaemon;
  taskId: string;
  baseUrl: string;
  outcomes: PermissionOutcome[];
  elicitationResults: unknown[];
  run: Promise<void>;
}

/**
 * Boots a real HTTP server + a real worker daemon (approvalMode "ask") whose
 * fake provider raises a permission request — and optionally an
 * AskUserQuestion elicitation — mid-stream, exactly where a real ACP agent
 * would. The returned promise resolves when the daemon's one-shot run ends.
 */
function startHarness(options: { humanRequestTimeoutMs?: number; withElicitation?: boolean } = {}): Harness {
  db = new Database(":memory:");
  workDir = mkdtempSync(join(tmpdir(), "multiremi-approval-e2e-"));
  const store = new MultiremiStore(db);
  const agent = store.createAgent({ name: "Approval Agent", provider: "claude", cwd: workDir });
  const task = store.createTask({ agentId: agent.id, prompt: "Do something dangerous" });
  const server = startMultiremiServer({ store, scheduler: null, hostname: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const outcomes: PermissionOutcome[] = [];
  const elicitationResults: unknown[] = [];
  const response: AgentResponse = { text: "Task done", sessionId: "sess-approval", requestId: "req-1" };

  const providerFactory: MultiremiDaemonProviderFactory = () => {
    let permissionHandler: ((params: RequestPermissionParams) => Promise<PermissionOutcome>) | null = null;
    let elicitationHandler: ((params: ElicitationCreateParams) => Promise<unknown>) | null = null;
    return {
      setPermissionHandler(handler) {
        permissionHandler = handler;
      },
      setElicitationHandler(handler) {
        elicitationHandler = handler as typeof elicitationHandler;
      },
      async *sendStream() {
        yield { sessionUpdate: "agent_thought_chunk", content: [{ type: "text", text: "About to run a tool" }] } as any;
        // Block exactly like a real ACP agent: the stream does not advance
        // until the permission promise resolves.
        if (!permissionHandler) throw new Error("permission handler not registered");
        outcomes.push(await permissionHandler(PERMISSION_PARAMS));
        if (options.withElicitation) {
          if (!elicitationHandler) throw new Error("elicitation handler not registered");
          elicitationResults.push(await elicitationHandler(ELICITATION_PARAMS));
        }
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Task done" }] } as any;
      },
      getLastResponse: () => response,
    };
  };

  const daemon = new MultiremiDaemon({
    serverUrl: baseUrl,
    daemonId: "daemon-approval",
    runtimeName: "approval-runtime",
    provider: "claude",
    workspaceId: "local",
    once: true,
    daemonPort: 0,
    repoCacheRoot: join(workDir, ".repo-cache"),
    approvalMode: "ask",
    humanRequestTimeoutMs: options.humanRequestTimeoutMs ?? 60_000,
    providerFactory,
  });

  return { store, server, daemon, taskId: task.id, baseUrl, outcomes, elicitationResults, run: daemon.start() };
}

async function waitFor<T>(probe: () => T | null | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fetchRequests(baseUrl: string, taskId: string): Promise<MultiremiTaskHumanRequest[]> {
  const resp = await fetch(`${baseUrl}/api/tasks/${taskId}/human-requests`);
  expect(resp.status).toBe(200);
  return ((await resp.json()) as { requests: MultiremiTaskHumanRequest[] }).requests;
}

async function respond(baseUrl: string, taskId: string, requestId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/human-requests/${requestId}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: body }),
  });
}

describe("Multiremi approval routing e2e", () => {
  it("routes a permission request to a human and honors the approval", async () => {
    const h = startHarness();
    try {
      // Agent hits the permission gate → request row appears, task parks.
      const pending = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.status === "pending"),
        "pending permission request",
      );
      expect(pending.kind).toBe("permission");
      expect(pending.payload).toMatchObject({ tool_call: { title: "Bash: rm -rf ./dist" } });
      expect(h.store.getTaskStatus(h.taskId)).toBe("awaiting_human" as MultiremiTaskStatus);

      // The kanban reads the same state over the user API.
      const listed = await fetchRequests(h.baseUrl, h.taskId);
      expect(listed).toHaveLength(1);
      expect(listed[0].status).toBe("pending");

      // Human clicks "Allow once".
      const respondResp = await respond(h.baseUrl, h.taskId, pending.id, { option_id: "opt-allow-once" });
      expect(respondResp.status).toBe(200);

      // Double-respond loses the first-write-wins race.
      const conflict = await respond(h.baseUrl, h.taskId, pending.id, { option_id: "opt-reject" });
      expect(conflict.status).toBe(409);

      await h.run;
      expect(h.outcomes).toEqual([{ outcome: "selected", optionId: "opt-allow-once" }]);
      const task = h.store.getTask(h.taskId)!;
      expect(task.status).toBe("completed");

      const settled = (await fetchRequests(h.baseUrl, h.taskId))[0];
      expect(settled.status).toBe("responded");
      expect(settled.response).toEqual({ option_id: "opt-allow-once" });
      expect(settled.respondedBy).toBeTruthy();

      // Transcript carries the request/response audit rows.
      const types = h.store.listTaskMessages(h.taskId).map((m) => m.type);
      expect(types).toContain("permission_request");
      expect(types).toContain("permission_response");
    } finally {
      h.server.stop(true);
    }
  });

  it("routes AskUserQuestion to a human and folds answers back", async () => {
    const h = startHarness({ withElicitation: true });
    try {
      const permission = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.kind === "permission" && r.status === "pending"),
        "pending permission request",
      );
      await respond(h.baseUrl, h.taskId, permission.id, { option_id: "opt-allow-always" });

      const question = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.kind === "question" && r.status === "pending"),
        "pending question request",
      );
      expect(question.payload).toMatchObject({ message: "Which environment should I deploy to?" });
      const questions = (question.payload as { questions: Array<{ question: { question: string } }> }).questions;
      expect(questions).toHaveLength(1);
      expect(h.store.getTaskStatus(h.taskId)).toBe("awaiting_human" as MultiremiTaskStatus);

      // Human answers keyed by question text; the worker folds it back into
      // elicitation content keyed by the original field name.
      const answerResp = await respond(h.baseUrl, h.taskId, question.id, {
        answers: { [questions[0].question.question]: "staging" },
      });
      expect(answerResp.status).toBe(200);

      await h.run;
      expect(h.elicitationResults).toEqual([{ action: "accept", content: { question_0: "staging" } }]);
      expect(h.store.getTask(h.taskId)!.status).toBe("completed");
      const types = h.store.listTaskMessages(h.taskId).map((m) => m.type);
      expect(types).toContain("question_request");
      expect(types).toContain("question_response");
    } finally {
      h.server.stop(true);
    }
  });

  it("expires an unanswered permission request and denies conservatively", async () => {
    const h = startHarness({ humanRequestTimeoutMs: 500 });
    try {
      const pending = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.status === "pending"),
        "pending permission request",
      );

      await h.run; // nobody responds; worker times out and expires the request
      expect(h.outcomes).toEqual([{ outcome: "cancelled" }]);
      expect(h.store.getTaskHumanRequest(pending.id)!.status).toBe("timeout");
      // The task itself resumes and completes — a denied tool is not a failure.
      expect(h.store.getTask(h.taskId)!.status).toBe("completed");
    } finally {
      h.server.stop(true);
    }
  });
});
