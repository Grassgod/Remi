import type { IssueTopicConfig } from "@multiremi/contracts/types.js";
import { isFeishuOpenId } from "@shared/feishu-mention.js";

export class IssueTopicConfigError extends Error {
  readonly code = "issue_topic_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "IssueTopicConfigError";
  }
}

export function parseIssueTopicConfig(value: unknown): IssueTopicConfig {
  if (!isRecord(value)) throw new IssueTopicConfigError("issueTopics must be an object");
  if (typeof value.enabled !== "boolean") {
    throw new IssueTopicConfigError("issueTopics.enabled must be a boolean");
  }
  const chatId = cleanString(value.chatId);
  if (value.enabled && !chatId) {
    throw new IssueTopicConfigError("issueTopics.chatId is required when enabled");
  }
  const projectIds = parseProjectIds(value.projectIds);
  const notifyMode = value.notifyMode === undefined ? "group_owner" : value.notifyMode;
  if (notifyMode !== "group_owner" && notifyMode !== "person" && notifyMode !== "none") {
    throw new IssueTopicConfigError("issueTopics.notifyMode must be group_owner, person, or none");
  }
  const notifyOpenId = cleanString(value.notifyOpenId);
  if (notifyMode === "person" && !isFeishuOpenId(notifyOpenId)) {
    throw new IssueTopicConfigError("issueTopics.notifyOpenId must be a bot-scoped open_id when notifyMode is person");
  }
  return {
    enabled: value.enabled,
    chatId: chatId ?? "",
    ...(projectIds ? { projectIds } : {}),
    notifyMode,
    ...(notifyMode === "person" ? { notifyOpenId: notifyOpenId! } : {}),
  };
}

export function readWorkspaceIssueTopics(settings: Record<string, unknown>): IssueTopicConfig {
  return settings.issueTopics === undefined
    ? { enabled: false, chatId: "" }
    : parseIssueTopicConfig(settings.issueTopics);
}

/**
 * The same read, for delivery paths that must never throw (MUL-407).
 *
 * `parseIssueTopicConfig` validates writes, and it is right to reject an
 * unusable `person` target there. A database written before that validation
 * existed (or edited around it) can still hold one, though — and a delivery
 * path that throws on it produces a human request with no delivery at all, so
 * nobody the task asked ever hears about it. An unusable target is treated as
 * "there is no recipient", which the decision lane already knows how to degrade
 * to text.
 */
export function readWorkspaceIssueTopicsForDelivery(settings: Record<string, unknown>): IssueTopicConfig {
  try {
    return readWorkspaceIssueTopics(settings);
  } catch (error) {
    if (!(error instanceof IssueTopicConfigError)) throw error;
    const raw = settings.issueTopics;
    if (!isRecord(raw)) return { enabled: false, chatId: "" };
    // Every field is read defensively: the whole point of this reader is that a
    // stored config cannot abort a delivery, so a second malformed field must not
    // throw here either.
    let projectIds: string[] | undefined;
    try { projectIds = parseProjectIds(raw.projectIds); } catch { projectIds = undefined; }
    return {
      enabled: raw.enabled === true,
      chatId: cleanString(raw.chatId) ?? "",
      ...(projectIds ? { projectIds } : {}),
      // An unrecognised mode falls back to the documented default rather than
      // inventing `person`, which would send the request looking for a target
      // that was never configured.
      notifyMode: raw.notifyMode === "none" ? "none"
        : raw.notifyMode === "person" ? "person" : "group_owner",
      ...(isFeishuOpenId(raw.notifyOpenId) ? { notifyOpenId: raw.notifyOpenId } : {}),
    };
  }
}

function parseProjectIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new IssueTopicConfigError("issueTopics.projectIds must be an array");
  }
  const projectIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const projectId = cleanString(value[index]);
    if (!projectId) {
      throw new IssueTopicConfigError(`issueTopics.projectIds[${index}] must be a non-empty string`);
    }
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    projectIds.push(projectId);
  }
  return projectIds.length ? projectIds : undefined;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
