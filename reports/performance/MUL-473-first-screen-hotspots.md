# MUL-473（S9-2 PR1）首屏热点：pending-tasks 与筛选解析的前后对比

- 本单：MUL-473（PR1 = a + b），**QA 返工版**（修 `usr_` 前缀回归 + 重采集 golden）
- 方案出处：MUL-395 评论 `cmt_3zf9gx474mh8` §3 热点表、§6 的 S9-2 行、§10 风险
- **合并的 main**：`d6714966`（Merge PR #298，含 MUL-457、MUL-390、MUL-398 A2）。合并提交 `620fc94f`；本文件与四份 JSON 都在该状态采集，改前数字在同一 harness 上跑 `d6714966` 得到。
- 改动范围：`GET /api/chat/pending-tasks`（a）、`resolveAssigneeFilterId` 背后的 `resolveAssigneeRef`（b）
- 夹具：`tests/fixtures/multiremi/first-screen-hotspots-fixture.ts`（50 会话 / 20 agent / 60 issue / 300 inbox 行，每个 agent 带 4 KB skill 正文），另加一个名字形如 `usr_` 的 agent 与一条指向它的 issue，让 b 的回落路径进入被测集合
- 驱动：`tests/manual/bench-first-screen-hotspots.ts`，进程内 `app.request()`，预热 5 / 有效样本 20（PG 轮预热 3 / 样本 10），p50/p95 用最近秩法
- 原始 JSON：
  - SQLite 改前（`d6714966`）[`MUL-473-first-screen-hotspots-before.json`](MUL-473-first-screen-hotspots-before.json)
  - SQLite 改后（`620fc94f`）[`MUL-473-first-screen-hotspots.json`](MUL-473-first-screen-hotspots.json)
  - PostgreSQL 改前 [`MUL-473-first-screen-hotspots-before-postgres.json`](MUL-473-first-screen-hotspots-before-postgres.json)
  - PostgreSQL 改后 [`MUL-473-first-screen-hotspots-after-postgres.json`](MUL-473-first-screen-hotspots-after-postgres.json)

## 口径

- `dbq`：请求内**实际执行**的 SQL 语句数（包裹 `SqlStatement` 的 `get/all/run/values`，不只数 `query()` 构造）。
- `db bytes`（dbb）：**过桥字节**。PG 桥上 worker 用 `JSON.stringify({ rows, count })` 回传，这里对每条语句实际返回的行做同样序列化并累计，因此是生产 `dbb` 的同一量纲。
- `resp bytes`：回包 JSON 长度。a、b 都**不改响应形状**，所以它应逐字节不变——下表每一行的 `resp bytes` 前后都相同。
- p50/p95：`app.request()` 端到端耗时（含鉴权、SQL、JSON 编码）。SQLite 是进程内数字；PG 轮是真实 `PostgresSyncDatabase` 桥（含 worker 往返），不含网络与 209。

## 改前 / 改后（同口径）

### SQLite 50 会话

| 路由 | dbq | dbb | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 516 → **5** | 529641 → 21759 | 4252 → 4252 | 25.4 → 2.811 |
| `GET /api/issues (assignee_id=usr_ user id, 3 tiers)` | 73 → **9** | 118517 → 26277 | 10271 → 10271 | 5.258 → 3.273 |
| `GET /api/issues (assignee_id=usr_ agent name, 3 tiers)` | 73 → **9** | 108341 → 16101 | 726 → 726 | 4.456 → 2.226 |
| `GET /api/issues (assignee_id=mem_ row id)` | 7 → **7** | 12173 → 12405 | 10271 → 10271 | 2.988 → 0.847 |
| `GET /api/issues (assignee_id=agt_)` | 10 → **7** | 8419 → 17001 | 2028 → 2028 | 1.13 → 0.844 |
| `GET /api/issues (assignee_id=<agent name>)` | 73 → **9** | 109733 → 17493 | 2028 → 2028 | 5.29 → 3.461 |

### SQLite 200 会话

