import { describe, expect, it } from "vitest";
import type { TraceSubagentItem } from "@multiremi/contracts/trace";
import { processItemCount } from "@multiremi/shared/turn-trace";
import { at, message, subagent } from "../../test/trace-fixtures";
import { claudeDoneItems, claudeLiveItems, codexItems } from "./__fixtures__/subagents";
import {
  backgroundRunningCount,
  plainText,
  runningSubagents,
  runningTree,
  subagentDurationMs,
  subagentFailureText,
  subagentGenerations,
  subagentLabel,
  subagentPath,
  subagentStatus,
  subagentTaskLine,
} from "./subagents";
import { buildTurnSteps } from "./turn-steps";

const find = (items: ReturnType<typeof claudeLiveItems>, id: string) => items.find((item) => item.id === id) as TraceSubagentItem;

describe("labels", () => {
  it("uses the name as the label and the agent type as secondary text only when it says something else (U2)", () => {
    expect(subagentLabel(subagent("sa:1", "查找", { name: "查找", agent_type: "Explore" }))).toEqual({ name: "查找", type: "Explore" });
    // Claude native child sessions carry no type.
    expect(subagentLabel(subagent("sa:1", "查找", { name: "查找", agent_type: null }))).toEqual({ name: "查找", type: null });
    expect(subagentLabel(subagent("sa:1", "Explore", { name: null, agent_type: "Explore" }))).toEqual({ name: "Explore", type: null });
    expect(subagentLabel(subagent("sa:1", " ", { name: null, title: null, tool: "spawnAgent" })).name).toBe("spawnAgent");
  });

  it("cuts the task to the first line of the instructions, without Markdown, at 60 characters", () => {
    expect(subagentTaskLine(subagent("sa:1", "x", { prompt: "\n## Find the **loader** in `src`\nthen report" }))).toBe("Find the loader in src");
    const long = "a".repeat(70);
    expect(subagentTaskLine(subagent("sa:1", "x", { prompt: long }))).toBe(`${"a".repeat(60)}…`);
    // No instructions (Codex's synthetic task) and instructions that only repeat the name give none.
    expect(subagentTaskLine(subagent("sa:1", "x", { prompt: null }))).toBeNull();
    expect(subagentTaskLine(subagent("sa:1", "count", { name: "count", prompt: "count" }))).toBeNull();
    expect(plainText("- [docs](http://x) and ~~old~~ *new*")).toBe("docs and old new");
  });
});

describe("status and timing", () => {
  it("maps item states to the row statuses", () => {
    const running = { status: "in_progress" as const, completed_at: null };
    expect(subagentStatus(subagent("s", "x", { ...running, background: true }))).toBe("background");
    expect(subagentStatus(subagent("s", "x", { ...running, background: null }))).toBe("running");
    expect(subagentStatus(subagent("s", "x", { status: "failed" }))).toBe("failed");
    expect(subagentStatus(subagent("s", "x", { status: "stopped" }))).toBe("stopped");
    expect(subagentStatus(subagent("s", "x", { status: "declined" }))).toBe("stopped");
    expect(subagentStatus(subagent("s", "x"))).toBe("completed");
  });

  it("reads the duration, else the span between start and end", () => {
    expect(subagentDurationMs(subagent("s", "x", { duration_ms: 4000 }))).toBe(4000);
    expect(subagentDurationMs(subagent("s", "x", { duration_ms: null, started_at: at(1), completed_at: at(9) }))).toBe(8000);
    expect(subagentDurationMs(subagent("s", "x", { duration_ms: null, completed_at: null }))).toBeNull();
  });

  it("keeps the end of a long failure text, at most 400 characters", () => {
    const items = claudeDoneItems();
    expect(subagentFailureText(items, find(items, "sa:fail"))).toBe("Error: connect ETIMEDOUT open.feishu.cn:443");
    const long = subagent("sa:x", "x", { status: "failed", output: `${"x".repeat(500)}END` });
    const text = subagentFailureText([long], long)!;
    expect([...text].length).toBe(401);
    expect(text.startsWith("…") && text.endsWith("END")).toBe(true);
    // Without output, the end of its reply.
    const bare = subagent("sa:y", "y", { status: "failed", output: null });
    expect(subagentFailureText([bare, message("m", "gave up: quota", "commentary", { parent_id: "sa:y" })], bare)).toBe("gave up: quota");
    expect(subagentFailureText([bare], bare)).toBeNull();
  });
});

describe("trees and counts", () => {
  it("gives the path from the top-level subagent and the running tree with depths", () => {
    const items = claudeLiveItems();
    expect(subagentPath(items, "sa:gp")).toEqual(["sa:explore", "sa:gp"]);
    expect(subagentPath(items, "sa:plan")).toEqual(["sa:plan"]);
    expect(runningTree(items).map(({ item, depth }) => [item.id, depth])).toEqual([["sa:explore", 0], ["sa:gp", 1], ["sa:plan", 0]]);
    const { top, nested } = runningSubagents(items);
    expect([top.map((item) => item.id), nested.map((item) => item.id)]).toEqual([["sa:explore", "sa:plan"], ["sa:gp"]]);
    // A running agent under a finished one moves up a level.
    const finished = items.map((item) => item.id === "sa:explore" ? { ...item, status: "completed" as const, completed_at: at(12) } : item);
    expect(runningTree(finished).map(({ item, depth }) => [item.id, depth])).toEqual([["sa:gp", 0], ["sa:plan", 0]]);
  });

  it("counts background subagents for the header, and any running one once the reply started", () => {
    const items = claudeLiveItems();
    expect(backgroundRunningCount(items, false)).toBe(1);
    expect(backgroundRunningCount(items, true)).toBe(2);
    expect(backgroundRunningCount(codexItems(), true)).toBe(0);
  });

  it("keeps the fold's process count equal to the shared count on the subagent fixtures", () => {
    for (const items of [claudeLiveItems(), claudeDoneItems(), codexItems()]) {
      expect(buildTurnSteps(items).processCount).toBe(processItemCount(items));
    }
  });
});

describe("generations", () => {
  it("splits a resumed subagent at each new instruction and finds each reply", () => {
    const items = claudeDoneItems();
    const generations = subagentGenerations(items, find(items, "sa:review"));
    expect(generations.map((g) => [g.key, g.prompt, g.children.map((child) => child.id), g.reply?.id ?? null, g.endedAt, g.running])).toEqual([
      ["sa:review", "审阅 `claude/feishu-step-copy` 分支的改动。", ["cmd:r1", "cmd:r2", "msg:r1"], "msg:r1", at(20), false],
      ["um:r2", "再看看 ja 和 ko 的翻译", ["cmd:r3", "msg:r2"], "msg:r2", at(42), false],
    ]);
  });

  it("gives a running subagent no reply yet, and none when a tool call follows its last message", () => {
    const items = claudeLiveItems();
    const [plan] = subagentGenerations(items, find(items, "sa:plan"));
    expect([plan!.running, plan!.reply, plan!.endedAt]).toEqual([true, null, null]);
    const codex = codexItems();
    const [child] = subagentGenerations(codex, find(codex, "sa:t1"));
    // Codex has no task prompt; its last message is its reply.
    expect([child!.prompt, child!.reply?.id]).toEqual([null, "msg:c1"]);
  });
});
