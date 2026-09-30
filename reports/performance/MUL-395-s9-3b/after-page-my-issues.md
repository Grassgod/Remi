# MUL-383 页面测速基线（schema 3）

- 生成时间：2026-09-28T13:54:04.266Z（北京时间 2026/9/28 21:54:04）
- 目标：http://localhost:18571（工作区 `local`）
- 被测用户：Local User　窗口：`offpeak`
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x64, 64 vCPU, 248 GiB RAM)
- 每场景轮数：5（最近秩分位数；n=5 时 p95 = max）
- 前端版本：未知
- API 版本：未知
- 选择器模式：`auto`

## 判定口径

- 终点：详情/深链：anchor（agent-stream 优先，否则最新一条评论；深链为 target-comment）可见 + 骨架 0 + 之后 500ms 无移动帧。列表：区域内无骨架且至少 1 个真实行可见 + 500ms 安静。chat：最新一条消息可见 + 500ms 安静；legacy 下 chat/列表退回 H1+无骨架。
- 跳动：首次出现真实内容后，相邻帧中同一 `data-perf-key` 的可见行位移 > 1px（或 scrollTop 位移 > 1px）即为移动帧，连续移动帧合并为一次跳动。`jumps = 0` 才合格。
- readyMs：anchor 完整可见、骨架为 0、之后 500ms 无移动帧；取该安静窗口的起点。单轮超时 20s，超时轮不进分位数。
- cold 用 `page.goto`；warm 先 hover 后真实 click，`navStartMs` 取页面内记录的 click 时间戳。**warm 的每一毫秒都从 click 起算**：帧、跳动、`Server-Timing` 与首屏集合都先减 `navStartMs`，首屏集合另有 `startMs ≥ navStartMs` 的下界，所以入口页的尾请求不计入目标页；cold 的 `navStartMs = 0`，数字与旧口径一致。
- 入口页安静（MUL-383 A1，2026-09-27 定案）：warm 轮在目标行出现后再等入口页 `500` ms 内没有新的 `/api/**` 请求开始，最多等 `5000` ms；超时照点并记 `entrySettled=false`。点击时的在途数记 `entryInflightAtClick`。
- 串行深度：`wave = 1 + max(wave(p) | p.responseEnd ≤ start + 8ms)`；`Server-Timing` 由 resource timing 同源读取。口径不变，另存 `serialChain` 与逐请求 `wave/after`。
- 环境参照：`/api/config` 中位耗时 运行前 2.7 ms / 运行后 2.9 ms。
- 写护栏自检：通过（deliberate POST /api/inbox/unread-count was aborted by the guard）

## 每场景汇总

| 场景 | 模式 | 状态 | 目标 | 选择器 | anchor | n | ready p50 | p75 | p95 | max | 超时 | firstReal p50 | jumps max | 位移 max | 串行深度 | 首屏 API p50 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| page-my-issues | cold | measured | my-issues | contract | h1-no-skeleton | 5 | 2636.8 | 2700.2 | 2767.3 | 2767.3 | 0 | - | 0 | 0.0 | 8 | 12.0 |
| page-my-issues | warm | measured | my-issues | contract | h1-no-skeleton | 5 | 1478.6 | 1497.7 | 1518.9 | 1518.9 | 0 | - | 0 | 0.0 | 1 | 1.0 |

## 每轮明细

| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| page-my-issues | cold | 1 | 2700.2 | - | 2700.2 | none | - | - | 0 | 0.0 | 0.002 | 2420.0 | 1.7 | 7 | 22.97 MiB | 7 | 12/12 | 0 | 0 | - | - | - | - | - |
| page-my-issues | cold | 2 | 2555.3 | - | 2555.3 | none | - | - | 0 | 0.0 | 0.002 | 2292.0 | 1.5 | 7 | 22.97 MiB | 6 | 12/12 | 0 | 0 | - | - | - | - | - |
| page-my-issues | cold | 3 | 2526.9 | - | 2526.9 | none | - | - | 0 | 0.0 | 0 | 2576.0 | 1.5 | 7 | 22.97 MiB | 7 | 12/12 | 0 | 0 | - | - | - | - | - |
| page-my-issues | cold | 4 | 2767.3 | - | 2767.3 | none | - | - | 0 | 0.0 | 0 | 2824.0 | 1.7 | 7 | 22.97 MiB | 8 | 12/12 | 0 | 0 | - | - | - | - | - |
| page-my-issues | cold | 5 | 2636.8 | - | 2636.8 | none | - | - | 0 | 0.0 | 0.002 | 2356.0 | 1.7 | 7 | 22.97 MiB | 8 | 12/12 | 0 | 0 | - | - | - | - | - |
| page-my-issues | warm | 1 | 1465.8 | - | 22.8 | none | - | - | 0 | 0.0 | 0 | 2812.0 | 1.7 | 1 | 7.83 MiB | 1 | 1/1 | 0 | 0 | - | - | - | My Issues | - |
| page-my-issues | warm | 2 | 1497.7 | - | 16.8 | none | - | - | 0 | 0.0 | 0 | 2796.0 | 1.8 | 1 | 7.83 MiB | 1 | 1/1 | 0 | 0 | - | - | - | My Issues | - |
| page-my-issues | warm | 3 | 1518.9 | - | 22.8 | none | - | - | 0 | 0.0 | 0 | 2760.0 | 1.7 | 1 | 7.83 MiB | 1 | 1/1 | 0 | 0 | - | - | - | My Issues | - |
| page-my-issues | warm | 4 | 1334.6 | - | 20.4 | none | - | - | 0 | 0.0 | 0 | 2660.0 | 1.7 | 1 | 7.83 MiB | 1 | 1/1 | 0 | 0 | - | - | - | My Issues | - |
| page-my-issues | warm | 5 | 1478.6 | - | 21.5 | none | - | - | 0 | 0.0 | 0 | 2760.0 | 1.8 | 1 | 7.83 MiB | 1 | 1/1 | 0 | 0 | - | - | - | My Issues | - |

