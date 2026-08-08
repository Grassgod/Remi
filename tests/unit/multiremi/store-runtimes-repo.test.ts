// Sibling test for packages/server/src/store/repos/runtimes-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { RuntimesRepo } from "@multiremi/store/repos/runtimes-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): RuntimesRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  const ctx = new StoreContext(db, () => store!);
  // The analytics recorders are not on the public facade, so they are registered on the context.
  ctx.registerAnalytics(new AnalyticsRepo(ctx));
  return new RuntimesRepo(ctx);
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("RuntimesRepo", () => {
  it("registers a runtime with models and reads it back", () => {
    const repo = createRepo();

    const runtime = repo.registerRuntime({
      id: "rt_alpha",
      name: "Alpha",
      provider: "claude",
      workspaceId: "local",
      models: [{ id: "sonnet", label: "Sonnet", provider: "claude", default: true }],
    });

    expect(runtime.id).toBe("rt_alpha");
    expect(runtime.status).toBe("online");
    expect(repo.getRuntime("rt_alpha")?.name).toBe("Alpha");
    expect(repo.listRuntimes().map((entry) => entry.id)).toEqual(["rt_alpha"]);
    expect(repo.listRuntimeModels("rt_alpha").map((model) => model.id)).toEqual(["sonnet"]);
    expect(() => repo.listRuntimeModels("rt_missing")).toThrow("Runtime not found: rt_missing");
  });

  it("runs a model-list request through create → claim → report", () => {
    const repo = createRepo();
    repo.registerRuntime({ id: "rt_beta", name: "Beta", provider: "claude", workspaceId: "local" });

    const request = repo.createRuntimeModelListRequest("rt_beta");
    expect(request.status).toBe("pending");

    const claimed = repo.claimRuntimeModelListRequest("rt_beta");
    expect(claimed?.id).toBe(request.id);
    expect(claimed?.status).toBe("running");

    const reported = repo.reportRuntimeModelListResult("rt_beta", request.id, {
      status: "completed",
      models: [{ id: "opus", label: "Opus", provider: "claude", default: true }],
    });
    expect(reported.status).toBe("completed");
    expect(repo.listRuntimeModels("rt_beta").map((model) => model.id)).toEqual(["opus"]);
    // Terminal requests are immutable — a late failure report must not overwrite the result.
    expect(repo.reportRuntimeModelListResult("rt_beta", request.id, { status: "failed" }).status).toBe("completed");
  });

  it("hands pending work back on heartbeat and gates the claim predicate on ownership", () => {
    const repo = createRepo();
    const runtime = repo.registerRuntime({
      id: "rt_gamma",
      name: "Gamma",
      provider: "claude",
      workspaceId: "local",
      ownerId: "usr_owner",
      visibility: "private",
    });
    const update = repo.createRuntimeUpdateRequest("rt_gamma", { targetVersion: "9.9.9" });

    const ack = repo.heartbeatRuntime("rt_gamma");
    expect(ack.status).toBe("ok");
    expect(ack.pending_update?.id).toBe(update.id);
    expect(repo.heartbeatRuntime("rt_nope").runtime_gone).toBe(true);

    // Agents live in another repo, reached through ctx.agents().
    const mine = store!.createAgent({ name: "Mine", provider: "claude", workspaceId: "local", ownerId: "usr_owner" });
    const theirs = store!.createAgent({ name: "Theirs", provider: "claude", workspaceId: "local", ownerId: "usr_other" });
    expect(repo.runtimeCanRunAgent(runtime, mine)).toBe(true);
    expect(repo.runtimeCanRunAgent(runtime, theirs)).toBe(false);

    expect(repo.getRuntimeByDaemonAndProvider("rt_gamma", "claude")?.id).toBe("rt_gamma");
    expect(repo.deleteRuntime("rt_gamma")).toBe(true);
    expect(repo.getRuntime("rt_gamma")).toBeNull();
  });
});
