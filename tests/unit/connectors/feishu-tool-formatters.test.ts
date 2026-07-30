import { describe, expect, it } from "bun:test";
import { formatToolInputSummary } from "@connectors/feishu/tool-formatters.js";

describe("Feishu Bash input summary", () => {
  it("keeps a slash-heavy command intact instead of path-compressing it", () => {
    const command = 'grep -rn "foo" ./src | head -30 > /dev/null';

    expect(formatToolInputSummary("Bash", { command })).toBe(`\`$ ${command}\``);
  });

  it("collapses a multiline command to its first line plus a dropped-line count", () => {
    const command = "cd frontend/packages/views\nbun run test\nbun run lint";
    const summary = formatToolInputSummary("Bash", { command });

    expect(summary).toBe("`$ cd frontend/packages/views (+2)`");
    expect(summary).not.toContain("\n");
  });

  it("leaves a single-line command unsuffixed, trailing newline included", () => {
    expect(formatToolInputSummary("Bash", { command: "echo hi" })).toBe("`$ echo hi`");
    expect(formatToolInputSummary("Bash", { command: "echo hi\n" })).toBe("`$ echo hi`");
  });

  it("head-truncates a long command without mangling its slashes", () => {
    const command = `echo ${"/x".repeat(250)}`;
    const summary = formatToolInputSummary("Bash", { command });

    expect(summary).toBe(`\`$ ${command.slice(0, 397)}...\``);
    expect(summary).not.toContain("~/");
  });

  it("adds no phantom line count when the command is missing", () => {
    expect(formatToolInputSummary("Bash", { terminal_id: "term-1" })).toBe("`$ `");
    expect(formatToolInputSummary("Bash", {})).toBe("");
  });

  it("still shortens paths for path-valued tools", () => {
    expect(formatToolInputSummary("Read", { file_path: "src/a.ts" })).toBe("`src/a.ts`");
    expect(formatToolInputSummary("Read", { file_path: `${process.env.HOME}/projects/a.ts` })).toBe(
      "`~/projects/a.ts`",
    );
  });
});
