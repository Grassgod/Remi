/**
 * Resolving a Feishu stop request against durable Tasks (MUL-358).
 *
 * The CoT "stop" control reaches the platform as a plain user IM message with
 * no thread lineage, so the store resolves it from the sender's own unfinished
 * Tasks and, when that is ambiguous, asks instead of guessing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const CHAT = "oc_stop_group";
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

function scaffold(): { store: MultiremiStore; agentId: string; revision: number } {
  const store = createLocalStore();
  const owner = store.getCurrentUser();
  store.getOrCreateUser({
    externalId: "ou_stop_owner",
    feishuUnionId: "on_stop_owner",
    email: owner.email,
    name: "Workspace Owner",
  });
  // Several concurrent runs are the situation this resolution has to cope
  // with, so the Agent must be allowed to hold more than one Task at a time.
  const agent = store.createAgent({
    name: "Remi", provider: "codex", workspaceId: "local", maxConcurrentTasks: 4,
  });
  store.registerRuntime({
    id: "rt_bot",
    name: "Bot host",
    provider: "codex",
    workspaceId: "local",
    daemonId: "bot-host",
    // The scenarios below run several Tasks at once, which the Agent and its
    // Runtime must both be willing to do.
    maxConcurrency: 4,
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: "rt_bot",
    appId: "cli_stop",
    senderAccessPolicy: "agent",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  return { store, agentId: agent.id, revision: config.revision };
}

/** Submit one group top-level message, which is how the stop button arrives. */
function submit(
  store: MultiremiStore,
  revision: number,
  input: { messageId: string; senderOpenId: string; sessionKey?: string; text?: string },
) {
  return store.submitFeishuBotMessage("local", "rt_bot", {
    revision,
    externalSessionKey: input.sessionKey ?? `${CHAT}:thread:${input.messageId}`,
    externalMessageId: input.messageId,
    chatType: "group",
    chatId: CHAT,
    threadId: `omt_${input.messageId}`,
    senderOpenId: input.senderOpenId,
    senderName: input.senderOpenId,
    text: input.text ?? "please work on this",
    deliveryMode: "native_cot_v1",
  });
}

/** Mark a submitted Task as actually running. */
function start(store: MultiremiStore, taskId: string, startedAt?: string) {
  expect(store.claimTask("rt_bot")?.id).toBe(taskId);
  store.startTask(taskId);
  if (startedAt) db!.run("UPDATE multiremi_tasks SET started_at = ? WHERE id = ?", [startedAt, taskId]);
}

