import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import { executionTrackerFor } from "@daemon/agent-runtime/workspace/execution-tracker.js";
import {
  diskUsageFile, envRoot, pendingReportsRoot, registryFile, registrySnapshotDirectory, sharedRoot,
  traceDirectory, tracesRoot, workDirectory, workRoot,
} from "@daemon/agent-runtime/workspace/layout.js";
import { runLegacySweep } from "@daemon/agent-runtime/workspace/legacy-sweep.js";
import { restoreReclaimedSubject } from "@daemon/agent-runtime/workspace/restore.js";
import { updateSubjectRecord, upsertSubjectRecord } from "@daemon/agent-runtime/workspace/registry.js";
import {
  DAY, HOUR, REPO_DIR, REPO_URL, cleanupFixtures, cloneAt, commitIn, envOf, git, issueEnded, localRepositoryAt, reclaimFixture, worktreeAt, type ReclaimFixture,
} from "./reclaim-fixture.js";

// Each case builds real repositories; a busy CI host needs more than the 5 s default.
setDefaultTimeout(30_000);
afterEach(cleanupFixtures);

const issue = (n: number): StorageSubjectRef => ({ kind: "issue", id: `iss_${n}` });
const chat = (n: number): StorageSubjectRef => ({ kind: "chat", id: `chat_${n}` });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** An ended Issue with a worktree, one provider lane generation and the given edit. */
function endedIssue(f: ReclaimFixture, n: number, edit?: (worktree: string) => void) {
  const subject = issue(n);
  f.subject(subject);
  const worktree = f.worktree(subject);
  const lane = f.lane(subject, 1);
  edit?.(worktree);
  f.server.answer(subject.id, issueEnded());
  return { subject, worktree, lane, workDir: workDirectory(f.root, subject) };
}

describe("reclaiming an ended subject", () => {
  test("saves uncommitted and untracked work, deletes the workspace and keeps only native history", async () => {
    const f = reclaimFixture();
    const { subject, worktree, lane, workDir } = endedIssue(f, 1, (path) => {
      writeFileSync(join(path, "README.md"), "edited\n");
      writeFileSync(join(path, "new.txt"), "new\n");
    });
    const head = git(worktree, ["rev-parse", "HEAD"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    const ref = "refs/remi/snapshots/iss_1/1";
    const commit = git(f.bare, ["rev-parse", ref]);
    expect(git(f.bare, ["show", `${commit}:new.txt`])).toBe("new");
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(workDir);
    // Native history stays; everything rebuildable goes.
    expect(readdirSync(join(lane, "home")).sort()).toEqual(["projects", "session_index.jsonl"]);
    expect(existsSync(join(lane, "home", "projects", "-work", "session.jsonl"))).toBe(true);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(lane, "work"))).toBe(false);

    const record = f.record(subject)!;
    expect(record.state).toBe("reclaimed");
    expect(record.reclaimed_at).not.toBeNull();
    expect(record.snapshot).toMatchObject({ wiki_files: 0, git: [{ ref, commit, head, branch: "agent/iss_1", dir: REPO_DIR }] });
    // How much space was freed is read off the filesystem, never summed from a walk of the subject.
    expect(f.server.reclaimed).toEqual([{
      runtime_id: "rt_1", subject, snapshot: record.snapshot, unsaved_work: true, freed_bytes: expect.any(Number),
    }]);
    expect(report).toMatchObject({
      version: 1, mode: "periodic", reclaimed_this_round: 1, forgotten_this_round: 0,
      subjects: { total: 1, reclaimed: 1, active: 0, ended: 0 },
      plan: [{ subject, action: "reclaim", reason: "ended_ttl", bytes: null, unsaved_work: true }],
      errors: [],
    });
    expect(report.freed_bytes).toBeGreaterThanOrEqual(0);
  });

  test("a clean worktree needs no snapshot", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = endedIssue(f, 1);

    await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(f.server.reclaimed[0]).toMatchObject({ snapshot: null, unsaved_work: false });
  });

  test("unpushed commits are pinned by a ref and survive the workspace", async () => {
    const f = reclaimFixture();
    const { subject, worktree } = endedIssue(f, 1, (path) => {
      writeFileSync(join(path, "local.txt"), "local\n");
      git(path, ["add", "."]);
      git(path, ["commit", "-m", "local work"]);
    });
    const head = git(worktree, ["rev-parse", "HEAD"]);

    await f.engine().run("periodic");

    const snapshot = f.record(subject)!.snapshot!.git[0]!;
    expect(snapshot).toMatchObject({ commit: head, head });
    expect(git(f.bare, ["rev-parse", snapshot.ref])).toBe(head);
    expect(f.server.reclaimed[0]!.unsaved_work).toBe(true);
  });

  test("keeps the subject when the snapshot would exceed the limit", async () => {
    const f = reclaimFixture();
    f.policy.snapshot_max_bytes = 1024 * 1024;
    const { subject, workDir, lane } = endedIssue(f, 1, (path) => {
      writeFileSync(join(path, "huge.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
    });

    const report = await f.engine().run("run");

    expect(existsSync(join(workDir, REPO_DIR, "huge.bin"))).toBe(true);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(true);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)!.state).toBe("active");
    expect(f.server.reclaimed).toEqual([]);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("snapshot limit") }]);
    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "keep", reason: "snapshot_failed" })]);
  });

  test("keeps the subject when a submodule has local changes: it is a repository of its own", async () => {
    const f = reclaimFixture();
    const { subject, worktree, workDir } = endedIssue(f, 1);
    const library = join(f.scratch, "library");
    git(f.scratch, ["init", "--initial-branch=main", library]);
    writeFileSync(join(library, "lib.txt"), "lib\n");
    git(library, ["add", "."]);
    git(library, ["commit", "-m", "lib"]);
    git(worktree, ["-c", "protocol.file.allow=always", "submodule", "add", library, "vendor/lib"]);
    git(worktree, ["commit", "-m", "add submodule"]);
    git(worktree, ["push", "origin", "HEAD:refs/heads/agent/iss_1"]);
    git(f.bare, ["fetch", "origin"]);
    writeFileSync(join(worktree, "vendor", "lib", "lib.txt"), "edited\n");

    const report = await f.engine().run("periodic");

    expect(existsSync(join(workDir, REPO_DIR, "vendor", "lib", "lib.txt"))).toBe(true);
    expect(f.record(subject)!.state).toBe("active");
    // A submodule's git directory lies inside the worktree's administrative directory, which is pruned
    // with the worktree; a snapshot ref written there would not outlive it.
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(join("vendor", "lib")) }]);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
  });

  test("a repository git cannot inspect keeps its subject without stopping the round", async () => {
    const f = reclaimFixture();
    const broken = endedIssue(f, 1);
    const fine = endedIssue(f, 2);
    writeFileSync(join(broken.worktree, ".git"), "gitdir: /nonexistent/place\n");

    const report = await f.engine().run("periodic");

    expect(existsSync(broken.workDir)).toBe(true);
    expect(existsSync(fine.workDir)).toBe(false);
    expect(report.retained).toEqual({ git_check_failed: 1 });
    expect(report.reclaimed_this_round).toBe(1);
  });

  test("a standalone clone with unsaved work cannot be snapshotted", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const clone = join(workDirectory(f.root, subject), "clone");
    mkdirSync(workDirectory(f.root, subject), { recursive: true });
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), clone]);
    writeFileSync(join(clone, "wip.txt"), "wip\n");
    f.server.answer(subject.id, issueEnded());

    const report = await f.engine().run("periodic");

    expect(existsSync(join(clone, "wip.txt"))).toBe(true);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });

  test("never touches a user-registered directory, but cleans the environment", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    const mine = join(f.scratch, "my-project");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "keep.txt"), "mine");
    f.subject(subject, { externalWorkDir: mine });
    const lane = f.lane(subject, 1);
    f.server.answer(subject.id, { status: "archived", updated_at: new Date(f.now - 10 * DAY).toISOString(), pinned: false, origin: null });

    const report = await f.engine().run("periodic");

    expect(readFileSync(join(mine, "keep.txt"), "utf8")).toBe("mine");
    expect(readdirSync(mine)).toEqual(["keep.txt"]);
    expect(existsSync(workDirectory(f.root, subject))).toBe(false);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(false);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null, external_work_dir: mine });
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: { external_dir: 1 } });
  });

  test("a work directory that is a link out of the root is not followed", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const outside = join(f.scratch, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "precious");
    mkdirSync(join(f.root, "work"), { recursive: true });
    symlinkSync(outside, workDirectory(f.root, subject));
    f.server.answer(subject.id, issueEnded());

    await f.engine().run("periodic");

    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("precious");
  });

  test("an environment directory that is a link out of the root is not cleaned through", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const outside = join(f.scratch, "outside-env");
    mkdirSync(join(outside, "conv", "agent", "main", "1", "home", "cache"), { recursive: true });
    writeFileSync(join(outside, "conv", "agent", "main", "1", "home", "cache", "precious"), "precious");
    mkdirSync(join(f.root, "env"), { recursive: true });
    symlinkSync(outside, envOf(f, subject));
    f.server.answer(subject.id, issueEnded());

    await f.engine().run("periodic");

    expect(readFileSync(join(outside, "conv", "agent", "main", "1", "home", "cache", "precious"), "utf8")).toBe("precious");
  });
});

