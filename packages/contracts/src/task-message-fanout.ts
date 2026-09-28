/**
 * The Task fields one message batch's fan-out reads: routing (`workspaceId`,
 * `agentId`), Chat scoping, and the wire payload's `issue_id` /
 * `issue_session_id` / `chat_session_id`. MUL-474 narrowed this from the whole
 * `MultiremiTask` so appending a message no longer has to load the prompt.
 */
export interface TaskMessageFanoutSubject {
  id: string;
  workspaceId: string;
  agentId: string;
  chatSessionId: string | null;
  issueId: string | null;
  issueSessionId: string | null;
}
