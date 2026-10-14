"use client";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { paths, useWorkspaceSlug } from "@multiremi/core/paths";
import { AppLink } from "../navigation";
import { useT } from "../i18n";

export function MessageHeader({ message }: {
  message: Partial<Pick<SessionLogRow, "author_type" | "sender_type" | "trigger_source">>;
}) {
  const { t } = useT("messages");
  const slug = useWorkspaceSlug();
  if ((message.sender_type ?? message.author_type) !== "agent") return null;
  const source = message.trigger_source;
  if (!source) return <div data-message-header className="mb-1 text-[11px] text-muted-foreground">{t($ => $.trigger.unknown)}</div>;
  const name = source.actor_name || (source.actor_type === "timer" ? t($ => $.trigger.timer)
    : source.actor_type === "platform" ? t($ => $.trigger.system) : t($ => $.trigger.unknown_actor));
  const actor = source.parent_issue ? t($ => $.trigger.parent_actor, { name, issue: source.parent_issue_key ?? source.issue_key ?? "" }) : name;
  const text = source.actor_type === "timer" ? t($ => $.trigger.scheduled, { name: actor })
    : source.actor_type === "member" ? t($ => $.trigger.comment, { name: actor }) : t($ => $.trigger.by, { name: actor });
  const ws = slug ? paths.workspace(slug) : null;
  const href = ws && source.issue_id
    ? `${ws.issueSession(source.issue_id, source.session_id)}&comment=${encodeURIComponent(source.message_id)}`
    : ws && source.actor_type === "timer" && source.actor_id ? ws.autopilotDetail(source.actor_id) : null;
  return <div data-message-header className="mb-1 min-w-0 text-[11px] text-muted-foreground">
    {href ? <AppLink href={href} className="block truncate hover:underline" title={text}>{text}</AppLink>
      : <span className="block truncate" title={text}>{text}</span>}
  </div>;
}
