import { describe, expect, it } from "bun:test";
import {
  isLowQualityTitle,
  issueTitleContentHash,
  shouldAutoRetitle,
} from "@multiremi/issue-title/eligibility.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const DESCRIPTION = "实现一个稳定的一键自动命名功能，并确保模型失败不会影响 Issue 读写。";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    title: "实现 Issue 自动命名功能",
    description: DESCRIPTION,
    archivedAt: null,
    updatedAt: "2026-08-25T11:54:59.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("issue title eligibility", () => {
  it("recognizes every low-quality title shape", () => {
    expect(isLowQualityTitle("Remi")).toBe(true);
    expect(isLowQualityTitle("这是首行的完整需求", { description: "这是首行的完整需求\n更多内容" })).toBe(true);
    expect(isLowQualityTitle("这是一个被截断的非常非常长的需求...", {
      description: "这是一个被截断的非常非常长的需求，后面还有更多详细内容",
    })).toBe(true);
    expect(isLowQualityTitle("x".repeat(81))).toBe(true);
    expect(isLowQualityTitle("合法标题\n第二行内容")).toBe(true);
    expect(isLowQualityTitle("![图片](https://example.com/a.png) 标题")).toBe(true);
    expect(isLowQualityTitle("一个很长的项目名称", { projectName: "一个很长的项目名称" })).toBe(true);
    expect(isLowQualityTitle("一个很长的代理名称", { agentName: "一个很长的代理名称" })).toBe(true);
    expect(isLowQualityTitle("实现 Issue 自动命名功能", { description: DESCRIPTION })).toBe(false);
  });

  it("rejects archived, locked, over-limit, short, and recently edited issues", () => {
    expect(shouldAutoRetitle(issue({ archivedAt: NOW.toISOString(), title: "Remi" }), NOW)).toBe(false);
    expect(shouldAutoRetitle(issue({ metadata: { auto_title: { locked: true } }, title: "Remi" }), NOW)).toBe(false);
    expect(shouldAutoRetitle(issue({ metadata: { auto_title: { count: 3 } }, title: "Remi" }), NOW)).toBe(false);
    expect(shouldAutoRetitle(issue({ description: "**太短**", title: "Remi" }), NOW)).toBe(false);
    expect(shouldAutoRetitle(issue({ updatedAt: "2026-08-25T11:55:01.000Z", title: "Remi" }), NOW)).toBe(false);
  });

  it("accepts a stale low-quality title", () => {
    expect(shouldAutoRetitle(issue({ title: "Remi" }), NOW)).toBe(true);
  });

  it("accepts a good title only when content changed after an earlier automatic title", () => {
    expect(shouldAutoRetitle(issue(), NOW)).toBe(false);
    expect(shouldAutoRetitle(issue({
      metadata: { auto_title: { content_hash: issueTitleContentHash("旧的描述内容需要至少二十个字符用于测试场景。") } },
    }), NOW)).toBe(true);
    expect(shouldAutoRetitle(issue({
      metadata: { auto_title: { content_hash: issueTitleContentHash(DESCRIPTION) } },
    }), NOW)).toBe(false);
  });
});
