# MUL-401 DB 阻塞基线（之前）

- 采样日：2026-09-28，北京时间。任务于当晚发出；三个指定时间窗均已结束。采集日：2026-09-29。
- 对象：209 生产 API 容器 `multiremi-platform-app-api-1`。只读取容器元数据和 stdout 日志，未连接数据库、未执行 SQL、未修改配置或服务。实际运行版本为 **0.2.83**，镜像 revision `922b332c9583d8d255d03a9e5d5fcc69dd69b6cd`；容器从 2026-09-27T00:03:42Z 开始运行，覆盖采样日。取数命令见 [V]。
- 口径：`api_minute_summary.db_busy_pct` 是包含后台工作的进程级 DB 阻塞占比；`db_queries` 是同一进程的一分钟查询数。对每个指定时间窗内日志行的这两个字段分别取最近秩 p95（排序后第 `ceil(0.95*n)` 个）。窗口按汇总行的 UTC `ts` 归属，不按请求开始时间归属。它们不是逐路由数，也不能与 WS 帧归因相加。取数命令见 [M]。

## 三个窗口

| 北京时间窗口 | 汇总分钟样本 | 进程级 `db_busy_pct` p95 | 进程级 `db_queries` p95（次/分钟） | `requests` p95（次/分钟） | `dropped` 合计 | 命令 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 08:00–10:00 | 119 | 93.58% | 36,402 | 1,703 | 0 | [M] |
| 13:00–14:00 | 60 | 92.68% | 30,029 | 1,335 | 0 | [M] |
| 20:00–21:00 | 59 | 95.09% | 29,344 | 1,361 | 0 | [M] |

08–10 和 20–21 的汇总行数分别少于理想的 120/60 个整分钟样本；定时器窗口可能跨边界，不能据此判定日志丢失。上表仅对实际取得的 119/59 行取 p95，未补点或估算。[M] 输出首末时间可复核覆盖范围。`dropped=0` 只表示指标环形缓冲没有丢请求样本，不证明一分钟汇总日志完整。

## 旧轮询路由

`api_minute_summary.routes` 只保存 `count / p50_ms / p95_ms / sum_ms`，**没有**逐路由 `db_ms` 和 `db_queries`。`api_slow_request` 有这两个字段，但默认只记录总耗时超过 500 ms 的请求。因此下面把全请求路由 DB p95 如实记为「未取到」，把慢请求子集的 p95 单列为有偏参考值；后者不能当作全请求 p95，也不能与进程级一分钟 `db_queries` 相加。[K] 可核对实际日志字段，[R] 和 [S] 是取数命令。

| 北京时间 | 旧路由 | `api_minute_summary` 已报告请求数 | 全请求 `db_ms` / `db_queries` p95 | 慢请求样本数 | 慢请求 `db_ms` p95 | 慢请求 `db_queries` p95 | 命令 |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| 08–10 | `POST /api/daemon/heartbeat` | 14,048 | 未取到 / 未取到 | 2,710 | 65.6 ms | 45 | [R][S] |
| 08–10 | `POST /api/daemon/runtimes/:runtimeId/tasks/claim` | 7,769 | 未取到 / 未取到 | 1,391 | 91.9 ms | 51 | [R][S] |
| 13–14 | `POST /api/daemon/heartbeat` | 7,149 | 未取到 / 未取到 | 1,317 | 113.9 ms | 45 | [R][S] |
| 13–14 | `POST /api/daemon/runtimes/:runtimeId/tasks/claim` | 3,990 | 未取到 / 未取到 | 718 | 127.0 ms | 52 | [R][S] |
| 20–21 | `POST /api/daemon/heartbeat` | 5,440 | 未取到 / 未取到 | 4,151 | 93.4 ms | 45 | [R][S] |
| 20–21 | `POST /api/daemon/runtimes/:runtimeId/tasks/claim` | 2,735 | 未取到 / 未取到 | 2,126 | 108.8 ms | 44 | [R][S] |
| 008 单机（以上各窗） | heartbeat / claim | 未取到 | 未取到 / 未取到 | 未取到 | 未取到 | 未取到 | [K][H] |

