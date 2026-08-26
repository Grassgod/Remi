import { describe, expect, it } from "bun:test";
import type { MultiremiScmSyncStream } from "@multiremi/contracts/types.js";
import { GITHUB_SCM_CAPABILITIES } from "@multiremi/scm/capabilities.js";
import { ScmHttpError } from "@multiremi/scm/http.js";
import { pollIsDue, ScmPollingScheduler } from "@multiremi/scm/poller.js";
import {
  ScmStreamUnavailableError,
  type ScmPollContext,
  type ScmPollPage,
  type ScmProviderAdapter,
} from "@multiremi/scm/types.js";
import { MemoryScmIngestionStore, scmConnection } from "./scm-test-helpers.js";

class FakeAdapter implements ScmProviderAdapter {
  readonly provider = "github" as const;
  readonly capabilities = GITHUB_SCM_CAPABILITIES;
  calls: MultiremiScmSyncStream[] = [];
  head = "aaa";
  failStream: MultiremiScmSyncStream | null = null;
  failError: Error = new Error("provider unavailable");

  async poll(context: ScmPollContext): Promise<ScmPollPage> {
    this.calls.push(context.stream);
    if (context.stream === this.failStream) throw this.failError;
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
    expect(cursor?.consecutiveFailures).toBe(1);
    expect(cursor?.suspendedUntil).toBeNull();
    expect(cursor?.lastCompletedAt).toBeNull();
    expect(cursor?.baselineCompletedAt).toBeNull();

    adapter.failStream = null;
    const recovered = await scheduler.runOnce(new Date("2026-08-21T08:01:00.000Z"));
    expect(recovered.failed).toBe(0);
    const recoveredCursor = store.getSyncCursor("scm_1", "repo_1", "reviews");
    expect(recoveredCursor?.lastError).toBeNull();
    expect(recoveredCursor?.consecutiveFailures).toBe(0);
    expect(recoveredCursor?.suspendedUntil).toBeNull();
  });

  it("persists contextual HTTP errors without URL query parameters", async () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new FakeAdapter();
    adapter.failStream = "reviews";
    adapter.failError = new ScmHttpError(
      "SCM provider request failed (503)",
      503,
      null,
      "",
      "https://api.github.com/repos/acme/widgets/pulls?page=1&token=secret",
      "GET",
    );
    const scheduler = new ScmPollingScheduler({ store, adapters: [adapter] });

    await scheduler.runOnce(new Date("2026-08-21T08:00:00.000Z"));

    const lastError = store.getSyncCursor("scm_1", "repo_1", "reviews")?.lastError;
    expect(lastError).toBe("GitHub reviews poll failed: GET /repos/acme/widgets/pulls -> 503");
    expect(lastError).not.toContain("token");
    expect(lastError).not.toContain("secret");
  });

  it("uses provider cursors immediately but observes connection poll intervals after completion", () => {
    const connection = scmConnection({ pollIntervalSeconds: 60 });
    const now = new Date("2026-08-21T08:01:00.000Z");
    expect(pollIsDue(connection, null, now)).toBe(true);
    const cursor = {
      connectionId: "scm_1", repositoryId: "repo_1", stream: "comments" as const,
      cursor: null, watermark: null, baselineCompletedAt: "2026-08-21T07:00:00.000Z",
      lastStartedAt: "2026-08-21T08:00:30.000Z", lastCompletedAt: "2026-08-21T08:00:30.000Z",
      lastError: null, consecutiveFailures: 0, suspendedUntil: null,
      leaseOwner: null, leaseUntil: null, leaseToken: null,
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

  it("backs off failed streams without ever polling them faster than healthy streams", () => {
    const connection = scmConnection({ pollIntervalSeconds: 60 });
    const cursor = {
      connectionId: "scm_1",
      repositoryId: "repo_1",
      stream: "reviews" as const,
      cursor: null,
      watermark: null,
      baselineCompletedAt: null,
      lastStartedAt: "2026-08-21T08:00:00.000Z",
      lastCompletedAt: null,
      lastError: null,
      consecutiveFailures: 0,
      suspendedUntil: null,
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: "2026-08-21T08:00:00.000Z",
    };

    const healthyDueAt = new Date("2026-08-21T08:01:00.000Z");
    expect(pollIsDue(connection, cursor, healthyDueAt)).toBe(true);
    expect(pollIsDue(connection, {
      ...cursor,
      lastError: "failed",
      consecutiveFailures: 1,
    }, healthyDueAt)).toBe(true);
    expect(pollIsDue(connection, {
      ...cursor,
      lastError: "failed",
      consecutiveFailures: 2,
    }, healthyDueAt)).toBe(false);
    expect(pollIsDue(connection, {
      ...cursor,
      lastError: "failed",
      consecutiveFailures: 2,
    }, new Date("2026-08-21T08:02:00.000Z"))).toBe(true);
    expect(pollIsDue(connection, {
      ...cursor,
      lastError: "failed",
      consecutiveFailures: 20,
    }, new Date("2026-08-21T08:29:59.000Z"))).toBe(false);
    expect(pollIsDue(connection, {
      ...cursor,
      lastError: "failed",
      consecutiveFailures: 20,
    }, new Date("2026-08-21T08:30:00.000Z"))).toBe(true);
  });

  it("honors suspended_until before resumable cursors", () => {
    const connection = scmConnection({ pollIntervalSeconds: 60 });
    const cursor = {
      connectionId: "scm_1",
      repositoryId: "repo_1",
      stream: "comments" as const,
      cursor: { kind: "review", page: 2 },
      watermark: null,
      baselineCompletedAt: null,
      lastStartedAt: "2026-08-21T08:00:00.000Z",
      lastCompletedAt: null,
      lastError: "unavailable",
      consecutiveFailures: 1,
      suspendedUntil: "2026-08-21T14:00:00.000Z",
      leaseOwner: null,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: "2026-08-21T08:00:00.000Z",
    };
    expect(pollIsDue(connection, cursor, new Date("2026-08-21T13:59:59.000Z"))).toBe(false);
    expect(pollIsDue(connection, cursor, new Date("2026-08-21T14:00:00.000Z"))).toBe(true);
  });

  it("cools down an unavailable stream and does not call it again during suspension", async () => {
    const store = new MemoryScmIngestionStore();
    const adapter = new FakeAdapter();
    adapter.failStream = "reviews";
    adapter.failError = new ScmStreamUnavailableError(
      "GitHub",
      "reviews",
      404,
      "/repos/acme/widgets/pulls",
      "pull requests unavailable",
    );
    let clock = new Date("2026-08-21T08:00:00.000Z");
    const scheduler = new ScmPollingScheduler({ store, adapters: [adapter], now: () => clock });

    const first = await scheduler.runOnce(clock);
    expect(first.failed).toBe(1);
    const cursor = store.getSyncCursor("scm_1", "repo_1", "reviews");
    expect(cursor?.lastError).toBe(
      "GitHub reviews poll failed: GET /repos/acme/widgets/pulls -> 404 (pull requests unavailable)",
    );
    expect(cursor?.consecutiveFailures).toBe(1);
    expect(cursor?.suspendedUntil).toBe("2026-08-21T14:00:00.000Z");
    expect(adapter.calls.filter((stream) => stream === "reviews")).toHaveLength(1);

    clock = new Date("2026-08-21T13:59:59.000Z");
    await scheduler.runOnce(clock);
    expect(adapter.calls.filter((stream) => stream === "reviews")).toHaveLength(1);
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