| 路由 | dbq | dbb | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 2016 → **5** | 2066348 → 44590 | 17102 → 17102 | 91.276 → 3.191 |
| `GET /api/issues (assignee_id=usr_ user id, 3 tiers)` | 73 → **9** | 118517 → 26277 | 10271 → 10271 | 4.609 → 1.632 |
| `GET /api/issues (assignee_id=usr_ agent name, 3 tiers)` | 73 → **9** | 108341 → 16101 | 726 → 726 | 4.425 → 1.021 |
| `GET /api/issues (assignee_id=mem_ row id)` | 7 → **7** | 12173 → 12405 | 10271 → 10271 | 0.849 → 0.817 |
| `GET /api/issues (assignee_id=agt_)` | 10 → **7** | 8419 → 17001 | 2028 → 2028 | 1.177 → 0.931 |
| `GET /api/issues (assignee_id=<agent name>)` | 73 → **9** | 109733 → 17493 | 2028 → 2028 | 4.771 → 1.13 |

### PostgreSQL 18.4，50 会话

| 路由 | dbq | dbb | db ms | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 516 → **5** | 529941 → 21759 | 209.937 → 3.493 | 4252 → 4252 | 237.744 → 9.973 |
| `GET /api/issues (assignee_id=usr_ user id, 3 tiers)` | 73 → **9** | 118519 → 26279 | 28.303 → 6.262 | 10271 → 10271 | 37.502 → 12.455 |
| `GET /api/issues (assignee_id=usr_ agent name, 3 tiers)` | 73 → **9** | 108343 → 16103 | 31.309 → 5.543 | 726 → 726 | 39.307 → 10.23 |
| `GET /api/issues (assignee_id=mem_ row id)` | 7 → **7** | 12175 → 12407 | 4.182 → 4.047 | 10271 → 10271 | 7.536 → 7.666 |
| `GET /api/issues (assignee_id=agt_)` | 10 → **7** | 8421 → 17003 | 4.119 → 4.736 | 2028 → 2028 | 9.367 → 8.533 |
| `GET /api/issues (assignee_id=<agent name>)` | 73 → **9** | 109735 → 17495 | 31.627 → 5.505 | 2028 → 2028 | 38.001 → 10.06 |

### PostgreSQL 18.4，200 会话