describe("what a round must not reclaim", () => {
  test("a subject with a running execution", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = endedIssue(f, 1);
    const finish = executionTrackerFor(f.root).begin(subject.id, "tsk_running");
    try {
      const report = await f.engine().run("periodic");
      expect(existsSync(workDir)).toBe(true);
      expect(report.retained).toEqual({ running: 1 });
      expect(f.server.checks).toEqual([]);
    } finally {
      finish();
    }
  });

  test("a subject whose lifecycle lock is held, even before its execution is tracked", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = endedIssue(f, 1);
    const release = await f.locker.acquireShared(subject.id);

    const busy = await f.engine().run("periodic");
    expect(existsSync(workDir)).toBe(true);
    expect(busy.retained).toEqual({ running: 1 });
    expect(busy.errors).toEqual([]);

    release();
    await f.engine().run("periodic");
    expect(existsSync(workDir)).toBe(false);
  });

  test("a subject used while the round ran", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = endedIssue(f, 1);
    const original = f.server.getIssueGcCheck;
    f.server.getIssueGcCheck = async (id: string) => {
      const reply = await original(id);
      // An execution starts between the check and the reclaim.
      f.subject(subject, { usedAgoMs: 0 });
      return reply;
    };

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(true);
    expect(report.retained).toEqual({ within_ttl: 1 });
  });

  test("a pinned Chat, an active Issue and an ended subject inside its retention", async () => {
    const f = reclaimFixture();
    const pinned = chat(1);
    const active = issue(1);
    const recent = issue(2);
    for (const subject of [pinned, active, recent]) {
      f.subject(subject, { usedAgoMs: 100 * DAY });
      f.worktree(subject);
    }
    f.server.answer(pinned.id, { status: "archived", updated_at: new Date(f.now - 100 * DAY).toISOString(), pinned: true, origin: null });
    f.server.answer(active.id, { status: "in_progress", updated_at: new Date(f.now - 100 * DAY).toISOString() });
    f.server.answer(recent.id, issueEnded(5 * HOUR));

    const report = await f.engine().run("run");

    for (const subject of [pinned, active, recent]) expect(existsSync(workDirectory(f.root, subject))).toBe(true);
    expect(report.retained).toEqual({ pinned: 1, not_ended: 1, within_ttl: 1 });
    expect(report.reclaimed_this_round).toBe(0);
  });

  test("anything while the server is unreachable, without hammering it", async () => {
    const f = reclaimFixture();
    const subjects = Array.from({ length: 24 }, (_, index) => issue(index + 1));
    for (const subject of subjects) {
      f.subject(subject);
      f.worktree(subject);
      f.server.answer(subject.id, "down");
    }

    const report = await f.engine().run("periodic");

    expect(report.retained).toEqual({ server_unreachable: 24 });
    expect(f.server.checks.length).toBeLessThan(24);
    for (const subject of subjects) expect(existsSync(workDirectory(f.root, subject))).toBe(true);
  });

  test("a round aborts when the daemon no longer owns the root", async () => {
    const f = reclaimFixture();
    const first = endedIssue(f, 1);
    const second = endedIssue(f, 2);
    let lost = false;
    const report = f.server.reportSubjectReclaimed.bind(f.server);
    f.server.reportSubjectReclaimed = async (payload) => {
      await report(payload);
      lost = true;
    };
    const engine = f.engine({
      assertRootOwner: () => {
        if (lost) throw new Error("workspace root identity changed");
      },
    });

    await expect(engine.run("periodic")).rejects.toThrow("workspace root identity changed");

    expect(existsSync(first.workDir)).toBe(false);
    expect(existsSync(second.workDir)).toBe(true);
    expect(f.record(second.subject)!.state).toBe("active");
  });
});

describe("dry run", () => {
  function expectUntouched(f: ReclaimFixture, subject: StorageSubjectRef, lane: string) {
    expect(existsSync(join(workDirectory(f.root, subject), REPO_DIR, "new.txt"))).toBe(true);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(true);
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.server.reclaimed).toEqual([]);
  }

  test("plans what a run would do and changes nothing", async () => {
    const f = reclaimFixture();
    const { subject, lane } = endedIssue(f, 1, (path) => writeFileSync(join(path, "new.txt"), "new\n"));
    const kept = issue(2);
    f.subject(kept);
    f.server.answer(kept.id, { status: "in_progress" });

    const report = await f.engine().run("dry_run");

    expect(report.mode).toBe("dry_run");
    expect(report.reclaimed_this_round).toBe(0);
    expect(report.plan).toEqual([
      { subject, action: "reclaim", reason: "ended_ttl", bytes: null, unsaved_work: true },
      { subject: kept, action: "keep", reason: "not_ended", bytes: null, unsaved_work: false },
    ]);
    expectUntouched(f, subject, lane);
  });

  test("MULTIREMI_GC_DRY_RUN makes every round a dry run, including an operator's run request", async () => {
    const f = reclaimFixture();
    const { subject, lane } = endedIssue(f, 1, (path) => writeFileSync(join(path, "new.txt"), "new\n"));

    const periodic = await f.engine({ dryRun: true }).run("periodic");
    const requested = await f.engine({ dryRun: true }).run("run");

    expect(periodic.mode).toBe("dry_run");
    expect(periodic.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", unsaved_work: true })]);
    expect(requested.mode).toBe("dry_run");
    expectUntouched(f, subject, lane);
  });

  test("predicts a snapshot that would not fit", async () => {
    const f = reclaimFixture();
    f.policy.snapshot_max_bytes = 1024 * 1024;
    const { subject } = endedIssue(f, 1, (path) => writeFileSync(join(path, "huge.bin"), Buffer.alloc(2 * 1024 * 1024, 1)));

    const report = await f.engine().run("dry_run");

    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "keep", reason: "snapshot_failed" })]);
  });
});

describe("retention cap", () => {
  test("reclaims the least recently used ended subjects beyond max_retained", async () => {
    const f = reclaimFixture();
    f.policy.max_retained = 1;
    const subjects = [1, 2, 3].map(issue);
    subjects.forEach((subject, index) => {
      f.subject(subject, { usedAgoMs: (index + 1) * HOUR });
      f.worktree(subject);
      f.server.answer(subject.id, issueEnded(10 * HOUR));
    });

    const report = await f.engine().run("periodic");

    expect(existsSync(workDirectory(f.root, subjects[0]!))).toBe(true);
    expect(existsSync(workDirectory(f.root, subjects[1]!))).toBe(false);
    expect(existsSync(workDirectory(f.root, subjects[2]!))).toBe(false);
    expect(report.plan.map((item) => [item.subject.id, item.reason]).sort()).toEqual([["iss_2", "over_cap"], ["iss_3", "over_cap"]]);
  });

  test("zero means no cap", async () => {
    const f = reclaimFixture();
    f.policy.max_retained = 0;
    for (const n of [1, 2, 3]) {
      const subject = issue(n);
      f.subject(subject, { usedAgoMs: n * HOUR });
      f.worktree(subject);
      f.server.answer(subject.id, issueEnded(10 * HOUR));
    }

    expect((await f.engine().run("periodic")).reclaimed_this_round).toBe(0);
  });

  test("subjects past their retention do not count against the cap", async () => {
    const f = reclaimFixture();
    f.policy.max_retained = 2;
    const [due, first, second] = [1, 2, 3].map(issue);
    f.subject(due!, { usedAgoMs: 90 * DAY });
    f.server.answer(due!.id, issueEnded(80 * DAY));
    f.subject(first!, { usedAgoMs: HOUR });
    f.server.answer(first!.id, issueEnded(10 * HOUR));
    f.subject(second!, { usedAgoMs: 2 * HOUR });
    f.server.answer(second!.id, issueEnded(10 * HOUR));
    for (const subject of [due!, first!, second!]) f.worktree(subject);

    const report = await f.engine().run("periodic");

    expect(report.plan.map((item) => [item.subject.id, item.reason])).toEqual([["iss_1", "ended_ttl"]]);
  });

  test("an automation Chat is reclaimed on the shorter TTL", async () => {
    const f = reclaimFixture();
    const automated = chat(1);
    const regular = chat(2);
    for (const subject of [automated, regular]) {
      f.subject(subject, { usedAgoMs: 40 * HOUR });
      f.worktree(subject, `chat/${subject.id}`);
      f.server.answer(subject.id, {
        status: "archived",
        updated_at: new Date(f.now - 30 * HOUR).toISOString(),
        pinned: false,
        origin: subject === automated ? { autopilot_id: "ap_1", run_id: "run_1" } : null,
      });
    }

    const report = await f.engine().run("periodic");

    expect(report.plan.map((item) => [item.subject.id, item.reason])).toEqual([["chat_1", "ended_ttl"]]);
    expect(existsSync(workDirectory(f.root, regular))).toBe(true);
  });
});

describe("reporting a reclaim to the server", () => {
  test("a report the server cannot take is queued and sent at the start of the next round", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = endedIssue(f, 1, (path) => writeFileSync(join(path, "new.txt"), "new\n"));
    f.server.reportFailure = new Error("socket closed");

    await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
    const queued = readdirSync(pendingReportsRoot(f.root));
    expect(queued).toEqual(["iss_1.json"]);

    f.server.reportFailure = null;
    await f.engine().run("periodic");

    expect(readdirSync(pendingReportsRoot(f.root))).toEqual([]);
    expect(f.server.reclaimed).toEqual([expect.objectContaining({ subject, unsaved_work: true, freed_bytes: expect.any(Number), runtime_id: "rt_1" })]);
  });

  test("a queued report is dropped when the subject was reopened before it was sent", async () => {
    const f = reclaimFixture();
    const { subject } = endedIssue(f, 1, (path) => writeFileSync(join(path, "new.txt"), "new\n"));
    f.server.reportFailure = new Error("socket closed");
    await f.engine().run("periodic");
    expect(readdirSync(pendingReportsRoot(f.root))).toEqual(["iss_1.json"]);

    upsertSubjectRecord(f.root, { subject, workspace_id: "local", now: new Date(Date.now() + HOUR) });
    f.server.reportFailure = null;
    await f.engine().run("periodic");

    expect(readdirSync(pendingReportsRoot(f.root))).toEqual([]);
    expect(f.server.reclaimed).toEqual([]);
  });

  test("a report the server will never accept is dropped, not retried", async () => {
    const f = reclaimFixture();
    endedIssue(f, 1);
    f.server.reportFailure = Object.assign(new Error("not found"), { status: 404 });

    await f.engine().run("periodic");

    expect(existsSync(pendingReportsRoot(f.root))).toBe(false);
  });
});

describe("hard-deleted subjects", () => {
  function orphan(f: ReclaimFixture, usedAgoMs: number) {
    const subject = issue(1);
    f.subject(subject, { usedAgoMs });
    const worktree = f.worktree(subject);
    writeFileSync(join(worktree, "wip.txt"), "wip\n");
    const lane = f.lane(subject, 1);
    mkdirSync(traceDirectory(f.root, subject), { recursive: true });
    writeFileSync(join(traceDirectory(f.root, subject), "tsk_1.jsonl"), "{}\n");
    mkdirSync(registrySnapshotDirectory(f.root, subject), { recursive: true });
    f.server.answer(subject.id, "gone");
    return { subject, lane };
  }

  test("are forgotten after the orphan TTL, keeping unsaved work as a snapshot ref", async () => {
    const f = reclaimFixture();
    const { subject } = orphan(f, 100 * HOUR);

    const report = await f.engine().run("periodic");

    for (const path of [
      workDirectory(f.root, subject), envOf(f, subject), traceDirectory(f.root, subject),
      registryFile(f.root, subject), registrySnapshotDirectory(f.root, subject),
    ]) expect(existsSync(path)).toBe(false);
    const commit = git(f.bare, ["rev-parse", "refs/remi/snapshots/iss_1/1"]);
    expect(git(f.bare, ["show", `${commit}:wip.txt`])).toBe("wip");
    expect(f.server.reclaimed).toEqual([]);
    expect(report).toMatchObject({ forgotten_this_round: 1, reclaimed_this_round: 0, plan: [{ action: "forget", reason: "orphan", unsaved_work: true }] });
    expect(report.subjects.total).toBe(0);
  });

  test("are kept within the orphan TTL", async () => {
    const f = reclaimFixture();
    const { subject } = orphan(f, 10 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(workDirectory(f.root, subject))).toBe(true);
    expect(f.record(subject)).not.toBeNull();
    expect(report.retained).toEqual({ within_ttl: 1 });
  });

  test("are kept when their unsaved work cannot be saved", async () => {
    const f = reclaimFixture();
    f.policy.snapshot_max_bytes = 1024 * 1024;
    const { subject } = orphan(f, 100 * HOUR);
    writeFileSync(join(workDirectory(f.root, subject), REPO_DIR, "huge.bin"), Buffer.alloc(2 * 1024 * 1024, 1));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDirectory(f.root, subject))).toBe(true);
    expect(f.record(subject)).not.toBeNull();
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });

  test("a reclaimed subject is only looked up again after a while", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { state: "reclaimed" });
    f.server.answer(subject.id, issueEnded());
    const engine = f.engine();

    await engine.run("periodic");
    await engine.run("periodic");
    expect(f.server.checks).toEqual([subject.id]);

    await engine.run("dry_run");
    expect(f.server.checks).toEqual([subject.id, subject.id]);
  });
});

