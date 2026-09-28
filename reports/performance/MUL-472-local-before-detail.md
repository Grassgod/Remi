# MUL-383 页面测速基线（schema 3）

- 生成时间：2026-09-27T21:19:59.133Z（北京时间 2026/9/28 05:19:59）
- 目标：http://localhost:3380（工作区 `local`）
- 被测用户：Local User　窗口：`offpeak`
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x64, 64 vCPU, 248 GiB RAM)
- 每场景轮数：3（最近秩分位数；n=5 时 p95 = max）
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
- 环境参照：`/api/config` 中位耗时 运行前 4.4 ms / 运行后 3.5 ms。
- 写护栏自检：通过（deliberate POST /api/inbox/unread-count was aborted by the guard）

## 每场景汇总

| 场景 | 模式 | 状态 | 目标 | 选择器 | anchor | n | ready p50 | p75 | p95 | max | 超时 | firstReal p50 | jumps max | 位移 max | 串行深度 | 首屏 API p50 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| detail-short | cold | measured | MUL-1（4 条评论） | contract | agent-stream|latest-comment | 3 | 3325.6 | 3517.8 | 3517.8 | 3517.8 | 0 | 3325.6 | 0 | 0.0 | 22 | 36.0 |
| detail-short | warm | measured | MUL-1（4 条评论） | contract | agent-stream|latest-comment | 3 | 2341.9 | 2352.4 | 2352.4 | 2352.4 | 0 | 2341.9 | 0 | 0.0 | 11 | 16.0 |

## 每轮明细

| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| detail-short | cold | 1 | 3197.5 | 3197.5 | 3197.5 | latest-comment | 527/603.8/76.8/836 | - | 0 | 0.0 | 0 | 2232.0 | 1.4 | 7 | 22.57 MiB | 17 | 36/36 | 0 | 0 | - | - | - | - | - |
| detail-short | cold | 2 | 3325.6 | 3325.6 | 3325.6 | latest-comment | 527/603.8/76.8/836 | - | 0 | 0.0 | 0 | 2360.0 | 1.3 | 7 | 22.57 MiB | 20 | 36/36 | 0 | 0 | - | - | - | - | - |
| detail-short | cold | 3 | 3517.8 | 3517.8 | 3517.8 | latest-comment | 527/603.8/76.8/836 | - | 0 | 0.0 | 0 | 2628.0 | 2.0 | 7 | 22.57 MiB | 22 | 36/36 | 0 | 0 | - | - | - | - | - |
| detail-short | warm | 1 | 2352.4 | 2352.4 | 2352.4 | latest-comment | 527/603.8/76.8/836 | - | 0 | 0.0 | 0 | 2508.0 | 1.1 | 1 | 7.66 MiB | 10 | 16/16 | 0 | 0 | - | - | - | MUL-1  Local short issue  A short issue for the local probe. | - |
| detail-short | warm | 2 | 2166.7 | 2166.7 | 2166.7 | latest-comment | 527/603.8/76.8/836 | - | 0 | 0.0 | 0 | 2468.0 | 1.0 | 1 | 7.66 MiB | 11 | 16/16 | 0 | 0 | - | - | - | MUL-1  Local short issue  A short issue for the local probe. | - |
| detail-short | warm | 3 | 2341.9 | 2341.9 | 2341.9 | latest-comment | 527/603.8/76.8/836 | - | 0 | 0.0 | 0 | 2500.0 | 1.0 | 1 | 7.66 MiB | 11 | 16/16 | 0 | 0 | - | - | - | MUL-1  Local short issue  A short issue for the local probe. | - |

## 首屏 API 表（按 path 聚合，跨本场景各轮）

口径：只统计 `startMs ≥ navStartMs` 且不晚于就绪帧的请求（warm 从 click 起算）；`total` 是服务端 `Server-Timing`，`gap` 是客户端 duration 减服务端 total（排队与连接）。分位数用最近秩法，`n` 是本场景各轮的请求总数，`轮` 是出现过该 path 的轮数。

