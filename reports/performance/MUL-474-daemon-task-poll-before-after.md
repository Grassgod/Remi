# MUL-474 S8e：daemon 任务级轮询的前后对比（守卫与任务行按需读取）

| | |
| --- | --- |
| 单号 | MUL-474（父单 MUL-383 的 S8e） |
| 基线 main | `1bb060fb`（开工前确认的 head） |
| after head | `d78f9430`（`agent/MUL-474`，已 `git merge origin/main` 到 `d6714966`） |
| 数据库 | 真实 PostgreSQL 18.4，`PostgresSyncDatabase`（Worker + SharedArrayBuffer + `Atomics.wait`），每次运行新建一次性库并删除 |
| 采集脚本 | `tests/manual/bench-daemon-task-poll.ts` |
| fixture | `tests/fixtures/multiremi/daemon-task-poll-fixture.ts`，prompt 131,072 B，一条 Feishu 回执投递，第二个 Runtime + 独立 daemon token |
| 原始数据 | before `reports/performance/MUL-474-daemon-task-poll-before.json`、after `reports/performance/MUL-474-daemon-task-poll-after.json` |
| 采集方式 | 同一份脚本分别在 `1bb060fb`（干净 worktree）与本分支 head 上跑，无代码分支选择实现 |

## 口径

- **判定值取 `Server-Timing` 的 `dbq` / `dbb`**，由生产代码 `observability/request-metrics.ts` 从 `pg-worker.ts` 写进共享缓冲区的字节数累积而来，与 209 上 `api_slow_request.db_queries` / `db_bytes` 同一量。脚本不自己实现一套计数。
- 三条路由都用**真实 daemon access token** 走完整中间件，所以 `verifyAccessToken` 的 token 查询（以及被节流的 `last_used_at` 写）都在数里。
- 每条路由 2 次 warmup + 5 次采样，`dbq` 与 `dbb` 在 5 次采样之间必须完全相等，否则这次运行不算结论。三条路由两次运行都 stable。
- 逐语句归因由包装 `SqlDatabase` 复刻 `JSON.stringify({ rows, count })` 得到，只用于定位，不参与判定。
- 未访问 209，未改 `./wiki`，未执行 `remi wiki push`，无 token / 凭证 / 连接串落盘。

## 前后对比（同 fixture、同脚本、同 PG）

| 路由 | 语句数 before | 语句数 after | 过桥字节 before | 过桥字节 after | 字节降幅 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /api/daemon/tasks/:id/status` | 18 | **5** | 401,432 B | **1,763 B** | −99.6% |
| `GET /api/daemon/tasks/:id/steer` | 16 | **4** | 401,347 B | **1,314 B** | −99.7% |
| `POST /api/daemon/tasks/:id/messages`（1 条） | 25 | **10** | 668,083 B | **1,869 B** | −99.7% |

方案 §5 的字节门槛（`status` ≤8 KB、`steer` ≤2 KB）：**均满足**，且是在 128 KB prompt 上。

after 的语句构成（本次采样，`status` 5 条）：token 查询 1 + 任务身份投影 1 + Runtime lite 读 1 + `status` 投影 1 + 回执 ID 三表 JOIN 1。这里没有 `last_used_at` 写，是因为采集脚本按 status → steer → messages 顺序跑，同一 token 已被同一进程在 60 s 内验证过，节流生效；计数测试用每个用例新建的 store 跑，`status` 因此是 6 条（多这一条写）。

`steer` 4 条（无回执 JOIN、无 `last_used_at` 写）；`messages` 10 条 = 上面 4 条 + `MAX(seq)` 1 + INSERT 1 + 写任务 `updated_at` 1 + 回读本次写入的消息 1 + `appendTaskMessages` 的通知前身份再读 1（`GET messages` 是另一条路由，会多一次身份读）。

计数测试里的上限（每个用例新建 store，含 `last_used_at` 写）：`status` 6、`steer` 5、`messages` 9。

before 的主要构成：3 × `SELECT * FROM multiremi_tasks WHERE id = ?`（守卫 + 存在性检查 + handler/store 再读，每次 133,125 B）、1 条 Runtime 行 + 3 条派生读、2 条飞书例外四表 JOIN、3 条 `autopilot_runs` 查一条。守卫与 handler 的整行读是 401 KB 里的绝大部分。

## 鉴权矩阵（同一脚本同时记录）

| 凭证 | 路由 | before | after |
| --- | --- | ---: | ---: |
| 拥有者 daemon | `GET status` | 200 | 200 |
| 拥有者 daemon | `GET steer` | 200 | 200 |
| 其他 daemon | `GET status` | 403 | 403 |
| 其他 daemon | `GET steer` | 403 | 403 |
| 其他 daemon | `POST messages` | 403 | 403 |
| 其他 daemon | `POST complete` | 403 | 403 |
| 部署 master token | `GET status` | 200 | 200 |

403 的响应体逐字节相同（`{"error":"forbidden for daemon identity","code":"daemon_identity_forbidden"}`）。

## 响应体 golden

同一 fixture 下 `GET status` 的 JSON，before 与 after 逐字节相同：

```json
{"completed_at":null,"error":null,"receipt_message_ids":["om_mul474_receipt"],"result":null,"session_id":"ises_mul474_poll_session","started_at":"2026-09-27T00:00:00.000Z","status":"running","task_id":"tsk_mul474_poll","usage":[{"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":1000,"model":"gpt-5","outputTokens":500,"provider":"codex","totalTokens":0}],"work_dir":"/tmp/mul474-work"}
```

另有一份独立 golden（`tests/fixtures/multiremi/daemon-task-poll-golden.json`，由 `capture-daemon-task-poll-golden.ts` 在 `1bb060fb` 上采集、在本分支 head 上复采）：`sha256 c45bd5349c314bfcca3fee6434d3e0ba76069099ab1d5e4206153ce56a3c285c`，两处完全一致，并由 `mul474-daemon-task-poll-count.test.ts` 的 golden 用例持续守住。
