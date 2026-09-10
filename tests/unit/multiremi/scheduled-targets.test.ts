import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, configureRepositoryWikiAutomation, db, resetMultiremiTestEnv } from "./helpers.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiScheduler } from "@daemon/scheduler.js";

afterEach(resetMultiremiTestEnv);

function setup() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Scheduled worker", provider: "claude", maxConcurrentTasks: 1 });
  const project = store.createProject({ title: "Example" });
  store.updateWorkspace("local", { repos: [{ id: "repo_example", name: "Example", url: "https://github.com/example/example.git", source: "github" }] });
  const autopilot = store.createAutopilot({ title: "Nightly", assigneeId: agent.id, executionMode: "run_only" });
  const trigger = store.createAutopilotTrigger(autopilot.id, {
    kind: "schedule", cronExpression: "0 3 * * *", timezone: "Asia/Shanghai",
    scheduleTargets: { projects: { all: true, ids: [] }, repositories: { all: true, ids: [] }, prompt: "Lint the selected target" },
  });
  return { store, agent, project, autopilot, trigger };
}

describe("scheduled targets", () => {
  it("fills independent target slots up to the agent capacity and does not duplicate an active batch", () => {
    const { store, agent, autopilot, trigger } = setup();
    store.updateAgent(agent.id, { maxConcurrentTasks: 2 });
    store.createProject({ title: "Third target" });
    store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    const runs = store.listAutopilotRuns(autopilot.id);
    expect(runs.filter((run) => run.status === "running")).toHaveLength(2);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1);
    store.advanceScheduledTargetRuns();
    store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(3);
    store.cancelTask(runs.find((run) => run.taskId)!.taskId!);
    store.advanceScheduledTargetRuns();
    expect(store.listAutopilotRuns(autopilot.id).filter((run) => run.status === "running")).toHaveLength(2);
  });

  it("publishes Raw for issue-free project and repository tasks without broadening their scope", async () => {
    const { store, project, autopilot, trigger } = setup();
    const { agent } = configureRepositoryWikiAutomation(store);
    store.updateAgent(agent.id, { maxConcurrentTasks: 1 });
    store.updateAutopilot(autopilot.id, { assigneeId: agent.id });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const first = store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    const runFor = () => store.listAutopilotRuns(autopilot.id).find((run) => run.status === "running")!;
    for (const target of [{ kind: "project", id: project.id }, { kind: "repository", id: "repo_example" }] as const) {
      const run = runFor();
      expect(run.scheduleTarget?.id).toBe(target.id);
      const credential = await store.createTaskAccessToken(store.getTask(run.taskId!)!, "local");
      const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
      const rawResponse = await app.request("/api/knowledge/submissions", { method: "POST", headers, body: JSON.stringify({ workspace_id: "local", scope: target.kind === "project" ? "project_wiki" : "repository_wiki", [target.kind === "project" ? "project_id" : "repository_id"]: target.id, body: "Source facts" }) });
      expect(rawResponse.status).toBe(201);
      const raw = await rawResponse.json() as any;
      const publishPath = target.kind === "project" ? `/api/projects/${target.id}/knowledge/publish` : `/api/workspaces/local/repos/${target.id}/wiki/publish`;
      const response = await app.request(publishPath, { method: "POST", headers, body: JSON.stringify({ submission_ids: [raw.submission.id], dedupe_key: `scheduled:${run.id}`, outputs: [{ action: "create", kind: "wiki", title: "Guide", path: "guides/guide.md", body: "Verified facts" }] }) });
      expect(response.status).toBe(200);
      expect(store.getKnowledgeSubmission(raw.submission.id)?.status).toBe("consumed");
      const denied = await app.request(target.kind === "repository" ? `/api/projects/${project.id}/knowledge/publish` : "/api/workspaces/local/repos/repo_example/wiki/publish", { method: "POST", headers, body: JSON.stringify({ outputs: [{ action: "noop" }] }) });
      expect(denied.status).toBe(403);
      db!.run("UPDATE multiremi_autopilot_runs SET status = 'completed' WHERE id = ?", [run.id]);
      store.advanceScheduledTargetRuns();
    }
    expect(first.issueId).toBeNull();
  });

  it("adds a target schedule to a project event automation without changing event behavior", async () => {
    const { store, agent, project } = setup();
    const autopilot = store.createAutopilot({ title: "Project events", assigneeId: agent.id, executionMode: "trigger_issue" });
    store.createAutopilotTrigger(autopilot.id, { kind: "system_event", eventConfig: { resource: "issue", event: "status_changed", conditions: [{ field: "status", operator: "becomes", value: "done" }] } });
    const trigger = store.createAutopilotTrigger(autopilot.id, { kind: "schedule", cronExpression: "0 3 * * *", scheduleTargets: { projects: { all: false, ids: [project.id] }, repositories: { all: false, ids: [] }, prompt: "lint" } });
    store.updateAutopilot(autopilot.id, { title: "Renamed" });
    const run = store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    expect(run.taskId).toBeTruthy();
    expect(run.issueId).toBeNull();
    const issue = store.createIssue({ title: "Delivered", projectId: project.id });
    const eventRun = store.runAutopilot(autopilot.id, { triggerIssueId: issue.id });
    expect(eventRun.issueId).toBe(issue.id);
    expect(eventRun.scheduleTarget).toBeNull();
    expect(() => store.updateAutopilotTrigger(autopilot.id, trigger.id, { scheduleTargets: null })).toThrow("requires schedule_targets");
  });

  it("skips an empty catalog, validates config PATCH, and paginates more than twenty targets", async () => {
    const { store, autopilot, trigger } = setup();
    for (let i = 0; i < 22; i++) store.createProject({ title: `Extra ${i}` });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
    const patch = await app.request(`/api/autopilots/${autopilot.id}/triggers/${trigger.id}`, { method: "PATCH", headers, body: JSON.stringify({ schedule_targets: { projects: { all: true, ids: [] }, repositories: { all: false, ids: [] }, prompt: "new prompt" } }) });
    expect(patch.status).toBe(200);
    expect(store.getAutopilotTrigger(trigger.id)?.scheduleTargets?.prompt).toBe("new prompt");
    store.runAutopilot(autopilot.id, {});
    const page = await app.request(`/api/autopilots/${autopilot.id}/runs?offset=20&limit=20`, { headers });
    const data = await page.json() as any;
    expect(data.runs).toHaveLength(3);
    expect(data.runs.every((run: any) => run.schedule_target?.kind === "project")).toBe(true);
    expect(() => store.updateAutopilot(autopilot.id, { executionMode: "create_issue" })).toThrow("schedule_targets");
    const empty = createLocalStore();
    const worker = empty.createAgent({ name: "Empty", provider: "claude" });
    const rule = empty.createAutopilot({ title: "Empty", assigneeId: worker.id, executionMode: "run_only" });
    const time = empty.createAutopilotTrigger(rule.id, { kind: "schedule", scheduleTargets: { projects: { all: true, ids: [] }, repositories: { all: false, ids: [] } } });
    expect(empty.runAutopilot(rule.id, { triggerId: time.id }).status).toBe("skipped");
  });
  it("expands mixed targets without issues, serializes execution and resumes after failure", () => {
    const { store, project, autopilot, trigger } = setup();
    const run = store.runAutopilot(autopilot.id, { source: "schedule", triggerId: trigger.id });
    expect(run.scheduleTarget).toEqual({ kind: "project", id: project.id, name: "Example" });
    expect(run.taskId).toBeTruthy();
    expect(store.getTaskWithAgent(run.taskId!)?.project?.id).toBe(project.id);
    expect(store.getTask(run.taskId!)?.issueId).toBeNull();
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(2);
    expect(store.listAutopilotRuns(autopilot.id).filter((r) => r.status === "queued")).toHaveLength(1);
    store.runAutopilot(autopilot.id, { source: "schedule", triggerId: trigger.id });
    expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(2);
    store.cancelTask(run.taskId!);
    expect(store.getAutopilotRun(run.id)?.status).toBe("failed");
    new MultiremiScheduler({ store }).sync();
    const next = store.listAutopilotRuns(autopilot.id).find((r) => r.scheduleTarget?.kind === "repository")!;
    expect(next.status).toBe("running");
    expect(next.taskId).toBeTruthy();
    expect(store.getTask(next.taskId!)?.prompt).toContain("repo_example");
    expect(store.getTask(next.taskId!)?.issueId).toBeNull();
  });

  it("all is dynamic, selected targets are exact, and empty catalogs skip", () => {
    const { store, autopilot, trigger } = setup();
    const extra = store.createProject({ title: "Added after configuration" });
    store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    expect(store.listAutopilotRuns(autopilot.id).some((r) => r.scheduleTarget?.id === extra.id)).toBe(true);
    expect(() => store.createAutopilotTrigger(autopilot.id, { kind: "schedule", scheduleTargets: { projects: { all: false, ids: ["not-in-workspace"] }, repositories: { all: false, ids: [] } } })).toThrow("workspace");
    expect(() => store.createAutopilotTrigger(autopilot.id, { kind: "schedule", scheduleTargets: { projects: { all: false, ids: [] }, repositories: { all: false, ids: [] } } })).toThrow("at least one");
  });

  it("skips removed targets and respects paused automations", () => {
    const { store, autopilot, trigger } = setup();
    const first = store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    db!.run("UPDATE multiremi_autopilot_runs SET status = 'completed' WHERE id = ?", [first.id]);
    store.updateAutopilot(autopilot.id, { status: "paused" });
    store.advanceScheduledTargetRuns();
    expect(store.listAutopilotRuns(autopilot.id).some((r) => r.status === "queued")).toBe(true);
    store.updateWorkspace("local", { repos: [] });
    store.updateAutopilot(autopilot.id, { status: "active" });
    store.advanceScheduledTargetRuns();
    expect(store.listAutopilotRuns(autopilot.id).find((r) => r.scheduleTarget?.kind === "repository")?.status).toBe("skipped");
  });

  it("API round trips target configuration and task credentials cannot forge a target", async () => {
    const { store, agent, project, autopilot, trigger } = setup();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
    const response = await app.request(`/api/autopilots/${autopilot.id}`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.triggers[0].schedule_targets.projects.all).toBe(true);
    const run = store.runAutopilot(autopilot.id, { triggerId: trigger.id });
    const token = await store.createTaskAccessToken(store.getTask(run.taskId!)!, "local");
    const taskHeaders = { ...headers, Authorization: `Bearer ${token.token}` };
    const context = await (await app.request("/api/cli/context", { headers: taskHeaders })).json() as any;
    expect(context.current.project.id).toBe(project.id);
    expect(context.current.schedule_target.id).toBe(project.id);
    const foreignWorkspace = store.createWorkspace({ name: "Foreign", slug: "foreign" });
    const foreignProject = store.createProject({ title: "Foreign", workspaceId: foreignWorkspace.id });
    expect(() => store.updateAutopilotTrigger(autopilot.id, trigger.id, { scheduleTargets: { projects: { all: false, ids: [foreignProject.id] }, repositories: { all: false, ids: [] } } })).toThrow("workspace");
    const submit = (projectId: string) => app.request("/api/knowledge/submissions", { method: "POST", headers: taskHeaders, body: JSON.stringify({ workspace_id: "local", project_id: projectId, scope: "project_wiki", body: "Evidence" }) });
    expect((await submit(project.id)).status).toBe(201);
    const other = store.createProject({ title: "Other" });
    expect((await submit(other.id)).status).toBe(403);
    const ordinary = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "target" });
    const ordinaryToken = await store.createTaskAccessToken(ordinary, "local");
    const denied = await app.request("/api/knowledge/submissions", { method: "POST", headers: { ...headers, Authorization: `Bearer ${ordinaryToken.token}` }, body: JSON.stringify({ project_id: project.id, scope: "project_wiki", body: "Evidence", schedule_target: { kind: "project", id: project.id } }) });
    expect(denied.status).toBe(403);
  });
});
