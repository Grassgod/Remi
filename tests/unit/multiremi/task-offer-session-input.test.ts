import { afterEach, expect, spyOn, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { fitTaskOfferToBudget, taskOfferBytes, useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { readSessionLogRange } from "@multiremi/api/session-log-range.js";
import { normalizeDaemonClaimTask } from "@multiremi/worker/client.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import { log } from "@multiremi/api/helpers/common.js";
import { prepareTaskOffer } from "@multiremi/api/daemon-protocol/task-offers.js";
import { ProjectKnowledgeService } from "@multiremi/project-knowledge/service.js";
import type { OpenVikingClientContract } from "@multiremi/project-knowledge/types.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { resetMultiremiTestEnv } from "./helpers.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests('MUL-508 task offer input', backendFixture => {
const createLocalStore = () => backendFixture().store;
afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Input", provider: "codex" });
  const agent = store.createAgent({ name: "Input", provider: "codex", runtimeId: runtime.id });
  const issue = store.createIssue({ title: "Long issue" });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  return { store, runtime, agent, issue, session };
}

test("50 unread entries and huge Wiki offer only trigger messages and the unread range", () => {
  const f = fixture();
  for (let index = 0; index < 49; index++) f.store.createIssueComment(f.issue.id, {
    authorType: "member", authorId: "local", body: `UNREAD_${index} ${"正文".repeat(4_000)}`,
  });
  const trigger = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "TRIGGER " + "内容".repeat(10_000) });
  const task = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, triggerCommentId: trigger.id, prompt: trigger.body });
  const claimed = f.store.claimTask(f.runtime.id)!;
  const response = daemonTaskClaimResponse(f.store, claimed, f.store.getTaskTriggerMetadata(claimed));
  useTaskSessionInput(f.store, claimed, response);
  response.repository_wiki_contexts = [{ repository: { id: "repo_1" }, docs: [{ id: "doc_1", body: "大Wiki".repeat(200_000) }] }];
  const fitted = fitTaskOfferToBudget(response, f.runtime.id);
  const jsonl = (response.session_projection as { jsonl: string }).jsonl;
  expect(jsonl).toContain("TRIGGER");
  expect(jsonl).not.toContain("UNREAD_");
  expect(jsonl).not.toContain("inbox_toc");
  expect(jsonl).toContain("还有");
  expect(jsonl).toContain(`remi message list ${f.session.id} --from 0 --to`);
  const triggering = jsonl.split("\n").map(line => JSON.parse(line)).find(entry => entry.type === "triggering_message");
  expect(triggering.expand).toBe(`remi message list ${f.session.id} --from ${triggering.seq - 1} --to ${triggering.seq}`);
  expect(triggering.expand_hint).toContain(triggering.expand);
  expect(response.trigger_comment_content).toBeUndefined();
  expect(fitted.report.steps[0]).toBe("knowledge");
  expect(taskOfferBytes(response, f.runtime.id)).toBeLessThan(512 * 1024);
  expect(f.store.getTask(task.id)?.status).toBe("dispatched");
  expect(f.store.getIssue(f.issue.id)?.status).not.toBe("blocked");
  const prompt = buildTaskPrompt(normalizeDaemonClaimTask(response)!);
  expect(prompt).toContain("动手前先读完未读");
  expect(prompt).toContain("TRIGGER");
  expect(prompt).not.toContain("UNREAD_");
  expect(prompt).not.toContain("## Inbox");
});

test("coalesced rich mentions retain all triggering messages, while historical replies stay out", () => {
  const f = fixture();
  f.store.createIssueComment(f.issue.id, { authorType: "agent", authorId: f.agent.id, body: "OWN_HISTORY" });
  for (const body of ["FIRST_TRIGGER", "SECOND_TRIGGER"]) f.store.createIssueComment(f.issue.id, {
    authorType: "member", authorId: "local", body: `[@Input](mention://agent/${f.agent.id}) ${body}`,
  });
  const claimed = f.store.claimTask(f.runtime.id)!;
  const response = daemonTaskClaimResponse(f.store, claimed, f.store.getTaskTriggerMetadata(claimed));
  useTaskSessionInput(f.store, claimed, response);
  const prompt = buildTaskPrompt(normalizeDaemonClaimTask(response)!);
  expect(prompt).toContain("FIRST_TRIGGER"); expect(prompt).toContain("SECOND_TRIGGER");
  expect(prompt).not.toContain("OWN_HISTORY");
  expect(f.store.getTaskWakeSequences(claimed.id)).toHaveLength(2);
});

