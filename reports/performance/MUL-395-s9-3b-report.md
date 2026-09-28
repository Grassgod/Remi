# MUL-395 S9-3b：分组首页前后对比

before Web：e95b7a2345393fe7f79f13dcca3bdd4f6c32abe5
after 产品实现：8a48b0b59d32b4aa00ba3ed4a8efcd9a77531f48
合入 main：a30a8817daf891aabbb56fc7f85dc5a5d39074eb
Draft PR：https://github.com/Grassgod/Remi/pull/331（依赖 PR #297；472 合入 main 前不合入）。

## 实测口径

同机 n37-066-008、Bun 1.3.14、Chromium 1440×900、同一进程内 SQLite fixture（5 条 issue；MUL-454 的 210 条评论副本）。before 是 git archive 的 472 head，工作区包链接指向 archive 自身。after 使用本单实现；前后 Web 顺序运行 Next dev --webpack。未访问生产。
原 S1 CLI 每页 cold/warm 各 5 轮；My Issues 默认 assigned。另用相同 S1 recorder、selectors、测量层采集真实首行位置；该组显式固定 my scope=all，主列表延迟 300ms、延后请求延迟 900ms，与 472 的位置验证一致。cold 从文档原点、warm 从点击计时；warm 入口 issues←inbox，其他目标←issues，500ms 请求安静窗口/5s 上限，hover=150ms。
位置指标是固定真实行到达最终 top 的首帧；观察首行后 3000ms，同时计算 S1 前 1500ms jumpPx。固定行必须存在、可见且未断连。数字为中位数和最近秩 p95（n=5 即最大值），全部采样保留。Next dev、合成延迟和共享机器负载下的数值不代表生产 p95。

## 真实列表位置与请求

| 页面 | 模式 | n | 主列表+归档 HTTP | 首屏全部 API p50 | 最终位置 ms p50 | 最终位置 ms p95 | 固定行 px max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| issues | cold | 5 | 6+1 → 1+0 | 14 → 8 | 2903.8 → 2813.5 | 7681.2 → 3083.2 | 0 → 0 |
| issues | warm | 5 | 6+1 → 1+0 | 8 → 2 | 1732.8 → 1615.4 | 2345.7 → 1685.3 | 0 → 0 |
| my-issues-all | cold | 5 | 18+0 → 3+0 | 25 → 10 | 2900.8 → 2772.4 | 2925.6 → 2924.8 | 0 → 0 |
| my-issues-all | warm | 5 | 18+0 → 3+0 | 30 → 15 | 1731.7 → 1607.3 | 1787.9 → 1645.9 | 0 → 0 |

## 原 S1 CLI

| 页面（my 默认 assigned） | 模式 | 首屏全部 API p50 | ready ms p50 | ready ms p95 | S1 jumpPx max |
| --- | --- | --- | --- | --- | --- |
| page-issues | cold | 18 → 12 | 2831.4 → 2691.8 | 9253.7 → 11315.1 | 0 → 0 |
| page-issues | warm | 8 → 2 | 1716.5 → 1566.8 | 1842.1 → 1588.7 | 0 → 0 |
| page-my-issues | cold | 17 → 12 | 2805.6 → 2636.8 | 2935.7 → 2767.3 | 0 → 0 |
| page-my-issues | warm | 6 → 1 | 1581.3 → 1478.6 | 1607.3 → 1518.9 | 0 → 0 |

## 472 六场景与长样本

| 场景 | 模式 | n | 固定行 px | S1 jumpPx | 断连帧 |
| --- | --- | --- | --- | --- | --- |
| 472-issues | cold | 1 | 0 | 0 | 0 |
| 472-issues | warm | 1 | 0 | 0 | 0 |
| 472-inbox | cold | 1 | 0 | 0 | 0 |
| 472-inbox | warm | 1 | 0 | 0 | 0 |
| 472-detail | cold | 1 | 0 | 0 | 0 |
| 472-detail | warm | 1 | 0 | 0 | 0 |
| MUL-454 | cold | 1 | 0 | 0 | 0 |
| MUL-454 | warm | 1 | 0 | 0 | 0 |