describe("housekeeping", () => {
  test("cleans a superseded generation once idle past the TTL, even for an active subject", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    const recent = f.lane(subject, 2, { ageMs: 10 * HOUR });
    const current = f.lane(subject, 3);

    await f.engine().run("periodic");

    expect(readdirSync(join(stale, "home")).sort()).toEqual(["projects", "session_index.jsonl"]);
    expect(existsSync(join(stale, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(recent, ".remi-runtime"))).toBe(true);
    expect(existsSync(join(current, ".remi-runtime"))).toBe(true);
  });

  test("never cleans a superseded generation of a running subject", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    f.lane(subject, 2);
    const finish = executionTrackerFor(f.root).begin(subject.id, "tsk_running");
    try {
      await f.engine().run("periodic");
      expect(existsSync(join(stale, ".remi-runtime"))).toBe(true);
    } finally {
      finish();
    }
  });

  test("removes the private temp directories of executions that are not running", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const tmp = join(envOf(f, subject), "tmp");
    mkdirSync(join(tmp, "tsk_dead-abc123"), { recursive: true });
    mkdirSync(join(tmp, "tsk_live-def456"), { recursive: true });
    const finish = executionTrackerFor(f.root).begin(subject.id, "tsk_live");
    try {
      await f.engine().run("periodic");
      expect(readdirSync(tmp)).toEqual(["tsk_live-def456"]);
    } finally {
      finish();
    }
  });

  test("removes the temp directories of a subject that has no registry record", async () => {
    const f = reclaimFixture();
    const tmp = join(f.root, "env", "chat_unrecorded", "tmp");
    mkdirSync(join(tmp, "tsk_dead-abc123"), { recursive: true });
    await f.engine().run("periodic");
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("deletes legacy directories after the keep period", async () => {
    const f = reclaimFixture();
    const today = new Date(f.now).toISOString().slice(0, 10).replaceAll("-", "");
    const old = new Date(f.now - 8 * DAY).toISOString().slice(0, 10).replaceAll("-", "");
    for (const name of [`legacy-${old}`, `legacy-${today}`, "legacy-notes"]) {
      mkdirSync(join(f.root, name), { recursive: true });
      writeFileSync(join(f.root, name, "old.txt"), "old");
    }

    await f.engine().run("periodic");

    expect(existsSync(join(f.root, `legacy-${old}`))).toBe(false);
    expect(existsSync(join(f.root, `legacy-${today}`))).toBe(true);
    expect(existsSync(join(f.root, "legacy-notes"))).toBe(true);
  });

  test("prunes the registrations of worktrees whose directory is gone", async () => {
    const f = reclaimFixture();
    const { worktree } = endedIssue(f, 1);
    const other = issue(2);
    f.subject(other);
    f.server.answer(other.id, { status: "in_progress" });
    const stray = f.worktree(other);
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).toContain(stray);
    // Deleted out of band: only a prune notices.
    await Bun.$`rm -rf ${stray}`.quiet();

    await f.engine().run("periodic");

    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(stray);
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
  });
});

describe("restoring a reclaimed subject", () => {
  async function reclaimWithWork(f: ReclaimFixture) {
    const reclaimed = endedIssue(f, 1, (path) => {
      writeFileSync(join(path, "README.md"), "edited\n");
      writeFileSync(join(path, "new.txt"), "new\n");
    });
    await f.engine().run("periodic");
    expect(f.record(reclaimed.subject)!.state).toBe("reclaimed");
    // Reopened: the branch is checked out again into a fresh worktree.
    const fresh = join(reclaimed.workDir, REPO_DIR);
    return {
      ...reclaimed,
      fresh,
      reopen() {
        mkdirSync(reclaimed.workDir, { recursive: true });
        git(f.bare, ["worktree", "add", fresh, "agent/iss_1"]);
        return fresh;
      },
    };
  }

  test("brings back uncommitted and untracked work and marks the subject active", async () => {
    const f = reclaimFixture();
    const { subject, reopen } = await reclaimWithWork(f);
    const fresh = reopen();

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(fresh, "new.txt"), "utf8")).toBe("new\n");
    // Uncommitted, not staged: exactly as the work was left.
    expect(git(fresh, ["diff", "--name-only"])).toBe("README.md");
    expect(git(fresh, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(fresh, ["ls-files", "--others", "--exclude-standard"])).toBe("new.txt");
    // Applied once, so it leaves the record; the ref stays in the repository.
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toContain("refs/remi/snapshots/iss_1/1");
  });

  test("restoring twice changes nothing more", async () => {
    const f = reclaimFixture();
    const { subject, reopen } = await reclaimWithWork(f);
    const fresh = reopen();
    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });
    writeFileSync(join(fresh, "README.md"), "edited after restore\n");

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("edited after restore\n");
  });

  test("does not clobber a worktree that diverged from the saved HEAD", async () => {
    const f = reclaimFixture();
    const { subject, reopen } = await reclaimWithWork(f);
    const snapshot = f.record(subject)!.snapshot!.git[0]!;
    // The branch moved on elsewhere before the reopen.
    const moved = git(f.bare, ["commit-tree", git(f.bare, ["rev-parse", "origin/main^{tree}"]), "-p", snapshot.head, "-m", "moved on"]);
    git(f.bare, ["update-ref", "refs/heads/agent/iss_1", moved]);
    const fresh = reopen();

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(git(fresh, ["rev-parse", "HEAD"])).toBe(moved);
    expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("initial\n");
    expect(existsSync(join(fresh, "new.txt"))).toBe(false);
    expect(git(fresh, ["status", "--porcelain=v1"])).toBe("");
    // The ref stays for manual recovery.
    expect(git(f.bare, ["rev-parse", snapshot.ref])).toBe(snapshot.commit);
  });

  test("does not clobber local changes made since the reopen", async () => {
    const f = reclaimFixture();
    const { subject, reopen } = await reclaimWithWork(f);
    const fresh = reopen();
    writeFileSync(join(fresh, "mine.txt"), "mine\n");

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(readFileSync(join(fresh, "mine.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("initial\n");
    expect(existsSync(join(fresh, "new.txt"))).toBe(false);
  });

  test("a subject that is not reclaimed is left alone", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const worktree = f.worktree(subject);
    writeFileSync(join(worktree, "mine.txt"), "mine\n");

    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(readFileSync(join(worktree, "mine.txt"), "utf8")).toBe("mine\n");
    expect(f.record(subject)!.state).toBe("active");
  });

  test("saved work that was never taken back survives the next reclaim", async () => {
    const f = reclaimFixture();
    const { subject, workDir, reopen, fresh } = await reclaimWithWork(f);
    const saved = f.record(subject)!.snapshot!;
    // Reopened and used without checking the repository out, then ended again.
    mkdirSync(workDir, { recursive: true });
    f.subject(subject, { state: "reclaimed" });

    const report = await f.engine().run("periodic");

    expect(report.reclaimed_this_round).toBe(1);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: saved.git } });
    reopen();
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    expect(readFileSync(join(fresh, "new.txt"), "utf8")).toBe("new\n");
  });

  test("stays reclaimed until every saved repository is checked out again", async () => {
    const f = reclaimFixture();
    const { subject, reopen, fresh } = await reclaimWithWork(f);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    expect(f.record(subject)!.state).toBe("reclaimed");

    reopen();
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    expect(readFileSync(join(fresh, "new.txt"), "utf8")).toBe("new\n");
    expect(f.record(subject)!.state).toBe("active");
  });
});

