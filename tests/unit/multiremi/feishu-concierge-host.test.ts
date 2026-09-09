/**
 * The daemon-side host that actually boots the concierge channel (MUL-206).
 *
 * Sender identity is classified by the canonical Task bridge using union_id.
 * The connector only transports messages; it must not reject a sender by the
 * bot app's app-scoped open_id.
 */

import { describe, expect, it } from "bun:test";
import { controlPlaneConciergeHost } from "../../../apps/remi/cli/multiremi.js";
import type { bootFeishuChannel, FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type {
  MultiremiAgent,
  MultiremiFeishuBotDaemonConfig,
} from "@multiremi/contracts/types.js";
import type { MultiremiFeishuBotAssignment } from "@multiremi/worker/client.js";

const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

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
      listFeishuBotTaskMessages: async (_id: string, since: number) => {
        reads.push(since);
        return since === 0 ? [{ id: "msg_tool", taskId: "tsk_live", seq: 1, type: "tool_use", tool: "Bash" }] : [];
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
    expect(reads).toEqual([0, 1]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ type: "tool_use" }) }),
      expect.objectContaining({ kind: "snapshot", snapshot: expect.objectContaining({ status: "completed" }) }),
    ]);
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
});
