import { expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { seedZeroJumpFixture } from "../../integration/zero-jump-fixture";

it("keeps the F398 overflow fixture across independent pending agent lanes", async () => {
  const db = openSqliteDatabase(":memory:");
  try {
    const store = new MultiremiStore(db);
    const fixture = await seedZeroJumpFixture(store);
    for (const id of [fixture.shortIssueId, fixture.f398IssueId, fixture.parentIssueId, fixture.ungrantedParentIssueId, fixture.ineffectiveParentIssueId, fixture.disabledParentIssueId, fixture.decisionActivityIssueId, fixture.longIssueId, fixture.xlongIssueId, fixture.runningIssueId]) {
      expect(store.getIssue(id)?.responsibleMemberId).toBe(fixture.memberId);
      expect(store.resolveIssueResponsibility(id).rootHuman?.id).toBe(fixture.memberId);
    }
    const children = store.listChildIssues(fixture.parentIssueId);
    const completed = children.find(child => child.title === "Completed child")!;
    expect(completed.status).toBe("done");
    expect(completed.responsibleMemberId).toBeNull();
    expect(store.listIssueDeliveries(completed.id)[0]?.status).toBe("accepted");
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
