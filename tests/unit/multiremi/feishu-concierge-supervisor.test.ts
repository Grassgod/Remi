/**
 * Daemon-side reconcile loop for the Workspace Feishu concierge (MUL-206).
 *
 * The supervisor is the piece that decides whether this Runtime should be
 * running the bot right now. Everything here is about the decisions rather than
 * the connector: that a handover is announced, that two Runtimes cannot both
 * believe they hold the bot, that a bad App Secret is not retried at heartbeat
 * rate, and that no credential reaches a status report.
 */

import { describe, expect, it } from "bun:test";
import type {
  MultiremiFeishuBotDaemonConfig,
  MultiremiFeishuBotDirective,
} from "../../../packages/contracts/src/types.js";
import type { MultiremiFeishuBotAssignment } from "../../../packages/server/src/worker/client.js";
import {
  FeishuConciergeError,
  FeishuConciergeSupervisor,
  type FeishuConciergeStatusReport,
} from "../../../packages/server/src/worker/feishu-concierge.js";

const APP_SECRET = "top-secret-app-credential-value";

function assignment(revision: number, overrides: Partial<MultiremiFeishuBotDaemonConfig> = {}): MultiremiFeishuBotAssignment {
  const config: MultiremiFeishuBotDaemonConfig = {
    workspace_id: "ws_1",
    runtime_id: "rt_1",
    agent_id: "agt_1",
    revision,
    desired_state: "running",
    app_id: "cli_test_app",
    app_secret: APP_SECRET,
    domain: "feishu",
    ...overrides,
  };
  return {
    config,
    agent: { id: "agt_1", name: "Concierge", workspaceId: "ws_1" } as MultiremiFeishuBotAssignment["agent"],
  };
}

function directive(overrides: Partial<MultiremiFeishuBotDirective> = {}): MultiremiFeishuBotDirective {
  return { revision: 1, desired_state: "running", config_available: true, ...overrides };
}

interface Harness {
  supervisor: FeishuConciergeSupervisor;
  starts: MultiremiFeishuBotAssignment[];
  stops: number;
  reports: FeishuConciergeStatusReport[];
  sent: string[];
  advance: (ms: number) => void;
}

function harness(options: {
  fetch?: () => Promise<MultiremiFeishuBotAssignment | null>;
  start?: (input: MultiremiFeishuBotAssignment) => Promise<{ botName?: string | null }>;
  retryBackoffMs?: readonly number[];
} = {}): Harness {
  const state = {
    starts: [] as MultiremiFeishuBotAssignment[],
    stops: 0,
    reports: [] as FeishuConciergeStatusReport[],
    sent: [] as string[],
    nowMs: 1_000_000,
  };
  const supervisor = new FeishuConciergeSupervisor({
    host: {
      start: async (input) => {
        state.starts.push(input);
        return (await options.start?.(input)) ?? { botName: "Concierge" };
      },
      stop: async () => { state.stops += 1; },
      sendOutbound: async (delivery) => {
        state.sent.push(delivery.id);
        return { messageId: `om_${delivery.id}` };
      },
    },
    fetchConfig: options.fetch ?? (async () => assignment(1)),
    report: async (input) => { state.reports.push(input); },
    retryBackoffMs: options.retryBackoffMs,
    now: () => state.nowMs,
  });
  return {
    supervisor,
    get starts() { return state.starts; },
    get stops() { return state.stops; },
    get reports() { return state.reports; },
    get sent() { return state.sent; },
    advance: (ms) => { state.nowMs += ms; },
  };
}

