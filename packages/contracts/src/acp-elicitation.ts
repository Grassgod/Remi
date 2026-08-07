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
  ElicitationEnumEntry,
  ElicitationPropertySchema,
} from "./acp-protocol.js";

/** A single renderable question (matches the connector's AskUserQuestion shape). */
type AskQuestion = AskUserQuestionData["questions"][number];

/** The agent's free-text field appended after the question fields. */
const CUSTOM_ANSWER_FIELD = "customAnswer";

/**
 * codex-acp appends a free-text companion field named `<questionId>__other` to
 * any question that allows a custom answer (codex-acp dist/index.js:24749,
 * 24885-24895, 25143-25152). It is not a question of its own — codex reads it
 * back in preference to the parent field (dist/index.js:25280), so it has to be
 * folded into the owning question instead of rendered separately.
 */
const OTHER_FIELD_SUFFIX = "__other";

export interface ElicitationQuestion {
  fieldKey: string;
  question: AskQuestion;
  /** Field to post a free-text (non-option) answer to, when the agent offers one. */
  otherFieldKey?: string;
}

function optionFromEnumEntry(entry: ElicitationEnumEntry): AskQuestion["options"][number] {
  const label = entry.const;
  // codex carries the option help text as its own field; claude folds it into
  // the title as "label — description".
  if (entry.description) return { label, description: entry.description };
  const title = entry.title;
  if (title && title.startsWith(`${label} — `)) {
    return { label, description: title.slice(label.length + 3) };
  }
  if (title && title !== label) {
    return { label, description: title };
  }
  return { label };
}

function enumEntries(prop: ElicitationPropertySchema): ElicitationEnumEntry[] | null {
  if (prop.oneOf?.length) return prop.oneOf;
  if (prop.enum?.length) return prop.enum.map((v) => ({ const: v }));
  if (prop.type === "array") {
    if (prop.items?.anyOf?.length) return prop.items.anyOf;
    if (prop.items?.enum?.length) return prop.items.enum.map((v) => ({ const: v }));
  }
  return null;
}

/**
 * The question a `<id>__other` companion field belongs to, or null when the
 * field is a question in its own right. codex tags the companion in `_meta`;
 * the suffix is the fallback for the same field seen without `_meta`.
 */
function otherFieldParent(
  fieldKey: string,
  prop: ElicitationPropertySchema,
  properties: Record<string, ElicitationPropertySchema>,
): string | null {
  const meta = (prop._meta as { codex?: { isOtherAnswer?: boolean; questionId?: string } } | undefined)?.codex;
  if (meta?.isOtherAnswer && meta.questionId && meta.questionId in properties) return meta.questionId;
  if (!fieldKey.endsWith(OTHER_FIELD_SUFFIX)) return null;
  const parent = fieldKey.slice(0, -OTHER_FIELD_SUFFIX.length);
  return parent in properties ? parent : null;
}

/**
 * Convert a form elicitation into renderable questions. Returns null when
 * there is nothing to render (no form schema or no usable fields).
 */
export function elicitationToQuestions(params: ElicitationCreateParams): ElicitationQuestion[] | null {
  if (params.mode !== "form" || !params.requestedSchema?.properties) return null;

  const properties = params.requestedSchema.properties;
  const otherFieldByParent = new Map<string, string>();
  const fields = Object.entries(properties).filter(([key, prop]) => {
    if (key === CUSTOM_ANSWER_FIELD) return false;
    const parent = otherFieldParent(key, prop, properties);
    if (parent === null) return true;
    otherFieldByParent.set(parent, key);
    return false;
  });
  if (fields.length === 0) return null;

  return fields.map(([fieldKey, prop]) => {
    const entries = enumEntries(prop);
    // Single-question elicitations carry the question text in `message`;
    // multi-question ones put it in each field's `description`.
    const question = prop.description
      ?? (fields.length === 1 ? params.message : prop.title ?? fieldKey);
    const otherFieldKey = otherFieldByParent.get(fieldKey);
    return {
      fieldKey,
      ...(otherFieldKey ? { otherFieldKey } : {}),
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
  for (const { fieldKey, otherFieldKey, question } of questions) {
    const text = answers[question.question]?.trim();
    if (!text) continue;
    // A free-text answer to a question that offered an "other" affordance goes
    // to the companion field — that is where codex looks first
    // (codex-acp dist/index.js:25280); the parent field only accepts one of
    // its own option labels.
    const isOption = question.options.some((o) => o.label === text);
    content[otherFieldKey && !isOption ? otherFieldKey : fieldKey] = text;
  }
  return content;
}
