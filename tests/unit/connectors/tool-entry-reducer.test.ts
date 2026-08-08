/**
 * The shared ACP tool_call/tool_call_update state machine.
 *
 * Production (handleAgentStream), tests/integration/replay-coverage.ts and
 * tests/manual/replay-fixture.ts all drive this one reducer, so what it returns
 * is literally what a Feishu card renders. The frames below are lifted verbatim
 * from the recordings in tests/fixtures/acp/ — no hand-written wire shapes
 * except where noted.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createAdapter } from "@acp/adapters/index.js";
import { createToolEntryReducer } from "@connectors/feishu/adapters/tool-entry-reducer.js";
import type { ToolCallUpdate, ToolCallProgressUpdate } from "@shared/contracts/acp-protocol.js";

type Frame = ToolCallUpdate | ToolCallProgressUpdate;

/** Every tool frame of a recording, in wire order, optionally one tool call's. */
function toolFrames(fixture: string, toolCallId?: string): Frame[] {
  const raw = readFileSync(new URL(`../../fixtures/acp/${fixture}`, import.meta.url), "utf-8");
  return (JSON.parse(raw) as Array<{ params?: { update?: Frame } }>)
    .map((n) => n.params?.update)
    .filter((u): u is Frame => {
      if (!u) return false;
      if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") return false;
      return toolCallId === undefined || u.toolCallId === toolCallId;
    });
}

describe("tool entry reducer — claude Bash (bash-exec recording)", () => {
  const frames = toolFrames("bash-exec-notifications-1777958696235.json", "toolu_01CvKucHXqsYLjC4BDsVQdxs");

  it("pairs the four wire frames into one entry, merging args instead of replacing them", () => {
    // The recording is the canonical claude shape: an argument-less tool_call,
    // an update that finally carries rawInput, a bare toolResponse echo, then
    // the terminal frame.
    expect(frames.map((f) => `${f.sessionUpdate}:${f.status ?? "-"}`)).toEqual([
      "tool_call:pending",
      "tool_call_update:-",
      "tool_call_update:-",
      "tool_call_update:completed",
    ]);

    const tools = createToolEntryReducer(createAdapter("claude"));

    const started = tools.onToolCall(frames[0] as ToolCallUpdate, "let me run it");
    expect(started.toolName).toBe("Bash");
    // title is the generic "Terminal", which the adapter refuses as a command.
    expect(started.input).toBeUndefined();
    expect(tools.entries).toEqual([
      { name: "Bash", input: undefined, status: "pending", thinkingBefore: "let me run it" },
    ]);

    const withArgs = tools.onToolCallUpdate(frames[1] as ToolCallProgressUpdate);
    expect(withArgs.kind).toBe("input");
    expect(withArgs).toMatchObject({
      toolName: "Bash",
      input: { command: "echo hello_from_acp_test", description: "Echo test string" },
      step: { name: "Bash", description: "Bash `$ echo hello_from_acp_test`" },
    });

    // Second frame carries only _meta.claudeCode.toolResponse — no arguments,
    // and the call is already in seenInputs, so it must not add a second step.
    expect(tools.onToolCallUpdate(frames[2] as ToolCallProgressUpdate)).toEqual({
      kind: "ignored",
      toolCallId: "toolu_01CvKucHXqsYLjC4BDsVQdxs",
      toolName: "Bash",
    });

    const finished = tools.onToolCallUpdate(frames[3] as ToolCallProgressUpdate);
    expect(finished.kind).toBe("finished");
    if (finished.kind !== "finished") throw new Error("unreachable");
    expect(finished.status).toBe("completed");
    expect(finished.resultPreview).toBe("```console\nhello_from_acp_test\n```");
    expect(finished.durationMs).toBeGreaterThanOrEqual(0);
    // Step already emitted on the input frame — the terminal frame must not
    // duplicate it.
    expect(finished.step).toBeUndefined();

    // The terminal frame has no rawInput at all. Merge (not replace) is what
    // keeps the command on the card.
    expect(tools.entries).toEqual([
      {
        name: "Bash",
        input: { command: "echo hello_from_acp_test", description: "Echo test string" },
        status: "done",
        thinkingBefore: "let me run it",
        durationMs: finished.durationMs,
        resultPreview: "```console\nhello_from_acp_test\n```",
        stepAdded: true,
      },
    ]);
    expect(tools.toolCount).toBe(1);
  });

  it("forgets a completed call's seenInputs mark so a late frame is no longer suppressed", () => {
    const tools = createToolEntryReducer(createAdapter("claude"));
    tools.onToolCall(frames[0] as ToolCallUpdate);
    tools.onToolCallUpdate(frames[1] as ToolCallProgressUpdate);
    tools.onToolCallUpdate(frames[3] as ToolCallProgressUpdate);

    // Same argument-bearing frame again. Before completion it was deduped;
    // after completion the id is released, so the reducer reports it — with no
    // entry to attach it to, since nothing is pending any more.
    const replayed = tools.onToolCallUpdate(frames[1] as ToolCallProgressUpdate);
    expect(replayed.kind).toBe("input");
    if (replayed.kind !== "input") throw new Error("unreachable");
    expect(replayed.entry).toBeUndefined();
    expect(replayed.step).toBeUndefined();

    expect(tools.entries).toHaveLength(1);
    expect(tools.entries[0].status).toBe("done");
    expect(tools.toolCount).toBe(1);
  });
});

