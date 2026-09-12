import { afterEach, describe, expect, it } from "bun:test";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import type { TaskStreamEvent, TaskStreamingHandler } from "@connectors/base.js";
import type { ParsedFeishuMessage } from "@connectors/feishu/receive.js";

const sessions: FeishuStreamingSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.detach(); });

function message(chatType: "group" | "p2p", senderOpenId: string): ParsedFeishuMessage {
  return { text: "Any progress?", rawContent: "Any progress?", chatId: "oc_chat", messageId: "om_question",
    chatType, senderOpenId, senderUserId: "", senderUnionId: "", senderTenantKey: "", senderName: "Sender",
    mentionedBot: false, monitored: chatType === "group", media: [], rootId: chatType === "group" ? "om_topic" : undefined };
}

async function* events(): AsyncGenerator<TaskStreamEvent> {
  yield { kind: "snapshot", snapshot: { taskId: "tsk_reply", status: "completed", result: "Answer",
    sessionId: "provider_session", error: null, workDir: "/tmp/chat", usage: [] } };
}

function harness() {
  const cards: any[] = [];
  const errors: string[] = [];
  let sends = 0;
  const capture = async (input: any) => {
    sends++;
    cards.push(JSON.parse(input.data.content));
    return { code: 0, data: { message_id: "om_reply" } };
  };
  const client = { im: { message: {
    create: capture, reply: capture,
    patch: async (input: any) => { cards.push(JSON.parse(input.data.content)); return { code: 0 }; },
  } } };
  const credentials = { appId: "cli_test", appSecret: "test-secret" };
  const channel = new FeishuChannel(credentials);
  (channel as any)._makeClient = () => client;
  channel.addReaction = async () => undefined;
  channel.sendText = async (_chatId, text) => { errors.push(text); };
  channel.createStream = () => {
    const session = new FeishuStreamingSession(client as any, credentials, { log: () => {} });
    sessions.push(session);
    return session;
  };
  const handler: TaskStreamingHandler = async (_message, _sessionKey, consumer) => {
    await consumer(events(), { taskId: "tsk_reply", displayName: "Remi",
      respondHumanRequest: async () => { throw new Error("not expected"); } });
  };
  const connector = Object.create(FeishuConnector.prototype) as any;
  Object.assign(connector, { _channel: channel, _groupPolicy: { getByChatId: () => null }, _taskStreamHandler: handler });
  return { connector, channel, cards, errors, sends: () => sends };
}

describe("Feishu card sender mention", () => {
  it("does not present static response billing as current context", () => {
    const h = harness();
    expect(h.connector._formatStats({ durationMs: 54000, inputTokens: 880000, outputTokens: 3000 })).toBe("54s");
    expect(h.connector._formatStats({ durationMs: 54000, inputTokens: 880000, outputTokens: 3000,
      metadata: { contextUsage: { used: 82000, size: 200000 } } })).toBe("54s · 82k/200k");
  });

  it("carries the group message sender through the Task channel into the card footer", async () => {
    const h = harness();
    await h.connector._handleFeishuMessage(message("group", "ou_alice"));
    expect(h.errors).toEqual([]);
    expect(h.sends()).toBe(1);
    expect(h.cards).toHaveLength(1);
    expect(h.cards.at(-1).body.elements.at(-1).columns[0].elements[0].content).toBe("<at id=ou_alice></at>");
  });

  it("uses each message's sender rather than a previous participant", async () => {
    const h = harness();
    await h.connector._handleFeishuMessage(message("group", "ou_alice"));
    await h.connector._handleFeishuMessage(message("group", "ou_bob"));
    expect(h.sends()).toBe(2);
    const secondCards = h.cards.slice(-1);
    expect(secondCards).toHaveLength(1);
    expect(h.cards.at(-1).body.elements.at(-1).columns[0].elements[0].content).toBe("<at id=ou_bob></at>");
    expect(JSON.stringify(secondCards)).not.toContain("ou_alice");
  });

  for (const [chatType, sender] of [["p2p", "ou_alice"], ["group", ""], ["group", "all"], ["group", "ou_x><at id=all"]] as const) {
    it(`does not invent a mention for ${chatType} with sender ${JSON.stringify(sender)}`, async () => {
      const h = harness();
      await h.connector._handleFeishuMessage(message(chatType, sender));
      expect(h.errors).toEqual([]);
      expect(h.sends()).toBe(1);
      expect(JSON.stringify(h.cards)).not.toContain("<at ");
    });
  }

  it("also forwards the sender in the legacy ACP reply path", async () => {
    const h = harness();
    const mentions: Array<string | undefined> = [];
    h.connector._taskStreamHandler = undefined;
    h.connector._handler = async () => ({ text: "Answer" });
    h.connector._streamHandler = async (_incoming: unknown, consume: (stream: unknown, meta: unknown) => Promise<void>) => {
      await consume([], { agentType: "claude" });
    };
    h.channel.handleStream = async (_chat, _session, _stream, _meta, options) => { mentions.push(options.mentionOpenId); };
    await h.connector._handleFeishuMessage(message("group", "ou_alice"));
    expect(h.errors).toEqual([]);
    expect(mentions).toEqual(["ou_alice"]);
  });

  it("forwards the sender to static card replies without another notification", async () => {
    const h = harness();
    const mentions: Array<string | undefined> = [];
    h.connector._taskStreamHandler = undefined;
    h.connector._handler = async () => ({ text: "Answer" });
    h.connector._sendStaticReply = async (_chat: string, _reply: unknown, _parent: string, sender: string | undefined) => {
      mentions.push(sender);
    };
    await h.connector._handleFeishuMessage(message("group", "ou_alice"));
    expect(h.errors).toEqual([]);
    expect(mentions).toEqual(["ou_alice"]);
  });
});
