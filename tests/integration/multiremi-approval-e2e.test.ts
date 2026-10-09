import { createResponsibleTestIssue } from "../unit/multiremi/helpers.js";
import { disabledSshMeshRuntime } from "../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it } from "bun:test";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openHotspotDatabase } from "../fixtures/multiremi/first-screen-hotspots-database.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElicitationCreateParams, PermissionOutcome, RequestPermissionParams } from "@shared/contracts/acp-protocol.js";
import type { AgentResponse } from "@shared/contracts/provider-types.js";
import { startMultiremiServer } from "../fixtures/daemon-protocol.js";
import type { MultiremiDaemonProviderFactory } from "@multiremi/daemon.js";
import { TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTaskHumanRequest, MultiremiTaskStatus } from "@multiremi/contracts/types.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

let db: SqlDatabase | null = null;
let database: Awaited<ReturnType<typeof openHotspotDatabase>> | null = null;
let workDir: string | null = null;
let activeHarness: Harness | null = null;
let activeServer: ReturnType<typeof startMultiremiServer> | null = null;
const originalUnattendedHumanRequestTimeoutMs = process.env.MULTIREMI_UNATTENDED_HUMAN_REQUEST_TIMEOUT_MS;

afterEach(async () => {
  // Bun timeouts can bypass finally in the test body. Drain the worker while
  // HTTP and the database are still available, then release shared resources.
  try {
    if (activeHarness) await stopHarness(activeHarness);
  } finally {
    activeHarness = null;
    activeServer?.stop(true);
    activeServer = null;
    await database?.dispose();
    database=null;db = null;
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
    if (originalUnattendedHumanRequestTimeoutMs === undefined) {
      delete process.env.MULTIREMI_UNATTENDED_HUMAN_REQUEST_TIMEOUT_MS;
    } else {
      process.env.MULTIREMI_UNATTENDED_HUMAN_REQUEST_TIMEOUT_MS = originalUnattendedHumanRequestTimeoutMs;
    }
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
  cleanup?: Promise<void>;
}

function stopHarness(h: Harness): Promise<void> {
  return h.cleanup ??= (async () => {
    h.daemon.stop();
    const status = h.store.getTaskStatus(h.taskId);
    if (status && !["completed", "failed", "cancelled"].includes(status)) {
      h.store.cancelTask(h.taskId);
    }
    for (const request of h.store.listTaskHumanRequests(h.taskId)) {
      if (request.status === "pending") h.store.expireTaskHumanRequest(request.id, "cancelled");
    }
    try {
      await h.run;
    } finally {
      h.server.stop(true);
    }
  })();
}

/**
 * Boots a real HTTP server + a real worker daemon (approvalMode "ask") whose
 * fake provider raises a permission request — and optionally an
 * AskUserQuestion elicitation — mid-stream, exactly where a real ACP agent
 * would. The returned promise resolves when the daemon's one-shot run ends.
 */
async function startHarness(options: {
  humanRequestTimeoutMs?: number;
  unattendedHumanRequestTimeoutMs?: number;
  unattended?: boolean;
  withElicitation?: boolean;
  approvalMode?: "ask" | "auto";
} = {}): Promise<Harness> {
  database=await openHotspotDatabase();
  db=database.db;
  workDir = mkdtempSync(join(tmpdir(), "multiremi-approval-e2e-"));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: "Approval Agent", provider: "claude" });
  const task = options.unattended
    ? (() => {
        const autopilot = store.createAutopilot({
          title: "Approval timeout",
          assigneeId: agent.id,
          executionMode: "run_only",
        });
        const run = store.runAutopilot(autopilot.id, { prompt: "Do something dangerous" });
        if (!run.taskId) throw new Error("Autopilot run did not create a task");
        return store.getTask(run.taskId)!;
      })()
    : store.createSessionTask(store.getOrCreateDefaultIssueSession(createResponsibleTestIssue(store, { title: "Approval fixture",
        assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: "mem_local_local" }).id).id,
        { agentId: agent.id, prompt: "Do something dangerous" });
  const server = startMultiremiServer({ store, scheduler: null, hostname: "127.0.0.1", port: 0 });
  activeServer = server;
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const daemonToken = await store.createAccessToken({
    name: "Approval E2E daemon",
    type: "daemon",
    workspaceId: "local",
    daemonId: "daemon-approval",
  });

  const outcomes: PermissionOutcome[] = [];
  const elicitationResults: unknown[] = [];
  const response: AgentResponse = { text: "Task done", sessionId: "sess-approval", requestId: "req-1" };

  const providerFactory: MultiremiDaemonProviderFactory = () => {
    let permissionHandler: ((params: RequestPermissionParams) => Promise<PermissionOutcome>) | null = null;
    let elicitationHandler: ((params: ElicitationCreateParams) => Promise<unknown>) | null = null;
    let streamedText = "";
    return {
      setPermissionHandler(handler) {
        permissionHandler = handler;
      },
      setElicitationHandler(handler) {
        elicitationHandler = handler as typeof elicitationHandler;
      },
      getStreamedText(chatId) {
        return chatId === task.id ? streamedText : "";
      },
      async *sendStream() {
        // #11: a provider follows the offered range hint before responding.
        // Unattended offers also contain folded timer/status context.
        const current = store.getTurnForAttempt(task.id)!;
        const credential = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
        const input = await fetch(`${baseUrl}/api/sessions/${current.session_id}/messages?from=0&to=${store.getConversationLogHead(current.session_id)!.headSeq}`, {
          headers: { Authorization: `Bearer ${credential.token}` },
        });
        expect(input.status).toBe(200);
        await input.text();
        yield { sessionUpdate: "agent_thought_chunk", content: [{ type: "text", text: "About to run a tool" }] } as any;
        // Block exactly like a real ACP agent: the stream does not advance
        // until the permission promise resolves.
        if (!permissionHandler) throw new Error("permission handler not registered");
        outcomes.push(await permissionHandler(PERMISSION_PARAMS));
        if (options.withElicitation) {
          if (!elicitationHandler) throw new Error("elicitation handler not registered");
          streamedText = "I compared deployment risk and rollback speed before asking.";
          elicitationResults.push(await elicitationHandler(ELICITATION_PARAMS));
        }
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Task done" }] } as any;
      },
      getLastResponse: () => response,
    };
  };

  const daemon = new MultiremiDaemon({
    protocolClientOptions: { cliVersion: DAEMON_MIN_CLI_VERSION },
    sshMeshManager: disabledSshMeshRuntime(),
    serverUrl: baseUrl,
    token: daemonToken.token,
    daemonId: "daemon-approval",
    runtimeName: "approval-runtime",
    provider: "claude",
    workspaceId: "local",
    once: true,
    pollIntervalMs: 250,
    daemonPort: 0,
    repoCacheRoot: join(workDir, ".repo-cache"),
    approvalMode: options.approvalMode ?? "ask",
    humanRequestTimeoutMs: options.humanRequestTimeoutMs ?? 60_000,
    unattendedHumanRequestTimeoutMs: options.unattendedHumanRequestTimeoutMs,
    taskDrainTimeoutMs: 1000,
    providerFactory,
  });

  activeHarness = { store, server, daemon, taskId: task.id, baseUrl, outcomes, elicitationResults, run: daemon.start() };
  return activeHarness;
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

async function fetchRequests(store: MultiremiStore, baseUrl: string, taskId: string): Promise<MultiremiTaskHumanRequest[]> {
  const resp = await fetch(`${baseUrl}/api/sessions/${store.getTurnForAttempt(taskId)!.session_id}/messages`);
  expect(resp.status).toBe(200);
  return ((await resp.json()) as { messages: Array<{ id: string; metadata: { human_request?: unknown } }> }).messages
    .flatMap(message => message.metadata.human_request ? [store.getTaskHumanRequest(message.id)!] : []);
}

async function respond(store: MultiremiStore, baseUrl: string, taskId: string, requestId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/sessions/${store.getMessage(requestId)!.session_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message_kind: "reply", reply_to_id: requestId, body_md: "Approval response", response: body,
      expected_route_revision: store.getQuestion(requestId)!.route_revision }),
  });
}