describe("tool entry reducer — claude ExitPlanMode (enter-plan recording)", () => {
  const frames = toolFrames("enter-plan-notifications-1777954796663.json", "toolu_0138m2JtmNsmEUggridPAjka");

  it("early-marks the plan frame and lets the failed terminal frame own the step", () => {
    const tools = createToolEntryReducer(createAdapter("claude"));

    const started = tools.onToolCall(frames[0] as ToolCallUpdate);
    expect(started.toolName).toBe("ExitPlanMode");

    // The plan text belongs to the plan-review card, not to a tool step.
    const planFrame = frames[1] as ToolCallProgressUpdate;
    expect((planFrame.rawInput as Record<string, unknown>).plan).toContain("Config System Refactoring");
    expect(tools.onToolCallUpdate(planFrame)).toEqual({
      kind: "ignored",
      toolCallId: "toolu_0138m2JtmNsmEUggridPAjka",
      toolName: "ExitPlanMode",
    });
    expect(tools.entries[0].stepAdded).toBeUndefined();
    expect(tools.entries[0].input).toBeUndefined();

    const finished = tools.onToolCallUpdate(frames[2] as ToolCallProgressUpdate);
    expect(finished.kind).toBe("finished");
    if (finished.kind !== "finished") throw new Error("unreachable");
    expect(finished.status).toBe("failed");
    expect(finished.resultPreview).toBe("```\nUser rejected request to exit plan mode.\n```");
    // Early-marking suppressed the input step, so the terminal frame is the
    // first and only one to emit — bare, because the plan never became input.
    expect(finished.step).toEqual({ name: "ExitPlanMode", description: "ExitPlanMode" });

    expect(tools.entries).toEqual([
      {
        name: "ExitPlanMode",
        input: undefined,
        status: "done",
        thinkingBefore: "",
        durationMs: finished.durationMs,
        resultPreview: "```\nUser rejected request to exit plan mode.\n```",
        stepAdded: true,
      },
    ]);
    expect(tools.toolCount).toBe(1);
  });
});

describe("tool entry reducer — AskUserQuestion", () => {
  // No recording carries one: AskUserQuestion reaches us over
  // session/request_permission, which the fixtures capture as the synthetic
  // _permission_request event. These two frames copy the shape of the real
  // ExitPlanMode capture above (same bridge code path) with its arguments.
  const toolCallId = "toolu_01AskUserQuestionFixtureShape";
  const call = {
    _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    toolCallId,
    sessionUpdate: "tool_call",
    rawInput: {},
    status: "pending",
    title: "AskUserQuestion",
    kind: "other",
    content: [],
  } as unknown as ToolCallUpdate;
  const questionFrame = {
    _meta: { claudeCode: { toolName: "AskUserQuestion" } },
    toolCallId,
    sessionUpdate: "tool_call_update",
    rawInput: { questions: [{ question: "Which database?", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] }] },
    title: "AskUserQuestion",
    kind: "other",
    content: [],
  } as unknown as ToolCallProgressUpdate;

  it("never turns the question into a step — the question card owns it", () => {
    const tools = createToolEntryReducer(createAdapter("claude"));
    tools.onToolCall(call);

    expect(tools.onToolCallUpdate(questionFrame)).toEqual({ kind: "ignored", toolCallId, toolName: "AskUserQuestion" });
    expect(tools.entries[0].input).toBeUndefined();
    expect(tools.entries[0].stepAdded).toBeUndefined();
    expect(tools.toolCount).toBe(1);
  });
});

