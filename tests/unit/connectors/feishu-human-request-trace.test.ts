import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { handleTaskStream } from "@connectors/feishu/adapters/task-stream-handler.js";
import { handleButtonClick, handleFormSubmission } from "@connectors/feishu/sdk.js";
import { resetQuestionCardHostFixtures } from "./question-card-host-fixture.js";
import { nativeHarness, taskEvent, completed } from "./feishu-native-harness.js";
afterEach(resetQuestionCardHostFixtures);

// Trace input exactly as the daemon's human-input handlers write it
// (packages/server/src/worker/daemon.ts): the decision message ID is the only
// request identifier, and it is what every human-request lookup accepts.
const decisionId = "msg_decision";
const toolCall = { sessionUpdate: "tool_call_update", toolCallId: "tool_one", title: "Write", rawInput: { file_path: "/repo/app.ts" } };
const options = [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }];
const questions = [{ fieldKey: "question_0", question: {
  question: "Which environment?", header: "Environment", options: [{ label: "staging", description: "pre-production" }], multiSelect: false,
} }];
const daemonInput = {
  permission: { message_id: decisionId, options, tool_call: toolCall },
  question: { message_id: decisionId, questions },
} as const;
const eventType = (kind: "permission" | "question") => kind === "permission" ? "permission_request" : "question_request";

function pending(kind: "permission" | "question"): MultiremiTaskHumanRequest {
  return { id: decisionId, taskId: "tsk_test", kind, status: "pending", response: null, respondedBy: null,
    createdAt: new Date().toISOString(), respondedAt: null,
    payload: kind === "permission" ? { tool_call: toolCall, options }
      : { questions: questions.map(row => row.question) } };
}
/** Pending on the first read, answered on every later read. */
function lookups(kind: "permission" | "question") {
  const reads: string[] = [];
  return { reads, get: async (id: string) => {
    reads.push(id);
    const request = pending(kind);
    return reads.length === 1 ? request : { ...request, status: "responded" as const, respondedBy: "member_one",
      respondedAt: new Date().toISOString(), response: kind === "permission" ? { option_id: "allow" } : { answers: { "Which environment?": "staging" } } };
  } };
}

describe("Feishu human requests from daemon-shaped trace events", () => {
  it.each(["permission", "question"] as const)("bundled presentation sends, waits on and patches the %s card by decision message ID", async kind => {
    const h = nativeHarness();
    const lookup = lookups(kind);
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: "tsk_test", getHumanRequest: lookup.get, respondHumanRequest: async () => { throw new Error("answered elsewhere"); },
    }, { appId: "cli_test", idempotencyKey: "delivery", mentionOpenId: "ou_owner", save: h.save });
    async function* stream() { yield taskEvent(1, eventType(kind), { input: daemonInput[kind] }); yield completed; }
    await presentation.consume(stream());
    expect(lookup.reads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lookup.reads)).toEqual(new Set([decisionId]));
    expect(h.checkpoint?.interactions[decisionId]).toMatchObject({ waitingStarted: true, waitingFinished: true, receiptStatus: "responded" });
    expect(h.calls.filter(c => c.operation === "patch")).toHaveLength(1);
    const events = h.events();
    expect(JSON.parse(events.find(e => e.event_type === "STEP_STARTED")!.content).stepName)
      .toBe(kind === "question" ? "等待用户回答" : "等待用户审批");
    expect(JSON.parse(events.find(e => e.event_type === "STEP_FINISHED")!.content).stepName).toBe("已收到回复，继续执行");
  });

  it.each(["permission", "question"] as const)("split CoT lane opens and closes the %s waiting step by decision message ID", async kind => {
    const h = nativeHarness();
    const lookup = lookups(kind);
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: "tsk_test", getHumanRequest: lookup.get, respondHumanRequest: async () => { throw new Error("cards use their own lane"); },
    }, { appId: "cli_test", idempotencyKey: "delivery", lane: "cot", save: h.save });
    async function* stream() { yield taskEvent(1, eventType(kind), { input: daemonInput[kind] }); yield completed; }
    await presentation.consume(stream());
    expect(new Set(lookup.reads)).toEqual(new Set([decisionId]));
    const steps = h.events().filter(e => e.event_type === "STEP_STARTED" || e.event_type === "STEP_FINISHED");
    expect(steps.map(e => JSON.parse(e.content).stepName)).toEqual([
      kind === "question" ? "等待用户回答" : "等待用户审批", "已收到回复，继续执行",
    ]);
  });

  it("streaming card renders both forms and answers them by decision message ID", async () => {
    const pendingChecks: string[] = [];
    const responses: Array<[string, Record<string, unknown>]> = [];
    const session = {
      update: async () => {}, updateThinking: async () => {}, updateContextUsage: () => {}, updateExecution: () => {},
      addStep: () => {}, updateStatus: async () => {}, updateStepDesc: () => {}, updateStepDuration: () => {},
      getLastStatus: () => "", removePermissionForm: async () => {}, getElapsed: () => 1,
      appendPermissionForm: async (form: Record<string, unknown>) => {
        const permission = JSON.stringify(form).match(/_permission_action_id\\?"?:\\?"([^"\\]+)/);
        if (permission?.[1]) {
          expect(handleButtonClick(JSON.stringify({ _permission_action_id: permission[1], decision: "allow" }))).toBe(true);
          return;
        }
        expect(handleFormSubmission((form.form as { name: string }).name, { q0: { value: "staging" }, q0_custom: "" })).toBe(true);
      },
    };
    async function* stream(): AsyncGenerator<TaskStreamEvent> {
      yield taskEvent(1, "permission_request", { input: daemonInput.permission });
      yield taskEvent(2, "question_request", { input: daemonInput.question });
    }
    await handleTaskStream(session as any, stream(), "oc_group", {
      taskId: "tsk_test",
      isHumanRequestPending: async id => { pendingChecks.push(id); return true; },
      respondHumanRequest: async (id, response) => {
        responses.push([id, response]);
        return { ...pending("permission"), id, status: "responded", response };
      },
    });
    expect(pendingChecks[0]).toBe(decisionId);
    expect(responses).toEqual([
      [decisionId, { option_id: "allow" }],
      [decisionId, { answers: { "Which environment?": "staging" } }],
    ]);
  });
});