| 路由 | dbq | dbb | db ms | resp bytes | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/chat/pending-tasks` | 2016 → **5** | 2067548 → 44590 | 968.407 → 5.248 | 17102 → 17102 | 1019.714 → 7.588 |
| `GET /api/issues (assignee_id=usr_ user id, 3 tiers)` | 73 → **9** | 118519 → 26279 | 39.566 → 4.135 | 10271 → 10271 | 47.011 → 7.883 |
| `GET /api/issues (assignee_id=usr_ agent name, 3 tiers)` | 73 → **9** | 108343 → 16103 | 34.979 → 4.113 | 726 → 726 | 43.25 → 7.869 |
| `GET /api/issues (assignee_id=mem_ row id)` | 7 → **7** | 12175 → 12407 | 5.358 → 4.977 | 10271 → 10271 | 7.751 → 6.428 |
| `GET /api/issues (assignee_id=agt_)` | 10 → **7** | 8421 → 17003 | 5.069 → 3.753 | 2028 → 2028 | 9.957 → 5.953 |
| `GET /api/issues (assignee_id=<agent name>)` | 73 → **9** | 109735 → 17495 | 34.124 → 4.786 | 2028 → 2028 | 40.288 → 7.778 |


## 与 ≤8 预算的关系（返工版的关键变化）

方案 §3 给 `GET /api/issues` 的目标是 **dbq ≤ 8**。返工后按 ref 形状分档：

| ref 形状 | dbq | 拆解 | 结论 |
| --- | ---: | --- | --- |
| `usr_` 用户 id / `usr_` 形状 agent 名 / 普通 agent 名（**无类型，三档都读**） | **9** | 鉴权 3（token 读、`last_used_at` 写、登录态成员读）+ Agent 候选列表 + Member 候选列表 + Squad 候选列表 + Issue 页 + labels + count | **超出预算 1**，已实测并如实记录；**未为守预算牺牲语义** |
| `agt_` 形状（前缀锁定） | **7** | 鉴权 3 + Agent 候选列表 + 页 + labels + count | 达标 |
| `mem_` 形状（前缀锁定） | **7** | 鉴权 3 + Member 候选列表 + 页 + labels + count | 达标 |
| 无匹配的 `usr_`（页为空，不 hydrate labels） | **8** | 同第一行但无 labels | 刚好达标 |

`usr_` 为什么是 9：QA 的复核要求「无类型 ref 必须按旧的 agent → member → squad 顺序解析」，而 `usr_` 开头**不能**用来锁定 member（合法 agent / squad 可能就叫这个名字）。三档各读一次候选列表，是保持语义完全等价的最低代价——旧实现同样要读三档，只是每档用「精确 id 快路径 + 列表扫描」两条语句（共 6 条）；现在一条 `listX` 覆盖同样的判定（共 3 条），比旧实现少 3 条，但比「前缀锁定」多 2 条。

**两条可选的压缩路径（都需要你拍板，本轮都没做）**：
1. 给 `usr_` 加「先按 member `user_id` 精确查，命中即 member；否则回落三档」的快路径——语义等价（未命中时仍走完整三档），但等于本单新增第三种判定路径，超出「与旧实现完全等价」的最小改动范围。可把最常见的 `usr_` 用户 id 从 9 降到 7。
2. `usr_` 开头直接锁定 member——这就是本轮修复掉的回归，会把 QA 的反例重新变红。

## 查询数与 N 的关系

- `pending-tasks` 改前 `dbq = 4 + 4N + 命中任务的额外水合`（50 会话 516、200 会话 2016，随会话数线性增长）；改后固定 **5**，与会话数无关：token 读、`last_used_at` 写、登录态成员读、一条窗口函数 CTE、一条 task 批量水合。（夹具里没有 private agent，所以没有额外的角色读；若返回的任务含 private agent，会再 +1，且按 workspace 只解析一次角色。）
- `GET /api/issues?assignee_id=…` 改前固定 73：`usr_` 形状被拿去逐个试探 agent 分支，`getAgentByRef` 的别名扫描会 `listAgents()` 并**为每个 agent 读一遍 skill 与 skill 文件正文**（20 agent ⇒ 60 条 skill 语句 + 1 条全表扫描）。改后这条路径不再读任何 `multiremi_skills` / `multiremi_skill_files`（单测断言为 0 条），Agent 候选只读一行的 lite 投影。
- 200 会话时 `pending-tasks` 改前 2016 条、改后 5 条；改后与 N 无关。

## 改动的两处实现

1. **`pendingTasks()` 语义沿用**：单 SQL 用 `ROW_NUMBER() OVER (PARTITION BY task.chat_session_id ORDER BY CASE WHEN task.status = 'queued' THEN 1 ELSE 0 END, task.priority DESC, task.chat_queue_order ASC, task.created_at ASC, task.id ASC)`，与 `chat-repo.ts` 里 `pendingTasks()` 的 `ORDER BY` 逐项一致；只 join `multiremi_chat_sessions`，不碰 `multiremi_chat_messages`（避开 MUL-402 B1）。
2. **`resolveAssigneeRef` 恢复历史搜索顺序**（返工内容）：`inferAssigneeTypeFromRef` 只保留 main 上原有的 `agt_`/`mem_`/`sqd_` 三个前缀；`usr_` 不再作为锁定前缀。无类型 ref 一律按 Agent → Member → Squad 三档，每档用一次 `listX` + `uniqueRefMatch` 层级匹配。Member 档额外保留 main 上的三条既有规则：精确行 id 优先、`user_id` 精确命中优先于别名层级、多个 `user_id` 命中即拒绝该档。Agent 档读 lite 投影（不读 skill / skill 文件）。

   **读法（重要）**：Agent → Member → Squad 只是**查询执行顺序**，不是碰撞时的裁决顺序。三档各自把匹配到的候选收集起来，最后对合起来的集合**统一判歧义**：只有一个候选才返回，两个及以上一律抛 `Ambiguous assignee reference`。所以「同一个字符串既是某 member 的 user id、又是某个 agent 的名字」在旧实现里是歧义（`Ambiguous`，HTTP total=0），**不是**「先查 Agent 所以 Agent 赢」。Member 档内部还有一条更强的规则：同一 `user_id` 命中多行时该档直接拒绝，不会继续落到别名档。

## 复现命令

```bash
# 改后（本分支，合并提交 620fc94f）
MUL473_SAMPLES=20 MUL473_WARMUPS=5 \
  bun run tests/manual/bench-first-screen-hotspots.ts \
  --out reports/performance/MUL-473-first-screen-hotspots.json

# 改前（合并的 main d6714966；harness 与 fixture 两个文件拷过去即可，驱动方式不变）
git worktree add --detach /tmp/mul473-before d6714966
cp tests/manual/bench-first-screen-hotspots.ts tests/fixtures/multiremi/first-screen-hotspots-fixture.ts \
   /tmp/mul473-before/<对应目录>/
cd /tmp/mul473-before && bun run tests/manual/bench-first-screen-hotspots.ts --out /tmp/before.json

