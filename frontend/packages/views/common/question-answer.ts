import type { QuestionView } from "@multiremi/core/api/schemas";

/** Display known answer fields without exposing the provider response envelope. */
export function questionAnswerText(response: Record<string, unknown>, options?: readonly { value: string; label: string }[] | null): string | null {
  if (response.answers && typeof response.answers === "object" && !Array.isArray(response.answers)) {
    const answers = Object.entries(response.answers);
    if (answers.length && answers.every(([, answer]) => typeof answer === "string")) {
      return answers.length === 1 ? String(answers[0]![1]) : answers.map(([question, answer]) => `${question}\n\n${answer}`).join("\n\n");
    }
  }
  if (typeof response.answer === "string") return response.answer;
  if (typeof response.option_id === "string") return options?.find(option => option.value === response.option_id)?.label ?? null;
  if (Array.isArray(response.selected_options) && response.selected_options.every(value => typeof value === "string")) {
    return response.selected_options.map(value => options?.find(option => option.value === value)?.label ?? value).join(", ");
  }
  return null;
}

export function questionReplyText(body: string, metadata?: Record<string, unknown>): string {
  const response = metadata?.human_response;
  if (typeof metadata?.root_question_id !== "string" || !response || typeof response !== "object" || Array.isArray(response)) return body;
  if (body.trim() !== JSON.stringify(response)) return body;
  return questionAnswerText(response as Record<string, unknown>) ?? body;
}

export function questionAnswerBody(answer: { body_md: string; response: Record<string, unknown> }, options?: readonly { value: string; label: string }[] | null): string {
  if (answer.body_md.trim() && answer.body_md.trim() !== JSON.stringify(answer.response)) return answer.body_md;
  return questionAnswerText(answer.response, options) ?? answer.body_md;
}

/** Older read-only history entries can lack the current answer's full envelope. */
export function questionAnswerHistory(question: QuestionView) {
  const answers = question.history.flatMap(event => {
    const raw = event.answer;
    if (!raw || typeof raw !== "object" || !("body_md" in raw) || typeof raw.body_md !== "string") return [];
    const response = "response" in raw && raw.response && typeof raw.response === "object" && !Array.isArray(raw.response)
      ? raw.response as Record<string, unknown> : {};
    const actor = "actor" in raw && raw.actor && typeof raw.actor === "object" && "type" in raw.actor && "id" in raw.actor
      && typeof raw.actor.type === "string" && typeof raw.actor.id === "string" ? { type: raw.actor.type, id: raw.actor.id } : event.actor;
    return [{ body: questionAnswerBody({ body_md: raw.body_md, response }, question.options), actor,
      at: "at" in raw && typeof raw.at === "string" ? raw.at : event.at,
      replyId: "reply_message_id" in raw && typeof raw.reply_message_id === "string" ? raw.reply_message_id : "",
      reason: event.reason, overturn: event.overturn }];
  });
  const current = question.answer;
  if (current) {
    const body = questionAnswerBody(current, question.options);
    if (!answers.some(answer => current.reply_message_id && answer.replyId === current.reply_message_id
      || answer.at === current.at && answer.body === body && answer.actor?.type === current.actor.type && answer.actor?.id === current.actor.id)) {
      answers.push({ body, actor: current.actor, at: current.at, replyId: current.reply_message_id, reason: undefined, overturn: undefined });
    }
  }
  return answers;
}
