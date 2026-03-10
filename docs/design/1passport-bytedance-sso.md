# 1Passport 扩展：ByteDance SSO + Token Sync 配置化

## 背景

1Passport 目前只有 Feishu adapter，token 同步到 `~/.lark_auth/tokens.json` 是硬编码。
要接入 bytedcli（字节内部研发 CLI），需要：
1. 新增 ByteDance SSO adapter（Device Code 流程）
2. 将 token 同步机制从硬编码改为声明式配置

## 整体架构

```
┌──────────────────────────────────────────────────────┐
│                    1Passport AuthStore                │
│                                                      │
│  ┌─────────────┐  ┌──────────────────┐               │
│  │   Feishu     │  │  ByteDance SSO   │  ... 未来     │
│  │   Adapter    │  │  Adapter (新增)   │               │
│  └──────┬───────┘  └───────┬──────────┘               │
│         │                  │                          │
│         ▼                  ▼                          │
│  ┌─────────────────────────────────────┐              │
│  │         Token Sync Engine (新增)     │              │
│  │  读取 token_sync 配置，自动分发      │              │
│  └──────┬──────────┬──────────┬────────┘              │
│         │          │          │                       │
└─────────┼──────────┼──────────┼───────────────────────┘
          ▼          ▼          ▼
   ~/.lark_auth/   bytedcli    未来工具
   tokens.json    jwt_override  ...
```

## 一、ByteDance SSO Adapter

### 配置

```toml
# remi.toml
[bytedance_sso]
clientId = "cd1k8uzbde1i1aa1gy0f"
ssoHost = "https://sso.bytedance.com"           # 默认值
bytecloudHost = "https://cloud.bytedance.net"   # 默认值
scopes = ["read", "ciam.device.read"]           # 默认值
```

对应环境变量：`BYTEDANCE_SSO_CLIENT_ID`、`BYTEDANCE_SSO_HOST`、`BYTEDANCE_BYTECLOUD_HOST`

### Token 类型

| type | 说明 | 获取方式 | 生命周期 |
|------|------|---------|---------|
| `access` | SSO access_token | Device Code 登录 | ~2h, 自动 refresh |
| `jwt` | ByteCloud JWT | 用 access_token 换取 | ~10min, 缓存+重新换取 |

### 核心流程

```
登录（首次 / token 完全失效）:
  1. POST /oauth2/device/code → device_code + user_code + verification_uri
  2. 给用户发飞书卡片：「请在浏览器打开 {verification_uri} 并输入 {user_code}」
  3. 轮询 POST /oauth2/access_token 直到用户确认
  4. 存储 access_token + refresh_token

日常使用:
  getToken("access") → 返回缓存 / 用 refresh_token 刷新
  getToken("jwt")    → 用 access_token 换 ByteCloud JWT（缓存 10min）

JWT 换取:
  GET {bytecloudHost}/auth/api/v1/jwt?sso_access_token={token}&sso_client_id={clientId}
  → 从响应 header X-Jwt-Token 或 body 中提取 JWT
```

### Adapter 接口实现

```typescript
// src/auth/adapters/bytedance-sso.ts

export interface ByteDanceSSOConfig {
  clientId: string;
  ssoHost?: string;           // 默认 https://sso.bytedance.com
  bytecloudHost?: string;     // 默认 https://cloud.bytedance.net
  scopes?: string[];          // 默认 ["read", "ciam.device.read"]
}

export class ByteDanceSSOAdapter implements AuthAdapter {
  readonly service = "bytedance-sso";

  constructor(config: ByteDanceSSOConfig)

  // type = "access" | "jwt"
  async getToken(type = "access"): Promise<string>

  async checkAndRefresh(): Promise<void>
  // - access: 过期前 5min 用 refresh_token 刷新
  // - jwt: 过期前 2min 重新换取（jwt 生命周期短）

  status(): TokenStatus[]
  restoreTokens(tokens: Record<string, TokenEntry>): void
  exportTokens(): Record<string, TokenEntry>
  onTokenChange(cb: () => void): void

  // === 登录流程（供 CLI 和飞书交互调用）===
  async requestDeviceCode(): Promise<DeviceCodeResponse>
  async pollForToken(deviceCode: string, interval: number): Promise<void>
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}
```

### CLI 登录

```bash
bun run src/main.ts auth bytedance-sso
# → 显示 verification_uri + user_code
# → 轮询等待授权
# → 存储 token 到 ~/.remi/auth/tokens.json
```

### 飞书交互式登录（可选，Phase 2）

用户在飞书对话中输入 `/auth bytedance-sso`：
1. Remi 调 Device Code API
2. 发送卡片：「请点击链接并输入代码 XXXX-XXXX」
3. 后台轮询，成功后回复「ByteDance SSO 认证成功」

## 二、Token Sync 配置化

### 配置格式

```toml
# remi.toml

[[token_sync]]
name = "lark-mcp-server"
source = "feishu/*"                             # adapter/tokenType，* 表示全部
target = "~/.lark_auth/tokens.json"
format = "mirror"                               # 镜像整个 adapter 的 tokens

[[token_sync]]
name = "bytedcli-jwt"
source = "bytedance-sso/jwt"
target = "~/.local/share/bytedcli/data/jwt_override.json"
format = "json_kv"
key = "token"                                   # JSON 中的 key 名
extra_keys = { saved_at = "{{now_iso}}" }       # 附加字段

[[token_sync]]
name = "bytedcli-sso"
source = "bytedance-sso/access"
target = "~/.local/share/bytedcli/data/token.json"
format = "bytedcli_token"                       # bytedcli 原生格式

[[token_sync]]
name = "some-env-file"
source = "bytedance-sso/jwt"
target = "~/.config/my-tool/.env"
format = "env"
key = "BYTECLOUD_JWT"
```

