// Sibling test for packages/server/src/store/repos/autopilots-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { AutopilotsRepo } from "@multiremi/store/repos/autopilots-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): AutopilotsRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  const ctx = new StoreContext(db, () => store!);
  // The analytics recorders are not on the public facade, so they are registered on the context.
  ctx.registerAnalytics(new AnalyticsRepo(ctx));
  return new AutopilotsRepo(ctx);
}

function createAgentId(): string {
  // Agents live in another repo, reached through ctx.agents().
  return store!.createAgent({ name: "Pilot", provider: "claude", workspaceId: "local" }).id;
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("AutopilotsRepo", () => {
  it("creates an autopilot against an agent and updates it", () => {
    const repo = createRepo();
    const agentId = createAgentId();

    const autopilot = repo.createAutopilot({ title: "Nightly", assigneeId: agentId, workspaceId: "local" });
    expect(autopilot.title).toBe("Nightly");
    expect(repo.getAutopilot(autopilot.id)?.id).toBe(autopilot.id);
    expect(repo.listAutopilots("local").map((entry) => entry.id)).toEqual([autopilot.id]);

    expect(repo.updateAutopilot(autopilot.id, { title: "Nightly v2" }).title).toBe("Nightly v2");
    expect(repo.archiveAutopilot(autopilot.id).status).toBe("archived");
    expect(() => repo.createAutopilot({ title: "No assignee", assigneeId: "", workspaceId: "local" })).toThrow("Autopilot assignee is required");
  });

  it("schedules a cron trigger and claims it when due", () => {
    const repo = createRepo();
    const agentId = createAgentId();
    const autopilot = repo.createAutopilot({ title: "Cron", assigneeId: agentId, workspaceId: "local" });

    const trigger = repo.createAutopilotTrigger(autopilot.id, { kind: "schedule", cronExpression: "0 * * * *" });
    expect(trigger.kind).toBe("schedule");
    expect(trigger.nextRunAt).toBeTruthy();
    expect(repo.listAutopilotTriggers(autopilot.id).map((entry) => entry.id)).toEqual([trigger.id]);

    // Nothing is due yet; asking again an hour later claims exactly this trigger.
    expect(repo.claimDueScheduleTriggers(new Date(Date.parse(trigger.nextRunAt!) - 1000))).toEqual([]);
    const due = repo.claimDueScheduleTriggers(new Date(Date.parse(trigger.nextRunAt!) + 1000));
    expect(due.map((entry) => entry.id)).toEqual([trigger.id]);
    expect(repo.advanceScheduleTriggerNextRun(trigger.id)?.nextRunAt).toBeTruthy();
  });

  it("runs an autopilot and records a webhook delivery", () => {
    const repo = createRepo();
    const agentId = createAgentId();
    const autopilot = repo.createAutopilot({
      title: "Webhooked",
      assigneeId: agentId,
      workspaceId: "local",
    });

    // runAutopilot spawns the task through ctx.tasks().
    const run = repo.runAutopilot(autopilot.id, { source: "manual", prompt: "do the thing" });
    expect(run.autopilotId).toBe(autopilot.id);
    expect(repo.getAutopilotRun(run.id)?.id).toBe(run.id);
    expect(repo.listAutopilotRuns(autopilot.id).map((entry) => entry.id)).toEqual([run.id]);

    const result = repo.handleAutopilotWebhook(autopilot.id, {
      payload: { action: "opened" },
      headers: { "x-github-event": "issues" },
      provider: "github",
    });
    expect(result.delivery.autopilotId).toBe(autopilot.id);
    expect(repo.getWebhookDelivery(result.delivery.id)?.id).toBe(result.delivery.id);
    expect(repo.listWebhookDeliveries(autopilot.id).map((entry) => entry.id)).toContain(result.delivery.id);
  });
});
