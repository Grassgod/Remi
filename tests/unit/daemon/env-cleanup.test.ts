import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import {
  cleanLaneGeneration,
  cleanSubjectEnvironment,
  generationModifiedAt,
  isKeptHistory,
  isProviderState,
  listLaneGenerations,
  supersededGenerations,
} from "@daemon/agent-runtime/workspace/env-cleanup.js";
import { envDirectory, laneGenerationDirectory, rootRelative, workDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import { restoreReclaimedSubject } from "@daemon/agent-runtime/workspace/restore.js";
import {
  HOUR, REPO_DIR, ageLane, cleanupFixtures, cloneAt, commitIn, git, issueEnded, localRepositoryAt, reclaimFixture, worktreeAt, type ReclaimFixture,
} from "./reclaim-fixture.js";

// Each case builds real repositories; a busy CI host needs more than the 5 s default.
setDefaultTimeout(30_000);
afterEach(cleanupFixtures);

const issue = (n: number): StorageSubjectRef => ({ kind: "issue", id: `iss_${n}` });

/** An ended Issue with a worktree, one provider lane generation and the given edit. */
function endedIssue(f: ReclaimFixture, n: number) {
  const subject = issue(n);
  f.subject(subject);
  const worktree = f.worktree(subject);
  const lane = f.lane(subject, 1);
  f.server.answer(subject.id, issueEnded());
  return { subject, worktree, lane, workDir: workDirectory(f.root, subject) };
}

describe("cleaning a lane generation", () => {
  test("keeps the native session history where it is and removes everything else", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const lane = f.lane(subject, 1);
    mkdirSync(join(lane, "home", "sessions"), { recursive: true });
    writeFileSync(join(lane, "home", "sessions", "rollout.jsonl"), "{}\n");
    writeFileSync(join(lane, "meta.json"), "{}");

    const removed = await cleanLaneGeneration(lane, { root: f.root });

    expect(readdirSync(lane)).toEqual(["home"]);
    expect(readdirSync(join(lane, "home")).sort()).toEqual(["projects", "session_index.jsonl", "sessions"]);
    expect(readFileSync(join(lane, "home", "projects", "-work", "session.jsonl"), "utf8")).toBe("{}\n");
    // plugins/, settings.json, .remi-runtime/, work/, meta.json
    expect(removed).toBe(5);
    expect(await cleanLaneGeneration(lane, { root: f.root })).toBe(0);
  });

  test("keeps the history of every execution home too, and nothing else under executions/", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const lane = f.lane(subject, 1);
    const execution = join(lane, "executions", "abc123");
    mkdirSync(join(execution, "home", "projects"), { recursive: true });
    mkdirSync(join(execution, "home", "plugins"), { recursive: true });
    mkdirSync(join(execution, "scratch"), { recursive: true });
    writeFileSync(join(execution, "home", "projects", "session.jsonl"), "{}\n");

    await cleanLaneGeneration(lane, { root: f.root });

    expect(readdirSync(execution)).toEqual(["home"]);
    expect(readdirSync(join(execution, "home"))).toEqual(["projects"]);
  });

  test("removes a link as a link and never follows it", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const lane = f.lane(subject, 1);
    const outside = join(f.scratch, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "precious");
    symlinkSync(outside, join(lane, "work", "link"), "dir");
    symlinkSync(join(outside, "precious.txt"), join(lane, "home", "linked-file"));

    await cleanLaneGeneration(lane, { root: f.root });

    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("precious");
    expect(existsSync(join(lane, "work"))).toBe(false);
    expect(existsSync(join(lane, "home", "linked-file"))).toBe(false);
  });

  test("a generation outside the owned root is refused", async () => {
    const f = reclaimFixture();
    const stray = join(f.scratch, "stray");
    mkdirSync(join(stray, "work"), { recursive: true });
    writeFileSync(join(stray, "keep.txt"), "x");

    await expect(cleanLaneGeneration(stray, { root: f.root })).rejects.toThrow();
    expect(existsSync(join(stray, "keep.txt"))).toBe(true);
  });
});

