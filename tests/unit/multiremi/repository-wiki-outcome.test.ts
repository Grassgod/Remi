import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { configureRepositoryWikiAutomation, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const rootHeaders = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.createWorkspaceMember({ id: "mem_outcome_owner", name: "Wiki Owner", role: "owner" });
  store.updateWorkspaceRepositories("local", [
    { id: "repo_outcome", name: "Outcome", url: "https://github.com/acme/outcome.git", source: "github" },
    { id: "repo_other", name: "Other", url: "https://github.com/acme/other.git", source: "github" },
  ]);
  const runtime = store.registerRuntime({ name: "outcome-test", provider: "claude", metadata: { agent_plugin_protocol: 1 } });
  const { agent, autopilot, plugin } = configureRepositoryWikiAutomation(store, { runtimeId: runtime.id });
  store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
    status: "ready", observedDigest: plugin.activeVersion!.artifactDigest, retryGeneration: 0,
  });
  db!.run("UPDATE multiremi_autopilots SET created_by_type = 'member', created_by_id = ? WHERE id = ?", [owner.id, autopilot.id]);
  const doc = store.createRepositoryWikiDoc("local", "repo_outcome", { path: "index.md", title: "Index", body: "Existing published content" });
  db!.run("UPDATE multiremi_repository_wiki_docs SET updated_at = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", doc.id]);
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  let sequence = 0;
  const begin = async () => {
    const run = store.runAutopilot(autopilot.id, { source: "manual", repositoryId: "repo_outcome",
      dedupeKey: `repo_outcome:incremental_update:revision-${++sequence}`,
      payload: { repository_wiki_repository_id: "repo_outcome" },
    });
    const task = store.getTask(run.taskId!)!;
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { ...rootHeaders, Authorization: `Bearer ${credential.token}` };
    return { run, task, headers };
  };
  const report = (headers: Record<string, string>, outcome: string, reason = "A clear reason", extra = {}, repo = "repo_outcome") =>
    app.request(`/api/workspaces/local/repos/${repo}/wiki/outcome`, {
      method: "POST", headers, body: JSON.stringify({ outcome, reason, ...extra }),
    });
  const summary = async () => {
    const response = await app.request("/api/workspaces/local/repository-wikis", { headers: rootHeaders });
    expect(response.status).toBe(200);
    return (await response.json() as any).repositories.find((entry: any) => entry.repository_id === "repo_outcome");
  };
  const publish = (headers: Record<string, string>) => app.request("/api/workspaces/local/repos/repo_outcome/wiki/index", {
    method: "PUT", headers, body: JSON.stringify({ body: `Updated knowledge ${sequence}` }),
  });
  return { store, app, agent, autopilot, doc, owner, begin, report, summary, publish };
}

