import { describe, expect, it } from "bun:test";
import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import { buildTaskInteractionCard, handleTaskInteractionEvent, interactionMarker, parseQuestionAnswers, registerTaskInteraction } from "@connectors/feishu/task-interaction.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { nativeHarness, taskEvent, completed } from "./feishu-native-harness.js";

const questions = [
  { question: "Which features?", multiSelect: true, options: [{ label: "A", description: "First" }, { label: "B" }] },
  { question: "Which environment?", multiSelect: false, options: [{ label: "Staging" }, { label: "Production" }] },
];
function request(kind: "question" | "permission" = "question"): MultiremiTaskHumanRequest {
  return { id: "hr_test", taskId: "tsk_test", kind, status: "pending", response: null, respondedBy: null,
    createdAt: new Date().toISOString(), respondedAt: null,
    payload: kind === "question" ? { questions } : {
      tool_call: { title: "Bash", rawInput: { command: "echo approved" } },
      options: [{ optionId: "allow", name: "允许一次", kind: "allow_once" }, { optionId: "deny", name: "拒绝", kind: "reject_once" }],
    } };
}
const action = (name: string, form_value?: Record<string, unknown>, operator = "ou_owner") => ({
  operator: { open_id: operator }, context: { open_chat_id: "oc_group", open_message_id: "om_request" },
  action: { tag: "button", name, ...(form_value ? { form_value } : {}) },
});
const answered = (r: MultiremiTaskHumanRequest, response: Record<string, unknown>): MultiremiTaskHumanRequest =>
  ({ ...r, status: "responded", response, respondedAt: new Date().toISOString(), respondedBy: "feishu" });

