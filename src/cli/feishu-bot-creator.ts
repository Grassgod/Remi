/**
 * Feishu Bot auto-creation via App Registration API (Device Flow).
 *
 * Ported from bytedcli's `feishu login` implementation.
 * Uses https://accounts.feishu.cn/oauth/v1/app/registration
 *
 * Reference: larksuite/openclaw-lark (MIT)
 */

/** Default scopes for the bot (~65 scopes covering common Feishu APIs). */
export const DEFAULT_SCOPES = [
  "offline_access",
  "base:app:readonly", "base:app:write",
  "base:field:readonly", "base:field:write",
  "base:record:readonly", "base:record:write",
  "base:table:readonly", "base:table:write",
  "base:view:readonly", "base:view:write",
  "board:whiteboard:node:readonly", "board:whiteboard:node:write",
  "calendar:calendar.acl:readonly", "calendar:calendar.acl:write",
  "calendar:calendar.event:readonly", "calendar:calendar.event:write",
  "calendar:calendar.free_busy:read",
  "calendar:calendar:readonly", "calendar:calendar:write",
  "contact:contact.base:readonly",
  "contact:user.base:readonly",
  "contact:user.email:readonly",
  "contact:user.employee_id:readonly",
  "contact:user.phone:readonly",
  "docs:document.content:read", "docs:document.content:write",
  "docx:document:readonly", "docx:document:write",
  "drive:drive.metadata:readonly",
  "drive:file:readonly", "drive:file:write",
  "im:chat:readonly", "im:chat:write",
  "im:message:readonly", "im:message:write",
  "im:message.p2p_msg:readonly",
  "im:resource",
  "search:docs:read", "search:message",
  "sheets:spreadsheet:readonly", "sheets:spreadsheet:write",
  "space:document:readonly", "space:document:write",
  "task:task:read", "task:task:write",
  "wiki:wiki:readonly", "wiki:wiki:write",
];

export interface BotCredentials {
  appId: string;
  appSecret: string;
  createdByOpenId?: string;
}

export interface DeviceAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  refreshExpiresIn?: number;
  grantedScopes: string[];
}

type Brand = "feishu" | "lark";

function getOrigins(brand: Brand) {
  if (brand === "lark") {
    return {
      accounts: "https://accounts.larksuite.com",
      open: "https://open.larksuite.com",
    };
  }
  return {
    accounts: "https://accounts.feishu.cn",
    open: "https://open.feishu.cn",
  };
}

// ── Bot Registration ─────────────────────────────────────────

interface RegistrationBeginResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * Create a new Feishu Bot via the App Registration API.
 * User scans a QR code in terminal to approve.
 */
export async function createBot(
  brand: Brand,
  callbacks: {
    onQrUrl: (url: string, userCode: string) => void;
    onPolling?: (attempt: number) => void;
  },
): Promise<BotCredentials> {
  const { accounts } = getOrigins(brand);
  const regUrl = `${accounts}/oauth/v1/app/registration`;

  // Step 1: Init
  const initData = await postForm(regUrl, { action: "init" });
  if (initData.error) {
    throw new Error(`Bot registration init failed: ${initData.error as string}`);
  }

  // Step 2: Begin — get device_code + QR URL
  const beginData = await postForm(regUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });

  if (beginData.error) {
    throw new Error(`Bot registration begin failed: ${beginData.error as string}`);
  }

  const begin: RegistrationBeginResult = {
    deviceCode: beginData.device_code as string,
    userCode: beginData.user_code as string,
    verificationUri: beginData.verification_uri_complete as string,
    interval: (beginData.interval as number) || 5,
    expiresIn: (beginData.expires_in as number) || 300,
  };

  // Step 3: Show QR to user
  callbacks.onQrUrl(begin.verificationUri, begin.userCode);

  // Step 4: Poll for completion
  let interval = Math.max(begin.interval, 2);
  const deadline = Date.now() + begin.expiresIn * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    attempt++;
    callbacks.onPolling?.(attempt);

    const pollData = await postForm(regUrl, {
      action: "poll",
      device_code: begin.deviceCode,
    });

    const clientId = pollData.client_id as string | undefined;
    const clientSecret = pollData.client_secret as string | undefined;

    if (clientId && clientSecret) {
      const userInfo = pollData.user_info as Record<string, string> | undefined;
      return {
        appId: clientId,
        appSecret: clientSecret,
        createdByOpenId: userInfo?.open_id,
      };
    }

    const error = pollData.error as string | undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { interval += 5; continue; }
    if (error === "access_denied") throw new Error("用户拒绝了 Bot 创建请求");
    if (error === "expired_token") throw new Error("Bot 注册会话已过期，请重新执行 remi login");
    if (error) throw new Error(`Bot 注册失败: ${error}`);
  }

  throw new Error("Bot 注册超时，用户未在限定时间内完成扫码");
}

// ── User OAuth (Device Authorization Flow) ──────────────────

interface DeviceAuthBeginResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

/**
 * Obtain user_access_token via Device Authorization Flow.
 * User scans QR code to authorize.
 */
export async function authorizeUser(
  brand: Brand,
  appId: string,
  appSecret: string,
  scopes: string[],
  callbacks: {
    onQrUrl: (url: string, userCode: string) => void;
    onPolling?: (attempt: number) => void;
  },
): Promise<DeviceAuthResult> {
  const { accounts, open } = getOrigins(brand);

  // Step 1: Request device authorization
  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const daResp = await fetch(`${accounts}/oauth/v1/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      client_id: appId,
      scope: scopes.join(" "),
    }),
  });

  const daData = (await daResp.json()) as Record<string, unknown>;
  if (daData.error) {
    throw new Error(`Device authorization failed: ${daData.error as string}`);
  }

  const begin: DeviceAuthBeginResult = {
    deviceCode: daData.device_code as string,
    userCode: daData.user_code as string,
    verificationUri: (daData.verification_uri_complete ?? daData.verification_uri) as string,
    interval: (daData.interval as number) || 5,
    expiresIn: (daData.expires_in as number) || 300,
  };

  // Step 2: Show QR to user
  callbacks.onQrUrl(begin.verificationUri, begin.userCode);

  // Step 3: Poll for token
  let interval = Math.max(begin.interval, 2);
  const deadline = Date.now() + begin.expiresIn * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    attempt++;
    callbacks.onPolling?.(attempt);

    const tokenResp = await fetch(`${open}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: begin.deviceCode,
        client_id: appId,
        client_secret: appSecret,
      }),
    });

    const tokenData = (await tokenResp.json()) as Record<string, unknown>;

    if (tokenData.access_token) {
      return {
        accessToken: tokenData.access_token as string,
        refreshToken: tokenData.refresh_token as string | undefined,
        expiresIn: (tokenData.expires_in as number) || 7200,
        refreshExpiresIn: tokenData.refresh_token_expires_in as number | undefined,
        grantedScopes: ((tokenData.scope as string) ?? "").split(" ").filter(Boolean),
      };
    }

    const error = tokenData.error as string | undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { interval += 5; continue; }
    if (error === "access_denied") throw new Error("用户拒绝了 OAuth 授权");
    if (error === "expired_token") throw new Error("OAuth 会话已过期，请重新执行 remi login");
    if (error) throw new Error(`OAuth 授权失败: ${error}`);
  }

  throw new Error("OAuth 授权超时，用户未在限定时间内完成扫码");
}
