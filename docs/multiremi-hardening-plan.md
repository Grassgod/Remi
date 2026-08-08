# Bun Multiremi 服务端 · 技术债 & 安全加固方案 (PRD)

> **历史文档**(2026-07-02):文中的 `src/multiremi` 现为 `packages/server/`。当前布局见 `README.md`。

状态：待实现 · 交接给独立 session/开发者 · 2026-07-02
依据：一次全量代码评审(后端 `src/` + 前端双树)的结论。

---

## 0. 背景(评审结论一句话）

工程质量在线(tsc 0 错误、几乎 0 TODO、测试 364/369、任务领取用了正确的原子事务、SQL 全参数化无注入),但**风险集中在 `multiremi` 的两个巨石文件 + 逐路由手写的鉴权**:`api/api.ts`(9.4k 行、457 路由挤一个函数、helper 普遍 `c: any`)、`store/store.ts`(10.9k 行 god-class + 内嵌自制迁移)。安全靠人肉逐路由覆盖,已漏两处。

**已在部署侧处理(勿重复/勿冲突)**:
- 多用户鉴权已上线(PR #1 / `b3afce60`):login=`getOrCreateUser` by open_id、成员资格准入、`MULTIREMI_ALLOW_EMAIL_CODE_LOGIN` 默认关、`MULTIREMI_OWNER_OPEN_ID` 绑定 owner。
- `MULTIREMI_TOKEN`(admin)、`JWT_SECRET`(强随机)已写进 `.run-multiremi-server.sh` 并重启生效;已验证旧默认密钥伪造的 JWT 被 401 拒绝。
- 本 PRD 在这些之上继续,把**代码层**也补硬(不只靠 env)。

---

## 1. 目标与范围

把安全从"逐路由手写、易漏"变成"中间件统一强制",清掉死代码/重复,治理最痛的查询性能,并为两个巨石文件铺拆分路径。**不重写产品**、**不迁 Go 后端**、仍在 Bun `src/multiremi` 上做。

分四期:**P0 安全(必做/最急)→ P1 清理(低风险)→ P2 性能 → P3 结构(中长期)**。每期可独立交付。

---

## P0 — 安全加固(必做)

### 需求
- **FR-P0.1 全路由授权审计 + 补齐**:审计 `api/api.ts` 全部 457 路由,列出所有 workspace-scoped 但**未调 `denyCurrentUserWorkspaceAccess`**(或等价成员校验)的路由并补上。已知缺口:`/api/squads`(GET/POST 及 PATCH/DELETE `:2122–2285`)、`/api/pins`(GET/POST/DELETE/reorder `:2635–2665`)—— 这些信任客户端传的 `X-Workspace-ID`/`workspace_id` 却不做准入,可跨工作区读写;pins 还需按 `user_id` 做属主校验。
- **FR-P0.2 统一 auth 中间件(根治)**:新增一个中间件,在请求早期**一次性**解析出 `{ userId, workspaceId, role, accessToken }` 存进 typed context;各路由从 context 取,不再各自 `compatibilityWorkspaceId(c: any)` + 手写网关。以此消除 `c: any`(109 个 any 的主源)并结构性堵住"漏挂网关"。可分步:先落地中间件与 typed context,再逐资源迁移路由。
- **FR-P0.3 JWT 密钥硬失败**:`jwtSecret()`(`api.ts:9168`)在生产/非 dev 下**`JWT_SECRET` 未设即拒绝启动或禁用 JWT 认证**,绝不退回硬编码默认值 `"multiremi-dev-secret-change-in-production"`(`:134`)。(部署侧已设 env,此为代码层兜底。)
- **FR-P0.4 开放模式告警**:`MULTIREMI_TOKEN` 未设(`api.ts:321` 整块鉴权不挂 = 全 API 裸奔、人人 `local` admin)时,**启动打醒目 WARN**;并考虑该模式下默认只绑 loopback。

### 验收(P0)
| 编号 | 操作 | 期望 |
|---|---|---|
| AC-P0.1 | 用户 A(仅工作区 X 成员)带 A token,`GET/POST/DELETE /api/squads`、`/api/pins` 且 header 指向工作区 Y | 403/404,拿不到也改不了 Y 的 squad/pins;删别人的 pin 被拒 |
| AC-P0.2 | 审计脚本/清单列出所有 workspace-scoped 路由 | 每条都经过统一中间件或显式 gating;清单归档,0 遗漏 |
| AC-P0.3 | 不设 `JWT_SECRET` 启动(非 dev) | 进程拒绝启动或 JWT 路径禁用;设了强密钥则正常 |
| AC-P0.4 | 不设 `MULTIREMI_TOKEN` 启动 | 日志有醒目"鉴权已关闭"WARN |
| AC-P0.5 回归 | owner A 正常用;三台 daemon(`mul_` pat token)全程在线;install/公开路由仍 200 | 无回归 |
- 新增后端集成测试覆盖 AC-P0.1/P0.3(两个模拟用户 token 打 squad/pins,断言状态码)。

---

## P1 — 死代码 & 重复清理(低风险,先做见效快)

### 需求
- **FR-P1.1** 删 `src/connectors/feishu/protocol/acp.ts`(318 行,**0 引用**,是 `shared/contracts/acp-protocol.ts` 的陈旧副本)及空的 `protocol/` 目录。
- **FR-P1.2** 去掉 **Mission 残留**:`connectors/feishu/chat.ts:99–117`(`getBoardBaseUrl`/`addChatTab`)+ `remi/project/init.ts:130`(`setupProjectChat`)—— 每次建项目会加一个指向已删看板 `${REMI_BOARD_URL}/mission/${projectId}` 的 Feishu "Missions" tab。删掉或重指现有 UI。
- **FR-P1.3** 合并**重复 adapter**:`src/acp/adapters/{claude-code,codex}/index.ts` 与 `src/connectors/feishu/adapters/{claude-code,codex}/index.ts` 除一行 import 外**逐字节相同**(~414 行)。保留一份(移到 `shared/` 或让 feishu 侧 import acp 侧),删副本。
- **FR-P1.4** 前端禁用功能清理:`onboarding` 流程(`resolve.ts` 恒返回 `newWorkspace()`,但路由/`OnboardingFlow` 仍可达)、source-backfill 问卷(`needs-backfill.ts` 恒 `false`)、cloud waitlist —— 删除或用文档化 feature flag 收口。
- **FR-P1.5** 同步 4 个过期生产测试(`multiremi/` 里 `needs-backfill`、`source-backfill-modal`、`login-page`、`auth/callback` 断言旧值,源码与 git 一致):从 `frontend/` 覆盖过去,或统一"不在生产镜像跑测试"。
- **FR-P1.6** 删已并入 main 的 6 个本地分支(`agent-runtime-implementation`、`claude/clever-bhabha`、`claude/inspiring-goodall`、`codex/bun-multica-core`、`codex/remi-migration-fixes`、`dev/elicitation-and-remove-mission`;各 0 独有提交);`claude/vigilant-neumann-bdc4f0` 有 3 个独有提交(旧"管理控制台"尝试)—— 确认已被现 `/multiremi` 前端取代后再删。

### 验收(P1)
- `grep -r "feishu/protocol/acp\|getBoardBaseUrl\|addChatTab\|setupProjectChat"` 0 命中;建项目不再产生 Missions tab。
- adapter 只剩一份实现,`bun test` 仍全绿(除已知 3 个改名遗留)。
- `git branch` 只剩需要的分支。
- `tsc` 0 错误、`bun test` 无新增失败。

---

## P2 — 查询性能

### 需求
- **FR-P2.1** `store.ts` 列表方法下推 SQL:`listIssues`(`:3827`,现在 `SELECT *` 全表 + 内存过滤 + 每 issue 一次 `listLabelsForIssue` = O(全表)+N+1)及 `listGroupedIssues`/`listAssigneeFrequency` 等同型方法,改为 `WHERE`/`LIMIT`/`OFFSET` 进 SQL + 用 `WHERE issue_id IN (...)` **批量取标签**消 N+1。
- **FR-P2.2** `addColumnIfMissing`(`:8110`)**收窄 catch**:只吞"列已存在"这一种幂等错误(按后端方言判定),其他 ALTER 失败必须抛出 + 记日志(现在静默吞掉会让 schema 悄悄错)。

### 验收(P2)
- 造 N 条 issue(如 2k),`listIssues` 的 SQL 查询数从 O(N) 降到 O(1)~O(2)(标签一次批量);响应明显变快(给出前后基准)。
- 故意制造一个非幂等 ALTER 失败,迁移**报错而非静默通过**。
- 列表结果与改造前一致(同过滤/排序/分页)。

---

## P3 — 结构(中长期,可增量)

### 需求
- **FR-P3.1** 拆 `api/api.ts`:把 `createMultiremiApp()`(`:307–3895`,3.6k 行)按资源拆成 `routes/{issues,agents,workspaces,runtimes,auth,webhooks,...}.ts` 子路由,`app.route()` 挂载;compatibility 映射器移到 `serializers/`。**依赖 P0.2 的统一中间件**先落地。
- **FR-P3.2** 拆 `store.ts`:god-class 拆成 per-domain repo(`IssuesRepo`/`AgentsRepo`/`RuntimesRepo`/`TasksRepo`/`WorkspacesRepo`/`ChatRepo`)共享 `SqlDatabase`;`migrate()`(`:420–1308`)抽成版本化的 `store/migrations/`。
- **FR-P3.3** Postgres 后端(`store/db/postgres.ts`,正则翻译 SQLite SQL + `Atomics.wait` 阻塞主线程):当**实验特性**标注,或改成 async DB 接口;至少加"全查询面跑真实 PG"的测试。
- **FR-P3.4**(运维/工程)前端生产镜像 `/multiremi/`(gitignore)改成 **git worktree / 软链 / 直接从 `frontend/` 构建**,消除"手工镜像、直接改 git 看不见"的隐患;收敛成单一 lockfile。

### 验收(P3)
- 拆分为纯重构:拆前后 `bun test` + `tsc` 全绿,行为不变(路由/响应逐一对齐)。
- 每个子路由/repo 可独立定位;单文件行数显著下降。
- 前端:一处修改即生效,`git status` 能看到生产会用到的所有改动。

---

## 风险与注意(全程)

- **别锁死 owner**:改鉴权时确保 owner(hehuajie,open_id `ou_e6b7ffc…`)始终能进;服务器可直连 Postgres 兜底。
- **daemon 别断**:三台机器用 `mul_` pat token(userId=local=owner),任何鉴权改动都不能让 `/api/daemon/*` 变 401。
- **服务从源码跑**:改 `src/multiremi` 后需用 `.run-multiremi-server.sh` 重启(务必保留 `MULTIREMI_DATABASE_URL`/`MULTIREMI_TOKEN`/`JWT_SECRET`/`MULTIREMI_OWNER_OPEN_ID`)。
- **别在生产镜像 `/multiremi/` 跑测试**(4 个已知过期);测试在 `frontend/` 跑。
- **可逆**:每期尽量小步可回退;重构期严格"行为不变"。

---

## 建议执行顺序

P0.1+P0.4(小改、堵活口)→ P1 全套(低风险、见效快、减负)→ P0.2/P0.3(中间件根治,含把 P3.1 铺好)→ P2(性能)→ P3(增量拆分)。
