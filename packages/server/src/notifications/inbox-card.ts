import type { MultiremiInboxItem, MultiremiWorkspace } from "@multiremi/contracts/types.js";

const EVENT_LABELS: Record<string, string> = {
  issue_assigned: "Issue assigned",
  unassigned: "Issue unassigned",
  comment_created: "New issue comment",
  comment_mention: "Mentioned in an issue",
  status_changed: "Issue status changed",
  autopilot_paused: "Autopilot paused",
  autopilot_run_completed: "Autopilot run completed",
  autopilot_run_failed: "Autopilot run failed",
  autopilot_completed: "Autopilot run completed",
  autopilot_failed: "Autopilot run failed",
  inspection_completed: "Inspection completed",
  inspection_failed: "Inspection failed",
  organizer_action: "Organizer acted on a task",
};

const HEADER_TEMPLATES: Record<string, string> = {
  info: "blue",
  attention: "orange",
  warning: "orange",
  error: "red",
  critical: "red",
};

// Feishu cards have no viewer timezone context; this Chinese workspace uses PRC time.
const FEISHU_CARD_TIME_ZONE = "Asia/Shanghai";

export function buildInboxNotificationCard(input: {
  item: MultiremiInboxItem;
  workspace: MultiremiWorkspace | null;
  publicUrl?: string | null;
}): Record<string, unknown> {
  const { item } = input;
  const eventLabel = humanizeEventType(item.type);
  const source = notificationSource(item);
  const autopilot = structuredAutopilotCard(item);
  const summary = autopilot?.plainConclusion ?? truncateSummary(item.body ?? item.title);
  const content = autopilot
    ? [
        `**结论**  ${autopilot.conclusion}`,
        `**触发**  ${autopilot.trigger}`,
        `**处理**  ${autopilot.action}`,
      ].join("\n")
    : [
        `**Event**  ${escapeMarkdown(eventLabel)}`,
        `**Source**  ${escapeMarkdown(source)}`,
        `**Result**  ${escapeMarkdown(summary)}`,
        `**Occurred**  ${escapeMarkdown(formatOccurredAt(item.createdAt))}`,
      ].join("\n");
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content,
    },
  ];
  const detailUrl = notificationDetailUrl(item, input.workspace, input.publicUrl, Boolean(autopilot));
  if (detailUrl) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: autopilot ? "查看详情" : "View details" },
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
  preferInboxItem = false,
): string | null {
  const base = normalizePublicUrl(publicUrl);
  if (!base || !workspace?.slug) return null;
  const workspacePath = encodeURIComponent(workspace.slug);
  if (preferInboxItem) {
    return `${base}/${workspacePath}/inbox?item=${encodeURIComponent(item.id)}`;
  }
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
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
}

export function formatOccurredAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone: FEISHU_CARD_TIME_ZONE,
  }).format(date);
}

function detailsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function escapeMarkdown(value: string): string {
  return value
    .replace(/\n+/gu, " ")
    .split(/(https?:\/\/[^\s]+)/giu)
    .map((part) => /^https?:\/\//iu.test(part)
      ? part
      : part.replace(/[\\`*_[\]]/gu, "\\$&"))
    .join("");
}

interface StructuredAutopilotCard {
  conclusion: string;
  plainConclusion: string;
  trigger: string;
  action: string;
}

function structuredAutopilotCard(item: MultiremiInboxItem): StructuredAutopilotCard | null {
  if (item.type !== "autopilot_run_completed" && item.type !== "autopilot_run_failed") return null;
  const details = detailsRecord(item.details);
  const outcome = detailsRecord(details.outcome);
  const kind = cleanString(outcome.kind);
  if (!kind || !["no_change", "changes", "failed", "unknown"].includes(kind)) return null;

  const headline = cleanString(outcome.headline);
  const text = cleanString(outcome.text);
  const links = Array.isArray(outcome.links)
    ? outcome.links.flatMap((value) => {
        const link = detailsRecord(value);
        const linkKind = cleanString(link.kind);
        const url = safeHttpUrl(cleanString(link.url));
        if (!url || (linkKind !== "pull_request" && linkKind !== "merge_request")) return [];
        const number = typeof link.number === "number" && Number.isFinite(link.number)
          ? link.number
          : null;
        return [{ kind: linkKind, url, number }];
      })
    : [];
  const counts = detailsRecord(outcome.counts);
  const changeCount = typeof counts.changes === "number" && Number.isFinite(counts.changes)
    ? Math.max(0, Math.floor(counts.changes))
    : links.length;
  const linkMarkdown = links.map((link) => {
    const label = `${link.kind === "pull_request" ? "PR" : "MR"}${link.number == null ? "" : ` #${link.number}`}`;
    return `[${label}](${link.url.replace(/\)/gu, "%29")})`;
  });

  let plainConclusion: string;
  if (headline) plainConclusion = headline;
  else if (kind === "no_change") plainConclusion = "本次无变更";
  else if (kind === "failed") plainConclusion = text ? `运行失败：${text}` : "运行失败";
  else if (kind === "changes") plainConclusion = changeCount > 0 ? `产生 ${changeCount} 个改动` : "运行已产生变更";
  else plainConclusion = text ? `运行完成：${text}` : "运行已完成";
  plainConclusion = truncateSummary(plainConclusion);
  const conclusion = [escapeMarkdown(plainConclusion), ...linkMarkdown].join(" · ");

  const triggerObject = detailsRecord(details.trigger_object);
  const repositoryName = cleanString(triggerObject.repository_name);
  const branch = cleanString(triggerObject.target_branch);
  const changeNumber = typeof triggerObject.change_number === "number"
    ? triggerObject.change_number
    : null;
  const eventType = cleanString(triggerObject.event_type);
  const triggerName = repositoryName
    ? changeNumber != null
      ? `${repositoryName} #${changeNumber}`
      : branch
        ? `${repositoryName}@${branch}`
        : repositoryName
    : details.trigger === "schedule" || eventType === "schedule"
      ? "定时运行"
      : eventType ?? cleanString(details.trigger) ?? "未知触发来源";
  const occurredAt = cleanString(triggerObject.occurred_at)
    ?? cleanString(details.triggered_at)
    ?? item.createdAt;
  const trigger = escapeMarkdown(`${triggerName} · ${formatOccurredAt(occurredAt)}`);

  const actionValue = detailsRecord(outcome.action);
  const actionKind = cleanString(actionValue.kind);
  const actionPrefix = actionKind === "review"
    ? "请审阅变更"
    : actionKind === "retry"
      ? "建议重试"
      : actionKind === "investigate"
        ? "需要排查"
        : actionKind === "none"
          ? "无需处理"
          : "请查看运行详情";
  const action = escapeMarkdown(actionPrefix);

  return { conclusion, plainConclusion, trigger, action };
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
