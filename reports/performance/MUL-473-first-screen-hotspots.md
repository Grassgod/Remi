# MUL-473（S9-2 PR1）首屏热点：pending-tasks 与筛选解析的前后对比

- 本单：MUL-473（PR1 = a + b）
- 方案出处：MUL-395 评论 `cmt_3zf9gx474mh8` §3 热点表、§6 的 S9-2 行、§10 风险
- 生成时间见各 JSON 的 `generatedAt`
- 改动范围：`GET /api/chat/pending-tasks`（a）、`resolveAssigneeFilterId` 背后的 `resolveAssigneeRef`（b）
- 夹具：`tests/fixtures/multiremi/first-screen-hotspots-fixture.ts`（50 会话 / 20 agent / 60 issue / 300 inbox 行，每个 agent 带 4 KB skill 正文）
- 驱动：`tests/manual/bench-first-screen-hotspots.ts`，进程内 `app.request()`，预热 5 次、有效样本 20 次（PG 轮为预热 3 / 样本 10），p50/p95 用最近秩法
- 原始 JSON：
  - SQLite 改前 [`MUL-473-first-screen-hotspots-before.json`](MUL-473-first-screen-hotspots-before.json)
  - SQLite 改后 [`MUL-473-first-screen-hotspots.json`](MUL-473-first-screen-hotspots.json)
  - PostgreSQL 改前 [`MUL-473-first-screen-hotspots-before-postgres.json`](MUL-473-first-screen-hotspots-before-postgres.json)
  - PostgreSQL 改后 [`MUL-473-first-screen-hotspots-after-postgres.json`](MUL-473-first-screen-hotspots-after-postgres.json)

## 口径

- `dbq`：请求内**实际执行**的 SQL 语句数（包裹 `SqlStatement` 的 `get/all/run/values`，不只数 `query()` 构造）。
- `db bytes`（dbb）：**过桥字节**。PG 桥上 worker 用 `JSON.stringify({ rows, count })` 回传，这里对每条语句实际返回的行做同样序列化并累计，因此是生产 `dbb` 的同一量纲。
- `resp bytes`：回包 JSON 长度。a、b 都**不改响应形状**，所以它应逐字节不变。
- p50/p95：`app.request()` 端到端耗时（含鉴权、SQL、JSON 编码）。SQLite 是进程内数字；PG 轮是真实 `PostgresSyncDatabase` 桥（含 worker 往返），不含网络与 209 上限。209 的对比由 QA/Explorer 另做。

## 改前 / 改后（SQLite，50 会话）

| 路由 | dbq | dbb | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 516 → 5 | 529641 → 21759 | 4252 → 4252 | 24.885 → 1.188 |
| `GET /api/issues?assignee_id=usr_…` | 72 → 8 | 116536 → 11055 | 8921 → 8921 | 4.994 → 1.572 |
| `GET /api/issues?assignee_id=agt_…` | 10 → 7 | 8149 → 3539 | 1758 → 1758 | 1.238 → 0.862 |
| `GET /api/issues?assignee_id=<agent name>` | 72 → 12 | 108832 → 16592 | 1758 → 1758 | 4.383 → 1.143 |

## 改前 / 改后（SQLite，200 会话）

| 路由 | dbq | dbb | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 2016 → 5 | 2066348 → 44590 | 17102 → 17102 | 89.987 → 3.419 |
| `GET /api/issues?assignee_id=usr_…` | 72 → 8 | 116536 → 11055 | 8921 → 8921 | 4.645 → 1.206 |
| `GET /api/issues?assignee_id=agt_…` | 10 → 7 | 8149 → 3539 | 1758 → 1758 | 0.824 → 0.665 |
| `GET /api/issues?assignee_id=<agent name>` | 72 → 12 | 108832 → 16592 | 1758 → 1758 | 4.356 → 2.916 |

## 改前 / 改后（真实 PostgreSQL 18.4，50 会话）

| 路由 | dbq | dbb | db ms | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 516 → 5 | 529941 → 21759 | 253.259 → 5.524 | 4252 → 4252 | 267.935 → 9.173 |
| `GET /api/issues?assignee_id=usr_…` | 72 → 8 | 116538 → 11057 | 37.824 → 4.806 | 8921 → 8921 | 42.744 → 10.811 |
| `GET /api/issues?assignee_id=agt_…` | 10 → 7 | 8151 → 3541 | 7.401 → 3.821 | 1758 → 1758 | 12.699 → 8.926 |
| `GET /api/issues?assignee_id=<agent name>` | 72 → 12 | 108834 → 16594 | 39.484 → 9.999 | 1758 → 1758 | 51.541 → 14.013 |

