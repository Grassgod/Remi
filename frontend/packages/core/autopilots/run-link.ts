import type { WorkspacePaths } from "../paths";
import type { AutopilotRun } from "../types";

export function getAutopilotRunHref(
  wsPaths: Pick<WorkspacePaths, "issueDetail" | "issueSession" | "chat">,
  run: Pick<AutopilotRun, "issue_id" | "issue_session_id" | "chat_session_id">,
): string | null {
  if (run.issue_id) {
    return run.issue_session_id
      ? wsPaths.issueSession(run.issue_id, run.issue_session_id)
      : wsPaths.issueDetail(run.issue_id);
  }
  return run.chat_session_id ? wsPaths.chat(run.chat_session_id) : null;
}
