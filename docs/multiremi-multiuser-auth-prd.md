# Bun Multiremi 服务端 · 多用户/多租户鉴权 需求文档 (PRD)

状态：待实现 · 交接给独立 session/开发者 · 2026-07-01

---

## 0. 一句话

当前部署跑的是 **Bun 重写版服务端 `src/multiremi`**，它的登录是"单用户捷径"——任何飞书用户登录后都会变成同一个 `local` owner，能看到全部数据，且后登录者覆盖前者。数据模型/前端本身支持多租户，本需求是**把 Bun 服务端的登录与鉴权真正做成多用户 + 按工作区成员资格准入**。

---

## 1. 背景与现状（含证据）

- 部署：`n37-117-209` 上 `bun run src/multiremi-main.ts serve`（:6120，Postgres），前端 `multiremi/apps/web`（`next start` :3000，nginx:80 转发）。已开鉴权：launcher `.run-multiremi-server.sh` 里设了 `MULTIREMI_TOKEN`。
- **问题**：另一个飞书用户（zhuxinwen）登录后直接进入 Remi 工作区、看到全部运行时；且用户表里唯一那条记录的名字被从「贺华杰」覆盖成「朱欣文」。
- **根因（代码事实）**：
  - `src/multiremi/store/store.ts` `getCurrentUser()` **写死取 `id="local"` 的唯一用户**（没有就建一个 `local`）。
  - `src/multiremi/api/api.ts` `localAuthResponse()`（飞书/邮箱登录都走它）= `getCurrentUser()`（永远 local）→ 把该用户改名/改邮箱成登录者 → `createAccessToken({type:"pat"})`（`userId` 默认 `"local"`）。**从不按身份建/查独立用户。**
  - `currentRequestUserId(c) = accessToken.userId ?? jwtUserId ?? "local"`（兜底成 local）。
  - `currentWorkspaceRole()` / `currentWorkspaceRoleStrict()` 有后门：`workspaceId==="local" && currentRequestUserId==="local" → "owner"`。
  - `currentWorkspaceMember()` 靠 `member.id === userId || member.id === \`mem_${ws}_${userId}\`` 匹配（成员表**没有 user_id 列**，只有 `id, workspace_id, name, email, role`）。
  - `/auth/send-code` 直接把验证码**返回在响应体里**（dev 登录），任意邮箱可登。
- **数据模型是支持多租户的**：`multiremi_users`、`multiremi_workspace_members`（含 `role`）、`multiremi_workspaces`、邀请相关表都在；前端有成员/邀请/角色 UI。缺的是"Bun 服务端登录/鉴权没接上这套"。

---

## 2. 需求（Functional Requirements）

- **FR1 独立用户**：每个飞书身份（用 `open_id` 作稳定外部 id；企业邮箱可作展示/邀请匹配）登录后对应**一条独立用户记录**，多人登录互不覆盖。
- **FR2 真实身份 token**：登录签发的 token/JWT 携带**真实 userId**；`currentRequestUserId` 解析为该用户；去掉"匿名兜底成 local"。
- **FR3 工作区按成员资格准入**：所有 workspace-scoped 端点（issues / agents / runtimes / members / projects / skills / settings 等）必须校验"请求者是该 workspace 的成员"，非成员 → 403 或不返回。**移除 `local+local→owner` 后门**，一律用真实成员 role。
- **FR4 新用户空态**：不是任何工作区成员的新用户登录后，`GET /api/workspaces` 不含 Remi，进入"无工作区 / 创建工作区 / 待接受邀请"空态，看不到 Remi 的任何数据。
- **FR5 邀请加入**：owner/admin 可按邮箱邀请；被邀请者登录/接受后按邀请的 role 成为成员，才能看到对应工作区（邀请表/前端已存在，需把后端行为对上）。
- **FR6 运行时可见性生效**：runtime `owner_id` = 注册它的 daemon token 所属用户；`canCurrentUserUseRuntime` 配合真实 role：`private` 仅 owner/admin 可用，`public` 全体成员可用；**非成员完全看不到该 workspace 的运行时**。
- **FR7 保留现有 owner**：迁移后现在的 owner（hehuajie / 贺华杰，飞书 `open_id = ou_e6b7ffc662b392317275b817295c0b44`）仍是 Remi（`local`）工作区的 owner，历史数据归属不乱。
- **FR8 daemon 不受影响**：三台机器的 daemon（`mul_` 类型 `pat` token）继续注册/心跳不中断；daemon token 归属到"当初 `remi setup` 时创建它的用户"。
- **FR9 收紧开放登录**：生产环境**停用或严格限制**邮箱验证码登录（`/auth/send-code`/`/auth/verify-code` 不能对任意邮箱返回验证码），只保留飞书 SSO。可用开关（如 `MULTIREMI_ALLOW_EMAIL_CODE_LOGIN=false` 默认关）。

