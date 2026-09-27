# MUL-398 A: repository-wikis 投影 after 与前后对比

| | |
| --- | --- |
| 分支 / head | `agent/MUL-398`（本 PR #273，含 MUL-386 合入后的 `fd52ff9e`） |
| 数据库 | 真实 PostgreSQL 18.4，`PostgresSyncDatabase`（Worker + SharedArrayBuffer + `Atomics.wait`），每次运行新建一次性库 |
| fixture | `tests/fixtures/multiremi/repository-wikis-bridge-fixture.ts`（146 页 / 178 run / 133 编译记录） |
| 采集脚本 | `tests/manual/bench-repository-wikis-db-bytes.ts`（与准备轮同一份，未改动测量逻辑） |
| 采样 | warmup 1 + n=5；两次独立 after 运行逐字节相同 |
| before 结果 | `reports/performance/MUL-398-repository-wikis-db-bytes-before.json` |
| after 结果 | `reports/performance/MUL-398-repository-wikis-db-bytes-after.json` |

## 1. 口径（与准备轮完全一致，未改）

- 判定值 `db_bytes` 取生产 `Server-Timing` 头的 `dbb`，即 `observability/request-metrics.ts` 的 `recordDbQuery()` 从 `pg-worker.ts` 共享缓冲区字节数累积的值——209 上 `api_slow_request.db_bytes` 的同一个量。脚本不自造计数器。
- 每语句归因由包装 `SqlDatabase` 复刻 `JSON.stringify({ rows, count })`，只用于定位，不参与判定。
- `MULTIREMI_TEST_POSTGRES_URL` 不可达时非零退出，不回落 SQLite。
- **响应体逐字节**：把两次运行的 `responseContract.body` 按 key 排序做 `JSON.stringify` 全等比较。为此把 fixture 文档行的 `created_at` / `updated_at` 固定为常量（此前用 `nowIso()`，会让 `last_published_at` 每次不同，无法做字节比对）。

## 2. before / after

| 指标 | before | after | 变化 |
| --- | --- | --- | --- |
| **`db_bytes`** | 23,471,509 B（22.38 MiB） | **392,775 B（0.375 MiB）** | **−98.3%** |
| `db_queries` | 11 | 11 | 不变 |
| p50 | 147.8 ms | 19.5 ms | −87% |
| p95 / max | 160.1 ms | 21.9 ms | −86% |
| `db_ms`（桥等待） | 73.1 ms | 15.7 ms | −79% |
| `db_parse_ms`（主线程 JSON.parse） | 31.9 ms | 1.5 ms | −95% |
| HTTP 响应体 | 1,067 B | 1,067 B | 不变 |
| **响应体逐字节** | — | — | **完全相同** |
| 采样一致性 | 5/5 相同 | 5/5 相同 | — |

**响应契约**：40 个叶子值、20 个契约字段路径，`fieldPaths` 集合相同，按 key 排序后的 JSON 全等。唯一改动过的两个叶子（`updated_at` / `last_published_at`）在固定 fixture 时钟后也完全一致。

### 2.1 两条被投影的语句

| 语句 | before | after | 变化 |
| --- | --- | --- | --- |
| `repositoryWikiObservability` 的 run 查询（178 行） | 12,306,475 B | **34,626 B** | −99.7% |
| `listLatestRepositoryAutopilotRuns`（133 行） | 10,872,505 B | **65,620 B** | −99.4% |
| 合计 | 23,178,980 B | 100,246 B | −99.6% |

### 2.2 投影后剩余的最大贡献（本地 fixture）

| 语句 | B/次 | 调用 | 说明 |
| --- | --- | --- | --- |
| `SELECT * FROM multiremi_repository_wiki_docs` | 120,178 | 1 | 146 行元数据；OpenViking 模式下 `body` 为空串 |
| `SELECT * FROM multiremi_autopilot_runs WHERE id = ?`（`getAutopilotRun`） | 114,751 | 2 | 整行读，含 payload/result；本单范围外 |
| 构建状态投影 | 65,620 | 1 | |
| `compilations()` 的 join | 55,510 | 1 | 133 条编译记录；本单范围外 |
| 观测投影 | 34,626 | 1 | |

## 3. 209 规模估算：本地达标，但 209 真实规模很可能不达标

**这是本次交付需要裁决的点，不能只报本地数字。**

### 3.1 两条投影语句本身在 209 行数下就用光了 1MB 预算

用本地实测的每行常数（`payload` 为 NULL 的纯标量行）乘以 Explorer 的行数：

| 语句 | 209 行数 | 本地实测 B/行 | 估算 |
| --- | --- | --- | --- |
| 观测查询 | 1,842 | 178.2 | 328,244 B |
| 构建状态查询 | 1,443 | 483.2 | 697,258 B |
| **合计** | | | **1,025,502 B（0.98 MiB）** |

剩余预算 22.5 KiB。B/行常数做 ±10% 敏感度（9 组）时 6 组 <1MB、3 组越线——即**结论对常数不敏感，两条语句本身就贴着上限**。

B/行常数的来源：把 fixture 规模放大到 1,842 / 1,443 行、`payload` 全为 NULL，直接量 `JSON.stringify({ rows, count }).length`，再除以行数。行数越多常数越收敛（1 → 50 仓库时观测行 188.0 → 178.2 B/行，构建行 493.0 → 483.2 B/行）。

