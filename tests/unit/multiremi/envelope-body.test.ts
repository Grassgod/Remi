import { expect, test } from "bun:test";
import { clampEnvelopeBody, envelopeSummary } from "@multiremi/store/envelope-body.js";

test("bounds envelope UTF-8 bytes without splitting characters", () => {
  const clamped = clampEnvelopeBody("文😀".repeat(10_000));
  expect(Buffer.byteLength(clamped)).toBeLessThanOrEqual(4_096);
  expect(clamped).not.toContain("\ufffd");
  expect(clamped).toContain("已截断");
  expect(clampEnvelopeBody("short")).toBe("short");
  expect(Array.from(envelopeSummary("文😀".repeat(10_000))).length).toBeLessThanOrEqual(500);
  expect(Buffer.byteLength(envelopeSummary("文😀".repeat(10_000)))).toBeLessThanOrEqual(1_100);
});
