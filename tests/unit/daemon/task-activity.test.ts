// `task.activity` reporter (PR 5 §3.8, §4.4): debounced, refreshed while above
// 0, resent on reconnect, and cleared to 0 when the attempt ends.
import { describe, expect, it } from "bun:test";
import { TaskActivityReporter } from "@multiremi/worker/task-activity.js";

describe("TaskActivityReporter", () => {
  it("debounces changes and sends the latest count once", async () => {
    const sent: number[] = [];
    const reporter = new TaskActivityReporter((n) => sent.push(n), { debounceMs: 40, refreshMs: 10_000 });
    reporter.update(1);
    reporter.update(2);
    reporter.update(1);
    expect(sent).toEqual([]);
    await Bun.sleep(80);
    expect(sent).toEqual([1]);
    reporter.finish();
    expect(sent).toEqual([1, 0]);
  });

  it("refreshes while above 0 and stops at 0", async () => {
    const sent: number[] = [];
    const reporter = new TaskActivityReporter((n) => sent.push(n), { debounceMs: 5, refreshMs: 30 });
    reporter.update(2);
    await Bun.sleep(100);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sent)).toEqual(new Set([2]));
    reporter.update(0);
    // Under load a refresh tick may beat the debounce; either way exactly one 0 goes out, then nothing.
    const deadline = Date.now() + 2_000;
    while (sent.at(-1) !== 0 && Date.now() < deadline) await Bun.sleep(5);
    const settled = sent.length;
    expect(sent.filter((value) => value === 0)).toEqual([0]);
    await Bun.sleep(120);
    expect(sent).toHaveLength(settled);
    reporter.finish();
    // Already 0: nothing more to clear.
    expect(sent).toHaveLength(settled);
  });

  it("a refresh tick that beats the debounce of a drop to 0 neither repeats 0 nor keeps refreshing", async () => {
    const sent: number[] = [];
    const reporter = new TaskActivityReporter((n) => sent.push(n), { debounceMs: 60, refreshMs: 10 });
    reporter.update(1);
    await Bun.sleep(90);
    reporter.update(0);
    await Bun.sleep(150);
    expect(sent.filter((value) => value === 0)).toEqual([0]);
    const settled = sent.length;
    await Bun.sleep(60);
    expect(sent).toHaveLength(settled);
    reporter.finish();
    expect(sent).toHaveLength(settled);
  });

  it("sends nothing for an attempt without subagents, and nothing after finish", async () => {
    const sent: number[] = [];
    const reporter = new TaskActivityReporter((n) => sent.push(n), { debounceMs: 5 });
    reporter.update(0);
    reporter.resend();
    await Bun.sleep(20);
    reporter.finish();
    reporter.update(3);
    reporter.resend();
    await Bun.sleep(20);
    expect(sent).toEqual([]);
  });

  it("resends the current count on reconnect, and a failing transport does not throw", async () => {
    const sent: number[] = [];
    let fail = true;
    const reporter = new TaskActivityReporter((n) => {
      if (fail) throw new Error("not connected");
      sent.push(n);
    }, { debounceMs: 5, refreshMs: 10_000 });
    reporter.update(1);
    await Bun.sleep(20);
    fail = false;
    reporter.resend();
    expect(sent).toEqual([1]);
    reporter.finish();
    expect(sent).toEqual([1, 0]);
  });
});
