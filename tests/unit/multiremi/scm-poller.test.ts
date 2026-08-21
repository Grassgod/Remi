import { describe, expect, it } from "bun:test";
import type { MultiremiScmSyncStream } from "@multiremi/contracts/types.js";
import { GITHUB_SCM_CAPABILITIES } from "@multiremi/scm/capabilities.js";
import { pollIsDue, ScmPollingScheduler } from "@multiremi/scm/poller.js";
import type { ScmPollContext, ScmPollPage, ScmProviderAdapter } from "@multiremi/scm/types.js";
import { MemoryScmIngestionStore, scmConnection } from "./scm-test-helpers.js";

class FakeAdapter implements ScmProviderAdapter {
  readonly provider = "github" as const;
  readonly capabilities = GITHUB_SCM_CAPABILITIES;
  calls: MultiremiScmSyncStream[] = [];
  head = "aaa";
  failStream: MultiremiScmSyncStream | null = null;

  async poll(context: ScmPollContext): Promise<ScmPollPage> {
    this.calls.push(context.stream);
    if (context.stream === this.failStream) throw new Error("provider unavailable");
    const observedAt = context.now.toISOString();
    if (context.stream === "default_branch") {
      return {
        observations: [{
          stream: "default_branch",
          entityType: "ref",
          externalId: "main",
          version: this.head,
          occurredAt: observedAt,
          observedAt,
          payload: { branch: "main", head_sha: this.head },
        }],
        cursor: null,
        watermark: observedAt,
        done: true,
      };
    }
    return { observations: [], cursor: null, watermark: observedAt, done: true };
  }

  verifyWebhook(): boolean { return true; }
  parseWebhook() { return { providerEvent: "test", deliveryId: null, candidates: [], ignoredReason: null }; }
}

class BlockingAdapter extends FakeAdapter {
  defaultBranchAttempts = 0;
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });
  readonly release = new Promise<void>((resolve) => { this.releaseResolve = resolve; });

  constructor(private readonly beforeBlock?: (context: ScmPollContext) => void) {
    super();
  }

  override async poll(context: ScmPollContext): Promise<ScmPollPage> {
    if (context.stream === "default_branch") {
      this.defaultBranchAttempts += 1;
      this.beforeBlock?.(context);
      this.enteredResolve();
      await this.release;
    }
    return super.poll(context);
  }

  unblock(): void {
    this.releaseResolve();
  }
}

class CrossTickPaginationAdapter implements ScmProviderAdapter {
  readonly provider = "github" as const;
  readonly capabilities = {
    ...GITHUB_SCM_CAPABILITIES,
    streams: {
      ...GITHUB_SCM_CAPABILITIES.streams,
      default_branch: { ...GITHUB_SCM_CAPABILITIES.streams.default_branch, poll: false },
      comments: { ...GITHUB_SCM_CAPABILITIES.streams.comments, poll: false },
      reviews: { ...GITHUB_SCM_CAPABILITIES.streams.reviews, poll: false },
      pipelines: { ...GITHUB_SCM_CAPABILITIES.streams.pipelines, poll: false },
    },
  };
  calls: Array<{ cursor: Record<string, unknown> | null; watermark: string | null }> = [];

  async poll(context: ScmPollContext): Promise<ScmPollPage> {
    this.calls.push({ cursor: context.cursor?.cursor ?? null, watermark: context.cursor?.watermark ?? null });
    const call = this.calls.length;
    const entity = call === 1
      ? change("old-page-1", "2026-08-20T07:00:00.000Z", context.now)
      : call === 2
        ? change("old-page-2", "2026-08-20T06:00:00.000Z", context.now)
        : change("inserted-during-cycle", "2026-08-21T08:01:00.000Z", context.now);
    return {
      observations: [entity],
      cursor: call === 1 ? { page: 2 } : null,
      watermark: context.now.toISOString(),
      done: call !== 1,
    };
  }

  verifyWebhook(): boolean { return true; }
  parseWebhook() { return { providerEvent: "test", deliveryId: null, candidates: [], ignoredReason: null }; }
}

