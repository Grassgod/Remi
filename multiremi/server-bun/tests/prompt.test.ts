/** buildTaskPrompt embeds the task context (instructions + issue + conversation). */

import { test, expect } from "bun:test";
import { buildTaskPrompt } from "../src/agent/prompt.js";

test("assembles instructions, issue, acceptance criteria, and conversation", () => {
  const prompt = buildTaskPrompt({
    instructions: "You are a careful engineer.",
    issue: {
      identifier: "MUL-12",
      title: "Fix login",
      description: "Users can't log in with SSO.",
      status: "in_progress",
      acceptanceCriteria: ["SSO works", "tests pass"],
    },
    comments: [
      { author: "member", content: "any update?" },
      { author: "agent", content: "looking into it" },
    ],
  });
  expect(prompt).toContain("You are a careful engineer.");
  expect(prompt).toContain("# Task: MUL-12 — Fix login");
  expect(prompt).toContain("Status: in_progress");
  expect(prompt).toContain("Users can't log in with SSO.");
  expect(prompt).toContain("## Acceptance criteria");
  expect(prompt).toContain("- SSO works");
  expect(prompt).toContain("## Conversation");
  expect(prompt).toContain("[member]: any update?");
  expect(prompt).toContain("[agent]: looking into it");
});

test("notes a comment-triggered task", () => {
  const prompt = buildTaskPrompt({
    instructions: "x",
    issue: { identifier: "MUL-1", title: "T", status: "todo" },
    triggeredByComment: true,
  });
  expect(prompt).toContain("mentioned in the most recent comment");
});

test("non-string acceptance criteria are ignored; empty input falls back", () => {
  const p = buildTaskPrompt({ issue: { identifier: "MUL-2", title: "T", status: "todo", acceptanceCriteria: [{ x: 1 }, "keep me"] } });
  expect(p).toContain("- keep me");
  expect(p).not.toContain("[object Object]");
  expect(buildTaskPrompt({})).toBe("Proceed.");
});