## 接口与兼容

issues 状态首页显式传当前六个 PAGINATED_STATUSES、limit=50、原 sort/filter，以及 include_archived_total=true；groups[status] 的 issues/total 填入原 {byStatus} 缓存，archived_total 写入原数字计数 key。
my assigned/created/agents 各 1 次，all 按 assignee/creator/involves 三个原筛选各 1 次，18→3；合并顺序、去重和 total 规则不变，未增加后端 relation=any 或修正旧 creator/involves/sort 语义。加载更多仍是 /api/issues 单状态，offset 等于该桶已加载条数。
404 每 API client 只探测一次（并发 all 共享探测），随后本会话走旧路径；新会话重新探测。401/500 不当作版本错配。工作区负责人看板在 /api/issues/grouped 上也显式请求可选归档计数，保持隐藏状态子树不订阅；旧 API 忽略此字段时只在兼容分支恢复旧归档请求。两服务端 grouped 路由默认字段/查询成本不变，CLI issue grouped 新增 --include-archived-total。

## 失效与 refetch 清单

| 来源 | 行为 |
| --- | --- |
| core/issues/queries.ts: issueListOptions / myIssueListOptions | 原 key 不变；每次 queryFn 执行均取分组首页。数字归档计数是 skipToken 被动订阅，由活跃状态/负责人列表写入。 |
| core/issues/mutations.ts | create / update / unarchive / delete / batch update / move：list 或 issues 根前缀失效；my 乐观缓存/删除清理和旧失效规则保留。 |
| core/issues/delete-cache.ts | 删除后的 list + myAll 失效走各自同一个分组 queryFn。 |
| core/issues/ws-updaters.ts | issue created / updated / deleted、labels、metadata、kind：保留直接 cache patch；需 refetch 的 my/负责人/位置列表走现有 key。归档和取消归档额外刷新活跃 workspace 列表，以更新随页计数。 |
| core/realtime/use-realtime-sync.ts | 重连时 issueKeys.all(wsId) 失效。 |
| core/realtime/sync/prefix-refresh.ts | squad 删除、label 事件的 issues 根前缀；其 tasks/sessions/usage/detail 前缀不匹配 workspace list/my key。 |
| core/realtime/sync/workspace.ts；views/settings/components/workspace-tab.tsx | 工作区快照/设置变化触发 issues 根前缀。 |
| core/labels/mutations.ts；views/issues/components/issue-description-section.tsx | 标签修改/删除与描述保存触发 issues 根前缀。 |
| core/query-client.ts；QueryObserver.refetch / invalidateQueries / focusManager | 生产默认 staleTime=Infinity、窗口聚焦不重新拉取、重连重新拉取。显式 refetch 或启用聚焦并失效时使用同一分组 queryFn；守卫覆盖这三种情况。 |

## 测试与回归

| 复现命令 | 结果 |
| --- | --- |
| bun run typecheck:frontend | 通过；main + 472 最后合并后的版本。 |
| bun run test:frontend | 3631 pass / 18 skip / 0 fail；core 1109、views 2467、web 55。 |
| bun run --cwd frontend/packages/core test issues/status-pages.test.ts | 等价、请求数、失效、404 与错误隔离守卫全部通过；定向四文件合计 72/72。 |
| bun run tests/manual/mul395-s9-3b-backend.ts postgres tests/unit/multiremi/issue-status-pages.test.ts tests/unit/multiremi/request-metrics.test.ts | 真实 PG：新路由、静态 metrics 标签、归档可选成本用例通过；连同合并后专项共 52 pass / 0 fail。 |
| bun run tests/manual/mul395-s9-3b-backend.ts sqlite tests/unit/multiremi/issue-status-pages.test.ts tests/unit/multiremi/request-metrics.test.ts tests/unit/remi/cli-collaboration.test.ts | SQLite + CLI：85 pass / 8 PG 专项 skip / 0 fail。dbq 单个用例独立启动也通过，预热不再依赖前序。 |
| bun test tests/arch/ --timeout 20000 | 108 pass / 0 fail，3898 次断言。 |
| bunx tsc --noEmit | 通过；含新增复现脚本。 |
| npm run docs:check；npm run docs:test | 通过；docs:test 13 pass。 |
| npm run cli:capabilities:check | 678 mapped / 96 exempt / 0 missing；774 路由。 |
| bun run scripts/snapshot-api-routes.ts --check | 通过；本任务只给已有 grouped 加显式参数，路由条数未增加。 |
| bun run tests/manual/mul395-s9-3b-browser.ts <472 的 git archive 快照目录>；bun run tests/manual/mul395-s9-3b-report.ts | 原 S1 after 28 轮与实际行位置 after 28 轮均为 0px；before/after 配对各 20 轮。 |

