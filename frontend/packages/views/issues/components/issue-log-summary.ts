import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import type { SessionResult } from "@multiremi/core/types";
import { envelopeType, eventSummary, metadataRecord, metadataString, reportOutcome } from "../../common/session-log/event-summary";
import { formatActivity, type IssuesT } from "../utils/format-activity";

/** Shared by system event rows and reply previews, regardless of display preferences. */
export function systemLogSummary(row: SessionLogRow, getActorName: (type: string, id: string) => string,
  taskAgents: ReadonlyMap<string, string>, results: ReadonlyMap<string, SessionResult>, t: IssuesT): string {
  if (row.metadata.type === "workspace_move_cleared") {
    return formatActivity({ type: "activity", id: row.id, action: "workspace_move_cleared", details: row.metadata,
      actor_type: row.sender_type ?? row.author_type, actor_id: row.sender_id ?? row.author_id ?? "", created_at: row.created_at }, t);
  }
  if (row.metadata.envelope || row.id.startsWith("cmt_env_")) {
    const envelope = metadataRecord(row.metadata.envelope);
    const recipient = eventSummary(getActorName("agent", metadataString(envelope.recipient_agent_id)));
    const type = envelopeType(envelope);
    const outcome = reportOutcome(envelope.outcome);
    const source = metadataRecord(envelope.source);
    const reporter = taskAgents.get(metadataString(source.taskId));
    const name = reporter ? eventSummary(getActorName("agent", reporter)) : "";
    const values = { notification: recipient ? t($ => $.log_event.envelope_recipient, { name: recipient }) : t($ => $.log_event.envelope_notice), reporter: name };
    switch (type) {
      case "delegation":
        return outcome === "completed" ? (name ? t($ => $.log_event.envelope_delegation_completed, values) : t($ => $.log_event.envelope_delegation_completed_generic, values))
          : outcome === "failed" ? (name ? t($ => $.log_event.envelope_delegation_failed, values) : t($ => $.log_event.envelope_delegation_failed_generic, values))
          : outcome === "cancelled" ? (name ? t($ => $.log_event.envelope_delegation_cancelled, values) : t($ => $.log_event.envelope_delegation_cancelled_generic, values))
          : t($ => $.log_event.envelope_delegation_progress, values);
      case "child": return outcome === "completed" ? t($ => $.log_event.envelope_child_completed, values)
        : outcome === "failed" ? t($ => $.log_event.envelope_child_failed, values)
        : outcome === "cancelled" ? t($ => $.log_event.envelope_child_cancelled, values) : t($ => $.log_event.envelope_child_updated, values);
      case "dependency_failed": return t($ => $.log_event.envelope_dependency_failed, values);
      case "dependency_ready": return t($ => $.log_event.envelope_dependency_ready, values);
      case "decision_needed": return t($ => $.log_event.envelope_decision_needed, values);
      case "decision_answer": return t($ => $.log_event.envelope_decision_answer, values);
      case "delegation_progress": return t($ => $.log_event.envelope_delegation_progress, values);
      case "relay": return t($ => $.log_event.envelope_relay, values);
      default: return t($ => $.log_event.envelope_generic, values);
    }
  }
  if (row.kind === "turn") {
    const name = eventSummary(getActorName("agent", metadataString(row.metadata.assignee_agent_id))) || t($ => $.log_event.unknown_agent);
    return t($ => $.log_event.inbox_view, { name });
  }
  if (row.kind === "result_published") {
    const result = results.get(metadataString(row.metadata.result_id));
    const title = eventSummary(metadataString(row.metadata.title) || result?.title || "") || t($ => $.detail.result_untitled);
    const publisher = result ? eventSummary(getActorName(result.published_by_type, result.published_by_id ?? "")) : "";
    return `${publisher ? `${publisher} ` : ""}${t($ => $.detail.result_published_activity, { title })}`;
  }
  return eventSummary(row.body_md) || t($ => $.log_event.generic);
}