test("new Wiki-fetch capability keeps complete metadata without any bodies", () => {
  const payload = { id: "task", prompt: "short", project_wiki_docs: [
    { id: "project_doc", version: 1, body: "项目".repeat(200_000) },
  ], repository_wiki_contexts: [{ docs: [{ id: "repo_doc", version: 1, status: "healthy", body: "" }] }],
    project_docs: { wiki: [{ body: "duplicate" }] } };
  fitTaskOfferToBudget(payload, "runtime", undefined, true);
  expect(payload.project_wiki_docs[0]!.body).toBe("");
  expect((payload.project_wiki_docs[0] as any).content_sha256).toBeUndefined();
  expect(payload.repository_wiki_contexts[0]!.docs[0]!.status).toBe("healthy");
  expect(payload.project_docs).toBeUndefined();
  expect((payload as any).knowledge_warnings).toEqual([]);
  expect(taskOfferBytes(payload, "runtime")).toBeLessThan(512 * 1024);
});

test("legacy Wiki bodies remain complete when they fit and only enough oversized pages are omitted", () => {
  const small = { id: "task", prompt: "work", repository_wiki_contexts: [{ docs: [
    { id: "repo_small", body: "small body", status: "healthy" },
  ] }], project_wiki_docs: [{ id: "project_small", body: "project body" }] };
  fitTaskOfferToBudget(small, "runtime");
  expect(small.repository_wiki_contexts[0]!.docs[0]).toMatchObject({ body: "small body", status: "healthy" });
  expect(small.project_wiki_docs[0]!.body).toBe("project body");
  expect((small as any).knowledge_warnings).toEqual([]);
  const large = { id: "task", prompt: "work", repository_wiki_contexts: [{ docs: [
    { id: "large", body: "x".repeat(400_000), status: "healthy" },
    { id: "medium", body: "y".repeat(200_000), status: "healthy" },
    { id: "small", body: "完整页面", status: "healthy" },
  ] }], project_wiki_docs: [{ id: "project", body: "z".repeat(100_000) }] };
  fitTaskOfferToBudget(large, "runtime");
  expect(large.repository_wiki_contexts[0]!.docs[0]).toMatchObject({ body: "", status: "unavailable" });
  expect(large.repository_wiki_contexts[0]!.docs[1]).toMatchObject({ body: "y".repeat(200_000), status: "healthy" });
  expect(large.repository_wiki_contexts[0]!.docs[2]!.body).toBe("完整页面");
  expect(large.project_wiki_docs[0]!.body).toHaveLength(100_000);
  expect((large as any).knowledge_warnings).toEqual([expect.stringContaining("1 页暂不可用")]);
  expect(taskOfferBytes(large, "runtime")).toBeLessThan(512 * 1024);
});

test("cold start includes Issue title and description and reads the complete range from zero", () => {
  const f = fixture();
  f.store.updateIssue(f.issue.id, { title: "COLD_START_TITLE", description: "COLD_START_DESCRIPTION" });
  f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "FIRST_UNREAD" });
  const trigger = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "TRIGGER" });
  f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, triggerCommentId: trigger.id, prompt: trigger.body });
  const claimed = f.store.claimTask(f.runtime.id)!;
  const response = daemonTaskClaimResponse(f.store, claimed, f.store.getTaskTriggerMetadata(claimed));
  useTaskSessionInput(f.store, claimed, response);
  fitTaskOfferToBudget(response, f.runtime.id);
  const projection = response.session_projection as any;
  const range = JSON.parse(projection.jsonl.split("\n")[0]);
  expect(range).toMatchObject({ type: "unread_range", from_seq: 0, to_seq: f.store.getConversationLogHead(f.session.id)!.headSeq });
  const prompt = buildTaskPrompt(normalizeDaemonClaimTask(response)!);
  expect(prompt).toContain("COLD_START_TITLE"); expect(prompt).toContain("COLD_START_DESCRIPTION");
  expect(prompt).toContain(`remi message list ${f.session.id} --from 0 --to ${range.to_seq}`);
  expect(prompt).not.toContain("你上次读到");
  expect(prompt).not.toContain("FIRST_UNREAD");
});

