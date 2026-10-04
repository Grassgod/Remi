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
  if (!Array.isArray(questions) || !questions.length || questions.some(q => !q || typeof q !== 'object'
    || typeof (q as Record<string, unknown>).question !== 'string' || !(q as Record<string, unknown>).question)) invalid();
  const questionRows = questions as Array<{ question: string; options?: Array<{ label?: string }> }>;
  let answers = response.answers;
  if (answers === undefined && questionRows.length === 1 && Array.isArray(selected) && selected.length === 1) {
    const question = questionRows[0]!;
    if (!question.options?.some(o => o.label === selected[0])) invalid();
    answers = { [question.question]: selected[0] };
  }
  if (answers === undefined && questionRows.length === 1 && selected === undefined && typeof response.answer === 'string' && response.answer.trim()) {
    answers = { [questionRows[0]!.question]: response.answer };
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) invalid();
  const values = answers as Record<string, unknown>;
  const keys = questionRows.map(q => q.question);
  if (Object.keys(values).some(k => !keys.includes(k)) || keys.some(k => typeof values[k] !== 'string' || !(values[k] as string).trim())) invalid();
  return { ...response, answers: values };
}