describe("tool entry reducer — claude agent spawn (agent-spawn recording)", () => {
  const frames = toolFrames("agent-spawn-notifications-1777954686821.json");

  it("names the Agent step from its description and keeps the nested Glob separate", () => {
    expect(frames).toHaveLength(7);
    const tools = createToolEntryReducer(createAdapter("claude"));
    const steps: Array<{ name: string; description: string }> = [];

    // 0: Agent tool_call — title "Task" is all the adapter has to go on.
    const agentCall = tools.onToolCall(frames[0] as ToolCallUpdate);
    expect(agentCall).toMatchObject({ toolName: "Agent", input: { description: "Task" } });

    // 1: the update that carries the real delegation arguments.
    const agentArgs = tools.onToolCallUpdate(frames[1] as ToolCallProgressUpdate);
    expect(agentArgs.kind).toBe("input");
    if (agentArgs.kind !== "input") throw new Error("unreachable");
    expect(agentArgs.step).toEqual({ name: "Agent", description: 'Agent "count TypeScript files"' });
    steps.push(agentArgs.step!);

    // 2: the subagent's Glob starts while the Agent entry is still pending.
    const globCall = tools.onToolCall(frames[2] as ToolCallUpdate);
    expect(globCall).toMatchObject({
      toolName: "Glob",
      input: { pattern: "**/*.ts", path: "/data00/home/hehuajie/project/remi/src" },
    });

    // 3: a bare toolResponse echo — _meta has no toolName, so the reducer's
    // per-id cache is the only thing that still knows this is Glob.
    expect(tools.onToolCallUpdate(frames[3] as ToolCallProgressUpdate)).toEqual({
      kind: "ignored",
      toolCallId: "toolu_01YZrpUvPqmyKMwwwouj2WZd",
      toolName: "Glob",
    });

    // 4: Glob completes. Two entries are pending; the newest one is the match.
    const globDone = tools.onToolCallUpdate(frames[4] as ToolCallProgressUpdate);
    expect(globDone.kind).toBe("finished");
    if (globDone.kind !== "finished") throw new Error("unreachable");
    expect(globDone.entry).toBe(tools.entries[1]);
    expect(globDone.step!.name).toBe("Glob");
    // The path half of the summary goes through shortPath, which is $HOME-relative.
    expect(globDone.step!.description).toStartWith("Glob `**/*.ts` in `");
    expect(globDone.step!.description).toEndWith("/project/remi/src`");
    steps.push(globDone.step!);

    // 5: Agent's own toolResponse echo — already in seenInputs from frame 1.
    expect(tools.onToolCallUpdate(frames[5] as ToolCallProgressUpdate)).toEqual({
      kind: "ignored",
      toolCallId: "toolu_015zmm7GBgjJXXn8DQAGS5G4",
      toolName: "Agent",
    });

    // 6: Agent completes; its step was already emitted on frame 1.
    const agentDone = tools.onToolCallUpdate(frames[6] as ToolCallProgressUpdate);
    expect(agentDone.kind).toBe("finished");
    if (agentDone.kind !== "finished") throw new Error("unreachable");
    expect(agentDone.entry).toBe(tools.entries[0]);
    expect(agentDone.step).toBeUndefined();
    expect(agentDone.resultPreview).toStartWith("97\nagentId: a4ed016170c8ae738");

    expect(steps).toHaveLength(2);
    expect(tools.toolCount).toBe(2);
    expect(tools.entries.map((e) => [e.name, e.status, e.stepAdded])).toEqual([
      ["Agent", "done", true],
      ["Glob", "done", true],
    ]);
    // The delegation prompt survives the terminal frame, which carries none.
    expect(tools.entries[0].input).toEqual({
      description: "count TypeScript files",
      prompt: "How many .ts files are in the src/ directory? Use Glob and count the results. Reply with just the number.",
    });
  });
});

describe("tool entry reducer — codex collab (codex-collab recording)", () => {
  const frames = toolFrames("codex-collab-notifications-1786010059380.json");

  it("lets the terminal frame enrich a wait call with the subagent answers", () => {
    // Four sequential calls: spawnAgent, spawnAgent, wait, wait.
    expect(frames).toHaveLength(8);
    const tools = createToolEntryReducer(createAdapter("codex"));
    const steps: Array<{ name: string; description: string }> = [];

    for (const frame of frames) {
      if (frame.sessionUpdate === "tool_call") {
        tools.onToolCall(frame as ToolCallUpdate);
        continue;
      }
      const result = tools.onToolCallUpdate(frame as ToolCallProgressUpdate);
      if (result.kind !== "ignored" && result.step) steps.push(result.step);
    }

    // spawnAgent normalizes to Agent; `wait` has no canonical name and passes
    // through. Every step comes from the terminal frame — codex sends no
    // separate argument frame.
    expect(steps).toEqual([
      { name: "Agent", description: 'Agent "Write exactly one original English-language haiku about the sea. Return only the three-line haiku, with no title or commentary."' },
      { name: "Agent", description: 'Agent "Write exactly one original English-language haiku about mountains. Return only the three-line haiku, with no title or commentary."' },
      { name: "wait", description: "wait 1 done" },
      { name: "wait", description: "wait 1 done" },
    ]);

    expect(tools.toolCount).toBe(4);
    expect(tools.entries.map((e) => [e.name, e.status])).toEqual([
      ["Agent", "done"],
      ["Agent", "done"],
      ["wait", "done"],
      ["wait", "done"],
    ]);

    // agentsStates starts empty on every tool_call and is only populated by the
    // terminal frame — the subagent's answer exists nowhere else.
    expect((frames[4].rawInput as Record<string, unknown>).agentsStates).toEqual({});
    expect(tools.entries[2].input?.agentsStates).toEqual({
      "019fd67f-032c-7d80-9eca-e69c0ae2d4a6": {
        status: "completed",
        message: "Snow crowns silent peaks\nClouds drift through the granite dawn\nPines breathe in valleys",
      },
    });
    expect(tools.entries[3].input?.agentsStates).toEqual({
      "019fd67e-f5d8-7041-87ee-6f1d8d52280f": {
        status: "completed",
        message: "Salt winds comb the waves\nMoonlight drifts on deep water\nShells dream beneath foam",
      },
    });
  });
});
