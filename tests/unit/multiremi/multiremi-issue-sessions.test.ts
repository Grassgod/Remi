import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Issue sessions and per-agent projection lanes", () => {
  it("keeps multiple product sessions isolated under one issue", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Multi-session issue", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const review = store.createIssueSession(issue.id, { title: "Review" });

    store.createIssueComment(issue.id, { issueSessionId: main.id, body: "Main-only context" });
    store.createIssueComment(issue.id, { issueSessionId: review.id, body: "Review-only context" });

    expect(store.listIssueSessions(issue.id).map((session) => session.title)).toEqual(["Main", "Review"]);
    expect(store.listSessionEvents(main.id).some((event) => event.body === "Main-only context")).toBe(true);
    expect(store.listSessionEvents(main.id).some((event) => event.body === "Review-only context")).toBe(false);
    expect(store.listSessionEvents(review.id).some((event) => event.body === "Review-only context")).toBe(true);
  });

  it("backfills one default Session and canonical events for legacy Issue rows", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Legacy worker", provider: "claude" });
    const issue = store.createIssue({ title: "Legacy issue", workspaceId: "local" });
    const comment = store.createIssueComment(issue.id, { body: "Legacy comment" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Legacy task" });

    db!.run("UPDATE multiremi_issue_comments SET issue_session_id = NULL WHERE issue_id = ?", [issue.id]);
    db!.run("UPDATE multiremi_tasks SET issue_session_id = NULL WHERE issue_id = ?", [issue.id]);
    db!.run("DELETE FROM multiremi_session_events WHERE session_id IN (SELECT id FROM multiremi_issue_sessions WHERE issue_id = ?)", [issue.id]);
    db!.run("DELETE FROM multiremi_issue_sessions WHERE issue_id = ?", [issue.id]);

    const migrated = new MultiremiStore(db!);
    const sessions = migrated.listIssueSessions(issue.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ title: "Main", isDefault: true });
    expect(migrated.getIssueComment(comment.id)?.issueSessionId).toBe(sessions[0]!.id);
    expect(migrated.getTask(task.id)?.issueSessionId).toBe(sessions[0]!.id);
    expect(migrated.listSessionEvents(sessions[0]!.id)).toEqual([
      expect.objectContaining({
        sourceCommentId: comment.id,
        body: "Legacy comment",
      }),
    ]);
  });

  it("records comment corrections as append-only Session events", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Corrections", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comment = store.createIssueComment(issue.id, {
      issueSessionId: session.id,
      body: "Original wording",
    });

    store.updateIssueComment(comment.id, { body: "Corrected wording" });
    store.resolveIssueComment(comment.id);
    store.unresolveIssueComment(comment.id);
    store.deleteIssueComment(comment.id);

    expect(store.listSessionEvents(session.id).map((event) => event.kind)).toEqual([
      "message",
      "message_edited",
      "thread_resolved",
      "thread_unresolved",
      "message_deleted",
    ]);
  });

  it("bootstraps once, resumes with delta, and keeps ACP lineage with its cursor", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_issue_session",
      name: "Issue session runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agentA = store.createAgent({ name: "Agent A", provider: "claude" });
    const agentB = store.createAgent({ name: "Agent B", provider: "claude" });
    const issue = store.createIssue({ title: "Projection", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);

    store.createIssueComment(issue.id, {
      issueSessionId: session.id,
      authorType: "agent",
      authorId: agentA.id,
      body: "A decided on an event log.",
    });
    store.createIssueComment(issue.id, {
      issueSessionId: session.id,
      authorType: "agent",
      authorId: agentB.id,
      body: "B had an earlier imported answer.",
    });
    const firstTask = store.createSessionTask(session.id, {
      agentId: agentB.id,
      prompt: "Implement the projection.",
    });

    const firstProjection = store.buildTaskSessionProjection(firstTask.id)!;
    expect(firstProjection.mode).toBe("bootstrap");
    expect(firstProjection.jsonl).toContain('"perspective":"external_agent"');
    expect(firstProjection.jsonl).toContain('"author_name":"Agent A"');
    expect(firstProjection.jsonl).toContain('"perspective":"assistant_history"');
    expect(firstProjection.jsonl).toContain("Implement the projection.");
    const firstPrompt = buildTaskPrompt({
      ...store.getTaskWithAgent(firstTask.id)!,
      issueSession: session,
      sessionProjection: firstProjection,
      issueSessionResults: [],
    } as any);
    expect(firstPrompt).toContain("Sibling Session transcripts are private");
    expect(firstPrompt).toContain(
      `remi issue session result publish ${issue.id} --session ${session.id}`,
    );
    // The result taxonomy is only useful if the agent is told it exists.
    expect(firstPrompt).toContain("--type mr|report|deploy|decision|doc|other");
    expect(firstPrompt).toContain("--ref issue:<id>");

    expect(store.claimTask(runtime.id)?.id).toBe(firstTask.id);
    store.startTask(firstTask.id);
    store.completeTask(firstTask.id, {
      output: "Projection implemented.",
      sessionId: "acp_b_1",
      workDir: "/tmp/issue-session-b",
    });

    const committedFirst = store.getTask(firstTask.id)!;
    const lane = store.getSessionAgentLane(session.id, agentB.id)!;
    expect(lane).toMatchObject({
      providerSessionId: "acp_b_1",
      runtimeId: runtime.id,
      provider: "claude",
      cursorSeq: committedFirst.projectionToSeq,
      lastTaskId: firstTask.id,
    });

    store.createIssueComment(issue.id, {
      issueSessionId: session.id,
      authorType: "member",
      body: "Please add deterministic ordering.",
    });
    const secondTask = store.createSessionTask(session.id, {
      agentId: agentB.id,
      prompt: "Add deterministic ordering.",
    });
    expect(secondTask.sessionId).toBe("acp_b_1");
    expect(secondTask.runtimeId).toBe(runtime.id);

    const secondProjection = store.buildTaskSessionProjection(secondTask.id)!;
    expect(secondProjection.mode).toBe("delta");
    expect(secondProjection.fromSeq).toBe(lane.cursorSeq);
    expect(secondProjection.jsonl).toContain("Please add deterministic ordering.");
    expect(secondProjection.jsonl).toContain("Add deterministic ordering.");
    expect(secondProjection.jsonl).not.toContain("Projection implemented.");
  });

  it("abandons a stale provider lineage and retries from a bootstrap projection", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_stale_lane",
      name: "Stale lane runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Agent B", provider: "claude" });
    const issue = store.createIssue({ title: "Stale lineage", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    store.createIssueComment(issue.id, { issueSessionId: session.id, body: "Canonical context" });

    const first = store.createSessionTask(session.id, { agentId: agent.id, prompt: "First turn" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "First answer", sessionId: "dead_acp_session" });

    const stale = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Resume turn" });
    expect(stale.sessionId).toBe("dead_acp_session");
    expect(store.claimTask(runtime.id)?.id).toBe(stale.id);
    store.startTask(stale.id);
    store.failTask(stale.id, {
      error: "Stale provider session: no conversation found",
      failureReason: "agent_error.stale_session",
      sessionId: "dead_acp_session",
    });

    const retry = store.listTasksForIssue(issue.id).find((task) => task.parentTaskId === stale.id);
    expect(retry).toBeDefined();
    expect(retry).toMatchObject({
      issueSessionId: session.id,
      sessionId: null,
      runtimeId: null,
      attempt: 2,
    });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      providerSessionId: null,
      runtimeId: null,
      cursorSeq: 0,
    });
    expect(store.buildTaskSessionProjection(retry!.id)?.mode).toBe("bootstrap");
  });

  it("drops a lane when its agent switches provider instead of resuming foreign ACP state", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_provider_lane",
      name: "Provider lane runtime",
      provider: "claude",
      workspaceId: "local",
    });
    const agent = store.createAgent({ name: "Switching agent", provider: "claude" });
    const issue = store.createIssue({ title: "Provider switch", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const first = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Claude turn" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "Claude result", sessionId: "claude_acp_lane" });
    expect(store.getSessionAgentLane(session.id, agent.id)?.providerSessionId).toBe("claude_acp_lane");

    store.updateAgent(agent.id, { provider: "codex" });
    const next = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Codex turn" });

    expect(next).toMatchObject({ sessionId: null, runtimeId: null });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      providerSessionId: null,
      runtimeId: null,
      provider: null,
      cursorSeq: 0,
    });
    expect(store.buildTaskSessionProjection(next.id)?.mode).toBe("bootstrap");
  });

  it("publishes only explicit results across sibling sessions", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Cross-session results", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const implementation = store.createIssueSession(issue.id, { title: "Implementation" });
    store.createIssueComment(issue.id, {
      issueSessionId: main.id,
      body: "Private architecture discussion.",
    });

    const result = store.publishSessionResult(main.id, {
      title: "Architecture decision",
      body: "Use one event log and one lane per agent.",
    });

    const published = store.listIssueSessionResults(issue.id);
    expect(published).toEqual([result]);
    expect(published[0]?.body).not.toContain("Private architecture discussion.");
    expect(store.listSessionEvents(implementation.id)).toHaveLength(1);
  });

  it("serves isolated Session timelines and snake-case UI contracts", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Session API", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const review = store.createIssueSession(issue.id, { title: "Review" });
    store.createIssueComment(issue.id, { issueSessionId: main.id, body: "Main context" });
    store.createIssueComment(issue.id, { issueSessionId: review.id, body: "Review context" });

    const sessionsResponse = await app.request(`/api/issues/${issue.id}/sessions`);
    expect(sessionsResponse.status).toBe(200);
    const sessions = await sessionsResponse.json();
    expect(sessions[0]).toMatchObject({
      id: main.id,
      issue_id: issue.id,
      is_default: true,
      title: "Main",
      participants: [],
    });
    expect(sessions[0].issueId).toBeUndefined();

    const timelineResponse = await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${review.id}`,
    );
    expect(timelineResponse.status).toBe(200);
    const timeline = await timelineResponse.json();
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      issue_session_id: review.id,
      content: "Review context",
      // Present but null on a human comment; the stream keys its transcript
      // affordance off this field, so it must always be on the wire.
      task_id: null,
    });

    const createdMessage = await app.request(
      `/api/issues/${issue.id}/sessions/${review.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "One more review note" }),
      },
    );
    expect(createdMessage.status).toBe(201);
    expect(await createdMessage.json()).toMatchObject({
      issue_id: issue.id,
      issue_session_id: review.id,
      content: "One more review note",
    });

    const publishedResult = await app.request(
      `/api/issues/${issue.id}/sessions/${review.id}/results`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Review decision",
          body: "Ship the deterministic projection.",
        }),
      },
    );
    expect(publishedResult.status).toBe(201);
    expect(await publishedResult.json()).toMatchObject({
      issue_id: issue.id,
      source_session_id: review.id,
      title: "Review decision",
      body: "Ship the deterministic projection.",
    });
    const resultsResponse = await app.request(`/api/issues/${issue.id}/session-results`);
    expect(resultsResponse.status).toBe(200);
    expect(await resultsResponse.json()).toEqual([
      expect.objectContaining({
        source_session_id: review.id,
        body: "Ship the deterministic projection.",
      }),
    ]);
  });

  it("roundtrips result kind and refs metadata through publish and list", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Typed results", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);

    const published = await app.request(
      `/api/issues/${issue.id}/sessions/${main.id}/results`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Merged the projection fix",
          body: "See the MR for the deterministic ordering change.",
          metadata: {
            kind: "mr",
            refs: [
              { type: "url", value: "https://example.test/mr/12" },
              { type: "issue", value: issue.id },
            ],
          },
        }),
      },
    );
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({
      metadata: {
        kind: "mr",
        refs: [
          { type: "url", value: "https://example.test/mr/12" },
          { type: "issue", value: issue.id },
        ],
      },
    });

    const listed = await app.request(`/api/issues/${issue.id}/session-results`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      expect.objectContaining({
        title: "Merged the projection fix",
        metadata: {
          kind: "mr",
          refs: [
            { type: "url", value: "https://example.test/mr/12" },
            { type: "issue", value: issue.id },
          ],
        },
      }),
    ]);
  });

  it("records the writing run's task_id on a comment posted with a task token", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const agent = store.createAgent({ name: "Reply agent", provider: "claude" });
    const issue = store.createIssue({ title: "Reply linkage", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Reply in thread" });
    const token = await store.createTaskAccessToken(task, "local");

    const res = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "In-run reply" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { author_type: string; task_id: string | null };
    expect(created.author_type).toBe("agent");
    // The linkage the per-reply transcript button depends on: the comment
    // carries the run that wrote it even when the agent posts via its tool
    // (the auto-reply path already recorded it; this is the task-token path).
    expect(created.task_id).toBe(task.id);
  });

  it("allows a task token to read its Session but not sibling raw transcripts", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const agent = store.createAgent({ name: "Scoped agent", provider: "claude" });
    const issue = store.createIssue({ title: "Session auth", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const sibling = store.createIssueSession(issue.id, { title: "Sibling" });
    store.createIssueComment(issue.id, { issueSessionId: main.id, body: "Visible current context" });
    store.createIssueComment(issue.id, { issueSessionId: sibling.id, body: "Hidden sibling context" });
    store.publishSessionResult(sibling.id, { title: "Published", body: "Safe shared result" });
    const task = store.createSessionTask(main.id, {
      agentId: agent.id,
      prompt: "Read current context",
    });
    const siblingTask = store.createSessionTask(sibling.id, {
      agentId: agent.id,
      prompt: "Private sibling task prompt",
    });
    store.appendTaskMessages(task.id, [{ type: "assistant", content: "Own raw execution log" }]);
    store.appendTaskMessages(siblingTask.id, [{ type: "assistant", content: "Sibling raw execution log" }]);
    const token = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${token.token}` };

    expect((await app.request(
      `/api/issues/${issue.id}/sessions/${main.id}/events`,
      { headers },
    )).status).toBe(200);
    expect((await app.request(
      `/api/issues/${issue.id}/sessions/${sibling.id}/events`,
      { headers },
    )).status).toBe(403);
    expect((await app.request(
      `/api/issues/${issue.id}/timeline`,
      { headers },
    )).status).toBe(403);
    expect((await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${sibling.id}`,
      { headers },
    )).status).toBe(403);
    expect((await app.request(
      `/api/issues/${issue.id}/timeline?issue_session_id=${main.id}`,
      { headers },
    )).status).toBe(200);

    const scopedCommentsResponse = await app.request(`/api/issues/${issue.id}/comments`, { headers });
    expect(scopedCommentsResponse.status).toBe(200);
    const scopedComments = await scopedCommentsResponse.json();
    expect(scopedComments.map((comment: { content: string }) => comment.content)).toContain("Visible current context");
    expect(scopedComments.map((comment: { content: string }) => comment.content)).not.toContain("Hidden sibling context");

    const detailResponse = await app.request(`/api/multiremi/issues/${issue.id}`, { headers });
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.comments.map((comment: { body: string }) => comment.body)).toContain("Visible current context");
    expect(detail.comments.map((comment: { body: string }) => comment.body)).not.toContain("Hidden sibling context");
    expect(detail.issue.tasks.map((item: { id: string }) => item.id)).toEqual([task.id]);
    expect(detail.activity).toEqual([]);

    const searchResponse = await app.request(
      `/api/issues/search?q=${encodeURIComponent("Hidden sibling context")}`,
      { headers },
    );
    expect(searchResponse.status).toBe(200);
    expect((await searchResponse.json()).issues).toEqual([]);

    const taskRunsResponse = await app.request(`/api/issues/${issue.id}/task-runs`, { headers });
    expect(taskRunsResponse.status).toBe(200);
    expect((await taskRunsResponse.json()).map((item: { id: string }) => item.id)).toEqual([task.id]);
    const rawTasksResponse = await app.request("/api/multiremi/tasks", { headers });
    expect(rawTasksResponse.status).toBe(200);
    expect((await rawTasksResponse.json()).tasks.map((item: { id: string }) => item.id)).toEqual([task.id]);
    expect((await app.request(`/api/multiremi/tasks/${siblingTask.id}`, { headers })).status).toBe(403);
    expect((await app.request(`/api/tasks/${siblingTask.id}/cancel`, {
      method: "POST",
      headers,
    })).status).toBe(403);
    expect((await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, issueId: issue.id, prompt: "Bypass Session route" }),
    })).status).toBe(403);
    expect((await app.request(`/api/tasks/${task.id}/messages`, { headers })).status).toBe(200);
    expect((await app.request(`/api/tasks/${siblingTask.id}/messages`, { headers })).status).toBe(403);

    const agentCommentResponse = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Current Session agent note" }),
    });
    expect(agentCommentResponse.status).toBe(201);
    expect(await agentCommentResponse.json()).toMatchObject({
      issue_session_id: main.id,
      author_type: "agent",
      author_id: agent.id,
    });

    expect((await app.request(`/api/issues/${issue.id}/sessions/${sibling.id}/messages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Forbidden sibling write" }),
    })).status).toBe(403);
    expect((await app.request(`/api/issues/${issue.id}/sessions/${sibling.id}/results`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Bad", body: "Forbidden sibling publish" }),
    })).status).toBe(403);

    const resultsResponse = await app.request(`/api/issues/${issue.id}/session-results`, { headers });
    expect(resultsResponse.status).toBe(200);
    expect(await resultsResponse.json()).toEqual([
      expect.objectContaining({
        source_session_id: sibling.id,
        body: "Safe shared result",
      }),
    ]);
  });
});
