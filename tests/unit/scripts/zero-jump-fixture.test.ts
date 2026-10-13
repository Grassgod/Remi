import { expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { seedZeroJumpFixture } from "../../integration/zero-jump-fixture";

it("keeps the F398 overflow fixture across independent pending agent lanes", async () => {
  const db = openSqliteDatabase(":memory:");
  try {
    const store = new MultiremiStore(db);
    const fixture = await seedZeroJumpFixture(store);
    // Every fixture root is a plain Issue: no designated human is configured or read.
    for (const id of [fixture.shortIssueId, fixture.f398IssueId, fixture.parentIssueId, fixture.reassignedParentIssueId, fixture.disabledParentIssueId, fixture.decisionActivityIssueId, fixture.longIssueId, fixture.xlongIssueId, fixture.runningIssueId]) {
      expect(store.getIssue(id)).not.toHaveProperty("responsibleMemberId");
      expect(store.resolveIssueResponsibility(id)).not.toHaveProperty("rootHuman");
    }
    const children = store.listChildIssues(fixture.parentIssueId);
    const completed = children.find(child => child.title === "Completed child")!;
    // Closed by the parent's execution owner under the done rule.
    expect(completed.status).toBe("done");
    expect(store.listIssueActivity(completed.id).find(entry => entry.type === "issue_updated")?.data)
      .toMatchObject({ status: "done", actorType: "agent", actorId: fixture.parentOwnerAgentId });
    expect(store.resolveIssueResponsibility(fixture.reassignedParentIssueId).executionOwner?.id).toBe(fixture.replacementAgentId);
    expect(store.resolveIssueResponsibility(fixture.disabledParentIssueId).executionOwner).toBeNull();
    const tasks = store.listActiveTasksForIssue(fixture.f398IssueId, { userId: fixture.userId });
    expect(tasks).toHaveLength(fixture.counts.f398QueuedTasks);
    expect(new Set(tasks.map(task => task.agentId)).size).toBe(fixture.counts.f398QueuedTasks);
    expect(tasks.every(task => task.status === "queued")).toBe(true);

    // Another request in one lane must still coalesce under the product model.
    const repeated = store.createTask({
      agentId: tasks[0]!.agentId,
      issueId: fixture.f398IssueId,
      prompt: "Another request for the same pending agent",
    });
    expect(repeated.id).toBe(tasks[0]!.id);
    expect(store.listActiveTasksForIssue(fixture.f398IssueId, { userId: fixture.userId }))
      .toHaveLength(fixture.counts.f398QueuedTasks);
  } finally {
    db.close();
  }
});
