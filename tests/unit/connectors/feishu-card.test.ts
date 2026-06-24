import { describe, expect, it } from "bun:test";
import { handleButtonClick, handleFormSubmission, registerPendingAction } from "@remi/feishu-channel";
import { approvePlanOption, isPlanApproval, rejectPermissionOption } from "../../../src/connectors/feishu/index.js";
import { buildPlanReviewForm, buildToolApprovalForm, buildFinalCard, FeishuStreamingSession } from "@remi/feishu-channel";

describe("Feishu final card", () => {
  it("preserves final content and stats", () => {
    const card = buildFinalCard({
      text: "Refactoring complete! I've split the config module.",
      stats: "12.0s · 25k/200k · 3 tools",
      toolCount: 3,
    });

    const json = JSON.stringify(card);
    expect(json).toContain("Refactoring complete!");
    expect(json).toContain("12.0s");
    expect(json).toContain("25k/200k");
    expect(json).toContain("3 tools");
  });

  it("keeps submitted plan panels without keeping the decision form", () => {
    const card = buildFinalCard({
      text: "Proceeding with approved plan.",
      retainedPermissionPanels: [{
        hr: { tag: "hr", element_id: "perm_hr_plan1" },
        panel: {
          tag: "collapsible_panel",
          element_id: "perm_plan_plan1",
          header: { title: { tag: "plain_text", content: "Implementation Plan" } },
          elements: [{ tag: "markdown", content: "Plan body stays visible." }],
        },
      }],
    });

    const json = JSON.stringify(card);
    expect(json).toContain("Plan body stays visible.");
    expect(json).not.toContain("form_plan_plan1");
    expect(json).not.toContain("Select action");
  });

  it("uses the shared large feedback input for plan review cards", () => {
    const card = buildFinalCard({
      text: "Review this plan.",
      planReview: { actionId: "plan1", planContent: "Plan body." },
    });

    const json = JSON.stringify(card);
    expect(json).toContain("\"name\":\"feedback_text\"");
    expect(json).toContain("\"input_type\":\"multiline_text\"");
    expect(json).toContain("\"rows\":8");
  });
});

describe("Feishu card actions", () => {
  it("renders ACP tool permission options without choosing a default", () => {
    const form = buildToolApprovalForm("tool1", "Write", "`src/file.ts`", [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ]);

    const columns = ((form.form.elements as any[])[1].columns as any[]);
    const buttonNames = columns.map((column) => column.elements[0].name);
    const values = columns.map((column) => JSON.parse(column.elements[0].value));
    expect(new Set(buttonNames).size).toBe(buttonNames.length);
    expect(values).toContainEqual({ _permission_action_id: "tool1", decision: "allow" });
    expect(values).toContainEqual({ _permission_action_id: "tool1", decision: "reject" });
    const json = JSON.stringify(form);
    expect(json).not.toContain("\"select_static\"");
  });

  it("renders ExitPlanMode feedback as a large multiline input", () => {
    const form = buildPlanReviewForm("plan1", "Plan body.");

    const json = JSON.stringify(form);
    expect(json).toContain("\"name\":\"feedback_text\"");
    expect(json).toContain("\"input_type\":\"multiline_text\"");
    expect(json).toContain("\"max_length\":1000");
    expect(json).toContain("\"rows\":8");
  });

  it("does not guess plan approval options from the first ACP option", () => {
    expect(approvePlanOption([
      { kind: "reject_once", name: "Reject", optionId: "reject" },
    ])).toBeUndefined();
    expect(rejectPermissionOption([
      { kind: "allow_once", name: "Allow", optionId: "allow" },
    ])).toBeUndefined();
  });

  it("requires an explicit plan decision", () => {
    expect(isPlanApproval({ feedback_text: "please approve this" })).toBe(false);
    expect(isPlanApproval({ decision: { value: "approved" }, feedback_text: "" })).toBe(true);
    expect(isPlanApproval({ decision: { value: "rejected" }, feedback_text: "approve later" })).toBe(false);
  });

  it("resolves generic tool permission selections from form values", async () => {
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const actionId = registerPendingAction(resolve, reject, undefined, "chat-1");
      expect(handleFormSubmission(actionId, { decision: { value: "reject" } })).toBe(true);
    });

    await expect(resultPromise).resolves.toEqual({ decision: { value: "reject" } });
  });

  it("resolves form submissions when Feishu returns the form name", async () => {
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const actionId = registerPendingAction(resolve, reject, undefined, "chat-1");
      expect(handleFormSubmission(`form_${actionId}`, { decision: { value: "reject" } })).toBe(true);
    });

    await expect(resultPromise).resolves.toEqual({ decision: { value: "reject" } });
  });

  it("resolves generic tool permission selections from option buttons", async () => {
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const actionId = registerPendingAction(resolve, reject, undefined, "chat-1");
      expect(handleButtonClick(JSON.stringify({
        _permission_action_id: actionId,
        decision: "allow",
      }))).toBe(true);
    });

    await expect(resultPromise).resolves.toEqual({ decision: "allow" });
  });

  it("normalizes select object values for AskUserQuestion answers", async () => {
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const actionId = registerPendingAction(
        resolve,
        reject,
        [
          { question: "Which package manager?", options: [{ label: "bun" }] },
          { question: "Which targets?", options: [{ label: "api" }, { label: "web" }] },
        ],
        "chat-1",
      );

      expect(handleFormSubmission(actionId, {
        q0: { value: "bun", text: { content: "bun" } },
        q0_custom: "",
        q1: [{ value: "api" }, { value: "web" }],
        q1_custom: "",
      })).toBe(true);
    });

    await expect(resultPromise).resolves.toEqual({
      "Which package manager?": "bun",
      "Which targets?": "api, web",
    });
  });

  it("fails permission form rendering when the card patch is rejected", async () => {
    const client = {
      im: {
        message: {
          patch: async () => {
            const err: any = new Error("patch failed");
            err.response = { data: { code: 230099, msg: "invalid card" } };
            throw err;
          },
        },
      },
    };
    const session = new FeishuStreamingSession(client as any, { appId: "app", appSecret: "secret" });
    (session as any).state = {
      cardId: "card-1",
      messageId: "message-1",
      sequence: 1,
      currentText: "",
      currentThinking: "",
      currentStatus: "",
    };

    await expect(session.appendPermissionForm(buildToolApprovalForm("tool1", "Read", "`file`", [
      { kind: "allow_once", name: "Allow", optionId: "allow" },
    ]))).rejects.toThrow("Failed to render permission form");
  });
});
