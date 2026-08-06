import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { formatToolInputSummary, isCollabInput, TOOL_ICONS } from "@connectors/feishu/tool-formatters.js";

/** Collab rawInputs from the real C0 capture (codex 0.142.5), by verb + status. */
function collabInputs(title: string, status: string): Record<string, unknown>[] {
  const frames = JSON.parse(
    readFileSync(
      new URL("../../fixtures/acp/codex-collab-notifications-1786010059380.json", import.meta.url),
      "utf-8",
    ),
  ) as Array<{ params?: { update?: Record<string, unknown> } }>;
  return frames
    .map((frame) => frame.params?.update)
    .filter((u): u is Record<string, unknown> => !!u && u.title === title && u.status === status)
    .map((u) => u.rawInput as Record<string, unknown>);
}

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

describe("Feishu codex collab summaries", () => {
  it("detects a collab call by input shape, including the prompt-less wait", () => {
    const [spawn] = collabInputs("spawnAgent", "in_progress");
    const [wait] = collabInputs("wait", "in_progress");

    expect(isCollabInput(spawn)).toBe(true);
    expect(wait!.prompt).toBeNull();
    expect(isCollabInput(wait)).toBe(true);
    expect(isCollabInput({ description: "look around", prompt: "go" })).toBe(false);
    expect(isCollabInput(undefined)).toBe(false);
  });

  it("summarizes a spawnAgent delegation by its prompt and a wait by counts", () => {
    const [spawn] = collabInputs("spawnAgent", "in_progress");
    const [waitStart] = collabInputs("wait", "in_progress");
    const [waitDone] = collabInputs("wait", "completed");

    expect(formatToolInputSummary("Agent", spawn)).toBe(
      '"Write exactly one original English-language haiku about the sea. Return only the three-line haiku, with no title or commentary."',
    );
    expect(formatToolInputSummary("wait", waitStart)).toBe("waiting for 2 agents");
    expect(formatToolInputSummary("wait", waitDone)).toBe("1 done");
    expect(
      formatToolInputSummary("wait", {
        senderThreadId: "s",
        receiverThreadIds: ["a", "b", "c"],
        agentsStates: { a: { status: "inProgress" }, b: { status: "pendingInit" }, c: { status: "completed" } },
      }),
    ).toBe("2 running · 1 done");
  });

  it("never leaks a thread id into a one-line summary", () => {
    const inputs = [
      ...collabInputs("spawnAgent", "in_progress"),
      ...collabInputs("spawnAgent", "completed"),
      ...collabInputs("wait", "in_progress"),
      ...collabInputs("wait", "completed"),
    ];
    // 2 spawnAgent + 2 wait, each with an initial and a terminal frame.
    expect(inputs).toHaveLength(8);

    for (const input of inputs) {
      for (const name of ["Agent", "wait"]) {
        const summary = formatToolInputSummary(name, input);
        expect(summary).not.toContain(String(input.senderThreadId));
        for (const id of input.receiverThreadIds as string[]) {
          expect(summary).not.toContain(id);
        }
      }
    }
  });

  it("gives the wait verb its own card icon", () => {
    expect(TOOL_ICONS.wait).toBe("time_outlined");
    expect(TOOL_ICONS.Agent).toBe("robot_outlined");
  });
});
