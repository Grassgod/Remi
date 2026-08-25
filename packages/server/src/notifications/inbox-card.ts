import type { MultiremiInboxItem, MultiremiWorkspace } from "@multiremi/contracts/types.js";

const EVENT_LABELS: Record<string, string> = {
  issue_assigned: "Issue assigned",
  unassigned: "Issue unassigned",
  comment_created: "New issue comment",
  comment_mention: "Mentioned in an issue",
  status_changed: "Issue status changed",
  autopilot_paused: "Autopilot paused",
  autopilot_completed: "Autopilot run completed",
  autopilot_failed: "Autopilot run failed",
  inspection_completed: "Inspection completed",
  inspection_failed: "Inspection failed",
};

const HEADER_TEMPLATES: Record<string, string> = {
  info: "blue",
  attention: "orange",
  warning: "orange",
  error: "red",
  critical: "red",
};

export function buildInboxNotificationCard(input: {
  item: MultiremiInboxItem;
  workspace: MultiremiWorkspace | null;
  publicUrl?: string | null;
}): Record<string, unknown> {
  const { item } = input;
  const eventLabel = humanizeEventType(item.type);
  const source = notificationSource(item);
  const summary = truncateSummary(item.body ?? item.title);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: [
        `**Event**  ${escapeMarkdown(eventLabel)}`,
        `**Source**  ${escapeMarkdown(source)}`,
        `**Result**  ${escapeMarkdown(summary)}`,
        `**Occurred**  ${escapeMarkdown(formatOccurredAt(item.createdAt))}`,
      ].join("\n"),
    },
  ];
  const detailUrl = notificationDetailUrl(item, input.workspace, input.publicUrl);
  if (detailUrl) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "View details" },
      type: "primary",
      behaviors: [{ type: "open_url", default_url: detailUrl }],
    });
  }
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: item.title || eventLabel },
      template: HEADER_TEMPLATES[item.severity.toLowerCase()] ?? "blue",
      icon: { tag: "standard_icon", token: "bell_outlined", color: "grey" },
    },
    config: {
      width_mode: "fill",
      summary: { content: `${eventLabel}: ${summary}`.slice(0, 200) },
    },
    body: { elements },
  };
}

export function humanizeEventType(type: string): string {
  const known = EVENT_LABELS[type];
  if (known) return known;
  return type
    .split(/[_:\-]+/u)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ") || "Notification";
}

function notificationSource(item: MultiremiInboxItem): string {
  if (item.issue) return `${item.issue.key}: ${item.issue.title}`;
  const details = detailsRecord(item.details);
  for (const key of ["autopilot_title", "schedule_name", "inspection_name", "task_name"]) {
    const value = cleanString(details[key]);
    if (value) return value;
  }
  const autopilotId = cleanString(details.autopilot_id);
  if (autopilotId) return `Autopilot ${autopilotId}`;
  return item.title || "Multiremi";
}

function notificationDetailUrl(
  item: MultiremiInboxItem,
  workspace: MultiremiWorkspace | null,
  publicUrl: string | null | undefined,
): string | null {
  const base = normalizePublicUrl(publicUrl);
  if (!base || !workspace?.slug) return null;
  const workspacePath = encodeURIComponent(workspace.slug);
  if (item.issueId) {
    return `${base}/${workspacePath}/issues/${encodeURIComponent(item.issueId)}`;
  }
  const details = detailsRecord(item.details);
  const autopilotId = cleanString(details.autopilot_id);
  if (autopilotId) {
    return `${base}/${workspacePath}/autopilots/${encodeURIComponent(autopilotId)}`;
  }
  return null;
}

function normalizePublicUrl(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().replace(/\/+$/u, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().replace(/\/+$/u, "") : null;
  } catch {
    return null;
  }
}

function truncateSummary(value: string): string {
  const normalized = value.trim() || "No additional details";
  return normalized.length > 1_500 ? `${normalized.slice(0, 1_497)}...` : normalized;
}

function formatOccurredAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function detailsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!>|~]/gu, "\\$&").replace(/\n+/gu, " ");
}