describe("Multiremi approval routing e2e", () => {
  it("drains a pending approval before closing the server", async () => {
    const h = await startHarness();
    const pending = await waitFor(
      () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.status === "pending"),
      "pending permission request",
    );
    await stopHarness(h);
    expect(h.store.getTaskStatus(h.taskId)).toBe("cancelled");
    expect(h.store.getTaskHumanRequest(pending.id)?.status).toBe("pending");
    expect(h.store.getQuestion(pending.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'source_turn_cancelled' });
    await expect(fetch(`${h.baseUrl}/api/health`)).rejects.toThrow();
    await stopHarness(h);
  }, 30_000);

  it("routes a permission request to a human and honors the approval", async () => {
    const h = await startHarness();
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
      const listed = await fetchRequests(h.store, h.baseUrl, h.taskId);
      expect(listed).toHaveLength(1);
      expect(listed[0].status).toBe("pending");

      // Human clicks "Allow once".
      const respondResp = await respond(h.store, h.baseUrl, h.taskId, pending.id, { option_id: "opt-allow-once" });
      expect(respondResp.status).toBe(200);

      // Double-respond loses the first-write-wins race.
      const conflict = await respond(h.store, h.baseUrl, h.taskId, pending.id, { option_id: "opt-reject" });
      expect(conflict.status).toBe(409);

      await h.run;
      expect(h.outcomes).toEqual([{ outcome: "selected", optionId: "opt-allow-once" }]);
      const task = h.store.getTask(h.taskId)!;
      expect(task.status).toBe("completed");

      const settled = (await fetchRequests(h.store, h.baseUrl, h.taskId))[0];
      expect(settled.status).toBe("responded");
      expect(settled.response).toEqual({ option_id: "opt-allow-once" });
      expect(settled.respondedBy).toBeTruthy();

      // Transcript carries the request/response audit rows.
      const types = h.daemon.traceStore().read(h.taskId).events.map((m) => m.type);
      expect(types).toContain("permission_request");
      expect(types).toContain("permission_response");
    } finally {
      await stopHarness(h);
    }
  }, 30_000);

  it("routes AskUserQuestion to a human and folds answers back", async () => {
    const h = await startHarness({ withElicitation: true });
    try {
      const permission = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.kind === "permission" && r.status === "pending"),
        "pending permission request",
      );
      await respond(h.store, h.baseUrl, h.taskId, permission.id, { option_id: "opt-allow-always" });

      const question = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.kind === "question" && r.status === "pending"),
        "pending question request",
      );
      expect(question.payload).toMatchObject({ message: "Which environment should I deploy to?" });
      expect(question.payload).toMatchObject({
        context: { text: "I compared deployment risk and rollback speed before asking." },
      });
      const questions = (question.payload as { questions: Array<{ question: { question: string } }> }).questions;
      expect(questions).toHaveLength(1);
      expect(h.store.getTaskStatus(h.taskId)).toBe("awaiting_human" as MultiremiTaskStatus);

      // Human answers keyed by question text; the worker folds it back into
      // elicitation content keyed by the original field name.
      const answerResp = await respond(h.store, h.baseUrl, h.taskId, question.id, {
        answers: { [questions[0].question.question]: "staging" },
      });
      expect(answerResp.status, await answerResp.clone().text()).toBe(200);

      await h.run;
      expect(h.elicitationResults).toEqual([{ action: "accept", content: { question_0: "staging" } }]);
      expect(h.store.getTask(h.taskId)!.status).toBe("completed");
      const types = h.daemon.traceStore().read(h.taskId).events.map((m) => m.type);
      expect(types).toContain("question_request");
      expect(types).toContain("question_response");
    } finally {
      await stopHarness(h);
    }
  }, 30_000);

  it("routes AskUserQuestion in auto approval mode while tools remain auto-approved", async () => {
    const h = await startHarness({ withElicitation: true, approvalMode: "auto" });
    try {
      const question = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.kind === "question" && r.status === "pending"),
        "pending question request",
      );
      expect(h.store.listTaskHumanRequests(h.taskId).some((r) => r.kind === "permission")).toBe(false);
      const questions = (question.payload as { questions: Array<{ question: { question: string } }> }).questions;
      await respond(h.store, h.baseUrl, h.taskId, question.id, {
        answers: { [questions[0]!.question.question]: "production" },
      });

      await h.run;
      expect(h.outcomes).toEqual([{ outcome: "selected", optionId: "opt-allow-always" }]);
      expect(h.elicitationResults).toEqual([{ action: "accept", content: { question_0: "production" } }]);
    } finally {
      await stopHarness(h);
    }
  }, 30_000);

  it("expires an unanswered permission request and denies conservatively", async () => {
    const h = await startHarness({ humanRequestTimeoutMs: 500 });
    try {
      const pending = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.status === "pending"),
        "pending permission request",
      );

      await h.run; // nobody responds; worker times out and expires the request
      expect(h.outcomes).toEqual([{ outcome: "cancelled" }]);
      expect(h.store.getTaskHumanRequest(pending.id)!.status).toBe("pending");
      expect(h.store.getQuestion(pending.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
      // The task itself resumes and completes — a denied tool is not a failure.
      expect(h.store.getTask(h.taskId)!.status).toBe("completed");
    } finally {
      await stopHarness(h);
    }
  }, 30_000);

  it("uses the shorter timeout for unattended permission requests", async () => {
    const h = await startHarness({
      unattended: true,
      humanRequestTimeoutMs: 5_000,
      unattendedHumanRequestTimeoutMs: 100,
    });
    try {
      const pending = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.status === "pending"),
        "pending unattended permission request",
      );

      await h.run;
      expect(h.outcomes).toEqual([{ outcome: "cancelled" }]);
      expect(h.store.getTaskHumanRequest(pending.id)!.status).toBe("pending");
      expect(h.store.getQuestion(pending.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
    } finally {
      await stopHarness(h);
    }
  }, 30_000);

  it("keeps the attended timeout when the unattended timeout is shorter", async () => {
    const h = await startHarness({
      humanRequestTimeoutMs: 5_000,
      unattendedHumanRequestTimeoutMs: 100,
    });
    try {
      const pending = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.status === "pending"),
        "pending attended permission request",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(h.store.getTaskHumanRequest(pending.id)!.status).toBe("pending");

      await respond(h.store, h.baseUrl, h.taskId, pending.id, { option_id: "opt-allow-once" });
      await h.run;
      expect(h.outcomes).toEqual([{ outcome: "selected", optionId: "opt-allow-once" }]);
    } finally {
      await stopHarness(h);
    }
  }, 30_000);

  it("honors the unattended timeout environment override for questions", async () => {
    process.env.MULTIREMI_UNATTENDED_HUMAN_REQUEST_TIMEOUT_MS = "100";
    const h = await startHarness({
      unattended: true,
      withElicitation: true,
      approvalMode: "auto",
      humanRequestTimeoutMs: 5_000,
    });
    try {
      const pending = await waitFor(
        () => h.store.listTaskHumanRequests(h.taskId).find((r) => r.kind === "question" && r.status === "pending"),
        "pending unattended question request",
      );

      await h.run;
      expect(h.elicitationResults).toEqual([{ action: "cancel" }]);
      expect(h.store.getTaskHumanRequest(pending.id)!.status).toBe("pending");
      expect(h.store.getQuestion(pending.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
      expect(h.store.getTask(h.taskId)!.status).toBe("completed");
    } finally {
      await stopHarness(h);
    }
  }, 30_000);
});
