"use client";

import { ArrowRightLeft, Cpu } from "lucide-react";
import type { ChatModelDisplay } from "../lib/chat-model";
import { useT } from "../../i18n";

/**
 * The model the chat runs on, read-only, in the composer footer after the
 * agent and work-location pickers: no chevron, no button, no hover. The model
 * is changed in the agent's settings, which the tooltip says.
 *
 * It only takes the room the pickers leave: its slot grows from zero up to
 * `max-w-64` and is its own `@container`, so it never squeezes a picker or
 * the send button. In a narrow slot the name truncates, below 8rem the effort
 * goes (the tooltip keeps it), and below 4.5rem the chip hides.
 */
export function ChatModelChip({ model }: { model: ChatModelDisplay }) {
  const { t } = useT("chat");
  const name = model.modelId ? model.label ?? model.modelId : t(($) => $.model.default);
  const title = [
    model.modelId ?? t(($) => $.model.default_detail),
    model.effort ? t(($) => $.model.effort, { value: model.effort }) : null,
    model.fallback ? t(($) => $.model.fallback) : null,
    t(($) => $.model.settings_hint),
  ].filter(Boolean).join("\n");
  const Icon = model.fallback ? ArrowRightLeft : Cpu;
  return (
    <span data-chat-model-slot="" className="@container/model flex min-w-0 max-w-64 flex-1">
      <span
        data-chat-model=""
        role="group"
        aria-label={`${t(($) => $.model.label)}: ${model.effort ? `${name} · ${model.effort}` : name}`}
        title={title}
        className="flex min-w-0 max-w-full cursor-default select-none items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground @max-[4.5rem]/model:hidden"
      >
        <Icon className={model.fallback ? "size-3.5 shrink-0 text-warning" : "size-3.5 shrink-0"} aria-hidden="true" />
        <span data-chat-model-name="" className="min-w-0 truncate">{name}</span>
        {model.effort && <span className="shrink-0 whitespace-nowrap @max-[8rem]/model:hidden">· {model.effort}</span>}
      </span>
    </span>
  );
}