### 3.2 209 那条 32.3MB 路由里约 7.4MB 不属于这两条语句

用 Explorer 自己的数字对账：

| 量 | 值 |
| --- | --- |
| 路由 `db_bytes`（`api_slow_request`） | 32,349,139 B |
| 两条语句 `payload` + `result` 未压缩文本（`octet_length`） | 24,921,467 B |
| **差额 = 路由的其余读取** | **7,427,672 B（7.4 MB）** |

桥上传的是驱动返回的 TEXT（解压后），所以对账用未压缩口径；按 `pg_column_size` 全行（18.2MB）对账差额更大（14.2MB）。**任一口径下，路由的非 run 部分本来就远大于 1MB。**

### 3.3 这部分几乎全是「每个有构建记录的仓库」的固定开销

本地多仓库扫描（每仓库 2 个 run、`payload` 全 NULL）实测：

| 语句 | B/仓库 | 说明 |
| --- | --- | --- |
| `getAutopilotRun`（`repositoryWikiRunHasPublication` 触发） | 11,676 | 整行读，含 payload/result |
| `SELECT * FROM multiremi_autopilots WHERE id = ?` | 647 | |
| 每仓库文档行 | ~600 | |
| **合计** | **≈12.9 KB/仓库** | 另有每仓库 `getTask` 与 `compilations()` 的 `taskOutcome` 查询 |

仓库数从 1 → 50 时路由 `db_bytes` 从 14.8 KB 线性涨到 723.6 KB，确认线性关系。

### 3.4 把 209 的三个已知量都塞进本地模型

固定 Explorer 测得的 1,842 观测行、1,443 构建行与每行 payload/result 体量，只让「有构建记录的仓库数」变化（该值 Explorer 未给，用 `db_queries=140` 反推约 45）：

| 仓库数 | 本地模型 db_bytes | 判定 |
| --- | --- | --- |
| 26 | 1,476,496 B（1.41 MiB） | 越线 |
| 46 | 1,693,635 B（1.62 MiB） | 越线 |
| 92 | 2,185,546 B（2.08 MiB） | 越线 |

三个场景全部越线，主因是 3.1 的两条语句（0.86 MB 与 0.32 MB）叠加 3.3 的每仓库开销。

### 3.5 结论

**本单批准的两条语句投影是正确的、必要的，且在本地 fixture 上把 `db_bytes` 从 22.38 MiB 压到 0.375 MiB；但在 209 现有数据规模下，仅靠这两条语句无法保证 `< 1MB` 验收。**

要达到 209 上的 `< 1MB`，还需（均在本单授权之外）：

1. `getAutopilotRun` 的整行读改为同一套投影——它是 `repositoryWikiRunHasPublication()` 的输入，只需 `id / autopilot_id / repository_id / task_id / dedupe_key / payload(条件) / schedule_target`；本地估算每仓库 11.7 KB → 约 1 KB。
2. `listWorkspaceRepositoryWikiDocs` 不读 `body`（OpenViking 模式下该列为空串），146 行 120 KB → 约 25 KB，且在 209 上随仓库页数增长。
3. 可选：`compilations()` 的 `SELECT r.*` 同样投影（`result_summary` 之外的大列）。

按 3.4 的模型，三项合计可再降约 0.7–1.3 MB，209 规模有望落到 0.4–0.7 MB。

## 4. CLI 输出逐字节比对

摘要路由的响应被 `remi wiki repository list` 直接渲染，因此「CLI 输出不变」也需要证据，而不只是 HTTP 体不变。

用真实 CLI 子进程打真实 API 进程（真实 PG、同一 fixture），在**投影前**与**投影后**两套源码上各跑一次，把 stdout / stderr 落盘后 `cmp`：

| 命令 | stdout | stderr | sha256（前后一致） |
| --- | --- | --- | --- |
| `remi wiki repository list --output json` | 1,482 B | 0 B | `ff0e13b1b7740046d5a52ab54cbc4bf7424dc5e238b0d5f08c1bc90bf0848060` |
| `remi wiki repository list` | 68 B | 0 B | `5960a08c77a7d66caa31ced2318d4945b0e7b1122ac1132669408b53d44e41b9` |

两个命令的 stdout 与 stderr 在前后版本之间**逐字节相同**。投影前那一次同时输出了 Explorer 描述的两条 `api_large_db_reply`（12,306,475 / 10,872,505 B），投影后没有大包日志，确认两次跑的是同一份数据、不同实现。

> 做法说明：CLI 读的是 `MULTIREMI_SERVER_URL` / `MULTIREMI_TOKEN`（`apps/remi/cli/multiremi.ts:315-360`）。比对脚本只在本机 loopback 起临时 API，不接触任何远端。

## 5. 复现

```bash
# 需要一次性可建库的真实 PG
MULTIREMI_TEST_POSTGRES_URL=postgres://… \
MUL398_STAGE=after \
  bun run tests/manual/bench-repository-wikis-db-bytes.ts \
  --out reports/performance/MUL-398-repository-wikis-db-bytes-after.json
```

fixture 与脚本参数可用 `MUL398_*` 覆盖；`MUL398_STAGE` 只写进报告的 `stage` 字段，不影响测量。