describe("restoring while a saved repository is still waiting", () => {
  test("an entry applied once is not applied again after the agent discarded it", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const worktree = f.worktree(subject);
    writeFileSync(join(worktree, "README.md"), "edited\n");
    writeFileSync(join(worktree, "new.txt"), "new\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    // A second saved repository nobody has checked out again keeps the record reclaimed.
    updateSubjectRecord(f.root, subject, (current) => ({
      ...current,
      snapshot: {
        ...current.snapshot!,
        git: [...current.snapshot!.git, { ...current.snapshot!.git[0]!, repo_url: "https://example.test/other.git", ref: "refs/remi/snapshots/iss_1/2", dir: "other" }],
      },
    }));
    const fresh = join(workDirectory(f.root, subject), REPO_DIR);
    git(f.bare, ["worktree", "add", fresh, "agent/iss_1"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    expect(readFileSync(join(fresh, "new.txt"), "utf8")).toBe("new\n");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [{ repo_url: "https://example.test/other.git" }] } });
    // The agent throws the restored work away; the next checkout must not bring it back.
    git(fresh, ["checkout", "--", "."]);
    git(fresh, ["clean", "-fd"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(readFileSync(join(fresh, "README.md"), "utf8")).toBe("initial\n");
    expect(existsSync(join(fresh, "new.txt"))).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
  });

  test("a restore never writes back a stale copy of the record", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const worktree = f.worktree(subject);
    writeFileSync(join(worktree, "new.txt"), "new\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    const fresh = join(workDirectory(f.root, subject), REPO_DIR);
    git(f.bare, ["worktree", "add", fresh, "agent/iss_1"]);

    // A second holder starts while the first one is mid-restore.
    const restoring = restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    const usedAt = new Date(f.now + 5 * HOUR);
    upsertSubjectRecord(f.root, { subject, workspace_id: "local", now: usedAt });
    await restoring;

    expect(f.record(subject)).toMatchObject({ state: "active", last_used_at: usedAt.toISOString() });
  });
});

/** A Wiki working copy as the daemon materializes it: the pages and the fetch baseline they equal. */
function materialize(workDir: string, pages: Record<string, string>) {
  mkdirSync(join(workDir, "wiki"), { recursive: true });
  mkdirSync(join(workDir, ".multiremi", "wiki-base", "files"), { recursive: true });
  for (const [path, text] of Object.entries(pages)) {
    writeFileSync(join(workDir, "wiki", path), text);
    writeFileSync(join(workDir, ".multiremi", "wiki-base", "files", path), text);
  }
  writeFileSync(join(workDir, ".multiremi", "wiki-base", "manifest.json"), JSON.stringify({
    version: 1,
    projectId: "prj_1",
    docs: Object.entries(pages).map(([path, text]) => ({ id: path, slug: path, path, sha256: sha256(text) })),
  }));
}

describe("the Wiki working copy", () => {
  test("saves changed, new and deleted pages and restores them over a rebuilt copy", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    materialize(workDir, { "a.md": "base a\n", "b.md": "base b\n", "c.md": "base c\n" });
    writeFileSync(join(workDir, "wiki", "a.md"), "edited a\n");
    writeFileSync(join(workDir, "wiki", "new.md"), "new page\n");
    writeFileSync(join(workDir, "wiki", "ignored.txt"), "not a page");
    await Bun.$`rm ${join(workDir, "wiki", "b.md")}`.quiet();
    f.server.answer(subject.id, issueEnded());

    await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(f.record(subject)!.snapshot).toMatchObject({ git: [], wiki_files: 3 });
    expect(f.server.reclaimed[0]).toMatchObject({ unsaved_work: true });
    const saved = join(registrySnapshotDirectory(f.root, subject), "wiki");
    expect(readdirSync(saved).sort()).toEqual(["a.md", "deleted.json", "new.md"]);

    // Reopened: the working copy is materialized from the server again, one page edited upstream.
    materialize(workDir, { "a.md": "base a\n", "b.md": "base b\n", "c.md": "base c\n" });
    writeFileSync(join(workDir, "wiki", "new.md"), "typed by someone since\n");
    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });

    expect(readFileSync(join(workDir, "wiki", "a.md"), "utf8")).toBe("edited a\n");
    expect(existsSync(join(workDir, "wiki", "b.md"))).toBe(false);
    expect(readFileSync(join(workDir, "wiki", "c.md"), "utf8")).toBe("base c\n");
    // A page edited since the rebuild is never overwritten.
    expect(readFileSync(join(workDir, "wiki", "new.md"), "utf8")).toBe("typed by someone since\n");
    expect(f.record(subject)!.state).toBe("active");
  });

  test("saved pages that were never taken back survive the next reclaim", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    const pages = { "a.md": "base a\n", "b.md": "base b\n", "c.md": "base c\n" };
    materialize(workDir, pages);
    writeFileSync(join(workDir, "wiki", "a.md"), "edited a\n");
    writeFileSync(join(workDir, "wiki", "c.md"), "edited c\n");
    await Bun.$`rm ${join(workDir, "wiki", "b.md")}`.quiet();
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    expect(f.record(subject)!.snapshot).toMatchObject({ wiki_files: 3 });

    // Reopened and rebuilt, but the restore never ran; one page is edited again before the next reclaim.
    const usedAt = new Date(f.now + HOUR);
    upsertSubjectRecord(f.root, { subject, workspace_id: "local", now: usedAt });
    materialize(workDir, pages);
    writeFileSync(join(workDir, "wiki", "c.md"), "edited c again\n");
    await f.engine({ now: () => usedAt.getTime() + 10 * DAY }).run("periodic");

    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { wiki_files: 3 } });
    const saved = join(registrySnapshotDirectory(f.root, subject), "wiki");
    expect(readdirSync(saved).sort()).toEqual(["a.md", "c.md", "deleted.json"]);
    expect(readFileSync(join(saved, "c.md"), "utf8")).toBe("edited c again\n");

    materialize(workDir, pages);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: true });
    expect(readFileSync(join(workDir, "wiki", "a.md"), "utf8")).toBe("edited a\n");
    expect(existsSync(join(workDir, "wiki", "b.md"))).toBe(false);
    expect(readFileSync(join(workDir, "wiki", "c.md"), "utf8")).toBe("edited c again\n");
  });

  test("an unchanged working copy leaves no wiki snapshot", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    materialize(workDirectory(f.root, subject), { "a.md": "base a\n" });
    f.server.answer(subject.id, issueEnded());

    await f.engine().run("periodic");

    expect(f.record(subject)!.snapshot).toBeNull();
    expect(existsSync(registrySnapshotDirectory(f.root, subject))).toBe(false);
  });
});

describe("a reclaimed subject that is used again", () => {
  /** Reclaimed once `ago` ago, then used again (a discussion, a Runtime workspace) without a work directory. */
  async function reusedAfterReclaim(f: ReclaimFixture, subject: StorageSubjectRef, options: { externalWorkDir?: string } = {}) {
    f.subject(subject, options);
    f.server.answer(subject.id, issueEnded(40 * DAY));
    const reclaimedAt = f.now + 40 * DAY;
    await f.engine({ now: () => reclaimedAt }).run("periodic");
    expect(f.record(subject)!.state).toBe("reclaimed");
    const usedAt = new Date(reclaimedAt + HOUR);
    upsertSubjectRecord(f.root, { subject, workspace_id: "local", now: usedAt });
    return { reclaimedAt, usedAt };
  }

  test.each([
    ["an Issue used only by discussions", {}],
    ["a Runtime workspace", { externalWorkDir: "/runtime-workspace" }],
  ])("is reclaimed again once its retention passes: %s", async (_name, options) => {
    const f = reclaimFixture();
    const subject = issue(1);
    const { usedAt } = await reusedAfterReclaim(f, subject, options);
    const environment = f.lane(subject, 2);
    expect(f.server.reclaimed).toHaveLength(1);

    const report = await f.engine({ now: () => usedAt.getTime() + 30 * DAY }).run("run");

    expect(report.reclaimed_this_round).toBe(1);
    expect(existsSync(join(environment, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(environment, "home", "projects", "-work", "session.jsonl"))).toBe(true);
    expect(f.server.reclaimed).toHaveLength(2);
    // Settled again: nothing left to do until the next use.
    const next = await f.engine({ now: () => usedAt.getTime() + 31 * DAY }).run("periodic");
    expect(next.reclaimed_this_round).toBe(0);
    expect(f.server.reclaimed).toHaveLength(2);
  });

  test("is not looked up again while the reclaim still describes the disk", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    f.server.answer(subject.id, issueEnded(40 * DAY));
    const reclaimedAt = f.now + 40 * DAY;
    const engine = f.engine({ now: () => reclaimedAt });
    await engine.run("periodic");
    const checks = f.server.checks.length;

    await engine.run("periodic");

    expect(f.server.checks).toHaveLength(checks);
  });

  test("a superseded generation of a reused subject is cleaned inside its retention", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    const { usedAt } = await reusedAfterReclaim(f, subject);
    const now = usedAt.getTime() + HOUR;
    const superseded = f.lane(subject, 2, { ageMs: Date.now() - now + 100 * HOUR });
    const current = f.lane(subject, 3);

    const report = await f.engine({ now: () => now }).run("periodic");

    expect(report.reclaimed_this_round).toBe(0);
    expect(existsSync(join(superseded, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(current, ".remi-runtime"))).toBe(true);
  });
});

/** A `du` that never finishes on its own; it ends when its deadline passes, like the real one. */
const hangingMeasure = (_paths: readonly string[], signal: AbortSignal) => new Promise<number>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

describe("disk usage in the report", () => {
  test("a round never waits for the measurement; the report carries the latest completed one", async () => {
    const f = reclaimFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = f.engine({ measure: async () => { await gate; return 2048; } });

    const started = Date.now();
    const first = await engine.run("periodic");

    expect(Date.now() - started).toBeLessThan(5000);
    expect(first.bytes).toBeNull();
    expect(first.bytes_measured_at).toBeNull();
    release();
    await engine.measurementSettled();
    const second = await engine.run("periodic");
    expect(second.bytes).toEqual({ work: 2048, env: 2048, traces: 2048, shared: 2048, legacy: 2048 });
    expect(second.bytes_measured_at).toBe(new Date(f.now).toISOString());
    expect(JSON.parse(readFileSync(diskUsageFile(f.root), "utf8"))).toMatchObject({ version: 1, measured_at: new Date(f.now).toISOString() });
  });

  test("every kind of round carries the cached sizes, a requested dry run included", async () => {
    const f = reclaimFixture();
    const engine = f.engine({ measure: async () => 1024 });
    await engine.run("periodic");
    await engine.measurementSettled();

    for (const mode of ["periodic", "dry_run", "run"] as const) {
      const report = await engine.run(mode);
      expect(report.bytes).toEqual({ work: 1024, env: 1024, traces: 1024, shared: 1024, legacy: 1024 });
      expect(report.bytes_measured_at).not.toBeNull();
      await engine.measurementSettled();
    }
  });

  test("measures at most hourly unless an operator asks", async () => {
    const f = reclaimFixture();
    let measurements = 0;
    let clock = f.now;
    const engine = f.engine({ now: () => clock, measure: async () => { measurements++; return 1024; } });
    const settle = async () => { await engine.measurementSettled(); const count = measurements; measurements = 0; return count; };

    await engine.run("periodic");
    expect(await settle()).toBe(5);

    clock += 59 * 60_000;
    await engine.run("periodic");
    expect(await settle()).toBe(0);

    // Asked: a dry run or a real run measures again at once.
    await engine.run("dry_run");
    expect(await settle()).toBe(5);
    await engine.run("run");
    expect(await settle()).toBe(5);

    clock += 61 * 60_000;
    await engine.run("periodic");
    expect(await settle()).toBe(5);
  });

  test("sizes after a round reflect what the round left", async () => {
    const f = reclaimFixture();
    const { subject, workDir, lane } = endedIssue(f, 1);
    writeFileSync(join(lane, "home", "blob.bin"), Buffer.alloc(256 * 1024, 1));
    const engine = f.engine({ measure: undefined });

    const report = await engine.run("run");
    await engine.measurementSettled();
    const later = await engine.run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(report.freed_bytes).toBeGreaterThanOrEqual(0);
    // The home keeps its history entries only; the cached sizes are of the directories as they are now.
    expect(later.bytes!.work).toBeLessThan(256 * 1024);
    expect(later.bytes!.env).toBeLessThan(256 * 1024);
    expect(later.bytes!.shared).toBeGreaterThan(0);
    expect(f.record(subject)!.state).toBe("reclaimed");
  });

  test("a measurement that never finishes neither delays nor fails a round, and the earlier numbers stay", async () => {
    const f = reclaimFixture();
    let clock = f.now;
    const good = f.engine({ now: () => clock, measure: async () => 777 });
    await good.run("periodic");
    await good.measurementSettled();

    clock += 2 * 3_600_000;
    const stuck = f.engine({ now: () => clock, measure: hangingMeasure, diskUsage: { categoryTimeoutMs: 60 } });
    const started = Date.now();
    const report = await stuck.run("periodic");

    expect(Date.now() - started).toBeLessThan(5000);
    expect(report.errors).toEqual([]);
    expect(report.bytes).toEqual({ work: 777, env: 777, traces: 777, shared: 777, legacy: 777 });
    expect(report.bytes_measured_at).toBe(new Date(f.now).toISOString());
    // The hung measurement runs out its own deadline; the next reports still carry the old numbers.
    await stuck.measurementSettled();
    expect((await stuck.run("periodic")).bytes!.work).toBe(777);
  });

  test("a round sizes no subject: plan sizes stay unknown, and only the background measurement walks directories", async () => {
    const f = reclaimFixture();
    const { subject } = endedIssue(f, 1);
    const kept = issue(2);
    f.subject(kept);
    f.server.answer(kept.id, { status: "in_progress" });
    const asked: string[] = [];
    const engine = f.engine({ measure: async (paths) => { asked.push(...paths); return 1; } });

    const dry = await engine.run("dry_run");
    await engine.measurementSettled();
    const real = await engine.run("run");
    await engine.measurementSettled();

    for (const report of [dry, real]) {
      expect(report.plan.every((item) => item.bytes === null)).toBe(true);
      expect(report.plan).toContainEqual(expect.objectContaining({ subject, action: "reclaim", bytes: null }));
    }
    // Every request is for one of the root's categories; none is for a subject's directories.
    const categories = [workRoot(f.root), envRoot(f.root), tracesRoot(f.root), sharedRoot(f.root)];
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((path) => categories.includes(path))).toBe(true);
  });
});

