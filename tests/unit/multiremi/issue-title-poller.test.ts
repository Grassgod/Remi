import { afterEach, describe, expect, it } from "bun:test";
import { IssueTitleScheduler } from "@multiremi/issue-title/poller.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const FUTURE = new Date(Date.now() + 6 * 60 * 1_000);
const DESCRIPTION = "实现稳定的一键 Issue 自动命名功能，并确保模型网络失败不会影响主流程。";
const CODEX_FRAGMENT = [
  'model_provider = "OpenAI"',
  "[model_providers.OpenAI]",
  'base_url = "https://gateway.example.com/v1"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
].join("\n");

describe("Issue title scheduler", () => {
  it("runs candidates serially through an injected transport and applies at most the configured cap", async () => {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "codex", {
      fragment: CODEX_FRAGMENT,
      tokenOp: "set",
      authToken: "secret-not-for-output",
    });
    const first = store.createIssue({ title: "Remi", description: DESCRIPTION });
    const second = store.createIssue({ title: "测试", description: DESCRIPTION });
    let inFlight = 0;
    let maxInFlight = 0;
    const scheduler = new IssueTitleScheduler({
      store,
      maxCandidates: 1,
      now: () => FUTURE,
      httpRequest: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return {
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"title":"实现 Issue 自动命名","keep":false}' } }] }),
        };
      },
    });

    const result = await scheduler.runOnce();
    expect(result).toMatchObject({ attempted: 1, applied: 1, failed: 0 });
    expect(maxInFlight).toBe(1);
    const renamed = [first, second].find((issue) => store.getIssue(issue.id)?.title === "实现 Issue 自动命名");
    expect(renamed).toBeDefined();
    expect(store.getIssueAutoTitleMetadata(renamed!.id).count).toBe(1);
  });

  it("silently skips an eligible Issue when its gateway is unconfigured", async () => {
    const store = createLocalStore();
    const issue = store.createIssue({ title: "Remi", description: DESCRIPTION });
    const scheduler = new IssueTitleScheduler({ store, now: () => FUTURE });

    await expect(scheduler.runOnce()).resolves.toEqual({ attempted: 1, applied: 0, skipped: 1, failed: 0 });
    expect(store.getIssue(issue.id)?.title).toBe("Remi");
  });

  it("coalesces overlapping ticks into one run", async () => {
    const store = createLocalStore();
    store.createIssue({ title: "Remi", description: DESCRIPTION });
    let calls = 0;
    const scheduler = new IssueTitleScheduler({
      store,
      now: () => FUTURE,
      retitle: async (_store, _id, options) => {
        calls += 1;
        await Promise.resolve();
        return { title: "Remi", previousTitle: "Remi", applied: false, reason: options.source === "auto" ? "kept" : "generated" };
      },
    });
    await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    expect(calls).toBe(1);
  });
});
