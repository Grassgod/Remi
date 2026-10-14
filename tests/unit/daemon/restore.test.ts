import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import { rootRelative, sharedReposRoot, workDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import { updateSubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";
import { restoreReclaimedSubject } from "@daemon/agent-runtime/workspace/restore.js";
import { DAY, HOUR, REPO_DIR, ageLane, cleanupFixtures, commitIn, git, issueEnded, reclaimFixture, worktreeAt, type ReclaimFixture } from "./reclaim-fixture.js";

// Each case builds real repositories; a busy CI host needs more than the 5 s default.
setDefaultTimeout(30_000);
afterEach(cleanupFixtures);

const issue = (n: number): StorageSubjectRef => ({ kind: "issue", id: `iss_${n}` });
const chat = (n: number): StorageSubjectRef => ({ kind: "chat", id: `chat_${n}` });

describe("a worktree the agent made beside the checkout", () => {
  test("is saved under its own place and comes back only there; the Issue's branch never moves", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    const repo = f.worktree(subject);
    const mainHead = commitIn(repo, "main.txt");
    const experiment = join(workDir, "repo-experiment");
    git(repo, ["worktree", "add", "-b", "experiment", experiment, "HEAD"]);
    const experimentHead = commitIn(experiment, "experiment.txt");
    writeFileSync(join(experiment, "dirty.txt"), "dirty\n");
    f.server.answer(subject.id, issueEnded());

    await f.engine().run("periodic");

    expect(f.record(subject)!.snapshot!.git.map((entry) => [entry.dir, entry.branch])).toEqual([
      [REPO_DIR, "agent/iss_1"], ["repo-experiment", "experiment"],
    ]);

    // Reopened: the daemon checks the Issue branch out into `repo` and nothing else.
    mkdirSync(workDir, { recursive: true });
    git(f.bare, ["worktree", "add", join(workDir, REPO_DIR), "agent/iss_1"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(git(join(workDir, REPO_DIR), ["rev-parse", "HEAD"])).toBe(mainHead);
    expect(git(f.bare, ["rev-parse", "refs/heads/agent/iss_1"])).toBe(mainHead);
    expect(existsSync(join(workDir, REPO_DIR, "experiment.txt"))).toBe(false);
    expect(git(join(workDir, REPO_DIR), ["status", "--porcelain=v1"])).toBe("");
    // The experiment's work waits for a worktree to stand at its place.
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [{ dir: "repo-experiment", branch: "experiment" }] } });

    git(f.bare, ["worktree", "add", join(workDir, "repo-experiment"), "experiment"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(workDir, "repo-experiment", "dirty.txt"), "utf8")).toBe("dirty\n");
    expect(git(join(workDir, "repo-experiment"), ["rev-parse", "HEAD"])).toBe(experimentHead);
    expect(git(f.bare, ["rev-parse", "refs/heads/agent/iss_1"])).toBe(mainHead);
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });
});

