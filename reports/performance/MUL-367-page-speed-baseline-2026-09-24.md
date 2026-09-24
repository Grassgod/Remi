# MUL-367 页面测速基线

- 生成时间：2026-09-24T11:29:33.929Z
- 目标：http://n37-117-209.byted.org（工作区 `remi`）
- 被测用户：贺华杰
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x64, 64 vCPU, 248 GiB RAM)
- 运行模式：headless Chromium (no desktop session) via frontend/scripts/perf/page-speed.ts
- 每页轮数：3
- API 版本：0.2.80
- 前端版本：未知（未暴露版本接口）

## 判定口径

- 就绪时间：从 `page.goto` 导航开始计时，到 主内容区域（[data-slot="sidebar-inset"]）出现 H1 标题，且区域内没有 data-slot="skeleton" 骨架占位。
- LCP / DOMContentLoaded 来自浏览器 Performance 条目，仅作参考。
- API 字节：encodedBodySize=压缩后传输体积，decodedBodySize=解压后 JSON 体积，transferSize=含响应头的传输体积。
- 每轮使用一个全新的 browser context：第一页（issues）包含 app shell 冷启动成本，同轮后续页面复用该 shell。
- 环境参照：`/api/config` 中位耗时 运行前 2231.4 ms / 运行后 3170.9 ms（原始样本前 [1294,2364.3,2.6,1857.4,2652.3,2231.4,2720.7]，后 [3030.7,3578.4,3798.4,3170.9,2903.3,2.6,4150.4]）。生产是共享环境，复跑对比前先核对这个参照。

## 每页中位数

| 页面 | 就绪 ms | LCP ms | DOMContentLoaded ms | API 数 | API 传输字节 | 最慢 API ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| issues | 16576.0 | 3136.0 | 59.0 | 21 | 136.8 KiB | 8479.1 |
| my-issues | 11288.0 | 3980.0 | 66.3 | 20 | 88.6 KiB | 7722.6 |
| chat | 4875.0 | 4820.0 | 63.0 | 3 | 5.2 KiB | 3840.8 |
| inbox | 10380.0 | 4788.0 | 57.3 | 15 | 110.2 KiB | 6274.2 |
| agents | 4707.0 | 3972.0 | 61.2 | 9 | 29.7 KiB | 2727.0 |
| runtimes | 4881.0 | 3396.0 | 62.3 | 9 | 29.7 KiB | 2083.6 |
| projects | 9414.0 | 3840.0 | 60.0 | 15 | 88.9 KiB | 6565.8 |
| workbench | 9690.0 | 4084.0 | 59.4 | 15 | 96.0 KiB | 7123.1 |
| settings | 4953.0 | 5256.0 | 59.0 | 3 | 5.2 KiB | 3841.6 |
| autopilots | 10259.0 | 5436.0 | 59.2 | 14 | 96.9 KiB | 5136.9 |
| skills | 10407.0 | 10428.0 | 65.5 | 14 | 90.5 KiB | 6553.4 |

## 每轮明细

