---
title: 身份与工作区授权
status: active
summary: 定位当前登录、请求身份、工作区成员及 task/daemon 凭据边界，说明鉴权修改的验证入口。
---

# 身份与工作区授权

Remi 当前使用独立用户、工作区成员关系和分类型访问凭据。请求身份在中间件解析；工作区、角色和资源权限由对应路由与 guard 判断。本页描述实现契约，不代表已完成所有路由的安全审计或生产登录验证。

## 登录与请求身份

- [登录路由](../../packages/server/src/api/routers/auth.ts)把飞书 `open_id`、`union_id` 交给 [WorkspacesRepo.getOrCreateUser](../../packages/server/src/store/repos/workspaces-repo.ts)。身份按 `union_id`、`open_id` 解析；兼容邮箱匹配时不会复用已绑定其他外部身份的用户；否则创建独立用户记录。
- [localAuthResponse](../../packages/server/src/api/helpers/login.ts)签发包含真实 `userId` 的 30 天 PAT，`purpose` 为 `session`。该文件中的邮箱验证码与 Google fallback 共用 `MULTIREMI_ALLOW_EMAIL_CODE_LOGIN`，默认关闭；启用后验证码直接出现在响应中，Google fallback 也不校验 Google 凭据，不能把它们描述成生产邮件发送或 Google OAuth。当前 `sendLocalAuthCode` 在校验验证码前就调用 `store.updateCurrentUser` 修改旧 current user 的姓名/邮箱，启用此路径时需要单独检查这个副作用。
- 密码登录使用独立的 `MULTIREMI_ALLOW_PASSWORD_LOGIN` 开关，默认关闭；本机 profile 显式开启。`POST /auth/password` 验证预配账号，再为已确认的真实用户签发 30 天 session PAT，不按邮箱重新创建身份。[私有凭据仓储](../../packages/server/src/store/repos/password-accounts-repo.ts)保存唯一登录邮箱和 Argon2id 哈希，哈希不进入公开 User 类型。`POST /api/auth/password-accounts` 仅允许部署主令牌或显式无鉴权本地模式配置账号及指定工作区 owner 成员；它不是用户自助注册接口，不接受旧 `local` 身份作为密码账号。普通 PAT、JWT、task 和 daemon 均不能调用。
- `/api/me` 的读取、资料与 onboarding 写入沿用已认证用户，`/api/cli-token` 交接也保留同一用户身份；部署主令牌和原有本地模式仍回退到 `local`。密码登录和刷新页面必须保持同一用户身份，不能把请求身份替换成全局 current user。Web 退出调用 `/auth/logout` 撤销 session PAT 并清理 HttpOnly Cookie，原生 token 客户端的退出行为保持不变。
- [API 中间件](../../packages/server/src/api/server.ts)在开启鉴权时识别部署主令牌、持久化访问令牌和 JWT。普通 API 优先使用 Bearer；仅在缺少整个 `Authorization` 头且方法为 GET/HEAD 时接受 `multimira_auth` Cookie。公开登录、健康、下载、Webhook 等路径有显式例外，应同时检查各路由自己的验证。
- [MultiremiRequestAuth](../../packages/server/src/api/wire/context.ts)保存解析后的访问令牌及用户身份，不缓存统一的 workspace/role。部署主令牌和无鉴权本地模式保留无真实用户、回退 `local` 管理员的兼容路径；不能将这种路径的行为当作普通用户授权结果。

## 工作区与凭据边界

| 边界 | 当前行为与源码 |
|---|---|
| 人类用户的工作区权限 | [denyCurrentUserWorkspaceAccess](../../packages/server/src/api/helpers/auth-guards.ts)按成员关系判断；真实用户的 PAT 可访问其加入的多个工作区，不以登录时写入的 `workspaceId: local` 限制工作区。非成员通常返回 404 隐藏存在性。[工作区路由](../../packages/server/src/api/routers/workspaces.ts)也据此过滤列表。 |
| 成员与角色 | [WorkspacesRepo](../../packages/server/src/store/repos/workspaces-repo.ts)读取成员 `userId`，兼容旧成员 ID 形式。[成员 wire](../../packages/server/src/api/wire/workspaces.ts)的 `user_id` 同样优先使用真实 `userId`，仅在缺失时按旧成员 ID 推导；成员记录 `id` 与用户 ID 不可混用，否则 Web 无法识别已有角色。[currentWorkspaceRoleStrict](../../packages/server/src/api/wire/context.ts)可返回无角色；带默认值的 `currentWorkspaceRole` 不能单独证明成员资格。管理员操作使用相应的 admin guard。 |
| task 凭据 | [auth-guards.ts](../../packages/server/src/api/helpers/auth-guards.ts)将其限制在绑定工作区，并继承所属用户的业务权限，包括环境值与 SCM 配置等。`taskTokenHardDenyCategory` 另外阻止凭据签发/揭示、身份、工作区生命周期、权限配置等敏感操作；它不是只读令牌。 |
| daemon 凭据 | 同一 guard 文件中的请求允许列表和 `denyNonDaemonOperationalAccess` 区分机器控制面与人类操作；daemon 绑定、runtime/task 归属及 owner 成员资格另有检查。旧 CLI PAT 升级、注册和特定 SCM 请求存在明确例外，应按实现核对。 |
| 私有资源与实时消息 | Agent、运行时、附件、会话和 transcript 有各自的权限检查。[realtime.ts](../../packages/server/src/api/realtime.ts)处理浏览器/daemon WebSocket 鉴权与接收范围，不能只验证 HTTP 路径。 |