describe("restoring only where the work stood", () => {
  /** An Issue whose experiment worktree was reclaimed with unsaved work, and the ground a reopen starts from. */
  async function reclaimedExperiment(f: ReclaimFixture) {
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    const experiment = worktreeAt(f, join(workDir, "group", "experiment"), "experiment");
    writeFileSync(join(experiment, "idea.txt"), "idea\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    expect(f.record(subject)!.snapshot!.git).toEqual([expect.objectContaining({ dir: "group/experiment" })]);
    mkdirSync(workDir, { recursive: true });
    return { subject, workDir };
  }

  test("a link in the middle of the recorded place is not followed, even into another worktree of the repository", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = await reclaimedExperiment(f);
    const outside = join(f.scratch, "outside");
    mkdirSync(outside, { recursive: true });
    git(f.bare, ["worktree", "add", join(outside, "experiment"), "experiment"]);
    symlinkSync(outside, join(workDir, "group"), "dir");

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(outside, "experiment", "idea.txt"))).toBe(false);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [expect.objectContaining({ dir: "group/experiment" })] } });
  });

  test("a link that leads to another place inside the work directory is not followed either", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = await reclaimedExperiment(f);
    git(f.bare, ["worktree", "add", join(workDir, "other"), "experiment"]);
    symlinkSync(join(workDir, "other"), join(workDir, "alias"), "dir");
    updateSubjectRecord(f.root, subject, (current) => ({
      ...current,
      snapshot: { ...current.snapshot!, git: current.snapshot!.git.map((entry) => ({ ...entry, dir: "alias" })) },
    }));

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(workDir, "other", "idea.txt"))).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
  });

  test("a worktree of another repository at the recorded place takes nothing", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = await reclaimedExperiment(f);
    const other = join(sharedReposRoot(f.root), "local", "other-fedcba9876543210.git");
    git(f.scratch, ["clone", "--bare", join(f.scratch, "origin.git"), other]);
    git(other, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(other, ["fetch", "origin"]);
    mkdirSync(join(workDir, "group"), { recursive: true });
    git(other, ["worktree", "add", "-b", "experiment", join(workDir, "group", "experiment"), "origin/main"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(workDir, "group", "experiment", "idea.txt"))).toBe(false);
    expect(git(join(workDir, "group", "experiment"), ["status", "--porcelain=v1"])).toBe("");
  });

  test("an entry that does not say where it stood is never applied", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = await reclaimedExperiment(f);
    git(f.bare, ["worktree", "add", join(workDir, "group", "experiment"), "experiment"]);
    updateSubjectRecord(f.root, subject, (current) => ({
      ...current,
      snapshot: { ...current.snapshot!, git: current.snapshot!.git.map(({ dir: _dir, ...entry }) => entry as typeof entry & { dir: string }) },
    }));

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(workDir, "group", "experiment", "idea.txt"))).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
  });
});

