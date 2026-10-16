/**
 * The output tail of a Claude background task (PR 6 §4.4): the last 4 KiB of
 * its `tasks/<id>.output` file, from a line start, only for a regular file of
 * that name, with the Linux private `/tmp` mapped, refreshed when it grew.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncTaskOutputTailer, isTaskOutputPath, readTaskOutputTail } from "@multiremi/worker/async-task-output.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function outputFile(taskId: string, content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "claude-pr6b-output-"));
  dirs.push(dir);
  mkdirSync(join(dir, "tasks"));
  const path = join(dir, "tasks", `${taskId}.output`);
  writeFileSync(path, content);
  return { dir, path };
}

describe("readTaskOutputTail", () => {
  it("reads a short output whole", () => {
    const { path } = outputFile("bash-1", "line 1\nline 2\n");
    expect(readTaskOutputTail(path, "bash-1")).toEqual({ tail: "line 1\nline 2\n", truncated: false, size: 14 });
  });

  it("keeps the last 4 KiB from a line start", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`).join("\n") + "\n";
    const { path } = outputFile("bash-1", lines);
    const read = readTaskOutputTail(path, "bash-1")!;
    expect(read.truncated).toBe(true);
    expect(Buffer.byteLength(read.tail!)).toBeLessThanOrEqual(4096);
    expect(read.tail!.startsWith("line ")).toBe(true);
    expect(read.tail!.endsWith("line 999\n")).toBe(true);
  });

  it("refuses another task's file, a non-output path, a directory and a symlink", () => {
    const { dir, path } = outputFile("bash-1", "x");
    expect(isTaskOutputPath(path, "bash-2")).toBe(false);
    expect(readTaskOutputTail(path, "bash-2")).toBeNull();
    expect(readTaskOutputTail(join(dir, "tasks"), "tasks")).toBeNull();
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "secret");
    const link = join(dir, "tasks", "bash-9.output");
    symlinkSync(secret, link);
    expect(readTaskOutputTail(link, "bash-9")).toBeNull();
    expect(readTaskOutputTail("relative/tasks/bash-1.output", "bash-1")).toBeNull();
  });

  it("maps /tmp to the lane's private temp dir on Linux", () => {
    const { dir } = outputFile("bash-1", "from the private tmp\n");
    expect(readTaskOutputTail("/tmp/tasks/bash-1.output", "bash-1", dir, "linux")).toMatchObject({ tail: "from the private tmp\n" });
  });
});

describe("AsyncTaskOutputTailer", () => {
  it("reports when the file grew, at most the configured number of tasks", async () => {
    const { path } = outputFile("bash-1", "a\n");
    const tailer = new AsyncTaskOutputTailer({ maxTasks: 1 });
    const tails: Array<string | null> = [];
    expect(tailer.watch("lane:bash-1", { path, taskId: "bash-1", intervalMs: 20, onTail: (tail) => tails.push(tail.tail) })).toBe(true);
    expect(tailer.watch("lane:bash-2", { path, taskId: "bash-1", intervalMs: 20, onTail: () => {} })).toBe(false);
    await Bun.sleep(60);
    expect(tails).toEqual(["a\n"]);
    appendFileSync(path, "b\n");
    await Bun.sleep(60);
    expect(tails).toEqual(["a\n", "a\nb\n"]);
    tailer.stop();
    expect(tailer.size).toBe(0);
  });
});
