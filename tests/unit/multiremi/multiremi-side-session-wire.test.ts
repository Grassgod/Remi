import { afterEach, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { createStore, jsonResponse, mockFetch, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

it("carries frozen inherited history and its truncation metadata through claim, client and prompt", async () => {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_side_wire", name: "side", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Side agent", provider: "claude", runtimeId: runtime.id });
  const issue = store.createIssue({ title: "Side wire" });
  const parent = store.getOrCreateDefaultIssueSession(issue.id);
  store.appendSessionEvent(parent.id, { authorType: "agent", authorId: agent.id, kind: "message", body: "Parent reference decision" });
  const side = store.createIssueSession(issue.id, { title: "Side", parentSessionId: parent.id });
  store.appendSessionEvent(parent.id, { authorType: "user", authorId: "local", kind: "message", body: "Later parent message" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: side.id, prompt: "Explain the earlier decision" });
  const wire = daemonTaskClaimResponse(store, store.getTaskWithAgent(task.id)!);
  const inherited = wire.inherited_session_projection as any;
  expect(inherited).toMatchObject({ session_id: parent.id, session_title: parent.title, to_seq: side.inheritCutoffSeq, truncated: false, omitted_events: 0 });
  expect(inherited.jsonl).toContain("inherited_agent");
  expect(inherited.jsonl).not.toContain("assistant_history");
  expect(inherited.jsonl).not.toContain("Later parent message");
  mockFetch(() => jsonResponse({ task: wire }));
  const normalized = await new MultiremiDaemonClient("https://remi.example").claimTask(runtime.id);
  expect(normalized?.inheritedSessionProjection).toEqual(inherited);
  const prompt = buildTaskPrompt(normalized as any);
  expect(prompt).toContain(`## Inherited Context From Session "${parent.title}"`);
  expect(prompt).toContain("Parent reference decision");
  expect(prompt).not.toContain("Later parent message");
  const request = prompt.indexOf("## Current Request");
  const snapshot = prompt.indexOf("## Inherited Context");
  const boundary = prompt.indexOf("## Side Conversation Boundary");
  const own = prompt.indexOf("## Current Session Context");
  expect(request).toBeLessThan(snapshot);
  expect(snapshot).toBeLessThan(boundary);
  expect(boundary).toBeLessThan(own);
  expect(prompt).toContain("Current Request at the top");
  expect(prompt).toContain("Sub-agents are off-limits");
});

it("suppresses squad delegation guidance on side turns, supports snake fields, and keeps private chat separate", () => {
  const task: any = {
    id: "tsk_side", workspaceId: "local", prompt: "Discuss", issueId: "issue", repos: [], projectResources: [],
    agent: { id: "leader", name: "Leader", provider: "claude", skills: [], instructions: "" },
    issue_session: { id: "side", title: "Side", inherit_mode: "snapshot" },
    inherited_session_projection: {
      session_title: "Main", mode: "bootstrap", jsonl: '{"perspective":"inherited_user","body":"Reference"}',
      truncated: true, omitted_events: 7,
    },
    session_projection: { mode: "delta", jsonl: '{"body":"Own turn"}' },
    squadContext: {
      name: "Team", leaderAgentId: "leader", members: [{ agentId: "other", name: "Peer", role: "member" }],
    },
  };
  const sidePrompt = buildTaskPrompt(task);
  expect(sidePrompt).toContain("7 events omitted");
  expect(sidePrompt).toContain("## Side Conversation Boundary");
  expect(sidePrompt).not.toContain("## Squad Coordination");
  expect(sidePrompt).not.toContain("MULTIREMI_COMMENT");
  const ordinary = { ...task, inherited_session_projection: null, issue_session: { id: "normal", title: "Normal" } };
  expect(buildTaskPrompt(ordinary)).toContain("## Squad Coordination");
  expect(buildTaskPrompt(ordinary)).not.toContain("## Side Conversation Boundary");
  const privateChat = buildTaskPrompt({ ...task, chatSessionId: "private" });
  expect(privateChat).not.toContain("## Inherited Context");
  expect(privateChat).not.toContain("## Side Conversation Boundary");
});
