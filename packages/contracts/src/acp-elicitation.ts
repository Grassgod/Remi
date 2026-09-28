/**
 * Form elicitation ⇄ AskUserQuestion conversion.
 *
 * Claude ACP agents (>= 0.44.0) convert the built-in AskUserQuestion tool into
 * a form elicitation: each question becomes a `question_<n>` field whose enum
 * options carry the option label as `const` and "label — description" as
 * `title`, plus a companion free-text field for a custom answer. These helpers
 * invert that mapping so connectors can reuse their existing question-form UI,
 * and fold the collected answers back into the response content shape the agent
 * expects.
 *
 * codex-acp sends its synchronous `request_user_input` tool through the same
 * extension, but lays the fields out differently and changed that layout in
 * 1.12: the question text moved from `description` to `title`, and the custom
 * answer companion was renamed from `<id>__other` to `<id>_note` with an
 * explicit `_meta.codex.role = "user_note"` marker.
 * codex-acp 1.13.1: buildUserInputRequest() dist/index.js:32052-32105 and
 * convertUserInputResponse() dist/index.js:32151-32179.
 */

import type { AskUserQuestionData } from "./acp-protocol.js";
import type {
  ElicitationCreateParams,
  ElicitationEnumEntry,
  ElicitationPropertySchema,
} from "./acp-protocol.js";

/** A single renderable question (matches the connector's AskUserQuestion shape). */
type AskQuestion = AskUserQuestionData["questions"][number];

/** The agent's free-text field appended after the question fields (claude-agent-acp < 0.66). */
const CUSTOM_ANSWER_FIELD = "customAnswer";

/**
 * claude-agent-acp >= 0.66.0 replaces the single form-level `customAnswer`
 * with a per-question companion field `question_<n>_custom` (mirroring the
 * CLI's per-question "Other" box; dist/elicitation.js:83). Unlike codex's
 * companions, it is not a question of its own and the agent reads it back in
 * preference to the parent field, so it must be folded into the owning
 * question — left standalone it renders as a required free-text question and
 * blocks form submission.
 */
const CLAUDE_CUSTOM_FIELD_RE = /^(question_\d+)_custom$/;

/**
 * codex-acp 1.11.0 appends a free-text companion field named
 * `<questionId>__other` to any question that allows a custom answer
 * (dist/index.js:26047, tagged at :26384 and read back at :26447). The suffix
 * is a fallback for the same field when its `_meta` marker is absent.
 */
const OTHER_FIELD_SUFFIX = "__other";

/**
 * codex-acp >= 1.12 appends `<questionId>_note` instead, tagged with
 * `_meta.codex = { questionId, role: "user_note" }` (dist/index.js:31756,
 * :32091-32100), and reads it back as `["user_note: <text>"]` (:32165-32169).
 * It is the question's "other" input, not a question of its own.
 */
const NOTE_FIELD_ROLE = "user_note";

/**
 * codex-acp >= 1.12 also appends a synthetic "None of the above" option to
 * every question that allows a custom answer (dist/index.js:32080-32084). The
 * card renders the note field as its own "other" input, so that synthetic
 * option is redundant and hidden whenever the note field was folded in. Only
 * this exact label is filtered: option text a model authored is untouched.
 */
const NONE_OF_THE_ABOVE = "None of the above";