| 轮 | 页面 | 就绪 ms | API 数 | 传输字节 | 解码字节 | 最慢 API | 耗时 ms | Server-Timing |
| ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| 1 | issues | 16576.0 | 20 | 136.3 KiB | 436.1 KiB | GET `/api/issues` | 9998.0 | （本次发布无此头） |
| 2 | issues | 10164.0 | 21 | 136.8 KiB | 436.9 KiB | GET `/api/issues/child-progress` | 4832.9 | （本次发布无此头） |
| 3 | issues | 16648.0 | 26 | 144.8 KiB | 461.3 KiB | GET `/api/chat/sessions` | 8479.1 | （本次发布无此头） |
| 1 | my-issues | 18786.0 | 20 | 88.6 KiB | 305.6 KiB | GET `/api/issues/child-progress` | 13524.2 | （本次发布无此头） |
| 2 | my-issues | 9209.0 | 25 | 97.0 KiB | 332.2 KiB | GET `/api/chat/sessions` | 7265.2 | （本次发布无此头） |
| 3 | my-issues | 11288.0 | 20 | 88.3 KiB | 303.7 KiB | GET `/api/issues/child-progress` | 7722.6 | （本次发布无此头） |
| 1 | chat | 3242.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 2153.3 | （本次发布无此头） |
| 2 | chat | 4875.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/me` | 3840.8 | （本次发布无此头） |
| 3 | chat | 11338.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 10289.8 | （本次发布无此头） |
| 1 | inbox | 7736.0 | 15 | 110.4 KiB | 450.3 KiB | GET `/api/workspaces` | 3400.8 | （本次发布无此头） |
| 2 | inbox | 10380.0 | 15 | 110.2 KiB | 450.4 KiB | GET `/api/workspaces/:id/members` | 6274.2 | （本次发布无此头） |
| 3 | inbox | 20178.0 | 15 | 109.9 KiB | 448.5 KiB | GET `/api/workspaces/:id/members` | 12687.0 | （本次发布无此头） |
| 1 | agents | 3082.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/me` | 1291.1 | （本次发布无此头） |
| 2 | agents | 4707.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/workspaces` | 2727.0 | （本次发布无此头） |
| 3 | agents | 13354.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/workspaces` | 6386.3 | （本次发布无此头） |
| 1 | runtimes | 4881.0 | 9 | 70.3 KiB | 245.9 KiB | GET `/api/workspaces` | 2083.6 | （本次发布无此头） |
| 2 | runtimes | 4839.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/inbox/summary` | 2040.6 | （本次发布无此头） |
| 3 | runtimes | 10221.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/inbox/summary` | 4796.1 | （本次发布无此头） |
| 1 | projects | 7096.0 | 15 | 88.9 KiB | 309.7 KiB | GET `/api/workspaces/:id/members` | 4098.3 | （本次发布无此头） |
| 2 | projects | 9414.0 | 15 | 88.9 KiB | 309.8 KiB | GET `/api/workspaces/:id/members` | 6677.6 | （本次发布无此头） |
| 3 | projects | 11500.0 | 14 | 88.6 KiB | 307.8 KiB | GET `/api/projects` | 6565.8 | （本次发布无此头） |
| 1 | workbench | 8788.0 | 15 | 96.0 KiB | 322.9 KiB | GET `/api/workspaces/:id/members` | 5095.7 | （本次发布无此头） |
| 2 | workbench | 9690.0 | 15 | 96.1 KiB | 323.0 KiB | GET `/api/workspaces/:id/members` | 7144.0 | （本次发布无此头） |
| 3 | workbench | 11541.0 | 14 | 95.6 KiB | 321.0 KiB | GET `/api/issues` | 7123.1 | （本次发布无此头） |
| 1 | settings | 4650.0 | 13 | 87.7 KiB | 304.7 KiB | GET `/api/workspaces` | 3518.5 | （本次发布无此头） |
| 2 | settings | 5293.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 4153.5 | （本次发布无此头） |
| 3 | settings | 4953.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 3841.6 | （本次发布无此头） |
| 1 | autopilots | 8013.0 | 14 | 96.7 KiB | 325.6 KiB | GET `/api/autopilots` | 5036.3 | （本次发布无此头） |
| 2 | autopilots | 10259.0 | 14 | 97.1 KiB | 328.5 KiB | GET `/api/autopilots` | 5136.9 | （本次发布无此头） |
| 3 | autopilots | 17146.0 | 14 | 96.9 KiB | 323.8 KiB | GET `/api/autopilots` | 9764.1 | （本次发布无此头） |
| 1 | skills | 7199.0 | 14 | 90.3 KiB | 310.4 KiB | GET `/api/skills` | 4116.3 | （本次发布无此头） |
| 2 | skills | 10407.0 | 14 | 90.9 KiB | 314.3 KiB | GET `/api/cli/latest-version` | 6553.4 | （本次发布无此头） |
| 3 | skills | 14084.0 | 14 | 90.5 KiB | 308.6 KiB | GET `/api/skills` | 9083.1 | （本次发布无此头） |

## 每页 API Top 5（按 path 模式汇总，首轮）

### issues

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 9 | 9998.0 | 77144.7 | 65.8 KiB | - |
| GET | `/api/pins` | 1 | 6656.3 | 6656.3 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 6638.9 | 6638.9 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 4949.5 | 4949.5 | 40.8 KiB | - |
| GET | `/api/inbox/summary` | 1 | 3391.1 | 3391.1 | 30 B | - |

### my-issues

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 8 | 13520.4 | 95456.6 | 17.6 KiB | - |
| GET | `/api/issues/child-progress` | 1 | 13524.2 | 13524.2 | 753 B | - |
| GET | `/api/pins` | 1 | 9512.2 | 9512.2 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 9504.3 | 9504.3 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 9289.7 | 9289.7 | 40.5 KiB | - |

