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
