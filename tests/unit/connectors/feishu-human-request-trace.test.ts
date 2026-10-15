import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import type { TraceItemOf } from "@multiremi/contracts/trace.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { resetQuestionCardHostFixtures } from "./question-card-host-fixture.js";
import { command, completed, item, nativeHarness, started, terminal, turnStarted } from "./feishu-native-harness.js";
afterEach(resetQuestionCardHostFixtures);

// Items exactly as the daemon's trace translator writes them
// (packages/server/src/worker/trace-translator.ts): the item ID is derived from
// the decision, and `message_id` carries the decision message ID itself, the
// only identifier every human-request lookup accepts.
const decisionId = "msg_decision";
const options = [{ option_id: "allow", name: "Allow once", kind: "allow_once" }, { option_id: "deny", name: "Reject", kind: "reject_once" }];
const questions = [{ fieldKey: "question_0", question: {
  question: "Which environment?", header: "Environment", options: [{ label: "staging", description: "pre-production" }], multiSelect: false,
} }];
const requestItem = {
  permission: item("permission", `perm:${decisionId}`, { status: "in_progress", completed_at: null, tool_item_id: "toolu_write",
    title: "Write", message_id: decisionId, options }),
  question: item("question", `q:${decisionId}`, { status: "in_progress", completed_at: null, tool_item_id: "toolu_ask",
    message: "Which environment?", message_id: decisionId, questions }),
} as const;
type Kind = keyof typeof requestItem;

function pending(kind: Kind): MultiremiTaskHumanRequest {
  return { id: decisionId, taskId: "tsk_test", kind, status: "pending", response: null, respondedBy: null,
    createdAt: new Date().toISOString(), respondedAt: null,
    payload: kind === "permission" ? { tool_call: { title: "Write" }, options: options.map(o => ({ optionId: o.option_id, name: o.name, kind: o.kind })) }
      : { questions: questions.map(row => row.question) } };
}
/** Pending on the first read, answered on every later read. */
function lookups(kind: Kind) {
  const reads: string[] = [];
  return { reads, get: async (id: string) => {
    reads.push(id);
    const request = pending(kind);
    return reads.length === 1 ? request : { ...request, status: "responded" as const, respondedBy: "member_one",
      respondedAt: new Date().toISOString(), response: kind === "permission" ? { option_id: "allow" } : { answers: { "Which environment?": "staging" } } };
  } };
}
/** The request opens, is answered, and the turn ends. */
async function* requestStream(kind: Kind) {
  const open = requestItem[kind];
  yield turnStarted(1);
  yield started(2, open);
  yield completed(3, { ...open, status: "completed", completed_at: open.started_at } as TraceItemOf<Kind>);
  yield terminal;
}

describe("Feishu human requests from daemon-shaped trace items", () => {
  it.each(["permission", "question"] as const)("bundled presentation sends, waits on and patches the %s card by message_id", async kind => {
    const h = nativeHarness();
    const lookup = lookups(kind);
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: "tsk_test", getHumanRequest: lookup.get,
    }, { appId: "cli_test", idempotencyKey: "delivery", mentionOpenId: "ou_owner", save: h.save });
    await presentation.consume(requestStream(kind));
    expect(lookup.reads.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lookup.reads)).toEqual(new Set([decisionId]));
    // The checkpoint is keyed by the decision message, never by the item ID.
    expect(Object.keys(h.checkpoint!.interactions)).toEqual([decisionId]);
    expect(h.checkpoint?.interactions[decisionId]).toMatchObject({ waitingStarted: true, waitingFinished: true, receiptStatus: "responded" });
    expect(h.calls.filter(c => c.operation === "patch")).toHaveLength(1);
    const events = h.events();
    expect(JSON.parse(events.find(e => e.event_type === "STEP_STARTED")!.content).stepName)
      .toBe(kind === "question" ? "等待用户回答" : "等待用户审批");
    expect(JSON.parse(events.find(e => e.event_type === "STEP_FINISHED")!.content).stepName).toBe("已收到回复，继续执行");
  });

  it.each(["permission", "question"] as const)("split CoT lane opens and closes the %s waiting step by message_id", async kind => {
    const h = nativeHarness();
    const lookup = lookups(kind);
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: "tsk_test", getHumanRequest: lookup.get,
    }, { appId: "cli_test", idempotencyKey: "delivery", lane: "cot", save: h.save });
    await presentation.consume(requestStream(kind));
    expect(new Set(lookup.reads)).toEqual(new Set([decisionId]));
    const steps = h.events().filter(e => e.event_type === "STEP_STARTED" || e.event_type === "STEP_FINISHED");
    expect(steps.map(e => JSON.parse(e.content).stepName)).toEqual([
      kind === "question" ? "等待用户回答" : "等待用户审批", "已收到回复，继续执行",
    ]);
    // The cards belong to their own lane.
    expect(h.cards()).toEqual([]);
  });

  it("presents a request once although its item has several events, and narrates the text before it", async () => {
    const h = nativeHarness();
    const lookup = lookups("permission");
    async function* stream() {
      yield turnStarted(1);
      yield completed(2, item("agent_message", "msg:ask", { text: "需要写入文件。" }));
      yield started(3, command("toolu_write", "tee app.ts"));
      yield started(4, requestItem.permission);
      yield completed(5, { ...requestItem.permission, status: "completed", completed_at: requestItem.permission.started_at });
      yield completed(6, command("toolu_write", "tee app.ts"));
      yield terminal;
    }
    await new FeishuTaskPresentation(h.client as any, "oc_group", { taskId: "tsk_test", getHumanRequest: lookup.get },
      { appId: "cli_test", idempotencyKey: "delivery", mentionOpenId: "ou_owner", save: h.save }).consume(stream());
    // One request card, its receipt patch and the result: nothing per extra event.
    expect(h.calls.filter(c => ["create", "reply", "patch"].includes(c.operation)).map(c => c.operation)).toEqual(["create", "patch", "create"]);
    expect(lookup.reads.length).toBeGreaterThanOrEqual(2);
    const order = h.events().map(e => e.event_type === "REASONING_MESSAGE_CONTENT" ? JSON.parse(e.content).delta
      : e.event_type === "STEP_STARTED" ? JSON.parse(e.content).stepName : null).filter(Boolean);
    expect(order).toEqual(["需要写入文件。", "等待用户审批", "等待你的审批，处理后继续。"]);
  });

  it("skips a request item without a decision message and a settled request it never presented", async () => {
    const h = nativeHarness();
    const reads: string[] = [];
    async function* stream() {
      yield turnStarted(1);
      yield started(2, { ...requestItem.question, id: "q:orphan", message_id: null });
      // First seen already answered (answered on the web before this delivery started).
      yield completed(3, { ...requestItem.permission, status: "completed", completed_at: requestItem.permission.started_at });
      yield terminal;
    }
    await new FeishuTaskPresentation(h.client as any, "oc_group", { taskId: "tsk_test", getHumanRequest: async id => {
      reads.push(id);
      return { ...pending("permission"), status: "responded" };
    } }, { appId: "cli_test", idempotencyKey: "delivery", save: h.save }).consume(stream());
    expect(reads).toEqual([decisionId]);
    expect(h.cards()).toHaveLength(1); // the result only
    expect(h.events()).toEqual([]);
  });
});
