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
} {
  let stops = 0;
  const sent: Array<{ chatId: string; idempotencyKey: string }> = [];
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
    } as unknown as FeishuChannelHandle,
    fail,
    stops: () => stops,
    sent,
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
      idempotencyKey: "fbo_host",
    });

    expect(result).toEqual({ messageId: "om_proactive" });
    expect(test.channel.sent).toEqual([{ chatId: "oc_host", idempotencyKey: "fbo_host" }]);
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
