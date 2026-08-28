import type {
  BotMenuAudienceTarget,
  BotMenuBehavior,
  BotMenuConfig,
  BotMenuIcon,
  BotMenuItemConfig,
  BotMenuUserConfig,
  BotMenuUserIdType,
  MultiremiUser,
  MultiremiWorkspaceMember,
  ResolvedBotMenuConfig,
  ResolvedBotMenuUserConfig,
} from "@multiremi/contracts/types.js";

const USER_ID_TYPES = new Set<BotMenuUserIdType>(["open_id", "union_id", "user_id"]);
const ROLES = new Set(["owner", "admin", "member"] as const);
const BEHAVIOR_TYPES = new Set<BotMenuBehavior["type"]>(["target", "event_key", "send_message"]);

export class BotMenuConfigError extends Error {
  readonly code = "bot_menu_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "BotMenuConfigError";
  }
}

export function parseBotMenuConfig(value: unknown): BotMenuConfig {
  if (!isRecord(value)) throw new BotMenuConfigError("botMenu must be an object");
  const config: BotMenuConfig = {};
  if (value.default !== undefined) config.default = parseItems(value.default, "default", 0);
  if (value.users !== undefined) {
    if (!Array.isArray(value.users)) throw new BotMenuConfigError("botMenu.users must be an array");
    config.users = value.users.map((entry, index) => parseAudience(entry, index));
  }
  return config;
}

export function readWorkspaceBotMenu(settings: Record<string, unknown>): BotMenuConfig {
  return settings.botMenu === undefined ? {} : parseBotMenuConfig(settings.botMenu);
}

export function resolveBotMenuConfig(
  config: BotMenuConfig,
  workspaceId: string,
  members: readonly MultiremiWorkspaceMember[],
  getUser: (userId: string) => MultiremiUser | null,
): ResolvedBotMenuConfig {
  const resolved = new Map<string, ResolvedBotMenuUserConfig>();
  const audiences = config.users ?? [];

  // Role targets establish the broad policy first. Explicit member/external
  // targets are always more specific and replace a role-derived entry.
  for (const audience of audiences) {
    if (audience.target.type !== "role") continue;
    const role = audience.target.role;
    const matching = members.filter((member) =>
      member.workspaceId === workspaceId
      && !member.archivedAt
      && member.role === role
    );
    for (const member of matching) {
      if (!member.userId) continue;
      const externalId = cleanString(getUser(member.userId)?.externalId);
      if (!externalId) continue;
      resolved.set(`open_id:${externalId}`, resolvedUser(externalId, "open_id", audience));
    }
  }

  for (const audience of audiences) {
    const target = audience.target;
    if (target.type === "role") continue;
    if (target.type === "external") {
      resolved.set(
        `${target.userIdType}:${target.userId}`,
        resolvedUser(target.userId, target.userIdType, audience),
      );
      continue;
    }
    const member = members.find((candidate) =>
      candidate.id === target.memberId
      && candidate.workspaceId === workspaceId
      && !candidate.archivedAt
    );
    if (!member) throw new BotMenuConfigError(`menu member is not active in this workspace: ${target.memberId}`);
    if (!member.userId) throw new BotMenuConfigError(`menu member has no linked user: ${target.memberId}`);
    const externalId = cleanString(getUser(member.userId)?.externalId);
    if (!externalId) throw new BotMenuConfigError(`menu member has no Feishu identity: ${target.memberId}`);
    resolved.set(`open_id:${externalId}`, resolvedUser(externalId, "open_id", audience));
  }

  return {
    ...(config.default ? { default: config.default } : {}),
    ...(resolved.size ? { users: [...resolved.values()] } : {}),
  };
}

