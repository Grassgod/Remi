# MUL-383 页面测速基线（schema 3）

- 生成时间：2026-09-28T13:55:35.590Z（北京时间 2026/9/28 21:55:35）
- 目标：http://localhost:18571（工作区 `local`）
- 被测用户：Local User　窗口：`offpeak`
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x64, 64 vCPU, 248 GiB RAM)
- 每场景轮数：1（最近秩分位数；n=5 时 p95 = max）
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
- 环境参照：`/api/config` 中位耗时 运行前 2.6 ms / 运行后 2.8 ms。
- 写护栏自检：通过（deliberate POST /api/inbox/unread-count was aborted by the guard）

## 每场景汇总

| 场景 | 模式 | 状态 | 目标 | 选择器 | anchor | n | ready p50 | p75 | p95 | max | 超时 | firstReal p50 | jumps max | 位移 max | 串行深度 | 首屏 API p50 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| detail-xlong | cold | measured | MUL-5（超长，210 条评论） | contract | agent-stream|latest-comment | 1 | 4023.0 | 4023.0 | 4023.0 | 4023.0 | 0 | 4023.0 | 0 | 0.0 | 21 | 30.0 |
| detail-xlong | warm | measured | MUL-5（超长，210 条评论） | contract | agent-stream|latest-comment | 1 | 2614.2 | 2614.2 | 2614.2 | 2614.2 | 0 | 2614.2 | 0 | 0.0 | 11 | 18.0 |

## 每轮明细

| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| detail-xlong | cold | 1 | 4023.0 | 4023.0 | 4023.0 | latest-comment | 435.8/677/241.2/796 | 3938.1 | 0 | 0.0 | 0 | 4052.0 | 1.3 | 7 | 22.95 MiB | 21 | 30/37 | 0 | 0 | - | - | - | - | - |
| detail-xlong | warm | 1 | 2614.2 | 2614.2 | 2614.2 | latest-comment | 435.8/677/241.2/796 | 2148.4 | 0 | 0.0 | 0 | 2788.0 | 1.1 | 1 | 7.81 MiB | 11 | 18/18 | 0 | 0 | - | - | - | MUL-5  MUL-454 local 210-comment fixture  Fixed synthetic QA | - |

## 首屏 API 表（按 path 聚合，跨本场景各轮）

口径：只统计 `startMs ≥ navStartMs` 且不晚于就绪帧的请求（warm 从 click 起算）；`total` 是服务端 `Server-Timing`，`gap` 是客户端 duration 减服务端 total（排队与连接）。分位数用最近秩法，`n` 是本场景各轮的请求总数，`轮` 是出现过该 path 的轮数。

### detail-xlong（cold）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues/:id/timeline` | GET | 2 | 1 | 1.0 | 1.3 | 0.0 | 0 | 0 B | 9.3 |
| `/api/issues/:id/change-requests` | GET | 1 | 1 | 0.6 | 0.6 | 0.0 | 0 | 0 B | 6.6 |
| `/api/issues/:id/usage` | GET | 1 | 1 | 0.6 | 0.6 | 0.0 | 0 | 0 B | 8.8 |
| `/api/chat/pending-tasks` | GET | 1 | 1 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 9.1 |
| `/api/chat/sessions` | GET | 1 | 1 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 8.8 |
| `/api/issues/:id` | GET | 2 | 1 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 8.9 |
| `/api/agents` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 10.1 |
| `/api/assignee-frequency` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 7.1 |
| `/api/issues/:id/active-task` | GET | 2 | 1 | 0.3 | 0.4 | 0.0 | 0 | 0 B | 10.7 |
| `/api/issues/:id/decisions` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 9.2 |
| `/api/issues/:id/labels` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 40.4 |
| `/api/issues/:id/session-archives` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 13.3 |
| `/api/issues/:id/task-runs` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 16.2 |
| `/api/projects` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 224.8 |
| `/api/runtimes` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 12.8 |
| `/api/issues/:id/attachments` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 8.9 |
| `/api/issues/:id/children` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 10.0 |
| `/api/issues/:id/dependencies` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 9.5 |
| `/api/issues/:id/session-results` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 9.9 |
| `/api/issues/:id/sessions` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 10.9 |
| `/api/issues/:id/subscribers` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 12.9 |
| `/api/issues/:id/workspace` | GET | 1 | 1 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 8.2 |
| `/api/me` | GET | 1 | 1 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 10.9 |
| `/api/workspaces` | GET | 1 | 1 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 12.2 |
| `/api/workspaces/:id/members` | GET | 1 | 1 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 9.4 |
| `/api/config` | GET | 1 | 1 | 0.1 | 0.1 | 0.0 | 0 | 0 B | 11.1 |
| `/api/runtime-workspaces` | GET | 1 | 1 | 0.1 | 0.1 | 0.0 | 0 | 0 B | 7.6 |

