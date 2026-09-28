// MUL-474 (MUL-383 S8e): deterministic fixture for the daemon task-level polls.
//
// The three routes under test must keep answering with the same body before and
// after the read-path change, so the fixture pins everything that body can carry:
//
//   * a Task whose `prompt` is far larger than any projection should read, which
//     is the production shape (209's tasks carry >=100 KB prompts) and what makes
//     an accidental payload read visible in the bridge-byte numbers;
//   * a populated `result` / `usage` / `session_id` / `work_dir`, so a projection
//     that silently drops a column cannot pass by returning nulls;
//   * one Feishu receipt delivery, so `receipt_message_ids` is non-empty — that
//     three-table JOIN is part of the `status` body, and the exception probe that
//     finds it is exactly what the owner-identity branch can skip;
//   * a second Runtime with its own daemon token, so the authority matrix can show
//     a non-owner is still refused.
import { createHash } from "node:crypto";
import { MultiremiStore } from "@multiremi/store.js";

export const DAEMON_TASK_POLL_PROMPT_BYTES = 131_072;
export const DAEMON_TASK_POLL_EXTERNAL_MESSAGE_ID = "om_mul474_receipt";
export const DAEMON_TASK_POLL_APP_ID = "cli_mul474_fixture_app";
export const DAEMON_TASK_POLL_RUNTIME_ID = "rt_mul474_poll";

export interface DaemonTaskPollFixture {
  workspaceId: string;
  agentId: string;
  runtimeId: string;
  foreignRuntimeId: string;
  taskId: string;
  chatSessionId: string;
  externalMessageId: string;
  daemonToken: string;
  foreignDaemonToken: string;
  promptBytes: number;
}

export interface DaemonTaskPollFixtureOptions {
  /** Bytes of prompt text to store. Defaults to {@link DAEMON_TASK_POLL_PROMPT_BYTES}. */
  promptBytes?: number;
  /**
   * Runs one statement outside the store. The golden capture uses this to pin the
   * `started_at` / `completed_at` the `status` body echoes, so the captured bytes
   * are comparable across runs.
   */
  run?: (sql: string, params: unknown[]) => void;
}