## 改前 / 改后（真实 PostgreSQL 18.4，200 会话）

| 路由 | dbq | dbb | db ms | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 2016 → 5 | 2076095 → 44590 | 952.644 → 4.376 | 17102 → 17102 | 1200.283 → 10.345 |
| `GET /api/issues?assignee_id=usr_…` | 72 → 8 | 116538 → 11057 | 33.136 → 4.092 | 8921 → 8921 | 38.894 → 9.783 |
| `GET /api/issues?assignee_id=agt_…` | 10 → 7 | 8151 → 3541 | 5.628 → 3.587 | 1758 → 1758 | 8.509 → 8.643 |
| `GET /api/issues?assignee_id=<agent name>` | 72 → 12 | 108834 → 16594 | 36.186 → 8.724 | 1758 → 1758 | 46.985 → 12.575 |

## 目标对照（方案 §3 / §6 的 S9-2 行）

| 目标 | 实测（SQLite / PG，50 会话） | 结论 |
| --- | --- | --- |
| `pending-tasks` dbq ≤ 8 | 5 / 5 | 达标 |
| `pending-tasks` db < 10ms | 0.351 / 5.524 ms | 达标（PG 也是单次 CTE，5 条语句中的 DB 总时间） |
| my-issues `GET /api/issues` dbq ≤ 8 | 8 / 8 | 达标 |

## 查询数与 N 的关系

`pending-tasks` 改前 `dbq = 4 + 4N + 命中任务的额外水合`（50 会话 516、200 会话 2016，随会话数线性增长）；改后固定 **5～6**，与会话数无关：token 读、`last_used_at` 写、登录态成员读、一条窗口函数 CTE、一条 task 批量水合，以及**当且仅当**返回的任务里有私有 agent 时多一条角色读（`canCurrentUserAccessAgentChecker` 每个 workspace 最多解析一次角色，不随 agent 数增长）。本表 harness 的夹具把所有 agent 设为 workspace 可见，所以是 5。

`GET /api/issues?assignee_id=usr_…` 改前固定 72：`usr_` 形状的 ref 会被拿去逐个试探 Agent 分支，`getAgentByRef` 的别名扫描会 `listAgents()` 并**为每个 agent 读一遍 skill 与 skill 文件正文**（20 agent ⇒ 60 条 skill 语句 + 1 条全表扫描）。改后 8，与 issue 数（1 / 60 / 300）无关。

## 改动的两处实现

1. **`pendingTasks()` 语义沿用**：单 SQL 用 `ROW_NUMBER() OVER (PARTITION BY task.chat_session_id ORDER BY CASE WHEN task.status = 'queued' THEN 1 ELSE 0 END, task.priority DESC, task.chat_queue_order ASC, task.created_at ASC, task.id ASC)`，与 `chat-repo.ts` 里 `pendingTasks()` 的 `ORDER BY` 逐项一致；只 join `multiremi_chat_sessions`，不碰 `multiremi_chat_messages`（避开 MUL-402 B1）。排序语义由 golden 与专门的两个排序用例锁住。
2. **`resolveAssigneeRef` 的 ref 形状识别**：`usr_`/`mem_` 直接走 member 分支，`agt_` 走 agent 分支，`sqd_` 走 squad 分支；只有形状无信息的 ref 才按原顺序试探三类。Agent 分支改走 `getAgentLiteByRef`（只读 agent 行，不读 skill / skill 文件）。

## 复现命令

```bash
# 改后（本分支）
MUL473_SAMPLES=20 MUL473_WARMUPS=5 \
  bun run tests/manual/bench-first-screen-hotspots.ts \
  --out reports/performance/MUL-473-first-screen-hotspots.json

# 真实 PostgreSQL（用完即删库；不要指向生产库）
MULTIREMI_TEST_POSTGRES_URL=postgres://… \
  bun run tests/manual/bench-first-screen-hotspots.ts --out /tmp/after-pg.json

# 改前：在 main（593ff2ba）上跑同一个文件。harness 与 fixture 都只读驱动
# `app.request()`，没有分支选择被测实现。
```

## 限制

- SQLite「过桥字节」是同口径模拟，不是真实网络流量。
- PG 轮是本地 18.4 实例（127.0.0.1，非默认端口），数字含 worker 往返，不含 nginx 与公网。
- 209 上线后的 `api_minute_summary` / `api_slow_request` 对比由 QA 与 Explorer 另做，不在本 PR 内。
- `GET /api/issues?assignee_id=<agent name>` 改后是 12 条：名字形态无法从形状判断类型，仍按原顺序试探三类；这条路径不是首屏热点（my-issues 发的是 `usr_` 形状），保留原语义优先。