## 首屏 API 表（按 path 聚合，跨本场景各轮）

口径：只统计 `startMs ≥ navStartMs` 且不晚于就绪帧的请求（warm 从 click 起算）；`total` 是服务端 `Server-Timing`，`gap` 是客户端 duration 减服务端 total（排队与连接）。分位数用最近秩法，`n` 是本场景各轮的请求总数，`轮` 是出现过该 path 的轮数。

### page-my-issues（cold）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues/status-pages` | GET | 5 | 5 | 1.7 | 1.7 | 0.0 | 0 | 0 B | 10.7 |
| `/api/runtimes` | GET | 5 | 5 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 12.2 |
| `/api/agents` | GET | 5 | 5 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 11.7 |
| `/api/chat/pending-tasks` | GET | 5 | 5 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 10.8 |
| `/api/chat/sessions` | GET | 5 | 5 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 9.7 |
| `/api/assignee-frequency` | GET | 5 | 5 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 60.2 |
| `/api/projects` | GET | 5 | 5 | 0.3 | 0.4 | 0.0 | 0 | 0 B | 218.2 |
| `/api/workspaces/:id/members` | GET | 5 | 5 | 0.2 | 0.3 | 0.0 | 0 | 0 B | 10.5 |
| `/api/me` | GET | 5 | 5 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 12.5 |
| `/api/runtime-workspaces` | GET | 5 | 5 | 0.1 | 0.2 | 0.0 | 0 | 0 B | 9.1 |
| `/api/config` | GET | 5 | 5 | 0.1 | 0.1 | 0.0 | 0 | 0 B | 12.7 |
| `/api/workspaces` | GET | 5 | 5 | 0.1 | 0.1 | 0.0 | 0 | 0 B | 11.9 |

### page-my-issues（warm）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues/status-pages` | GET | 5 | 5 | 1.7 | 1.8 | 0.0 | 0 | 0 B | 12.9 |

## 逐轮时基与串行链

_逐请求明细（`path`/`wave`/`after`/`startMs`/`Server-Timing`/`gapMs`）在 JSON 的 `scenarios[].rounds[].apiFirstScreenEntries[]`，HTML 里按场景折叠显示。_

| 场景 | 模式 | 轮 | navStart ms | clickT ms | 入口就绪 ms | 点击时在途 API | 入口安静 | 串行链 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| page-my-issues | cold | 1 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/chat/pending-tasks → /api/runtime-workspaces → /api/projects → /api/issues/status-pages → /api/assignee-frequency` |
| page-my-issues | cold | 2 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/chat/pending-tasks → /api/projects → /api/issues/status-pages → /api/assignee-frequency` |
| page-my-issues | cold | 3 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/chat/pending-tasks → /api/projects → /api/agents → /api/issues/status-pages → /api/assignee-frequency` |
| page-my-issues | cold | 4 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/workspaces/:id/members → /api/runtime-workspaces → /api/projects → /api/agents → /api/issues/status-pages → /api/assignee-frequency` |
| page-my-issues | cold | 5 | 0.0 | - | - | - | - | `/api/config → /api/workspaces → /api/runtimes → /api/workspaces/:id/members → /api/runtime-workspaces → /api/projects → /api/issues/status-pages → /api/assignee-frequency` |
| page-my-issues | warm | 1 | 4049.8 | 4049.8 | 2841.0 | 0 | 是 | `/api/issues/status-pages` |
| page-my-issues | warm | 2 | 4058.5 | 4058.5 | 2818.0 | 0 | 是 | `/api/issues/status-pages` |
| page-my-issues | warm | 3 | 4000.0 | 4000.0 | 2322.0 | 0 | 是 | `/api/issues/status-pages` |
| page-my-issues | warm | 4 | 3917.8 | 3917.8 | 2681.0 | 0 | 是 | `/api/issues/status-pages` |
| page-my-issues | warm | 5 | 4001.0 | 4001.0 | 2778.0 | 0 | 是 | `/api/issues/status-pages` |
