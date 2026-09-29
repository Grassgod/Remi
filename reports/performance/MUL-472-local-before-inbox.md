# MUL-383 页面测速基线（schema 3）

- 生成时间：2026-09-27T21:00:15.979Z（北京时间 2026/9/28 05:00:15）
- 目标：http://localhost:3316（工作区 `local`）
- 被测用户：Local User　窗口：`offpeak`
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x64, 64 vCPU, 248 GiB RAM)
- 每场景轮数：2（最近秩分位数；n=5 时 p95 = max）
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
- 环境参照：`/api/config` 中位耗时 运行前 5.3 ms / 运行后 3.2 ms。
- 写护栏自检：通过（deliberate POST /api/inbox/unread-count was aborted by the guard）

## 每场景汇总

| 场景 | 模式 | 状态 | 目标 | 选择器 | anchor | n | ready p50 | p75 | p95 | max | 超时 | firstReal p50 | jumps max | 位移 max | 串行深度 | 首屏 API p50 |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| page-inbox | cold | measured | inbox | legacy | h1-no-skeleton | 2 | 2442.7 | 2545.8 | 2545.8 | 2545.8 | 0 | - | 0 | 0.0 | 13 | 19.0 |
| page-inbox | warm | measured | inbox | legacy | h1-no-skeleton | 2 | 1407.6 | 1416.6 | 1416.6 | 1416.6 | 0 | - | 0 | 0.0 | 1 | 1.0 |

## 每轮明细

| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| page-inbox | cold | 1 | 2442.7 | - | 2442.7 | none | - | - | 0 | 0.0 | 0 | 2336.0 | 1.4 | 7 | 22.71 MiB | 13 | 19/19 | 0 | 0 | - | - | - | - | - |
| page-inbox | cold | 2 | 2545.8 | - | 2545.8 | none | - | - | 0 | 0.0 | 0 | 2472.0 | 2.2 | 7 | 22.71 MiB | 11 | 19/19 | 0 | 0 | - | - | - | - | - |
| page-inbox | warm | 1 | 1407.6 | - | 22.8 | none | - | - | 0 | 0.0 | 0 | 2492.0 | 1.2 | 1 | 7.80 MiB | 1 | 1/1 | 0 | 0 | - | - | - | Inbox | - |
| page-inbox | warm | 2 | 1416.6 | - | 22.3 | none | - | - | 0 | 0.0 | 0 | 2416.0 | 1.4 | 1 | 7.80 MiB | 1 | 1/1 | 0 | 0 | - | - | - | Inbox | - |

## 首屏 API 表（按 path 聚合，跨本场景各轮）

口径：只统计 `startMs ≥ navStartMs` 且不晚于就绪帧的请求（warm 从 click 起算）；`total` 是服务端 `Server-Timing`，`gap` 是客户端 duration 减服务端 total（排队与连接）。分位数用最近秩法，`n` 是本场景各轮的请求总数，`轮` 是出现过该 path 的轮数。

### page-inbox（cold）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/cli/latest-version` | GET | 2 | 2 | 0.6 | 2.2 | 0.0 | 0 | 0 B | 8.9 |
| `/api/inbox/page` | GET | 2 | 2 | 1.4 | 1.6 | 0.0 | 0 | 0 B | 20.6 |
| `/api/agent-task-snapshot` | GET | 2 | 2 | 1.1 | 1.2 | 0.0 | 0 | 0 B | 9.2 |
| `/api/agents` | GET | 2 | 2 | 0.9 | 1.2 | 0.0 | 0 | 0 B | 10.6 |
| `/api/issues` | GET | 4 | 2 | 0.8 | 1.1 | 0.0 | 0 | 0 B | 8.5 |
| `/api/me` | GET | 2 | 2 | 0.7 | 1.0 | 0.0 | 0 | 0 B | 13.1 |
| `/api/projects` | GET | 2 | 2 | 0.7 | 0.9 | 0.0 | 0 | 0 B | 173.0 |
| `/api/chat/pending-tasks` | GET | 2 | 2 | 0.6 | 0.8 | 0.0 | 0 | 0 B | 7.7 |
| `/api/chat/sessions` | GET | 2 | 2 | 0.6 | 0.8 | 0.0 | 0 | 0 B | 11.0 |
| `/api/inbox/summary` | GET | 2 | 2 | 0.7 | 0.8 | 0.0 | 0 | 0 B | 9.3 |
| `/api/workspaces` | GET | 2 | 2 | 0.4 | 0.8 | 0.0 | 0 | 0 B | 12.9 |
| `/api/runtimes` | GET | 2 | 2 | 0.4 | 0.7 | 0.0 | 0 | 0 B | 9.6 |
| `/api/invitations` | GET | 2 | 2 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 10.5 |
| `/api/squads` | GET | 2 | 2 | 0.5 | 0.6 | 0.0 | 0 | 0 B | 8.6 |
| `/api/pins` | GET | 2 | 2 | 0.3 | 0.5 | 0.0 | 0 | 0 B | 8.5 |
| `/api/workspaces/:id/members` | GET | 2 | 2 | 0.4 | 0.5 | 0.0 | 0 | 0 B | 7.4 |
| `/api/runtime-workspaces` | GET | 2 | 2 | 0.4 | 0.4 | 0.0 | 0 | 0 B | 7.4 |
| `/api/config` | GET | 2 | 2 | 0.1 | 0.1 | 0.0 | 0 | 0 B | 14.6 |

### page-inbox（warm）

| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/inbox/page` | GET | 2 | 2 | 1.2 | 1.4 | 0.0 | 0 | 0 B | 20.0 |

## 逐轮时基与串行链

_逐请求明细（`path`/`wave`/`after`/`startMs`/`Server-Timing`/`gapMs`）在 JSON 的 `scenarios[].rounds[].apiFirstScreenEntries[]`，HTML 里按场景折叠显示。_

| 场景 | 模式 | 轮 | navStart ms | clickT ms | 入口就绪 ms | 点击时在途 API | 入口安静 | 串行链 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| page-inbox | cold | 1 | 0.0 | - | - | - | - | `/api/config → /api/agents → /api/agent-task-snapshot → /api/invitations → /api/cli/latest-version → /api/issues → /api/issues → /api/pins → /api/workspaces/:id/members → /api/chat/pending-tasks → /api/runtime-workspaces → /api/projects → /api/inbox/page` |
| page-inbox | cold | 2 | 0.0 | - | - | - | - | `/api/config → /api/agents → /api/agent-task-snapshot → /api/invitations → /api/issues → /api/pins → /api/workspaces/:id/members → /api/chat/pending-tasks → /api/runtime-workspaces → /api/projects → /api/inbox/page` |
| page-inbox | warm | 1 | 3616.4 | 3616.4 | 2790.0 | 0 | 是 | `/api/inbox/page` |
| page-inbox | warm | 2 | 3573.7 | 3573.7 | 2743.0 | 0 | 是 | `/api/inbox/page` |
