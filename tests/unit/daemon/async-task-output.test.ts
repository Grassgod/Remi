/**
 * The output tail of a Claude background task (PR 6 §4.4): the last 4 KiB of
 * its `tasks/<id>.output` file, from a line start, only for a regular file of
 * that name, with the Linux private `/tmp` mapped, refreshed when it grew.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncTaskOutputTailer, isTaskOutputPath, readTaskOutputTail, type OutputTail } from "@multiremi/worker/async-task-output.js";

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
    const read = readTaskOutputTail(path, "bash-1") as OutputTail & { size: number };
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
    // There, but never followed: unreadable, not absent.
    expect(readTaskOutputTail(link, "bash-9")).toEqual({ unreadable: true });
    mkdirSync(join(dir, "tasks", "bash-8.output"));
    expect(readTaskOutputTail(join(dir, "tasks", "bash-8.output"), "bash-8")).toEqual({ unreadable: true });
    expect(readTaskOutputTail(join(dir, "tasks", "bash-7.output"), "bash-7")).toBeNull();
    expect(readTaskOutputTail(join(dir, "nowhere", "tasks", "bash-7.output"), "bash-7")).toBeNull();
    expect(readTaskOutputTail("relative/tasks/bash-1.output", "bash-1")).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("reports a file it has no permission to read as unreadable", () => {
    const { path } = outputFile("bash-1", "private\n");
    chmodSync(path, 0o000);
    try {
      expect(readTaskOutputTail(path, "bash-1")).toEqual({ unreadable: true });
    } finally {
      chmodSync(path, 0o600);
    }
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

  it("reports an unreadable file once, its tail once readable again, and a null tail once it is gone", async () => {
    const { dir, path } = outputFile("bash-1", "a\n");
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "secret");
    rmSync(path);
    symlinkSync(secret, path);
    const tailer = new AsyncTaskOutputTailer();
    const tails: OutputTail[] = [];
    tailer.watch("lane:bash-1", { path, taskId: "bash-1", intervalMs: 20, onTail: (tail) => tails.push(tail) });
    await Bun.sleep(80);
    expect(tails).toEqual([{ tail: null, truncated: false, unreadable: true }]);
    rmSync(path);
    writeFileSync(path, "a\n");
    await Bun.sleep(60);
    expect(tails.at(-1)).toEqual({ tail: "a\n", truncated: false });
    rmSync(path);
    await Bun.sleep(60);
    // The same size again after a gap is reported again.
    writeFileSync(path, "b\n");
    await Bun.sleep(60);
    tailer.stop();
    expect(tails.slice(1)).toEqual([{ tail: "a\n", truncated: false }, { tail: null, truncated: false }, { tail: "b\n", truncated: false }]);
  });
});
