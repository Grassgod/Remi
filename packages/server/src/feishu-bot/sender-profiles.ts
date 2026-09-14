import type { MultiremiStore } from "../store/store.js";
import { feishuBotApiBase } from "./verify.js";

const REFRESH_INTERVAL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

/** Use names attached to messages the bot already received. Contact lookup can
 * require broader address-book permissions, including for external users. */
export class FeishuBotSenderProfiles {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  refresh(store: MultiremiStore, workspaceId: string): Promise<void> {
    const existing = this.pending.get(workspaceId);
    if (existing) return existing;
    const refresh = this.refreshOnce(store, workspaceId).finally(() => this.pending.delete(workspaceId));
    this.pending.set(workspaceId, refresh);
    return refresh;
  }

  private async refreshOnce(store: MultiremiStore, workspaceId: string): Promise<void> {
    const checkedAt = new Date().toISOString();
    const sources = store.listFeishuBotSenderProfileSources(workspaceId,
      new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString());
    if (!sources.length) return;
    const profiles = new Map<string, { name: string; nameEn: string | null }>();
    try {
      const credentials = store.revealFeishuBotSecrets(workspaceId);
      if (!credentials) return;
      const base = feishuBotApiBase(credentials.domain);
      // One deadline covers token exchange and the batch; no network I/O occurs
      // inside a database transaction or on the task ingestion path.
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const authResponse = await this.fetchImpl(`${base}/auth/v3/tenant_access_token/internal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }), signal,
      });
      const auth = await authResponse.json() as Record<string, unknown>;
      if (!authResponse.ok || auth.code !== 0 || typeof auth.tenant_access_token !== "string") return;
      const query = new URLSearchParams({ with_sender_name: "true", user_id_type: "open_id" });
      for (const source of sources) query.append("message_ids", source.messageId);
      const response = await this.fetchImpl(`${base}/im/v1/messages/mget?${query}`, {
        headers: { Authorization: `Bearer ${auth.tenant_access_token}` }, signal,
      });
      const body = await response.json() as { code?: number; data?: { items?: unknown[] } };
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.items)) return;
      for (const item of body.data.items) {
        if (!isRecord(item) || !isRecord(item.sender)) continue;
        const sender = item.sender;
        // Match both the delivered message and its app-scoped sender. Never
        // use response order, display names or a different user's profile as identity.
        const source = sources.find(source => source.messageId === item.message_id
          && source.openId === sender.id && sender.id_type === "open_id" && sender.sender_type === "user");
        if (!source) continue;
        const i18n = isRecord(sender.sender_i18n_names) ? sender.sender_i18n_names : {};
        const name = profileText(sender.sender_name) ?? profileText(i18n.zh_cn)
          ?? profileText(i18n.en_us) ?? profileText(i18n.ja_jp);
        if (name) profiles.set(source.id, { name, nameEn: profileText(i18n.en_us) });
      }
    } catch {
      // An unavailable/deleted message or missing read permission must not hide
      // the allowlist, leak upstream credentials, or erase a previously known name.
    } finally {
      for (const source of sources) {
        store.updateFeishuBotSenderProfile(workspaceId, source.appId, source.id,
          profiles.get(source.id) ?? null, checkedAt);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 512 && !/^feishu user$/i.test(text) ? text : null;
}