## 变异与恢复

| 临时变异 | 实际失败 |
| --- | --- |
| fetchFirstPages 恢复循环 | 3 fail；issues 预期 1、收到 7；assigned 预期 1、收到 6；all 预期 3、收到 18（status-pages.test.ts:143）。 |
| 仅预热后改用逐状态请求 | 1 fail；invalidate 后预期 1、收到 6（status-pages.test.ts:148）。冷开守卫先通过。 |
| 删除 include_archived_total | 5 fail；List response is missing requested archived_total；归档失效守卫的 isSuccess 预期 true、收到 false（:168）。 |
| 删除 404 兜底 | 2 fail；两个 404 用例收到 ApiError: not found，未得到预期缓存；401/500 两用例仍通过。 |

四项逐个还原；每次 git diff --exit-code -- frontend/ packages/ 退出 0，恢复后 core 四文件 72/72。临时修改未提交。

## 限制与复核事项

这是本地性能与定向测试报告。顺序执行的 PG/SQLite 全量和最终提交 CI 的完整结果见 MUL-395 的 S9-3b 交付评论。测速对应 8a48b0b5；之后无冲突合入 main a30a8817，未改 issues/my-issues 前端，因此按续跑要求沿用这些配对采样。

before 为 472 最终 head e95b7a23。前后 Next dev 都出现已有 use-kanban-drag.ts:121 的 Maximum update depth exceeded 告警；该 hook 不在本单改动内，真实行的 3 秒采样仍没有跳动或断连。合成 squad fixture 的 creator_id/leader_id=null 另触发 schema 告警。这些本地环境现象不代表生产页面。

原 S1 after issues cold 首轮 ready=11315ms 的离群值未剔除。S1 列表 profile 以容器就绪为准，首行字段可能为空，因此另外固定实际 issue/inbox/comment 行，不能单凭 S1 jump=0 推断列表稳定。

472 的六场景是 issues/inbox/detail 的 cold/warm 各一轮；长样本是同一 fixture 中 MUL-454 的 210 条评论副本，cold/warm 各一轮。所有 after 固定行 px、S1 jumpPx 与断连帧都为 0。

上一轮 PG 全量中已有 MUL-473 pending-tasks 的 1→200 Chat 夹具曾接近或超过 20s。该文件单跑通过 10/10，纯 472 e95b7a23 复现同一个 24.480s 超时；本轮在纯 main a30a8817、同一实例且本单全量并行的负载下，该用例通过（16.917s）。没有放宽断言、增加 timeout 或跳过用例。一次跨 main 合并的全量还读到 772/774 路由两版本；该次不作为最终验证，最终两套全量固定合并态顺序运行。

按前置约定保留旧服务端 creator_id、involves_user_id、排序参数的既有语义；本单只合并往返和修复观测标签，不改变筛选结果。404 兼容模式仍需要旧请求数量，新 API 的请求数收益不适用于该模式。

## 临时 PG