describe("the configured repository cache", () => {
  test("is pruned at the end of a round, wherever it lives", async () => {
    const f = reclaimFixture();
    const moved = join(f.scratch, "elsewhere", "local", "repo-0123456789abcdef.git");
    mkdirSync(join(f.scratch, "elsewhere", "local"), { recursive: true });
    await Bun.$`mv ${f.bare} ${moved}`.quiet();
    const subject = issue(1);
    f.subject(subject);
    f.server.answer(subject.id, { status: "in_progress" });
    const stray = join(workDirectory(f.root, subject), REPO_DIR);
    mkdirSync(workDirectory(f.root, subject), { recursive: true });
    git(moved, ["worktree", "add", "-b", "agent/stray", stray, "origin/main"]);
    await Bun.$`rm -rf ${stray}`.quiet();

    await f.engine({ repoCacheRoot: join(f.scratch, "elsewhere") }).run("periodic");

    expect(git(moved, ["worktree", "list", "--porcelain"])).not.toContain(stray);
  });
});

describe("a subject kept because its Wiki changes do not fit", () => {
  test("collects no snapshot ref for its repositories round after round", async () => {
    const f = reclaimFixture();
    f.policy.snapshot_max_bytes = 1024 * 1024;
    const subject = issue(1);
    f.subject(subject);
    const worktree = f.worktree(subject);
    writeFileSync(join(worktree, "README.md"), "edited\n");
    const workDir = workDirectory(f.root, subject);
    mkdirSync(join(workDir, "wiki"), { recursive: true });
    mkdirSync(join(workDir, ".multiremi", "wiki-base"), { recursive: true });
    writeFileSync(join(workDir, ".multiremi", "wiki-base", "manifest.json"), JSON.stringify({ version: 1, projectId: "prj_1", docs: [] }));
    writeFileSync(join(workDir, "wiki", "big.md"), "x".repeat(2 * 1024 * 1024));
    f.server.answer(subject.id, issueEnded());

    for (let round = 0; round < 3; round++) {
      const report = await f.engine().run("run");
      expect(report.retained).toEqual({ snapshot_failed: 1 });
    }

    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)!.state).toBe("active");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("edited\n");
  });
});

describe("an Issue that moved to another workspace", () => {
  /** The Issue's records on this daemon: native history, a trace, and a worktree with unsaved work. */
  function movedIssue(f: ReclaimFixture, usedAgoMs: number) {
    const subject = issue(1);
    f.subject(subject, { usedAgoMs });
    const worktree = f.worktree(subject);
    writeFileSync(join(worktree, "wip.txt"), "wip\n");
    const lane = f.lane(subject, 1);
    mkdirSync(traceDirectory(f.root, subject), { recursive: true });
    writeFileSync(join(traceDirectory(f.root, subject), "tsk_1.jsonl"), "{}\n");
    // The server tells only a daemon that ran the Issue, and with no timestamps.
    f.server.answer(subject.id, { status: "moved" });
    return { subject, worktree, lane };
  }

  test("is reclaimed after the TTL like an ended Issue: unsaved work saved first, records kept", async () => {
    const f = reclaimFixture();
    const { subject, lane } = movedIssue(f, 100 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(workDirectory(f.root, subject))).toBe(false);
    const ref = "refs/remi/snapshots/iss_1/1";
    expect(git(f.bare, ["show", `${git(f.bare, ["rev-parse", ref])}:wip.txt`])).toBe("wip");
    expect(readdirSync(join(lane, "home")).sort()).toEqual(["projects", "session_index.jsonl"]);
    expect(existsSync(join(traceDirectory(f.root, subject), "tsk_1.jsonl"))).toBe(true);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: [{ ref }] } });
    expect(f.server.reclaimed).toEqual([expect.objectContaining({ subject, unsaved_work: true })]);
    expect(report).toMatchObject({
      reclaimed_this_round: 1, forgotten_this_round: 0,
      plan: [{ subject, action: "reclaim", reason: "ended_ttl", unsaved_work: true }],
      subjects: { total: 1, reclaimed: 1 },
    });
  });

  test("is kept within the TTL and counts as ended", async () => {
    const f = reclaimFixture();
    const { subject } = movedIssue(f, 10 * HOUR);

    const report = await f.engine().run("run");

    expect(existsSync(workDirectory(f.root, subject))).toBe(true);
    expect(report.retained).toEqual({ within_ttl: 1 });
    expect(report.subjects).toMatchObject({ ended: 1, active: 0 });
  });

  test("is never forgotten, however long it has not been used; its records and registry entry stay", async () => {
    const f = reclaimFixture();
    const { subject } = movedIssue(f, 1000 * HOUR);

    const first = await f.engine().run("periodic");
    const again = await f.engine({ now: () => f.now + 30 * DAY }).run("run");

    expect(first).toMatchObject({ reclaimed_this_round: 1, forgotten_this_round: 0 });
    expect(again).toMatchObject({ reclaimed_this_round: 0, forgotten_this_round: 0 });
    expect(f.record(subject)).toMatchObject({ state: "reclaimed" });
    expect(existsSync(traceDirectory(f.root, subject))).toBe(true);
    expect(existsSync(join(f.root, "env", subject.id))).toBe(true);
  });

  test("is forgotten like any other once the server deletes it", async () => {
    const f = reclaimFixture();
    const { subject } = movedIssue(f, 1000 * HOUR);
    await f.engine().run("periodic");
    f.server.answer(subject.id, "gone");

    const report = await f.engine().run("run");

    expect(report).toMatchObject({ forgotten_this_round: 1, plan: [{ action: "forget", reason: "orphan" }] });
    expect(f.record(subject)).toBeNull();
    expect(existsSync(traceDirectory(f.root, subject))).toBe(false);
  });

  test("keeps a workspace it cannot save, like an ended Issue", async () => {
    const f = reclaimFixture();
    f.policy.snapshot_max_bytes = 1024 * 1024;
    const { subject, worktree } = movedIssue(f, 100 * HOUR);
    writeFileSync(join(worktree, "huge.bin"), Buffer.alloc(2 * 1024 * 1024, 1));

    const report = await f.engine().run("run");

    expect(existsSync(join(workDirectory(f.root, subject), REPO_DIR, "huge.bin"))).toBe(true);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });
});

describe("files at the top of a work directory", () => {
  const archived = { status: "archived", pinned: false, origin: null };

  /** The workspace an intake round leaves: a manifest beside read-only project views that link to code views. */
  function intakeWorkspace(f: ReclaimFixture, subject: StorageSubjectRef, options: { readOnly?: boolean } = {}) {
    const workDir = workDirectory(f.root, subject);
    const codeView = join(f.scratch, "code-view");
    mkdirSync(codeView, { recursive: true });
    writeFileSync(join(codeView, "README.md"), "a shared, read-only code view\n");
    const project = join(workDir, "projects", "Remi");
    mkdirSync(join(project, "repos"), { recursive: true });
    mkdirSync(join(project, "knowledge", "docs"), { recursive: true });
    writeFileSync(join(project, "project.json"), "{}\n");
    writeFileSync(join(project, "knowledge", "docs", "intro.md"), "intro\n");
    symlinkSync(codeView, join(project, "repos", "remi"), "dir");
    writeFileSync(join(workDir, "manifest.json"), `${JSON.stringify({ version: 1, mode: "intake" })}\n`);
    mkdirSync(join(workDir, ".multiremi"), { recursive: true });
    writeFileSync(join(workDir, ".multiremi", "workspace.json"), `${JSON.stringify({ version: 1, kind: "intake", read_only: true })}\n`);
    if (options.readOnly) {
      for (const directory of [join(project, "knowledge", "docs"), join(project, "knowledge"), join(project, "repos"), project, join(workDir, "projects")]) {
        chmodSync(directory, 0o555);
      }
    }
    return { workDir, codeView };
  }

  test("an ended intake Issue is reclaimed although its workspace has a manifest.json at the top", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const { workDir, codeView } = intakeWorkspace(f, subject, { readOnly: true });
    f.server.answer(subject.id, issueEnded());

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    // The views are links into a shared cache; removing the workspace never reaches through them.
    expect(readFileSync(join(codeView, "README.md"), "utf8")).toBe("a shared, read-only code view\n");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
    expect(f.server.reclaimed).toEqual([expect.objectContaining({ subject, unsaved_work: false })]);
  });

  test("an archived Chat is reclaimed although a report.md lies at the top of its workspace", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const worktree = f.worktree(subject, "chat/chat_1");
    const workDir = workDirectory(f.root, subject);
    writeFileSync(join(workDir, "report.md"), "# findings\n");
    writeFileSync(join(workDir, "download.bin"), Buffer.alloc(1024, 1));
    f.server.answer(subject.id, { ...archived, updated_at: new Date(f.now - 10 * DAY).toISOString() });
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("initial\n");

    const report = await f.engine().run("periodic");

    // Only repositories and the wiki are saved; the files an agent leaves beside them go with the workspace.
    expect(existsSync(workDir)).toBe(false);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
  });

  test("a dry run plans the reclaim of such a workspace without error", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "report.md"), "# findings\n");
    f.server.answer(subject.id, { ...archived, updated_at: new Date(f.now - 10 * DAY).toISOString() });

    const report = await f.engine().run("dry_run");

    expect(report.errors).toEqual([]);
    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", reason: "ended_ttl" })]);
    expect(existsSync(join(workDir, "report.md"))).toBe(true);
  });

  test("links at the top are removed as links and never followed", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const outside = join(f.scratch, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "precious");
    mkdirSync(join(outside, ".git"));
    const workDir = workDirectory(f.root, subject);
    mkdirSync(workDir, { recursive: true });
    symlinkSync(outside, join(workDir, "linked-dir"), "dir");
    symlinkSync(join(outside, "precious.txt"), join(workDir, "linked-file"));
    symlinkSync(join(f.scratch, "does-not-exist"), join(workDir, "dangling"));
    f.server.answer(subject.id, { ...archived, updated_at: new Date(f.now - 10 * DAY).toISOString() });

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("precious");
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });
  });

  test("a clean worktree beside the files is still checked, and its unsaved work still saved", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const worktree = f.worktree(subject, "chat/chat_1");
    writeFileSync(join(worktree, "README.md"), "edited\n");
    writeFileSync(join(workDirectory(f.root, subject), "report.md"), "# findings\n");
    f.server.answer(subject.id, { ...archived, updated_at: new Date(f.now - 10 * DAY).toISOString() });

    await f.engine().run("periodic");

    expect(git(f.bare, ["show", `${git(f.bare, ["rev-parse", "refs/remi/snapshots/chat_1/1"])}:README.md`])).toBe("edited");
  });
});

