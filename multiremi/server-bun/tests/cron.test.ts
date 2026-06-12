/** computeNextRun: 5-field cron, timezone-aware, fail-fast on bad input. */

import { test, expect } from "bun:test";
import { computeNextRun } from "../src/agent/cron.js";

test("daily-at-midnight returns the next UTC midnight after `from`", () => {
  const from = new Date("2026-06-08T10:00:00Z");
  expect(computeNextRun("0 0 * * *", "UTC", from).toISOString()).toBe("2026-06-09T00:00:00.000Z");
});

test("every-15-minutes returns the next quarter hour", () => {
  const from = new Date("2026-06-08T10:07:00Z");
  expect(computeNextRun("*/15 * * * *", "UTC", from).toISOString()).toBe("2026-06-08T10:15:00.000Z");
});

test("timezone is honored — midnight in a +08:00 zone is 16:00 the prior UTC day", () => {
  const from = new Date("2026-06-08T10:00:00Z"); // 18:00 in Shanghai
  // Next Asia/Shanghai midnight is 2026-06-09 00:00 +08:00 = 2026-06-08 16:00Z.
  expect(computeNextRun("0 0 * * *", "Asia/Shanghai", from).toISOString()).toBe("2026-06-08T16:00:00.000Z");
});

test("an invalid cron expression throws", () => {
  expect(() => computeNextRun("not a cron", "UTC")).toThrow(/invalid expression/);
});
