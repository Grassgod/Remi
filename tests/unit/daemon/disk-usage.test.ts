import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISK_CATEGORIES,
  DISK_CATEGORY_TIMEOUT_MS,
  DISK_REFRESH_MS,
  DiskUsage,
  freeDiskBytes,
  freedBetween,
  measureBytes,
} from "@daemon/agent-runtime/workspace/disk-usage.js";
import { diskUsageFile, envRoot, sharedRoot, tracesRoot, workRoot } from "@daemon/agent-runtime/workspace/layout.js";

setDefaultTimeout(30_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "multiremi-disk-usage-")));
  roots.push(root);
  return root;
}

/** A clock the test moves by hand. */
function clock(start = Date.parse("2026-10-14T00:00:00Z")) {
  const state = { now: start };
  return { state, now: () => state.now };
}

/** Sizes every category by the number of its paths; records what was measured and with which signal. */
function recordingMeasure() {
  const calls: Array<{ paths: readonly string[]; signal: AbortSignal }> = [];
  return {
    calls,
    measure: async (paths: readonly string[], signal: AbortSignal) => {
      calls.push({ paths, signal });
      return 1000 + paths.length;
    },
  };
}

describe("DiskUsage", () => {
  test("measures the five categories in the background and caches them with their time", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "legacy-20261001"));
    mkdirSync(join(root, "legacy-20261002"));
    const time = clock();
    const recorder = recordingMeasure();
    const usage = new DiskUsage({ root, measure: recorder.measure, now: time.now });

    expect(usage.latest()).toBeNull();
    usage.refresh(false);
    await usage.settled();

    expect(recorder.calls.map((call) => call.paths)).toEqual([
      [workRoot(root)], [envRoot(root)], [tracesRoot(root)], [sharedRoot(root)],
      [join(root, "legacy-20261001"), join(root, "legacy-20261002")],
    ]);
    const expected = {
      measured_at: new Date(time.state.now).toISOString(),
      bytes: { work: 1001, env: 1001, traces: 1001, shared: 1001, legacy: 1002 },
    };
    expect(usage.latest()).toEqual(expected);
    expect(JSON.parse(readFileSync(diskUsageFile(root), "utf8"))).toEqual({ version: 1, ...expected });
    expect(diskUsageFile(root)).toBe(join(root, ".daemon", "disk-usage.json"));
  });

  test("starts and returns at once: the caller never waits for a measurement", async () => {
    const root = tempRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const usage = new DiskUsage({ root, measure: async () => { await gate; return 1; } });

    const started = performance.now();
    usage.refresh(false);

    expect(performance.now() - started).toBeLessThan(50);
    expect(usage.latest()).toBeNull();
    release();
    await usage.settled();
    expect(usage.latest()?.bytes).toEqual({ work: 1, env: 1, traces: 1, shared: 1, legacy: 1 });
  });

  test("never runs two measurements of one root at once, even from two instances", async () => {
    const root = tempRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recorder = recordingMeasure();
    const measure = async (paths: readonly string[], signal: AbortSignal) => { await gate; return recorder.measure(paths, signal); };
    const first = new DiskUsage({ root, measure });
    const second = new DiskUsage({ root, measure });

    first.refresh(true);
    second.refresh(true);
    first.refresh(true);
    release();
    await first.settled();

    expect(recorder.calls).toHaveLength(DISK_CATEGORIES.length);
  });

  test("measures at most hourly unless asked", async () => {
    const root = tempRoot();
    const time = clock();
    const recorder = recordingMeasure();
    const usage = new DiskUsage({ root, measure: recorder.measure, now: time.now });
    const measurements = () => recorder.calls.length / DISK_CATEGORIES.length;

    usage.refresh(false);
    await usage.settled();
    expect(measurements()).toBe(1);

    time.state.now += 59 * MINUTE;
    usage.refresh(false);
    await usage.settled();
    expect(measurements()).toBe(1);

    time.state.now += 2 * MINUTE;
    usage.refresh(false);
    await usage.settled();
    expect(measurements()).toBe(2);

    // An operator asking does not wait for the hour.
    usage.refresh(true);
    await usage.settled();
    expect(measurements()).toBe(3);
    expect(DISK_REFRESH_MS).toBe(HOUR);
  });

  test("a cached measurement from before a restart gates the next one", async () => {
    const root = tempRoot();
    const time = clock();
    mkdirSync(join(root, ".daemon"));
    const cached = {
      version: 1,
      measured_at: new Date(time.state.now - 10 * MINUTE).toISOString(),
      bytes: { work: 5, env: 4, traces: 3, shared: 2, legacy: 1 },
    };
    writeFileSync(diskUsageFile(root), JSON.stringify(cached));
    const recorder = recordingMeasure();
    const usage = new DiskUsage({ root, measure: recorder.measure, now: time.now });

    // The report of the first round after the restart already carries the old numbers.
    expect(usage.latest()).toEqual({ measured_at: cached.measured_at, bytes: cached.bytes });
    usage.refresh(false);
    await usage.settled();
    expect(recorder.calls).toEqual([]);

    time.state.now += 51 * MINUTE;
    usage.refresh(false);
    await usage.settled();
    expect(recorder.calls).toHaveLength(DISK_CATEGORIES.length);
  });

  test("a timed-out category drops the measurement and keeps the previous one", async () => {
    const root = tempRoot();
    const time = clock();
    const usage = new DiskUsage({ root, measure: recordingMeasure().measure, now: time.now, categoryTimeoutMs: 40 });
    usage.refresh(true);
    await usage.settled();
    const previous = usage.latest();
    expect(previous).not.toBeNull();

    // `traces` never finishes; `du` honours the signal like the real one.
    const seen: string[] = [];
    const slow = new DiskUsage({
      root,
      now: time.now,
      categoryTimeoutMs: 40,
      measure: (paths, signal) => new Promise<number>((resolve, reject) => {
        seen.push(paths[0] ?? "");
        if (!paths[0]?.endsWith("traces")) return resolve(7);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    time.state.now += 2 * HOUR;
    const started = Date.now();
    slow.refresh(false);
    await slow.settled();

    expect(Date.now() - started).toBeLessThan(5000);
    expect(seen.map((path) => path.split("/").at(-1))).toEqual(["work", "env", "traces"]);
    // No partial mix of two moments: the earlier measurement is still the latest one.
    expect(slow.latest()).toEqual(previous);
  });

  test("a failing measurement is logged, keeps the previous one and is not retried within the hour", async () => {
    const root = tempRoot();
    const time = clock();
    const good = new DiskUsage({ root, measure: recordingMeasure().measure, now: time.now });
    good.refresh(true);
    await good.settled();
    const previous = good.latest();

    let attempts = 0;
    const failing = new DiskUsage({ root, now: time.now, measure: async () => { attempts++; throw new Error("du exploded"); } });
    time.state.now += 2 * HOUR;
    failing.refresh(false);
    await failing.settled();
    expect(attempts).toBe(1);
    expect(failing.latest()).toEqual(previous);

    time.state.now += 30 * MINUTE;
    failing.refresh(false);
    await failing.settled();
    expect(attempts).toBe(1);

    time.state.now += 31 * MINUTE;
    failing.refresh(false);
    await failing.settled();
    expect(attempts).toBe(2);
  });

  test("stopping ends a running measurement and keeps the previous one", async () => {
    const root = tempRoot();
    const stop = new AbortController();
    const usage = new DiskUsage({
      root,
      stopSignal: () => stop.signal,
      measure: (_paths, signal) => new Promise<number>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });

    usage.refresh(false);
    await Bun.sleep(20);
    stop.abort();
    await usage.settled();

    expect(usage.latest()).toBeNull();
    expect(existsSync(diskUsageFile(root))).toBe(false);
  });

  test("lets a category take the 30 minutes it is given", async () => {
    const root = tempRoot();
    const recorder = recordingMeasure();
    const usage = new DiskUsage({ root, measure: recorder.measure });

    usage.refresh(false);
    await usage.settled();

    expect(DISK_CATEGORY_TIMEOUT_MS).toBe(30 * MINUTE);
    // One deadline per category, not one for the whole measurement.
    expect(new Set(recorder.calls.map((call) => call.signal)).size).toBe(DISK_CATEGORIES.length);
    expect(recorder.calls.every((call) => !call.signal.aborted)).toBe(true);
  });

  test("ignores a cache that is corrupt or incomplete", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".daemon"), { recursive: true });
    const usage = new DiskUsage({ root, measure: recordingMeasure().measure });
    for (const content of [
      "not json",
      "null",
      JSON.stringify({ version: 2, measured_at: "2026-10-14T00:00:00.000Z", bytes: {} }),
      JSON.stringify({ version: 1, measured_at: "yesterday", bytes: { work: 1, env: 1, traces: 1, shared: 1, legacy: 1 } }),
      JSON.stringify({ version: 1, measured_at: "2026-10-14T00:00:00.000Z", bytes: { work: 1, env: -1, traces: 1, shared: 1, legacy: 1 } }),
      JSON.stringify({ version: 1, measured_at: "2026-10-14T00:00:00.000Z", bytes: { work: 1, env: 1, traces: 1, shared: 1 } }),
    ]) {
      writeFileSync(diskUsageFile(root), content);
      expect(usage.latest()).toBeNull();
    }
  });

  test("does not write the cache once the root is no longer owned", async () => {
    const root = tempRoot();
    const usage = new DiskUsage({
      root,
      measure: recordingMeasure().measure,
      assertRootOwner: () => { throw new Error("workspace root identity changed"); },
    });

    usage.refresh(false);
    await usage.settled();

    expect(existsSync(diskUsageFile(root))).toBe(false);
  });
});

