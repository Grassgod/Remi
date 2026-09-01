import { describe, expect, it } from "bun:test";
import { handleTaskStream } from "@connectors/feishu/adapters/task-stream-handler.js";
import { handleButtonClick, handleFormSubmission } from "@connectors/feishu/sdk.js";
import type { TaskStreamEvent } from "@connectors/base.js";

function message(seq: number, type: string, patch: Record<string, unknown> = {}) {
  return {
    id: `msg_${seq}`,
    taskId: "tsk_1",
    seq,
    type,
    tool: null,
    content: null,
    input: null,
    output: null,
    toolCallId: null,
    status: null,
    meta: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...patch,
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
  yield { kind: "message", message: message(8, "usage", { meta: { total_tokens: 42 } }) };
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
  it("preserves intermediate events and responds through the Task human request", async () => {
    const status: string[] = [];
    const steps: Array<[string, string]> = [];
    const humanResponses: Array<[string, Record<string, unknown>]> = [];
    const session = {
      update: async () => {},
      updateThinking: async () => {},
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
      stats: "2s · 42 tokens · 1 tools",
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
