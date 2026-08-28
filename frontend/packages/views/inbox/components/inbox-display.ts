import type {
  AutopilotRunOutcome,
  AutopilotRunTriggerObject,
  InboxItem,
} from "@multiremi/core/types";

export interface InboxDisplayLocalizer {
  locale?: string;
  timeZone?: string;
  scheduled: (time: string) => string;
  repeatedRuns: (title: string, count: number) => string;
}

function singleLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripQuickCreatePrefix(title: string, identifier?: string): string {
  const normalized = singleLine(title);
  if (!normalized) return "";

  if (identifier) {
    const exactPrefix = new RegExp(
      `^Created\\s+${escapeRegExp(identifier)}:\\s*`,
      "i",
    );
    const withoutExactPrefix = normalized.replace(exactPrefix, "");
    if (withoutExactPrefix !== normalized) return withoutExactPrefix.trim();
  }

  return normalized.replace(/^Created\s+[A-Z][A-Z0-9]*-\d+:\s*/i, "").trim();
}

export function getInboxDisplayTitle(
  item: InboxItem,
  localizer?: InboxDisplayLocalizer,
  runCount = 1,
): string {
  const details = item.details ?? {};

  if (item.type === "quick_create_done") {
    const cleanedTitle = stripQuickCreatePrefix(item.title, details.identifier);
    if (cleanedTitle) return cleanedTitle;

    const prompt = singleLine(details.original_prompt);
    if (prompt) return prompt;
  }

  if (item.type === "quick_create_failed") {
    const prompt = singleLine(details.original_prompt);
    if (prompt) return prompt;
  }

  if (
    item.type === "autopilot_run_completed"
    || item.type === "autopilot_run_failed"
  ) {
    const autopilotTitle = singleLine(details.autopilot_title);
    if (autopilotTitle) {
      const triggerLabel = getAutopilotTriggerObjectLabel(item, localizer);
      const title = triggerLabel ? `${autopilotTitle} · ${triggerLabel}` : autopilotTitle;
      return runCount > 1 && localizer
        ? localizer.repeatedRuns(title, runCount)
        : title;
    }
  }

  return item.title;
}

export function getAutopilotRunOutcome(item: InboxItem): AutopilotRunOutcome | null {
  const value = item.details?.outcome;
  if (!isRecord(value)) return null;
  if (!["no_change", "changes", "failed", "unknown"].includes(value.kind)) return null;
  if (!Array.isArray(value.links)) return null;
  if (value.text !== null && typeof value.text !== "string") return null;
  const headline = typeof value.headline === "string" && value.headline.trim()
    ? value.headline.trim()
    : null;
  const links = value.links.flatMap((link) => {
    if (!isRecord(link)) return [];
    if (link.kind !== "pull_request" && link.kind !== "merge_request") return [];
    if (typeof link.url !== "string" || !/^https?:\/\//u.test(link.url)) return [];
    return [{
      kind: link.kind,
      url: link.url,
      ...(typeof link.number === "number" ? { number: link.number } : {}),
    }];
  });
  const counts = isRecord(value.counts)
    ? Object.fromEntries(
      Object.entries(value.counts).filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
      ),
    )
    : null;
  const risks = Array.isArray(value.risks)
    && value.risks.every((risk) => typeof risk === "string")
    ? [...value.risks]
    : [];
  const action = isRecord(value.action)
    && ["none", "review", "retry", "investigate"].includes(String(value.action.kind))
    && (value.action.text === null || typeof value.action.text === "string")
    ? {
      kind: value.action.kind as NonNullable<AutopilotRunOutcome["action"]>["kind"],
      text: value.action.text,
    }
    : null;
  return {
    kind: value.kind as AutopilotRunOutcome["kind"],
    headline,
    text: value.text,
    links,
    counts,
    risks,
    action,
  };
}

export type AutopilotDurationParts =
  | { unit: "seconds"; seconds: number }
  | { unit: "minutes"; minutes: number }
  | { unit: "hours"; hours: number; minutes: number };

export function autopilotDurationParts(value: number): AutopilotDurationParts {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return { unit: "seconds", seconds };

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", minutes };

  return {
    unit: "hours",
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  };
}

export function getAutopilotTriggerObject(
  item: InboxItem,
): AutopilotRunTriggerObject | null {
  const value = item.details?.trigger_object;
  return isAutopilotTriggerObject(value) ? value : null;
}

export function getAutopilotTriggerObjectLabel(
  item: InboxItem,
  localizer?: InboxDisplayLocalizer,
): string | null {
  const trigger = getAutopilotTriggerObject(item);
  if (trigger?.repository_name) {
    if (trigger.change_number != null) return `${trigger.repository_name} #${trigger.change_number}`;
    return trigger.target_branch
      ? `${trigger.repository_name}@${trigger.target_branch}`
      : trigger.repository_name;
  }
  if (item.details?.trigger === "schedule" || trigger?.event_type === "schedule") {
    if (!localizer) return null;
    return localizer.scheduled(triggerTime(
      trigger?.occurred_at ?? item.details?.triggered_at ?? item.created_at,
      localizer.locale,
      localizer.timeZone,
    ));
  }
  return null;
}

function isAutopilotTriggerObject(value: unknown): value is AutopilotRunTriggerObject {
  if (!isRecord(value)) return false;
  return (value.repository_name === null || typeof value.repository_name === "string")
    && (value.change_number === null || typeof value.change_number === "number")
    && (value.target_branch === null || typeof value.target_branch === "string")
    && (value.event_type === null || typeof value.event_type === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function triggerTime(value: string, locale?: string, timeZone?: string): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    try {
      return new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        ...(timeZone ? { timeZone } : {}),
      }).format(date);
    } catch {
      // Preserve the existing UTC fallback for invalid locale/time-zone data.
    }
  }
  const isoTime = value.match(/T(\d{2}:\d{2})/u)?.[1];
  return isoTime ? `${isoTime} UTC` : value;
}

export function getQuickCreateFailureDetail(item: InboxItem): string {
  const details = item.details ?? {};
  return singleLine(details.error) || singleLine(item.body);
}
