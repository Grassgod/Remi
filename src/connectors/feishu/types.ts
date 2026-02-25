/**
 * Feishu connector type definitions.
 */

export type FeishuDomain = "feishu" | "lark" | (string & {});
export type FeishuConnectionMode = "websocket";

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export type FeishuSendResult = {
  messageId: string;
  chatId: string;
};

export type FeishuProbeResult = {
  ok: boolean;
  error?: string;
  appId?: string;
  botName?: string;
  botOpenId?: string;
};

export type FeishuMediaInfo = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  placeholder: string;
};

/** Raw Feishu message event from WebSocket / EventDispatcher. */
export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

/** Parsed context from a Feishu message event. */
export type FeishuMessageContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  senderName?: string;
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  rootId?: string;
  parentId?: string;
  content: string;
  contentType: string;
};