describe("SCM polling scheduler", () => {
  it("establishes a baseline first and emits only subsequent changes", async () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new FakeAdapter();
    const scheduler = new ScmPollingScheduler({ store, adapters: [adapter], now: () => new Date("2026-08-21T08:00:00.000Z") });
    const first = await scheduler.runOnce(new Date("2026-08-21T08:00:00.000Z"));
    expect(first.completed).toBe(5);
    expect(first.eventsCreated).toBe(0);
    expect(store.getSyncCursor("scm_1", "repo_1", "default_branch")?.baselineCompletedAt).toBeString();

    adapter.head = "bbb";
    const second = await scheduler.runOnce(new Date("2026-08-21T08:02:00.000Z"));
    expect(second.eventsCreated).toBe(2);
    expect([...store.events.values()].map((event) => event.type)).toEqual(["default_branch.updated", "push.observed"]);
  });

  it("persists a stream error without advancing its completion time", async () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new FakeAdapter();
    adapter.failStream = "reviews";
    const scheduler = new ScmPollingScheduler({ store, adapters: [adapter] });
    const result = await scheduler.runOnce(new Date("2026-08-21T08:00:00.000Z"));
    expect(result.failed).toBe(1);
    const cursor = store.getSyncCursor("scm_1", "repo_1", "reviews");
    expect(cursor?.lastError).toBe("provider unavailable");
    expect(cursor?.lastCompletedAt).toBeNull();
    expect(cursor?.baselineCompletedAt).toBeNull();
  });

  it("uses provider cursors immediately but observes connection poll intervals after completion", () => {
    const connection = scmConnection({ pollIntervalSeconds: 60 });
    const now = new Date("2026-08-21T08:01:00.000Z");
    expect(pollIsDue(connection, null, now)).toBe(true);
    const cursor = {
      connectionId: "scm_1", repositoryId: "repo_1", stream: "comments" as const,
      cursor: null, watermark: null, baselineCompletedAt: "2026-08-21T07:00:00.000Z",
      lastStartedAt: "2026-08-21T08:00:30.000Z", lastCompletedAt: "2026-08-21T08:00:30.000Z",
      lastError: null, leaseOwner: null, leaseUntil: null, leaseToken: null,
      updatedAt: "2026-08-21T08:00:30.000Z",
    };
    expect(pollIsDue(connection, cursor, now)).toBe(false);
    expect(pollIsDue(connection, { ...cursor, cursor: { page: 2 } }, now)).toBe(true);
    expect(pollIsDue(connection, {
      ...cursor,
      leaseOwner: "server-a",
      leaseToken: "lease-a",
      leaseUntil: "2026-08-21T08:02:00.000Z",
    }, now)).toBe(false);
    expect(pollIsDue(connection, {
      ...cursor,
      leaseOwner: "server-a",
      leaseToken: "lease-a",
      leaseUntil: "2026-08-21T08:00:59.000Z",
    }, now)).toBe(true);
  });

  it("uses a shared store lease to fence concurrent scheduler instances", async () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new BlockingAdapter();
    const first = new ScmPollingScheduler({
      store,
      adapters: [adapter],
      leaseOwner: "server-a",
      now: () => new Date("2026-08-21T08:00:00.000Z"),
    });
    const second = new ScmPollingScheduler({
      store,
      adapters: [adapter],
      leaseOwner: "server-b",
      now: () => new Date("2026-08-21T08:02:00.000Z"),
    });

    const firstRun = first.runOnce(new Date("2026-08-21T08:00:00.000Z"));
    await adapter.entered;
    const secondRun = await second.runOnce(new Date("2026-08-21T08:02:00.000Z"));
    expect(adapter.defaultBranchAttempts).toBe(1);
    expect(secondRun.skipped).toBeGreaterThan(0);

    adapter.unblock();
    await firstRun;
    expect(store.getSyncCursor("scm_1", "repo_1", "default_branch")?.leaseToken).toBeNull();
  });

  it("renews a long provider page so another scheduler cannot take over after the original expiry", async () => {
    const store = new MemoryScmIngestionStore();
    let clock = new Date("2026-08-21T08:00:00.000Z");
    const adapter = new BlockingAdapter((context) => {
      clock = new Date("2026-08-21T08:04:00.000Z");
      context.heartbeat?.();
    });
    const first = new ScmPollingScheduler({
      store,
      adapters: [adapter],
      leaseOwner: "server-a",
      now: () => clock,
    });
    const second = new ScmPollingScheduler({
      store,
      adapters: [adapter],
      leaseOwner: "server-b",
      now: () => clock,
    });

    const firstRun = first.runOnce(clock);
    await adapter.entered;
    expect(store.getSyncCursor("scm_1", "repo_1", "default_branch")?.leaseUntil)
      .toBe("2026-08-21T08:09:00.000Z");

    clock = new Date("2026-08-21T08:06:00.000Z");
    const secondRun = await second.runOnce(clock);
    expect(adapter.defaultBranchAttempts).toBe(1);
    expect(secondRun.skipped).toBeGreaterThan(0);

    adapter.unblock();
    await firstRun;
  });

  it("rejects stale lease tokens after another owner claims an expired stream", () => {
    const store = new MemoryScmIngestionStore();
    const first = store.claimSyncStream({
      connectionId: "scm_1",
      repositoryId: "repo_1",
      stream: "comments",
      owner: "server-a",
      now: "2026-08-21T08:00:00.000Z",
      leaseMs: 30_000,
    })!;
    const second = store.claimSyncStream({
      connectionId: "scm_1",
      repositoryId: "repo_1",
      stream: "comments",
      owner: "server-b",
      now: "2026-08-21T08:01:00.000Z",
      leaseMs: 30_000,
    })!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(store.updateClaimedSyncCursor({
      connectionId: "scm_1",
      repositoryId: "repo_1",
      stream: "comments",
      leaseToken: first.leaseToken!,
      cursor: { page: 99 },
    })).toBeNull();
    expect(store.releaseSyncStream({
      connectionId: "scm_1",
      repositoryId: "repo_1",
      stream: "comments",
      leaseToken: first.leaseToken!,
    })).toBe(false);
  });

  it("keeps a fixed cycle watermark across ticks so front-page inserts are scanned next", async () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new CrossTickPaginationAdapter();
    let clock = new Date("2026-08-21T08:00:00.000Z");
    const scheduler = new ScmPollingScheduler({
      store,
      adapters: [adapter],
      maxPagesPerStream: 1,
      now: () => clock,
    });

    const first = await scheduler.runOnce(clock);
    expect(first.completed).toBe(0);
    expect(store.getSyncCursor("scm_1", "repo_1", "change_requests")?.cursor).toEqual({
      __multiremi_cycle: {
        startedAt: "2026-08-21T08:00:00.000Z",
        providerCursor: { page: 2 },
      },
    });

    clock = new Date("2026-08-21T08:02:00.000Z");
    const second = await scheduler.runOnce(clock);
    expect(second.completed).toBe(1);
    expect(adapter.calls[1]?.cursor).toEqual({ page: 2 });
    expect(store.getSyncCursor("scm_1", "repo_1", "change_requests")?.watermark)
      .toBe("2026-08-21T08:00:00.000Z");

    clock = new Date("2026-08-21T08:04:00.000Z");
    const third = await scheduler.runOnce(clock);
    expect(adapter.calls[2]?.watermark).toBe("2026-08-21T08:00:00.000Z");
    expect(third.eventsCreated).toBe(1);
    expect([...store.events.values()][0]?.subjectId).toBe("inserted-during-cycle");
  });
});

function change(externalId: string, updatedAt: string, observedAt: Date) {
  return {
    stream: "change_requests" as const,
    entityType: "change_request" as const,
    externalId,
    version: updatedAt,
    occurredAt: updatedAt,
    observedAt: observedAt.toISOString(),
    payload: {
      id: externalId,
      state: "open",
      title: externalId,
      head_sha: `sha-${externalId}`,
      updated_at: updatedAt,
    },
  };
}