describe("the environment of a subject", () => {
  /** Lanes of one subject: the main lane of two agents and a delegated one, with a few generations each. */
  function lanes(f: ReclaimFixture, subject: StorageSubjectRef) {
    const make = (conversation: string, agentId: string, scope: string | null, generation: number) => {
      const directory = laneGenerationDirectory(f.root, { subject, conversation, agentId, scope, generation });
      mkdirSync(join(directory, "home", "plugins"), { recursive: true });
      mkdirSync(join(directory, "work"), { recursive: true });
      return directory;
    };
    return {
      mainOne: make("ises_1", "agt_1", null, 1),
      mainTwo: make("ises_1", "agt_1", null, 2),
      mainThree: make("ises_1", "agt_1", null, 3),
      other: make("ises_1", "agt_2", null, 1),
      delegated: make("ises_1", "agt_1", "dlg_9", 4),
    };
  }

  test("lists numbered generations of every lane, and nothing else", () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const made = lanes(f, subject);
    mkdirSync(join(made.mainOne, "..", "not-a-generation"), { recursive: true });
    mkdirSync(join(made.mainOne, "..", "07"), { recursive: true });
    mkdirSync(join(envDirectory(f.root, subject), "tmp", "tsk_1-abc123", "1"), { recursive: true });

    expect(listLaneGenerations(f.root, subject).map((generation) => generation.path).sort()).toEqual(
      [made.mainOne, made.mainTwo, made.mainThree, made.other, made.delegated].sort(),
    );
  });

  test("a generation is superseded by a higher one of the same lane only", () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const made = lanes(f, subject);

    expect(supersededGenerations(f.root, subject).map((generation) => generation.path).sort()).toEqual([made.mainOne, made.mainTwo].sort());
  });

  test("a generation is as old as the newest change to it or to its direct children", () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const lane = f.lane(subject, 1, { ageMs: 100 * HOUR });
    const old = f.now - 100 * HOUR;
    expect(Math.abs(generationModifiedAt(lane) - old)).toBeLessThan(2000);

    const touched = new Date(f.now - HOUR);
    utimesSync(join(lane, "work"), touched, touched);
    expect(Math.abs(generationModifiedAt(lane) - touched.getTime())).toBeLessThan(2000);
  });

  test("cleans every generation of every lane and the execution temp directories, keeping all history", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject);
    const made = lanes(f, subject);
    for (const directory of Object.values(made)) {
      mkdirSync(join(directory, "home", "projects"), { recursive: true });
      writeFileSync(join(directory, "home", "projects", "session.jsonl"), "{}\n");
    }
    mkdirSync(join(envDirectory(f.root, subject), "tmp", "tsk_1-abc123"), { recursive: true });

    await cleanSubjectEnvironment(subject, { root: f.root });

    for (const directory of Object.values(made)) {
      expect(readdirSync(directory)).toEqual(["home"]);
      expect(readdirSync(join(directory, "home"))).toEqual(["projects"]);
    }
    expect(existsSync(join(envDirectory(f.root, subject), "tmp"))).toBe(false);
  });
});

