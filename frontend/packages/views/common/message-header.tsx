"use client";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { useT } from "../i18n";

export function MessageHeader({ message, getActorName }: {
  message: Pick<SessionLogRow, "to_type" | "to_ref" | "to_agent_id" | "to_member_id" | "message_kind" | "wake_applied" | "wake_reason">;
  getActorName?: (type: string, id: string) => string;
}) {
  const { t } = useT("messages");
  if (!message.message_kind) return null;
  const ref = message.to_ref ?? "";
  const role = t($ => $.roles, { returnObjects: true }) as Record<string, string>;
  const kinds = t($ => $.kinds, { returnObjects: true }) as Record<string, string>;
  const wakes = t($ => $.wakes, { returnObjects: true }) as Record<string, string>;
  const reasons = t($ => $.wake_reasons, { returnObjects: true }) as Record<string, string>;
  const recipient = message.to_type === "role" ? role[ref] ?? ref
    : message.to_type === "none" ? t($ => $.no_recipient)
    : getActorName?.(message.to_type ?? "", ref) || ref;
  return <div data-message-header className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
    <span className="max-w-48 truncate" title={recipient}>{t($ => $.recipient, { name: recipient })}</span>
    <span className="rounded border px-1.5">{kinds[message.message_kind] ?? message.message_kind}</span>
    {message.wake_applied && <span data-wake-applied={message.wake_applied} title={message.wake_reason ? reasons[message.wake_reason] ?? message.wake_reason : undefined}
      className="rounded bg-muted px-1.5">{wakes[message.wake_applied] ?? message.wake_applied}</span>}
  </div>;
}
