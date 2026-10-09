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
