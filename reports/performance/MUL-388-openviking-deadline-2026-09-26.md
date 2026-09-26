# MUL-388 OpenViking 请求级总 deadline：PUT 项目文档挂起前后对比

- 生成时间：2026-09-26
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x86_64, 64 vCPU, 247 GiB RAM)，Bun 1.3.14
- 被测接口：`PUT /api/projects/:id/docs/:ref`，进程内 `app.request` 调用，不经过 nginx
- 依赖：本机回环地址上的 fake OpenViking HTTP 服务，由 [scripts/bench-openviking-deadline.ts](../../scripts/bench-openviking-deadline.ts) 启动；未连接任何真实 OpenViking，未访问生产 209
- before：`origin/main` @ `a1e61623`，由 `git archive` 导出；after：`agent/MUL-388` @ `a61e7481`
- 复现：`bun scripts/bench-openviking-deadline.ts <label> <none|write|commit|all> [timeoutMs] [maxRetries]`，在干净环境（`env -i`）中运行
- 原始数据：[MUL-388-openviking-deadline-2026-09-26.json](MUL-388-openviking-deadline-2026-09-26.json)

## 判定口径

- 耗时：从发出 PUT 到收到响应，用 `performance.now()` 计时。
- 挂起：fake 对指定调用一直不响应，连接保持打开，模拟 OpenViking 卡死。
  - `write`：batch-write（create 或 replace）挂起。
  - `commit`：所有 snapshot commit 挂起，包括回滚时的 commit。此时新正文已经落盘，请求走最长路径。
  - `all`：所有调用都挂起。
- 回读：解除挂起后 GET 同一篇文档，确认正文仍可读，并确认读到的是哪个版本。

## 结果

| 场景 | 代码 | env TIMEOUT_MS / MAX_RETRIES | 挂起 | 状态 | 耗时 | batch-write 次数 | 回读 |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| 健康 | before | 180000 / 5 | 无 | 200 | 13 ms | – | 200 v2 |
| 健康 | after | 180000 / 5 | 无 | 200 | 13 ms | – | 200 v2 |
| 生产 env，写挂起 | before | 180000 / 5 | write | 503 | 1083.1 s | 6 | 200 v1 |
| 缩比 env，写挂起 | before | 1000 / 5 | write | 503 | 9.13 s | 6 | 200 v1 |
| 生产 env，写挂起 | after | 180000 / 5 | write | 504 `DEADLINE_EXCEEDED` | 20.0 s | 1 | 200 v1 |
| 生产 env，全部挂起 | after | 180000 / 5 | all | 504 `DEADLINE_EXCEEDED` | 20.0 s | 0（卡在首个 read） | 200 v1 |
| 生产 env，commit 挂起（最坏） | after | 180000 / 5 | commit | 504 `DEADLINE_EXCEEDED` | 25.0 s | 2（写入 + 回滚） | 200 v1 |
| 默认 env，写挂起 | after | 未设（15000 / 2） | write | 504 `TIMEOUT` | 15.0 s | 1 | 200 v1 |

## 解读

- **before 的耗时**：符合 (MAX_RETRIES + 1) × TIMEOUT + 退避总和，退避总和为 100 + 200 + 400 + 800 + 1600 = 3100 ms。
  - 缩比 env：6 × 1000 + 3100 = 9100 ms，实测 9128 ms。
  - 生产 env：6 × 180000 + 3100 = 1,083,100 ms，实测 1,083,124 ms，与生产观测到的 1084 s 一致。
  - 两种 env 下，结果未知的写入都被重发了 6 次。
- **after 在 env=180000/5 下不再放大**：主路径在 20 s 截止，即 25 s 预算减去 5 s 补偿预留。单次尝试的超时被截到剩余时间，写入只发一次。
- **最坏路径**：新正文落盘后 commit 挂起，请求用满 25 s。前 20 s 属于主路径；后 5 s 用于回滚，把正文换回 v1，所以挂起解除后文档仍然可读（回读为 v1）。
  - 如果不留这 5 s，回滚会随 deadline 一起被中止，正文与 SQL 哈希不一致，之后每次读取都返回 503。
  - 单测 `rolls back a half-applied write in the budget's reserved tail` 把预留设为 0 时就会失败。
- **30 s 内有明确结果**：after 的所有场景都在 nginx 30 s 断开前返回 504，并各输出一行 `openviking_request_timeout` 日志。
- **默认 env（15000/2）**：写挂起时，单次尝试超时后写入不重发，15 s 返回 `TIMEOUT`。生产 env 收窄到 15000/2 是单独的授权项，本单不改生产。
- **健康路径无回归**：before 与 after 都是 13 ms。

## 未覆盖

- 没有经过 nginx 实测；30 s 断开取自配置值。
- fake OpenViking 只模拟挂起，没有模拟“慢但最终成功”的响应，也没有模拟半开连接等网络故障。
- 没有在生产 209 复测，因为生产只读。
