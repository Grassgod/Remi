import { afterEach, describe, expect, it } from "bun:test";
import { retitleIssue } from "@multiremi/issue-title/service.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const CODEX_FRAGMENT = [
  'model_provider = "OpenAI"',
  "[model_providers.OpenAI]",
  'base_url = "https://gateway.example.com/v1"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
].join("\n");

describe("Issue title service", () => {
  it("manual retitling bypasses eligibility, applies metadata, and records an auditable activity", async () => {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "codex", {
      fragment: CODEX_FRAGMENT,
      tokenOp: "set",
      authToken: "secret-not-for-output",
    });
    const issue = store.createIssue({
      title: "现有标题已经足够长且刚刚编辑",
      description: "这是一个足够长的描述，用于验证手动触发会跳过自动 eligibility 判断。",
    });
    store.setIssueAutoTitleMetadata(issue.id, { locked: true, count: 1 });
    const now = new Date("2026-08-25T12:00:00.000Z");

    const result = await retitleIssue(store, issue.id, {
      source: "manual",
      apply: true,
      now,
      httpRequest: async () => ({
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: '{"title":"验证人工触发自动命名","keep":false}' } }] }),
      }),
    });

    expect(result).toEqual({
      title: "验证人工触发自动命名",
      previousTitle: "现有标题已经足够长且刚刚编辑",
      applied: true,
      reason: "generated",
    });
    expect(store.getIssue(issue.id)?.title).toBe("验证人工触发自动命名");
    expect(store.getIssueAutoTitleMetadata(issue.id)).toMatchObject({
      locked: true,
      generated_at: now.toISOString(),
      model: "gpt-5.6-luna",
      source: "manual",
      count: 1,
      content_hash: expect.any(String),
    });
    expect(store.listIssueActivity(issue.id).find((activity) => activity.type === "title_renamed")?.data).toEqual({
      from: "现有标题已经足够长且刚刚编辑",
      to: "验证人工触发自动命名",
      source: "manual",
      model: "gpt-5.6-luna",
    });
  });

  it("returns a generated preview without mutating when apply is false", async () => {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "codex", { fragment: CODEX_FRAGMENT, tokenOp: "set", authToken: "secret" });
    const issue = store.createIssue({ title: "Remi", description: "这是一个足够长的描述，用于验证 dry-run 不会写入数据库。" });
    const result = await retitleIssue(store, issue.id, {
      source: "manual",
      apply: false,
      httpRequest: async () => ({
        status: 200,
        text: JSON.stringify({ choices: [{ message: { content: '{"title":"预览自动命名结果","keep":false}' } }] }),
      }),
    });
    expect(result).toMatchObject({ title: "预览自动命名结果", applied: false, reason: "generated" });
    expect(store.getIssue(issue.id)?.title).toBe("Remi");
    expect(store.getIssueAutoTitleMetadata(issue.id)).toEqual({});
  });

  it("does not overwrite a human title edit made while an automatic request is in flight", async () => {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "codex", {
      fragment: CODEX_FRAGMENT,
      tokenOp: "set",
      authToken: "secret",
    });
    const issue = store.createIssue({
      title: "Remi",
      description: "这是一个足够长的描述，用于验证模型调用期间人工编辑不会被自动流程覆盖。",
    });
    const result = await retitleIssue(store, issue.id, {
      source: "auto",
      apply: true,
      now: new Date(Date.now() + 6 * 60 * 1_000),
      httpRequest: async () => {
        store.updateIssue(issue.id, { title: "人工编辑后的明确标题" });
        store.setIssueAutoTitleMetadata(issue.id, { locked: true });
        return {
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"title":"模型生成的标题","keep":false}' } }] }),
        };
      },
    });

    expect(result).toMatchObject({
      title: "人工编辑后的明确标题",
      previousTitle: "Remi",
      applied: false,
      reason: "not_eligible",
    });
    expect(store.getIssue(issue.id)?.title).toBe("人工编辑后的明确标题");
  });

  it("discards an automatic result when the description changes during generation", async () => {
    const store = createLocalStore();
    store.upsertRelayConfig("local", "codex", {
      fragment: CODEX_FRAGMENT,
      tokenOp: "set",
      authToken: "secret",
    });
    const issue = store.createIssue({
      title: "Remi",
      description: "登录认证流程持续失败，需要修复会话刷新和凭据校验逻辑。",
    });
    const result = await retitleIssue(store, issue.id, {
      source: "auto",
      apply: true,
      now: new Date(Date.now() + 6 * 60 * 1_000),
      httpRequest: async () => {
        store.updateIssue(issue.id, {
          description: "支付订单发生重复扣款，需要修复幂等校验和退款处理逻辑。",
        });
        return {
          status: 200,
          text: JSON.stringify({ choices: [{ message: { content: '{"title":"修复登录认证流程失败问题","keep":false}' } }] }),
        };
      },
    });

    expect(result).toEqual({
      title: "Remi",
      previousTitle: "Remi",
      applied: false,
      reason: "not_eligible",
    });
    expect(store.getIssue(issue.id)).toMatchObject({
      title: "Remi",
      description: "支付订单发生重复扣款，需要修复幂等校验和退款处理逻辑。",
    });
    expect(store.getIssueAutoTitleMetadata(issue.id)).toEqual({});
    expect(store.listIssueActivity(issue.id).some((activity) => activity.type === "title_renamed")).toBe(false);
  });
});
