/**
 * Lark (Feishu) Open Platform HTTP client — port of the Go
 * server/internal/integrations/lark/http_client.go.
 *
 * Scope kept to what server-bun needs right now: tenant_access_token
 * acquisition + in-memory caching, and IM v1 text-message send. The Go
 * client carries per-installation credentials on every call and caches
 * tokens keyed by app_id; here a single LarkClient instance is
 * constructed per (appId, appSecret) so the token cache is just one
 * field on the instance.
 *
 * Credentials and the HTTP transport are injected via the constructor so
 * tests can substitute a fake `fetch` and never touch the network (no DB
 * either — this client is pure HTTP).
 */

/** Mainland 飞书 open-platform host; the default when none is injected. */
const DEFAULT_BASE_URL = "https://open.feishu.cn";

/**
 * Subtracted from Lark's `expire` so we refresh before a token actually
 * lapses. 60s comfortably exceeds any in-flight HTTP timeout. Mirrors the
 * Go client's tokenSafetyMargin.
 */
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

/** Injectable HTTP transport. Defaults to globalThis.fetch. */
export interface HttpTransport {
  fetch: typeof fetch;
}

export interface LarkClientOptions {
  http?: HttpTransport;
  baseUrl?: string;
}

export type ReceiveIdType = "chat_id" | "open_id" | "user_id";

export interface SendMessageParams {
  receiveIdType: ReceiveIdType;
  receiveId: string;
  msgType: "text";
  content: string;
}

interface CachedToken {
  value: string;
  /** epoch millis after which the cached token must not be reused. */
  expiresAt: number;
}

export class LarkClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly httpFetch: typeof fetch;
  private token: CachedToken | null = null;

  constructor(appId: string, appSecret: string, opts?: LarkClientOptions) {
    this.appId = appId;
    this.appSecret = appSecret;
    // Strip a trailing slash so baseUrl + path never doubles the "/".
    this.baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.httpFetch = opts?.http?.fetch ?? globalThis.fetch;
  }

  /**
   * Returns a usable tenant_access_token, reusing the cached value while
   * it is alive (minus the safety margin) and otherwise fetching a fresh
   * one from the self-built (internal) app endpoint. Throws on a non-zero
   * Lark error code.
   */
  async tenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now) {
      return this.token.value;
    }

    const body = await this.postJson<{
      code: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    }>("/open-apis/auth/v3/tenant_access_token/internal", {
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(
        `lark client: tenant_access_token: code=${body.code} msg=${JSON.stringify(body.msg ?? "")}`,
      );
    }

    // Clamp to >= 2× the safety margin so a misbehaving upstream that
    // returns a sub-minute expire never makes us cache a token that is
    // already past its safe window.
    const expireMs = Math.max((body.expire ?? 0) * 1000, TOKEN_SAFETY_MARGIN_MS * 2);
    this.token = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + expireMs - TOKEN_SAFETY_MARGIN_MS,
    };
    return this.token.value;
  }

  /**
   * Posts an IM v1 message. The `content` is the raw msg_type-specific
   * envelope Lark expects (for text: a JSON-encoded {"text": "..."}).
   * Returns the new message_id. Throws on a non-zero Lark error code.
   */
  async sendMessage(params: SendMessageParams): Promise<{ messageId: string }> {
    const token = await this.tenantAccessToken();
    const path = `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(params.receiveIdType)}`;
    const body = await this.postJson<{
      code: number;
      msg?: string;
      data?: { message_id?: string };
    }>(
      path,
      {
        receive_id: params.receiveId,
        msg_type: params.msgType,
        content: params.content,
      },
      token,
    );

    if (body.code !== 0 || !body.data?.message_id) {
      throw new Error(
        `lark client: send message: code=${body.code} msg=${JSON.stringify(body.msg ?? "")}`,
      );
    }
    return { messageId: body.data.message_id };
  }

  /**
   * Convenience: post a plain-text reply into a chat. Lark's `text`
   * msg_type expects content = JSON-encoded {"text": "..."}; JSON.stringify
   * escapes newlines / quotes / unicode so the reply round-trips intact.
   */
  async replyText(chatId: string, text: string): Promise<{ messageId: string }> {
    return this.sendMessage({
      receiveIdType: "chat_id",
      receiveId: chatId,
      msgType: "text",
      content: JSON.stringify({ text }),
    });
  }

  /**
   * Shared verb + URL + auth-header + JSON encode/decode path. An empty
   * token skips the Authorization header (only the tenant_access_token
   * endpoint takes that path).
   */
  private async postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await this.httpFetch(this.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      throw new Error(`lark client: http ${res.status}: ${raw.slice(0, 512)}`);
    }
    return (await res.json()) as T;
  }
}
