/**
 * Daemon-side Feishu command routing (MUL-358).
 *
 * Covers the two failure modes that produced stray Issues: `/stop` from the
 * Feishu CoT stop control was filed as new work, and every command sent in a
 * group missed because the connector's speaker prefix was matched instead of
 * the raw body.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { IncomingMessage, TaskStreamEvent, TaskStreamMeta } from "@connectors/base.js";
import { createFeishuTaskHandler } from "../../../apps/remi/cli/multiremi.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";
const CHAT = "oc_command_group";
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

function scaffold(): { store: MultiremiStore; revision: number } {
  const store = createLocalStore();
  const owner = store.getCurrentUser();
  store.getOrCreateUser({
    externalId: "ou_handler_owner", feishuUnionId: "on_handler_owner",
    email: owner.email, name: "Workspace Owner",
  });
  const agent = store.createAgent({
    name: "Remi", provider: "codex", workspaceId: "local", maxConcurrentTasks: 4,
  });
  store.registerRuntime({
    id: "rt_bot", name: "Bot host", provider: "codex", workspaceId: "local",
    daemonId: "bot-host", maxConcurrency: 4,
  });
  store.heartbeatRuntime("rt_bot", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id, runtimeId: "rt_bot", appId: "cli_handler",
    senderAccessPolicy: "agent", appSecretOp: "set", appSecret: APP_SECRET,
    domain: "feishu", enabled: true,
  });
  return { store, revision: config.revision };
}

function handler(store: MultiremiStore, revision: number) {
  const daemon = {
    submitFeishuBotMessage: async (input: Parameters<MultiremiDaemon["submitFeishuBotMessage"]>[0]) =>
      store.submitFeishuBotMessage("local", "rt_bot", input),
    cancelFeishuBotSessionTask: async (
      rev: number, key: string,
      options?: { chatId?: string | null; senderOpenId?: string | null; target?: string | null },
    ) => store.cancelFeishuBotSessionTask("local", "rt_bot", rev, key, options),
    inspectFeishuBotSession: async (rev: number, key: string) =>
      store.inspectFeishuBotSession("local", "rt_bot", rev, key),
    resetFeishuBotSession: async (rev: number, key: string) =>
      store.resetFeishuBotSession("local", "rt_bot", rev, key),
    getFeishuBotHumanRequest: async () => null,
    respondFeishuBotHumanRequest: async () => { throw new Error("not expected"); },
    uploadFeishuBotAttachment: async () => { throw new Error("not expected"); },
    listFeishuBotTaskMessages: async () => [],
    getFeishuBotTaskSnapshot: async () => ({ taskId: "unused", status: "running", result: null,
      error: null, sessionId: null, workDir: null, usage: [] }),
  } as unknown as MultiremiDaemon;
  return createFeishuTaskHandler(daemon, revision, "Concierge");
}

/** Capture the reply card text the consumer renders, if any. */
async function run(
  handle: ReturnType<typeof handler>,
  message: IncomingMessage,
  sessionKey: string,
): Promise<{ meta: TaskStreamMeta[]; text: string[] }> {
  const meta: TaskStreamMeta[] = [];
  const text: string[] = [];
  await handle(message, sessionKey, async (stream) => {
    for await (const event of stream as AsyncIterable<TaskStreamEvent>) {
      if (event.kind === "message" && event.message.content) text.push(event.message.content);
    }
    meta.push({ taskId: "captured", respondHumanRequest: async () => { throw new Error("not expected"); } });
  });
  return { meta, text };
}

