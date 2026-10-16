/**
 * The output tail of a Claude background task (PR 6 §4.4). claude-agent-acp
 * names each task's output file (`outputFilePath`, an absolute path ending in
 * `tasks/<asyncTaskId>.output`, dist/async-tasks.js:735-782) and sends no
 * output text, so the daemon reads the file's end itself: it stats the file
 * every few seconds and, when it grew, reads the last 4 KiB from a line start
 * with positioned reads. Codex sends no output file; nothing is tailed for it.
 *
 * Bounded: at most {@link MAX_TAILED_TASKS} tasks per daemon. Only a regular
 * file whose path ends in `/tasks/<asyncTaskId>.output` is read. On Linux the
 * bridge sees a private `/tmp` (`@acp/private-tmp`), so a path under `/tmp/`
 * maps to the lane's private temp directory. A file that cannot be read gives
 * a null tail.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { constants } from "node:fs";
import { mapPrivateTmpPath } from "@acp/index.js";
import { TRACE_BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES } from "@multiremi/contracts/trace.js";
import { outputTailFromBytes } from "@shared/trace-sanitize.js";

/** Tasks tailed at once, per daemon. */
export const MAX_TAILED_TASKS = 8;
/** How often a tail is refreshed while an attempt runs, and while the lane is parked. */
export const OUTPUT_TAIL_ATTEMPT_MS = 5_000;
export const OUTPUT_TAIL_PARKED_MS = 10_000;

export interface OutputTail {
  tail: string | null;
  truncated: boolean;
}

/** Whether `path` is a task output file of `taskId` (the bridge's own naming). */
export function isTaskOutputPath(path: string, taskId: string): boolean {
  if (!path.startsWith("/") || !taskId || taskId.includes("/")) return false;
  return path.endsWith(`/tasks/${taskId}.output`);
}

/**
 * The last {@link TRACE_BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES} of a task's
 * output file, from a line start; null when it is not a readable regular
 * output file of `taskId`. `size` is the file size the tail was read at.
 */
export function readTaskOutputTail(path: string, taskId: string, privateTmpDirectory?: string | null,
  platform: NodeJS.Platform = process.platform): (OutputTail & { size: number }) | null {
  if (!isTaskOutputPath(path, taskId)) return null;
  const local = mapPrivateTmpPath(path, privateTmpDirectory ?? undefined, platform);
  let fd: number | null = null;
  try {
    // No symlink is followed: the bridge writes the file itself.
    if (!lstatSync(local).isFile()) return null;
    fd = openSync(local, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const max = TRACE_BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES;
    // One byte more than the cap tells whether the tail was cut.
    const length = Math.min(stat.size, max + 1);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, stat.size - length + read);
      if (n <= 0) break;
      read += n;
    }
    const tail = outputTailFromBytes(buffer.subarray(0, read), max);
    return { tail: tail.value, truncated: tail.truncated || stat.size > read, size: stat.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

interface Watch {
  path: string;
  taskId: string;
  privateTmpDirectory: string | null;
  intervalMs: number;
  onTail: (tail: OutputTail) => void;
  timer: ReturnType<typeof setTimeout> | null;
  lastSize: number | null;
  unreadable: boolean;
}

/** Tails up to {@link MAX_TAILED_TASKS} task output files, each on its own cadence. */
export class AsyncTaskOutputTailer {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly options: { maxTasks?: number; platform?: NodeJS.Platform } = {}) {}

  /**
   * Watch one task's output (key: lane and task). A watch already held keeps
   * its last size and changes cadence; false when the daemon already tails
   * the most it may, or the path is not a task output file.
   */
  watch(key: string, input: { path: string; taskId: string; privateTmpDirectory?: string | null; intervalMs: number;
    onTail: (tail: OutputTail) => void }): boolean {
    if (!isTaskOutputPath(input.path, input.taskId)) return false;
    const existing = this.watches.get(key);
    if (existing) {
      existing.onTail = input.onTail;
      if (existing.intervalMs !== input.intervalMs) {
        existing.intervalMs = input.intervalMs;
        this.schedule(key, existing, 0);
      }
      return true;
    }
    if (this.watches.size >= (this.options.maxTasks ?? MAX_TAILED_TASKS)) return false;
    const watch: Watch = { path: input.path, taskId: input.taskId, privateTmpDirectory: input.privateTmpDirectory ?? null,
      intervalMs: input.intervalMs, onTail: input.onTail, timer: null, lastSize: null, unreadable: false };
    this.watches.set(key, watch);
    this.schedule(key, watch, 0);
    return true;
  }

  /** Read once more now (a task ended), then stop watching it. */
  finish(key: string): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    this.poll(watch);
    this.unwatch(key);
  }

  unwatch(key: string): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    if (watch.timer) clearTimeout(watch.timer);
    this.watches.delete(key);
  }

  get size(): number {
    return this.watches.size;
  }

  stop(): void {
    for (const key of [...this.watches.keys()]) this.unwatch(key);
  }

  private schedule(key: string, watch: Watch, delayMs: number): void {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = null;
      if (this.watches.get(key) !== watch) return;
      this.poll(watch);
      if (this.watches.get(key) === watch) this.schedule(key, watch, watch.intervalMs);
    }, delayMs);
    (watch.timer as { unref?: () => void }).unref?.();
  }

  private poll(watch: Watch): void {
    const read = readTaskOutputTail(watch.path, watch.taskId, watch.privateTmpDirectory, this.options.platform);
    if (!read) {
      // Reported once: a null tail until the file can be read.
      if (!watch.unreadable && watch.lastSize !== null) watch.onTail({ tail: null, truncated: false });
      watch.unreadable = true;
      return;
    }
    watch.unreadable = false;
    if (read.size === watch.lastSize) return;
    watch.lastSize = read.size;
    try {
      watch.onTail({ tail: read.tail, truncated: read.truncated });
    } catch {
      // A failing listener never stops the tail.
    }
  }
}
