import type { MultiremiTaskHumanRequest } from '@multiremi/contracts/types.js';
import { IssueDecisionError } from '../repos/issues-repo.js';

/** Produce the fields consumed by provider permission and elicitation handlers. */
export function normalizeHumanResponse(request: MultiremiTaskHumanRequest, response: Record<string, unknown>): Record<string, unknown> {
  const invalid = (): never => { throw new IssueDecisionError(400, 'invalid human response'); };
  const selected = response.selected_options;
  if (selected !== undefined && (!Array.isArray(selected) || selected.some(v => typeof v !== 'string' || !v.trim()))) invalid();
  if (request.kind === 'permission') {
    const value = response.option_id ?? response.optionId ?? (Array.isArray(selected) && selected.length === 1 ? selected[0] : undefined);
    const options = request.payload.options;
    if (typeof value !== 'string' || !value.trim() || !Array.isArray(options)
      || !options.some(o => o && typeof o === 'object' && (o as Record<string, unknown>).optionId === value)) invalid();
    return { ...response, option_id: value };
  }
  const questions = request.payload.questions;
  if (!Array.isArray(questions) || !questions.length) invalid();
  // ACP elicitation carries {fieldKey, question:{question, options}}, while
  // AskUserQuestion's direct payload carries the question object itself.
  const questionRows = (questions as unknown[]).map(row => {
    if (!row || typeof row !== 'object') return invalid();
    const record = row as Record<string, unknown>;
    const value = typeof record.question === 'object' && record.question !== null
      ? record.question as Record<string, unknown> : record;
    if (typeof value.question !== 'string' || !value.question.trim()) return invalid();
    return { ...value, fieldKey: typeof record.fieldKey === 'string' ? record.fieldKey : undefined } as
      { question: string; fieldKey?: string; options?: Array<{ label?: string }> };
  });
  let answers = response.answers;
  if (answers === undefined && Array.isArray(selected) && selected.length) {
    const values: Record<string, string> = {};
    for (const option of selected) {
      let question = questionRows.length === 1 ? questionRows[0] : undefined;
      let answer = option;
      try {
        const value: unknown = JSON.parse(option);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const choice = value as Record<string, unknown>;
          question = questionRows.find(q => q.fieldKey === choice.question || q.question === choice.question);
          if (typeof choice.answer !== 'string') return invalid();
          answer = choice.answer;
        }
      } catch (error) { if (error instanceof IssueDecisionError) throw error; }
      if (!question || !question.options?.some(o => o.label === answer) || question.question in values) return invalid();
      values[question.question] = answer;
    }
    answers = values;
  }
  if (answers === undefined && questionRows.length === 1 && selected === undefined && typeof response.answer === 'string' && response.answer.trim()) {
    answers = { [questionRows[0]!.question]: response.answer };
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) invalid();
  const values = answers as Record<string, unknown>;
  const keys = questionRows.flatMap(q => [q.question, ...(q.fieldKey ? [q.fieldKey] : [])]);
  if (Object.keys(values).some(k => !keys.includes(k))) invalid();
  const normalized: Record<string, string> = {};
  for (const question of questionRows) {
    const byText = values[question.question], byField = question.fieldKey ? values[question.fieldKey] : undefined;
    if (byText !== undefined && byField !== undefined && byText !== byField) invalid();
    const answer = byText ?? byField;
    if (typeof answer !== 'string' || !answer.trim()) return invalid();
    normalized[question.question] = answer;
  }
  return { ...response, answers: normalized };
}
