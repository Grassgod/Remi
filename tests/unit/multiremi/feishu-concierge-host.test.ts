/**
 * The daemon-side host that actually boots the concierge channel (MUL-206).
 *
 * Sender identity is classified by the canonical Task bridge using union_id.
 * The connector only transports messages; it must not reject a sender by the
 * bot app's app-scoped open_id.
 */

import { describe, expect, it } from "bun:test";
import { attachControlPlaneConciergeHosts, controlPlaneConciergeHost } from "../../../apps/remi/cli/multiremi.js";
import type { FeishuConciergeHost } from "@multiremi/worker/feishu-concierge.js";
import type { bootFeishuChannel, FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type {
  MultiremiAgent,
  MultiremiFeishuBotOutboundDelivery,
  MultiremiTaskHumanRequest,
  MultiremiFeishuBotDaemonConfig,
} from "@multiremi/contracts/types.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import { DECISION_RECIPIENT_SENTINEL } from "@shared/feishu-task-card.js";
import { handleTaskInteractionEvent, interactionMarker } from "@connectors/feishu/task-interaction.js";
import type { MultiremiFeishuBotAssignment } from "@multiremi/worker/client.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

/** A delivery on one of the MUL-407 decision lanes. */
function decisionDelivery(
  overrides: Partial<MultiremiFeishuBotOutboundDelivery> & { kind: MultiremiFeishuBotOutboundDelivery["kind"] },
): MultiremiFeishuBotOutboundDelivery {
  return {
    id: "fbo_decision",
    claimToken: "lease",
    chatId: "oc_decision",
    threadId: "om_topic_root",
    replyToMessageId: "om_topic_root",
    body: "",
    bodyOrigin: "issue",
    idempotencyKey: "fbo_decision",
    humanRequestId: "hrq_1",
    ...overrides,
  };
}

/** A pending card carrying the sentinel the host is expected to resolve. */
function cardWithSentinel(): Record<string, unknown> {
  return {
    schema: "2.0",
    body: { elements: [
      { tag: "markdown", content: "**Continue?**" },
      { tag: "markdown", content: `<at id=${DECISION_RECIPIENT_SENTINEL}></at>` },
    ] },
  };
}

function assignment(overrides: Partial<MultiremiFeishuBotDaemonConfig> = {}): MultiremiFeishuBotAssignment {
  return {
    config: {
      workspace_id: "ws_configured",
      runtime_id: "rt_a",
      agent_id: "agt_1",
      revision: 4,
      desired_state: "running",
      app_id: "cli_a1b2c3d4e5f6g7h8",
      app_secret: APP_SECRET,
      domain: "feishu",
      ...overrides,
    },
    agent: { id: "agt_1", name: "Concierge" } as MultiremiAgent,
  };
}

interface FakeDaemon {
  daemon: MultiremiDaemon;
  botMenuPublishers: unknown[];
  failures: unknown[];
}

function fakeDaemon(): FakeDaemon {
  const botMenuPublishers: unknown[] = [];
  const failures: unknown[] = [];
  const daemon = {
    localPort: () => 4242,
    ensureTopicWorkspace: async () => null,
    // Recovery runs on every start; default to "no cards to restore".
    listFeishuBotDecisionCards: async () => [],
    setBotMenuPublisher: (publisher: unknown) => { botMenuPublishers.push(publisher); },
    reportFeishuConciergeFailure: async (error: unknown) => { failures.push(error); },
  } as unknown as MultiremiDaemon;
  return { daemon, botMenuPublishers, failures };
}

type BootArgs = Parameters<typeof bootFeishuChannel>;

interface BootCall {
  authorize: BootArgs[0];
  options: BootArgs[1];
}

/** A channel handle whose run promise the test controls. */
function fakeChannel(): {
  handle: FeishuChannelHandle;
  fail: (error: unknown) => void;
  stops: () => number;
  sent: Array<{ chatId: string; idempotencyKey: string }>;
  uploads: Buffer[];
} {
  let stops = 0;
  const sent: Array<{ chatId: string; idempotencyKey: string }> = [];
  const uploads: Buffer[] = [];
  let fail!: (error: unknown) => void;
  const start = new Promise<void>((_resolve, reject) => { fail = reject; });
  return {
    handle: {
      appId: "cli_a1b2c3d4e5f6g7h8",
      start,
      stop: async () => { stops += 1; },
      publishBotMenu: async () => ({ dryRun: true, defaultPublished: false, userMenuCount: 0 }),
      sendProactiveThreadReply: async (input: { chatId: string; idempotencyKey: string }) => {
        sent.push({ chatId: input.chatId, idempotencyKey: input.idempotencyKey });
        return { messageId: "om_proactive" };
      },
      uploadImage: async (image: Buffer) => {
        uploads.push(image);
        return { imageKey: "img_uploaded" };
      },
    } as unknown as FeishuChannelHandle,
    fail,
    stops: () => stops,
    sent,
    uploads,
  };
}

function host(input: {
  daemon?: MultiremiDaemon | undefined;
  workspacesRoot?: string | undefined;
}) {
  const calls: BootCall[] = [];
  let current: FeishuChannelHandle | null = null;
  const channel = fakeChannel();
  const boot: typeof bootFeishuChannel = async (authorize, options) => {
    calls.push({ authorize, options });
    return channel.handle;
  };
  const conciergeHost = controlPlaneConciergeHost({
    daemon: () => input.daemon,
    workspacesRoot: () => ("workspacesRoot" in input ? input.workspacesRoot : "/tmp/workspaces"),
    current: () => current,
    attach: (handle) => { current = handle; },
    boot,
  });
  return { conciergeHost, calls, channel, current: () => current };
}

describe("control-plane Feishu concierge host", () => {
  it("hosts either co-resident provider without letting a sibling stop or detach its channel", async () => {
    const daemons = [fakeDaemon(), fakeDaemon()];
    const hosts: FeishuConciergeHost[] = [];
    const shutdowns = [0, 0];
    for (const [index, test] of daemons.entries()) {
      Object.assign(test.daemon, {
        localPort: () => 4242 + index,
        setFeishuConciergeHost: (host: FeishuConciergeHost) => { hosts[index] = host; },
        shutdownFeishuConcierge: async () => {
          shutdowns[index]!++;
          await hosts[index]!.stop();
        },
      });
    }
    const channels: ReturnType<typeof fakeChannel>[] = [];
    const ports: number[] = [];
    const stop = attachControlPlaneConciergeHosts(daemons.map(test => test.daemon), {
      workspacesRoot: () => "/tmp/workspaces",
      boot: async (_authorize, options) => {
        ports.push(options!.daemonPort!);
        const channel = fakeChannel();
        channels.push(channel);
        return channel.handle;
      },
    });
    expect(hosts).toHaveLength(2);
    // Codex is normally the second daemon; it must boot using its own port.
    await hosts[1]!.start(assignment({ runtime_id: "rt_codex" }));
    await hosts[0]!.stop();
    expect(channels[0]!.stops()).toBe(0);
    expect(await hosts[1]!.uploadImage!(Buffer.from("codex image"))).toEqual({ imageKey: "img_uploaded" });
    // Simulate the control plane's stopped-before-started handover to Claude.
    await hosts[1]!.stop();
    await hosts[0]!.start(assignment({ runtime_id: "rt_claude" }));
    channels[0]!.fail(new Error("late failure from the stopped Codex channel"));
    await Promise.resolve();
    await hosts[1]!.stop();
    expect(channels[1]!.stops()).toBe(0);
    expect(await hosts[0]!.uploadImage!(Buffer.from("claude image"))).toEqual({ imageKey: "img_uploaded" });
    expect(ports).toEqual([4243, 4242]);
    expect(daemons.flatMap(test => test.failures)).toEqual([]);
    await Promise.all([stop(), stop()]);
    expect(shutdowns).toEqual([1, 1]);
    expect(channels.map(channel => channel.stops())).toEqual([1, 1]);
  });

  it("routes a private Task to the main chat without inventing a thread session key", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    let sends = 0;
    test.channel.handle.streamProactiveTask = async (chatId, sessionKey, _stream, _meta, options) => {
      sends++;
      expect(chatId).toBe("oc_private");
      expect(sessionKey).toBe("oc_private");
      expect(options.replyToMessageId).toBeUndefined();
      expect(options.receiptMessageIds).toEqual(["om_original"]);
      expect(options.interactionOpenId).toBe("ou_requester");
      return { messageId: "om_result" };
    };
    await test.conciergeHost.sendOutbound!({ id: "fbo_private", claimToken: "lease", chatId: "oc_private",
      threadId: null, replyToMessageId: null, body: "", bodyOrigin: "agent", taskId: "tsk_private",
      idempotencyKey: "fbo_private", receiptMessageIds: ["om_original"], interactionOpenId: "ou_requester",
      mention: { mode: "none", resolvedOpenId: null } }, {
      signal: new AbortController().signal, onStarted: async () => {},
    });
    expect(sends).toBe(1);
  });

  it("opens without a session and reads the final provider session once on closed", async () => {
    const { daemon } = fakeDaemon();
    let reads = 0;
    Object.assign(daemon, {
      subscribeTrace: async (_taskId: string, fromSeq: number, onEvents: Parameters<MultiremiDaemon["subscribeTrace"]>[2]) => {
        expect(fromSeq).toBe(0);
        expect(reads).toBe(0);
        await onEvents([], true);
        return async () => {};
      },
      getFeishuBotTaskSnapshot: async () => {
        reads++;
        return { taskId: "tsk_private", status: "completed", result: "done", error: null,
          sessionId: "sess_pinned", workDir: null, usage: [] };
      },
    });
    const test = host({ daemon });
    await test.conciergeHost.start(assignment());
    const observed: Array<string | null> = [];
    let metaSessionId: string | null | undefined = "not observed";
    test.channel.handle.streamProactiveTask = async (_chat, _session, stream, meta) => {
      metaSessionId = meta.sessionId;
      for await (const event of stream) if (event.kind === "snapshot") observed.push(event.snapshot.sessionId);
      return { messageId: "om_result" };
    };
    await test.conciergeHost.sendOutbound!({ id: "fbo_private", claimToken: "lease", chatId: "oc_private",
      threadId: null, replyToMessageId: null, body: "", bodyOrigin: "agent", taskId: "tsk_private",
      idempotencyKey: "fbo_private", mention: { mode: "none", resolvedOpenId: null } },
      { signal: new AbortController().signal, onStarted: async () => {} });
    // `null`, not `undefined`: the card starts as a newborn, not a bare agent name.
    expect(metaSessionId).toBeNull();
    expect(observed).toEqual(["sess_pinned"]);
    expect(reads).toBe(1);
  });

  it("checkpoints a group owner before sending through the existing Task card", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const sequence: string[] = [];
    test.channel.handle.resolveProactiveMention = async (chatId, mention) => {
      sequence.push("resolve");
      expect(chatId).toBe("oc_topic");
      expect(mention).toEqual({ mode: "group_owner" });
      return "ou_candidate";
    };
    test.channel.handle.streamProactiveTask = async (_chat, _session, _stream, _meta, options) => {
      sequence.push("card");
      expect(options.mentionOpenId).toBe("ou_saved");
      await options.onStarted!("om_card");
      return { messageId: "om_card" };
    };
    const delivery = { id: "fbo_owner", claimToken: "lease", chatId: "oc_topic", threadId: "om_root",
      replyToMessageId: "om_root", body: "", bodyOrigin: "agent" as const, taskId: "tsk_owner", idempotencyKey: "fbo_owner",
      mention: { mode: "group_owner" as const } };
    await test.conciergeHost.sendOutbound!(delivery, {
      signal: new AbortController().signal,
      prepareMention: async id => { sequence.push("checkpoint"); expect(id).toBe("ou_candidate"); return "ou_saved"; },
      onStarted: async () => { sequence.push("started"); },
    });
    expect(sequence).toEqual(["resolve", "checkpoint", "card", "started"]);
    expect(test.channel.sent).toHaveLength(0);
    sequence.length = 0;
    await test.conciergeHost.sendOutbound!({ ...delivery, resumeMessageId: "om_card", mention: { mode: "group_owner", resolvedOpenId: "ou_saved" } }, {
      signal: new AbortController().signal, onStarted: async () => { sequence.push("started"); },
    });
    expect(sequence).toEqual(["card", "started"]);
  });

  it("does not send a card when the recipient checkpoint loses its lease", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    test.channel.handle.resolveProactiveMention = async () => "ou_owner";
    let sends = 0;
    test.channel.handle.streamProactiveTask = async () => { sends++; return { messageId: "om_card" }; };
    await expect(test.conciergeHost.sendOutbound!({ id: "fbo_owner", claimToken: "lease", chatId: "oc_topic", threadId: "om_root",
      replyToMessageId: "om_root", body: "", bodyOrigin: "agent", taskId: "tsk_owner", idempotencyKey: "fbo_owner",
      mention: { mode: "group_owner" } }, { signal: new AbortController().signal,
      prepareMention: async () => { throw new Error("stale lease"); }, onStarted: async () => {} })).rejects.toThrow("stale lease");
    expect(sends).toBe(0);
  });

  it("still sends the report when the saved recipient is absent", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    test.channel.handle.resolveProactiveMention = async () => null;
    let sends = 0;
    test.channel.handle.streamProactiveTask = async (_chat, _session, _stream, _meta, options) => {
      sends++;
      expect(options.mentionOpenId).toBeUndefined();
      return { messageId: "om_card" };
    };
    await test.conciergeHost.sendOutbound!({ id: "fbo_owner", claimToken: "lease", chatId: "oc_topic", threadId: "om_root",
      replyToMessageId: "om_root", body: "", bodyOrigin: "agent", taskId: "tsk_owner", idempotencyKey: "fbo_owner",
      mention: { mode: "group_owner" } }, { signal: new AbortController().signal,
      prepareMention: async id => { expect(id).toBeNull(); return null; }, onStarted: async () => {} });
    expect(sends).toBe(1);
  });

  it("streams an existing proactive Task instead of sending only its final body", async () => {
    const fake = fakeDaemon();
    const reads: number[] = [];
    Object.assign(fake.daemon, {
      subscribeTrace: async (_id: string, fromSeq: number, onEvents: Parameters<MultiremiDaemon["subscribeTrace"]>[2]) => {
        reads.push(fromSeq);
        await onEvents([{ seq: 1, ts: "2026-09-28T00:00:00Z", type: "tool_use", tool: "Bash" }], true);
        return async () => {};
      },
      getFeishuBotTaskSnapshot: async () => ({ taskId: "tsk_live", status: "completed", result: "done", usage: [] }),
    });
    const test = host({ daemon: fake.daemon });
    const events: unknown[] = [];
    test.channel.handle.streamProactiveTask = async (chatId, _sessionKey, stream, meta, options) => {
      expect(chatId).toBe("oc_topic");
      expect(meta.taskId).toBe("tsk_live");
      expect(options.durable).toEqual({ idempotencyKey: "fbo_live", messageId: "om_existing" });
      await options.onStarted!("om_existing");
      for await (const event of stream) events.push(event);
      return { messageId: "om_existing" };
    };
    await test.conciergeHost.start(assignment());
    const checkpoints: string[] = [];
    await test.conciergeHost.sendOutbound!({ id: "fbo_live", claimToken: "lease", chatId: "oc_topic", threadId: "om_root",
      replyToMessageId: "om_root", body: "", bodyOrigin: "agent", taskId: "tsk_live", resumeMessageId: "om_existing",
      idempotencyKey: "fbo_live" }, { signal: new AbortController().signal, onStarted: async id => { checkpoints.push(id); } });
    expect(test.channel.sent).toHaveLength(0);
    expect(checkpoints).toEqual(["om_existing"]);
    expect(reads).toEqual([0]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ type: "tool_use" }) }),
      expect.objectContaining({ kind: "snapshot", snapshot: expect.objectContaining({ status: "completed" }) }),
    ]);
  });

  it("replays canonical trace from zero while retaining the presentation checkpoint", async () => {
    const fake = fakeDaemon();
    const cursors: number[] = [];
    const received: number[] = [];
    Object.assign(fake.daemon, {
      subscribeTrace: async (_id: string, fromSeq: number, onEvents: Parameters<MultiremiDaemon["subscribeTrace"]>[2]) => {
        cursors.push(fromSeq);
        await onEvents([{ seq: fromSeq + 1, ts: "2026-09-28T00:00:00Z", type: "thinking", content: "resumed" }], true);
        return async () => {};
      },
      getFeishuBotTaskSnapshot: async () => ({ taskId: "tsk_resume", status: "completed", result: "done", usage: [] }),
    });
    const test = host({ daemon: fake.daemon });
    test.channel.handle.resolveProactiveMention = async () => null;
    test.channel.handle.streamProactiveTask = async (_chat, _session, stream, _meta, options) => {
      expect(options.durable?.presentation?.throughSeq).toBe(7);
      for await (const event of stream) if (event.kind === "message") received.push(event.message.seq);
      return { messageId: "om_existing" };
    };
    await test.conciergeHost.start(assignment());
    await test.conciergeHost.sendOutbound!({ id: "fbo_resume", claimToken: "lease", chatId: "oc_topic", threadId: "om_root",
      replyToMessageId: "om_root", body: "", bodyOrigin: "agent", taskId: "tsk_resume", resumeMessageId: "om_existing",
      idempotencyKey: "fbo_resume", presentation: { version: "native_cot_v1", startedAt: 1, throughSeq: 7, interactions: {} } },
      { signal: new AbortController().signal, onStarted: async () => {} });
    expect(cursors).toEqual([0]);
    expect(received).toEqual([1]);
  });

  it("applies live no-mention settings to exactly the configured group", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    test.conciergeHost.setNoMentionChatIds!(["oc_topics"]);
    await test.conciergeHost.start(assignment());
    const policy = test.calls[0]!.options.groupPolicy!;
    expect(policy.getByChatId("oc_topics")).toEqual({ monitor: true, replyMode: "thread" });
    expect(policy.getByChatId("oc_other")).toBeNull();
    test.conciergeHost.setNoMentionChatIds!(["oc_new"]);
    expect(policy.getByChatId("oc_topics")).toBeNull();
    expect(policy.getByChatId("oc_new")?.monitor).toBe(true);
    test.conciergeHost.setNoMentionChatIds!([]);
    expect(policy.getByChatId("oc_new")).toBeNull();
  });

  it("routes proactive delivery through the running connector handle", async () => {
    const fake = fakeDaemon();
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment());

    const result = await test.conciergeHost.sendOutbound!({
      id: "fbo_host",
      claimToken: "claim_host",
      chatId: "oc_host",
      threadId: "omt_host",
      replyToMessageId: "om_root",
      body: "Round complete.",
      bodyOrigin: "agent",
      idempotencyKey: "fbo_host",
    });

    expect(result).toEqual({ messageId: "om_proactive" });
    expect(test.channel.sent).toEqual([{ chatId: "oc_host", idempotencyKey: "fbo_host" }]);
  });

  it("routes image uploads through the running connector handle", async () => {
    const fake = fakeDaemon();
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment());

    await expect(test.conciergeHost.uploadImage!(Buffer.from("png")))
      .resolves.toEqual({ imageKey: "img_uploaded" });
    expect(test.channel.uploads).toEqual([Buffer.from("png")]);
  });

  it("admits senders for server-side union_id classification", async () => {
    const fake = fakeDaemon();
    const test = host({ daemon: fake.daemon });

    const result = await test.conciergeHost.start(assignment());

    expect(result).toEqual({ botName: "Concierge" });
    expect(test.calls).toHaveLength(1);
    const authorized = await test.calls[0]!.authorize("ou_stranger");
    expect(authorized).toBe(true);
  });

  it("refuses to boot without the canonical Task bridge", async () => {
    const noDaemon = host({ daemon: undefined });
    await expect(noDaemon.conciergeHost.start(assignment())).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(noDaemon.calls).toHaveLength(0);

    const fake = fakeDaemon();
    const noRoot = host({ daemon: fake.daemon, workspacesRoot: undefined });
    await expect(noRoot.conciergeHost.start(assignment())).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(noRoot.calls).toHaveLength(0);
  });

  it("hands the assignment's credentials to the channel instead of the machine's env", async () => {
    const fake = fakeDaemon();
    const test = host({ daemon: fake.daemon });

    await test.conciergeHost.start(assignment({
      domain: "lark",
    }));

    expect(test.calls[0]!.options).toMatchObject({
      daemonPort: 4242,
      workspacesRoot: "/tmp/workspaces",
      credentials: {
        appId: "cli_a1b2c3d4e5f6g7h8",
        appSecret: APP_SECRET,
        domain: "lark",
      },
    });
    // The menu publisher follows the live channel, so a publish from Workspace
    // settings reaches the bot that is actually running.
    expect(fake.botMenuPublishers.at(-1)).toBeFunction();
  });

  it("reports a channel that dies on its own", async () => {
    // Without this the settings page keeps showing `online` for a bot that
    // stopped answering, and nothing ever restarts it.
    const fake = fakeDaemon();
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment());

    test.channel.fail(new Error("websocket closed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.failures).toHaveLength(1);
    expect((fake.failures[0] as Error).message).toBe("websocket closed");
    expect(test.current()).toBeNull();
    expect(fake.botMenuPublishers.at(-1)).toBeNull();
  });

  it("detaches the channel on stop so a handover can complete", async () => {
    const fake = fakeDaemon();
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment());

    await test.conciergeHost.stop();

    expect(test.channel.stops()).toBe(1);
    expect(test.current()).toBeNull();
    expect(fake.botMenuPublishers.at(-1)).toBeNull();
  });

  it("resolves the topic owner into the decision card before sending it", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const cards: Array<{ chatId: string; replyToMessageId?: string; card: Record<string, unknown> }> = [];
    const receipts: Array<{ messageId: string; interactionOpenId?: string | null; degraded?: string | null }> = [];
    test.channel.handle.resolveProactiveMention = async () => "ou_group_owner";
    test.channel.handle.sendProactiveCard = async (input) => {
      cards.push({ chatId: input.chatId, replyToMessageId: input.replyToMessageId, card: input.card });
      return { messageId: "om_card" };
    };
    await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card",
      body: JSON.stringify({ card: cardWithSentinel(), fallback_text: "问题：继续吗？" }),
    }), {
      signal: new AbortController().signal, onStarted: async () => {},
      onDecisionSent: async receipt => { receipts.push(receipt); },
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]!.chatId).toBe("oc_decision");
    expect(cards[0]!.replyToMessageId).toBe("om_topic_root");
    const rendered = JSON.stringify(cards[0]!.card);
    expect(rendered).toContain("<at id=ou_group_owner></at>");
    expect(rendered).not.toContain("__remi_decision_recipient__");
    // The recipient the card actually used is checkpointed with the send.
    expect(receipts).toEqual([{ messageId: "om_card", interactionOpenId: "ou_group_owner", degraded: null }]);
  });

  it("degrades a rejected decision card to its text twin instead of retrying it", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const replies: string[] = [];
    const receipts: Array<{ messageId: string; interactionOpenId?: string | null; degraded?: string | null }> = [];
    test.channel.handle.resolveProactiveMention = async () => "ou_group_owner";
    test.channel.handle.sendProactiveCard = async () => {
      // A permanent rejection: retrying the same payload cannot succeed.
      throw new FeishuDeliveryError("Feishu card send: Feishu code 99991672", false);
    };
    test.channel.handle.sendProactiveThreadReply = async (input: { body: string }) => {
      replies.push(input.body);
      return { messageId: "om_fallback" };
    };
    const sent = await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card",
      body: JSON.stringify({ card: cardWithSentinel(), fallback_text: "**MUL-1 - 问题**\n\n1. 继续" }),
    }), {
      signal: new AbortController().signal, onStarted: async () => {},
      onDecisionSent: async receipt => { receipts.push(receipt); },
    });

    expect(sent).toEqual({ messageId: "om_fallback" });
    expect(replies).toEqual(["<at id=ou_group_owner></at> **MUL-1 - 问题**\n\n1. 继续"]);
    // The control plane must learn it degraded, or it would later PATCH a card
    // that does not exist.
    expect(receipts).toEqual([{ messageId: "om_fallback", interactionOpenId: "ou_group_owner", degraded: "send_failed" }]);
  });

  it("sends text when the group owner cannot be resolved at all", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const replies: string[] = [];
    const receipts: Array<{ messageId: string; interactionOpenId?: string | null; degraded?: string | null }> = [];
    let cardsSent = 0;
    test.channel.handle.resolveProactiveMention = async () => null;
    test.channel.handle.sendProactiveCard = async () => { cardsSent += 1; return { messageId: "om_card" }; };
    test.channel.handle.sendProactiveThreadReply = async (input: { body: string }) => {
      replies.push(input.body);
      return { messageId: "om_no_recipient" };
    };
    const sent = await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card",
      body: JSON.stringify({ card: cardWithSentinel(), fallback_text: "**MUL-1 - 问题**\n\n1. 继续" }),
    }), {
      signal: new AbortController().signal, onStarted: async () => {},
      onDecisionSent: async receipt => { receipts.push(receipt); },
    });

    // No card: a card nobody can press is worse than the plain question.
    expect(cardsSent).toBe(0);
    expect(sent).toEqual({ messageId: "om_no_recipient" });
    expect(replies).toEqual(["**MUL-1 - 问题**\n\n1. 继续"]);
    expect(receipts).toEqual([{ messageId: "om_no_recipient", interactionOpenId: null, degraded: "unresolved_recipient" }]);
    // No @ to a person who was never identified.
    expect(replies[0]).not.toContain("<at id=");
  });

  it("sends text for a request the control plane already marked unaddressable", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const replies: string[] = [];
    let cardsSent = 0;
    let mentionLookups = 0;
    test.channel.handle.resolveProactiveMention = async () => { mentionLookups += 1; return "ou_group_owner"; };
    test.channel.handle.sendProactiveCard = async () => { cardsSent += 1; return { messageId: "om_card" }; };
    test.channel.handle.sendProactiveThreadReply = async (input: { body: string }) => {
      replies.push(input.body);
      return { messageId: "om_degraded" };
    };
    const sent = await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card",
      degraded: "notify_none",
      // A degraded row carries plain text, not an envelope.
      body: "**MUL-1 - 问题**\n\n1. 继续",
    }), { signal: new AbortController().signal, onStarted: async () => {} });

    expect(sent).toEqual({ messageId: "om_degraded" });
    expect(cardsSent).toBe(0);
    // No lookup: the control plane already decided there is nobody to ask.
    expect(mentionLookups).toBe(0);
    expect(replies).toEqual(["**MUL-1 - 问题**\n\n1. 继续"]);
  });

  it("lets a retryable card failure reach the outbox backoff", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    test.channel.handle.resolveProactiveMention = async () => "ou_group_owner";
    test.channel.handle.sendProactiveCard = async () => {
      throw new FeishuDeliveryError("Feishu card send: Feishu code 99991400", true);
    };
    let textFallbacks = 0;
    test.channel.handle.sendProactiveThreadReply = async () => {
      textFallbacks += 1;
      return { messageId: "om_fallback" };
    };
    await expect(test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card",
      body: JSON.stringify({ card: cardWithSentinel(), fallback_text: "问题" }),
    }), { signal: new AbortController().signal, onStarted: async () => {} })).rejects.toThrow(/99991400/);
    expect(textFallbacks).toBe(0);
  });

  it("B2: the terminal PATCH carries the real card, never an empty one", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    // Records exactly what the fake Feishu client is asked to PUT on the wire.
    const patches: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    test.channel.handle.updateProactiveCard = async (messageId, card) => {
      patches.push({ messageId, card: { ...card } });
    };
    const terminalCard = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "Concierge  09:00" } },
      body: { elements: [
        { tag: "markdown", content: "**已超时，未回答**" },
        { tag: "markdown", content: "**Continue?**" },
        { tag: "markdown", content: "超时视为未回答（2026-09-27 09:00），授权类请求不会被自动批准。" },
      ] },
    };
    const sent = await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card_patch",
      targetMessageId: "om_live_card",
      body: JSON.stringify({ card: terminalCard }),
    }), { signal: new AbortController().signal, onStarted: async () => {} });

    expect(sent).toEqual({ messageId: "om_live_card" });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.messageId).toBe("om_live_card");
    // The payload the client would send: a complete card, not `{}`.
    expect(patches[0]!.card).toEqual(terminalCard);
    expect(Object.keys(patches[0]!.card).length).toBeGreaterThan(0);
    expect(JSON.stringify(patches[0]!.card)).toContain("已超时，未回答");
    expect(JSON.stringify(patches[0]!.card)).toContain("Continue?");
  });

  it("refuses a patch whose body is not a card rather than blanking the message", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    let patches = 0;
    test.channel.handle.updateProactiveCard = async () => { patches += 1; };
    await expect(test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card_patch", targetMessageId: "om_live_card", body: "{}",
    }), { signal: new AbortController().signal, onStarted: async () => {} })).rejects.toThrow(/not a card envelope/);
    expect(patches).toBe(0);
  });

  it("B5: the reminder @s the person who was asked", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const replies: string[] = [];
    test.channel.handle.sendProactiveThreadReply = async (input: { body: string }) => {
      replies.push(input.body);
      return { messageId: "om_reminder" };
    };
    await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_reminder",
      body: "**MUL-1 - 问题**\n\n上面这个问题还没人回答，再过一会儿就会超时。",
      mention: { mode: "person", openId: "ou_the_person", resolvedOpenId: "ou_the_person" },
      interactionOpenId: "ou_the_person",
    }), { signal: new AbortController().signal, onStarted: async () => {} });

    expect(replies).toHaveLength(1);
    // The text actually handed to Feishu carries a card-lark @ for the person.
    expect(replies[0]).toContain("<at id=ou_the_person></at>");
    expect(replies[0]).toContain("超时");
  });

  it("B5: a reminder with nobody to address is sent without an @", async () => {
    const test = host({ daemon: fakeDaemon().daemon });
    await test.conciergeHost.start(assignment());
    const replies: string[] = [];
    test.channel.handle.sendProactiveThreadReply = async (input: { body: string }) => {
      replies.push(input.body);
      return { messageId: "om_reminder" };
    };
    await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_reminder",
      body: "**MUL-1 - 问题**\n\n上面这个问题还没人回答。",
      mention: { mode: "none", resolvedOpenId: null },
    }), { signal: new AbortController().signal, onStarted: async () => {} });

    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain("<at id=");
    expect(replies[0]).toContain("还没人回答");
  });

  it("B1: a click registers the card so the asked person can answer it", async () => {
    const fake = fakeDaemon();
    let pending: MultiremiTaskHumanRequest = { id: "hrq_1", taskId: "tsk_1", kind: "question", status: "pending",
      payload: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] },
      response: null, respondedBy: null, createdAt: "2026-09-27T00:00:00.000Z", respondedAt: null };
    const submitted: Array<Record<string, unknown>> = [];
    Object.assign(fake.daemon, {
      getFeishuBotHumanRequest: async () => pending,
      respondFeishuBotHumanRequest: async (_taskId: string, _requestId: string, response: Record<string, unknown>, credential: { operatorOpenId: string; token: string }) => {
        if (credential.operatorOpenId !== "ou_group_owner") throw Object.assign(new Error("recipient_mismatch"), { code: "recipient_mismatch" });
        submitted.push(response);
        pending = { ...pending, status: "responded", response, respondedBy: "feishu", respondedAt: "2026-09-27T00:10:00.000Z" };
        return pending;
      },
    });
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment());
    test.channel.handle.resolveProactiveMention = async () => "ou_group_owner";
    test.channel.handle.sendProactiveCard = async (input) => {
      expect(input.idempotencyKey).toBe("fbo_decision");
      return { messageId: "om_clickable" };
    };
    await test.conciergeHost.sendOutbound!(decisionDelivery({
      kind: "decision_card",
      humanRequestTaskId: "tsk_1",
      body: JSON.stringify({ card: cardWithSentinel(), fallback_text: "问题" }),
    }), { signal: new AbortController().signal, onStarted: async () => {} });

    // A stranger clicking gets the toast and changes nothing.
    const stranger = await handleTaskInteractionEvent("cli_a1b2c3d4e5f6g7h8", {
      operator: { open_id: "ou_someone_else" },
      context: { open_chat_id: "oc_decision", open_message_id: "om_clickable" },
      action: { value: { t: "host-token-fixture", r: "hrq_1", task_id: "tsk_1" }, tag: "button", name: interactionMarker("tsk_1", "hrq_1"), form_value: { q0_option0: true } },
    });
    expect(stranger).toMatchObject({ toast: { content: "请由卡片中指定的处理人提交" } });
    expect(submitted).toHaveLength(0);

    // The person who was asked submits the form and the request is answered.
    const answer = await handleTaskInteractionEvent("cli_a1b2c3d4e5f6g7h8", {
      operator: { open_id: "ou_group_owner" },
      context: { open_chat_id: "oc_decision", open_message_id: "om_clickable" },
      action: { value: { t: "host-token-fixture", r: "hrq_1", task_id: "tsk_1" }, tag: "button", name: interactionMarker("tsk_1", "hrq_1"), form_value: { q0_option0: "true" } },
    });
    expect(answer).toMatchObject({ toast: { type: "success", content: "已提交" } });
    expect(submitted).toEqual([{ answers: { "Continue?": "Yes" } }]);
    expect((answer as { card: { data: Record<string, unknown> } }).card.data).toBeTruthy();
    expect(JSON.stringify((answer as { card: { data: Record<string, unknown> } }).card.data)).toContain("已提交");
  });

  it("B1: a restarted host re-registers the cards it must still answer", async () => {
    const fake = fakeDaemon();
    let pending: MultiremiTaskHumanRequest = { id: "hrq_restart", taskId: "tsk_restart", kind: "question", status: "pending",
      payload: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
      response: null, respondedBy: null, createdAt: "2026-09-27T00:00:00.000Z", respondedAt: null };
    const cards = [{ requestId: "hrq_restart", taskId: "tsk_restart", chatId: "oc_decision",
      messageId: "om_before_restart", recipientOpenId: "ou_group_owner" }];
    const submitted: Array<Record<string, unknown>> = [];
    Object.assign(fake.daemon, {
      listFeishuBotDecisionCards: async () => cards,
      getFeishuBotHumanRequest: async () => pending,
      respondFeishuBotHumanRequest: async (_taskId: string, _requestId: string, response: Record<string, unknown>) => {
        submitted.push(response);
        pending = { ...pending, status: "responded", response, respondedBy: "feishu", respondedAt: "2026-09-27T00:10:00.000Z" };
        return pending;
      },
    });
    const test = host({ daemon: fake.daemon });
    // A fresh process: nothing was sent here, but the card is still on screen.
    await test.conciergeHost.start(assignment());

    const answer = await handleTaskInteractionEvent("cli_a1b2c3d4e5f6g7h8", {
      operator: { open_id: "ou_group_owner" },
      context: { open_chat_id: "oc_decision", open_message_id: "om_before_restart" },
      action: { value: { t: "host-token-fixture", r: "hrq_restart", task_id: "tsk_restart" }, tag: "button", name: interactionMarker("tsk_restart", "hrq_restart"), form_value: { q0_option0: "true" } },
    });
    expect(answer).toMatchObject({ toast: { type: "success", content: "已提交" } });
    expect(submitted).toEqual([{ answers: { "Continue?": "Yes" } }]);
  });

  it("B1: a request already answered elsewhere is reported, not overwritten", async () => {
    const fake = fakeDaemon();
    const answered: MultiremiTaskHumanRequest = { id: "hrq_done", taskId: "tsk_done", kind: "question", status: "responded",
      payload: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] },
      response: { answers: { "Continue?": "Yes" } }, respondedBy: "alice",
      createdAt: "2026-09-27T00:00:00.000Z", respondedAt: "2026-09-27T00:05:00.000Z" };
    let submits = 0;
    Object.assign(fake.daemon, {
      listFeishuBotDecisionCards: async () => [{ requestId: "hrq_done", taskId: "tsk_done", chatId: "oc_decision",
        messageId: "om_already_answered", recipientOpenId: "ou_group_owner" }],
      getFeishuBotHumanRequest: async () => answered,
      respondFeishuBotHumanRequest: async () => { submits += 1; return answered; },
    });
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment());

    const click = await handleTaskInteractionEvent("cli_a1b2c3d4e5f6g7h8", {
      operator: { open_id: "ou_group_owner" },
      context: { open_chat_id: "oc_decision", open_message_id: "om_already_answered" },
      action: { value: { t: "host-token-fixture", r: "hrq_done", task_id: "tsk_done" }, tag: "button", name: interactionMarker("tsk_done", "hrq_done"), form_value: { q0_option0: "true" } },
    });
    expect(click).toMatchObject({ toast: { type: "info", content: "请求已结束" } });
    // The web answer stands; the click must not write a second one.
    expect(submits).toBe(0);
  });
});