describe("measureBytes", () => {
  test("sizes real directories, counts a missing path as zero and sums several", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a", "blob"), Buffer.alloc(256 * 1024, 1));
    writeFileSync(join(root, "b", "blob"), Buffer.alloc(128 * 1024, 1));

    const a = await measureBytes([join(root, "a")]);
    const both = await measureBytes([join(root, "a"), join(root, "b"), join(root, "missing")]);

    expect(a).toBeGreaterThanOrEqual(256 * 1024);
    expect(both).toBeGreaterThanOrEqual(a + 128 * 1024);
    expect(await measureBytes([join(root, "missing")])).toBe(0);
  });

  test("runs du at the lowest priority, so measuring yields to everything else", async () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "nice.log");
    // Stands in for nice(1): records its arguments, then runs the command it was given.
    writeFileSync(join(bin, "nice"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nshift 2\nexec "$@"\n`);
    chmodSync(join(bin, "nice"), 0o755);
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "blob"), "x");
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    restores.push(() => { process.env.PATH = path; });

    await measureBytes([join(root, "data")]);

    expect(readFileSync(log, "utf8").trim()).toBe(`-n 19 du -sk ${join(root, "data")}`);
  });

  test("stops at once when its signal is aborted, also before it starts", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "data"));
    const controller = new AbortController();
    controller.abort(new Error("budget spent"));

    await expect(measureBytes([join(root, "data")], controller.signal)).rejects.toThrow("budget spent");
  });
});

describe("free space", () => {
  test("is read off the filesystem without walking anything, and is unknown for a path that is not there", async () => {
    const root = tempRoot();
    const free = await freeDiskBytes(root);

    expect(free).toBeGreaterThan(0);
    expect(await freeDiskBytes(join(root, "missing"))).toBeNull();
  });

  test("what a round freed is the space gained between two readings, never negative or guessed", () => {
    expect(freedBetween(100, 160)).toBe(60);
    expect(freedBetween(160, 100)).toBe(0);
    expect(freedBetween(null, 100)).toBe(0);
    expect(freedBetween(100, null)).toBe(0);
  });
});