describe("the work sets of lane generations", () => {
  test("a standalone clone with unsaved work in a lane's work directory keeps the subject and its lane whole", async () => {
    const f = reclaimFixture();
    const { subject, lane, workDir } = endedIssue(f, 1);
    const clone = cloneAt(f, join(lane, "work", "clone"));
    const local = commitIn(clone);

    const report = await f.engine().run("periodic");

    expect(git(clone, ["rev-parse", "HEAD"])).toBe(local);
    expect(existsSync(workDir)).toBe(true);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(true);
    expect(existsSync(join(lane, "home", "plugins"))).toBe(true);
    expect(f.record(subject)!.state).toBe("active");
    expect(f.server.reclaimed).toEqual([]);
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(join(lane, "work", "clone")) }]);
  });

  test("a clean standalone clone in a lane's work directory goes with the environment", async () => {
    const f = reclaimFixture();
    const { subject, lane, workDir } = endedIssue(f, 1);
    cloneAt(f, join(lane, "work", "clone"));

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(existsSync(join(lane, "work"))).toBe(false);
    expect(f.record(subject)!.state).toBe("reclaimed");
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test("a linked worktree with unsaved work in a lane's work directory is saved, recorded by its place below the root", async () => {
    const f = reclaimFixture();
    const { subject, lane, workDir } = endedIssue(f, 1);
    const experiment = worktreeAt(f, join(lane, "work", "experiment"), "lane-experiment");
    writeFileSync(join(experiment, "idea.txt"), "idea\n");

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(existsSync(join(lane, "work"))).toBe(false);
    const [entry] = f.record(subject)!.snapshot!.git;
    expect(f.record(subject)!.snapshot!.git).toHaveLength(1);
    expect(entry).toMatchObject({ branch: "lane-experiment", dir: rootRelative(f.root, join(lane, "work", "experiment")) });
    expect(entry!.dir.startsWith("env/")).toBe(true);
    expect(git(f.bare, ["show", `${entry!.commit}:idea.txt`])).toBe("idea");
    expect(git(f.bare, ["worktree", "list", "--porcelain"])).not.toContain(experiment);
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });

    // Nothing of a lane's work set can be mistaken for a checkout of the subject: reopening restores none of it.
    mkdirSync(workDir, { recursive: true });
    git(f.bare, ["worktree", "add", join(workDir, REPO_DIR), "agent/iss_1"]);
    await restoreReclaimedSubject({ root: f.root, subject, wiki: false });
    expect(existsSync(join(workDir, REPO_DIR, "idea.txt"))).toBe(false);
  });

  test("a discussion's read-only worktree at the Issue branch's tip is rebuilt, not saved", async () => {
    const f = reclaimFixture();
    const { subject, worktree, lane } = endedIssue(f, 1);
    const tip = commitIn(worktree);
    git(f.bare, ["worktree", "add", "--detach", join(lane, "work", REPO_DIR), tip]);

    const report = await f.engine().run("periodic");

    expect(report.errors).toEqual([]);
    expect(f.record(subject)!.snapshot!.git.map((entry) => entry.dir)).toEqual([REPO_DIR]);
    expect(git(f.bare, ["for-each-ref", "--format=%(refname)", "refs/remi/snapshots"])).toBe("refs/remi/snapshots/iss_1/1");
  });

  test("a superseded generation that holds a standalone clone's unsaved work is kept and reported; the others are cleaned", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const kept = f.lane(subject, 1, { ageMs: 100 * HOUR });
    const clean = f.lane(subject, 2, { ageMs: 100 * HOUR });
    const current = f.lane(subject, 3);
    const clone = cloneAt(f, join(kept, "work", "clone"));
    commitIn(clone);
    ageLane(f, kept, 100 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(join(clone, "local.txt"))).toBe(true);
    expect(existsSync(join(kept, ".remi-runtime"))).toBe(true);
    expect(existsSync(join(clean, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(current, ".remi-runtime"))).toBe(true);
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(join(kept, "work", "clone")) }]);
  });

  test("a superseded generation's linked worktree with unsaved work is saved, and the record names the ref", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    f.lane(subject, 2);
    const experiment = worktreeAt(f, join(stale, "work", "experiment"), "lane-experiment");
    writeFileSync(join(experiment, "idea.txt"), "idea\n");
    ageLane(f, stale, 100 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(join(stale, "work"))).toBe(false);
    expect(existsSync(join(stale, ".remi-runtime"))).toBe(false);
    expect(report.errors).toEqual([]);
    const saved = f.record(subject)!.snapshot!;
    expect(saved.git).toEqual([expect.objectContaining({ branch: "lane-experiment", dir: rootRelative(f.root, experiment), ref: "refs/remi/snapshots/iss_1/1" })]);
    expect(git(f.bare, ["show", `${saved.git[0]!.commit}:idea.txt`])).toBe("idea");
    expect(f.record(subject)!.state).toBe("active");
  });

  test("what the engine saved from lanes survives the subject's own reclaim", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: 100 * HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    f.lane(subject, 2);
    writeFileSync(join(worktreeAt(f, join(stale, "work", "experiment"), "lane-experiment"), "idea.txt"), "idea\n");
    ageLane(f, stale, 100 * HOUR);
    await f.engine().run("periodic");
    const saved = f.record(subject)!.snapshot!.git;
    expect(saved).toHaveLength(1);

    // The Issue ends later; its own workspace is reclaimed with what the lane left on the record.
    f.server.answer(subject.id, issueEnded());
    f.worktree(subject);
    await f.engine().run("periodic");

    expect(f.record(subject)).toMatchObject({ state: "reclaimed", snapshot: { git: saved } });
  });
});