修改路由时，从请求实际指向的资源解析 workspace，再调用对应 guard；不要仅凭客户端传入的 ID 或“已经登录”认定有权限。[server.ts](../../packages/server/src/api/server.ts)中的 daemon 前缀中间件必须注册在对应 handler 之前，Hono 的注册顺序会影响覆盖范围。

## 启动条件

Runtime 的 Codex / Claude Code 自定义连接 GET/PUT 使用 Runtime 可见性/编辑权限，task token 对整个配置路由为 hard deny；直接填写的 API Key 经服务端 AES-256-GCM 加密并版本化。只允许绑定机器身份的 daemon token 从专用 `codex-profile-key` / `claude-profile-key` 路由读取对应 Runtime 的凭据，浏览器响应和任务公共响应不含密钥。加密配置、轮换和执行快照见 [Codex Runtime](../design/acp-codex-via-codex-acp.md#runtime-自定义连接)，Claude 的字段和请求头见 [Claude Code Runtime](../design/acp-claude-via-claude-agent-acp.md)，权限回归见 [runtime-codex-profile.test.ts](../../tests/unit/multiremi/runtime-codex-profile.test.ts)。

本机 profile 可按[部署说明](../deploy/local-profiles.md#stable-内网访问)将 stable 的 Web/API 对内网开放。密码登录页在显式 stable 构建的配置主机名显示；`MULTIREMI_DAEMON_DIRECT_BASE_URL` 同时通过 `/api/config.daemon_server_url` 和 daemon 安装说明公布可连接的 API origin，避免远程机器误连自身 loopback。监听 `0.0.0.0` 与客户端连接地址是不同设置，不改变服务端原有鉴权。

[startMultiremiServer](../../packages/server/src/api/server.ts)调用 [evaluateStartupEnv](../../packages/server/src/config/startup-env.ts)：生产模式要求 `MULTIREMI_DATABASE_URL`、`MULTIREMI_TOKEN`、`JWT_SECRET`，缺项会拒绝启动。显式 development/test 作为本地模式；否则 production 或已配置数据库 URL 会触发生产要求。

应用工厂保留本地无鉴权模式并打印警告，这不等于生产入口允许忽略配置。[jwtSecret](../../packages/server/src/api/helpers/jwt.ts)仅在精确的 `NODE_ENV=development/test` 下允许开发默认密钥，其他环境未设密钥时拒绝 JWT；启动配置检查与 JWT 校验是两个不同入口。

## 验证入口

| 变更 | 已有测试 |
|---|---|
| 多人登录、成员隔离、邀请、运行时归属 | [multiremi-multiuser-auth.test.ts](../../tests/unit/multiremi/multiremi-multiuser-auth.test.ts) |
| 密码账号预配、会话身份、错误凭据、重设及并发边界 | [password-auth.test.ts](../../tests/unit/multiremi/password-auth.test.ts) |
| Bearer/Cookie、task 权限、daemon 边界与迁移例外 | [multiremi-api-auth.test.ts](../../tests/unit/multiremi/multiremi-api-auth.test.ts) |
| Agent 操作、私有资源和配置脱敏 | [multiremi-store-agent-authz.test.ts](../../tests/unit/multiremi/multiremi-store-agent-authz.test.ts) |
| 生产配置缺项、本地模式与配置脱敏 | [startup-env.test.ts](../../tests/unit/multiremi/startup-env.test.ts) |

在仓库根目录按修改范围选择测试，例如：

```bash
bun test tests/unit/multiremi/multiremi-multiuser-auth.test.ts tests/unit/multiremi/multiremi-api-auth.test.ts tests/unit/multiremi/startup-env.test.ts
```

这些链接提供验证入口，不表示本次已执行或全部通过。真实飞书回调、生产环境配置及 WebSocket 行为需要与对应部署条件一起验证；不能从本地测试数量推导生产安全结论。