008 已单列，但这些日志没有 daemon、runtime 或来源主机维度；`/api/daemon/runtimes/:runtimeId/tasks/claim` 是归一化路由模式，不含具体 runtime ID。即使 008 发出的请求包含路径 ID，汇总和慢请求日志也不保留它，不能把全 fleet 的行分摊给 008。[H] 只验证采集机身份，不能提供 008 的 DB 归因。路由请求数是汇总中已报告的次数：heartbeat 和 claim 在取得的每条汇总行里均出现，但缺失的汇总分钟仍不可补算。[R]

## 之后：待同口径复测

| 变化 | 预期与待测项 |
| --- | --- |
| PR #315，已合入父单 `b8608f71` | QA 严验 `cmt_npxmxanw53hi` 第 1 项原文：“独立 SQL 探针确认达标 v2 的 helper 只有 1 次 SELECT、0 次写入，执行计划命中 runtime 主键和 daemon profile 复合索引；请求缓存可省去这次读取。WS hb 路径 `api/daemon-protocol/index.ts:391` 未改，也不调用该 helper，没有新增周期写库。”这是已完成的实测，本报告不重测；v2 且版本足够的 runtime 在心跳路径上不新增写库，最多多一次走索引的 SELECT。 |
| 裁定 ⑧ | 60 s 兜底扫描：每台在线 runtime 每分钟一次 `claimTask`。上线后核对实际在线 runtime 数、扫描次数和这部分 DB 开销；这是服务端扫描，不是 HTTP claim 轮询。来源：MUL-401 `cmt_z5sa1xvxvn1m`。 |
| 裁定 ⑱，MUL-419 PR #314 进行中 | 心跳复验将增加 retire 和凭证检查。每次心跳 SELECT 条数 **待 #314 定值**；上线后用相同一分钟窗口复测。来源：MUL-401 `cmt_y7twj9xlbcjx`。 |
| v2 HTTP 轮询归零 | 旧 `heartbeat` / `claim` HTTP 轮询请求及其查询量应消失。上表是上线前路由出现频度及慢请求 DB 开销参考；全请求逐路由 DB p95 **未取到**，不能宣称其改善幅度。上线后仍以 `api_minute_summary.db_busy_pct` 评估进程级变化，WS 的 `ws_minute_summary` 仅作帧归因，不与进程总量相加。 |

## 可复现的只读命令

[V]、[M]、[R]、[S]、[K] 在 209 的 shell 中只读运行；若从外部连接，使用 `ssh -i <SSH_KEY_PATH> hehuajie@n37-117-209.byted.org`。`<SSH_KEY_PATH>` 仅为占位符，不在报告中记录凭证。[H] 在 008 本机运行。以下生产命令只读容器元数据和日志，不执行测试或写库。

**[V] 当前运行镜像、版本与 revision**

```bash
docker inspect --format '{{.Config.Image}} {{.Image}} {{.State.StartedAt}}' multiremi-platform-app-api-1
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}' ghcr.io/grassgod/remi-api@sha256:39aa8a8c9d3577cd1027bb35a92b06265047e96ddd6aa23bf342453d39e8152f
```

**[M] 三窗进程级一分钟 p95、样本和 dropped**

