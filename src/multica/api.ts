import { Hono } from "hono";
import { cors } from "hono/cors";
import { createLogger } from "../logger.js";
import { renderMulticaDashboardHtml } from "./dashboard.js";
import { MulticaScheduler } from "./scheduler.js";
import { MulticaStore } from "./store.js";
import type {
  AddSquadMemberInput,
  AssignIssueInput,
  CreateAgentInput,
  CreateAutopilotInput,
  CreateChatSessionInput,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreateIssueWithTaskInput,
  CreateProjectInput,
  CreateProjectResourceInput,
  CreateSquadInput,
  CreateTaskInput,
  CreateWorkspaceMemberInput,
  RegisterRuntimeInput,
  RemoveSquadMemberInput,
  RunAutopilotInput,
  SendChatMessageInput,
  UpdateAgentInput,
  UpdateAutopilotInput,
  UpdateChatSessionInput,
  UpdateIssueInput,
  UpdateProjectInput,
  UpdateSquadInput,
  UpdateWorkspaceMemberInput,
} from "./types.js";

const log = createLogger("multica-api");

export interface MulticaApiOptions {
  store?: MulticaStore;
  scheduler?: MulticaScheduler | null;
  authToken?: string | null;
  hostname?: string;
}

export function createMulticaApp(options: MulticaApiOptions = {}): Hono {
  const store = options.store ?? new MulticaStore();
  const scheduler = options.scheduler ?? null;
  const authToken = options.authToken ?? process.env.MULTICA_TOKEN ?? "";
  const app = new Hono();

  app.use("*", cors());
  app.get("/", (c) => c.html(renderMulticaDashboardHtml()));

  if (authToken) {
    app.use("*", async (c, next) => {
      const header = c.req.header("Authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (token !== authToken) return c.json({ error: "unauthorized" }, 401);
      await next();
    });
  }

  app.onError((err, c) => {
    log.error(err.message);
    return c.json({ error: err.message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/multica/health", (c) => c.json({ ok: true }));

  app.get("/api/multica/agents", (c) => c.json({ agents: store.listAgents() }));
  app.post("/api/multica/agents", async (c) => {
    const body = await readJson<CreateAgentInput>(c);
    return c.json({ agent: store.createAgent(body) }, 201);
  });
  app.post("/api/multica/agents/default", async (c) => {
    const body = await readJson<{ provider?: string }>(c);
    return c.json({ agent: store.ensureDefaultAgent(body.provider ?? "claude") }, 201);
  });
  app.get("/api/multica/agents/:id", (c) => {
    const agent = store.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "agent not found" }, 404);
    return c.json({ agent });
  });
  app.patch("/api/multica/agents/:id", async (c) => {
    const body = await readJson<UpdateAgentInput>(c);
    return c.json({ agent: store.updateAgent(c.req.param("id"), body) });
  });
  app.delete("/api/multica/agents/:id", (c) => {
    return c.json({ agent: store.archiveAgent(c.req.param("id")) });
  });

  app.get("/api/multica/members", (c) => {
    const members = store.listWorkspaceMembers(c.req.query("workspaceId"));
    return c.json({ members, total: members.length });
  });
  app.post("/api/multica/members", async (c) => {
    const body = await readJson<CreateWorkspaceMemberInput>(c);
    return c.json({ member: store.createWorkspaceMember(body) }, 201);
  });
  app.get("/api/multica/members/:id", (c) => {
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (!member) return c.json({ error: "member not found" }, 404);
    return c.json({ member });
  });
  app.patch("/api/multica/members/:id", async (c) => {
    const body = await readJson<UpdateWorkspaceMemberInput>(c);
    return c.json({ member: store.updateWorkspaceMember(c.req.param("id"), body) });
  });
  app.delete("/api/multica/members/:id", (c) => {
    return c.json({ member: store.archiveWorkspaceMember(c.req.param("id")) });
  });

  app.get("/api/multica/runtimes", (c) => c.json({ runtimes: store.listRuntimes() }));
  app.post("/api/multica/runtimes", async (c) => {
    const body = await readJson<RegisterRuntimeInput>(c);
    return c.json({ runtime: store.registerRuntime(body) }, 201);
  });
  app.post("/api/multica/runtimes/:id/heartbeat", (c) => {
    store.heartbeatRuntime(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/multica/projects", (c) => {
    const projects = store.listProjects(c.req.query("workspaceId"));
    return c.json({ projects, total: projects.length });
  });
  app.post("/api/multica/projects", async (c) => {
    const body = await readJson<CreateProjectInput>(c);
    return c.json({ project: store.createProject(body) }, 201);
  });
  app.get("/api/multica/projects/:id", (c) => {
    const project = store.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project, resources: store.listProjectResources(project.id) });
  });
  app.patch("/api/multica/projects/:id", async (c) => {
    const body = await readJson<UpdateProjectInput>(c);
    return c.json({ project: store.updateProject(c.req.param("id"), body) });
  });
  app.delete("/api/multica/projects/:id", (c) => {
    return c.json({ project: store.archiveProject(c.req.param("id")) });
  });
  app.get("/api/multica/projects/:id/resources", (c) => {
    const resources = store.listProjectResources(c.req.param("id"));
    return c.json({ resources, total: resources.length });
  });
  app.post("/api/multica/projects/:id/resources", async (c) => {
    const body = await readJson<CreateProjectResourceInput>(c);
    return c.json({ resource: store.createProjectResource(c.req.param("id"), body) }, 201);
  });
  app.delete("/api/multica/projects/:id/resources/:resourceId", (c) => {
    store.deleteProjectResource(c.req.param("id"), c.req.param("resourceId"));
    return c.json({ ok: true });
  });

  app.get("/api/multica/squads", (c) => {
    const squads = store.listSquads(c.req.query("workspaceId"));
    return c.json({ squads, total: squads.length });
  });
  app.post("/api/multica/squads", async (c) => {
    const body = await readJson<CreateSquadInput>(c);
    return c.json({ squad: store.createSquad(body) }, 201);
  });
  app.get("/api/multica/squads/:id", (c) => {
    const squad = store.getSquad(c.req.param("id"));
    if (!squad) return c.json({ error: "squad not found" }, 404);
    return c.json({ squad, members: store.listSquadMembers(squad.id) });
  });
  app.patch("/api/multica/squads/:id", async (c) => {
    const body = await readJson<UpdateSquadInput>(c);
    return c.json({ squad: store.updateSquad(c.req.param("id"), body) });
  });
  app.delete("/api/multica/squads/:id", (c) => {
    return c.json({ squad: store.archiveSquad(c.req.param("id")) });
  });
  app.get("/api/multica/squads/:id/members", (c) => {
    return c.json({ members: store.listSquadMembers(c.req.param("id")) });
  });
  app.post("/api/multica/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(c.req.param("id"), body) }, 201);
  });
  app.patch("/api/multica/squads/:id/members", async (c) => {
    const body = await readJson<AddSquadMemberInput>(c);
    return c.json({ member: store.addSquadMember(c.req.param("id"), body) });
  });
  app.delete("/api/multica/squads/:id/members", async (c) => {
    const body = await readJson<RemoveSquadMemberInput>(c);
    store.removeSquadMember(c.req.param("id"), body);
    return c.json({ ok: true });
  });

  app.get("/api/multica/autopilots", (c) => {
    const autopilots = store.listAutopilots(c.req.query("workspaceId"));
    return c.json({ autopilots, total: autopilots.length });
  });
  app.post("/api/multica/autopilots", async (c) => {
    const body = await readJson<CreateAutopilotInput>(c);
    const autopilot = store.createAutopilot(body);
    scheduler?.sync();
    return c.json({ autopilot }, 201);
  });
  app.get("/api/multica/autopilots/:id", (c) => {
    const autopilot = store.getAutopilot(c.req.param("id"));
    if (!autopilot) return c.json({ error: "autopilot not found" }, 404);
    return c.json({ autopilot, runs: store.listAutopilotRuns(autopilot.id) });
  });
  app.patch("/api/multica/autopilots/:id", async (c) => {
    const body = await readJson<UpdateAutopilotInput>(c);
    const autopilot = store.updateAutopilot(c.req.param("id"), body);
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.delete("/api/multica/autopilots/:id", (c) => {
    const autopilot = store.archiveAutopilot(c.req.param("id"));
    scheduler?.sync();
    return c.json({ autopilot });
  });
  app.get("/api/multica/autopilots/:id/runs", (c) => {
    return c.json({ runs: store.listAutopilotRuns(c.req.param("id")) });
  });
  app.post("/api/multica/autopilots/:id/run", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json({ run: store.runAutopilot(c.req.param("id"), body) }, 201);
  });
  app.post("/api/multica/autopilots/:id/run-scheduled", (c) => {
    const run = scheduler?.trigger(c.req.param("id")) ?? store.runAutopilot(c.req.param("id"), { source: "schedule" });
    return c.json({ run }, 201);
  });
  app.get("/api/multica/scheduler", (c) => {
    return c.json({
      enabled: Boolean(scheduler),
      scheduledIds: scheduler?.scheduledIds() ?? [],
      total: scheduler?.scheduledCount() ?? 0,
    });
  });
  app.post("/api/multica/autopilots/:id/trigger", async (c) => {
    const body = await readJson<RunAutopilotInput>(c);
    return c.json({
      run: store.runAutopilot(c.req.param("id"), { ...body, source: body.source ?? "api" }),
    }, 201);
  });
  app.post("/api/multica/autopilots/:id/webhook", async (c) => {
    const body = await readJson<RunAutopilotInput & { payload?: unknown }>(c);
    return c.json({
      run: store.runAutopilot(c.req.param("id"), {
        prompt: body.prompt ?? null,
        payload: body.payload ?? body,
        source: "webhook",
      }),
    }, 201);
  });

  app.get("/api/multica/issues", (c) => {
    const issues = store.listIssues().map((issue) => {
      const tasks = store.listTasksForIssue(issue.id);
      return {
        ...issue,
        taskCount: tasks.length,
        latestTaskStatus: tasks[0]?.status ?? null,
        latestTaskId: tasks[0]?.id ?? null,
      };
    });
    return c.json({ issues });
  });
  app.post("/api/multica/issues", async (c) => {
    const body = await readJson<CreateIssueWithTaskInput>(c);
    const assigneeType = body.assigneeType ?? (body.agentId ? "agent" : null);
    const assigneeId = body.assigneeId ?? body.agentId ?? null;
    const issue = store.createIssue({ ...body, assigneeType: null, assigneeId: null });
    let task = null;
    if (assigneeType && assigneeId) {
      const assigned = store.assignIssue(issue.id, {
        assigneeType,
        assigneeId,
        prompt: body.prompt ?? body.title,
      });
      return c.json({ issue: assigned.issue, task: assigned.task }, 201);
    }
    return c.json({ issue, task }, 201);
  });
  app.get("/api/multica/issues/:id", (c) => {
    const issue = store.getIssueWithTasks(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    return c.json({
      issue,
      comments: store.listIssueComments(issue.id),
      activity: store.listIssueActivity(issue.id),
    });
  });
  app.patch("/api/multica/issues/:id", async (c) => {
    const body = await readJson<UpdateIssueInput>(c);
    return c.json({ issue: store.updateIssue(c.req.param("id"), body) });
  });
  app.post("/api/multica/issues/:id/assign", async (c) => {
    const body = await readJson<AssignIssueInput>(c);
    return c.json(store.assignIssue(c.req.param("id"), body));
  });
  app.get("/api/multica/issues/:id/comments", (c) => {
    return c.json({ comments: store.listIssueComments(c.req.param("id")) });
  });
  app.post("/api/multica/issues/:id/comments", async (c) => {
    const body = await readJson<CreateIssueCommentInput>(c);
    return c.json({ comment: store.createIssueComment(c.req.param("id"), body) }, 201);
  });
  app.get("/api/multica/issues/:id/metadata", (c) => {
    return c.json({ metadata: store.listIssueMetadata(c.req.param("id")) });
  });
  app.put("/api/multica/issues/:id/metadata/:key", async (c) => {
    const body = await readJson<{ value?: unknown }>(c);
    return c.json({ metadata: store.setIssueMetadataKey(c.req.param("id"), c.req.param("key"), body.value) });
  });
  app.delete("/api/multica/issues/:id/metadata/:key", (c) => {
    return c.json({ metadata: store.deleteIssueMetadataKey(c.req.param("id"), c.req.param("key")) });
  });

  app.get("/api/multica/chats", (c) => {
    const sessions = store.listChatSessions(c.req.query("workspaceId"));
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multica/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    return c.json({ session: store.createChatSession(body) }, 201);
  });
  app.get("/api/multica/chats/:id", (c) => {
    const session = store.getChatSession(c.req.param("id"));
    if (!session) return c.json({ error: "chat session not found" }, 404);
    return c.json({ session, messages: store.listChatMessages(session.id) });
  });
  app.patch("/api/multica/chats/:id", async (c) => {
    const body = await readJson<UpdateChatSessionInput>(c);
    return c.json({ session: store.updateChatSession(c.req.param("id"), body) });
  });
  app.get("/api/multica/chats/:id/messages", (c) => {
    return c.json({ messages: store.listChatMessages(c.req.param("id")) });
  });
  app.post("/api/multica/chats/:id/messages", async (c) => {
    const body = await readJson<SendChatMessageInput>(c);
    return c.json(store.sendChatMessage(c.req.param("id"), body), 201);
  });

  app.get("/api/multica/tasks", (c) => {
    const status = c.req.query("status") as any;
    return c.json({ tasks: store.listTasks(status) });
  });
  app.post("/api/multica/tasks", async (c) => {
    const body = await readJson<CreateTaskInput>(c);
    return c.json({ task: store.createTask(body) }, 201);
  });
  app.get("/api/multica/tasks/:id", (c) => {
    const task = store.getTaskWithAgent(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json({ task });
  });
  app.post("/api/multica/tasks/:id/cancel", (c) => {
    return c.json({ task: store.cancelTask(c.req.param("id")) });
  });
  app.get("/api/multica/tasks/:id/messages", (c) => {
    return c.json({ messages: store.listTaskMessages(c.req.param("id")) });
  });

  // Multica daemon-compatible endpoints.
  app.post("/api/daemon/runtimes/:runtimeId/tasks/claim", (c) => {
    const task = store.claimTask(c.req.param("runtimeId"));
    return c.json({ task });
  });
  app.post("/api/daemon/runtimes/:runtimeId/recover-orphans", (c) => {
    const recovered = store.recoverOrphans(c.req.param("runtimeId"));
    return c.json({ recovered });
  });
  app.post("/api/daemon/tasks/:taskId/start", (c) => {
    return c.json({ task: store.startTask(c.req.param("taskId")) });
  });
  app.post("/api/daemon/tasks/:taskId/progress", async (c) => {
    const body = await readJson<{ summary?: string; step?: number; total?: number }>(c);
    store.reportProgress(c.req.param("taskId"), body.summary ?? "", body.step, body.total);
    return c.json({ ok: true });
  });
  app.post("/api/daemon/tasks/:taskId/messages", async (c) => {
    const body = await readJson<{ messages?: any[] }>(c);
    const messages = store.appendTaskMessages(c.req.param("taskId"), body.messages ?? []);
    return c.json({ messages });
  });
  app.post("/api/daemon/tasks/:taskId/session", async (c) => {
    const body = await readJson<{ session_id?: string; sessionId?: string; work_dir?: string; workDir?: string }>(c);
    store.pinTaskSession(
      c.req.param("taskId"),
      body.session_id ?? body.sessionId ?? null,
      body.work_dir ?? body.workDir ?? null,
    );
    return c.json({ ok: true });
  });
  app.post("/api/daemon/tasks/:taskId/complete", async (c) => {
    const body = await readJson<{ output?: string; branch_name?: string; session_id?: string; work_dir?: string }>(c);
    const task = store.completeTask(c.req.param("taskId"), {
      output: body.output ?? "",
      branchName: body.branch_name ?? null,
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
    });
    return c.json({ task });
  });
  app.post("/api/daemon/tasks/:taskId/fail", async (c) => {
    const body = await readJson<{ error?: string; session_id?: string; work_dir?: string }>(c);
    const task = store.failTask(c.req.param("taskId"), {
      error: body.error ?? "Task failed",
      sessionId: body.session_id ?? null,
      workDir: body.work_dir ?? null,
    });
    return c.json({ task });
  });
  app.post("/api/daemon/tasks/:taskId/usage", async (c) => {
    const body = await readJson<{ usage?: any[] }>(c);
    store.reportTaskUsage(c.req.param("taskId"), body.usage ?? []);
    return c.json({ ok: true });
  });
  app.get("/api/daemon/tasks/:taskId/status", (c) => {
    return c.json({ status: store.getTaskStatus(c.req.param("taskId")) });
  });

  return app;
}

export function startMulticaServer(options: MulticaApiOptions & { port?: number } = {}): ReturnType<typeof Bun.serve> {
  const store = options.store ?? new MulticaStore();
  const scheduler = options.scheduler === undefined ? new MulticaScheduler({ store }) : options.scheduler;
  scheduler?.start();
  const app = createMulticaApp({ ...options, store, scheduler });
  const port = options.port ?? parseInt(process.env.MULTICA_PORT ?? "6130", 10);
  const hostname = options.hostname ?? process.env.MULTICA_HOST ?? "0.0.0.0";
  const server = Bun.serve({ port, hostname, fetch: app.fetch });
  const stopServer = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    scheduler?.stop();
    return stopServer(closeActiveConnections);
  };
  return server;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return await c.req.json() as T;
  } catch {
    return {} as T;
  }
}