describe("standalone Task interactions", () => {
  it("does not expose unusable buttons when the group recipient could not be resolved", () => {
    const card = JSON.stringify(buildTaskInteractionCard(request(), { displayName: "Remi" }));
    expect(card).not.toContain('"tag":"button"');
    expect(card).not.toContain("<at ");
    expect(card).toContain("工作台处理");
  });

  it("returns within the callback deadline and patches only after the original submission succeeds", async () => {
    const r = request("permission");
    let finish!: (r: MultiremiTaskHumanRequest) => void;
    let writes = 0;
    const registration = registerTaskInteraction({ appId: "cli_test", chatId: "oc_group", messageId: "om_request", recipientOpenId: "ou_owner", request: r,
      submit: () => { writes++; return new Promise(resolve => { finish = resolve; }); } });
    try {
      const result = await handleTaskInteractionEvent("cli_test", action(`${interactionMarker(r.taskId, r.id)}_o0`));
      expect(result).toEqual({ toast: { type: "info", content: "正在提交，请稍候" } });
      expect(registration.current()).toBeUndefined();
      const resolved = answered(r, { option_id: "allow" });
      finish(resolved);
      await Bun.sleep(1);
      expect(registration.current()).toEqual(resolved);
      await handleTaskInteractionEvent("cli_test", action(`${interactionMarker(r.taskId, r.id)}_o1`));
      expect(writes).toBe(1);
    } finally { registration.dispose(); }
  });
  it("renders one neutral checkbox row per option, per-question custom text and one submit", () => {
    const card = buildTaskInteractionCard(request(), { displayName: "Remi", recipientOpenId: "ou_owner" }) as any;
    expect(card.header.subtitle).toBeUndefined();
    const form = card.body.elements.find((e: any) => e.tag === "form");
    expect(form.elements.filter((e: any) => e.tag === "column_set")).toHaveLength(4);
    expect(form.elements.filter((e: any) => e.tag === "input")).toHaveLength(2);
    expect(form.elements.filter((e: any) => e.tag === "button")).toHaveLength(1);
    const json = JSON.stringify(card);
    expect(json).not.toContain("select_static");
    expect(json).not.toContain("tools");
    expect(json).toContain("<at id=ou_owner></at>");
    expect(json).toContain("自定义回答");
  });

  it("combines selected answers with custom text and validates every question", () => {
    expect(parseQuestionAnswers(questions, { q0_option0: true, q0_option1: { checked: true }, q0_custom: "include tests", q1_custom: { value: "Canary" } }))
      .toEqual({ "Which features?": "A、B\n自定义回答：include tests", "Which environment?": "自定义回答：Canary" });
    expect(() => parseQuestionAnswers(questions, { q0_option0: true })).toThrow("问题 2");
    expect(() => parseQuestionAnswers(questions, { q0_option0: true, q1_option0: true, q1_option1: true })).toThrow("只能选择一项");
    expect(() => parseQuestionAnswers(questions, { q0_option0: "not-a-boolean" })).toThrow("选项值无效");
  });

  for (const [choice, selected] of [[0, "allow"], [1, "deny"]] as const) {
    it(`persists ${selected} on the original request before returning a non-interactive receipt`, async () => {
      const r = request("permission");
      const writes: any[] = [];
      const registration = registerTaskInteraction({ appId: "cli_test", chatId: "oc_group", messageId: "om_request", recipientOpenId: "ou_owner", request: r,
        submit: async response => { writes.push({ taskId: r.taskId, requestId: r.id, response }); return answered(r, response); } });
      try {
        const name = `${interactionMarker(r.taskId, r.id)}_o${choice}`;
        const reply = await handleTaskInteractionEvent("cli_test", action(name));
        expect(writes).toEqual([{ taskId: "tsk_test", requestId: "hr_test", response: { option_id: selected } }]);
        expect((reply as any).toast.type).toBe("success");
        expect(JSON.stringify((reply as any).card)).not.toContain('"tag":"button"');
        expect(JSON.stringify((reply as any).card)).not.toContain("<at ");
        await handleTaskInteractionEvent("cli_test", action(name));
        expect(writes).toHaveLength(1);
      } finally { registration.dispose(); }
    });
  }

  it("rejects another operator, chat, message, app or button without resolving the Task", async () => {
    const r = request("permission"); let writes = 0;
    const registration = registerTaskInteraction({ appId: "cli_test", chatId: "oc_group", messageId: "om_request", recipientOpenId: "ou_owner", request: r,
      submit: async response => { writes++; return answered(r, response); } });
    try {
      const name = `${interactionMarker(r.taskId, r.id)}_o0`;
      const events = [action(name, undefined, "ou_other"), { ...action(name), context: { open_chat_id: "oc_other", open_message_id: "om_request" } },
        { ...action(name), context: { open_chat_id: "oc_group", open_message_id: "om_forwarded" } }, action("fr_invalid_o0")];
      for (const event of events) expect((await handleTaskInteractionEvent("cli_test", event) as any).toast.type).not.toBe("success");
      expect((await handleTaskInteractionEvent("cli_other", action(name)) as any).toast.type).not.toBe("success");
      expect(writes).toBe(0);
    } finally { registration.dispose(); }
  });

  it("two simultaneous decisions commit only the first one", async () => {
    const r = request("permission"); const writes: any[] = [];
    let resolve!: (request: MultiremiTaskHumanRequest) => void;
    const registration = registerTaskInteraction({ appId: "cli_test", chatId: "oc_group", messageId: "om_request", recipientOpenId: "ou_owner", request: r,
      submit: response => { writes.push(response); return new Promise(done => { resolve = done; }); } });
    try {
      const first = handleTaskInteractionEvent("cli_test", action(`${interactionMarker(r.taskId, r.id)}_o0`));
      const second = handleTaskInteractionEvent("cli_test", action(`${interactionMarker(r.taskId, r.id)}_o1`));
      expect(writes).toEqual([{ option_id: "allow" }]);
      resolve(answered(r, writes[0]));
      expect(await first).toEqual(await second);
    } finally { registration.dispose(); }
  });

  for (const status of ["responded", "timeout", "cancelled"] as const) {
    it(`rehydrates a saved request message and patches a ${status} receipt after restart`, async () => {
      const h = nativeHarness();
      const r = { ...request(), status, response: status === "responded" ? { answers: { "Which features?": "A", "Which environment?": "Staging" } } : null };
      const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
        taskId: r.taskId, getHumanRequest: async () => r, respondHumanRequest: async () => { throw new Error("must not respond"); },
      }, { appId: "cli_test", idempotencyKey: "delivery", checkpoint: {
        version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: { hr_test: { messageId: "om_existing" } },
      }, save: h.save });
      async function* stream() { yield taskEvent(1, "question_request", { input: { request_id: r.id } }); yield completed; }
      await presentation.consume(stream());
      expect(h.calls.filter(c => c.operation === "patch")).toHaveLength(1);
      expect(h.calls[0]!.input.path.message_id).toBe("om_existing");
      expect(h.checkpoint?.interactions.hr_test?.receiptStatus).toBe(status);
      expect(h.cards()).toHaveLength(2); // the same receipt + independent terminal result
    });
  }

  it("restores the original pending card and submits all answers through its original Task", async () => {
    const h = nativeHarness();
    let r = request();
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: r.taskId, getHumanRequest: async () => r,
      respondHumanRequest: async (id, response) => { expect(id).toBe("hr_test"); r = answered(r, response); return r; },
    }, { appId: "cli_test", idempotencyKey: "delivery", checkpoint: {
      version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactionOpenId: "ou_owner",
      interactions: { hr_test: { messageId: "om_request" } },
    }, save: h.save });
    async function* stream() { yield taskEvent(1, "question_request", { input: { request_id: r.id } }); yield completed; }
    const running = presentation.consume(stream());
    await Bun.sleep(10);
    const response = await handleTaskInteractionEvent("cli_test", action(interactionMarker(r.taskId, r.id),
      { q0_option0: true, q0_option1: true, q1_custom: "Canary" }));
    expect((response as any).toast.type).toBe("success");
    await running;
    expect(r.response).toEqual({ answers: { "Which features?": "A、B", "Which environment?": "自定义回答：Canary" } });
    expect(h.calls.filter(c => ["create", "reply"].includes(c.operation))).toHaveLength(1);
    expect(h.checkpoint?.interactions.hr_test?.messageId).toBe("om_request");
    expect(h.checkpoint?.interactions.hr_test).toMatchObject({ waitingStarted: true, waitingFinished: true, receiptStatus: "responded" });
    const events = h.events();
    const start = events.find(e => e.event_type === "STEP_STARTED");
    const end = events.find(e => e.event_type === "STEP_FINISHED");
    expect(JSON.parse(start!.content).stepName).toBe("等待用户回答");
    expect(JSON.parse(end!.content).stepId).toBe(JSON.parse(start!.content).stepId);
    expect(events.at(-1)?.event_type).toBe("RUN_FINISHED");
    expect(events.filter(e => e.event_type === "RUN_STARTED")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("<at ");
  });

  it("finishes a saved native waiting step after restart without repeating the card or waiting announcement", async () => {
    const h = nativeHarness();
    const r = answered(request("permission"), { option_id: "allow" });
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: r.taskId, getHumanRequest: async () => r, respondHumanRequest: async () => { throw new Error("already answered"); },
    }, { appId: "cli_test", idempotencyKey: "delivery", save: h.save, checkpoint: {
      version: "native_cot_v1", startedAt: Date.now(), throughSeq: 1,
      cot: { status: "active", presentation: "semantic_v1", cotId: "cot_1", messageId: "om_cot", runStarted: true },
      interactions: { hr_test: { messageId: "om_request", waitingStarted: true } },
    } });
    async function* stream() { yield taskEvent(1, "permission_request", { input: { request_id: r.id } }); yield completed; }
    await presentation.consume(stream());
    expect(h.events().filter(e => e.event_type === "STEP_STARTED")).toHaveLength(0);
    expect(h.events().filter(e => e.event_type === "STEP_FINISHED")).toHaveLength(1);
    expect(h.calls.filter(c => c.operation === "POST")).toHaveLength(0);
    expect(h.checkpoint?.interactions.hr_test?.waitingFinished).toBe(true);
  });

  it("accepts a visible card's response even while the native waiting update is blocked", async () => {
    const h = nativeHarness(), original = h.client.request;
    let release!: () => void, blocked = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.client.request = async input => { blocked = true; await pending; return original(input); };
    let r = request("permission");
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_group", {
      taskId: r.taskId, getHumanRequest: async () => r,
      respondHumanRequest: async (_id, response) => { r = answered(r, response); return r; },
    }, { appId: "cli_test", idempotencyKey: "delivery", mentionOpenId: "ou_owner", save: h.save });
    async function* stream() { yield taskEvent(1, "permission_request", { input: { request_id: r.id } }); yield completed; }
    const running = presentation.consume(stream());
    try {
      while (!blocked) await Bun.sleep(1);
      const reply = await handleTaskInteractionEvent("cli_test", {
        ...action(`${interactionMarker(r.taskId, r.id)}_o0`), context: { open_chat_id: "oc_group", open_message_id: "om_1" },
      });
      expect((reply as any).toast.type).toBe("success");
      expect(r.status).toBe("responded");
    } finally { release(); await running; }
    expect(h.checkpoint?.interactions.hr_test?.waitingFinished).toBe(true);
  });

  it("escapes receipt text so a custom answer cannot inject a mention", () => {
    const r = answered(request(), { answers: { "Which features?": "<at id=all></at>", "Which environment?": "prod" } });
    expect(JSON.stringify(buildTaskInteractionCard(r, { receipt: true }))).not.toContain("<at ");
  });
});