describe("FeishuConciergeSupervisor", () => {
  it("sends leased outbound work only while the connector is online", async () => {
    const test = harness();
    const delivery = {
      id: "fbo_1",
      claimToken: "claim_1",
      chatId: "oc_1",
      threadId: "omt_1",
      replyToMessageId: "om_root",
      body: "Round complete.",
      idempotencyKey: "fbo_1",
    };
    await expect(test.supervisor.sendOutbound(delivery)).rejects.toThrow("not online");
    await test.supervisor.apply(directive());
    await expect(test.supervisor.sendOutbound(delivery)).resolves.toEqual({ messageId: "om_fbo_1" });
    expect(test.sent).toEqual(["fbo_1"]);
  });

  it("starts the channel and applies the revision the fetch actually returned", async () => {
    // The directive's revision is a hint; the fetched payload is authoritative,
    // because an admin can save again between the heartbeat and the fetch.
    const test = harness({ fetch: async () => assignment(7) });
    await test.supervisor.apply(directive({ revision: 5 }));

    expect(test.starts).toHaveLength(1);
    expect(test.supervisor.snapshot()).toEqual({ state: "online", appliedRevision: 7, botName: "Concierge" });
    expect(test.reports.map((report) => report.state)).toEqual(["starting", "online"]);
    expect(test.reports.at(-1)?.applied_revision).toBe(7);
  });

  it("does not restart a channel that already matches the directive", async () => {
    const test = harness();
    await test.supervisor.apply(directive());
    await test.supervisor.apply(directive());
    await test.supervisor.apply(directive());

    expect(test.starts).toHaveLength(1);
    expect(test.stops).toBe(0);
  });

  it("withholds the start until the control plane says the config is available", async () => {
    // `config_available: false` is the other half of a handover: another
    // Runtime still holds the bot, so starting here would double-run it.
    const test = harness();
    await test.supervisor.apply(directive({ config_available: false }));

    expect(test.starts).toHaveLength(0);
    expect(test.supervisor.snapshot().state).toBe("stopped");
  });

  it("reports a stop even when nothing was running, so a handover can finish", async () => {
    const test = harness();
    await test.supervisor.apply(directive({ desired_state: "stopped", revision: 3 }));

    expect(test.reports).toHaveLength(1);
    expect(test.reports[0]).toMatchObject({ state: "stopped", applied_revision: 3 });
  });

  it("tears the old channel down before starting a new revision", async () => {
    const test = harness();
    await test.supervisor.apply(directive({ revision: 1 }));
    await test.supervisor.apply(directive({ revision: 2 }));

    expect(test.starts).toHaveLength(2);
    // One stop, and it happened between the two starts rather than after them.
    expect(test.stops).toBe(1);
    expect(test.reports.map((report) => report.state)).toEqual(["starting", "online", "starting", "online"]);
  });

  it("stays stopped when the assignment moved away between heartbeat and fetch", async () => {
    const test = harness({ fetch: async () => null });
    await test.supervisor.apply(directive());

    expect(test.starts).toHaveLength(0);
    expect(test.supervisor.snapshot().state).toBe("stopped");
    expect(test.reports.at(-1)?.state).toBe("stopped");
  });

  it("never lets a credential reach the reported error message", async () => {
    const test = harness({
      start: async () => { throw new Error(`Feishu rejected app_secret=${APP_SECRET}`); },
    });
    await test.supervisor.apply(directive());

    const report = test.reports.at(-1)!;
    expect(report.state).toBe("failed");
    expect(report.error_code).toBe("connector_start_failed");
    expect(report.error_message).toContain("Feishu rejected");
    expect(report.error_message).not.toContain(APP_SECRET);
  });

  it("keeps a named failure instead of collapsing it into a start failure", async () => {
    const test = harness({
      fetch: async () => { throw new FeishuConciergeError("the bot Agent is gone", "agent_unavailable"); },
    });
    await test.supervisor.apply(directive());

    expect(test.reports.at(-1)).toMatchObject({ state: "failed", error_code: "agent_unavailable" });
  });

  it("backs off after a failure and retries once the ladder elapses", async () => {
    // Directives arrive every few seconds. Without a backoff, a revoked App
    // Secret would be retried against Feishu at heartbeat rate forever.
    const test = harness({
      start: async () => { throw new Error("connect ECONNREFUSED"); },
      retryBackoffMs: [10_000],
    });
    await test.supervisor.apply(directive());
    expect(test.starts).toHaveLength(1);

    await test.supervisor.apply(directive());
    expect(test.starts).toHaveLength(1);

    test.advance(10_001);
    await test.supervisor.apply(directive());
    expect(test.starts).toHaveLength(2);
  });

  it("retries immediately when a new revision arrives, because an admin just changed something", async () => {
    const test = harness({
      start: async () => { throw new Error("connect ECONNREFUSED"); },
      retryBackoffMs: [600_000],
    });
    await test.supervisor.apply(directive({ revision: 1 }));
    await test.supervisor.apply(directive({ revision: 1 }));
    expect(test.starts).toHaveLength(1);

    await test.supervisor.apply(directive({ revision: 2 }));
    expect(test.starts).toHaveLength(2);
  });

  it("restarts after the host reports a channel that died on its own", async () => {
    const test = harness();
    await test.supervisor.apply(directive());
    expect(test.supervisor.snapshot().state).toBe("online");

    await test.supervisor.reportChannelFailure(new Error("websocket closed"));
    expect(test.supervisor.snapshot().state).toBe("failed");
    expect(test.reports.at(-1)).toMatchObject({ state: "failed", bot_name: null });

    test.advance(600_000);
    await test.supervisor.apply(directive());
    expect(test.starts).toHaveLength(2);
    expect(test.supervisor.snapshot().state).toBe("online");
  });

  it("serializes overlapping directives so two starts cannot race one bot", async () => {
    // Directives arrive faster than a channel boots. Two starts running at once
    // would put two connectors on one app id, fighting over the same events.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inStart = 0;
    let maxInStart = 0;
    let first = true;
    let fetched = 0;
    const test = harness({
      fetch: async () => assignment(++fetched),
      start: async () => {
        inStart += 1;
        maxInStart = Math.max(maxInStart, inStart);
        if (first) { first = false; await gate; }
        inStart -= 1;
        return { botName: "Concierge" };
      },
    });

    const inFlight = test.supervisor.apply(directive({ revision: 1 }));
    const queued = test.supervisor.apply(directive({ revision: 2 }));
    release();
    await Promise.all([inFlight, queued]);

    expect(maxInStart).toBe(1);
    // The queued directive ran after the first reconcile finished, refetched,
    // and its assignment is the one that stuck.
    expect(test.starts).toHaveLength(2);
    expect(test.supervisor.snapshot().appliedRevision).toBe(2);
  });

  it("announces the stop on shutdown so another Runtime need not wait out staleness", async () => {
    const test = harness();
    await test.supervisor.apply(directive());
    await test.supervisor.shutdown();

    expect(test.stops).toBe(1);
    expect(test.reports.at(-1)).toMatchObject({ state: "stopped", bot_name: null });
  });

  it("does not report again on shutdown when it was never running", async () => {
    const test = harness();
    await test.supervisor.shutdown();

    expect(test.stops).toBe(0);
    expect(test.reports).toHaveLength(0);
  });
});
