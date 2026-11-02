import type { ElicitationCreateParams, ElicitationPropertySchema, ElicitationResult } from "@shared/contracts/acp-protocol.js";

type Question = { id: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean };
type AskParams = { toolCallId?: string; title?: string; questions: Question[] };
type PlanParams = { toolCallId?: string; name?: string; overview?: string; plan?: string };

export const CURSOR_CANCELLED = { outcome: { outcome: "cancelled" } } as const;

/** Cursor's extension omits sessionId; each Remi process owns one root session. */
export function cursorQuestionForm(sessionId: string, params: AskParams): ElicitationCreateParams {
  if (!Array.isArray(params.questions) || !params.questions.length) throw new Error("Cursor question request has no questions");
  const properties: Record<string, ElicitationPropertySchema> = {};
  for (const [index, question] of params.questions.entries()) {
    if (typeof question.id !== "string" || typeof question.prompt !== "string" || !Array.isArray(question.options)
      || question.options.some((option) => typeof option.id !== "string" || typeof option.label !== "string")) {
      throw new Error("Invalid Cursor question");
    }
    // Remi's question UI displays enum constants, so labels travel through the form;
    // the response converts them back to Cursor's stable option IDs.
    const options = question.options.map((option) => ({ const: option.label }));
    properties[`question_${index}`] = {
      type: question.allowMultiple ? "array" : "string",
      title: params.title,
      description: question.prompt,
      ...(question.allowMultiple ? { items: { anyOf: options } } : { oneOf: options }),
    };
  }
  return {
    mode: "form", sessionId, toolCallId: params.toolCallId,
    message: params.title ?? "Cursor needs your input to continue.",
    requestedSchema: { type: "object", properties, required: Object.keys(properties) },
  };
}

export function cursorQuestionResult(params: AskParams, result: ElicitationResult): Record<string, unknown> {
  if (result.action === "cancel") return CURSOR_CANCELLED;
  if (result.action === "decline") return { outcome: { outcome: "skipped" } };
  const supplied: string[] = [];
  let hasFreeform = false;
  const answers = params.questions.flatMap((question, index) => {
    const value = result.content?.[`question_${index}`];
    const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
      : typeof value === "string" ? [value] : [];
    const exact = selected.flatMap((label) => question.options.filter((option) => option.label === label).map((option) => option.id));
    // Existing Remi multi-select submissions join their labels with commas.
    const selectedOptionIds = exact.length || !question.allowMultiple ? exact
      : question.options.filter((option) => selected.some((label) => label.split(",").map((part) => part.trim()).includes(option.label))).map((option) => option.id);
    const text = selected.join(", ").trim();
    if (text) supplied.push(`${question.prompt}\n${text}`);
    const selectedLabels = question.options.filter((option) => selectedOptionIds.includes(option.id)).map((option) => option.label);
    if (text && (!selectedOptionIds.length || selected.some((label) => !selectedLabels.includes(label)
      && (!question.allowMultiple || !label.split(",").every((part) => selectedLabels.includes(part.trim())))))) {
      hasFreeform = true;
    }
    return selectedOptionIds.length ? [{ questionId: question.id, selectedOptionIds: question.allowMultiple ? selectedOptionIds : selectedOptionIds.slice(0, 1) }] : [];
  });
  // Cursor ACP 2026.10.22 copies only selectedOptionIds into its native Answer;
  // freeformText is omitted even though the underlying protobuf supports it.
  // Its skipped.reason is forwarded verbatim as AskQuestionRejected.reason,
  // so preserve every answer there whenever the user supplied custom text.
  if (hasFreeform) return { outcome: { outcome: "skipped", reason: `The user provided these answers:\n\n${supplied.join("\n\n")}` } };
  return answers.length ? { outcome: { outcome: "answered", answers } } : { outcome: { outcome: "skipped" } };
}

export function cursorPlanForm(sessionId: string, params: PlanParams): ElicitationCreateParams {
  return {
    mode: "form", sessionId, toolCallId: params.toolCallId,
    message: [params.name, params.overview, params.plan].filter((part) => typeof part === "string" && part.trim()).join("\n\n") || "Review Cursor's plan.",
    requestedSchema: {
      type: "object", properties: { decision: { type: "string", title: "Plan", oneOf: [{ const: "Accept plan" }, { const: "Reject plan" }] } },
      required: ["decision"],
    },
  };
}

export function cursorPlanResult(result: ElicitationResult): Record<string, unknown> {
  if (result.action === "cancel") return CURSOR_CANCELLED;
  return { outcome: { outcome: result.action === "accept" && result.content?.decision === "Accept plan" ? "accepted" : "rejected" } };
}