### detail-xlong（warm）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues/:id/timeline` | GET | 1 | 1 | 1.1 | 1.1 | 0.0 | 0 | 0 B | 14.5 |
| `/api/issues/:id` | GET | 2 | 1 | 0.3 | 0.5 | 0.0 | 0 | 0 B | 10.5 |
| `/api/issues/:id/active-task` | GET | 2 | 1 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 10.4 |
| `/api/issues/:id/task-runs` | GET | 1 | 1 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 15.2 |
| `/api/issues/:id/usage` | GET | 1 | 1 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 12.0 |
| `/api/issues/:id/change-requests` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 6.9 |
| `/api/issues/:id/labels` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 64.5 |
| `/api/issues/:id/session-archives` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 12.0 |
| `/api/issues/:id/sessions` | GET | 1 | 1 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 15.7 |
| `/api/issues/:id/attachments` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 11.3 |
| `/api/issues/:id/children` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 39.6 |
| `/api/issues/:id/decisions` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 8.1 |
| `/api/issues/:id/subscribers` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 10.5 |
| `/api/issues/:id/workspace` | GET | 1 | 1 | 0.3 | 0.3 | 0.0 | 0 | 0 B | 9.3 |
| `/api/issues/:id/dependencies` | GET | 1 | 1 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 8.4 |
| `/api/issues/:id/session-results` | GET | 1 | 1 | 0.2 | 0.2 | 0.0 | 0 | 0 B | 9.9 |

## 逐轮时基与串行链

_逐请求明细（`path`/`wave`/`after`/`startMs`/`Server-Timing`/`gapMs`）在 JSON 的 `scenarios[].rounds[].apiFirstScreenEntries[]`，HTML 里按场景折叠显示。_

| 场景 | 模式 | 轮 | navStart ms | clickT ms | 入口就绪 ms | 点击时在途 API | 入口安静 | 串行链 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| detail-xlong | cold | 1 | 0.0 | - | - | - | - | `/api/config → /api/runtimes → /api/issues/:id → /api/chat/pending-tasks → /api/runtime-workspaces → /api/projects → /api/chat/sessions → /api/issues/:id/timeline → /api/issues/:id/usage → /api/issues/:id/labels → /api/issues/:id → /api/issues/:id/subscribers → /api/issues/:id/workspace → /api/issues/:id/task-runs → /api/issues/:id/timeline → /api/issues/:id/dependencies → /api/issues/:id/decisions → /api/assignee-frequency → /api/issues/:id/change-requests → /api/issues/:id/session-archives → /api/issues/:id/active-task` |
| detail-xlong | warm | 1 | 4013.8 | 4013.8 | 2856.0 | 0 | 是 | `/api/issues/:id/timeline → /api/issues/:id/labels → /api/issues/:id/children → /api/issues/:id → /api/issues/:id/subscribers → /api/issues/:id/session-results → /api/issues/:id/task-runs → /api/issues/:id/decisions → /api/issues/:id/change-requests → /api/issues/:id/session-archives → /api/issues/:id/active-task` |