test("a long prompt without an explicit trigger points to its task instead of rereading the session", () => {
  const response = { id: "manual_task", issue_session_id: "session", prompt: "正文".repeat(10_000) };
  fitTaskOfferToBudget(response, "runtime");
  expect(response.prompt).toContain("remi task get manual_task");
  expect(response.prompt).not.toContain("--from 0");
});

test("coalesced Chat input includes all triggering messages once without a duplicate chat_message body", () => {
  const f = fixture(); const chat = f.store.createChatSession({ agentId: f.agent.id });
  const first = f.store.sendChatMessage(chat.id, { body: "FIRST_CHAT_TRIGGER" });
  const second = f.store.sendChatMessage(chat.id, { body: "SECOND_CHAT_TRIGGER" });
  expect(second.task.id).toBe(first.task.id);
  const claimed = f.store.claimTask(f.runtime.id)!;
  f.store.startTask(claimed.id);
  const response = daemonTaskClaimResponse(f.store, claimed, f.store.getTaskTriggerMetadata(claimed));
  useTaskSessionInput(f.store, claimed, response);
  const prompt = buildTaskPrompt(normalizeDaemonClaimTask(response)!);
  expect(prompt).toContain("FIRST_CHAT_TRIGGER"); expect(prompt).toContain("SECOND_CHAT_TRIGGER");
  expect(response.chat_message).toBeUndefined();
  expect(prompt.match(/FIRST_CHAT_TRIGGER/g)).toHaveLength(1);
  expect(prompt.match(/SECOND_CHAT_TRIGGER/g)).toHaveLength(1);
});

