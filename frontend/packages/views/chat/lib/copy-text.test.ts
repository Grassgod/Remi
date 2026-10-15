import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@multiremi/core/types";
import { extractCopyText } from "./copy-text";

const message = (content: string): ChatMessage => ({
  id: "m1",
  chat_session_id: "s1",
  role: "assistant",
  content,
  task_id: "t1",
  created_at: "2026-05-06T00:00:00Z",
});

describe("extractCopyText", () => {
  it("copies the stored reply exactly, never the folded steps", () => {
    const reply = "## Done\n\n- fixed `a.ts`\n\n```bash\nbun test\n```";
    expect(extractCopyText(message(reply))).toBe(reply);
  });

  it("copies an empty string for an empty reply", () => {
    expect(extractCopyText(message(""))).toBe("");
  });
});