### detail-short（cold）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues` | GET | 6 | 3 | 0.8 | 2.0 | 0.0 | 0 | 0 B | 10.7 |
| `/api/issues/:id/usage` | GET | 3 | 3 | 0.9 | 1.4 | 0.0 | 0 | 0 B | 11.0 |
| `/api/squads` | GET | 3 | 3 | 0.6 | 1.4 | 0.0 | 0 | 0 B | 10.0 |
| `/api/agent-task-snapshot` | GET | 3 | 3 | 1.2 | 1.3 | 0.0 | 0 | 0 B | 10.9 |
| `/api/inbox/summary` | GET | 3 | 3 | 0.6 | 1.3 | 0.0 | 0 | 0 B | 11.9 |
| `/api/issues/:id/timeline` | GET | 6 | 3 | 1.0 | 1.3 | 0.0 | 0 | 0 B | 10.9 |
| `/api/me` | GET | 3 | 3 | 0.9 | 1.3 | 0.0 | 0 | 0 B | 11.2 |
| `/api/agents` | GET | 3 | 3 | 1.0 | 1.1 | 0.0 | 0 | 0 B | 10.2 |
| `/api/issues/:id/attachments` | GET | 3 | 3 | 0.7 | 1.1 | 0.0 | 0 | 0 B | 12.7 |
| `/api/issues/:id/active-task` | GET | 6 | 3 | 0.8 | 1.0 | 0.0 | 0 | 0 B | 18.3 |
| `/api/issues/:id/session-archives` | GET | 3 | 3 | 0.6 | 1.0 | 0.0 | 0 | 0 B | 9.5 |
| `/api/assignee-frequency` | GET | 3 | 3 | 0.6 | 0.9 | 0.0 | 0 | 0 B | 7.4 |
| `/api/invitations` | GET | 3 | 3 | 0.5 | 0.9 | 0.0 | 0 | 0 B | 10.8 |
| `/api/issues/:id` | GET | 6 | 3 | 0.6 | 0.9 | 0.0 | 0 | 0 B | 10.2 |
| `/api/issues/:id/change-requests` | GET | 3 | 3 | 0.8 | 0.9 | 0.0 | 0 | 0 B | 9.5 |
| `/api/issues/:id/labels` | GET | 3 | 3 | 0.9 | 0.9 | 0.0 | 0 | 0 B | 200.5 |
| `/api/issues/:id/session-results` | GET | 3 | 3 | 0.6 | 0.9 | 0.0 | 0 | 0 B | 10.0 |
| `/api/issues/:id/task-runs` | GET | 3 | 3 | 0.6 | 0.9 | 0.0 | 0 | 0 B | 9.1 |
| `/api/issues/:id/workspace` | GET | 3 | 3 | 0.8 | 0.9 | 0.0 | 0 | 0 B | 17.9 |
| `/api/chat/sessions` | GET | 3 | 3 | 0.7 | 0.8 | 0.0 | 0 | 0 B | 9.7 |
| `/api/issues/:id/children` | GET | 3 | 3 | 0.6 | 0.8 | 0.0 | 0 | 0 B | 13.6 |
| `/api/issues/:id/subscribers` | GET | 3 | 3 | 0.6 | 0.8 | 0.0 | 0 | 0 B | 11.6 |
| `/api/chat/pending-tasks` | GET | 3 | 3 | 0.6 | 0.7 | 0.0 | 0 | 0 B | 9.1 |
| `/api/issues/:id/sessions` | GET | 3 | 3 | 0.7 | 0.7 | 0.0 | 0 | 0 B | 10.1 |
| `/api/projects` | GET | 3 | 3 | 0.7 | 0.7 | 0.0 | 0 | 0 B | 206.5 |
| `/api/workspaces` | GET | 3 | 3 | 0.4 | 0.7 | 0.0 | 0 | 0 B | 12.0 |
| `/api/runtime-workspaces` | GET | 3 | 3 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 7.4 |
| `/api/runtimes` | GET | 3 | 3 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 10.6 |
| `/api/cli/latest-version` | GET | 3 | 3 | 0.3 | 0.5 | 0.0 | 0 | 0 B | 12.8 |
| `/api/pins` | GET | 3 | 3 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 10.8 |
| `/api/workspaces/:id/members` | GET | 3 | 3 | 0.5 | 0.5 | 0.0 | 0 | 0 B | 9.7 |
| `/api/config` | GET | 3 | 3 | 0.1 | 0.1 | 0.0 | 0 | 0 B | 12.4 |

