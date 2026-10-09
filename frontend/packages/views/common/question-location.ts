/** Q access is separate from raw Message/Turn access, including private sources. */
export function questionLocation(inboxItem: (id: string) => string, questionId: string, sourceMessageId?: string) {
  return `${inboxItem(questionId)}&question=${encodeURIComponent(questionId)}${sourceMessageId ? `&question_source=${encodeURIComponent(sourceMessageId)}` : ""}`;
}
