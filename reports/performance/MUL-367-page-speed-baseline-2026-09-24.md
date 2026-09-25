# MUL-367 页面测速基线

- 生成时间：2026-09-24T11:57:42.896Z
- 目标：http://n37-117-209.byted.org（工作区 `remi`）
- 被测用户：贺华杰
- 运行机器：n37-066-008 (linux 5.15.120.bsk.3-amd64 x64, 64 vCPU, 248 GiB RAM)
- 运行模式：headless Chromium (no desktop session) via frontend/scripts/perf/page-speed.ts
- 每页轮数：3
- 前端版本：`dev`（部署包上报的 `X-Client-Version`；镜像 sha256:3b2c7d1ec2c1）
- API 版本：0.2.80（ref 2bcd2e1d31f8；镜像 sha256:d54adf1ff485）

## 判定口径

- 就绪时间：从 `page.goto` 导航开始计时，到 主内容区域（[data-slot="sidebar-inset"]）出现 H1 标题，且区域内没有 data-slot="skeleton" 骨架占位。
- LCP / DOMContentLoaded 来自浏览器 Performance 条目，仅作参考。
- API 字节：encodedBodySize=压缩后传输体积，decodedBodySize=解压后 JSON 体积，transferSize=含响应头的传输体积。
- 每轮使用一个全新的 browser context：第一页（issues）包含 app shell 冷启动成本，同轮后续页面复用该 shell。
- 环境参照：`/api/config` 中位耗时 运行前 1886.1 ms / 运行后 3735.1 ms（原始样本前 [1195.1,1388.2,1700,2294.5,2367,2739.5,1886.1]，后 [4376,3735.1,4303.3,4211.4,1982,2857.3,2680.3]）。生产是共享环境，复跑对比前先核对这个参照。

## 每页中位数

| 页面 | 就绪 ms | LCP ms | DOMContentLoaded ms | API 数 | API 传输字节 | 最慢 API ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| issues | 20187.0 ⚠1 | 5284.0 | 63.5 | 21 | 137.6 KiB | 13519.7 |
| my-issues | 11519.0 | 4764.0 | 53.0 | 20 | 89.3 KiB | 7090.3 |
| chat | 4258.0 | 4276.0 | 61.2 | 3 | 5.2 KiB | 3243.5 |
| inbox | 10258.0 | 3880.0 | 56.9 | 15 | 108.3 KiB | 7469.7 |
| agents | 14674.0 | 5976.0 | 56.9 | 9 | 29.7 KiB | 9497.9 |
| runtimes | 8336.0 | 5940.0 | 57.6 | 9 | 29.7 KiB | 4580.2 |
| projects | 9502.0 | 3772.0 | 63.4 | 14 | 87.5 KiB | 6509.0 |
| workbench | 10872.0 | 5080.0 | 62.7 | 14 | 94.9 KiB | 6896.8 |
| settings | 4685.0 | 5000.0 | 58.8 | 3 | 5.2 KiB | 3535.2 |
| autopilots | 13097.0 | 6288.0 | 58.5 | 14 | 96.0 KiB | 7478.2 |
| skills | 12785.0 | 12820.0 | 65.4 | 14 | 89.0 KiB | 7442.5 |

> ⚠ 有 1 次页面加载在 60 s 就绪等待内没有满足口径（上表标 ⚠N）。这些轮次不进中位数，只保留在明细里；中位数由剩余轮次计算。

## 每轮明细