### Format 类型

| format | 说明 | 输出示例 |
|--------|------|---------|
| `mirror` | 镜像整个 adapter tokens（兼容现有 lark_auth） | `{ "feishu": { "tenant": {...}, "user": {...} } }` |
| `json_kv` | `{ key: token, ...extra_keys }` | `{ "token": "eyJ...", "saved_at": "2026-..." }` |
| `bytedcli_token` | bytedcli 原生 token 格式 | `{ "access_token": "...", "refresh_token": "...", "expires_at": 123, "token_type": "Bearer" }` |
| `raw` | 纯文本 token 值 | `eyJ...` |
| `env` | `KEY=value` 格式 | `BYTECLOUD_JWT=eyJ...` |

### Token Sync Engine 实现

```typescript
// src/auth/token-sync.ts

export interface TokenSyncRule {
  name: string;
  source: string;          // "adapter/type" 或 "adapter/*"
  target: string;          // 文件路径，支持 ~ 展开
  format: "mirror" | "json_kv" | "bytedcli_token" | "raw" | "env";
  key?: string;            // json_kv/env 的 key 名
  extraKeys?: Record<string, string>;  // 附加字段，支持 {{now_iso}} 模板
}

export class TokenSyncEngine {
  constructor(rules: TokenSyncRule[])

  // 当 adapter token 变化时调用
  sync(service: string, type: string, entry: TokenEntry): void
  // → 匹配 rules，写入对应 target

  // 全量同步（启动时 + 定期）
  syncAll(adapters: Map<string, AuthAdapter>): void
}
```

### 集成到 AuthStore

```typescript
// store.ts 改动
class AuthStore {
  private _syncEngine: TokenSyncEngine;

  constructor(authDir: string, syncRules: TokenSyncRule[]) {
    this._syncEngine = new TokenSyncEngine(syncRules);
  }

  // 原有的 _persistNow 中：
  // 删除硬编码的 LARK_MCP_TOKEN_FILE 同步
  // 改为：this._syncEngine.syncAll(this._adapters)
}
```

### 迁移

现有的 `~/.lark_auth/tokens.json` 同步从硬编码迁移为默认配置：

```typescript
// 如果用户没有配置 token_sync，提供默认规则
const DEFAULT_SYNC_RULES: TokenSyncRule[] = [
  {
    name: "lark-mcp-server",
    source: "feishu/*",
    target: "~/.lark_auth/tokens.json",
    format: "mirror",
  },
];
```

确保无配置时行为不变，向后兼容。

## 三、Daemon 集成

```typescript
// daemon.ts 改动

_buildRemi(): Remi {
  const remi = new Remi(this.config);

  // 读取 token_sync 配置（含默认规则）
  const syncRules = this.config.tokenSync?.length
    ? this.config.tokenSync
    : DEFAULT_SYNC_RULES;

  const authStore = new AuthStore(
    join(homedir(), ".remi", "auth"),
    syncRules,
  );

  // Feishu adapter（已有）
  if (hasFeishuCreds) {
    authStore.registerAdapter(new FeishuAuthAdapter({...}));
  }

  // ByteDance SSO adapter（新增）
  if (this.config.bytedanceSso?.clientId) {
    authStore.registerAdapter(new ByteDanceSSOAdapter(this.config.bytedanceSso));
  }

  remi.authStore = authStore;
  // ...
}
```

## 四、bytedcli 集成效果

配置完成后的使用流程：

```
1. 首次登录
   $ bun run src/main.ts auth bytedance-sso
   → 浏览器确认 → token 存入 1Passport

2. Token Sync 自动触发
   1Passport → jwt_override.json（给 bytedcli）
   1Passport → token.json（给 bytedcli，可选）

3. bytedcli MCP 使用
   claude mcp add bytedcli -- npx @bytedance-dev/bytedcli@latest mcp
   → bytedcli 读到 jwt_override → 直接可用，无需再次登录

4. 日常运行
   1Passport 自动 refresh SSO token → 重新换 JWT → 同步到 bytedcli
   用户无感知
```

## 五、实现计划

| 阶段 | 内容 | 文件 |
|------|------|------|
| **Phase 1** | TokenSyncEngine + 配置化 | `src/auth/token-sync.ts`, `store.ts` 改动 |
| **Phase 2** | ByteDanceSSOAdapter | `src/auth/adapters/bytedance-sso.ts` |
| **Phase 3** | CLI 登录命令 | `src/auth/oauth-cli.ts` 扩展 |
| **Phase 4** | bytedcli MCP 接入 + 配置 | `remi.toml`, `.claude/settings.json` |
| **Phase 5** | 飞书交互式登录（可选） | 飞书卡片 + 轮询逻辑 |

Phase 1-2 是核心，预计改动 4 个文件，新增 2 个文件。
Phase 3-4 是接入，主要是配置。
Phase 5 是体验优化，非必须。

## 六、安全考虑

- Token 文件权限 0o600，目录 0o700
- 原子写入（tmp + rename）
- refresh_token 不会同步到外部工具（只同步 access_token 或 JWT）
- Device Code 登录需要浏览器物理确认，无法被远程利用
- JWT override 每次使用前验证有效性（bytedcli 自带逻辑）
