import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import type {
  MultiremiChatLink,
  MultiremiChatSession,
  ResolveExternalChatInput,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class ChatLinksRepo {
  constructor(private ctx: StoreContext) {}

  getOrCreateChatSessionForExternalChat(input: ResolveExternalChatInput): MultiremiChatSession {
    const workspaceId = input.workspaceId.trim();
    const externalChatId = input.externalChatId.trim();
    if (!workspaceId) throw new Error("workspace_id is required");
    if (input.source !== "feishu") throw new Error(`Unsupported external chat source: ${input.source}`);
    if (!externalChatId) throw new Error("external_chat_id is required");

    const resolve = (): MultiremiChatSession => {
      const existing = this.getChatLink(workspaceId, input.source, externalChatId);
      if (existing) return this.requireLinkedSession(existing);

      const session = this.ctx.chat().createChatSession({
        workspaceId,
        creatorId: input.creatorId,
        agentId: input.agentId,
        title: input.title ?? `Feishu ${externalChatId}`,
      });
      this.ctx.db.run(
        `INSERT INTO multiremi_chat_links (
          id, workspace_id, source, external_chat_id, chat_session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [createId("chl"), workspaceId, input.source, externalChatId, session.id, nowIso()],
      );
      return session;
    };

    try {
      return this.ctx.db.transaction(resolve)();
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const raced = this.getChatLink(workspaceId, input.source, externalChatId);
      if (!raced) throw error;
      return this.requireLinkedSession(raced);
    }
  }

  getChatLink(
    workspaceId: string,
    source: "feishu",
    externalChatId: string,
  ): MultiremiChatLink | null {
    const row = this.ctx.db.query(
      `SELECT * FROM multiremi_chat_links
       WHERE workspace_id = ? AND source = ? AND external_chat_id = ?`,
    ).get(workspaceId, source, externalChatId) as Row | null;
    return row ? toChatLink(row) : null;
  }

  private requireLinkedSession(link: MultiremiChatLink): MultiremiChatSession {
    const session = this.ctx.chat().getChatSession(link.chatSessionId);
    if (!session) throw new Error(`Linked chat session not found: ${link.chatSessionId}`);
    return session;
  }
}

function toChatLink(row: Row): MultiremiChatLink {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    source: String(row.source) as MultiremiChatLink["source"],
    externalChatId: String(row.external_chat_id),
    chatSessionId: String(row.chat_session_id),
    createdAt: String(row.created_at),
  };
}

function isUniqueError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return message.includes("unique constraint") || message.includes("duplicate key");
}