| 轮 | 页面 | 就绪 ms | API 数 | 传输字节 | 解码字节 | 最慢 API | 耗时 ms | Server-Timing |
| ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| 1 | issues | 15751.0 | 21 | 137.6 KiB | 443.2 KiB | GET `/api/issues/child-progress` | 11617.2 | （本次发布无此头） |
| 2 | issues | - (超时) | 15 | 88.4 KiB | 311.5 KiB | GET `/api/issues` | 28745.9 | （本次发布无此头） |
| 3 | issues | 24623.0 | 26 | 143.9 KiB | 468.1 KiB | GET `/api/chat/sessions` | 13519.7 | （本次发布无此头） |
| 1 | my-issues | 9592.0 | 20 | 89.4 KiB | 312.0 KiB | GET `/api/issues/child-progress` | 6605.1 | （本次发布无此头） |
| 2 | my-issues | 19580.0 | 20 | 89.3 KiB | 310.0 KiB | GET `/api/issues/child-progress` | 10459.3 | （本次发布无此头） |
| 3 | my-issues | 11519.0 | 20 | 87.1 KiB | 310.2 KiB | GET `/api/issues/child-progress` | 7090.3 | （本次发布无此头） |
| 1 | chat | 3519.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 2489.8 | （本次发布无此头） |
| 2 | chat | 4456.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 3426.1 | （本次发布无此头） |
| 3 | chat | 4258.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 3243.5 | （本次发布无此头） |
| 1 | inbox | 8052.0 | 15 | 110.4 KiB | 453.9 KiB | GET `/api/workspaces/:id/members` | 4845.4 | （本次发布无此头） |
| 2 | inbox | 25190.0 | 15 | 108.3 KiB | 452.0 KiB | GET `/api/workspaces/:id/members` | 19952.3 | （本次发布无此头） |
| 3 | inbox | 10258.0 | 15 | 108.2 KiB | 452.2 KiB | GET `/api/workspaces/:id/members` | 7469.7 | （本次发布无此头） |
| 1 | agents | 6656.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/inbox/summary` | 2970.4 | （本次发布无此头） |
| 2 | agents | 14674.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/workspaces` | 10230.4 | （本次发布无此头） |
| 3 | agents | 14806.0 | 9 | 69.3 KiB | 250.5 KiB | GET `/api/agent-task-snapshot` | 9497.9 | （本次发布无此头） |
| 1 | runtimes | 8336.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/workspaces` | 4580.2 | （本次发布无此头） |
| 2 | runtimes | 17104.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/workspaces` | 9157.0 | （本次发布无此头） |
| 3 | runtimes | 6963.0 | 9 | 29.7 KiB | 92.6 KiB | GET `/api/workspaces` | 3291.7 | （本次发布无此头） |
| 1 | projects | 9502.0 | 15 | 89.5 KiB | 316.1 KiB | GET `/api/workspaces/:id/members` | 6509.0 | （本次发布无此头） |
| 2 | projects | 20580.0 | 14 | 87.4 KiB | 314.2 KiB | GET `/api/projects` | 15490.9 | （本次发布无此头） |
| 3 | projects | 8344.0 | 14 | 87.5 KiB | 314.3 KiB | GET `/api/projects` | 5033.4 | （本次发布无此头） |
| 1 | workbench | 10872.0 | 14 | 96.6 KiB | 329.1 KiB | GET `/api/issues` | 6896.8 | （本次发布无此头） |
| 2 | workbench | 16529.0 | 15 | 94.9 KiB | 327.5 KiB | GET `/api/workspaces/:id/members` | 12075.8 | （本次发布无此头） |
| 3 | workbench | 9356.0 | 14 | 94.6 KiB | 327.5 KiB | GET `/api/issues` | 4573.4 | （本次发布无此头） |
| 1 | settings | 4801.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 3667.6 | （本次发布无此头） |
| 2 | settings | 4685.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 3535.2 | （本次发布无此头） |
| 3 | settings | 3704.0 | 3 | 5.2 KiB | 13.1 KiB | GET `/api/workspaces` | 2631.9 | （本次发布无此头） |
| 1 | autopilots | 13097.0 | 14 | 97.8 KiB | 332.0 KiB | GET `/api/workspaces` | 7267.1 | （本次发布无此头） |
| 2 | autopilots | 11771.0 | 14 | 95.3 KiB | 330.2 KiB | GET `/api/autopilots` | 7478.2 | （本次发布无此头） |
| 3 | autopilots | 16403.0 | 15 | 96.0 KiB | 330.5 KiB | GET `/api/workspaces/:id/members` | 10584.3 | （本次发布无此头） |
| 1 | skills | 14805.0 | 14 | 89.6 KiB | 317.0 KiB | GET `/api/skills` | 10603.1 | （本次发布无此头） |
| 2 | skills | 11359.0 | 14 | 88.9 KiB | 315.0 KiB | GET `/api/skills` | 6440.5 | （本次发布无此头） |
| 3 | skills | 12785.0 | 14 | 89.0 KiB | 315.2 KiB | GET `/api/skills` | 7442.5 | （本次发布无此头） |

## 每页 API Top 5（按 path 模式汇总，首轮）

### issues

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 9 | 10775.0 | 86236.9 | 65.8 KiB | - |
| GET | `/api/issues/child-progress` | 1 | 11617.2 | 11617.2 | 753 B | - |
| GET | `/api/pins` | 1 | 7796.9 | 7796.9 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 7784.7 | 7784.7 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 6377.8 | 6377.8 | 41.4 KiB | - |

### my-issues

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 8 | 6602.2 | 44990.6 | 17.6 KiB | - |
| GET | `/api/issues/child-progress` | 1 | 6605.1 | 6605.1 | 753 B | - |
| GET | `/api/pins` | 1 | 4654.4 | 4654.4 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 4448.8 | 4448.8 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 3840.1 | 3840.1 | 41.4 KiB | - |