```bash
docker logs --since '2026-09-28T00:00:00+08:00' --until '2026-09-29T00:00:00+08:00' multiremi-platform-app-api-1 2>/dev/null |
  rg 'api_minute_summary' |
  jq -s '
    def ceil: if . == floor then . else floor + 1 end;
    def p95: sort | .[((length * 0.95 | ceil) - 1)];
    def win($name;$start;$stop):
      [.[] | select(.ts >= $start and .ts < $stop)] as $rows |
      {window:$name, minute_samples:($rows|length),
       first:($rows|first|.ts), last:($rows|last|.ts),
       db_busy_pct_p95:($rows|map(.db_busy_pct)|p95),
       db_queries_p95:($rows|map(.db_queries)|p95),
       requests_p95:($rows|map(.requests)|p95),
       dropped_total:($rows|map(.dropped)|add)};
    win("low_08_10";"2026-09-28T00:00:00Z";"2026-09-28T02:00:00Z"),
    win("peak_13_14";"2026-09-28T05:00:00Z";"2026-09-28T06:00:00Z"),
    win("evening_20_21";"2026-09-28T12:00:00Z";"2026-09-28T13:00:00Z")'
```

**[R] 两条旧轮询路由在已取得汇总中的请求数**

```bash
docker logs --since '2026-09-28T00:00:00+08:00' --until '2026-09-29T00:00:00+08:00' multiremi-platform-app-api-1 2>/dev/null |
  rg 'api_minute_summary' |
  jq -s '
    def route($rows;$name):
      [$rows[] | .routes[] | select(.route == $name)] as $found |
      {route:$name, minutes_present:($found|length), requests:($found|map(.count)|add)};
    def win($name;$start;$stop):
      [.[] | select(.ts >= $start and .ts < $stop)] as $rows |
      {window:$name, routes:[
        route($rows;"/api/daemon/heartbeat"),
        route($rows;"/api/daemon/runtimes/:runtimeId/tasks/claim")]};
    win("low_08_10";"2026-09-28T00:00:00Z";"2026-09-28T02:00:00Z"),
    win("peak_13_14";"2026-09-28T05:00:00Z";"2026-09-28T06:00:00Z"),
    win("evening_20_21";"2026-09-28T12:00:00Z";"2026-09-28T13:00:00Z")'
```

**[S] 慢请求子集的逐路由 p95**（依次使用下列三个 `START` / `STOP` 组合，每组分别得到 heartbeat 和 claim 两行；只适用于 `api_slow_request`，不是全请求 p95）

```bash
# 每次先将 START / STOP 设成下列一组，再运行管道：
# 2026-09-28T08:00:00+08:00 / 2026-09-28T10:00:00+08:00
# 2026-09-28T13:00:00+08:00 / 2026-09-28T14:00:00+08:00
# 2026-09-28T20:00:00+08:00 / 2026-09-28T21:00:00+08:00
docker logs --since "$START" --until "$STOP" multiremi-platform-app-api-1 2>/dev/null |
  rg 'api_slow_request' |
  jq -s '
    def ceil: if . == floor then . else floor + 1 end;
    def p95: sort | .[((length * 0.95 | ceil) - 1)];
    def stat($route): [.[] | select(.route == $route)] as $rows |
      {route:$route, samples:($rows|length),
       db_ms_p95:($rows|map(.db_ms)|p95),
       db_queries_p95:($rows|map(.db_queries)|p95)};
    stat("/api/daemon/heartbeat"),
    stat("/api/daemon/runtimes/:runtimeId/tasks/claim")'
```

**[K] 实际日志字段与 008 归因限制**

```bash
docker logs --since '2026-09-28T13:00:00+08:00' --until '2026-09-28T13:02:00+08:00' multiremi-platform-app-api-1 2>/dev/null |
  rg 'api_minute_summary' | head -n 1 |
  jq -c '{summary_keys:keys, route_keys:(.routes[0]|keys)}'
docker logs --since '2026-09-28T13:00:00+08:00' --until '2026-09-28T13:02:00+08:00' multiremi-platform-app-api-1 2>/dev/null |
  rg 'api_slow_request' | head -n 1 | jq -c 'keys'
```

**[H] 008 采集机身份**

```bash
hostname
```

本次 [H] 输出 `n37-066-008`。`api_minute_summary` 没有逐 runtime 或逐主机 DB 字段；没有从主机身份推算任何 DB 数值。若后续需要 008 的全请求 DB p95，须新增带 runtime 维度且不泄露凭证的独立观测，再按相同时间窗采集。