### chat

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/workspaces` | 1 | 2153.3 | 2153.3 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 2148.0 | 2148.0 | 766 B | - |
| GET | `/api/config` | 1 | 569.1 | 569.1 | 182 B | - |

### inbox

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 2847.8 | 5692.3 | 17.4 KiB | - |
| GET | `/api/workspaces` | 1 | 3400.8 | 3400.8 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 3395.5 | 3395.5 | 766 B | - |
| GET | `/api/workspaces/:id/members` | 1 | 3261.6 | 3261.6 | 159 B | - |
| GET | `/api/inbox/page` | 1 | 3256.3 | 3256.3 | 22.2 KiB | - |

### agents

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/me` | 1 | 1291.1 | 1291.1 | 766 B | - |
| GET | `/api/workspaces` | 1 | 1288.7 | 1288.7 | 4.3 KiB | - |
| GET | `/api/inbox/summary` | 1 | 1181.0 | 1181.0 | 30 B | - |
| GET | `/api/invitations` | 1 | 1086.6 | 1086.6 | 2 B | - |
| GET | `/api/squads` | 1 | 1086.4 | 1086.4 | 3.0 KiB | - |

### runtimes

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/workspaces` | 1 | 2083.6 | 2083.6 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 2078.0 | 2078.0 | 766 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 1910.0 | 1910.0 | 40.6 KiB | - |
| GET | `/api/inbox/summary` | 1 | 1873.9 | 1873.9 | 30 B | - |
| GET | `/api/invitations` | 1 | 1789.2 | 1789.2 | 2 B | - |

### projects

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 3948.5 | 7893.1 | 17.4 KiB | - |
| GET | `/api/workspaces/:id/members` | 1 | 4098.3 | 4098.3 | 159 B | - |
| GET | `/api/projects` | 1 | 3957.2 | 3957.2 | 1.0 KiB | - |
| GET | `/api/pins` | 1 | 3952.2 | 3952.2 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 3581.5 | 3581.5 | 21 B | - |

### workbench

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 3 | 4965.3 | 14873.8 | 25.6 KiB | - |
| GET | `/api/workspaces/:id/members` | 1 | 5095.7 | 5095.7 | 159 B | - |
| GET | `/api/pins` | 1 | 4959.7 | 4959.7 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 4945.6 | 4945.6 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 3497.1 | 3497.1 | 40.5 KiB | - |

### settings

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 2769.0 | 5534.7 | 17.4 KiB | - |
| GET | `/api/workspaces` | 1 | 3518.5 | 3518.5 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 3514.4 | 3514.4 | 766 B | - |
| GET | `/api/cli/latest-version` | 1 | 2757.1 | 2757.1 | 21 B | - |
| GET | `/api/inbox/summary` | 1 | 2755.3 | 2755.3 | 30 B | - |

### autopilots

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 5028.6 | 10054.5 | 17.4 KiB | - |
| GET | `/api/autopilots` | 1 | 5036.3 | 5036.3 | 9.0 KiB | - |
| GET | `/api/pins` | 1 | 5032.4 | 5032.4 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 5016.2 | 5016.2 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 4439.8 | 4439.8 | 40.5 KiB | - |

### skills

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 4108.4 | 8195.1 | 17.4 KiB | - |
| GET | `/api/skills` | 1 | 4116.3 | 4116.3 | 2.6 KiB | - |
| GET | `/api/pins` | 1 | 4113.8 | 4113.8 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 4078.8 | 4078.8 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 3486.6 | 3486.6 | 40.5 KiB | - |

## 被拦截的写请求

无。页面加载过程中没有任何非 GET/HEAD 的 `/api/**` 请求。

## inbox 专项

| 接口 | Status | 解码字节 | 条目数 | 备注 |
| --- | ---: | ---: | ---: | --- |
| `/api/inbox` | 200 | 14.85 MiB | 4410 | {} |
| `/api/inbox/summary` | 200 | 30 B | - | {"unread":170,"attention":199} |
| `/api/inbox/unread-count` | 200 | 14 B | - | {"count":3039} |
| `/api/inbox/page?limit=50` | 200 | 145.5 KiB | 50 | {"hasMore":true,"hasNextCursor":true} |

只读护栏自检：对 `/api/inbox/unread-count` 发 POST —— **已被拦截**。POST 被 page.route 拦截并 abort，护栏生效

inbox 页面打开时尝试了 1 个写请求，全部被 abort：

- `POST /api/inbox/:id/read`（inbox-guard-click，尝试 930 次，全部 abort）
