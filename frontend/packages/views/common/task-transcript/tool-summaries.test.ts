import { describe, expect, it } from "vitest";
import { formatToolInputSummary, isBashCommandMissing, toolIcon } from "./tool-summaries";
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

describe("formatToolInputSummary — Bash commands", () => {
  it("keeps a slash-heavy command intact instead of path-compressing it", () => {
    const command = 'grep -rn "foo" ./src | head -30 > /dev/null';

    expect(formatToolInputSummary("Bash", { command })).toBe(`$ ${command}`);
  });

  it("head-truncates a long command without mangling its slashes", () => {
    const command = `echo ${"/x".repeat(100)}`;
    const summary = formatToolInputSummary("Bash", { command });

    expect(summary).toBe(`$ ${command.slice(0, 160)}…`);
    expect(summary).not.toContain(".../");
  });

  it("shows the first line plus a dropped-line count for a multiline command", () => {
    const command = 'echo "― core ―"; ls a/b/c | head -20\nsecond line\nthird line';

    expect(formatToolInputSummary("Bash", { command })).toBe('$ echo "― core ―"; ls a/b/c | head -20 (+2)');
  });

  it("leaves a single-line command unsuffixed, trailing newline included", () => {
    expect(formatToolInputSummary("Bash", { command: "echo hi" })).toBe("$ echo hi");
    expect(formatToolInputSummary("Bash", { command: "echo hi\n" })).toBe("$ echo hi");
  });
});

describe("isBashCommandMissing", () => {
  it("flags only Bash steps whose command never made it into the input", () => {
    expect(isBashCommandMissing("Bash", undefined)).toBe(true);
    expect(isBashCommandMissing("Bash", { terminal_id: "term-1" })).toBe(true);
    expect(isBashCommandMissing("Bash", { command: "   " })).toBe(true);
    expect(isBashCommandMissing("Bash", { command: "ls a/b/c | head -1" })).toBe(false);
    expect(isBashCommandMissing("Read", { file_path: "/a/b/c/d.ts" })).toBe(false);
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
