import { afterEach, describe, expect, it } from "bun:test";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

/**
 * A leader that re-mentions the same teammate is continuing that conversation,
 * not opening a second one. The platform reuses the delegation so the follow-up
 * lands on the teammate's established provider session as a delta instead of
 * cold-bootstrapping the whole Issue again.
 */
function fixture() {
  const store = createStore();
  const runtime = store.registerRuntime({
    id: "mention-runner",
    name: "mention-runner",
    provider: "codex",
    maxConcurrency: 4,
    metadata: { parallel_agent_execution: 1, cli_version: "0.2.77" },
  });
  const leader = store.createAgent({ name: "Leader", provider: "codex" });
  const teammate = store.createAgent({ name: "Teammate", provider: "codex" });
  const squad = store.createSquad({ name: "Delivery", leaderId: leader.id, memberIds: [teammate.id] });
  const issue = store.createIssue({
    title: "Repeated delegation",
    assigneeType: "squad",
    assigneeId: squad.id,
  });
  const main = store.createTask({ agentId: leader.id, issueId: issue.id, prompt: "Coordinate." });
  expect(main.issueSessionId).toBeTruthy();
  expect(store.claimTask(runtime.id)?.id).toBe(main.id);
  store.buildTaskSessionProjection(main.id);
  store.startTask(main.id);
  const mention = (body: string) => store.createIssueComment(issue.id, {
    authorType: "agent",
    authorId: leader.id,
    taskId: main.id,
    issueSessionId: main.issueSessionId,
    body: `${body} [@Teammate](mention://agent/${teammate.id})`,
  });
  const delegated = () => store
    .listTasksForIssue(issue.id)
    .filter((task) => task.agentId === teammate.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { store, runtime, leader, teammate, issue, main, mention, delegated };
}

describe("rich mention continuation", () => {
  it("bootstraps the first mention for a teammate with no lane yet", () => {
    const f = fixture();
    f.mention("Kick off the work.");
    const [first] = f.delegated();
    expect(first?.delegationId).toStartWith("dlg_");
    expect(f.store.buildTaskSessionProjection(first!.id)?.mode).toBe("bootstrap");
  });

  it("reuses the delegation and projects a delta on the next mention", () => {
    const f = fixture();
    f.mention("First pass.");
    const [first] = f.delegated();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first!.id);
    f.store.buildTaskSessionProjection(first!.id);
    f.store.startTask(first!.id);
    f.store.completeTask(first!.id, {
      output: "first done",
      sessionId: "provider_one",
      workDir: "/tmp/one",
    });

    f.mention("Now apply the review feedback.");
    const [second] = f.delegated().slice(1);
    expect(second?.id).not.toBe(first!.id);
    expect(second?.delegationId).toBe(first!.delegationId);
    expect(f.store.buildTaskSessionProjection(second!.id)?.mode).toBe("delta");
    expect(f.store.getSessionAgentLane(f.main.issueSessionId!, f.teammate.id, first!.delegationId!))
      .toMatchObject({ providerSessionId: "provider_one" });
  });

  it("queues the continuation behind a teammate that is still working", () => {
    const f = fixture();
    f.mention("First pass.");
    const [first] = f.delegated();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first!.id);
    f.store.buildTaskSessionProjection(first!.id);
    f.store.startTask(first!.id);

    f.mention("One more thing while you are in there.");
    const [second] = f.delegated().slice(1);
    expect(second?.delegationId).toBe(first!.delegationId);
    expect(f.store.getTaskQueueBlocker(second!.id)?.taskId).toBe(first!.id);
    expect(f.store.claimTask(f.runtime.id)).toBeNull();
  });
});
