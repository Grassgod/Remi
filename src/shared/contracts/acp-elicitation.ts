/**
 * Form elicitation ⇄ AskUserQuestion conversion.
 *
 * Claude ACP agents (>= 0.44.0) convert the built-in AskUserQuestion tool into
 * a form elicitation: each question becomes a `question_<n>` field whose enum
 * options carry the option label as `const` and "label — description" as
 * `title`, plus a trailing free-text `customAnswer` field. These helpers invert
 * that mapping so connectors can reuse their existing question-form UI, and
 * fold the collected answers back into the response content shape the agent
 * expects.
 */

import type { AskUserQuestionData } from "./acp-protocol.js";
import type {
  ElicitationCreateParams,
  ElicitationPropertySchema,
} from "./acp-protocol.js";

/** A single renderable question (matches the connector's AskUserQuestion shape). */
type AskQuestion = AskUserQuestionData["questions"][number];

/** The agent's free-text field appended after the question fields. */
const CUSTOM_ANSWER_FIELD = "customAnswer";

export interface ElicitationQuestion {
  fieldKey: string;
  question: AskQuestion;
}

function optionFromEnumEntry(entry: { const: string; title?: string }): AskQuestion["options"][number] {
  const label = entry.const;
  const title = entry.title;
  if (title && title.startsWith(`${label} — `)) {
    return { label, description: title.slice(label.length + 3) };
  }
  if (title && title !== label) {
    return { label, description: title };
  }
  return { label };
}

function enumEntries(prop: ElicitationPropertySchema): Array<{ const: string; title?: string }> | null {
  if (prop.oneOf?.length) return prop.oneOf;
  if (prop.enum?.length) return prop.enum.map((v) => ({ const: v }));
  if (prop.type === "array") {
    if (prop.items?.anyOf?.length) return prop.items.anyOf;
    if (prop.items?.enum?.length) return prop.items.enum.map((v) => ({ const: v }));
  }
  return null;
}

/**
 * Convert a form elicitation into renderable questions. Returns null when
 * there is nothing to render (no form schema or no usable fields).
 */
export function elicitationToQuestions(params: ElicitationCreateParams): ElicitationQuestion[] | null {
  if (params.mode !== "form" || !params.requestedSchema?.properties) return null;

  const fields = Object.entries(params.requestedSchema.properties)
    .filter(([key]) => key !== CUSTOM_ANSWER_FIELD);
  if (fields.length === 0) return null;

  return fields.map(([fieldKey, prop]) => {
    const entries = enumEntries(prop);
    // Single-question elicitations carry the question text in `message`;
    // multi-question ones put it in each field's `description`.
    const question = prop.description
      ?? (fields.length === 1 ? params.message : prop.title ?? fieldKey);
    return {
      fieldKey,
      question: {
        question,
        header: prop.title,
        options: entries ? entries.map(optionFromEnumEntry) : [],
        multiSelect: prop.type === "array",
      },
    };
  });
}

/**
 * Fold connector answers (keyed by question text, as produced by the form
 * submission handlers) back into elicitation response content keyed by the
 * original field names. Empty answers are omitted, matching the agent's
 * "skipped" handling.
 */
export function answersToElicitationContent(
  questions: ElicitationQuestion[],
  answers: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const { fieldKey, question } of questions) {
    const text = answers[question.question]?.trim();
    if (text) content[fieldKey] = text;
  }
  return content;
}
