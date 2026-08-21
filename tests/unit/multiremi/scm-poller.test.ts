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
      lastError: null, updatedAt: "2026-08-21T08:00:30.000Z",
    };
    expect(pollIsDue(connection, cursor, now)).toBe(false);
    expect(pollIsDue(connection, { ...cursor, cursor: { page: 2 } }, now)).toBe(true);
  });
});