# 真实 PostgreSQL（用完即删库；不要指向生产库）
MULTIREMI_TEST_POSTGRES_URL=postgres://… bun run tests/manual/bench-first-screen-hotspots.ts --out /tmp/after-pg.json
```

## 两份 golden 的逐字节复现

两份 golden 都能用各自脚本里写明的**同一条命令**逐字节重放，`cmp` 退出码 0、SHA-256 相同。`source` 字段是脚本默认写出的标签，不是事后手改的。

### assignee-ref golden（124 条，期望值取自 `593ff2ba`）

在 `593ff2ba` 的独立 worktree 里，放入本分支的 `capture-assignee-ref-golden.ts` 与 `assignee-ref-fixture.ts`（业务代码保持 `593ff2ba` 原样），执行：

```bash
bun run tests/fixtures/multiremi/capture-assignee-ref-golden.ts \
  --baseline --out tests/fixtures/multiremi/assignee-ref-golden.json
```

- `cmp` 退出码 **0**
- SHA-256（两处相同）：`69eece781bdf1e09062703cc521066fcf69bfe07762cb8b58510a7dfc77edc06`
- `--baseline` 默认写出的 `source` 就是文件里的 `pre-MUL-473 implementation (593ff2ba)`；`--source <label>` 可覆盖。

本轮相对上轮新增第 124 条：`collision: two members share a user id, one named like it`（两个 member 共用同一 `user_id`，其中一个的 name 也命中该 ref）。旧实现该条为 `Assignee not found: usr_assignee_dupe_shared`、HTTP total=0——即 Member 档拒绝重复 `user_id` 后**不再**回落到别名档。

### first-screen golden

在合并提交 `620fc94f`（或本分支其后任意提交）执行：

```bash
bun run tests/fixtures/multiremi/capture-first-screen-hotspots-golden.ts \
  --baseline --out tests/fixtures/multiremi/first-screen-hotspots-golden.json
```

- `cmp` 退出码 **0**
- SHA-256（两处相同）：`199fe5e995a6c8e03319a94ee8f267746924eb7a8fd5eb14f08d695f335cfbee`
- label 是脚本里的常量，与文件一致；`--source <label>` 可覆盖。

**口径修正**：本文件与 `0b2c6e81` 版相比，整份 JSON 共有 **100 处**差异 = **99 个新增响应字段**（33 个 issue × `parent_done_grant_at`/`_by`/`_agent_id`，全为 `null`）+ **1 处 `$.source` 元数据**。上轮交付与报告只写了「只有 99 处」，把 `source` 这处漏在口径之外；现按 100 处如实记录。响应体本身除那 99 个 null 字段外**无任何**差异（无删除、无改名、无值变化、无顺序与计数变化），这一点由 QA 第 6 项递归 diff 独立确认。

## 与上一版（`0b2c6e81`）数字的差异

| 路由 | 上一版 dbq | 返工版 dbq | 原因 |
| --- | ---: | ---: | --- |
| `GET /api/issues?assignee_id=<usr_ 用户 id>` | 8 | **9** | `usr_` 由「前缀锁定 member」改成「三档回落」，多读 Agent 与 Squad 两份候选列表 |
| `GET /api/issues?assignee_id=<usr_ 形状 agent 名>` | 12（走名字路径） | **9** | 同上；这条路径本来就已回落，本轮把每档的两条语句合并为一条 |
| `GET /api/issues?assignee_id=<agt_ id>` | 6 | **7** | 本轮不再用 `getAgentByRef` 的精确 id 快路径，改由 `listAgentsLite` + 层级匹配覆盖（夹具多 1 条） |
| `GET /api/issues?assignee_id=<agent 名>` | 12 | **9** | 每档两条语句合并为一条 |
| `GET /api/chat/pending-tasks` | 5 | **5** | 未变（a 本轮未动） |

`dbb` 在 `usr_` 路径上由 21759 略增至 26277，原因是多读一份 member 候选列表；仍比改前的 118517 低 78%。

## 限制

- SQLite「过桥字节」是同口径模拟，不是真实网络流量。
- PG 轮是本地 18.4 实例（`127.0.0.1:55433`，非默认端口），数字含 worker 往返，不含 nginx 与公网；该实例已停库并删除数据目录。
- 209 上线后的 `api_minute_summary` / `api_slow_request` 对比由 QA 与 Explorer 另做，不在本 PR 内。