### detail-short（warm）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/issues/:id/usage` | GET | 3 | 3 | 1.0 | 1.1 | 0.0 | 0 | 0 B | 8.4 |
| `/api/issues/:id` | GET | 3 | 3 | 0.8 | 1.0 | 0.0 | 0 | 0 B | 11.7 |
| `/api/issues/:id/active-task` | GET | 6 | 3 | 0.8 | 1.0 | 0.0 | 0 | 0 B | 17.8 |
| `/api/issues/:id/timeline` | GET | 6 | 3 | 0.9 | 1.0 | 0.0 | 0 | 0 B | 10.7 |
| `/api/issues/:id/change-requests` | GET | 3 | 3 | 0.8 | 0.9 | 0.0 | 0 | 0 B | 9.8 |
| `/api/issues/:id/children` | GET | 3 | 3 | 0.9 | 0.9 | 0.0 | 0 | 0 B | 11.0 |
| `/api/issues/:id/attachments` | GET | 3 | 3 | 0.7 | 0.8 | 0.0 | 0 | 0 B | 11.3 |
| `/api/issues/:id/labels` | GET | 3 | 3 | 0.7 | 0.8 | 0.0 | 0 | 0 B | 158.6 |
| `/api/issues/:id/session-archives` | GET | 3 | 3 | 0.6 | 0.8 | 0.0 | 0 | 0 B | 9.4 |
| `/api/issues/:id/session-results` | GET | 3 | 3 | 0.8 | 0.8 | 0.0 | 0 | 0 B | 10.4 |
| `/api/issues/:id/workspace` | GET | 3 | 3 | 0.7 | 0.8 | 0.0 | 0 | 0 B | 14.0 |
| `/api/issues/:id/sessions` | GET | 3 | 3 | 0.6 | 0.7 | 0.0 | 0 | 0 B | 10.4 |
| `/api/issues/:id/subscribers` | GET | 3 | 3 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 11.6 |
| `/api/issues/:id/task-runs` | GET | 3 | 3 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 8.9 |

## 逐轮时基与串行链

_逐请求明细（`path`/`wave`/`after`/`startMs`/`Server-Timing`/`gapMs`）在 JSON 的 `scenarios[].rounds[].apiFirstScreenEntries[]`，HTML 里按场景折叠显示。_

| 场景 | 模式 | 轮 | navStart ms | clickT ms | 入口就绪 ms | 点击时在途 API | 入口安静 | 串行链 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| detail-short | cold | 1 | 0.0 | - | - | - | - | `/api/config → /api/agents → /api/squads → /api/inbox/summary → /api/issues → /api/chat/pending-tasks → /api/chat/sessions → /api/issues/:id → /api/issues/:id/children → /api/issues/:id/session-results → /api/assignee-frequency → /api/issues/:id/change-requests → /api/issues/:id/session-archives → /api/issues/:id/timeline → /api/issues/:id/usage → /api/issues/:id/active-task → /api/issues/:id/active-task` |
| detail-short | cold | 2 | 0.0 | - | - | - | - | `/api/config → /api/agents → /api/agent-task-snapshot → /api/squads → /api/invitations → /api/issues → /api/workspaces/:id/members → /api/issues/:id → /api/chat/pending-tasks → /api/runtime-workspaces → /api/projects → /api/issues/:id → /api/issues/:id/workspace → /api/assignee-frequency → /api/issues/:id/change-requests → /api/issues/:id/session-archives → /api/issues/:id/usage → /api/issues/:id/labels → /api/issues/:id/active-task → /api/issues/:id/active-task` |
| detail-short | cold | 3 | 0.0 | - | - | - | - | `/api/config → /api/agents → /api/agent-task-snapshot → /api/invitations → /api/inbox/summary → /api/cli/latest-version → /api/issues → /api/pins → /api/workspaces/:id/members → /api/issues/:id → /api/chat/pending-tasks → /api/runtime-workspaces → /api/projects → /api/issues/:id → /api/issues/:id/children → /api/assignee-frequency → /api/issues/:id/task-runs → /api/issues/:id/session-archives → /api/issues/:id/sessions → /api/issues/:id/labels → /api/issues/:id/active-task → /api/issues/:id/timeline` |
| detail-short | warm | 1 | 3669.2 | 3669.2 | 2830.0 | 0 | 是 | `/api/issues/:id → /api/issues/:id/subscribers → /api/issues/:id/workspace → /api/issues/:id/change-requests → /api/issues/:id/session-archives → /api/issues/:id/timeline → /api/issues/:id/usage → /api/issues/:id/labels → /api/issues/:id/active-task → /api/issues/:id/active-task` |
| detail-short | warm | 2 | 3627.8 | 3627.8 | 2807.0 | 0 | 是 | `/api/issues/:id → /api/issues/:id/children → /api/issues/:id/session-results → /api/issues/:id/change-requests → /api/issues/:id/session-archives → /api/issues/:id/timeline → /api/issues/:id/sessions → /api/issues/:id/usage → /api/issues/:id/labels → /api/issues/:id/active-task → /api/issues/:id/active-task` |
| detail-short | warm | 3 | 3660.9 | 3660.9 | 2832.0 | 0 | 是 | `/api/issues/:id → /api/issues/:id/children → /api/issues/:id/session-results → /api/issues/:id/change-requests → /api/issues/:id/task-runs → /api/issues/:id/session-archives → /api/issues/:id/timeline → /api/issues/:id/usage → /api/issues/:id/labels → /api/issues/:id/active-task → /api/issues/:id/active-task` |