---

## 3. 非目标（Non-goals）

- 不要求真发邮件验证码（可直接禁用邮箱登录）。
- 不改前端多用户 UI（已存在），只让后端行为对上；如需极小前端配合（如空态跳转）可做，但不重做页面。
- 不新增 SSO 之外的登录方式。
- 不做配额/计费/审计日志等。
- 不迁移到 Go 后端（仍在 Bun `src/multiremi` 上实现）。

---

## 4. 涉及改动地图（给实现者参考，非强制照抄）

`src/multiremi/api/api.ts`
- `localAuthResponse()`：改为按 `external_id(open_id)`/email `getOrCreateUser`，签发**该用户**的 token；删掉复用 `getCurrentUser()` 的逻辑。
- `/auth/lark/callback`：把 `larkFetchUserInfo` 拿到的 `open_id`（稳定外部 id）+ name + 企业邮箱一起传入登录。
- `currentRequestUserId` / `currentWorkspaceRole` / `currentWorkspaceRoleStrict` / `currentWorkspaceMember`：去掉 local 后门，按真实 user + 成员表判定 role（无成员身份 → null/非成员）。
- 鉴权中间件（`app.use("*")`，约 315 行）：无有效 token/JWT 一律 401；**保留公开路由白名单**（`/auth/*`、`/health*`、`/api/remi/releases/*`、`/api/webhooks/*`、`/api/config`、`/`）。去掉"匿名即 local"。
- `daemonRegisterOwnerContext` / `registerDaemonRuntimes`：runtime `ownerId` = daemon token 的 `userId`（该 token 所属用户）。
- 各 workspace-scoped 端点：统一加"请求者是目标 workspace 成员"的准入中间件/校验。
- `/auth/send-code`、`/auth/verify-code`：按 FR9 加开关/禁用。

`src/multiremi/store/store.ts`
- 新增 `getOrCreateUser({externalId, email, name})`、`getUserByEmail(email)`、`getUserByExternalId(openId)`；`getCurrentUser()`（写死 local）不再用于登录路径（可保留给纯本地 CLI 场景，但 API 登录不用）。
- 用户表可能需要加 `external_id`（open_id）列以稳定匹配飞书身份。
- `createAccessToken`：登录 token 必须能传真实 `userId`（现在默认 `"local"`）。
- `multiremi_workspace_members`：**当前没有 `user_id` 列**——需把"成员↔用户"关联起来（加 `user_id` 列，或用稳定 email/open_id 匹配），并提供 `getUserRoleInWorkspace(userId, workspaceId)`。
- 数据迁移：把现有 `local` 用户迁成 hehuajie 的独立用户（`external_id = ou_e6b7ffc662b392317275b817295c0b44`）并保留其在 Remi 工作区的 owner 成员身份；Remi 工作区 owner 不变；已有 issue/agent/runtime 的 `owner_id`/作者引用保持有效。

前端（`multiremi/`，仅在必要时）
- 已是 token 模式（`web-providers.tsx` `cookieAuth=false`）。若后端对非成员返回 403/空，确认前端空态（无工作区/创建工作区/待邀请）能正确落地；如需微调走 `packages/views` + 重建 `multiremi/apps/web`（`REMOTE_API_URL=http://127.0.0.1:6120 pnpm build` → `next start --port 3000`）。

---

## 5. 验收标准与测试（Acceptance Criteria）

前置：服务器已设 `MULTIREMI_TOKEN`；至少两个飞书账号（A=hehuajie，owner；B=zhuxinwen，非成员）。DB 用 Bun 脚本直连查（`new SQL(process.env.MULTIREMI_DATABASE_URL)`，注意 `psql` 未安装）。带 token 直连 API 或用浏览器均可。

