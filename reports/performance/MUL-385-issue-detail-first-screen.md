# MUL-385 详情首屏三接口服务端基线与前后对比

- 父单：MUL-383（方案 §1 的 S4）
- 本单：MUL-385
- 生成时间：2026-09-26T10:14:36.760Z
- 改前 commit：`a1e6162312b34d272e22b633d185f014f535f23e`（本分支的父提交）
- 实测 commit：`aeda289197252a86aad1492f60c8be904eaef6a9`。两阶段都用同一份 harness 与同一个 seed 在这个提交上跑；报告 JSON 里 `after.commit` 字段记的是提交前的工作树版本，两种情况下被测实现都是本提交的实现。这里不写 head SHA（下一次提交就会过期），复核不变量用 `git diff --name-only aeda2891..HEAD -- packages/`，应为空：之后的提交只改报告与 golden 元数据，不改被测实现。
- 运行机器：linux x64，64 vCPU，248 GiB RAM
- Bun：1.3.14（Node v24.3.0）
- 数据库：**SQLite（in-memory）+ 模拟过桥字节**。本机无 PostgreSQL 服务、无 docker 权限，`MULTIREMI_TEST_POSTGRES_URL` 未设置，因此按 MUL-176 / MUL-357 的降级口径采集，报告口径声明为「SQLite + 模拟过桥字节」。
- 采集方式：进程内 `in-process app.request()`
- 预热 5 次，有效样本 30 次，串行采样，p50/p95 用最近秩法（`ceil(q·n)-1`）
- 原始 JSON：[`MUL-385-issue-detail-first-screen.json`](MUL-385-issue-detail-first-screen.json)

## 判定口径

- `dbq`：请求内 SQL 语句执行次数。SQLite 下由包裹 `SqlDatabase` 的探针统计。
- `db bytes`：**模拟过桥字节**。PG 桥上 worker 用 `JSON.stringify({ rows, count })` 回传（`packages/server/src/store/db/pg-worker.ts:101`），这里对每个语句实际返回的行做同样序列化并累计长度，因此是同一量纲的可比数字，不是真实 PG 网络流量。
- `resp bytes`：回包 JSON 的字节长度。
- p50/p95：`app.request()` 端到端耗时（含鉴权、SQL、JSON 编码）。这是**进程内**数字，不含真实网络与 PG 往返；生产 209 的 p95≤150ms 验收在发版后由 `api_minute_summary` 复核，本报告不替代那一步。

## fixture

MUL-307 规模：1 个长 issue，173 条评论（105 条 root + 68 条回复），6 个 session、22 个 participant，54 个 task（prompt 1200 B / result 2400 B），另有 6 条 issue reaction、32 条评论 reaction、28 个 attachment、3 个 label、4 个子 issue、2 条依赖。

seed 固定（id 由种子 PRNG 生成、时间戳与 cursor 由种子时钟生成），`before` 与 `after` 用同一份 fixture、同一个 harness、同一组参数。fixture 与 harness 都在本分支里，因此改前数据可以在父提交上原样复现。

## 改前 / 改后对比（同口径）

