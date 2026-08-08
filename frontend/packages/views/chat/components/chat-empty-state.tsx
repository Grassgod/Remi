"use client";

import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

// Three starter prompts shown on the empty state. Each is keyed into the
// chat namespace so labels translate per locale; the icon stays raw since
// emojis are locale-neutral.
const STARTER_KEYS: ("list_open" | "summarize_today" | "plan_next")[] = [
  "list_open",
  "summarize_today",
  "plan_next",
];
const STARTER_ICONS: Record<(typeof STARTER_KEYS)[number], string> = {
  list_open: "📋",
  summarize_today: "📝",
  plan_next: "💡",
};

export function EmptyState({
  hasSessions,
  agentName,
  noAgent,
  onPickPrompt,
}: {
  hasSessions: boolean;
  agentName?: string;
  /** Server-confirmed "this workspace has zero agents you can chat with".
   *  `handleSend` early-returns without one, so a live starter prompt would
   *  be a button that does nothing — same lockout ChatInput already applies. */
  noAgent: boolean;
  onPickPrompt: (text: string) => void;
}) {
  const { t } = useT("chat");
  // First-time experience: the user has never started a chat in this
  // workspace. Educate before suggesting actions — starter prompts
  // presume the user already knows what chat is for.
  if (!hasSessions) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8">
        <div className="text-center space-y-3">
          <h3 className="text-base font-semibold">
            {t(($) => $.empty_state.first_time_title)}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => $.empty_state.first_time_intro)}{" "}
            <span className="font-medium text-foreground">
              {t(($) => $.empty_state.first_time_pillars)}
            </span>
            {t(($) => $.empty_state.first_time_pillars_suffix)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(($) => $.empty_state.first_time_actions)}
          </p>
        </div>
      </div>
    );
  }

  // Returning user: starter prompts are the fastest path back to action.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-8">
      <div className="text-center space-y-1">
        <h3 className="text-base font-semibold">
          {agentName
            ? t(($) => $.empty_state.returning_title_named, { name: agentName })
            : t(($) => $.empty_state.returning_title_default)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {noAgent
            ? t(($) => $.empty_state.no_agent_hint)
            : t(($) => $.empty_state.returning_subtitle)}
        </p>
      </div>
      <div className="w-full max-w-xs space-y-2">
        {STARTER_KEYS.map((key) => {
          const text = t(($) => $.starter_prompts[key]);
          return (
            <button
              key={key}
              type="button"
              disabled={noAgent}
              onClick={() => onPickPrompt(text)}
              className={cn(
                "w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition-colors",
                noAgent
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-brand/40 hover:bg-accent",
              )}
            >
              <span className="mr-2">{STARTER_ICONS[key]}</span>
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