仅使用自起的 PostgreSQL 18.4，端口 55433，数据目录 /tmp/mul395-pg/data。公共 @embedded-postgres/linux-x64@18.4.0-beta.17 提供二进制及 ICU；LD_LIBRARY_PATH 指向同目录的 libshim 和 package/native/lib。initdb/pg_ctl 均通过 unshare --user --map-user=1000 --map-group=1000 运行。启动参数 -p 55433 -k /tmp/mul395-pg/socket -h 127.0.0.1；停止用 pg_ctl -D /tmp/mul395-pg/data -m fast -w stop。测试连接设置仅存在子进程内存，runner 清除 MULTIREMI_TOKEN。没有使用 5433，没有读取其他实例配置。

## 本单非 merge 文件

- apps/remi/cli/commands/collaboration.ts
- docs/cli-command-migration.md
- docs/dev/performance.md
- frontend/packages/core/api/endpoints/issues.ts
- frontend/packages/core/api/schemas/issues.ts
- frontend/packages/core/issues/mutations.test.tsx
- frontend/packages/core/issues/queries.test.ts
- frontend/packages/core/issues/queries.ts
- frontend/packages/core/issues/status-pages.test.ts
- frontend/packages/core/issues/ws-updaters.ts
- frontend/packages/core/types/api.ts
- frontend/packages/views/common/list-perf-marker-query.test.tsx
- frontend/packages/views/issues/components/issues-page.test.tsx
- frontend/packages/views/issues/components/issues-page.tsx
- packages/server/src/api/routers/issues.ts
- packages/server/src/observability/request-metrics.ts
- reports/performance/MUL-395-s9-3b-report.html
- reports/performance/MUL-395-s9-3b-report.md
- reports/performance/MUL-395-s9-3b/after-472-detail-short.html
- reports/performance/MUL-395-s9-3b/after-472-detail-short.json
- reports/performance/MUL-395-s9-3b/after-472-detail-short.md
- reports/performance/MUL-395-s9-3b/after-472-detail-xlong.html
- reports/performance/MUL-395-s9-3b/after-472-detail-xlong.json
- reports/performance/MUL-395-s9-3b/after-472-detail-xlong.md
- reports/performance/MUL-395-s9-3b/after-472-page-inbox.html
- reports/performance/MUL-395-s9-3b/after-472-page-inbox.json
- reports/performance/MUL-395-s9-3b/after-472-page-inbox.md
- reports/performance/MUL-395-s9-3b/after-472-page-issues.html
- reports/performance/MUL-395-s9-3b/after-472-page-issues.json
- reports/performance/MUL-395-s9-3b/after-472-page-issues.md
- reports/performance/MUL-395-s9-3b/after-page-issues.html
- reports/performance/MUL-395-s9-3b/after-page-issues.json
- reports/performance/MUL-395-s9-3b/after-page-issues.md
- reports/performance/MUL-395-s9-3b/after-page-my-issues.html
- reports/performance/MUL-395-s9-3b/after-page-my-issues.json
- reports/performance/MUL-395-s9-3b/after-page-my-issues.md
- reports/performance/MUL-395-s9-3b/after-positions.json
- reports/performance/MUL-395-s9-3b/before-page-issues.html
- reports/performance/MUL-395-s9-3b/before-page-issues.json
- reports/performance/MUL-395-s9-3b/before-page-issues.md
- reports/performance/MUL-395-s9-3b/before-page-my-issues.html
- reports/performance/MUL-395-s9-3b/before-page-my-issues.json
- reports/performance/MUL-395-s9-3b/before-page-my-issues.md
- reports/performance/MUL-395-s9-3b/before-positions.json
- reports/performance/MUL-395-s9-3b/validation.json
- tests/manual/mul395-s9-3b-backend.ts
- tests/manual/mul395-s9-3b-browser.ts
- tests/manual/mul395-s9-3b-fixture.ts
- tests/manual/mul395-s9-3b-positions.ts
- tests/manual/mul395-s9-3b-report.ts
- tests/unit/multiremi/issue-status-pages.test.ts
- tests/unit/multiremi/request-metrics.test.ts
- tests/unit/remi/cli-collaboration.test.ts