test("range reads every page, rejoins long Unicode bodies, and excludes own history", async () => {
  const f = fixture();
  const body = "😀中文".repeat(30_000);
  const long = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body });
  for (let index = 0; index < 120; index++) f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: `entry ${index}` });
  const own = f.store.createIssueComment(f.issue.id, { authorType: "agent", authorId: f.agent.id, body: "OWN_HISTORY" });
  const to = f.store.getConversationLogHead(f.session.id)!.headSeq;
  let cursor: string | null = null;
  const bodies = new Map<string, string>();
  let pages = 0;
  do {
    const page = readSessionLogRange(f.store, f.session.id, 0, to, cursor ?? undefined, f.agent.id);
    for (const entry of page.entries) bodies.set(String(entry.id), (bodies.get(String(entry.id)) ?? "") + entry.body_md);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
    cursor = page.next_cursor;
    pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(3);
  expect(bodies.get(long.id)).toBe(body);
  expect(bodies.size).toBe(121);
  expect(bodies.has(own.id)).toBe(false);
  const app = createMultiremiApp({ store: f.store });
  expect((await app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${to}`)).status).toBe(200);
  for (const query of ["from=0", "from=2&to=1", "from=-1&to=4", "from=0&to=9007199254740992",
    "from=0&to=4&seq=1", "from=0&to=4&cursor=bad", "from=0&to=4&cursor=null",
    ...["unread_by", "thread", "message_kind", "after_seq", "limit", "query"].map(key => `from=0&to=4&${key}=1`)]) {
    expect((await app.request(`/api/sessions/${f.session.id}/messages?${query}`)).status).toBe(400);
  }
});

test("task-token range reads are recorded without including bodies or credentials", async () => {
  const f = fixture();
  const own = f.store.createIssueComment(f.issue.id, { authorType: "agent", authorId: f.agent.id, body: "OWN_HISTORY" });
  const peer = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: "local", body: "unread".repeat(2_000) });
  f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "read" });
  const claimed = f.store.claimTask(f.runtime.id)!;
  const credential = await f.store.createTaskAccessToken(claimed, "local");
  const app = createMultiremiApp({ store: f.store });
  const info = spyOn(log, "info").mockImplementation(() => {});
  try {
    const response = await app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${f.store.getConversationLogHead(f.session.id)!.headSeq}`,
      { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.entries.some((entry: any) => entry.id === own.id)).toBe(false);
    expect(data.entries.some((entry: any) => entry.id === peer.id)).toBe(true);
    expect(info.mock.calls).toContainEqual(["Session unread range read", expect.objectContaining({
      event: "session_log_range_read", task_id: claimed.id, agent_id: f.agent.id, session_id: f.session.id,
    })]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(credential.token);
    expect(JSON.stringify(info.mock.calls)).not.toContain(peer.body);
    info.mockImplementation(() => { throw new Error("telemetry unavailable"); });
    expect((await app.request(`/api/sessions/${f.session.id}/messages?from=0&to=1`,
      { headers: { Authorization: `Bearer ${credential.token}` } })).status).toBe(200);
    const other = f.store.createChatSession({ agentId: f.agent.id, creatorId: "other_user" });
    expect((await app.request(`/api/sessions/${other.id}/messages?from=0&to=1`,
      { headers: { Authorization: `Bearer ${credential.token}` } })).status).toBe(403);
  } finally { info.mockRestore(); }
});

for (const mode of ["sql", "openviking"] as const) test(`Wiki offers read metadata only in ${mode} mode; bodies use existing scoped read routes`, async () => {
  const f = fixture(); const project = f.store.createProject({ title: "Wiki" });
  f.store.updateWorkspaceRepositories("local", [{ id: "repo_wiki", name: "Wiki", url: "https://github.com/example/wiki.git", source: "github", default_branch: "main" }]);
  f.store.createProjectResource(project.id, { resourceType: "github_repo", resourceRef: { url: "https://github.com/example/wiki.git" } });
  f.store.updateIssue(f.issue.id, { projectId: project.id });
  const projectDoc = f.store.createProjectDoc(project.id, { kind: "wiki", slug: "guide", title: "Guide", body: "project body".repeat(70_000) });
  const repoDoc = f.store.createRepositoryWikiDoc("local", "repo_wiki", { path: "guide.md", title: "Guide", body: "repository body" });
  f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, prompt: "read" });
  const claimed = f.store.claimTask(f.runtime.id)!;
  const noBodyReads = new Proxy({} as OpenVikingClientContract, {
    get(_, operation) { throw new Error(`Metadata offers must not access OpenViking: ${String(operation)}`); },
  });
  const projectService = new ProjectKnowledgeService(f.store, mode === "sql" ? null : noBodyReads, mode);
  const repositoryService = new RepositoryWikiService(f.store, mode === "sql" ? null : noBodyReads, mode);
  const projectBodies = spyOn(projectService, "listProjectDocs").mockImplementation(async () => { throw new Error("body hydration forbidden during offer"); });
  const repositoryBodies = spyOn(repositoryService, "list").mockImplementation(async () => { throw new Error("body hydration forbidden during offer"); });
  const projectMetadata = spyOn(f.store, "listProjectDocs");
  const repositoryMetadata = spyOn(f.store, "listRepositoryWikiDocs");
  const offered = (await prepareTaskOffer(f.store, claimed, projectService, repositoryService, true))!;
  expect(projectBodies).not.toHaveBeenCalled(); expect(repositoryBodies).not.toHaveBeenCalled();
  expect(projectMetadata).toHaveBeenCalledWith(project.id, { kind: "wiki", includeBody: false });
  expect(repositoryMetadata).toHaveBeenCalledWith("local", "repo_wiki", { includeBody: false });
  projectBodies.mockRestore(); repositoryBodies.mockRestore(); projectMetadata.mockRestore(); repositoryMetadata.mockRestore();
  expect((offered.project_wiki_docs as any[])[0]).toMatchObject({ id: projectDoc.id, version: projectDoc.version, body: "" });
  expect((offered.repository_wiki_contexts as any[])[0].docs[0]).toMatchObject({ id: repoDoc.id, body: "" });
  fitTaskOfferToBudget(offered, f.runtime.id, undefined, true);
  expect((offered.project_wiki_docs as any[])[0]).toMatchObject({ id: projectDoc.id, body: "" });
  const app = createMultiremiApp({ store: f.store,
    projectKnowledge: new ProjectKnowledgeService(f.store, null, "sql"),
    repositoryWiki: new RepositoryWikiService(f.store, null, "sql") });
  for (const [path, body] of [
    [`/api/projects/${project.id}/docs/${projectDoc.id}`, projectDoc.body],
    [`/api/workspaces/local/repos/repo_wiki/wiki/${repoDoc.id}`, repoDoc.body],
  ]) {
    const response = await app.request(path!, { headers: { Authorization: `Bearer ${offered.auth_token}` } });
    expect(response.status).toBe(200);
    expect((await response.json() as any).doc.body).toBe(body);
  }
});
});
