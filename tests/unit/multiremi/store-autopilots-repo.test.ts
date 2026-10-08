// Sibling test for packages/server/src/store/repos/autopilots-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { AutopilotsRepo } from "@multiremi/store/repos/autopilots-repo.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): AutopilotsRepo {
  db = openSqliteDatabase(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return directRepo(store);
}

function directRepo(host: MultiremiStore): AutopilotsRepo {
  const ctx = (host as unknown as { ctx: StoreContext }).ctx;
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
  setSystemTime();
});

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let pgSequence = 0;
const PG_TEST_TIMEOUT = 30_000;
const INITIAL_TIME = "2026-10-03T19:00:00Z";
const INITIAL_NEXT_RUN = "2026-10-03T20:00:00.000Z";
const RESUME_TIME = "2026-10-05T19:18:00Z";
const RESUMED_NEXT_RUN = "2026-10-05T20:00:00.000Z";

async function withRepo(
  backend: "sqlite" | "postgres",
  run: (repo: AutopilotsRepo, host: MultiremiStore) => void,
): Promise<void> {
  if (backend === "sqlite") {
    const database = openSqliteDatabase(":memory:");
    try {
      const host = new MultiremiStore(database);
      host.ensureLocalWorkspace();
      run(directRepo(host), host);
    } finally {
      database.close();
    }
    return;
  }

  // Each PG case owns a disposable database; a configured but unreachable PG fails.
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `mul525_resume_${process.pid}_${++pgSequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let database: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    database = new PostgresSyncDatabase(url.toString());
    const host = new MultiremiStore(database);
    host.ensureLocalWorkspace();
    run(directRepo(host), host);
  } finally {
    database?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function dailySchedule(repo: AutopilotsRepo, host: MultiremiStore) {
  setSystemTime(new Date(INITIAL_TIME));
  const agent = host.createAgent({ name: "Daily pilot", provider: "claude", workspaceId: "local" });
  const autopilot = repo.createAutopilot({ title: "Daily release", assigneeId: agent.id, workspaceId: "local" });
  const trigger = repo.createAutopilotTrigger(autopilot.id, {
    kind: "schedule", cronExpression: "0 4 * * *", timezone: "Asia/Shanghai",
  });
  expect(trigger.nextRunAt).toBe(INITIAL_NEXT_RUN);
  return { autopilot, trigger };
}

function resumeAfterMissedRuns(repo: AutopilotsRepo, autopilotId: string): void {
  repo.updateAutopilot(autopilotId, { status: "paused" });
  setSystemTime(new Date(RESUME_TIME));
  expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
  repo.updateAutopilot(autopilotId, { status: "active" });
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-525 schedule resume (${backend})`, () => {
    it("U1: resumes after two missed runs without claiming either", async () => {
      await withRepo(backend, (repo, host) => {
        const { autopilot, trigger } = dailySchedule(repo, host);
        resumeAfterMissedRuns(repo, autopilot.id);
        expect(repo.getAutopilotTrigger(trigger.id)).toEqual({
          ...trigger, nextRunAt: RESUMED_NEXT_RUN, updatedAt: new Date().toISOString(),
        });
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
      });
    }, PG_TEST_TIMEOUT);

    it("U2: claims the next 04:00 once and advances to the following day", async () => {
      await withRepo(backend, (repo, host) => {
        const { autopilot, trigger } = dailySchedule(repo, host);
        resumeAfterMissedRuns(repo, autopilot.id);
        expect(repo.getAutopilotTrigger(trigger.id)?.nextRunAt).toBe(RESUMED_NEXT_RUN);
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);

        setSystemTime(new Date("2026-10-05T20:00:01Z"));
        expect(repo.claimDueScheduleTriggers(new Date()).map((entry) => entry.id)).toEqual([trigger.id]);
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
        expect(repo.advanceScheduleTriggerNextRun(trigger.id)?.nextRunAt).toBe("2026-10-06T20:00:00.000Z");
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
      });
    }, PG_TEST_TIMEOUT);

    it.each([
      ["on time", "2026-10-03T20:00:01Z"],
      ["overdue after downtime", RESUME_TIME],
    ])("U3: claims an active autopilot %s once", async (_label, dueTime) => {
      await withRepo(backend, (repo, host) => {
        const { trigger } = dailySchedule(repo, host);
        setSystemTime(new Date(dueTime));
        expect(repo.claimDueScheduleTriggers(new Date()).map((entry) => entry.id)).toEqual([trigger.id]);
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
      });
    }, PG_TEST_TIMEOUT);

    it("U4: preserves next_run_at for title edits and active-to-active updates", async () => {
      await withRepo(backend, (repo, host) => {
        const { autopilot, trigger } = dailySchedule(repo, host);
        setSystemTime(new Date(RESUME_TIME));
        repo.updateAutopilot(autopilot.id, { title: "Renamed active" });
        expect(repo.getAutopilotTrigger(trigger.id)).toEqual(trigger);
        repo.updateAutopilot(autopilot.id, { status: "active" });
        expect(repo.getAutopilotTrigger(trigger.id)).toEqual(trigger);
        repo.updateAutopilot(autopilot.id, { status: "paused" });
        expect(repo.getAutopilotTrigger(trigger.id)).toEqual(trigger);
        repo.updateAutopilot(autopilot.id, { title: "Renamed paused" });
        expect(repo.getAutopilotTrigger(trigger.id)).toEqual(trigger);
      });
    }, PG_TEST_TIMEOUT);

    it("U5: restores an archived autopilot without claiming missed runs", async () => {
      await withRepo(backend, (repo, host) => {
        const { autopilot, trigger } = dailySchedule(repo, host);
        repo.archiveAutopilot(autopilot.id);
        setSystemTime(new Date(RESUME_TIME));
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
        repo.updateAutopilot(autopilot.id, { status: "active" });
        expect(repo.getAutopilotTrigger(trigger.id)?.nextRunAt).toBe(RESUMED_NEXT_RUN);
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
      });
    }, PG_TEST_TIMEOUT);

    it("U6: recomputes every enabled schedule in its timezone and preserves other triggers", async () => {
      await withRepo(backend, (repo, host) => {
        const { autopilot, trigger } = dailySchedule(repo, host);
        const otherSchedule = repo.createAutopilotTrigger(autopilot.id, {
          kind: "schedule", cronExpression: "0 8 * * *", timezone: "UTC",
        });
        expect(otherSchedule.nextRunAt).toBe("2026-10-04T08:00:00.000Z");
        const webhook = repo.createAutopilotTrigger(autopilot.id, { kind: "webhook", label: "Hook" });
        const disabled = repo.createAutopilotTrigger(autopilot.id, {
          kind: "schedule", cronExpression: "0 4 * * *", timezone: "Asia/Shanghai", enabled: false,
        });
        expect(webhook.nextRunAt).toBeNull();
        expect(disabled.nextRunAt).toBeNull();

        resumeAfterMissedRuns(repo, autopilot.id);
        expect(repo.getAutopilotTrigger(trigger.id)?.nextRunAt).toBe(RESUMED_NEXT_RUN);
        expect(repo.getAutopilotTrigger(otherSchedule.id)).toEqual({
          ...otherSchedule, nextRunAt: "2026-10-06T08:00:00.000Z", updatedAt: new Date().toISOString(),
        });
        expect(repo.getAutopilotTrigger(webhook.id)).toEqual(webhook);
        expect(repo.getAutopilotTrigger(disabled.id)).toEqual(disabled);
        expect(repo.claimDueScheduleTriggers(new Date())).toEqual([]);
      });
    }, PG_TEST_TIMEOUT);
  });
}

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
