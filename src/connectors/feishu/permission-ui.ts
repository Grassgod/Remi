/**
 * Permission UI builders for streaming cards.
 *
 * Three form types:
 * - Tool approval: Allow/Deny buttons
 * - AskUserQuestion: select + custom input + Submit
 * - ExitPlanMode: plan content + feedback input + Approve/Deny buttons
 */

import type { AskUserQuestion } from "../../providers/base.js";
import type { PermissionOption } from "../../providers/acp/protocol.js";

export interface AskUserQuestionData {
  questions: AskUserQuestion[];
}

export interface PermissionFormElements {
  hr: Record<string, unknown>;
  form: Record<string, unknown>;
  panel?: Record<string, unknown>;
}

function buttonTypeForPermissionOption(option: PermissionOption): string {
  const text = `${option.kind} ${option.optionId} ${option.name ?? ""}`.toLowerCase();
  if (text.includes("reject") || text.includes("deny")) return "danger";
  if (
    text.includes("allow") ||
    text.includes("approve") ||
    text.includes("accept") ||
    text.includes("default") ||
    text.includes("auto")
  ) {
    return "primary";
  }
  return "default";
}

export function buildToolApprovalForm(
  actionId: string,
  toolName: string,
  inputSummary: string,
  options: PermissionOption[],
): PermissionFormElements {
  return {
    hr: { tag: "hr", element_id: `perm_hr_${actionId}` },
    form: {
      tag: "form",
      name: `form_${actionId}`,
      element_id: `perm_${actionId}`,
      elements: [
        { tag: "markdown", content: `**${toolName}**\n\n${inputSummary}` },
        {
          tag: "column_set",
          flex_mode: "none",
          columns: options.map((option, index) => ({
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [{
              tag: "button",
              name: `${actionId}_${index}`,
              text: { tag: "plain_text", content: option.name || option.optionId },
              type: buttonTypeForPermissionOption(option),
              value: JSON.stringify({
                _permission_action_id: actionId,
                decision: option.optionId,
              }),
            }],
          })),
        },
      ],
    },
  };
}

export function buildAskQuestionForm(
  actionId: string,
  data: AskUserQuestionData,
): PermissionFormElements {
  const formElements: Record<string, unknown>[] = [];
  for (let i = 0; i < data.questions.length; i++) {
    const q = data.questions[i];
    const optionLines = (q.options ?? []).map((opt) =>
      opt.description ? `- **${opt.label}** — ${opt.description}` : `- ${opt.label}`
    );
    formElements.push({
      tag: "markdown",
      content: `**${data.questions.length > 1 ? `${i + 1}. ` : ""}${q.question}**\n${optionLines.join("\n")}`,
    });
    if (q.options && q.options.length > 0) {
      formElements.push({
        tag: q.multiSelect ? "multi_select_static" : "select_static",
        name: `q${i}`,
        placeholder: { tag: "plain_text", content: q.multiSelect ? "可多选..." : "请选择..." },
        options: q.options.map((opt) => ({
          text: { tag: "plain_text", content: opt.label },
          value: opt.label,
        })),
      });
    }
    formElements.push({
      tag: "input",
      input_type: "multiline_text",
      name: `q${i}_custom`,
      placeholder: { tag: "plain_text", content: "或自定义回答..." },
      max_length: 500,
      rows: 3,
    });
  }
  formElements.push({
    tag: "button",
    name: actionId,
    text: { tag: "plain_text", content: "Submit" },
    type: "primary",
    form_action_type: "submit",
  });

  return {
    hr: { tag: "hr", element_id: `perm_hr_${actionId}` },
    form: {
      tag: "form",
      name: `form_${actionId}`,
      element_id: `perm_${actionId}`,
      elements: formElements,
    },
  };
}

export function buildPlanReviewForm(
  actionId: string,
  planContent?: string,
): PermissionFormElements {
  const panel = planContent ? {
    tag: "collapsible_panel",
    expanded: true,
    element_id: `perm_plan_${actionId}`,
    header: { title: { tag: "plain_text", content: "Implementation Plan" } },
    border: { color: "grey" },
    elements: [{
      tag: "markdown",
      content: planContent.length > 3000
        ? planContent.slice(0, 3000) + "\n\n*(...truncated)*"
        : planContent,
    }],
  } : undefined;

  return {
    hr: { tag: "hr", element_id: `perm_hr_${actionId}` },
    panel,
    form: {
      tag: "form",
      name: `form_${actionId}`,
      element_id: `perm_${actionId}`,
      elements: [
        {
          tag: "select_static",
          name: "decision",
          placeholder: { tag: "plain_text", content: "Select action..." },
          options: [
            { text: { tag: "plain_text", content: "Approve" }, value: "approved" },
            { text: { tag: "plain_text", content: "Deny" }, value: "rejected" },
          ],
        },
        {
          tag: "input",
          input_type: "multiline_text",
          name: "feedback_text",
          placeholder: { tag: "plain_text", content: "Feedback or changes (optional)..." },
          max_length: 1000,
          rows: 8,
        },
        {
          tag: "button",
          name: actionId,
          text: { tag: "plain_text", content: "Submit" },
          type: "primary",
          form_action_type: "submit",
        },
      ],
    },
  };
}
