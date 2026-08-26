// Sibling test for packages/server/src/store/repos/issues-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): IssuesRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new IssuesRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("IssuesRepo", () => {
  it("creates an issue with a per-workspace key and resolves it by ref", () => {
    const repo = createRepo();

    const first = repo.createIssue({ title: "First", workspaceId: "local" });
    const second = repo.createIssue({ title: "Second", workspaceId: "local" });
    expect([first.key, second.key]).toEqual(["MUL-1", "MUL-2"]);
    expect(repo.getIssue(first.id)?.title).toBe("First");
    expect(repo.getIssueByRef(second.key, "local")?.id).toBe(second.id);
    expect(repo.listIssues({ workspaceId: "local" }).map((entry) => entry.id).sort())
      .toEqual([first.id, second.id].sort());
  });

  it("comments on an issue and records the activity timeline", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "Discuss", workspaceId: "local" });

    const comment = repo.createIssueComment(issue.id, { body: "first thought", authorType: "member", authorId: "local" });
    expect(repo.listIssueComments(issue.id).map((entry) => entry.id)).toEqual([comment.id]);
    expect(repo.updateIssueComment(comment.id, { body: "revised" }).body).toBe("revised");

    repo.updateIssue(issue.id, { status: "in_progress" });
    // appendIssueActivity lives on StoreContext; the repo writes through it.
    expect(repo.listIssueActivity(issue.id).map((entry) => entry.type)).toContain("issue_updated");
    expect(repo.listIssueTimeline(issue.id).some((entry) => entry.type === "comment")).toBe(true);

    repo.deleteIssueComment(comment.id);
    expect(repo.listIssueComments(issue.id)).toEqual([]);
  });

  it("attaches and detaches a label, and hydrates it onto the issue", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "Tagged", workspaceId: "local" });
    const label = repo.createLabel({ name: "bug", color: "#ff0000", workspaceId: "local" });

    expect(repo.attachLabelToIssue(issue.id, label.id).map((entry) => entry.id)).toEqual([label.id]);
    expect(repo.getIssue(issue.id)?.labels?.map((entry) => entry.id)).toEqual([label.id]);
    expect(repo.detachLabelFromIssue(issue.id, label.id)).toEqual([]);
    expect(repo.getIssue(issue.id)?.labels).toEqual([]);
  });

  it("stores issue metadata under key/value validation", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "Meta", workspaceId: "local" });

    expect(repo.setIssueMetadataKey(issue.id, "branch", "issue/MUL-1")).toEqual({ branch: "issue/MUL-1" });
    expect(repo.listIssueMetadata(issue.id)).toEqual({ branch: "issue/MUL-1" });
    expect(() => repo.setIssueMetadataKey(issue.id, "not a key", "x")).toThrow();
    expect(repo.deleteIssueMetadataKey(issue.id, "branch")).toEqual({});
  });

  it("preserves private auto-title state while editing public metadata", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "Meta", workspaceId: "local" });
    repo.setIssueAutoTitleMetadata(issue.id, {
      locked: true,
      count: 2,
      content_hash: "hash-1",
    });

    expect(repo.setIssueMetadataKey(issue.id, "branch", "issue/MUL-1")).toEqual({
      branch: "issue/MUL-1",
    });
    expect(repo.getIssueAutoTitleMetadata(issue.id)).toMatchObject({
      locked: true,
      count: 2,
      content_hash: "hash-1",
    });
    expect(() => repo.setIssueMetadataKey(issue.id, "auto_title", "overwrite")).toThrow(
      "auto_title is reserved for system metadata",
    );
    expect(() => repo.deleteIssueMetadataKey(issue.id, "auto_title")).toThrow(
      "auto_title is reserved for system metadata",
    );

    expect(repo.deleteIssueMetadataKey(issue.id, "branch")).toEqual({});
    expect(repo.getIssueAutoTitleMetadata(issue.id)).toMatchObject({
      locked: true,
      count: 2,
      content_hash: "hash-1",
    });
  });
});

