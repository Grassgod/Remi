/**
 * The daemon-side host that actually boots the concierge channel (MUL-206).
 *
 * MUL-190 put a fail-closed member gate in front of the Feishu bot: a sender
 * whose `open_id` is not a member of the workspace gets nothing — no Agent run,
 * no Issue, no tool call. MUL-206 made the workspace a per-start value instead
 * of `MULTIREMI_WORKSPACE_ID`, so the gate now has to be wired from the
 * assignment. These tests exist to keep that wiring honest: if the workspace
 * ever stops flowing through, the bot answers strangers.
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
      verification_token: null,
      encrypt_key: null,
      ...overrides,
    },
    agent: { id: "agt_1", name: "Concierge" } as MultiremiAgent,
    projects: [{ id: "prj_1", title: "Project", cwd: "/tmp/project" }],
  };
}

interface FakeDaemon {
  daemon: MultiremiDaemon;
  membershipCalls: Array<{ workspaceId: string; externalId: string }>;
  botMenuPublishers: unknown[];
  failures: unknown[];
}

function fakeDaemon(options: { isMember?: boolean } = {}): FakeDaemon {
  const membershipCalls: Array<{ workspaceId: string; externalId: string }> = [];
  const botMenuPublishers: unknown[] = [];
  const failures: unknown[] = [];
  const daemon = {
    localPort: () => 4242,
    checkExternalWorkspaceMembership: async (workspaceId: string, externalId: string) => {
      membershipCalls.push({ workspaceId, externalId });
      return options.isMember ?? false;
    },
    ensureTopicWorkspace: async () => null,
    setBotMenuPublisher: (publisher: unknown) => { botMenuPublishers.push(publisher); },
    reportFeishuConciergeFailure: async (error: unknown) => { failures.push(error); },
  } as unknown as MultiremiDaemon;
  return { daemon, membershipCalls, botMenuPublishers, failures };
}

type BootArgs = Parameters<typeof bootFeishuChannel>;

interface BootCall {
  agent: BootArgs[0];
  projects: BootArgs[1];
  authorize: BootArgs[2];
  options: NonNullable<BootArgs[3]>;
}

/** A channel handle whose run promise the test controls. */
function fakeChannel(): { handle: FeishuChannelHandle; fail: (error: unknown) => void; stops: () => number } {
  let stops = 0;
  let fail!: (error: unknown) => void;
  const start = new Promise<void>((_resolve, reject) => { fail = reject; });
  return {
    handle: {
      start,
      stop: async () => { stops += 1; },
      updateProjects: () => {},
      publishBotMenu: async () => ({ dryRun: true, defaultPublished: false, userMenuCount: 0 }),
    } as unknown as FeishuChannelHandle,
    fail,
    stops: () => stops,
  };
}

function host(input: {
  daemon?: MultiremiDaemon | undefined;
  workspacesRoot?: string | undefined;
}) {
  const calls: BootCall[] = [];
  let current: FeishuChannelHandle | null = null;
  const channel = fakeChannel();
  const boot: typeof bootFeishuChannel = async (agent, projects, authorize, options) => {
    calls.push({ agent, projects, authorize, options: options ?? {} });
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
  it("gates senders against the workspace the assignment names", async () => {
    // Not the daemon's own workspace and not an environment variable: the
    // workspace that owns the credentials this start is using.
    const fake = fakeDaemon({ isMember: false });
    const test = host({ daemon: fake.daemon });

    const result = await test.conciergeHost.start(assignment());

    expect(result).toEqual({ botName: "Concierge" });
    expect(test.calls).toHaveLength(1);
    const authorized = await test.calls[0]!.authorize("ou_stranger");
    expect(authorized).toBe(false);
    expect(fake.membershipCalls).toEqual([{ workspaceId: "ws_configured", externalId: "ou_stranger" }]);
  });

  it("admits a sender the control plane recognises as a member", async () => {
    const fake = fakeDaemon({ isMember: true });
    const test = host({ daemon: fake.daemon });
    await test.conciergeHost.start(assignment({ workspace_id: "ws_other" }));

    expect(await test.calls[0]!.authorize("ou_member")).toBe(true);
    expect(fake.membershipCalls).toEqual([{ workspaceId: "ws_other", externalId: "ou_member" }]);
  });

  it("refuses to boot without a daemon to ask about membership", async () => {
    // Failing closed here is the point: booting anyway would put a bot on a
    // real Feishu app with nothing deciding who may talk to it.
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
      verification_token: "vt_value",
      encrypt_key: "ek_value",
    }));

    expect(test.calls[0]!.options).toMatchObject({
      daemonPort: 4242,
      workspacesRoot: "/tmp/workspaces",
      credentials: {
        appId: "cli_a1b2c3d4e5f6g7h8",
        appSecret: APP_SECRET,
        domain: "lark",
        verificationToken: "vt_value",
        encryptKey: "ek_value",
      },
    });
    expect(test.calls[0]!.projects).toEqual([{ id: "prj_1", title: "Project", cwd: "/tmp/project" }]);
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
