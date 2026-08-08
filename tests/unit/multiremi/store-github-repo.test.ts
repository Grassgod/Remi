// Sibling test for packages/server/src/store/repos/github-repo.ts.
// Drives the carved-out repo directly over its StoreContext (not through the
// MultiremiStore facade) so a broken delegation cannot mask a broken move.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { GitHubRepo } from "@multiremi/store/repos/github-repo.js";

let db: Database | null = null;
let store: MultiremiStore | null = null;

function createRepo(): GitHubRepo {
  db = new Database(":memory:");
  // The store owns migrations and is the lazy cross-domain host the context resolves.
  store = new MultiremiStore(db);
  return new GitHubRepo(new StoreContext(db, () => store!));
}

afterEach(() => {
  db?.close();
  db = null;
  store = null;
});

describe("GitHubRepo", () => {
  it("defaults settings on and round-trips an update", () => {
    const repo = createRepo();
    expect(repo.getGitHubSettings("local").autoLinkPRs).toBe(true);

    const updated = repo.updateGitHubSettings({ workspaceId: "local", autoLinkPRs: false, prSidebar: false });
    expect(updated.autoLinkPRs).toBe(false);
    expect(repo.getGitHubSettings("local").prSidebar).toBe(false);
  });

  it("upserts a pull request and lists it back", () => {
    const repo = createRepo();
    const pr = repo.upsertGitHubPullRequest({
      workspaceId: "local",
      repoOwner: "acme",
      repoName: "widgets",
      number: 7,
      title: "Fix the widget",
      state: "open",
    });

    expect(pr.number).toBe(7);
    expect(repo.listGitHubPullRequests({ workspaceId: "local" }).map((entry) => entry.id)).toEqual([pr.id]);

    const reopened = repo.upsertGitHubPullRequest({
      workspaceId: "local",
      repoOwner: "acme",
      repoName: "widgets",
      number: 7,
      title: "Fix the widget better",
      state: "closed",
    });
    expect(reopened.id).toBe(pr.id);
    expect(reopened.state).toBe("closed");
    expect(repo.listGitHubPullRequests({ workspaceId: "local" }).length).toBe(1);
  });

  it("links a merged pull request to the issue named in its title", () => {
    const repo = createRepo();
    const issue = store!.createIssue({ title: "Widget rewrite", workspaceId: "local" });

    const pr = repo.upsertGitHubPullRequest({
      workspaceId: "local",
      repoOwner: "acme",
      repoName: "widgets",
      number: 12,
      title: `${issue.key} rewrite the widget`,
      state: "merged",
    });

    expect(pr.issueId).toBe(issue.id);
    // autoLinkPRs closes the linked issue on merge — that path runs through ctx.issues().
    expect(store!.getIssue(issue.id)?.status).toBe("done");
  });
});
