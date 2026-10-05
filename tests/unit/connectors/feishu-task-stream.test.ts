import { describe, expect, it } from "bun:test";
import { handleTaskStream } from "@connectors/feishu/adapters/task-stream-handler.js";
import { handleButtonClick, handleFormSubmission } from "@connectors/feishu/sdk.js";
import type { TaskStreamEvent } from "@connectors/base.js";

function message(seq: number, type: string, patch: Record<string, unknown> = {}) {
  const { toolCallId, ...fields } = patch;
  return {
    id: `msg_${seq}`,
    taskId: "tsk_1",
    seq,
    type,
    tool: null,
    content: null,
    input: null,
    output: null,
    tool_call_id: toolCallId as string ?? null,
    status: null,
    meta: null,
    ts: "2026-09-01T00:00:00.000Z",
    ...fields,
  };
}

async function* events(): AsyncGenerator<TaskStreamEvent> {
  yield { kind: "message", message: message(1, "thinking", { content: "Inspecting" }) };
  yield { kind: "message", message: message(2, "plan", {
    meta: { entries: [{ content: "Read code", status: "completed" }, { content: "Edit", status: "in_progress" }] },
  }) };
  yield { kind: "message", message: message(3, "tool_use", {
    tool: "Read",
    toolCallId: "tool_1",
    input: { file_path: "/repo/app.ts" },
  }) };
  yield { kind: "message", message: message(4, "tool_result", {
    toolCallId: "tool_1",
    output: "source",
    status: "completed",
    meta: { duration_ms: 12 },
  }) };
  yield { kind: "message", message: message(5, "permission_request", {
    input: {
      request_id: "hr_1",
      tool_call: { title: "Write", rawInput: { file_path: "/repo/app.ts" } },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
  }) };
  yield { kind: "message", message: message(6, "question_request", {
    input: {
      request_id: "hr_2",
      questions: [{
        fieldKey: "question_0",
        question: {
          question: "Which environment?",
          header: "Environment",
          options: [{ label: "staging", description: "pre-production" }],
          multiSelect: false,
        },
      }],
    },
  }) };
  yield { kind: "message", message: message(7, "text", { content: "Done" }) };
  yield { kind: "message", message: message(8, "usage", { meta: { used: 42, size: 200000 } }) };
  yield {
    kind: "snapshot",
    snapshot: {
      taskId: "tsk_1",
      status: "completed",
      result: "Done",
      error: null,
      sessionId: "ses_1",
      workDir: "/repo",
      usage: [],
    },
  };
}

describe("Feishu canonical Task stream", () => {
  it("updates the existing step when a guessed tool name is refined by use or result", async () => {
    for (const refinementType of ["tool_use", "tool_result"]) {
      const steps: Array<{ tool: string; desc: string }> = [];
      const session = {
        addStep: (tool: string, desc: string) => { steps.push({ tool, desc }); },
        updateStepDesc: (desc: string, tool?: string) => { Object.assign(steps.at(-1)!, { desc, ...(tool ? { tool } : {}) }); },
        updateStatus: async () => {}, getElapsed: () => 1,
      };
      async function* replay(): AsyncGenerator<TaskStreamEvent> {
        yield { kind: "message", message: message(1, "tool_use", { tool: "Grep", toolCallId: "shell" }) };
        yield { kind: "message", message: message(2, refinementType, { tool: "Bash", toolCallId: "shell",
          input: { command: "git grep durable" }, status: "completed" }) };
      }
      const result = await handleTaskStream(session as any, replay(), "chat", { taskId: "tsk_1",
        respondHumanRequest: async () => { throw new Error("unexpected interaction"); } });
      expect(result.toolCount).toBe(1);
      expect(result.toolEntries[0]?.name).toBe("Bash");
      expect(steps).toEqual([{ tool: "Bash", desc: "Bash `$ git grep durable`" }]);
    }
  });

  it("does not replace the current operation when an earlier parallel result refines its name", async () => {
    const steps: Array<{ tool: string; desc: string }> = [];
    const session = {
      addStep: (tool: string, desc: string) => { steps.push({ tool, desc }); },
      updateStepDesc: (desc: string, tool?: string) => { Object.assign(steps.at(-1)!, { desc, ...(tool ? { tool } : {}) }); },
      updateStepDuration: () => { throw new Error("must not finish the current operation"); },
      updateStatus: async () => {}, getElapsed: () => 1,
    };
    async function* replay(): AsyncGenerator<TaskStreamEvent> {
      for (const row of [
        message(1, "tool_use", { tool: "Grep", toolCallId: "shell" }),
        message(2, "tool_use", { tool: "Read", toolCallId: "read", input: { file_path: "/repo/app.ts" } }),
        message(3, "tool_result", { tool: "Bash", toolCallId: "shell", status: "completed",
          input: { command: "git grep durable" }, output: "found", meta: { duration_ms: 50 } }),
      ]) yield { kind: "message", message: row };
    }
    const result = await handleTaskStream(session as any, replay(), "chat", { taskId: "tsk_1",
      respondHumanRequest: async () => { throw new Error("unexpected interaction"); } });
    expect(result.toolEntries.map(entry => entry.name)).toEqual(["Bash", "Read"]);
    expect(steps.at(-1)?.tool).toBe("Read");
    expect(steps.at(-1)?.desc).toContain("/repo/app.ts");
  });

  it("refines one tool without completing partial output or mixing narration/child prose into the answer", async () => {
    const updates: string[] = [];
    const status: string[] = [];
    const context: unknown[] = [];
    const session = {
      update: async (value: string) => { updates.push(value); }, updateThinking: async () => {},
      updateContextUsage: (value: unknown) => { context.push(value); }, updateExecution: () => {},
      addStep: () => {}, updateStatus: async (value: string) => { status.push(value); },
      updateStepDesc: () => {}, updateStepDuration: () => {}, getElapsed: () => 2,
    };
    async function* replay(): AsyncGenerator<TaskStreamEvent> {
      for (const row of [
        message(1, "text", { content: "Checking.", meta: { phase: "commentary" } }),
        message(2, "tool_use", { tool: "Bash", toolCallId: "shell" }),
        message(3, "tool_result", { tool: "Bash", toolCallId: "shell", status: "in_progress", output: "partial",
          input: { command: "git status --short" } }),
        message(4, "tool_use", { tool: "Bash", toolCallId: "shell", input: { description: "检查状态" } }),
        message(5, "tool_result", { tool: "Bash", toolCallId: "shell", status: "cancelled" }),
        message(6, "usage", { meta: { used: 100, size: 200 } }),
        message(7, "usage", { meta: { used: 1, size: 2, parent_tool_call_id: "agent" } }),
        message(8, "text", { content: "Child answer", meta: { phase: "final", parent_tool_call_id: "agent" } }),
        message(9, "text", { content: "Done.", meta: { phase: "final" } }),
      ]) yield { kind: "message", message: row };
    }
    const result = await handleTaskStream(session as any, replay(), "chat", {
      taskId: "tsk_1", respondHumanRequest: async () => { throw new Error("unexpected interaction"); },
    });
    expect(result).toMatchObject({ contentText: "Done.", toolCount: 1, stats: "2s · 100/200 · 1 tools" });
    expect(result.toolEntries[0]?.input).toEqual({ command: "git status --short", description: "检查状态" });
    expect(status.filter(value => value === "Thinking...")).toEqual([]);
    expect(status).toContain("Tool cancelled");
    expect(context).toEqual([{ used: 100, size: 200 }]);
    expect(updates).toEqual(["Done."]);
  });

  it("preserves intermediate events and responds through the Task human request", async () => {
    const status: string[] = [];
    const steps: Array<[string, string]> = [];
    const humanResponses: Array<[string, Record<string, unknown>]> = [];
    const session = {
      update: async () => {},
      updateThinking: async () => {},
      updateContextUsage: () => {},
      updateExecution: () => {},
      addStep: (name: string, description: string) => { steps.push([name, description]); },
      updateStatus: async (value: string) => { status.push(value); },
      updateStepDesc: () => {},
      updateStepDuration: () => {},
      getLastStatus: () => status.at(-1) ?? "",
      appendPermissionForm: async (form: Record<string, unknown>) => {
        const json = JSON.stringify(form);
        const permission = json.match(/_permission_action_id\\?"?:\\?"([^"\\]+)/);
        if (permission?.[1]) {
          expect(handleButtonClick(JSON.stringify({
            _permission_action_id: permission[1],
            decision: "allow_once",
          }))).toBe(true);
          return;
        }
        const formName = (form.form as { name?: string } | undefined)?.name;
        expect(formName).toBeTruthy();
        expect(json).toContain("Which environment?");
        expect(json).toContain("pre-production");
        expect(handleFormSubmission(formName!, {
          q0: { value: "staging" },
          q0_custom: "",
        })).toBe(true);
      },
      removePermissionForm: async () => {},
      getElapsed: () => 2,
    };

    const result = await handleTaskStream(session as any, events(), "chat_1", {
      taskId: "tsk_1",
      respondHumanRequest: async (requestId, response) => {
        humanResponses.push([requestId, response]);
        return {
          id: requestId,
          taskId: "tsk_1",
          kind: "permission",
          payload: {},
          status: "responded",
          response,
          respondedBy: "feishu",
          createdAt: "2026-09-01T00:00:00.000Z",
          respondedAt: "2026-09-01T00:00:01.000Z",
        };
      },
    });

    expect(result).toMatchObject({
      contentText: "Done",
      thinkingText: "Inspecting",
      toolCount: 1,
      sessionId: "ses_1",
      stats: "2s · 42/200k · 1 tools",
    });
    expect(result.toolEntries[0]).toMatchObject({ name: "Read", status: "done", resultPreview: "source" });
    expect(steps.some(([name]) => name === "Read")).toBe(true);
    expect(status).toContain("Plan (1/2)\n✓ Read code\n→ Edit");
    expect(humanResponses).toEqual([
      ["hr_1", { option_id: "allow_once" }],
      ["hr_2", { answers: { "Which environment?": "staging" } }],
    ]);
  });
});
