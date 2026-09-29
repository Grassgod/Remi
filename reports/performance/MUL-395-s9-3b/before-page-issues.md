# MUL-383 页面测速基线（schema 3）

- 生成时间：2026-09-28T13:47:04.969Z（北京时间 2026/9/28 21:47:04）
- 目标：http://localhost:18570（工作区 `local`）
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
- 环境参照：`/api/config` 中位耗时 运行前 2.9 ms / 运行后 3.4 ms。
- 写护栏自检：通过（deliberate POST /api/inbox/unread-count was aborted by the guard）

## 每场景汇总

| 场景 | 模式 | 状态 | 目标 | 选择器 | anchor | n | ready p50 | p75 | p95 | max | 超时 | firstReal p50 | jumps max | 位移 max | 串行深度 | 首屏 API p50 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| page-issues | cold | measured | issues | contract | h1-no-skeleton | 5 | 2831.4 | 2957.9 | 9253.7 | 9253.7 | 0 | - | 0 | 0.0 | 10 | 18.0 |
| page-issues | warm | measured | issues | contract | h1-no-skeleton | 5 | 1716.5 | 1761.0 | 1842.1 | 1842.1 | 0 | - | 0 | 0.0 | 4 | 8.0 |

## 每轮明细

| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| page-issues | cold | 1 | 9253.7 | - | 9253.7 | none | - | - | 0 | 0.0 | 0 | 9300.0 | 1.9 | 7 | 24.50 MiB | 5 | 18/18 | 0 | 0 | - | - | - | - | - |
| page-issues | cold | 2 | 2800.9 | - | 2800.9 | none | - | - | 0 | 0.0 | 0 | 2836.0 | 0.6 | 7 | 24.50 MiB | 9 | 18/18 | 0 | 0 | - | - | - | - | - |
| page-issues | cold | 3 | 2957.9 | - | 2957.9 | none | - | - | 0 | 0.0 | 0 | 2996.0 | 0.6 | 7 | 24.50 MiB | 8 | 18/18 | 0 | 0 | - | - | - | - | - |
| page-issues | cold | 4 | 2831.4 | - | 2831.4 | none | - | - | 0 | 0.0 | 0 | 2880.0 | 0.7 | 7 | 24.50 MiB | 9 | 18/18 | 0 | 0 | - | - | - | - | - |
| page-issues | cold | 5 | 2813.9 | - | 2813.9 | none | - | - | 0 | 0.0 | 0 | 2848.0 | 0.7 | 7 | 24.50 MiB | 10 | 18/18 | 0 | 0 | - | - | - | - | - |
| page-issues | warm | 1 | 1842.1 | - | 19.4 | none | - | - | 0 | 0.0 | 0 | 5380.0 | 0.8 | 1 | 8.53 MiB | 3 | 8/9 | 0 | 0 | - | - | - | Issues | - |
| page-issues | warm | 2 | 1716.5 | - | 20.3 | none | - | - | 0 | 0.0 | 0 | 2772.0 | 0.6 | 1 | 8.53 MiB | 3 | 8/9 | 0 | 0 | - | - | - | Issues | - |
| page-issues | warm | 3 | 1706.8 | - | 22.1 | none | - | - | 0 | 0.0 | 0 | 2664.0 | 0.6 | 1 | 8.53 MiB | 3 | 8/9 | 0 | 0 | - | - | - | Issues | - |
| page-issues | warm | 4 | 1697.6 | - | 19.4 | none | - | - | 0 | 0.0 | 0 | 2640.0 | 0.6 | 1 | 8.53 MiB | 3 | 8/9 | 0 | 0 | - | - | - | Issues | - |
| page-issues | warm | 5 | 1761.0 | - | 22.1 | none | - | - | 0 | 0.0 | 0 | 2712.0 | 0.6 | 1 | 8.53 MiB | 4 | 8/9 | 0 | 0 | - | - | - | Issues | - |

## 首屏 API 表（按 path 聚合，跨本场景各轮）

口径：只统计 `startMs ≥ navStartMs` 且不晚于就绪帧的请求（warm 从 click 起算）；`total` 是服务端 `Server-Timing`，`gap` 是客户端 duration 减服务端 total（排队与连接）。分位数用最近秩法，`n` 是本场景各轮的请求总数，`轮` 是出现过该 path 的轮数。

### page-issues（cold）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/runtimes` | GET | 5 | 5 | 0.6 | 1.3 | 0.0 | 0 | 0 B | 13.1 |
| `/api/chat/pending-tasks` | GET | 5 | 5 | 0.6 | 1.2 | 0.0 | 0 | 0 B | 11.7 |
| `/api/assignee-frequency` | GET | 5 | 5 | 0.5 | 1.1 | 0.0 | 0 | 0 B | 59.3 |
| `/api/agents` | GET | 5 | 5 | 0.5 | 1.0 | 0.0 | 0 | 0 B | 11.5 |
| `/api/chat/sessions` | GET | 5 | 5 | 0.5 | 0.9 | 0.0 | 0 | 0 B | 9.8 |
| `/api/issues` | GET | 35 | 5 | 0.5 | 0.7 | 0.0 | 0 | 0 B | 12.9 |
| `/api/projects` | GET | 5 | 5 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 186.9 |
| `/api/runtime-workspaces` | GET | 5 | 5 | 0.2 | 0.5 | 0.0 | 0 | 0 B | 9.8 |
| `/api/workspaces/:id/members` | GET | 5 | 5 | 0.3 | 0.5 | 0.0 | 0 | 0 B | 13.7 |
| `/api/me` | GET | 5 | 5 | 0.2 | 0.3 | 0.0 | 0 | 0 B | 13.3 |
| `/api/config` | GET | 5 | 5 | 0.1 | 0.2 | 0.0 | 0 | 0 B | 13.7 |
| `/api/workspaces` | GET | 5 | 5 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 12.7 |

### page-issues（warm）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues` | GET | 35 | 5 | 0.5 | 0.7 | 0.0 | 0 | 0 B | 13.9 |
| `/api/assignee-frequency` | GET | 5 | 5 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 49.8 |

## 逐轮时基与串行链

_逐请求明细（`path`/`wave`/`after`/`startMs`/`Server-Timing`/`gapMs`）在 JSON 的 `scenarios[].rounds[].apiFirstScreenEntries[]`，HTML 里按场景折叠显示。_

| 场景 | 模式 | 轮 | navStart ms | clickT ms | 入口就绪 ms | 点击时在途 API | 入口安静 | 串行链 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| page-issues | cold | 1 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | cold | 2 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/chat/pending-tasks → /api/projects → /api/chat/sessions → /api/issues → /api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | cold | 3 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/projects → /api/chat/sessions → /api/issues → /api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | cold | 4 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/chat/pending-tasks → /api/projects → /api/chat/sessions → /api/issues → /api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | cold | 5 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/workspaces/:id/members → /api/chat/pending-tasks → /api/projects → /api/chat/sessions → /api/issues → /api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | warm | 1 | 6614.4 | 6614.4 | 5274.0 | 1 | 是 | `/api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | warm | 2 | 3898.8 | 3898.8 | 2964.0 | 0 | 是 | `/api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | warm | 3 | 3788.2 | 3788.2 | 2852.0 | 0 | 是 | `/api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | warm | 4 | 3767.9 | 3767.9 | 2831.0 | 0 | 是 | `/api/issues → /api/issues → /api/assignee-frequency` |
| page-issues | warm | 5 | 3834.2 | 3834.2 | 2906.0 | 0 | 是 | `/api/issues → /api/issues → /api/issues → /api/assignee-frequency` |