describe("repository Wiki structured outcomes", () => {
  it("records blocked on the caller's run, maps completed tasks to failed automation / stale Wiki, and delivers the three-run Inbox alert", async () => {
    const f = fixture();
    for (let index = 1; index <= 3; index++) {
      const { run, task, headers } = await f.begin();
      const response = await f.report(headers, "blocked", "Connected component exceeds publish limit");
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.run).toMatchObject({ status: "blocked", task_id: task.id, autopilot_run_id: run.id });
      f.store.completeTask(task.id, { output: "Completed all checks" });
      expect(f.store.getTask(task.id)?.status).toBe("completed");
      expect(f.store.getAutopilotRun(run.id)).toMatchObject({ status: "failed", failureReason: "Wiki blocked: Connected component exceeds publish limit" });
      const summary = await f.summary();
      expect(summary).toMatchObject({ status: "stale", builds_since_publish: index,
        last_published_at: "2026-01-01T00:00:00.000Z", consecutive_blocked: index,
        build: { outcome: { status: "blocked" } } });
      const notifications = f.store.listInboxItems(f.owner.id, "local");
      const alerts = notifications.filter(item => (item.details as any)?.wiki_alert);
      if (index < 3) {
        expect(summary.alert).toBeNull();
        expect(alerts).toHaveLength(0);
      } else {
        expect(summary.alert).toMatchObject({ code: "consecutive_blocked", threshold: 3, count: 3 });
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ type: "autopilot_run_failed", severity: "attention" });
        expect(alerts[0]!.body).toContain("Connected component exceeds publish limit");
        expect(alerts[0]!.title).toContain("3 consecutive runs");
      }
    }
  });

  it("keeps quiet noop repositories healthy, resets the blocked streak, and counts facts without age-based alarms", async () => {
    const f = fixture();
    for (const outcome of ["blocked", "blocked", "noop", "noop", "noop", "noop"]) {
      const { task, headers } = await f.begin();
      expect((await f.report(headers, outcome)).status).toBe(200);
      f.store.completeTask(task.id, { output: "blocked appears here as an example, not the reported result" });
    }
    expect(await f.summary()).toMatchObject({ status: "healthy", consecutive_blocked: 0, alert: null,
      builds_since_publish: 6, last_published_at: "2026-01-01T00:00:00.000Z", build: { outcome: { status: "noop" } } });
    expect(f.store.listInboxItems(f.owner.id, "local").filter(item => (item.details as any)?.wiki_alert)).toHaveLength(0);
  });

  it("advances publication facts only for real writes and reports partial publication with the existing vocabulary", async () => {
    const f = fixture();
    const blocked = await f.begin();
    expect((await f.report(blocked.headers, "blocked")).status).toBe(200);
    f.store.completeTask(blocked.task.id, { output: "Blocked" });
    const publishing = await f.begin();
    expect((await f.report(publishing.headers, "published")).status).toBe(409);
    expect((await f.report(publishing.headers, "published_with_warnings")).status).toBe(409);
    expect((await f.publish(publishing.headers)).status).toBe(200);
    expect((await f.report(publishing.headers, "noop")).status).toBe(409);
    expect((await f.report(publishing.headers, "blocked")).status).toBe(409);
    expect((await f.report(publishing.headers, "published_with_warnings", "Updated index; remaining sources unavailable")).status).toBe(200);
    f.store.completeTask(publishing.task.id, { output: "Done" });
    const summary = await f.summary();
    expect(summary).toMatchObject({ status: "healthy", builds_since_publish: 0, consecutive_blocked: 0, alert: null,
      build: { outcome: { status: "published_with_warnings" } } });
    expect(summary.last_published_at > "2026-01-01T00:00:00.000Z").toBe(true);
    const inbox = f.store.listInboxItems(f.owner.id, "local").find(item => (item.details as any)?.run_id === publishing.run.id)!;
    expect(inbox).toMatchObject({ severity: "attention", details: { knowledge_outcome: { status: "published_with_warnings" } } });
  });

  it("recognizes actual publication without requiring a redundant outcome report", async () => {
    const f = fixture();
    const { task, headers } = await f.begin();
    expect((await f.publish(headers)).status).toBe(200);
    f.store.completeTask(task.id, { output: "done" });
    expect(await f.summary()).toMatchObject({ status: "healthy", builds_since_publish: 0, build: { outcome: { status: "published" } } });
  });

  it("enforces scope, publisher capability, identity binding, input validation, and idempotent final reports", async () => {
    const f = fixture();
    const { task, headers } = await f.begin();
    expect((await f.report(headers, "blocked", "why", {}, "repo_other")).status).toBe(403);
    expect((await f.report(rootHeaders, "blocked")).status).toBe(403);
    expect((await f.report({ ...rootHeaders, Authorization: "Bearer invalid" }, "blocked")).status).toBe(401);
    for (const extra of [{ task_id: "someone-else" }, { run_id: "other-run" }]) {
      expect((await f.report(headers, "blocked", "why", extra)).status).toBe(400);
    }
    expect((await f.report(headers, "partial")).status).toBe(400);
    expect((await f.report(headers, "blocked", " ")).status).toBe(400);
    expect((await f.report(headers, "blocked", "x".repeat(4001))).status).toBe(400);
    const first = await (await f.report(headers, "blocked")).json() as any;
    const retry = await (await f.report(headers, "blocked")).json() as any;
    expect(retry).toMatchObject({ deduplicated: true, run: { id: first.run.id } });
    expect((await f.report(headers, "noop")).status).toBe(409);
    expect((await f.report(headers, "blocked", "different reason")).status).toBe(409);
    f.store.completeTask(task.id, { output: "done" });
    expect((await f.report(headers, "blocked")).status).toBe(401);

    const ordinaryAgent = f.store.createAgent({ name: "Not a publisher", provider: "claude" });
    const ordinaryTask = f.store.createTask({ agentId: ordinaryAgent.id, prompt: "ordinary task" });
    const ordinaryToken = await f.store.createTaskAccessToken(ordinaryTask, "local");
    expect((await f.report({ ...rootHeaders, Authorization: `Bearer ${ordinaryToken.token}` }, "blocked")).status).toBe(403);
  });

  it("includes scheduled repository Lint runs that have no repository_id and does not mistake restore audits for outcomes", async () => {
    const f = fixture();
    const { run, task, headers } = await f.begin();
    db!.run("UPDATE multiremi_autopilot_runs SET repository_id = NULL, dedupe_key = NULL, schedule_target = ? WHERE id = ?", [
      JSON.stringify({ kind: "repository", id: "repo_outcome", name: "Outcome" }), run.id,
    ]);
    expect((await f.report(headers, "blocked", "Missing canonical object")).status).toBe(200);
    const audit = f.store.createKnowledgeCompilationRun({ workspaceId: "local", repositoryId: "repo_outcome", taskId: task.id,
      autopilotRunId: run.id, mode: "manual_edit" }).run;
    f.store.completeKnowledgeCompilationRun(audit.id, "noop", "Storage restore dry-run audit");
    f.store.completeTask(task.id, { output: "done" });
    expect(await f.summary()).toMatchObject({ status: "stale", builds_since_publish: 1,
      last_published_at: "2026-01-01T00:00:00.000Z", build: { run_id: run.id, outcome: { status: "blocked" } } });
  });

  it("does not classify historical prose or missing reports as blocked", async () => {
    const f = fixture();
    const { task } = await f.begin();
    f.store.completeTask(task.id, { output: "blocked: cannot publish" });
    expect(await f.summary()).toMatchObject({ status: "healthy", builds_since_publish: 1, consecutive_blocked: 0,
      alert: null, build: { outcome: null } });
  });

  it("routes a threshold alert to workspace administrators when the automation creator is unavailable", async () => {
    const f = fixture();
    db!.run("UPDATE multiremi_autopilots SET created_by_type = 'agent', created_by_id = 'deleted-agent' WHERE id = ?", [f.autopilot.id]);
    for (let index = 0; index < 3; index++) {
      const { task, headers } = await f.begin();
      expect((await f.report(headers, "blocked", "Storage unavailable")).status).toBe(200);
      f.store.completeTask(task.id, { output: "done" });
    }
    const alerts = f.store.listInboxItems(f.owner.id, "local").filter(item => (item.details as any)?.wiki_alert);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "attention", details: { wiki_alert: { count: 3 } } });
  });

  it("does not let a premature no-publication report hide a later successful write", async () => {
    const f = fixture();
    const { task, headers } = await f.begin();
    expect((await f.report(headers, "blocked", "Initially blocked")).status).toBe(200);
    expect((await f.publish(headers)).status).toBe(200);
    f.store.completeTask(task.id, { output: "Recovered and published" });
    expect(await f.summary()).toMatchObject({ status: "healthy", builds_since_publish: 0,
      consecutive_blocked: 0, alert: null, build: { outcome: { status: "published" } } });
  });
});