export function daemonTaskPollPromptSha256(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/**
 * Seed the fixture into an already-migrated store.
 *
 * The caller owns the store, so the same seed works against in-memory SQLite
 * (fast, for the counting test) and against `PostgresSyncDatabase` (the
 * bridge-byte harness).
 */
export async function seedDaemonTaskPollFixture(
  store: MultiremiStore,
  options: DaemonTaskPollFixtureOptions = {},
): Promise<DaemonTaskPollFixture> {
  const workspaceId = "local";
  const promptBytes = options.promptBytes ?? DAEMON_TASK_POLL_PROMPT_BYTES;
  const prompt = `MUL-474 daemon task poll fixture. ${"x".repeat(Math.max(0, promptBytes - 34))}`;

  const agent = store.createAgent({
    id: "agt_mul474_poll",
    name: "MUL-474 poll agent",
    provider: "codex",
    workspaceId,
  });
  store.registerRuntime({
    id: DAEMON_TASK_POLL_RUNTIME_ID,
    name: "MUL-474 poll runtime",
    provider: "codex",
    workspaceId,
    daemonId: "daemon-mul474-poll",
    ownerId: "local",
  });
  store.registerRuntime({
    id: "rt_mul474_foreign",
    name: "MUL-474 foreign runtime",
    provider: "codex",
    workspaceId,
    daemonId: "daemon-mul474-foreign",
    ownerId: "local",
  });
  store.heartbeatRuntime("rt_mul474_poll", { supportsFeishuBotConfig: true });
  store.heartbeatRuntime("rt_mul474_foreign", { supportsFeishuBotConfig: true });

  const task = store.createTask({ id: "tsk_mul474_poll", agentId: agent.id, workspaceId, prompt });
  const claimed = store.claimTask("rt_mul474_poll");
  if (!claimed || claimed.id !== task.id) throw new Error("fixture could not claim its Task on the poll Runtime");
  store.startTask(task.id);
  store.reportTaskUsage(task.id, [
    { provider: "codex", model: "gpt-5", inputTokens: 1_000, outputTokens: 500 },
  ]);
  // The fixture Task stays *running*: that is the shape every one of these routes
  // sees in production (a 2.5 s poll only exists while a task runs). Its session
  // and work dir are pinned anyway, and usage is reported, so the projections
  // still have non-null columns to carry.
  store.pinTaskSession(task.id, "ises_mul474_poll_session", "/tmp/mul474-work");
  store.appendTaskMessages(task.id, [{ seq: 1, type: "text", content: "fixture message" }]);

  // One Feishu receipt delivery on the Task, so `receipt_message_ids` in the
  // `status` body is non-empty. The config row goes through the store (it holds
  // the encrypted app secret, which needs
  // `MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY`); the binding and delivery rows have no
  // public insert, so the caller's pinned runner writes them.
  const chatSession = store.createChatSession({ agentId: agent.id, creatorId: "local" });
  store.upsertFeishuBotConfig(workspaceId, {
    agentId: agent.id,
    runtimeId: "rt_mul474_poll",
    appId: DAEMON_TASK_POLL_APP_ID,
    appSecret: "mul474_fixture_app_secret",
    appSecretOp: "set",
    enabled: true,
    domain: "feishu",
  });
  const bindingId = `fbb_mul474_${chatSession.id}`;
  const now = new Date().toISOString();
  const run = options.run;
  if (run) {
    run(
      `INSERT INTO multiremi_feishu_bot_chat_bindings (
         id, workspace_id, app_id, agent_id, external_session_key, chat_session_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [bindingId, workspaceId, DAEMON_TASK_POLL_APP_ID, agent.id, `oc_mul474_${chatSession.id}`, chatSession.id, now, now],
    );
    run(
      `INSERT INTO multiremi_feishu_bot_deliveries (
         workspace_id, external_message_id, binding_id, task_id, reply_to_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, DAEMON_TASK_POLL_EXTERNAL_MESSAGE_ID, bindingId, task.id, null, now, now],
    );
  }

  const owner = await store.createAccessToken({
    name: "MUL-474 poll daemon",
    type: "daemon",
    workspaceId,
    daemonId: "daemon-mul474-poll",
  });
  const foreign = await store.createAccessToken({
    name: "MUL-474 foreign daemon",
    type: "daemon",
    workspaceId,
    daemonId: "daemon-mul474-foreign",
  });
  return {
    workspaceId,
    agentId: agent.id,
    runtimeId: DAEMON_TASK_POLL_RUNTIME_ID,
    foreignRuntimeId: "rt_mul474_foreign",
    taskId: task.id,
    chatSessionId: chatSession.id,
    externalMessageId: DAEMON_TASK_POLL_EXTERNAL_MESSAGE_ID,
    daemonToken: owner.token,
    foreignDaemonToken: foreign.token,
    promptBytes: prompt.length,
  };
}

/**
 * The `status` body echoes `result`, `session_id` and `work_dir`, and the first of
 * those has three stored shapes in the wild: the current structured JSON, a bare
 * string from before the structured form, and a value that is not valid JSON at
 * all. A projection that only ever saw the running/`null` case could drop one of
 * the fallbacks without any test noticing, so each shape is its own case.
 *
 * The rows are written through `run` because these are exactly the raw column
 * values old releases left behind — producing them through today's store would
 * only re-create the structured shape.
 */
export interface DaemonTaskPollResultCase {
  label: string;
  taskId: string;
  /** Raw `result` column value. */
  result: string | null;
  /** Raw `session_id` / `work_dir` columns; null exercises the result fallback. */
  sessionId: string | null;
  workDir: string | null;
}

export const DAEMON_TASK_POLL_RESULT_CASES: ReadonlyArray<DaemonTaskPollResultCase> = [
  {
    label: "structured result, columns also set",
    taskId: "tsk_mul474_result_structured",
    result: JSON.stringify({
      pr_url: "https://example.invalid/mul474/structured",
      output: "structured output",
      session_id: "ises_structured_from_result",
      work_dir: "/tmp/mul474-structured-from-result",
    }),
    sessionId: "ises_mul474_column",
    workDir: "/tmp/mul474-column",
  },
  {
    label: "legacy bare string result",
    taskId: "tsk_mul474_result_legacy_string",
    result: "legacy plain text result",
    sessionId: null,
    workDir: null,
  },
  {
    label: "result that is not valid JSON",
    taskId: "tsk_mul474_result_invalid_json",
    result: "{not json at all",
    sessionId: null,
    workDir: null,
  },
  {
    label: "structured result with columns null (session/work_dir fall back)",
    taskId: "tsk_mul474_result_fallback",
    result: JSON.stringify({
      pr_url: "",
      output: "output without columns",
      session_id: "ises_from_result_only",
      work_dir: "/tmp/mul474-from-result-only",
    }),
    sessionId: null,
    workDir: null,
  },
];

/**
 * Seed one running Task per stored-result shape and return them. The caller
 * supplies the raw statement runner (SQLite for the counting test, the metered PG
 * handle for the benchmark).
 */
export async function seedDaemonTaskPollResultCases(
  store: MultiremiStore,
  run: (sql: string, params: unknown[]) => void,
): Promise<DaemonTaskPollResultCase[]> {
  const workspaceId = "local";
  const agent = store.createAgent({
    id: "agt_mul474_result_cases",
    name: "MUL-474 result cases",
    provider: "codex",
    workspaceId,
  });
  for (const testCase of DAEMON_TASK_POLL_RESULT_CASES) {
    // Each Task belongs to the fixture's existing poll Runtime, which its daemon
    // token already owns — otherwise the guard would (correctly) refuse these
    // requests before the projection under test ever runs.
    store.createTask({
      id: testCase.taskId,
      agentId: agent.id,
      workspaceId,
      runtimeId: DAEMON_TASK_POLL_RUNTIME_ID,
      prompt: "result case",
    });
    run(
      "UPDATE multiremi_tasks SET result = ?, session_id = ?, work_dir = ?, started_at = ? WHERE id = ?",
      [testCase.result, testCase.sessionId, testCase.workDir, "2026-09-27T00:00:00.000Z", testCase.taskId],
    );
  }
  return DAEMON_TASK_POLL_RESULT_CASES.map((testCase) => ({ ...testCase }));
}