| 路由 | dbq | db ms | db bytes | resp bytes | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /api/issues/:id` | 44 → 4 | 3.773 → 0.063 | 606351 → 4606 | 4623 → 4623 | 5.997 → 0.361 | 9.824 → 0.543 |
| `GET /api/issues/:id/sessions` | 19 → 4 | 0.173 → 0.139 | 15445 → 10141 | 7922 → 7922 | 0.790 → 0.412 | 1.333 → 0.541 |
| `GET /api/issues/:id/timeline?issue_session_id=@default&limit=40` | 16 → 6 | 0.417 → 0.333 | 49148 → 43898 | 38940 → 38940 | 1.309 → 1.060 | 1.643 → 1.257 |
| `GET /api/issues/:id/comments（仅留档）` | 6 → 5 | 0.576 → 0.692 | 143741 → 143696 | 148358 → 148358 | 1.678 → 1.582 | 2.284 → 2.303 |

四个路由的 `resp bytes` 都逐字节不变，说明响应形状没有漂移。三个首屏路由之外，`comments` 只测基线：前端首屏不调用它（`listComments` 在 `frontend/packages/core/issues/queries.ts` 有定义但没有调用点），MUL-249 已经把真正的首页负载放到 timeline 上。`comments` 改后 dbq 少 1 条与 p95 的微增都在采样噪声量级，不构成结论。

## sessions 规模扫描

同一 fixture 形态，session 数 1 / 5 / 20，每个 session 2 个 participant：

| session 数 | participant 数 | 改前 dbq | 改后 dbq | 改前 db ms | 改后 db ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 9 | 4 | 0.070 | 0.047 |
| 5 | 10 | 17 | 4 | 0.146 | 0.086 |
| 20 | 40 | 47 | 4 | 0.418 | 0.152 |

改前 `dbq = 7 + 2×session`（每个 session 一条 `getIssueSession` 存在性校验 + 一条 participant 扫描），改后固定 4，与 session 数无关。

## 核查中发现的冗余查询

核查范围是三个首屏路由 + 仅留档的 `comments`。每条给出处置：

| # | 位置 | 现象（改前） | 处置 |
| ---: | --- | --- | --- |
| 1 | `GET /api/issues/:id` | `issueFromParam` 先完整 hydrate，`getIssueWithTasks` 又 hydrate 一次：`SELECT *` 10 次、`SELECT id` 14 次、label join 14 次 | **已修**。改为只用 `issueFromParam` 的结果，响应所需的 labels / reactions / attachments 从已读出的 issue 上取，不再加载 tasks / children / childProgress / dependencies。dbq 44 → 4。 |
| 2 | `GET /api/issues/:id/sessions` | 每个 session 调一次 `listSessionParticipants`，它先 `getIssueSession` 校验存在、再查 participants；`dbq = 7 + 2×session` | **已修**。新增 `listSessionParticipantsForSessions(sessionIds)`，一条 `IN (…)` 查完全部；session 刚由 `listIssueSessions` 读出，不再逐个复读。20 个 session 时 dbq 47 → 4。 |
| 3 | `GET /api/issues/:id/sessions` | `listIssueSessions` 为校验存在又 `getIssue` 完整 hydrate 一次（多 2 条语句） | **已修**。存在性校验换成只读 id 的 `hasIssue`；路由已解析 issue 时再跳过这道复读。 |
| 4 | `GET /api/issues/:id/timeline?issue_session_id=@default&limit=40` | `issueTimelineResponse` 先 `getIssue`（hydrate），`listIssueTimelinePage` 再查一次 issue 存在性，`@default` 解析出的 session 又被 `getIssueSession` 复读一次，label join 3 次 | **已修**。存在性改成 `hasIssue`；`@default` 解析复用同一次 `listIssueSessions` 的结果校验 session；`listIssueTimelinePage` 接受 `skipExistenceChecks`（调用方在同一请求内已做过同样校验），`issueTimelineCompatibilityResponse` 接受 `skipIssueExistenceCheck`。dbq 16 → 6。 |
| 5 | `GET /api/issues/:id/timeline` | 同一请求内同一条 `SELECT * FROM multiremi_issues WHERE id = ?` 出现 3 次、label join 3 次 | **已修**（同 4）。改后各 1 次。 |
| 6 | `listIssueReactions` / `listAttachmentsForIssue` / `listChildIssues` / `listIssueDependencies` | 这些方法各自用 `getIssue` 做存在性校验，白付一次 hydrate（label join） | **已修**。前两者改用 `hasIssue` 并新增 `…ForExistingIssue` 变体给已解析 issue 的调用方；后两者改用 `hasIssue`。语义不变：未知 issue 仍然抛 `Issue not found: <id>`。 |
| 7 | `hydrateIssue` 自身 | 每次 hydrate 会带一条 label join | **保留**。这是 `MultiremiIssue.labels` 的契约，`/api/multiremi/issues/:id`、列表、搜索结果都依赖它。本单只去掉多余的 hydrate 次数，不再改 hydrate 的内容。 |
| 8 | `GET /api/issues/:id/comments` | 改前 `dbq=6`：评论全量查询 1 条、批量 hydration 2 条、外加 4 条 `SELECT id` 存在性复读（来自 `listLabelsForIssue` 的校验） | **未专门改 `comments`**（前端首屏不调用它），只测基线留档。改后变 5 条是第 6 条附带的效果：`hydrateIssue` 不再做存在性复读。改后 p95 与改前同一量级，响应逐字节不变。 |
| 9 | `POST`/`PATCH` 等写路由上的同类 `getIssue` 用法 | 不在本单范围 | **不修**。写路由不是首屏路径，改动会扩大评审面；已按需求只处理三个首屏接口。 |
| 10 | 鉴权链（`verifyAccessToken` + `denyCurrentUserWorkspaceAccess`） | 用户 PAT 每请求固定 3 或 4 条语句（token 3 条，登录态 PAT 再加成员 1 条，见下一节） | **不修**。任务要求只核查、记录查询数，不削弱鉴权。数字见下一节。 |

## 鉴权开销（只核查，未改动）

鉴权链没有削弱，只记录查询数：主 token 与用户 PAT 各跑一遍三路由。

- master token：`issue detail` 4、`sessions` 4、`timeline @default limit=40` 6、`comments (baseline only)` 5
- 用户 PAT：`issue detail` 8、`sessions` 8、`timeline @default limit=40` 10、`comments (baseline only)` 9
- 用户 PAT 比 master token 多 4 条语句：`verifyAccessToken` 的 3 条（`token_hash` 查询、`last_used_at` 写入、按 id 复读）和 1 条工作区成员查询。`denyCurrentUserWorkspaceAccess` 自身不查库。这与 MUL-385 的改动无关，是本单要保留的语义。
- 备注：user PAT adds verifyAccessToken (3 statements: hash lookup, last_used_at write, re-read) and one workspace membership read; the master token adds none. Unchanged by MUL-385 - recorded so a later drift is visible.
- 成员查询只对「登录态 PAT」发生（`auth-guards.ts` 里 `humanPat`：`userId !== "local"` 或 `purpose === "session"`）。harness 的 PAT 属于这一支，所以是 +4。迁移期 `userId === "local"` 的非 session PAT 不查成员，只有 +3。因此两个环境对照时，±1 的差异来自 token 分支，不是回归。

## 与生产 `dbq` 的对照（改前）

生产值取自 209 的 Server-Timing（改前，v0.2.82）。它与本 fixture 的差值可以逐条对上（QA 复核实测，误差 0）：

| 路由 | 生产 | fixture（master token） | 差值拆解 |
| --- | ---: | ---: | --- |
| `GET /api/issues/:id` | 27 | 44 | 鉴权 +3，子 issue −8，依赖 −12 |
| `GET /api/issues/:id/sessions` | 10+2N | 7+2N | 鉴权 +3 |
| `GET /api/issues/:id/timeline` | 19 | 16 | 鉴权 +3 |
| `GET /api/issues/:id/comments` | 9 | 6 | 鉴权 +3 |

- 鉴权 +3：生产那只 token 走的是 `userId === "local"` 的 PAT 分支（上一节）。
- 子 issue：改前 `listChildIssues` 对每个子 issue 调单数 `hydrateIssue`，每个付 `SELECT id` 和 label join 共 2 条。fixture 有 4 个子 issue，共 8 条。`parent_issue_id` 查询本身只有 1 条，与子 issue 数无关。
- 依赖：每条依赖 6 条，即 `listIssueDependencies` 自身 1 条，再加 `hydrateIssueDependency` 对两端各 `getIssue` 一次（每次 3 条）。2 条依赖共 12 条。
- 把 fixture 改成生产形状（无子 issue、无依赖），用 `userId === "local"` 的 PAT 实测，`/api/issues/:id` 为 27，与生产一致。改后子 issue 与依赖两项不再发生（路由不再加载 children / dependencies）；鉴权的 3 或 4 条保持不变。

## 复现命令

```bash
# 改后（本分支）
MUL385_SAMPLES=30 MUL385_WARMUPS=5 \
  bun run tests/manual/bench-issue-detail-first-screen.ts \
  --out reports/performance/MUL-385-issue-detail-first-screen.json

