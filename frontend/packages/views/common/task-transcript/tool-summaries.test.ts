import { describe, expect, it } from "vitest";
import { formatToolInputSummary, toolIcon } from "./tool-summaries";
import { Terminal, FileText, Wrench } from "lucide-react";

describe("formatToolInputSummary", () => {
  it("summarizes per tool", () => {
    expect(formatToolInputSummary("Bash", { command: "echo hi" })).toBe("$ echo hi");
    expect(formatToolInputSummary("Read", { file_path: "/a/b/c/d.ts", offset: 10 })).toBe(".../c/d.ts L10");
    expect(formatToolInputSummary("Grep", { pattern: "foo", path: "src" })).toBe("/foo/ in src");
    expect(formatToolInputSummary("WebSearch", { query: "bun test" })).toBe('"bun test"');
    expect(formatToolInputSummary("TodoWrite", { todos: [{ status: "completed" }, { status: "in_progress" }] })).toBe("2 tasks (1 done, 1 active)");
  });

  it("falls back to a short string field for unknown tools", () => {
    expect(formatToolInputSummary("Mystery", { note: "short value" })).toBe("short value");
    expect(formatToolInputSummary("Empty", {})).toBe("");
  });
});

describe("toolIcon", () => {
  it("maps known tools and defaults to a wrench", () => {
    expect(toolIcon("Bash")).toBe(Terminal);
    expect(toolIcon("Read")).toBe(FileText);
    expect(toolIcon("Unknown")).toBe(Wrench);
    expect(toolIcon(undefined)).toBe(Wrench);
  });
});
