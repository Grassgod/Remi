export type FeishuDomainName = "feishu" | "lark" | "bytedance";

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  domain?: FeishuDomainName;
  connectionMode?: "ws" | "webhook";
  encryptKey?: string;
  verificationToken?: string;
}

// ── Bot Menu types ────────────────────────────────────────────

export interface BotMenuBehavior {
  type: "target" | "event_key" | "send_message";
  url?: string;
  eventKey?: string;
  isPrimary?: boolean;
}

export interface BotMenuIcon {
  token?: string;
  color?: string;
  fileKey?: string;
}

export interface BotMenuItemConfig {
  name: string;
  i18nName?: Record<string, string>;
  icon?: BotMenuIcon;
  tag?: string;
  behaviors?: BotMenuBehavior[];
  children?: BotMenuItemConfig[];
}

export interface BotMenuUserConfig {
  userId: string;
  userIdType?: "open_id" | "union_id" | "user_id";
  label?: string;
  items: BotMenuItemConfig[];
}

export interface BotMenuConfig {
  default?: BotMenuItemConfig[];
  users?: BotMenuUserConfig[];
}

/** Group policy interface — injected by remi, not read from config directly. */
export interface GroupPolicy {
  getByChatId(chatId: string): {
    replyMode?: string;
    listenMode?: string;
    monitor?: boolean;
    allowedUserIds?: string[];
    botOpenId?: string;
    projectId?: string | null;
  } | null;
}