describe("the native session history", () => {
  test("is exactly what cleanup keeps, in the home of the generation and in the home of an execution", () => {
    expect([
      ["home", "projects"],
      ["home", "sessions"],
      ["home", "session_index.jsonl"],
      ["executions", "abc123", "home", "projects"],
      ["executions", "abc123", "home", "sessions"],
    ].map((parts) => isKeptHistory(parts))).toEqual([true, true, true, true, true]);
    expect([
      ["home"],
      ["home", "plugins"],
      ["home", "projects", "-work"],
      ["work", "projects"],
      [".remi-runtime", "projects"],
      ["executions", "abc123", "plugins"],
      ["executions", "abc123", "home", "plugins"],
    ].map((parts) => isKeptHistory(parts))).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("the provider's own state", () => {
  const STATE = [".tmp", "tmp", "plugins", "vendor_imports", "skills", "cache", ".cache", "memories", "memories_v2"];
  const HOMES = [["home"], ["executions", "abc123", "home"]];

  test("is what a provider keeps for itself directly in its home, in the home of the generation and in the home of an execution", () => {
    expect(HOMES.flatMap((home) => STATE.map((name) => isProviderState([...home, name])))).toEqual(Array(HOMES.length * STATE.length).fill(true));
    expect([
      ["home"],
      ["home", "projects"],
      ["home", "scratch"],
      // Only the direct entries of a home: the search never gets below them to ask.
      ["home", "scratch", ".tmp"],
      ["home", ".tmp", "plugins"],
      ["work", ".tmp"],
      [".remi-runtime", "plugins"],
      ["executions", "abc123", ".tmp"],
      ["executions", "abc123", "plugins"],
      ["executions", "abc123", "scratch", "plugins"],
    ].map((parts) => isProviderState(parts))).toEqual(Array(10).fill(false));
  });

  /** An ended Issue whose lane has a repository with one commit and no remote at `below`, inside the generation. */
  function endedWithLocalRepository(f: ReclaimFixture, below: string[]) {
    const { subject, lane, workDir } = endedIssue(f, 1);
    return { subject, lane, workDir, repository: localRepositoryAt(join(lane, ...below)) };
  }

  // The post-A5 verification: Codex clones its curated plugins into `$CODEX_HOME/.tmp/plugins` whenever it starts, and
  // `CODEX_HOME` is the home of the execution. Every Codex subject was kept forever as a standalone clone with unsaved work.
  test.each([
    ["the home of the generation", ["home", ".tmp", "plugins"]],
    ["the home of an execution", ["executions", "abc123", "home", ".tmp", "plugins"]],
  ])("the repository Codex keeps in %s does not keep an ended subject: it is reclaimed with the rest of the home", async (_name, below) => {
    const f = reclaimFixture();
    const { subject, lane, workDir, repository } = endedWithLocalRepository(f, below);

    const report = await f.engine().run("periodic");

    expect(f.record(subject)!.state).toBe("reclaimed");
    expect(existsSync(workDir)).toBe(false);
    expect(existsSync(repository)).toBe(false);
    expect(existsSync(join(lane, "home", ".tmp"))).toBe(false);
    expect(existsSync(join(lane, "home", "projects", "-work", "session.jsonl"))).toBe(true);
    expect(f.server.reclaimed).toEqual([expect.objectContaining({ subject, unsaved_work: false })]);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test.each(HOMES.flatMap((home) => STATE.map((name) => [`${home.join("/")}/${name}`, [...home, name, "repo"]] as const)))(
    "a repository with no remote in %s is not looked through",
    async (_name, below) => {
      const f = reclaimFixture();
      const { subject, repository } = endedWithLocalRepository(f, [...below]);

      const report = await f.engine().run("periodic");

      expect(f.record(subject)!.state).toBe("reclaimed");
      expect(existsSync(repository)).toBe(false);
      expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
    },
  );

  test("a superseded generation that holds it is cleaned, not kept", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    f.lane(subject, 2);
    const plugins = localRepositoryAt(join(stale, "executions", "abc123", "home", ".tmp", "plugins"));
    ageLane(f, stale, 100 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(plugins)).toBe(false);
    expect(existsSync(join(stale, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(stale, "executions", "abc123", "home", ".tmp"))).toBe(false);
    expect(report.errors).toEqual([]);
  });

  // The skip is the provider's state in its home, nothing wider: an agent's repository anywhere else still counts.
  test.each([
    ["below a directory of the home that is not the provider's", ["home", "scratch", ".tmp", "plugins"]],
    ["in the private work directory", ["work", ".tmp", "plugins"]],
    ["in the plugin runtime", [".remi-runtime", "plugins", "repo"]],
    ["beside the home of an execution", ["executions", "abc123", "plugins", "repo"]],
  ])("a repository with no remote %s still keeps the subject", async (_name, below) => {
    const f = reclaimFixture();
    const { subject, workDir, repository } = endedWithLocalRepository(f, below);

    const report = await f.engine().run("periodic");

    expect(existsSync(repository)).toBe(true);
    expect(existsSync(workDir)).toBe(true);
    expect(f.record(subject)!.state).toBe("active");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(repository) }]);
  });
});

describe("the whole lane generation is looked through, not only its work directory", () => {
  /** An ended Issue with one generation, and a clone placed `below` that generation. */
  function endedWithClone(f: ReclaimFixture, below: string[]) {
    const { subject, lane, workDir } = endedIssue(f, 1);
    const clone = cloneAt(f, join(lane, ...below));
    return { subject, lane, workDir, clone, local: commitIn(clone) };
  }

  test.each([
    ["the provider home", ["home", "scratch", "clone"]],
    ["the plugin runtime", [".remi-runtime", "executions", "tsk_1", "clone"]],
    ["the home of an execution", ["executions", "abc123", "home", "scratch", "clone"]],
  ])("an unpushed clone in %s keeps the subject and its generation whole", async (_name, below) => {
    const f = reclaimFixture();
    const { subject, lane, workDir, clone, local } = endedWithClone(f, below);

    const report = await f.engine().run("periodic");

    expect(git(clone, ["rev-parse", "HEAD"])).toBe(local);
    expect(existsSync(workDir)).toBe(true);
    expect(existsSync(join(lane, ".remi-runtime"))).toBe(true);
    expect(f.record(subject)!.state).toBe("active");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(clone) }]);
  });

  test("a superseded generation whose provider home holds an unpushed clone is kept and reported; the others are cleaned", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const kept = f.lane(subject, 1, { ageMs: 100 * HOUR });
    const clean = f.lane(subject, 2, { ageMs: 100 * HOUR });
    const current = f.lane(subject, 3);
    const clone = cloneAt(f, join(kept, "home", "scratch-clone"));
    commitIn(clone);
    ageLane(f, kept, 100 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(join(clone, "local.txt"))).toBe(true);
    expect(existsSync(join(kept, ".remi-runtime"))).toBe(true);
    expect(existsSync(join(clean, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(current, ".remi-runtime"))).toBe(true);
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(clone) }]);
  });

  test("a clean clone in the provider home goes with it, and so does a linked worktree whose unsaved work is saved", async () => {
    const f = reclaimFixture();
    const { subject, lane, workDir } = endedIssue(f, 1);
    cloneAt(f, join(lane, "home", "scratch", "clone"));
    const experiment = worktreeAt(f, join(lane, "home", "worktrees", "experiment"), "home-experiment");
    writeFileSync(join(experiment, "idea.txt"), "idea\n");

    const report = await f.engine().run("periodic");

    expect(existsSync(workDir)).toBe(false);
    expect(existsSync(join(lane, "home", "scratch"))).toBe(false);
    expect(existsSync(join(lane, "home", "projects"))).toBe(true);
    const [entry] = f.record(subject)!.snapshot!.git;
    expect(entry).toMatchObject({ branch: "home-experiment", dir: rootRelative(f.root, join(lane, "home", "worktrees", "experiment")) });
    expect(git(f.bare, ["show", `${entry!.commit}:idea.txt`])).toBe("idea");
    expect(report).toMatchObject({ reclaimed_this_round: 1, errors: [] });
  });

  test("the native session history is kept where it is and not looked through: a clone in it does not hold anything back", async () => {
    const f = reclaimFixture();
    const { subject, lane } = endedIssue(f, 1);
    const clone = cloneAt(f, join(lane, "home", "projects", "-work", "clone"));
    commitIn(clone);
    const execution = cloneAt(f, join(lane, "executions", "abc123", "home", "sessions", "clone"));
    commitIn(execution);

    const report = await f.engine().run("periodic");

    expect(f.record(subject)!.state).toBe("reclaimed");
    expect(existsSync(join(clone, "local.txt"))).toBe(true);
    expect(existsSync(join(execution, "local.txt"))).toBe(true);
    expect(report).toMatchObject({ reclaimed_this_round: 1, retained: {}, errors: [] });
  });

  test("the work directory is searched as deep as ever, six levels below it", async () => {
    const f = reclaimFixture();
    const subject = issue(1);
    f.subject(subject, { usedAgoMs: HOUR });
    f.server.answer(subject.id, { status: "in_progress" });
    const stale = f.lane(subject, 1, { ageMs: 100 * HOUR });
    f.lane(subject, 2);
    const clone = cloneAt(f, join(stale, "work", "a", "b", "c", "d", "e", "clone"));
    commitIn(clone);
    ageLane(f, stale, 100 * HOUR);

    const report = await f.engine().run("periodic");

    expect(existsSync(join(clone, "local.txt"))).toBe(true);
    expect(report.errors).toEqual([{ subject_id: subject.id, message: expect.stringContaining(clone) }]);
  });

  test("a clone of an ended subject's lane whose remote is in the same lane has no remote that outlives it", async () => {
    const f = reclaimFixture();
    const { subject, lane } = endedIssue(f, 1);
    const store = join(lane, "home", "store.git");
    git(lane, ["init", "--bare", "--initial-branch=main", store]);
    const project = join(lane, "work", "project");
    git(lane, ["clone", store, project]);
    git(project, ["checkout", "-b", "main"]);
    commitIn(project);
    git(project, ["push", "origin", "main"]);

    const report = await f.engine().run("periodic");

    expect(existsSync(project)).toBe(true);
    expect(f.record(subject)!.state).toBe("active");
    expect(report.retained).toEqual({ snapshot_failed: 1 });
  });
});