// The two reaction triples share one implementation configured by ISSUE_REACTIONS /
// COMMENT_REACTIONS, so both parents are exercised against the same expectations.
describe("IssuesRepo reactions", () => {
  it("adds, de-duplicates and removes issue reactions", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "React", workspaceId: "wsp_1" });

    expect(repo.listIssueReactions(issue.id)).toEqual([]);
    const added = repo.addIssueReaction(issue.id, { emoji: "👍" });
    expect(added.issueId).toBe(issue.id);
    expect(added.workspaceId).toBe("wsp_1");
    // Defaults, and the ON CONFLICT DO NOTHING that makes a repeat a no-op.
    expect(added.actorType).toBe("member");
    expect(added.actorId).toBe("local");
    expect(repo.addIssueReaction(issue.id, { emoji: " 👍 " }).id).toBe(added.id);
    expect(repo.listIssueReactions(issue.id)).toHaveLength(1);

    repo.addIssueReaction(issue.id, { actorType: "agent", actorId: "agt_1", emoji: "🎉" });
    expect(repo.listIssueReactions(issue.id).map((entry) => entry.emoji)).toEqual(["👍", "🎉"]);

    repo.removeIssueReaction(issue.id, { emoji: "👍" });
    expect(repo.listIssueReactions(issue.id).map((entry) => entry.emoji)).toEqual(["🎉"]);
  });

  it("adds, de-duplicates and removes comment reactions", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "React", workspaceId: "wsp_1" });
    const comment = repo.createIssueComment(issue.id, { body: "hi" });

    expect(repo.listCommentReactions(comment.id)).toEqual([]);
    const added = repo.addCommentReaction(comment.id, { emoji: "👍" });
    expect(added.commentId).toBe(comment.id);
    // Comments have no workspace column of their own; it comes from the parent issue.
    expect(added.workspaceId).toBe("wsp_1");
    expect(repo.addCommentReaction(comment.id, { emoji: " 👍 " }).id).toBe(added.id);
    expect(repo.listCommentReactions(comment.id)).toHaveLength(1);

    repo.addCommentReaction(comment.id, { actorType: "agent", actorId: "agt_1", emoji: "🎉" });
    expect(repo.listCommentReactions(comment.id).map((entry) => entry.emoji)).toEqual(["👍", "🎉"]);

    repo.removeCommentReaction(comment.id, { emoji: "👍" });
    expect(repo.listCommentReactions(comment.id).map((entry) => entry.emoji)).toEqual(["🎉"]);
  });

  it("keeps the two parents' rows apart", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "React", workspaceId: "local" });
    const comment = repo.createIssueComment(issue.id, { body: "hi" });

    repo.addIssueReaction(issue.id, { emoji: "👍" });
    expect(repo.listCommentReactions(comment.id)).toEqual([]);
    repo.addCommentReaction(comment.id, { emoji: "🎉" });
    expect(repo.listIssueReactions(issue.id).map((entry) => entry.emoji)).toEqual(["👍"]);
  });

  it("rejects a blank emoji and an unknown parent on every entry point", () => {
    const repo = createRepo();
    const issue = repo.createIssue({ title: "React", workspaceId: "local" });
    const comment = repo.createIssueComment(issue.id, { body: "hi" });

    expect(() => repo.addIssueReaction(issue.id, { emoji: "  " })).toThrow("emoji is required");
    expect(() => repo.removeIssueReaction(issue.id, { emoji: "" })).toThrow("emoji is required");
    expect(() => repo.addCommentReaction(comment.id, { emoji: "  " })).toThrow("emoji is required");
    expect(() => repo.removeCommentReaction(comment.id, { emoji: "" })).toThrow("emoji is required");

    expect(() => repo.listIssueReactions("iss_nope")).toThrow("Issue not found: iss_nope");
    expect(() => repo.addIssueReaction("iss_nope", { emoji: "👍" })).toThrow("Issue not found: iss_nope");
    expect(() => repo.listCommentReactions("cmt_nope")).toThrow("Comment not found: cmt_nope");
    expect(() => repo.addCommentReaction("cmt_nope", { emoji: "👍" })).toThrow("Comment not found: cmt_nope");
  });
});
