import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collabAgentStates,
  formatToolInputSummary,
  isBashCommandMissing,
  isCollabInput,
  toolIcon,
} from "./tool-summaries";
import { Terminal, FileText, Hourglass, Wrench } from "lucide-react";

// Real C0 capture (codex 0.142.5 collab run): 2× spawnAgent + 2× wait.
// Tests read the frames rather than hand-written shapes so a bridge change that
// moves a field fails here instead of silently producing empty cards.
// Resolved from the vitest project root (frontend/packages/views) — jsdom does
// not give this file a file:// import.meta.url.
const COLLAB_FIXTURE = resolve(
  process.cwd(),
  "../../../tests/fixtures/acp/codex-collab-notifications-1786010059380.json",
);

function collabInputs(title: string, status: string): Record<string, unknown>[] {
  const frames = JSON.parse(readFileSync(COLLAB_FIXTURE, "utf-8")) as Array<{
    params?: { update?: Record<string, unknown> };
  }>;
  return frames
    .map((frame) => frame.params?.update)
    .filter((u): u is Record<string, unknown> => !!u && u.title === title && u.status === status)
    .map((u) => u.rawInput as Record<string, unknown>);
}

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

  it("gives the codex collab wait verb its own icon", () => {
    expect(toolIcon("wait")).toBe(Hourglass);
  });
});

describe("codex collab steps", () => {
  it("detects a collab call by input shape, including the prompt-less wait", () => {
    const [spawn] = collabInputs("spawnAgent", "in_progress");
    const [wait] = collabInputs("wait", "in_progress");

    expect(isCollabInput(spawn)).toBe(true);
    expect(wait!.prompt).toBeNull();
    expect(isCollabInput(wait)).toBe(true);
    // Shape, not name: a claude Agent step is not a collab step.
    expect(isCollabInput({ description: "look around", prompt: "go" })).toBe(false);
    expect(isCollabInput(undefined)).toBe(false);
    expect(isCollabInput({ senderThreadId: "t1" })).toBe(false);
  });

  it("summarizes a spawnAgent delegation by its prompt", () => {
    const [spawn] = collabInputs("spawnAgent", "in_progress");

    expect(formatToolInputSummary("Agent", spawn)).toBe(
      '"Write exactly one original English-language haiku about the sea. Return only the three-line haiku, with no title or commentary."',
    );
  });

  it("summarizes a finished wait by agent-state counts", () => {
    const [wait] = collabInputs("wait", "completed");

    expect(formatToolInputSummary("wait", wait)).toBe("1 done");
  });

  it("counts unfinished states as running", () => {
    const [spawnDone] = collabInputs("spawnAgent", "completed");
    // The terminal spawnAgent frame reports the new thread as pendingInit; the
    // prompt is still there, so the delegation keeps its prompt summary.
    expect(collabAgentStates(spawnDone)).toEqual([
      { threadId: "019fd67e-f5d8-7041-87ee-6f1d8d52280f", status: "pendingInit", message: undefined },
    ]);
    expect(
      formatToolInputSummary("wait", { ...spawnDone, prompt: null }),
    ).toBe("1 running");
    expect(
      formatToolInputSummary("wait", {
        senderThreadId: "s",
        receiverThreadIds: ["a", "b", "c"],
        agentsStates: {
          a: { status: "inProgress" },
          b: { status: "someFutureValue" },
          c: { status: "completed" },
        },
      }),
    ).toBe("2 running · 1 done");
  });

  it("falls back to the receiver count while agentsStates is still empty", () => {
    const [wait] = collabInputs("wait", "in_progress");

    expect(wait!.agentsStates).toEqual({});
    expect(formatToolInputSummary("wait", wait)).toBe("waiting for 2 agents");
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
      // Both the resolved name (spawnAgent → Agent) and the raw verb.
      for (const name of ["Agent", "wait"]) {
        const summary = formatToolInputSummary(name, input);
        expect(summary).not.toContain(String(input.senderThreadId));
        for (const id of input.receiverThreadIds as string[]) {
          expect(summary).not.toContain(id);
        }
      }
    }
  });

  it("reads malformed agent states as no chips rather than throwing", () => {
    expect(collabAgentStates({ agentsStates: "nope" })).toEqual([]);
    expect(collabAgentStates({ agentsStates: [1, 2] })).toEqual([]);
    expect(collabAgentStates(undefined)).toEqual([]);
    expect(collabAgentStates({ agentsStates: { t1: null } })).toEqual([
      { threadId: "t1", status: "unknown", message: undefined },
    ]);
  });
});