export interface ElicitationQuestion {
  fieldKey: string;
  question: AskQuestion;
  /**
   * Field to post a free-text (non-option) answer to, when the agent offers
   * one: claude's `question_<n>_custom`, codex 1.11's `<id>__other` or
   * codex >= 1.12's `<id>_note`.
   */
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
 * The parts of `_meta.codex` these helpers act on: 1.11's `isOtherAnswer`
 * marker on `<id>__other`, and >= 1.12's `role`/`questionId` on
 * `<id>_note`. Question fields carry `isOther`/`isSecret` too, but the
 * layout is decided per form, so neither changes what is rendered.
 */
interface CodexFieldMeta {
  isOtherAnswer?: boolean;
  questionId?: string;
  role?: string;
}

function codexFieldMeta(prop: ElicitationPropertySchema): CodexFieldMeta | null {
  const codex = (prop._meta as { codex?: unknown } | undefined)?.codex;
  if (!codex || typeof codex !== "object" || Array.isArray(codex)) return null;
  return codex as CodexFieldMeta;
}

/**
 * codex 1.11 and >= 1.12 both tag every field with `_meta.codex`; claude uses
 * its own `_askUserQuestionCustomAnswer` namespace, so its layout is untouched.
 */
function isCodexForm(properties: Record<string, ElicitationPropertySchema>): boolean {
  return Object.values(properties).some((prop) => codexFieldMeta(prop) !== null);
}

/**
 * A 1.11 form is recognisable through its companion field: either the
 * `isOtherAnswer` marker or a `<id>__other` field whose parent question exists.
 * A 1.11 form without a custom answer looks exactly like a >= 1.12 one; the
 * daemon pins codex-acp 1.13.1 (packages/acp/src/runtime-versions.json), so
 * that ambiguity is accepted.
 */
function usesLegacyCodexLayout(properties: Record<string, ElicitationPropertySchema>): boolean {
  return Object.entries(properties).some(([fieldKey, prop]) => {
    if (codexFieldMeta(prop)?.isOtherAnswer === true) return true;
    if (!fieldKey.endsWith(OTHER_FIELD_SUFFIX)) return false;
    return fieldKey.slice(0, -OTHER_FIELD_SUFFIX.length) in properties;
  });
}

/** null = not a codex form (claude); legacy = 1.11; current = >= 1.12. */
function codexFormLayout(
  properties: Record<string, ElicitationPropertySchema>,
): "legacy" | "current" | null {
  if (!isCodexForm(properties)) return null;
  return usesLegacyCodexLayout(properties) ? "legacy" : "current";
}

/**
 * The question a companion field belongs to, or null when the field is a
 * question in its own right. `userNote` marks codex >= 1.12's `<id>_note`
 * companion, whose synthetic "None of the above" option has to be hidden.
 */
function otherFieldParent(
  fieldKey: string,
  prop: ElicitationPropertySchema,
  properties: Record<string, ElicitationPropertySchema>,
): { parent: string; userNote: boolean } | null {
  const meta = codexFieldMeta(prop);
  if (meta?.isOtherAnswer && meta.questionId && meta.questionId in properties) {
    return { parent: meta.questionId, userNote: false };
  }
  if (meta?.role === NOTE_FIELD_ROLE && meta.questionId && meta.questionId in properties) {
    return { parent: meta.questionId, userNote: true };
  }
  const claudeParent = CLAUDE_CUSTOM_FIELD_RE.exec(fieldKey)?.[1];
  if (claudeParent && claudeParent in properties) return { parent: claudeParent, userNote: false };
  if (!fieldKey.endsWith(OTHER_FIELD_SUFFIX)) return null;
  const parent = fieldKey.slice(0, -OTHER_FIELD_SUFFIX.length);
  return parent in properties ? { parent, userNote: false } : null;
}

/**
 * Convert a form elicitation into renderable questions. Returns null when
 * there is nothing to render (no form schema or no usable fields).
 */
export function elicitationToQuestions(params: ElicitationCreateParams): ElicitationQuestion[] | null {
  if (params.mode !== "form" || !params.requestedSchema?.properties) return null;

  const properties = params.requestedSchema.properties;
  const layout = codexFormLayout(properties);
  const otherFieldByParent = new Map<string, string>();
  const userNoteParents = new Set<string>();
  const fields = Object.entries(properties).filter(([key, prop]) => {
    if (key === CUSTOM_ANSWER_FIELD) return false;
    const companion = otherFieldParent(key, prop, properties);
    if (companion === null) return true;
    otherFieldByParent.set(companion.parent, key);
    if (companion.userNote) userNoteParents.add(companion.parent);
    return false;
  });
  if (fields.length === 0) return null;

  return fields.map(([fieldKey, prop]) => {
    const entries = enumEntries(prop);
    const otherFieldKey = otherFieldByParent.get(fieldKey);
    // codex >= 1.12 swaps claude's and 1.11's assignment: the question text is
    // the field title and the short header the description. Its form-level
    // `message` is always "Codex needs your input to continue.", never the
    // question, so it is not consulted for this layout.
    const question = layout === "current"
      ? prop.title ?? fieldKey
      : prop.description
        ?? (fields.length === 1 ? params.message : prop.title ?? fieldKey);
    const header = layout === "current" ? prop.description : prop.title;
    const options = entries ? entries.map(optionFromEnumEntry) : [];
    return {
      fieldKey,
      ...(otherFieldKey ? { otherFieldKey } : {}),
      question: {
        question,
        header,
        options: userNoteParents.has(fieldKey)
          ? options.filter((option) => option.label !== NONE_OF_THE_ABOVE)
          : options,
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
    // (codex-acp 1.13.1 dist/index.js:32165-32169, 1.11.0 :26447); the
    // parent field only accepts one of its own option labels. codex-acp turns a
    // note into `["user_note: <text>"]` on the way back to the model, so the
    // synthetic "None of the above" label is never written to the parent.
    const isOption = question.options.some((o) => o.label === text);
    content[otherFieldKey && !isOption ? otherFieldKey : fieldKey] = text;
  }
  return content;
}