describe("Feishu stop resolution", () => {
  it("cancels the Task bound to the requesting conversation key", () => {
    const { store, revision } = scaffold();
    const sessionKey = `${CHAT}:thread:omt_precise`;
    const submitted = submit(store, revision, {
      messageId: "om_precise", senderOpenId: "ou_owner", sessionKey,
    });
    start(store, submitted.taskId);

    const result = store.cancelFeishuBotSessionTask("local", "rt_bot", revision, sessionKey);
    expect(result).toMatchObject({ outcome: "cancelled", taskId: submitted.taskId });
    expect(store.getTask(submitted.taskId)?.status).toBe("cancelled");
  });

  it("cancels the sender's only unfinished Task when a group-top-level stop has no thread", () => {
    const { store, revision } = scaffold();
    const submitted = submit(store, revision, { messageId: "om_solo", senderOpenId: "ou_owner" });
    start(store, submitted.taskId);

    // The button's message is its own new thread root, so this key has no task.
    const result = store.cancelFeishuBotSessionTask(
      "local", "rt_bot", revision, `${CHAT}:thread:omt_button_click`,
      { chatId: CHAT, senderOpenId: "ou_owner" },
    );
    expect(result).toMatchObject({ outcome: "cancelled", taskId: submitted.taskId });
    expect(store.getTask(submitted.taskId)?.status).toBe("cancelled");
  });

  it("asks instead of guessing when the sender has several unfinished Tasks", () => {
    const { store, revision } = scaffold();
    const first = submit(store, revision, { messageId: "om_many_1", senderOpenId: "ou_owner" });
    start(store, first.taskId, "2026-09-21T15:00:00.000Z");
    const second = submit(store, revision, { messageId: "om_many_2", senderOpenId: "ou_owner" });
    start(store, second.taskId, "2026-09-21T15:10:00.000Z");

    const result = store.cancelFeishuBotSessionTask(
      "local", "rt_bot", revision, `${CHAT}:thread:omt_button_click`,
      { chatId: CHAT, senderOpenId: "ou_owner" },
    );
    expect(result.outcome).toBe("ambiguous");
    expect(result.candidateCount).toBe(2);
    expect(result.candidates.map((candidate) => candidate.taskId))
      .toEqual([second.taskId, first.taskId]);
    // Nothing was stopped and nothing new was created.
    expect(store.getTask(first.taskId)?.status).toBe("running");
    expect(store.getTask(second.taskId)?.status).toBe("running");
  });

  it("never resolves to another sender's Task", () => {
    const { store, revision } = scaffold();
    const submitted = submit(store, revision, { messageId: "om_mine", senderOpenId: "ou_owner" });
    start(store, submitted.taskId);

    const result = store.cancelFeishuBotSessionTask(
      "local", "rt_bot", revision, `${CHAT}:thread:omt_other_click`,
      { chatId: CHAT, senderOpenId: "ou_someone_else" },
    );
    expect(result).toMatchObject({ outcome: "none", taskId: null });
    expect(store.getTask(submitted.taskId)?.status).toBe("running");
  });

  it("reports none without writing anything when nothing is running", () => {
    const { store, revision } = scaffold();
    const tasksBefore = store.listTasks().length;
    const result = store.cancelFeishuBotSessionTask(
      "local", "rt_bot", revision, `${CHAT}:thread:omt_button_click`,
      { chatId: CHAT, senderOpenId: "ou_owner" },
    );
    expect(result).toMatchObject({ outcome: "none", taskId: null, candidateCount: 0 });
    expect(store.listTasks()).toHaveLength(tasksBefore);
    expect(store.listIssues()).toHaveLength(0);
  });

  it("is idempotent: a second stop finds nothing and creates nothing", () => {
    const { store, revision } = scaffold();
    const submitted = submit(store, revision, { messageId: "om_twice", senderOpenId: "ou_owner" });
    start(store, submitted.taskId);
    const key = `${CHAT}:thread:omt_button_click`;
    const options = { chatId: CHAT, senderOpenId: "ou_owner" };

    expect(store.cancelFeishuBotSessionTask("local", "rt_bot", revision, key, options).outcome)
      .toBe("cancelled");
    expect(store.cancelFeishuBotSessionTask("local", "rt_bot", revision, key, options).outcome)
      .toBe("none");
    expect(store.listTasks()).toHaveLength(1);
    expect(store.listIssues()).toHaveLength(0);
  });

  it("accepts an explicit target only inside the sender's own candidate set", () => {
    const { store, revision } = scaffold();
    const first = submit(store, revision, { messageId: "om_target_1", senderOpenId: "ou_owner" });
    start(store, first.taskId);
    const second = submit(store, revision, { messageId: "om_target_2", senderOpenId: "ou_owner" });
    start(store, second.taskId);

    const stopped = store.cancelFeishuBotSessionTask(
      "local", "rt_bot", revision, `${CHAT}:thread:omt_button_click`,
      { chatId: CHAT, senderOpenId: "ou_owner", target: first.taskId },
    );
    expect(stopped).toMatchObject({ outcome: "cancelled", taskId: first.taskId });
    expect(store.getTask(first.taskId)?.status).toBe("cancelled");
    expect(store.getTask(second.taskId)?.status).toBe("running");

    // Another sender may not stop the remaining Task by naming its id.
    const denied = store.cancelFeishuBotSessionTask(
      "local", "rt_bot", revision, `${CHAT}:thread:omt_other_click`,
      { chatId: CHAT, senderOpenId: "ou_someone_else", target: second.taskId },
    );
    expect(denied.outcome).toBe("rejected");
    expect(store.getTask(second.taskId)?.status).toBe("running");
  });

  it("cancels a parent together with its delegation without queuing a return Task", () => {
    const { store } = scaffold();
    const leader = store.createAgent({ name: "Leader", provider: "codex", workspaceId: "local" });
    const worker = store.createAgent({ name: "Worker", provider: "codex", workspaceId: "local" });
    const squad = store.createSquad({ name: "Delivery Squad", leaderId: leader.id, memberIds: [worker.id] });
    const issue = store.createIssue({
      title: "Delegated stop", workspaceId: "local", assigneeType: "squad", assigneeId: squad.id,
    });
    const leaderTask = store.createTask({
      agentId: leader.id, issueId: issue.id, prompt: "Lead the work.",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(leaderTask.id);
    store.buildTaskSessionProjection(leaderTask.id);
    store.startTask(leaderTask.id);
    store.createIssueComment(issue.id, {
      authorType: "agent", authorId: leader.id, taskId: leaderTask.id,
      body: `Please verify [@Worker](mention://agent/${worker.id})`,
    });
    const child = store.listTasksForIssue(issue.id).find((task) => task.agentId === worker.id)!;
    expect(child).toMatchObject({ status: "queued", delegatedByAgentId: leader.id });
    expect(child.parentTaskId).toBe(leaderTask.id);

    const queuedBefore = store.listTasks().filter((task) => task.status === "queued").length;
    const result = store.cancelTaskTree(leaderTask.id);

    expect(result.cancelled.map((task) => task.id).sort()).toEqual([leaderTask.id, child.id].sort());
    expect(store.getTask(leaderTask.id)?.status).toBe("cancelled");
    expect(store.getTask(child.id)?.status).toBe("cancelled");
    // A cancelled delegation must not wake its delegator, or stopping would
    // spawn a brand-new return Task instead of ending the work.
    expect(store.listTasks().filter((task) => task.status === "queued")).toHaveLength(queuedBefore - 1);
    expect(store.listTasksForIssue(issue.id)
      .filter((task) => task.delegationReturnTaskId === leaderTask.id)).toHaveLength(0);
  });
});