describe("a worktree that is the work directory itself", () => {
  test("comes back there", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    mkdirSync(join(f.root, "work"), { recursive: true });
    git(f.bare, ["worktree", "add", "-b", "chat/chat_1", workDir, "origin/main"]);
    writeFileSync(join(workDir, "README.md"), "edited\n");
    f.server.answer(subject.id, { status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * 24 * 3600_000).toISOString() });
    await f.engine().run("periodic");
    expect(f.record(subject)!.snapshot!.git).toEqual([expect.objectContaining({ dir: "." })]);

    git(f.bare, ["worktree", "add", workDir, "chat/chat_1"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(workDir, "README.md"), "utf8")).toBe("edited\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });
});

/** An Issue reclaimed with unsaved work in its checkout (`repo` on `agent/iss_1`), and the ground a reopen starts from. */
async function reclaimedRepo(f: ReclaimFixture, edit: (repo: string) => void = (repo) => writeFileSync(join(repo, "saved.txt"), "saved work\n")) {
  const subject = issue(1);
  f.subject(subject);
  const workDir = workDirectory(f.root, subject);
  edit(f.worktree(subject));
  f.server.answer(subject.id, issueEnded());
  await f.engine().run("periodic");
  expect(f.record(subject)!.snapshot!.git).toEqual([expect.objectContaining({ dir: REPO_DIR })]);
  mkdirSync(workDir, { recursive: true });
  return { subject, workDir, repo: join(workDir, REPO_DIR) };
}

describe("a work directory that is not a real directory", () => {
  test("is refused: the saved work never lands in the checkout of the subject a link leads to", async () => {
    const f = reclaimFixture();
    // Saved from a detached HEAD, which any worktree behind the saved commit would take were it not for the link.
    const { subject, workDir } = await reclaimedRepo(f, (repo) => {
      git(repo, ["checkout", "--detach"]);
      writeFileSync(join(repo, "saved.txt"), "saved work\n");
    });
    expect(f.record(subject)!.snapshot!.git[0]!.branch).toBeNull();
    const other = issue(2);
    f.subject(other);
    const victim = f.worktree(other);
    writeFileSync(join(victim, "victim-own.txt"), "victim\n");
    // The victim's worktree stands at the commit the saved work builds on, so only the link stands between them.
    rmdirSync(workDir);
    symlinkSync(workDirectory(f.root, other), workDir, "dir");

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(existsSync(join(victim, "saved.txt"))).toBe(false);
    expect(readFileSync(join(victim, "victim-own.txt"), "utf8")).toBe("victim\n");
    expect(git(victim, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("agent/iss_2");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [expect.objectContaining({ dir: REPO_DIR })] } });
  });

  test("a plain file in its place is refused as well, and nothing is changed", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = await reclaimedRepo(f);
    rmdirSync(workDir);
    writeFileSync(workDir, "not a directory\n");

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(readFileSync(workDir, "utf8")).toBe("not a directory\n");
    expect(f.record(subject)!.state).toBe("reclaimed");
  });

  test("a link above the work directory is the operator's, and fine: only the subject's own entry counts", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = await reclaimedRepo(f);
    // `work` itself may live on another disk behind a link.
    const bigger = join(f.scratch, "bigger-disk");
    rmSync(join(f.root, "work"), { recursive: true });
    mkdirSync(join(bigger, "iss_1"), { recursive: true });
    symlinkSync(bigger, join(f.root, "work"), "dir");
    git(f.bare, ["worktree", "add", join(workDir, REPO_DIR), "agent/iss_1"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(workDir, REPO_DIR, "saved.txt"), "utf8")).toBe("saved work\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });
});

describe("restoring only onto the branch the work was saved on", () => {
  test("a checkout of another branch at the recorded place is left alone, and the entry waits", async () => {
    const f = reclaimFixture();
    const { subject, repo } = await reclaimedRepo(f);
    git(f.bare, ["worktree", "add", "-b", "agent/other", repo, "origin/main"]);
    const before = git(repo, ["rev-parse", "HEAD"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(repo, "saved.txt"))).toBe(false);
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("agent/other");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [expect.objectContaining({ dir: REPO_DIR, branch: "agent/iss_1" })] } });

    // The branch the work belongs to is checked out there later: it comes back.
    git(f.bare, ["worktree", "remove", "--force", repo]);
    git(f.bare, ["worktree", "add", repo, "agent/iss_1"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(repo, "saved.txt"), "utf8")).toBe("saved work\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });

  test("work saved on a branch the agent had switched to never moves the Issue's branch", async () => {
    const f = reclaimFixture();
    let experiment = "";
    const { subject, repo } = await reclaimedRepo(f, (path) => {
      git(path, ["checkout", "-b", "experiment"]);
      experiment = commitIn(path, "experiment.txt");
      writeFileSync(join(path, "wip.txt"), "wip on experiment\n");
    });
    expect(f.record(subject)!.snapshot!.git[0]).toMatchObject({ branch: "experiment", head: experiment });
    // Reopened: the daemon checks the Issue branch out again, at the commit it was at.
    git(f.bare, ["worktree", "add", repo, "agent/iss_1"]);
    const issueBranch = git(f.bare, ["rev-parse", "agent/iss_1"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(git(f.bare, ["rev-parse", "agent/iss_1"])).toBe(issueBranch);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(issueBranch);
    expect(existsSync(join(repo, "experiment.txt"))).toBe(false);
    expect(git(repo, ["status", "--porcelain=v1"])).toBe("");
    // Nothing is lost: the ref keeps the work, and the record still names it.
    expect(git(f.bare, ["rev-parse", "refs/remi/snapshots/iss_1/1^"])).toBe(experiment);
    expect(f.record(subject)!.state).toBe("reclaimed");
  });

  test("a worktree detached at the saved HEAD takes the work; one detached elsewhere does not", async () => {
    const f = reclaimFixture();
    const { subject, repo } = await reclaimedRepo(f, (path) => {
      commitIn(path, "committed.txt");
      writeFileSync(join(path, "saved.txt"), "saved work\n");
    });
    const head = f.record(subject)!.snapshot!.git[0]!.head;
    git(f.bare, ["worktree", "add", "--detach", repo, "origin/main"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(repo, "saved.txt"))).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
    git(f.bare, ["worktree", "remove", "--force", repo]);
    git(f.bare, ["worktree", "add", "--detach", repo, head]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(repo, "saved.txt"), "utf8")).toBe("saved work\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });
});

describe("saved work of a lane generation", () => {
  /** An Issue whose superseded generation held a worktree with unsaved work; the engine saved it and the Issue has ended since. */
  async function endedWithLaneWork(f: ReclaimFixture) {
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    f.lane(subject, 2);
    writeFileSync(join(worktreeAt(f, join(stale, "work", "experiment"), "lane-experiment"), "idea.txt"), "idea\n");
    ageLane(f, stale, 100 * HOUR);
    await f.engine().run("periodic");
    const entry = f.record(subject)!.snapshot!.git[0]!;
    expect(entry.dir).toBe(rootRelative(f.root, join(stale, "work", "experiment")));
    expect(f.record(subject)!.state).toBe("active");
    f.subject(subject, { usedAgoMs: 10 * DAY });
    f.worktree(subject);
    f.server.answer(subject.id, issueEnded());
    return { subject, entry, workDir: workDirectory(f.root, subject) };
  }

  function reopen(f: ReclaimFixture, workDir: string) {
    mkdirSync(workDir, { recursive: true });
    git(f.bare, ["worktree", "add", join(workDir, REPO_DIR), "agent/iss_1"]);
  }

  test("is reported once with the reclaim, waits for nothing, and is taken off the record by the first restore", async () => {
    const f = reclaimFixture();
    const { subject, entry, workDir } = await endedWithLaneWork(f);

    const report = await f.engine().run("run");

    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", unsaved_work: true })]);
    expect(f.server.reclaimed).toEqual([expect.objectContaining({ unsaved_work: true, snapshot: expect.objectContaining({ git: [entry] }) })]);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [entry] } });

    reopen(f, workDir);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    // Nothing of a lane can be restored into a new generation, so the record must not wait for it.
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
    expect(git(f.bare, ["rev-parse", entry.ref])).toBe(entry.commit);

    // Ended and reclaimed again: nothing is reported a second time.
    f.subject(subject, { usedAgoMs: 10 * DAY });
    const again = await f.engine().run("run");
    expect(again.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", unsaved_work: false })]);
    expect(f.server.reclaimed[1]).toMatchObject({ unsaved_work: false, snapshot: null });
  });

  test("a record that was reclaimed has reported its lane entries: the next reclaim does not carry them again", async () => {
    const f = reclaimFixture();
    const { subject, entry, workDir } = await endedWithLaneWork(f);
    await f.engine().run("run");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [entry] } });
    // Used again without a checkout (nothing to restore into), then ended once more.
    mkdirSync(workDir, { recursive: true });
    f.subject(subject, { usedAgoMs: 10 * DAY, state: "reclaimed" });

    const report = await f.engine().run("run");

    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", unsaved_work: false })]);
  });

  test("nor does a reclaim that has no workspace to delete: a discussion used the Issue since, and nothing is reported again", async () => {
    const f = reclaimFixture();
    const { subject, entry } = await endedWithLaneWork(f);
    await f.engine().run("run");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [entry] } });
    // Used again by a discussion only (no work directory, no restore), and ended once more.
    updateSubjectRecord(f.root, subject, (record) => ({ ...record, reclaimed_at: new Date(f.now - 20 * DAY).toISOString() }));
    f.subject(subject, { usedAgoMs: 10 * DAY, state: "reclaimed" });

    const report = await f.engine().run("run");

    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", unsaved_work: false })]);
    expect(f.server.reclaimed[1]).toMatchObject({ unsaved_work: false, snapshot: null });
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
  });

  test("a repository called env in the work directory is no lane's place: it is restored like any other", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    writeFileSync(join(worktreeAt(f, join(workDir, "env"), "agent/iss_1"), "saved.txt"), "saved work\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    expect(f.record(subject)!.snapshot!.git).toEqual([expect.objectContaining({ dir: "env" })]);
    mkdirSync(workDir, { recursive: true });
    git(f.bare, ["worktree", "add", join(workDir, "env"), "agent/iss_1"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(workDir, "env", "saved.txt"), "utf8")).toBe("saved work\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });

  test("does not hold back the entries that can be restored: they keep the record reclaimed, the lane's entry is gone at once", async () => {
    const f = reclaimFixture();
    const { subject, entry, workDir } = await endedWithLaneWork(f);
    const experiment = join(workDir, "repo-experiment");
    git(f.bare, ["worktree", "add", "-b", "experiment", experiment, "origin/main"]);
    writeFileSync(join(experiment, "idea.txt"), "idea\n");
    await f.engine().run("run");
    expect(f.record(subject)!.snapshot!.git.map((saved) => saved.dir).sort()).toEqual([entry.dir, "repo-experiment"].sort());
    reopen(f, workDir);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [expect.objectContaining({ dir: "repo-experiment" })] } });
    git(f.bare, ["worktree", "add", experiment, "experiment"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(experiment, "idea.txt"), "utf8")).toBe("idea\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });
});