describe("repositories at the top of a work directory and below it", () => {
  const endedChat = (f: ReclaimFixture) => ({ status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * DAY).toISOString() });

  /** What the daemon keeps in every work directory; neither is the agent's own content. */
  function daemonEntries(workDir: string) {
    mkdirSync(join(workDir, ".multiremi"), { recursive: true });
    writeFileSync(join(workDir, ".multiremi", "task.json"), "{}\n");
    materialize(workDir, { "a.md": "base a\n" });
  }

  function addWorktree(f: ReclaimFixture, path: string, branch: string): string {
    mkdirSync(dirname(path), { recursive: true });
    git(f.bare, ["worktree", "add", "-b", branch, path, "origin/main"]);
    return path;
  }

  test("a standalone clone at the work directory itself with unsaved work keeps the subject", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), workDir]);
    writeFileSync(join(workDir, "wip.txt"), "wip\n");
    f.server.answer(subject.id, endedChat(f));

    const report = await f.engine().run("periodic");

    expect(readFileSync(join(workDir, "wip.txt"), "utf8")).toBe("wip\n");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("standalone clone") }]);
    expect(f.record(subject)!.state).toBe("active");
  });

  test("a standalone clone with commits that were never pushed keeps the subject too", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    mkdirSync(workDir, { recursive: true });
    git(workDir, ["init", "--initial-branch=main"]);
    writeFileSync(join(workDir, "idea.txt"), "idea\n");
    git(workDir, ["add", "."]);
    git(workDir, ["commit", "-m", "idea"]);
    f.server.answer(subject.id, endedChat(f));

    const report = await f.engine().run("periodic");

    expect(existsSync(join(workDir, "idea.txt"))).toBe(true);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });

  test("a clean standalone clone at the work directory itself is reclaimed; the daemon's own entries are not its content", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), workDir]);
    daemonEntries(workDir);
    f.server.answer(subject.id, endedChat(f));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test("a linked worktree at the work directory itself is snapshotted without the daemon's entries", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    mkdirSync(join(f.root, "work"), { recursive: true });
    git(f.bare, ["worktree", "add", "-b", "chat/chat_1", workDir, "origin/main"]);
    daemonEntries(workDir);
    writeFileSync(join(workDir, "README.md"), "edited\n");
    writeFileSync(join(workDir, "notes.txt"), "notes\n");
    const head = git(workDir, ["rev-parse", "HEAD"]);
    f.server.answer(subject.id, endedChat(f));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    const ref = "refs/remi/snapshots/chat_1/1";
    const commit = git(f.bare, ["rev-parse", ref]);
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", commit]).split("\n").sort()).toEqual(["README.md", "notes.txt"]);
    expect(git(f.bare, ["show", `${commit}:README.md`])).toBe("edited");
    expect(git(f.bare, ["rev-parse", `${commit}^`])).toBe(head);
    expect(f.record(subject)!.snapshot!.git).toEqual([
      { repo_url: REPO_URL, ref, commit, head, branch: "chat/chat_1", dir: "." },
    ]);
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(workDir);
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [], plan: [{ action: "reclaim", unsaved_work: true }] });
  });

  test("a linked worktree at the work directory itself that holds only the daemon's entries needs no snapshot", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    mkdirSync(join(f.root, "work"), { recursive: true });
    git(f.bare, ["worktree", "add", "-b", "chat/chat_1", workDir, "origin/main"]);
    daemonEntries(workDir);
    f.server.answer(subject.id, endedChat(f));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });
  });

  test.each([
    ["two", "group/experiment"],
    ["three", "a/b/experiment"],
  ])("a linked worktree nested %s levels down with unsaved work is snapshotted", async (_depth, relativePath) => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    f.worktree(subject);
    const nested = addWorktree(f, join(workDir, ...relativePath.split("/")), "agent/iss_1-experiment");
    writeFileSync(join(nested, "idea.txt"), "idea\n");
    f.server.answer(subject.id, issueEnded());

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    const [entry] = f.record(subject)!.snapshot!.git;
    expect(f.record(subject)!.snapshot!.git).toHaveLength(1);
    expect(entry).toMatchObject({ ref: "refs/remi/snapshots/iss_1/1", branch: "agent/iss_1-experiment", dir: relativePath });
    expect(git(f.bare, ["show", `${entry!.commit}:idea.txt`])).toBe("idea");
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(nested);
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });
  });

  test("a nested worktree that is clean is not saved", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    addWorktree(f, join(workDirectory(f.root, subject), "group", "experiment"), "agent/iss_1-experiment");
    f.server.answer(subject.id, issueEnded());

    await f.engine().run("periodic");

    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
  });

  test("a standalone clone nested below the work directory with unsaved work keeps the subject", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const clone = join(workDirectory(f.root, subject), "tmp", "clone");
    mkdirSync(dirname(clone), { recursive: true });
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), clone]);
    writeFileSync(join(clone, "wip.txt"), "wip\n");
    f.server.answer(subject.id, issueEnded());

    const report = await f.engine().run("periodic");

    expect(readFileSync(join(clone, "wip.txt"), "utf8")).toBe("wip\n");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });

  test("the repository at the work directory leaves the repositories below it out of its own snapshot", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    mkdirSync(join(f.root, "work"), { recursive: true });
    git(f.bare, ["worktree", "add", "-b", "chat/chat_1", workDir, "origin/main"]);
    daemonEntries(workDir);
    writeFileSync(join(workDir, "top.txt"), "top\n");
    const nested = addWorktree(f, join(workDir, "tools", "helper"), "chat/chat_1-helper");
    writeFileSync(join(nested, "helper.txt"), "helper\n");
    f.server.answer(subject.id, endedChat(f));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    const saved = f.record(subject)!.snapshot!.git;
    expect(saved.map((entry) => [entry.dir, entry.branch])).toEqual([[".", "chat/chat_1"], ["tools/helper", "chat/chat_1-helper"]]);
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", saved[0]!.commit]).split("\n").sort()).toEqual(["README.md", "top.txt"]);
    expect(git(f.bare, ["ls-tree", "-r", "--name-only", saved[1]!.commit]).split("\n").sort()).toEqual(["README.md", "helper.txt"]);
    expect(report.errors).toEqual([]);
  });

  test("a repository under node_modules is a dependency and is not searched", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const dependency = join(workDirectory(f.root, subject), "node_modules", "dep");
    mkdirSync(dirname(dependency), { recursive: true });
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), dependency]);
    writeFileSync(join(dependency, "wip.txt"), "wip\n");
    f.server.answer(subject.id, issueEnded());

    const report = await f.engine().run("periodic");

    expect(existsSync(workDirectory(f.root, subject))).toBe(false);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  // Root reads any directory, so there is nothing to refuse there.
  test.skipIf(process.getuid?.() === 0)("a directory that cannot be listed keeps the subject: a repository may lie below it", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const locked = join(workDirectory(f.root, subject), "group", "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    f.server.answer(subject.id, issueEnded());
    try {
      const report = await f.engine().run("periodic");

      expect(existsSync(workDirectory(f.root, subject))).toBe(true);
      expect(report.retained).toEqual({ git_check_failed: 1 });
      expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("cannot search") }]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a dry run examines nested repositories too", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const nested = addWorktree(f, join(workDirectory(f.root, subject), "group", "experiment"), "agent/iss_1-experiment");
    writeFileSync(join(nested, "idea.txt"), "idea\n");
    const clone = join(workDirectory(f.root, subject), "tmp", "clone");
    mkdirSync(dirname(clone), { recursive: true });
    git(f.scratch, ["clone", join(f.scratch, "origin.git"), clone]);
    writeFileSync(join(clone, "wip.txt"), "wip\n");
    f.server.answer(subject.id, issueEnded());

    const report = await f.engine().run("dry_run");

    // The standalone clone cannot be saved, which is what a real round would find first.
    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "keep", reason: "snapshot_failed" })]);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
  });

  test("a snapshot of a nested worktree is only brought back where that worktree stands again", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    f.worktree(subject);
    const nested = addWorktree(f, join(workDir, "group", "experiment"), "agent/iss_1-experiment");
    writeFileSync(join(nested, "idea.txt"), "idea\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    expect(f.record(subject)!.state).toBe("reclaimed");

    // Reopened: the daemon checks the Issue's repository out again; the experiment is gone.
    mkdirSync(workDir, { recursive: true });
    git(f.bare, ["worktree", "add", join(workDir, REPO_DIR), "agent/iss_1"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    // Both are worktrees of one repository, yet the experiment's work must not land in the checkout.
    expect(existsSync(join(workDir, REPO_DIR, "idea.txt"))).toBe(false);
    expect(git(join(workDir, REPO_DIR), ["status", "--porcelain=v1"])).toBe("");
    expect(f.record(subject)!.state).toBe("reclaimed");
    expect(f.record(subject)!.snapshot!.git).toEqual([expect.objectContaining({ dir: "group/experiment" })]);

    // The worktree stands again where it was.
    git(f.bare, ["worktree", "add", join(workDir, "group", "experiment"), "agent/iss_1-experiment"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    expect(readFileSync(join(workDir, "group", "experiment", "idea.txt"), "utf8")).toBe("idea\n");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
  });

  test("a snapshot never reaches a worktree outside the work directory, whatever the record says", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    const nested = addWorktree(f, join(workDir, "group", "experiment"), "agent/iss_1-experiment");
    writeFileSync(join(nested, "idea.txt"), "idea\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    const elsewhere = join(f.scratch, "elsewhere");
    updateSubjectRecord(f.root, subject, (current) => ({
      ...current,
      snapshot: { ...current.snapshot!, git: current.snapshot!.git.map((entry) => ({ ...entry, dir: "../../../elsewhere" })) },
    }));
    mkdirSync(workDir, { recursive: true });
    git(f.bare, ["worktree", "add", elsewhere, "agent/iss_1-experiment"]);

    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });

    expect(existsSync(join(elsewhere, "idea.txt"))).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
  });

  test("a nested snapshot that was never taken back survives the next reclaim", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const workDir = workDirectory(f.root, subject);
    const nested = addWorktree(f, join(workDir, "group", "experiment"), "agent/iss_1-experiment");
    writeFileSync(join(nested, "idea.txt"), "idea\n");
    f.server.answer(subject.id, issueEnded());
    await f.engine().run("periodic");
    const saved = f.record(subject)!.snapshot!.git;
    expect(saved).toHaveLength(1);

    // Used again without anything checked out, then ended once more.
    mkdirSync(workDir, { recursive: true });
    f.subject(subject, { state: "reclaimed" });
    await f.engine().run("periodic");

    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: saved } });
  });
});

