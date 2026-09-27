# MUL-398 A2: repository-wikis 路由剩余 db_bytes（209 规模）

| | |
| --- | --- |
| 分支 / head | `agent/MUL-398`（PR #298，Draft） |
| before 基线 | `d905961b`（A / PR #273 的合入提交） |
| 数据库 | 真实 PostgreSQL 17.5，`PostgresSyncDatabase`（Worker + SharedArrayBuffer + `Atomics.wait`），每个场景新建一次性库；连接串只作为环境变量传入（`postgres://…`） |
| 采集脚本 | `tests/manual/bench-repository-wikis-a2-scale.ts`（209 规模模型）、`tests/manual/bench-repository-wikis-db-bytes.ts`（本地 fixture 同口径前后）、`tests/manual/bench-repository-wikis-a2-cli.ts`（CLI 逐字节） |
| 采样 | warmup 1 + n=5；before/after 用同一脚本、同一 fixture |
| after 结果 | `reports/performance/MUL-398-repository-wikis-a2-db-bytes.json` |

## 1. 口径

- 判定值 `db_bytes` 取生产 `Server-Timing` 头的 `dbb`，即 `observability/request-metrics.ts` 的 `recordDbQuery()` 从 `pg-worker.ts` 共享缓冲区字节数累积的值——209 上 `api_slow_request.db_bytes` 的同一个量。脚本不自造计数器。
- 每语句归因由包装 `SqlDatabase` 复刻 `JSON.stringify({ rows, count })`，只用于定位，不参与判定。
- `MULTIREMI_TEST_POSTGRES_URL` 不可达时非零退出，不回落 SQLite。
- 209 规模模型直接按 Explorer 的行数 seed：观测语句 1,842 行 = 1,443 个仓库级 run + 399 个 schedule-only run；构建状态语句因此同样是 1,443 行。文档行按生产形态（OpenViking）写入，行内 `body` 为空串。

## 2. 本地 fixture 前后（146 页 / 178 run / 133 编译记录）

| 指标 | before | after | 变化 |
| --- | --- | --- | --- |
| **`db_bytes`** | 392,775 B | **177,561 B** | **−54.8%** |
| `db_queries` | 11 | 9 | −2 |
| p50 / p95 / max | 20.4 / 20.8 / 20.8 ms | 15.2 / 18.0 / 18.0 ms | −26% / −13% / −13% |
| `db_parse_ms` | 1.5 ms | 0.8 ms | −47% |
| HTTP 响应体 | 1,067 B | 1,067 B | 不变 |
| **响应体逐字节** | — | — | **完全相同** |

两条语句的变化：观测语句 34,626 → 24,366 B（1,842 行里 399 行不再过桥）；`compilations()` 55,510 → 32,235 B；`getAutopilotRun` 整行读 114,751 B（2 次）→ 0；新增的窄发布探针 444 B（2 次）。

## 3. 209 规模模型（Explorer 行数）

| 仓库数 | before | after | 变化 | 判定 |
| --- | --- | --- | --- | --- |
| 26 | 1,877,923 B（1.79 MiB） | **658,858 B（0.63 MiB）** | −64.9% | < 1 MB ✓ |
| 46 | 2,136,712 B（2.04 MiB） | **759,199 B（0.72 MiB）** | −64.5% | < 1 MB ✓ |
| 92 | 2,731,926 B（2.61 MiB） | **989,981 B（0.94 MiB）** | −63.8% | < 1 MB ✓ |

| 仓库数 | before p50 / max / parse | after p50 / max / parse | before dbq | after dbq |
| --- | --- | --- | --- | --- |
| 26 | 173.9 / 190.1 / 9.1 ms | 146.9 / 153.3 / 4.2 ms | 162 | 136 |
| 46 | 272.6 / 297.4 / 12.2 ms | 239.8 / 251.3 / 5.8 ms | 282 | 236 |
| 92 | 567.5 / 597.5 / 20.4 ms | 479.4 / 487.2 / 10.4 ms | 558 | 466 |

### 3.1 after 的每语句构成（92 仓库场景）

| 语句 | bytes | 行数 | 调用 | B/行 |
| --- | ---: | ---: | ---: | ---: |
| `compilations()`（八列投影） | 278,522 | 1,443 | 1 | 193.0 |
| 观测语句（跳过 399 个无引用 schedule-only run） | 250,490 | 1,443 | 1 | 173.6 |
| `listWorkspaceRepositoryWikiDocs`（不含 `body`） | 205,030 | 276 | 1 | 742.9 |
| `SELECT * FROM multiremi_tasks WHERE id = ?` | 164,404 | 92 | 92 | 1,787.0 |
| `listLatestRepositoryAutopilotRuns`（SQL 内排序） | 44,365 | 92 | 1 | 482.2 |
| 窄发布探针 | 17,940 | 92 | 92 | 195.0 |
| 其余（workspace / task 查找 / 观测聚合等） | 29,230 | | | |
| **合计 `db_bytes`** | **989,981** | | | |