function parseAudience(value: unknown, index: number): BotMenuUserConfig {
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.users[${index}] must be an object`);
  return {
    target: parseTarget(value.target, index),
    ...(cleanString(value.label) ? { label: cleanString(value.label)! } : {}),
    items: parseItems(value.items, `users[${index}].items`, 0),
  };
}

function parseTarget(value: unknown, index: number): BotMenuAudienceTarget {
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.users[${index}].target must be an object`);
  if (value.type === "member") {
    const memberId = cleanString(value.memberId);
    if (!memberId) throw new BotMenuConfigError(`botMenu.users[${index}].target.memberId is required`);
    return { type: "member", memberId };
  }
  if (value.type === "role") {
    if (!ROLES.has(value.role as "owner" | "admin" | "member")) {
      throw new BotMenuConfigError(`botMenu.users[${index}].target.role is invalid`);
    }
    return { type: "role", role: value.role as "owner" | "admin" | "member" };
  }
  if (value.type === "external") {
    const userId = cleanString(value.userId);
    if (!userId) throw new BotMenuConfigError(`botMenu.users[${index}].target.userId is required`);
    if (!USER_ID_TYPES.has(value.userIdType as BotMenuUserIdType)) {
      throw new BotMenuConfigError(`botMenu.users[${index}].target.userIdType is invalid`);
    }
    return { type: "external", userId, userIdType: value.userIdType as BotMenuUserIdType };
  }
  throw new BotMenuConfigError(`botMenu.users[${index}].target.type is invalid`);
}

function parseItems(value: unknown, path: string, depth: number): BotMenuItemConfig[] {
  if (!Array.isArray(value)) throw new BotMenuConfigError(`botMenu.${path} must be an array`);
  if (depth > 1) throw new BotMenuConfigError(`botMenu.${path} exceeds two menu levels`);
  return value.map((entry, index) => parseItem(entry, `${path}[${index}]`, depth));
}

function parseItem(value: unknown, path: string, depth: number): BotMenuItemConfig {
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.${path} must be an object`);
  const name = cleanString(value.name);
  if (!name) throw new BotMenuConfigError(`botMenu.${path}.name is required`);
  const children = value.children === undefined ? undefined : parseItems(value.children, `${path}.children`, depth + 1);
  const behaviors = value.behaviors === undefined ? undefined : parseBehaviors(value.behaviors, path);
  const i18nName = parseStringMap(value.i18nName);
  const icon = parseIcon(value.icon, path);
  const tag = cleanString(value.tag);
  if (children?.length && behaviors?.length) {
    throw new BotMenuConfigError(`botMenu.${path} cannot define both children and behaviors`);
  }
  return {
    name,
    ...(i18nName ? { i18nName } : {}),
    ...(icon ? { icon } : {}),
    ...(tag ? { tag } : {}),
    ...(behaviors ? { behaviors } : {}),
    ...(children ? { children } : {}),
  };
}

function parseBehaviors(value: unknown, path: string): BotMenuBehavior[] {
  if (!Array.isArray(value)) throw new BotMenuConfigError(`botMenu.${path}.behaviors must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || !BEHAVIOR_TYPES.has(entry.type as BotMenuBehavior["type"])) {
      throw new BotMenuConfigError(`botMenu.${path}.behaviors[${index}].type is invalid`);
    }
    const type = entry.type as BotMenuBehavior["type"];
    const url = cleanString(entry.url);
    const eventKey = cleanString(entry.eventKey);
    if (type === "target" && !url) throw new BotMenuConfigError(`botMenu.${path}.behaviors[${index}].url is required`);
    if (type === "event_key" && !eventKey) throw new BotMenuConfigError(`botMenu.${path}.behaviors[${index}].eventKey is required`);
    return {
      type,
      ...(url ? { url } : {}),
      ...(eventKey ? { eventKey } : {}),
      ...(typeof entry.isPrimary === "boolean" ? { isPrimary: entry.isPrimary } : {}),
    };
  });
}

function parseIcon(value: unknown, path: string): BotMenuIcon | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new BotMenuConfigError(`botMenu.${path}.icon must be an object`);
  const token = cleanString(value.token);
  const color = cleanString(value.color);
  const fileKey = cleanString(value.fileKey);
  return token || color || fileKey ? {
    ...(token ? { token } : {}),
    ...(color ? { color } : {}),
    ...(fileKey ? { fileKey } : {}),
  } : undefined;
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new BotMenuConfigError("bot menu i18nName must be an object");
  const entries = Object.entries(value)
    .map(([key, entry]) => [key.trim(), cleanString(entry)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function resolvedUser(
  userId: string,
  userIdType: BotMenuUserIdType,
  audience: BotMenuUserConfig,
): ResolvedBotMenuUserConfig {
  return {
    userId,
    userIdType,
    ...(audience.label ? { label: audience.label } : {}),
    items: audience.items,
  };
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
