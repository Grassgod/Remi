// Sibling test for packages/server/src/store/repos/analytics-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): AnalyticsRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new AnalyticsRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("AnalyticsRepo", () => {
  it("records an agent-created event and reads it back", () => {
    const repo = createRepo();
    const event = repo.recordAgentCreated({
      actorId: "usr_1",
      workspaceId: "local",
      agentId: "agt_1",
      provider: "claude",
      runtimeMode: "local",
      isFirstAgentInWorkspace: true,
    });

    expect(event.name).toBe("agent_created");
    expect(event.properties.agent_id).toBe("agt_1");
    expect(event.properties.is_demo).toBe(false);

    const listed = repo.listAnalyticsEvents({ name: "agent_created" });
    expect(listed.map((entry) => entry.id)).toEqual([event.id]);
  });

  it("records a runtime failure and counts it as a metric", () => {
    const repo = createRepo();
    repo.recordRuntimeFailure({
      ownerId: "usr_1",
      workspaceId: "local",
      provider: "codex",
      failureReason: "timeout",
      errorType: "provider_error",
      recoverable: true,
    });

    const counters = repo.listMetricCounters({ name: "multiremi_runtime_failed_total" });
    expect(counters.length).toBe(1);
    expect(counters[0]!.value).toBe(1);
    expect(counters[0]!.labels.failure_reason).toBe("timeout");
    expect(counters[0]!.labels.recoverable).toBe("true");
  });

  it("hides metrics-only events when the caller opts out", () => {
    const repo = createRepo();
    repo.recordRuntimeFailure({
      failureReason: "timeout",
      errorType: "provider_error",
      recoverable: false,
    });

    expect(repo.listAnalyticsEvents({ includeMetricsOnly: true }).length).toBe(1);
    expect(repo.listAnalyticsEvents({ includeMetricsOnly: false })).toEqual([]);
  });
});