### 3.2 余量与敏感度

| 口径 | 余量 |
| --- | --- |
| 92 仓库场景 vs **1,000,000 B** | 10,019 B（**1.0%**） |
| 92 仓库场景 vs **1 MiB** | 58,595 B（5.9%） |
| 46 仓库场景 vs 1,000,000 B | 240,801 B（24.1%） |
| 26 仓库场景 vs 1,000,000 B | 341,142 B（34.1%） |

把每条「随行数增长」的语句按同一比例放大（每行常量整体漂移）：

| 放大 | 26 仓库 | 46 仓库 | 92 仓库 |
| --- | ---: | ---: | ---: |
| 0% | 658,858 B（0.63 MiB） | 759,199 B（0.72 MiB） | 989,981 B（0.94 MiB） |
| +5% | 696,225 B | 802,560 B | **1,038,019 B** |
| +10% | 723,900 B（0.69 MiB） | 833,645 B（0.80 MiB） | **1,086,056 B（1.04 MiB）** |

**结论：26 与 46 仓库场景余量充足；92 仓库场景在 1,000,000 B 口径下只剩 1.0% 余量，行常量各涨 5% 就会越线（对 1 MiB 口径则要到 +5.9% 才越线）。** 也就是说该场景刚过线，不是宽裕通过。

本单未再压这两条：

- 文档行已是纯元数据投影（不含 `body`），再压要动 `page_count` / `updated_at` / `status_message` / `source_revision` 的取数方式，超出 A2 裁决的「不读 `body`」这一条；
- `compilations()` 已从整行压到八列，剩下的都是 `taskOutcome` / 观测计数直接读的字段。

如果 209 复测后 92 仓库场景仍吃紧，可选后续（均未在本单实施）：把文档行的 `summary` / `tags` / `refs` / `content_uri` 等摘要不读的列也去掉；`SELECT * FROM multiremi_tasks WHERE id = ?`（每仓库 1.8 KB）改窄投影；把观测与 `compilations()` 改为按仓库聚合。

## 4. 逐字节证据

**HTTP**：把两次运行的 `responseContract.body` 按 key 排序后 `JSON.stringify`，SHA-256 前后相同：

| | before | after |
| --- | --- | --- |
| 字节数 | 1,067 | 1,067 |
| SHA-256 | `cf4f1f2621d3d94658c97d3b9749bc1bef800290604cc635fb6989853060f6bb` | 同左 |

40 个叶子值、20 个契约字段路径，`fieldPaths` 集合相同，差异叶子 0 个。为此 fixture 的文档行 `created_at` / `updated_at` 固定为常量（沿用 A 轮的做法），否则 `last_published_at` 每次不同，无法做字节比对。

**CLI**：真实 `remi` 子进程打本机 loopback 上的真实 API + 真实 PG，两套源码各跑一次，stdout/stderr 逐一 `cmp`：

| 命令 | stdout | stderr | sha256（前后一致） |
| --- | --- | --- | --- |
| `remi wiki repository list` | 68 B | 0 B | `5960a08c77a7d66caa31ced2318d4945b0e7b1122ac1132669408b53d44e41b9` |
| `remi wiki repository list --output json` | 1,482 B | 0 B | `ff0e13b1b7740046d5a52ab54cbc4bf7424dc5e238b0d5f08c1bc90bf0848060` |

四组 `cmp` 全部返回 0。

## 5. 变异

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| 发布判断换回 `getAutopilotRun` 整行读 | 红 | 1 fail：`decides publication from a narrow projection instead of the whole run row` |
| 把 `body` 加回文档投影 | 红 | 1 fail：`lists workspace docs without selecting the body column` |
| 去掉 `listLatestRepositoryAutopilotRuns` 的 SQL 排序 | 红 | 1 fail：`ranks runs in SQL so only the latest row per repository crosses the bridge` |

每次变异后都确认实现已还原（`git diff` 为空）。

## 6. 复现

```bash
# 需要一次性可建库的真实 PG
MULTIREMI_TEST_POSTGRES_URL=postgres://… MUL398_A2_STAGE=after \
  bun run tests/manual/bench-repository-wikis-a2-scale.ts \
  --out reports/performance/MUL-398-repository-wikis-a2-db-bytes.json

MULTIREMI_TEST_POSTGRES_URL=postgres://… \
  bun run tests/manual/bench-repository-wikis-db-bytes.ts --out /tmp/a2-route-after.json

MULTIREMI_TEST_POSTGRES_URL=postgres://… \
  bun run tests/manual/bench-repository-wikis-a2-cli.ts --label after --out /tmp/a2-cli
```

fixture 与脚本参数可用 `MUL398_*` / `MUL398_A2_*` 覆盖；`MUL398_A2_STAGE` 只写进报告的 `stage` 字段，不影响测量。
