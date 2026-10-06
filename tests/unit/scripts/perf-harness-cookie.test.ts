import { describe, expect, test } from "bun:test";
import type { Browser, BrowserContext } from "@playwright/test";
import { mktContext } from "../../../frontend/scripts/perf/lib/harness";

describe("perf context authentication", () => {
  test.each([false, true])("SSR cookie enabled=%s uses only the target origin and stays httpOnly", async enabled => {
    const cookies: unknown[] = [];
    const scripts: unknown[] = [];
    const context = {
      addCookies: async (batch: unknown[]) => { cookies.push(...batch); },
      addInitScript: async (...args: unknown[]) => { scripts.push(args); },
    } as unknown as BrowserContext;
    const browser = { newContext: async () => context } as unknown as Browser;
    await mktContext(browser, "test-memory-token", [], "http://localhost:3595", enabled);
    expect(cookies).toContainEqual({ name: "multimira_logged_in", value: "1", url: "http://localhost:3595" });
    const auth = cookies.filter(cookie => (cookie as { name: string }).name === "multimira_auth");
    expect(auth).toEqual(enabled ? [{ name: "multimira_auth", value: "test-memory-token", url: "http://localhost:3595", httpOnly: true, sameSite: "Strict" }] : []);
    expect(scripts.length).toBeGreaterThan(0);
  });
});