### chat

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/workspaces` | 1 | 2489.8 | 2489.8 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 2484.2 | 2484.2 | 766 B | - |
| GET | `/api/config` | 1 | 2430.5 | 2430.5 | 182 B | - |

### inbox

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 4625.4 | 9247.1 | 17.4 KiB | - |
| GET | `/api/workspaces/:id/members` | 1 | 4845.4 | 4845.4 | 159 B | - |
| GET | `/api/inbox/page` | 1 | 4715.7 | 4715.7 | 21.7 KiB | - |
| GET | `/api/pins` | 1 | 4628.5 | 4628.5 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 4613.1 | 4613.1 | 21 B | - |

### agents

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/inbox/summary` | 1 | 2970.4 | 2970.4 | 30 B | - |
| GET | `/api/workspaces` | 1 | 2937.7 | 2937.7 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 2932.1 | 2932.1 | 766 B | - |
| GET | `/api/invitations` | 1 | 2884.8 | 2884.8 | 2 B | - |
| GET | `/api/squads` | 1 | 2882.6 | 2882.6 | 3.0 KiB | - |

### runtimes

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/workspaces` | 1 | 4580.2 | 4580.2 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 4575.8 | 4575.8 | 766 B | - |
| GET | `/api/config` | 1 | 3526.2 | 3526.2 | 182 B | - |
| GET | `/api/inbox/summary` | 1 | 2725.3 | 2725.3 | 30 B | - |
| GET | `/api/invitations` | 1 | 2622.2 | 2622.2 | 2 B | - |

### projects

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 6067.1 | 12131.6 | 17.4 KiB | - |
| GET | `/api/workspaces/:id/members` | 1 | 6509.0 | 6509.0 | 159 B | - |
| GET | `/api/projects` | 1 | 6072.4 | 6072.4 | 1.0 KiB | - |
| GET | `/api/pins` | 1 | 6069.9 | 6069.9 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 6038.6 | 6038.6 | 21 B | - |

### workbench

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 3 | 6896.8 | 20671.1 | 25.5 KiB | - |
| GET | `/api/pins` | 1 | 6892.5 | 6892.5 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 6878.4 | 6878.4 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 4504.3 | 4504.3 | 41.3 KiB | - |
| GET | `/api/inbox/summary` | 1 | 3827.7 | 3827.7 | 30 B | - |

### settings

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/workspaces` | 1 | 3667.6 | 3667.6 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 3661.8 | 3661.8 | 766 B | - |
| GET | `/api/config` | 1 | 3543.0 | 3543.0 | 182 B | - |

### autopilots

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 4723.8 | 9421.2 | 17.4 KiB | - |
| GET | `/api/workspaces` | 1 | 7267.1 | 7267.1 | 4.3 KiB | - |
| GET | `/api/me` | 1 | 7261.5 | 7261.5 | 766 B | - |
| GET | `/api/config` | 1 | 6611.7 | 6611.7 | 182 B | - |
| GET | `/api/autopilots` | 1 | 4748.5 | 4748.5 | 9.0 KiB | - |

### skills

| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| GET | `/api/issues` | 2 | 10597.5 | 21192.0 | 17.4 KiB | - |
| GET | `/api/skills` | 1 | 10603.1 | 10603.1 | 2.6 KiB | - |
| GET | `/api/pins` | 1 | 10600.4 | 10600.4 | 2 B | - |
| GET | `/api/cli/latest-version` | 1 | 10572.6 | 10572.6 | 21 B | - |
| GET | `/api/agent-task-snapshot` | 1 | 4619.9 | 4619.9 | 39.8 KiB | - |

## 被拦截的写请求

无。页面加载过程中没有任何非 GET/HEAD 的 `/api/**` 请求。

## inbox 专项

| 接口 | Status | 解码字节 | 条目数 | 备注 |
| --- | ---: | ---: | ---: | --- |
| `/api/inbox` | 200 | 14.85 MiB | 4411 | {} |
| `/api/inbox/summary` | 200 | 30 B | - | {"unread":170,"attention":199} |
| `/api/inbox/unread-count` | 200 | 14 B | - | {"count":3040} |
| `/api/inbox/page?limit=50` | 200 | 142.7 KiB | 50 | {"hasMore":true,"hasNextCursor":true} |

只读护栏自检：对 `/api/inbox/unread-count` 发 POST —— **已被拦截**。POST 被 page.route 拦截并 abort，护栏生效

inbox 页面打开时尝试了 1 个写请求，全部被 abort：

- `POST /api/inbox/:id/read`（inbox-guard-click，尝试 992 次，全部 abort）