# 改前（父提交 a1e61623，只拷 fixture 与 harness 两个文件）
git worktree add --detach /tmp/mul385-before-tree a1e6162312b34d272e22b633d185f014f535f23e
cp tests/fixtures/multiremi/issue-detail-first-screen-fixture.ts \
   tests/manual/bench-issue-detail-first-screen.ts /tmp/mul385-before-tree/<对应目录>/
cd /tmp/mul385-before-tree
MUL385_SAMPLES=30 MUL385_WARMUPS=5 bun run tests/manual/bench-issue-detail-first-screen.ts --out /tmp/before.json

# 有可一次性创建的测试 PG 时（不要用生产库）
MULTIREMI_TEST_POSTGRES_URL=postgres://… bun run tests/manual/bench-issue-detail-first-screen.ts
```

## 结论与限制

改前后三路由的 `dbq`、`db bytes`、p95 都下降，`resp bytes` 不变，sessions 的查询数从随 session 线性增长变成常数。`GET /api/issues/:id` 不再加载 tasks / children / childProgress / dependencies —— 这些数据只有 `/api/multiremi/issues/:id` 需要，该路由保持原样。

限制：数字来自进程内 SQLite，不含真实 PG 往返与网络；真实 PG 的过桥字节只做了同口径模拟。209 上高峰窗口的 p95 需在发版后按验收项用 `api_minute_summary` 复核。