describe("legacy directories", () => {
  const legacyName = (f: ReclaimFixture, ageMs: number) => `legacy-${new Date(f.now - ageMs).toISOString().slice(0, 10).replaceAll("-", "")}`;

  /** A swept legacy directory: ordinary leftovers plus a worktree whose unsaved work was not snapshotted. */
  function legacyWithRetained(f: ReclaimFixture, ageMs: number) {
    const directory = join(f.root, legacyName(f, ageMs));
    mkdirSync(join(directory, "issues", "MUL-1"), { recursive: true });
    writeFileSync(join(directory, "issues", "MUL-1", "old.txt"), "old");
    writeFileSync(join(directory, "loose.txt"), "loose");
    mkdirSync(join(directory, ".runtime"));
    const worktree = join(directory, "retained", "issues", "MUL-2", "repo");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "precious.txt"), "the only copy");
    writeFileSync(join(directory, "retained.json"), JSON.stringify({
      version: 1,
      worktrees: [{ path: "retained/issues/MUL-2/repo", original_path: "issues/MUL-2/repo", reason: "snapshot_failed", message: "too large" }],
    }));
    return { directory, worktree };
  }

  test("expiry deletes everything but the worktrees kept for an operator, and the report counts them", async () => {
    const f = reclaimFixture();
    const { directory, worktree } = legacyWithRetained(f, 8 * DAY);

    const report = await f.engine().run("periodic");

    expect(readdirSync(directory).sort()).toEqual(["retained", "retained.json"]);
    expect(readFileSync(join(worktree, "precious.txt"), "utf8")).toBe("the only copy");
    expect(report.retained).toEqual({ legacy_retained: 1 });
    expect(report.errors).toEqual([]);

    // Nothing more to expire on later rounds; the worktree stays and stays counted.
    expect((await f.engine().run("periodic")).retained).toEqual({ legacy_retained: 1 });
    expect(readFileSync(join(worktree, "precious.txt"), "utf8")).toBe("the only copy");
  });

  test("once an operator has deleted the worktree it is no longer counted", async () => {
    const f = reclaimFixture();
    const { directory, worktree } = legacyWithRetained(f, 8 * DAY);
    await f.engine().run("periodic");

    rmSync(worktree, { recursive: true });
    const report = await f.engine().run("periodic");

    expect(report.retained).toEqual({});
    // The directory itself is left for the operator: the daemon never deletes retained/.
    expect(existsSync(join(directory, "retained.json"))).toBe(true);
  });

  test("a directory inside the keep period is untouched, and its retained worktrees are counted already", async () => {
    const f = reclaimFixture();
    const { directory } = legacyWithRetained(f, 2 * DAY);

    const report = await f.engine().run("periodic");

    expect(readdirSync(directory).sort()).toEqual([".runtime", "issues", "loose.txt", "retained", "retained.json"]);
    expect(report.retained).toEqual({ legacy_retained: 1 });
  });

  test("an unreadable list is reported, and its directory still keeps retained/", async () => {
    const f = reclaimFixture();
    const { directory, worktree } = legacyWithRetained(f, 8 * DAY);
    writeFileSync(join(directory, "retained.json"), "{ not json");

    const report = await f.engine().run("periodic");

    expect(readdirSync(directory).sort()).toEqual(["retained", "retained.json"]);
    expect(existsSync(join(worktree, "precious.txt"))).toBe(true);
    expect(report.errors).toEqual([{ subject_id: null, message: expect.stringContaining("retained legacy worktrees") }]);
  });

  test("a legacy directory that is a link out of the root is never cleaned through", async () => {
    const f = reclaimFixture();
    const outside = join(f.scratch, "outside-legacy");
    mkdirSync(join(outside, "retained"), { recursive: true });
    writeFileSync(join(outside, "loose.txt"), "outside");
    symlinkSync(outside, join(f.root, legacyName(f, 8 * DAY)), "dir");

    const report = await f.engine().run("periodic");

    expect(readFileSync(join(outside, "loose.txt"), "utf8")).toBe("outside");
    expect(existsSync(join(outside, "retained"))).toBe(true);
    expect(report.errors).toEqual([{ subject_id: null, message: expect.stringContaining("real directory") }]);
  });

  test("worktrees of several legacy directories are counted together", async () => {
    const f = reclaimFixture();
    legacyWithRetained(f, 8 * DAY);
    legacyWithRetained(f, 20 * DAY);

    expect((await f.engine().run("periodic")).retained).toEqual({ legacy_retained: 2 });
  });

  test("a retained worktree keeps its commits through expiry although the new cache already had its repository", async () => {
    const f = reclaimFixture();
    // The pre-ADR-0018 cache beside the new one the fixture made: the sweep cannot merge the two.
    const oldBare = join(f.root, ".repos", "local", "repo-0123456789abcdef.git");
    mkdirSync(dirname(oldBare), { recursive: true });
    git(f.scratch, ["clone", "--bare", join(f.scratch, "origin.git"), oldBare]);
    git(oldBare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(oldBare, ["fetch", "origin"]);
    const worktree = join(f.root, "issues", "MUL-2", "repo");
    mkdirSync(dirname(worktree), { recursive: true });
    git(oldBare, ["worktree", "add", "-b", "agent/MUL-2", worktree, "origin/main"]);
    const unpushed = commitIn(worktree, "unpushed.txt");
    writeFileSync(join(worktree, "big.bin"), Buffer.alloc(3 * 1024, 1));

    const swept = await runLegacySweep({ root: f.root, now: new Date(f.now), snapshotMaxBytes: 1024 });
    const legacy = join(f.root, `legacy-${new Date(f.now).toISOString().slice(0, 10).replaceAll("-", "")}`);
    const report = await f.engine({ now: () => f.now + 8 * DAY }).run("periodic");

    expect(swept).toMatchObject({ retained: 1 });
    expect(readdirSync(legacy).sort()).toEqual(["retained", "retained.json"]);
    const retained = join(legacy, "retained", "issues", "MUL-2", "repo");
    expect(git(retained, ["rev-parse", "HEAD"])).toBe(unpushed);
    expect(git(retained, ["log", "--format=%s", "-1"])).toBe("add unpushed.txt");
    expect(readFileSync(join(retained, "big.bin")).length).toBe(3 * 1024);
    expect(report.retained).toEqual({ legacy_retained: 1 });
    expect(report.errors).toEqual([]);
  });
});

describe("repositories an agent left in odd places keep what only they hold", () => {
  test.each([
    ["untracked by the checkout", false],
    ["ignored by the checkout", true],
  ])("a clone inside a checkout with an unpushed commit keeps the subject, whole: %s", async (_name, ignored) => {
    const f = reclaimFixture();
    const { subject, worktree, workDir, lane } = endedIssue(f, 1);
    const nested = cloneAt(f, join(worktree, ignored ? "scratch" : "third_party", "lib"));
    const local = commitIn(nested);
    if (ignored) {
      mkdirSync(join(f.bare, "info"), { recursive: true });
      writeFileSync(join(f.bare, "info", "exclude"), "scratch/\n");
    }

    const report = await f.engine().run("periodic");

    // Neither the checkout's snapshot nor anything else could have carried the clone's commit.
    expect(git(nested, ["rev-parse", "HEAD"])).toBe(local);
    expect(existsSync(workDir)).toBe(true);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(true);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)!.state).toBe("active");
    expect(f.server.reclaimed).toEqual([]);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(`${join("lib")} is a standalone clone`) }]);
  });

  test.each([
    [6, "keep"],
    // The documented limit of the search: anything deeper is not looked at.
    [7, "reclaim"],
  ])("a clone %i levels below the work directory is %s", async (depth, action) => {
    const f = reclaimFixture();
    const { workDir } = endedIssue(f, 1);
    commitIn(cloneAt(f, join(workDir, ...Array.from({ length: depth }, (_, index) => `d${index + 1}`))));

    const report = await f.engine().run("dry_run");

    expect(report.plan).toEqual([expect.objectContaining({ action })]);
  });

  test("a clean clone beside the checkout is deleted with the workspace", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = endedIssue(f, 1);
    cloneAt(f, join(workDir, "reference"));
    cloneAt(f, join(workDir, REPO_DIR, "vendor", "lib"));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test("a worktree of a clone inside the tree, with an untracked file, keeps the subject and records no ref", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    f.server.answer(subject.id, { status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * DAY).toISOString() });
    const workDir = workDirectory(f.root, subject);
    const clone = cloneAt(f, join(workDir, "clone"));
    const worktree = join(workDir, "clone-wt");
    git(clone, ["worktree", "add", "-b", "feature", worktree, "origin/main"]);
    writeFileSync(join(worktree, "precious.txt"), "unsaved\n");

    const report = await f.engine().run("periodic");

    // The worktree's `.git` is a file, yet the repository behind it is the clone inside the tree.
    expect(readFileSync(join(worktree, "precious.txt"), "utf8")).toBe("unsaved\n");
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(git(clone, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)).toMatchObject({ state: "active", snapshot: null });
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("clone-wt is a standalone clone") }]);
  });

  test("a clean worktree of a clone inside the tree is deleted with it", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    f.server.answer(subject.id, { status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * DAY).toISOString() });
    const workDir = workDirectory(f.root, subject);
    const clone = cloneAt(f, join(workDir, "clone"));
    git(clone, ["worktree", "add", "-b", "feature", join(workDir, "clone-wt"), "origin/main"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test("a clone with work on a side branch, in a stash or on a tag only it has keeps the subject", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    f.server.answer(subject.id, { status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * DAY).toISOString() });
    const clone = cloneAt(f, join(workDirectory(f.root, subject), "clone"));
    git(clone, ["checkout", "-b", "side"]);
    commitIn(clone);
    git(clone, ["checkout", "main"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(join(clone, ".git"))).toBe(true);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });

  test("a hard-deleted subject is not forgotten while a clone in it holds unsaved work", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: 100 * HOUR });
    const worktree = f.worktree(subject);
    const nested = cloneAt(f, join(worktree, "lib"));
    commitIn(nested);
    mkdirSync(traceDirectory(f.root, subject), { recursive: true });
    writeFileSync(join(traceDirectory(f.root, subject), "tsk_1.jsonl"), "{}\n");
    f.server.answer(subject.id, "gone");

    const report = await f.engine().run("periodic");

    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(traceDirectory(f.root, subject), "tsk_1.jsonl"))).toBe(true);
    expect(f.record(subject)).not.toBeNull();
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.forgotten_this_round).toBe(0);
  });

  test("a dry run keeps what a real round keeps", async () => {
    const f = reclaimFixture();
    const { subject, lane } = endedIssue(f, 1);
    commitIn(cloneAt(f, join(lane, "work", "clone")));

    const report = await f.engine().run("dry_run");

    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "keep", reason: "snapshot_failed" })]);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
  });
});

