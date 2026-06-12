/**
 * Lark (Feishu) inbound webhook — the minimal chatops closed loop:
 *   1. url_verification handshake (Feishu's webhook setup challenge echo);
 *   2. im.message.receive_v1 → create an issue in the installation's workspace.
 *
 * This is the MINIMAL loop. Not yet ported (follow-up): event signature/AES
 * verification, dedup, the WS long-connection, the bound-user attribution (uses
 * the workspace owner for now), and the agent dispatch reply. Public endpoint
 * (Feishu calls it) — NOT behind the /api/* JWT gate.
 */

import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import { createIssue, nextIssueNumber, getWorkspacePrefix } from "../../db/queries/issues.js";
import { getLarkInstallationByAppId, getWorkspaceOwner } from "../../db/queries/lark.js";
import { bus } from "../../realtime/bus.js";
import { boxFromEnv } from "../../util/secretbox.js";
import { LarkClient } from "../../lark/client.js";

/** Sends an outbound Feishu reply. Injectable so tests skip the network. */
export interface LarkReplier {
  reply(appId: string, appSecret: string, chatId: string, text: string): Promise<void>;
}

const defaultReplier: LarkReplier = {
  async reply(appId, appSecret, chatId, text) {
    await new LarkClient(appId, appSecret).replyText(chatId, text);
  },
};

/** Env var holding the base64 AES-256-GCM key that decrypts app secrets. */
const LARK_SECRET_KEY_ENV = "MULTIMIRA_LARK_SECRET_KEY";

function extractText(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return typeof parsed.text === "string"
      ? parsed.text.replace(/@_user_\d+/g, "").replace(/@_all/g, "").trim()
      : "";
  } catch {
    return "";
  }
}

export function larkRoutes(db?: Db, replier: LarkReplier = defaultReplier): Hono {
  const r = new Hono();

  r.post("/webhook", async (c) => {
    let body: Record<string, any>;
    try {
      body = (await c.req.json()) as Record<string, any>;
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    // 1. Feishu webhook-URL verification handshake.
    if (body.type === "url_verification" && typeof body.challenge === "string") {
      return c.json({ challenge: body.challenge });
    }

    if (!db) return c.json({ error: "database not configured" }, 503);

    // 2. Inbound message → create an issue in the bound workspace.
    if (body.header?.event_type === "im.message.receive_v1") {
      const appId: string | undefined = body.header?.app_id;
      const inst = appId ? await getLarkInstallationByAppId(db, appId) : null;
      if (!inst) return c.json({ ok: true }); // unknown app → ack + ignore

      const text = extractText(body.event?.message?.content) || "Feishu request";
      const owner = await getWorkspaceOwner(db, inst.workspaceId);
      if (!owner) return c.json({ ok: true });

      const number = await nextIssueNumber(db, inst.workspaceId);
      const created = await createIssue(db, {
        workspaceId: inst.workspaceId,
        title: text.slice(0, 200),
        creatorType: "member",
        creatorId: owner.userId,
        number,
        originType: "lark_chat",
      });
      bus.publish({ type: "issue.created", workspaceId: inst.workspaceId, payload: { id: created.id } });

      // Best-effort outbound confirmation back into the Feishu chat. Requires
      // the secret key (to decrypt the installation's app_secret) and a
      // chat_id; any failure is swallowed so the inbound ack still succeeds.
      const chatId: string | undefined = body.event?.message?.chat_id;
      if (chatId) {
        try {
          const box = boxFromEnv(LARK_SECRET_KEY_ENV);
          if (box && inst.appSecretEncrypted) {
            const appSecret = box.openString(inst.appSecretEncrypted as unknown as Uint8Array);
            const prefix = await getWorkspacePrefix(db, inst.workspaceId);
            const identifier = prefix ? `${prefix}-${created.number}` : `#${created.number}`;
            await replier.reply(inst.appId, appSecret, chatId, `Created ${identifier}: ${created.title}`);
          }
        } catch (err) {
          console.warn("lark: outbound reply failed:", err);
        }
      }

      return c.json({ ok: true, issue_id: created.id, number: created.number });
    }

    return c.json({ ok: true });
  });

  return r;
}