describe("Feishu Task command handler", () => {
  it("answers /stop without filing new work", async () => {
    const { store, revision } = scaffold();
    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision, externalSessionKey: `${CHAT}:thread:omt_live`, externalMessageId: "om_live",
      chatType: "group", chatId: CHAT, threadId: "omt_live",
      senderOpenId: "ou_owner", text: "long running work", deliveryMode: "native_cot_v1",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(submitted.taskId);
    store.startTask(submitted.taskId);

    const before = store.listTasks().length;
    const { meta, text } = await run(
      handler(store, revision),
      {
        chatId: CHAT,
        // Presentation text carries the speaker prefix; the raw body is clean.
        text: "贺华杰: /stop",
        metadata: {
          messageId: "om_button_click", chatType: "group", rootId: null,
          senderOpenId: "ou_owner", rawContent: "/stop",
        },
      },
      `${CHAT}:thread:omt_button_click`,
    );

    expect(meta).toHaveLength(1);
    expect(text.join("\n")).toContain("已请求停止");
    expect(store.getTask(submitted.taskId)?.status).toBe("cancelled");
    // A stop must not add a Task or an Issue.
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listIssues()).toHaveLength(0);
  });

  it("matches commands sent in a group despite the speaker prefix", async () => {
    const { store, revision } = scaffold();
    const before = store.listTasks().length;
    const { meta, text } = await run(
      handler(store, revision),
      {
        chatId: CHAT,
        text: "贺华杰: /new",
        metadata: { messageId: "om_new_group", chatType: "group", senderOpenId: "ou_owner", rawContent: "/new" },
      },
      `${CHAT}:thread:omt_new`,
    );
    // The command was recognised: a reply card exists and no Task was filed.
    // (The wording depends on whether a conversation existed yet, so match the
    // stable part of either answer.)
    expect(meta).toHaveLength(1);
    expect(text.join("\n").toLowerCase()).toContain("conversation");
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listIssues()).toHaveLength(0);
  });

  it("answers an unrecognised bare command instead of starting a Task", async () => {
    const { store, revision } = scaffold();
    const before = store.listTasks().length;
    const { text } = await run(
      handler(store, revision),
      {
        chatId: CHAT,
        text: "贺华杰: /clear",
        metadata: { messageId: "om_clear", chatType: "group", senderOpenId: "ou_owner", rawContent: "/clear" },
      },
      `${CHAT}:thread:omt_clear`,
    );
    expect(text.join("\n")).toContain("/clear");
    expect(text.join("\n")).toContain("Unsupported command");
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listIssues()).toHaveLength(0);
  });

  it("still submits a slash-prefixed request that is not a bare command", async () => {
    const { store, revision } = scaffold();
    const before = store.listTasks().length;
    const { meta } = await run(
      handler(store, revision),
      {
        chatId: CHAT,
        text: "贺华杰: /data00/home/x 看下",
        metadata: {
          messageId: "om_path", chatType: "group", senderOpenId: "ou_owner",
          rawContent: "/data00/home/x 看下",
        },
      },
      `${CHAT}:thread:omt_path`,
    );
    // A queued delivery hands off to the outbox, so the handler reports no
    // inline stream — but the Task exists.
    expect(meta).toHaveLength(0);
    expect(store.listTasks()).toHaveLength(before + 1);
  });

  it("reports a failure card when the cancel request cannot be made", async () => {
    const { store, revision } = scaffold();
    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision, externalSessionKey: `${CHAT}:thread:omt_fail`, externalMessageId: "om_fail",
      chatType: "group", chatId: CHAT, threadId: "omt_fail",
      senderOpenId: "ou_owner", text: "work that keeps running", deliveryMode: "native_cot_v1",
    });
    expect(store.claimTask("rt_bot")?.id).toBe(submitted.taskId);
    store.startTask(submitted.taskId);

    // The transport itself fails (an internal route answered 500).
    const daemon = {
      cancelFeishuBotSessionTask: async () => {
        throw new Error("GET /api/feishu-bot/session/cancel returned 500: internal error");
      },
    } as unknown as MultiremiDaemon;
    const handle = createFeishuTaskHandler(daemon, revision, "Concierge");
    const text: string[] = [];
    await handle(
      {
        chatId: CHAT,
        text: "贺华杰: /stop",
        metadata: {
          messageId: "om_fail_click", chatType: "group", senderOpenId: "ou_owner", rawContent: "/stop",
        },
      },
      `${CHAT}:thread:omt_fail_click`,
      async (stream) => {
        for await (const event of stream as AsyncIterable<TaskStreamEvent>) {
          if (event.kind === "message" && event.message.content) text.push(event.message.content);
        }
      },
    );

    const card = text.join("\n");
    // The user is told the request failed and that the Task may still be alive —
    // never that it stopped, and never a raw HTTP dump.
    expect(card).toContain("停止请求失败");
    expect(card).toContain("任务可能仍在运行");
    expect(card).toContain("服务端返回 500");
    expect(card).not.toContain("**Error:**");
    expect(card).not.toContain("returned 500: internal error");
    expect(store.getTask(submitted.taskId)?.status).toBe("running");
    expect(store.listIssues()).toHaveLength(0);
  });

  it("refuses an explicit target outside the sender's own candidates", async () => {
    const { store, revision } = scaffold();
    const submitted = store.submitFeishuBotMessage("local", "rt_bot", {
      revision, externalSessionKey: `${CHAT}:thread:omt_mine`, externalMessageId: "om_mine",
      chatType: "group", chatId: CHAT, threadId: "omt_mine",
      senderOpenId: "ou_owner", text: "my own work", deliveryMode: "native_cot_v1",
    });
    // The named Task belongs to someone else in this chat, so it is not in the
    // sender's candidate set and must not be stopped.
    const before = store.listTasks().length;
    const { text } = await run(
      handler(store, revision),
      {
        chatId: CHAT,
        text: "贺华杰: /stop tsk_someone_else",
        metadata: {
          messageId: "om_denied", chatType: "group", senderOpenId: "ou_other",
          rawContent: "/stop tsk_someone_else",
        },
      },
      `${CHAT}:thread:omt_denied`,
    );
    const card = text.join("\n");
    expect(card).toContain("没有停止任何任务");
    // The card's own wording, not a server sentence spliced into a Chinese
    // sentence: the user's target is echoed and the exit punctuation is one
    // sentence, not two.
    expect(card).toContain("tsk_someone_else 不是你在本群发起的未结束任务");
    expect(card).not.toContain("is not one of your unfinished tasks");
    expect(card).not.toMatch(/。\s*。/);
    // Untouched: the Task is still live, and no work was added or removed.
    expect(store.getTask(submitted.taskId)?.status).toBe("queued");
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listIssues()).toHaveLength(0);
  });

  it("reports no running task when one cannot be found", async () => {
    const { store, revision } = scaffold();
    const { text } = await run(
      handler(store, revision),
      {
        chatId: CHAT,
        text: "贺华杰: /stop",
        metadata: {
          messageId: "om_idle", chatType: "group", senderOpenId: "ou_owner", rawContent: "/stop",
        },
      },
      `${CHAT}:thread:omt_idle`,
    );
    expect(text.join("\n")).toContain("当前没有正在运行的任务");
    expect(store.listTasks()).toHaveLength(0);
    expect(store.listIssues()).toHaveLength(0);
  });
});