describe("bare repositories and remotes that die with the workspace", () => {
  function archivedChat(f: ReclaimFixture) {
    const subject = chat(1);
    f.subject(subject);
    f.server.answer(subject.id, { status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * DAY).toISOString() });
    const workDir = workDirectory(f.root, subject);
    mkdirSync(workDir, { recursive: true });
    return { subject, workDir };
  }

  test("a clone and the bare repository it pushed to keep the workspace: the commit's only other copy would go with it", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = archivedChat(f);
    const store = join(workDir, "store.git");
    git(workDir, ["init", "--bare", "--initial-branch=main", store]);
    const project = join(workDir, "project");
    git(workDir, ["clone", store, project]);
    git(project, ["checkout", "-b", "main"]);
    const precious = commitIn(project, "precious.txt");
    git(project, ["push", "origin", "main"]);

    const report = await f.engine().run("periodic");

    // The clone looks clean (its remote has the commit), but the remote is deleted with it.
    expect(git(project, ["rev-parse", "HEAD"])).toBe(precious);
    expect(git(store, ["rev-parse", "main"])).toBe(precious);
    expect(f.record(subject)!.state).toBe("active");
    expect(f.server.reclaimed).toEqual([]);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("standalone") }]);
  });

  test("a bare repository alone in the workspace, with commits nobody else has, keeps it", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = archivedChat(f);
    const store = join(workDir, "backup.git");
    git(workDir, ["init", "--bare", "--initial-branch=main", store]);
    const source = cloneAt(f, join(f.scratch, "outside-source"));
    const only = commitIn(source, "backup-only.txt");
    git(source, ["push", store, "HEAD:refs/heads/main"]);
    git(source, ["reset", "--hard", "origin/main"]);

    const report = await f.engine().run("run");

    expect(git(store, ["rev-parse", "main"])).toBe(only);
    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "keep", reason: "snapshot_failed" })]);
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("standalone bare repository with unsaved work") }]);
  });

  test("a hard-deleted subject is not forgotten while a bare repository in it holds commits", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject, { usedAgoMs: 10 * DAY });
    f.server.answer(subject.id, "gone");
    const store = join(workDirectory(f.root, subject), "store.git");
    mkdirSync(dirname(store), { recursive: true });
    git(dirname(store), ["init", "--bare", "--initial-branch=main", store]);
    const source = cloneAt(f, join(f.scratch, "outside-source"));
    commitIn(source, "only.txt");
    git(source, ["push", store, "HEAD:refs/heads/main"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(store)).toBe(true);
    expect(f.record(subject)).not.toBeNull();
    expect(report.forgotten_this_round).toBe(0);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });

  test("a worktree added inside a bare repository keeps the workspace: its uncommitted work is in no commit of the bare repository", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = archivedChat(f);
    const store = join(workDir, "store.git");
    git(f.scratch, ["clone", "--bare", join(f.scratch, "origin.git"), store]);
    git(store, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(store, ["fetch", "origin"]);
    git(store, ["worktree", "add", "-b", "feature", "feature", "origin/main"]);
    writeFileSync(join(store, "feature", "design.md"), "uncommitted design work\n");

    const report = await f.engine().run("periodic");

    expect(readFileSync(join(store, "feature", "design.md"), "utf8")).toBe("uncommitted design work\n");
    expect(f.record(subject)!.state).toBe("active");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(join("store.git", "feature")) }]);
  });

  test("an empty bare repository and a mirror of the origin hold nothing: they go with the workspace", async () => {
    const f = reclaimFixture();
    const { subject, workDir } = archivedChat(f);
    git(workDir, ["init", "--bare", "--initial-branch=main", join(workDir, "empty.git")]);
    const mirror = join(workDir, "mirror.git");
    git(f.scratch, ["clone", "--bare", join(f.scratch, "origin.git"), mirror]);
    git(mirror, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(mirror, ["fetch", "origin"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });
});

describe("what only a detached worktree names", () => {
  test("a commit made on a detached HEAD and named by a tag alone is saved: the cache prunes the tags no remote has", async () => {
    const f = reclaimFixture();
    const { subject, worktree } = endedIssue(f, 1);
    git(worktree, ["checkout", "--detach"]);
    const tagged = commitIn(worktree, "tagged-only.txt");
    git(worktree, ["tag", "my-local-tag"]);

    const report = await f.engine().run("periodic");

    expect(report.plan).toEqual([expect.objectContaining({ subject, action: "reclaim", unsaved_work: true })]);
    expect(f.record(subject)!.snapshot!.git).toEqual([expect.objectContaining({ dir: REPO_DIR, ref: "refs/remi/snapshots/iss_1/1", head: tagged, branch: null })]);
    // The next repository sync prunes local tags; the snapshot ref still holds the commit.
    git(f.bare, ["fetch", "--prune", "--prune-tags", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"]);
    expect(git(f.bare, ["for-each-ref", "--contains", tagged, "--format=%(refname)"])).toBe("refs/remi/snapshots/iss_1/1");
  });
});

describe("a snapshot never keeps only a pointer to a repository", () => {
  test("a clone below the depth the search reaches, in a checkout with other unsaved work, keeps the subject", async () => {
    const f = reclaimFixture();
    const { subject, worktree, workDir } = endedIssue(f, 1);
    // Seven levels below the work directory: `repo` is the first.
    const deep = cloneAt(f, join(worktree, "n1", "n2", "n3", "n4", "n5", "lib"));
    const only = commitIn(deep, "nested-only.txt");
    writeFileSync(join(deep, "dirty.txt"), "uncommitted nested\n");

    const report = await f.engine().run("periodic");

    // A snapshot of the checkout would hold a pointer to this clone's commit, not the clone.
    expect(git(deep, ["rev-parse", "HEAD"])).toBe(only);
    expect(existsSync(workDir)).toBe(true);
    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(f.record(subject)!.state).toBe("active");
    expect(f.server.reclaimed).toEqual([]);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining("not inspected") }]);
  });

  test("the same with another repository to save in the subject: nothing is saved while one cannot be", async () => {
    const f = reclaimFixture();
    const { subject, worktree, workDir } = endedIssue(f, 1);
    writeFileSync(join(worktree, "wip.txt"), "wip\n");
    const second = worktreeAt(f, join(workDir, "repo-two"), "two");
    commitIn(cloneAt(f, join(second, "a", "b", "c", "d", "e", "lib")));

    const report = await f.engine().run("periodic");

    expect(git(f.bare, ["for-each-ref", "refs/remi/snapshots"])).toBe("");
    expect(report.plan).toEqual([]);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(existsSync(join(worktree, "wip.txt"))).toBe(true);
  });
});

describe("directories laid out like a git directory, in a checkout that has nothing unsaved", () => {
  test("a bare repository the project commits as test data is part of the checkout: the clean Issue is reclaimed", async () => {
    const f = reclaimFixture();
    // Like the fixtures of Gitea and libgit2: a bare repository with a commit of its own and no remote, tracked by the project.
    const author = cloneAt(f, join(f.scratch, "author"));
    const fixture = join(author, "tests", "fixtures", "sample.git");
    git(f.scratch, ["clone", "--bare", localRepositoryAt(join(f.scratch, "sample-source")), fixture]);
    git(fixture, ["remote", "remove", "origin"]);
    // git tracks no empty directory: `refs/` only exists in a checkout when a loose ref is committed in it.
    writeFileSync(join(fixture, "refs", "heads", "main"), `${git(fixture, ["rev-parse", "HEAD"])}\n`);
    git(author, ["add", "-f", "tests"]);
    git(author, ["commit", "-m", "add the bare fixture"]);
    git(author, ["push", "origin", "HEAD:main"]);
    git(f.bare, ["fetch", "origin"]);
    const { subject, worktree, workDir } = endedIssue(f, 1);
    expect(git(worktree, ["ls-files", "tests/fixtures/sample.git/HEAD"])).not.toBe("");
    expect(git(worktree, ["status", "--porcelain"])).toBe("");

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test("an untracked folder of notes on git internals is saved with the checkout like any other files", async () => {
    const f = reclaimFixture();
    commitIn(f.worktree(issue(2), "agent/iss_2"), "elsewhere.txt");
    const { subject, worktree, workDir } = endedIssue(f, 1);
    const folder = join(worktree, "docs", "git-internals");
    mkdirSync(join(folder, "objects", "info"), { recursive: true });
    mkdirSync(join(folder, "refs", "heads"), { recursive: true });
    writeFileSync(join(folder, "HEAD"), "this file explains HEAD\n");
    writeFileSync(join(folder, "objects", "info", "README"), "x\n");
    writeFileSync(join(folder, "refs", "heads", "README"), "x\n");

    const report = await f.engine().run("periodic");

    // Not a repository of its own, so nobody judges the shared repository's other branches by it: the files are the checkout's.
    expect(existsSync(workDir)).toBe(false);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
    const [saved] = f.record(subject)!.snapshot!.git;
    expect(git(f.bare, ["show", `${saved!.commit}:docs/git-internals/HEAD`])).toBe("this file explains HEAD");
  });

  test("a folder of notes on git internals is just a folder, although git run inside it answers for the repository around it", async () => {
    const f = reclaimFixture();
    // Another Issue's branch in the shared repository that no remote has: `rev-list --all` from inside the folder would find it.
    commitIn(f.worktree(issue(2), "agent/iss_2"), "elsewhere.txt");
    const { subject, worktree, workDir } = endedIssue(f, 1);
    const folder = join(worktree, "docs", "git-internals");
    mkdirSync(join(folder, "objects", "info"), { recursive: true });
    mkdirSync(join(folder, "refs", "heads"), { recursive: true });
    writeFileSync(join(folder, "HEAD"), "this file explains HEAD\n");
    writeFileSync(join(folder, "objects", "info", "README"), "x\n");
    writeFileSync(join(folder, "refs", "heads", "README"), "x\n");
    git(worktree, ["add", "docs"]);
    git(worktree, ["commit", "-m", "docs"]);
    git(worktree, ["push", "origin", "HEAD:refs/heads/agent/iss_1"]);
    git(f.bare, ["fetch", "origin"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: null });
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });
});

describe("a daemon that inherited a repository from its environment", () => {
  test("still judges each tree by its own repository: an unpushed clone is not mistaken for the decoy's clean one", async () => {
    const f = reclaimFixture();
    const subject = chat(1);
    f.subject(subject);
    f.server.answer(subject.id, { status: "archived", pinned: false, origin: null, updated_at: new Date(f.now - 10 * DAY).toISOString() });
    const clone = cloneAt(f, join(workDirectory(f.root, subject), "clone"));
    const local = commitIn(clone);
    const decoy = cloneAt(f, join(f.scratch, "decoy"));
    const inherited = { GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy };
    Object.assign(process.env, inherited);
    let report;
    try {
      report = await f.engine().run("periodic");
    } finally {
      for (const name of Object.keys(inherited)) delete process.env[name];
    }

    expect(git(clone, ["rev-parse", "HEAD"])).toBe(local);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });
});
