// The task context file (PR 6 §2.4): the daemon writes the current attempt's
// token for a lane whose process outlives attempts; readers prefer it to the env.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LaneTaskContextFile } from "@multiremi/worker/lane-task-context.js";
import { readTaskContextFile, resolveTaskContext, TASK_CONTEXT_FILE_ENV } from "@shared/task-context-file.js";

const directories: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-pr6b-context-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SPAWN = { MULTIREMI_TOKEN: "spawn-token", MULTIREMI_TURN_ID: "turn_spawn", MULTIREMI_ATTEMPT_ID: "att_spawn" };

describe("lane task context file", () => {
  it("lives in a 0700 directory of the lane's private temp, as a 0600 file replaced whole on each write", () => {
    const privateTmp = scratch();
    const file = LaneTaskContextFile.create(privateTmp, "darwin");
    expect(dirname(dirname(file.hostPath))).toBe(privateTmp);
    expect(file.visiblePath).toBe(file.hostPath);
    expect(statSync(dirname(file.hostPath)).mode & 0o777).toBe(0o700);
    file.write({ token: "token-1", turnId: "turn_1", attemptId: "att_1" });
    expect(statSync(file.hostPath).mode & 0o777).toBe(0o600);
    expect(readTaskContextFile(file.hostPath)).toMatchObject({ token: "token-1", turn_id: "turn_1", attempt_id: "att_1" });
    file.write({ token: "token-2", turnId: "turn_2", attemptId: "att_2" });
    expect(readTaskContextFile(file.hostPath)).toMatchObject({ token: "token-2", attempt_id: "att_2", written_at: expect.any(String) });
    // Temp files are renamed into place, never left behind.
    expect(readdirSync(dirname(file.hostPath))).toEqual(["context.json"]);
    file.write({ token: null, turnId: null, attemptId: null });
    expect(readTaskContextFile(file.hostPath)).toMatchObject({ token: null, turn_id: null, attempt_id: null });
  });

  it("on Linux the agent reads it under its private /tmp, by a name no host /tmp path has", () => {
    const privateTmp = scratch();
    const one = LaneTaskContextFile.create(privateTmp, "linux");
    const two = LaneTaskContextFile.create(privateTmp, "linux");
    const name = basename(dirname(one.hostPath));
    expect(one.visiblePath).toBe(`/tmp/${name}/context.json`);
    expect(name).toMatch(/^\.remi-task-[0-9a-f]{16}$/);
    expect(two.visiblePath).not.toBe(one.visiblePath);
  });

  it("refuses to write through a directory the agent replaced with a link", () => {
    const privateTmp = scratch();
    const elsewhere = scratch();
    const file = LaneTaskContextFile.create(privateTmp, "darwin");
    const directory = dirname(file.hostPath);
    renameSync(directory, join(privateTmp, "moved"));
    symlinkSync(elsewhere, directory);
    expect(() => file.write({ token: "token-1", turnId: "turn_1", attemptId: "att_1" })).toThrow("not a real directory");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("resolveTaskContext", () => {
  it("prefers a readable context file to the spawn env", () => {
    const file = LaneTaskContextFile.create(scratch(), "darwin");
    file.write({ token: "current-token", turnId: "turn_now", attemptId: "att_now" });
    expect(resolveTaskContext({ ...SPAWN, [TASK_CONTEXT_FILE_ENV]: file.hostPath })).toEqual({
      token: "current-token", turnId: "turn_now", attemptId: "att_now", source: "file", parked: false });
  });

  it("reports a parked lane when the file has no token", () => {
    const file = LaneTaskContextFile.create(scratch(), "darwin");
    file.write({ token: null, turnId: null, attemptId: null });
    expect(resolveTaskContext({ ...SPAWN, [TASK_CONTEXT_FILE_ENV]: file.hostPath })).toMatchObject({ token: null, source: "file", parked: true });
  });

  it("falls back to the env without the variable, or when the file is missing or malformed (an Issue lane, as before)", () => {
    const directory = scratch();
    const fromEnv = { token: "spawn-token", turnId: "turn_spawn", attemptId: "att_spawn", source: "env" as const, parked: false };
    expect(resolveTaskContext(SPAWN)).toEqual(fromEnv);
    expect(resolveTaskContext({ ...SPAWN, [TASK_CONTEXT_FILE_ENV]: join(directory, "missing.json") })).toEqual(fromEnv);
    const malformed = join(directory, "malformed.json");
    writeFileSync(malformed, "{not json");
    expect(resolveTaskContext({ ...SPAWN, [TASK_CONTEXT_FILE_ENV]: malformed })).toEqual(fromEnv);
    writeFileSync(malformed, JSON.stringify({ token: 42 }));
    expect(resolveTaskContext({ ...SPAWN, [TASK_CONTEXT_FILE_ENV]: malformed })).toEqual(fromEnv);
    mkdirSync(join(directory, "a-directory"));
    expect(resolveTaskContext({ ...SPAWN, [TASK_CONTEXT_FILE_ENV]: join(directory, "a-directory") })).toEqual(fromEnv);
    expect(resolveTaskContext({})).toEqual({ token: null, turnId: null, attemptId: null, source: "env", parked: false });
  });
});
