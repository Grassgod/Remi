export type FeishuDomainName = "feishu" | "lark" | "bytedance";

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  domain?: FeishuDomainName;
  connectionMode?: "ws" | "webhook";
  encryptKey?: string;
  verificationToken?: string;
}

export type {
  BotMenuBehavior,
  BotMenuConfig,
  BotMenuIcon,
  BotMenuItemConfig,
  BotMenuUserConfig,
  ResolvedBotMenuConfig,
  ResolvedBotMenuUserConfig,
} from "@multiremi/contracts/types.js";

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

/** Resolve whether a Feishu sender belongs to the configured Multiremi workspace. */
export type FeishuSenderAuthorizer = (senderOpenId: string) => Promise<boolean>;