每条给"操作 / 期望结果"，实现完成时应逐条为真。

| 编号 | 操作 | 期望结果 |
|---|---|---|
| **AC1 独立用户不覆盖** | A 登录记 userId_A；B 登录记 userId_B；查 `multiremi_users` | 出现**两条**用户记录，userId_A ≠ userId_B；A 记录名字仍是「贺华杰」，未被 B 覆盖 |
| **AC2 非成员看不到** | B（非成员）带 B token 请求 `GET /api/workspaces`、Remi 工作区下的 `/api/multiremi/runtimes`、issues 等 | `/api/workspaces` 不含 Remi；Remi scope 的端点返回 **403 或空**；浏览器进入空态 |
| **AC3 owner 正常** | A（owner）带 A token 请求同上 | 看到 Remi 工作区 + 全部 6 个运行时；`currentWorkspaceRole == "owner"` |
| **AC4 邀请后可见** | A 邀请 B（role=member）；B 接受后带 B token 请求 | B 能看到 Remi 工作区；`public` 运行时可用；`private` 运行时被挡（403「this runtime is private…」） |
| **AC5 daemon 不中断** | 全程观察三台 daemon | `multiremi_runtimes` 心跳持续新鲜（<10s）；daemon 注册/心跳 200；每个 runtime `owner_id` = setup 该机器的用户 |
| **AC6 关闭开放登录** | `POST /auth/send-code {email:任意}` | 生产下 403/404 或被开关拒（不再对任意邮箱返回验证码）；`/auth/lark/url` 仍可用 |
| **AC7 迁移不丢** | 升级/重启后 A 登录 | A 仍是 Remi owner；历史 issue/agent/runtime 归属正确 |
| **AC8 公开路由回归** | `GET /api/remi/releases/latest/version`、install-remi.sh、`GET /auth/lark/url` | 仍 200，无需登录 |
| **AC9 两账号并存刷新** | A 登录用一会，B 另一个浏览器登录用一会，来回刷新 | 各自看到各自的身份/权限，互不串号、互不掉线 |

自动化建议：至少给 AC1/AC2/AC3/AC4/AC6 写后端集成测试（`bun test`，用两个模拟用户的 token 打端点断言状态码/可见集合）。

---

## 6. 风险与注意

- **别锁死 owner**：改鉴权时确保 A（hehuajie）始终能进；服务器上可直连 Postgres，出问题可手工补成员/角色兜底。
- **daemon token 是机器身份**：`pat` 类型、代表机器，不是人登录。归属用户要正确（setup 时创建 token 的用户），**绝不能让它们变 401**，否则三台机器全掉线。
- **成员表无 `user_id`**：这是主要 schema 缺口，先定"加列 vs 稳定 email/open_id 匹配"，再动。
- **`getCurrentUser()` 遍地是**：全代码几十处用它拿 local（评论作者、通知、注册 owner 等），逐一改成"请求真实用户"，漏改会串号；建议全局搜 `getCurrentUser(` 列清单逐个过。
- **可逆兜底**：保留"去掉 `MULTIREMI_TOKEN` 即回退到开放/单用户"的能力，便于应急。
- **飞书无邮箱**：很多飞书 profile 不返回 email（本例 A/B 都只有 open_id）。**必须用 `open_id` 作稳定用户 id**，不要依赖 email 唯一。企业邮箱（`enterprise_email`）如果有可作展示/邀请匹配，但要 app 授予相应权限。

---

## 7. 交接备注

- 现状里我已做的相关改动（供参考，勿冲突）：开鉴权（`MULTIREMI_TOKEN` + 公开路由白名单 commit `3495244e`）、前端强制 token 模式（`25743af5`）、飞书回调防重复提交（`d641f882`）、隐藏 `.local` 合成邮箱（`252975df`）。**本 PRD 要在这些基础上继续**。
- 服务器重启：改 `src/multiremi` 源码后需重启 `bun run src/multiremi-main.ts serve`（用 `.run-multiremi-server.sh`，务必保留 `MULTIREMI_DATABASE_URL` 和 `MULTIREMI_TOKEN`，否则回退空 SQLite / 关鉴权）。
