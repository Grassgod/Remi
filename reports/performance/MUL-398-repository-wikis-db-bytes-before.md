# MUL-398 A: repository-wikis 投影 before 基线

| | |
| --- | --- |
| 阶段 | **before**（本轮只做准备，不做产品代码改动） |
| 分支 / 提交 | `agent/MUL-398` @ `43d75571e736293b1300fabf1c54c2d03302de57`（= `origin/main`，与 main 无差异） |
| 数据库 | 真实 PostgreSQL 18.4，`PostgresSyncDatabase`（Worker + SharedArrayBuffer + `Atomics.wait`），每次运行新建一次性库 |
| fixture | `tests/fixtures/multiremi/repository-wikis-bridge-fixture.ts`，146 页 / 178 个 run / 133 条编译记录 |
| 采集脚本 | `tests/manual/bench-repository-wikis-db-bytes.ts` |
| 结果 JSON | `reports/performance/MUL-398-repository-wikis-db-bytes-before.json` |
| 单独提交 | fixture 与脚本随本 PR 一起提交，因此产物代码改动落地后可以用同一份文件复跑 after |

## 口径

- **`db_bytes` 是过桥字节，不是 HTTP 响应体。** 判定值取 `Server-Timing` 响应头里的 `dbb`：该值由生产代码 `packages/server/src/observability/request-metrics.ts` 的 `recordDbQuery()` 从 `pg-worker.ts` 写进共享缓冲区的字节数累积而来，也就是 209 上 `api_slow_request.db_bytes` 的同一个量。脚本不自己实现一套计数，避免「测的是脚本不是生产」。
- **`dbQueries`** 取同一响应头的 `dbq`；`db` / `dbp` / `total` 同理。
- **每个语句的归因**由包装 `SqlDatabase` 复刻 `JSON.stringify({ rows, count })` 得到，只用于定位是哪些语句贡献了字节，不参与判定。
- 每次运行内建 warmup 1 次 + 5 个采样；`db_bytes` / `db_queries` 在 5 个采样之间必须完全相等，否则这是测量噪声而不是结论。
- 无法访问的 `MULTIREMI_TEST_POSTGRES_URL` 会让脚本非零退出，不会静默回落 SQLite：桥字节只在真实 PG 桥后面才存在。
- 全程未接触 209，未改 `./wiki`，未执行 `remi wiki push`，无 token / 连接串落盘。

## fixture 与 209 的对应关系

fixture 复刻的是**行形状**，不是 209 的具体数据（209 保持只读，基线由 Explorer 另取）。

| 生产事实 | fixture 里的做法 |
| --- | --- |
| Wiki 正文在 OpenViking，控制面行 `body` 为空 | `pageStorage: "openviking"`（默认），行内只留 `content_uri` / `sha256` / `snapshot_oid` |
| `SELECT r.* FROM multiremi_autopilot_runs` 读整行，`payload`（SCM 事件的 changed-file patch）与 `result`（任务输出）是大头 | 130 个 `repository_id` 作用域的 SCM run，`payload` 46.8 KB / `result` 32 KB |
| 观测查询同时匹配 `schedule_target` 指向仓库的 run，构建状态查询还要求该 run 有编译记录 | 48 个仅 `schedule_target` 的调度 run，其中 3 个带编译记录 |
| SCM 触发的 run 才有 SCM payload；调度入队的 run 只写 `{timezone, cronExpression}` | 调度 run 的 payload 就是那个小对象 |
| — | 参数可用 `MUL398_*` 环境变量覆盖，便于复现别的形状 |

**一处必须说明的口径取舍。** 209 上两条语句分别是 12.2 MB 与 10.8 MB，差值 1.4 MB。本 fixture 里 `payload` 的差距（12.31 MB vs 10.87 MB，差 1.44 MB）来自 48 个仅调度 run 的小 payload；也就是说，**两条语句的覆盖率差异主要由 payload 决定，而不是 result**。这与 Explorer 只给出两个总量、没有给出行数的事实一致，属于合理重建；差异落在同一条语句上时绝对值会变，但「整行读大列」这个结论不受影响。

## before 结果

| 指标 | 值 |
| --- | --- |
| `db_bytes` | **23,471,509 B（22.38 MiB）** |
| `db_queries` | 11 |
| p50 | 147.4 ms |
| max | 163.7 ms |
| HTTP 响应体 | 1,065 B（响应体小，字节全在过桥） |
| 采样一致性 | 5/5 采样 `db_bytes` 与 `db_queries` 完全相同；二次独立运行逐字节相同 |

超过 1 MB 的部分几乎全部来自两条 `SELECT r.* FROM multiremi_autopilot_runs`：

| 语句 | 字节 | 占比 | 调用 |
| --- | --- | --- | --- |
| `repositoryWikiObservability` 的 run 查询 | 12,306,475 | 52.4% | 1 |
| `listLatestRepositoryAutopilotRuns` 的 run 查询 | 10,872,505 | 46.3% | 1 |
| `SELECT * FROM multiremi_repository_wiki_docs` | 120,178 | 0.5% | 1 |
| `SELECT * FROM multiremi_autopilot_runs WHERE id = ?` | 114,751 | 0.5% | 2 |
| `compilations()` 的 join 查询 | 55,510 | 0.2% | 1 |
| `SELECT * FROM multiremi_autopilots WHERE id = ?` | 1,350 | 0.01% | 2 |

两条 run 语句的字节量与 209 的 12.2 MB / 10.8 MB 相差 1% 以内。

## 与验收标准的关系

验收要求「repository-wikis 路由单次 `db_bytes` < 1 MB」。基线是 23.47 MB，是门槛的 22 倍；两条 run 语句单独就占了 22.1 MB。剩下的所有语句合计只有 0.29 MB，因此**只投影这两条语句即可达标，不需要动其它读路径**。

## 复跑方式

```bash
MULTIREMI_TEST_POSTGRES_URL=postgres://… \
  bun run tests/manual/bench-repository-wikis-db-bytes.ts \
  --out reports/performance/MUL-398-repository-wikis-db-bytes-before.json
```

after 用同一份 fixture、同一份脚本，只把输出路径换成 after 文件、环境变量 `MUL398_STAGE=after`。

## 下一步（等 MUL-386 / PR #255 合入 main 之后再动）

1. `git merge origin/main`。
2. 按调用方核查结论投影 `SELECT r.*`，用同一脚本、同一 fixture 测 after。
3. 单测覆盖投影；全套 PG 单测在 8MB 上限下全绿。
4. 前后对比报告放 `reports/performance/`。
