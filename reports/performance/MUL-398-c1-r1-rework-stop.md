# MUL-398 C-1 r1返工停止：表外非消息路由新增21个500

状态：停止，未完成C-1返工。按本轮授权的停止条件「全路由实测在messaging之外又找出超过20条遗漏」执行；没有自行扩表或改变8 MiB默认方案。

## 现场与方法

- 受管分支 `agent/MUL-398` 从 `2edf5f71` 合入 `origin/main 80f82058`，merge commit `c0f3da0a002e385d9e8ecdcf475ac8d7268b2829`，无文本冲突；merge tree `80fa64576eb933dca354254b9e4a55600cec5ce4`。本轮修复与审计脚本仍未提交，报告数字针对合并提交加本地未提交改动。
- 自建本任务专用 PostgreSQL 15.19，loopback 端口56698。main `80f82058` 在独立锁定 detached worktree，当前分支在受管工作区。每次各建独立同型数据库、运行完整 `createMultiremiApp`，按运行时 `app.routes` 的329条GET模式各请求GET和HEAD，共658个请求/版本，读取响应并记录状态；请求超时20秒。
- 初轮 fixture 在 PG 中给 `multiremi_workspaces.context`、agent instructions、project instructions、issue description、skill content、canonical message searchable_text、source allowlist 各放一行约9 MiB。各对象由现有 Store API 创建后更新长字段；消息授权后一分钟发送，满足 consent 规则。其余要求的大列类别尚未植入，写路由、页面和外部替身尚未测，故此为触发停止条件的初轮而非完整验收。
- main：430/658 为2xx、8/658 为5xx；当前工作树：372/658 为2xx、72/658 为5xx、64条 `api_db_reply_rejected`。main本身的8条5xx来自缺少查询参数或虚拟comment ID，两边同因，不计回归。main 2xx → 当前5xx 共58请求/29个GET模式，其中messaging/feishu 8个模式，**表外非messaging 21个模式、GET+HEAD 42个请求**。全部21条均是200→500，GET与HEAD各一次。单次拒绝样本约9,437,432 B，大于8,388,608 B；实际大字段可经 `WorkspacesRepo.listWorkspaces/getWorkspace` 的 `SELECT *` 读取，`context` 为无SQL字节界的TEXT列。

## 触发停止的21条

| GET模式 | main GET/HEAD | 当前GET/HEAD |
|---|---|---|
| `/api/daemon/workspaces/:workspaceId/repos` | 200/200 | 500/500 |
| `/api/workspaces` | 200/200 | 500/500 |
| `/api/workspaces/:id` | 200/200 | 500/500 |
| `/api/workspaces/:id/organizer` | 200/200 | 500/500 |
| `/api/workspaces/:id/issue-topics` | 200/200 | 500/500 |
| `/api/workspaces/:id/bot-menu` | 200/200 | 500/500 |
| `/api/workspaces/:id/prompts` | 200/200 | 500/500 |
| `/api/workspaces/:id/prompt-template` | 200/200 | 500/500 |
| `/api/workspaces/:id/repos` | 200/200 | 500/500 |
| `/api/workspaces/:id/env` | 200/200 | 500/500 |
| `/api/workspaces/:id/ssh-mesh` | 200/200 | 500/500 |
| `/api/workspaces/:id/relay-config` | 200/200 | 500/500 |
| `/api/workspaces/:id/feishu-bot/status` | 200/200 | 500/500 |
| `/api/workspaces/:id/feishu-bot/routes` | 200/200 | 500/500 |
| `/api/workspaces/:id/feishu-bot/senders` | 200/200 | 500/500 |
| `/api/workspaces/:id/members` | 200/200 | 500/500 |
| `/api/workspaces/:id/invitations` | 200/200 | 500/500 |
| `/api/multiremi/platform/config` | 200/200 | 500/500 |
| `/api/multiremi/platform/status` | 200/200 | 500/500 |
| `/api/multiremi/platform/operations` | 200/200 | 500/500 |
| `/api/workspaces/:id/issue-archive` | 200/200 | 500/500 |

## 已完成的局部返工与缺口

- Hono 4.12.28 的HEAD分发固定复用GET handler；桥的例外查找已在本地把HEAD映射为GET，日志origin仍保留HEAD。源码没有 `app.on(...)` 或 `app.all(...)` 的产品路由注册。逐条GET例外HEAD守卫及24 MiB真实PG读取通过。
- 已在本地给QA指出的15条messaging/feishu路由加例外。真实PG canonical message 9,437,960 B 与source allowlist 9,437,840 B 的五条GET及HEAD均200。C-1定向真实PG测试7/7通过。全路由比较仍有另外8条messaging/feishu模式失败，说明本轮不能只补15条。
- 运行时清单确实可取得775条业务路由，旧字面量审计不完整。新脚本初版结合 schema 的132张表/1556个TEXT/JSON/BLOB列和AST调用链，列出307条额外静态候选，尚有4条循环注册的parent-done-grant路由未映射。静态候选包含行宽/投影误报，不能当作生产超限或本次实测500计数；审计分类门禁尚未完成且当前arch检查会失败。
- 全类别长样本、10条消息写路由、浏览器页面、正式报告/文档、全部验证及CI 6/6均未执行。本地未提交代码不可当作可合入修复，PR #318继续Draft。

复跑入口：`tests/manual/probe-pg-reply-c1-routes.ts --root <main worktree> --out <output JSON>` 与不传 `--root` 的当前工作树调用，均需 `MULTIREMI_TEST_POSTGRES_URL` 指向自建loopback PG；其输出只含模式/状态/大小/跳过原因，不含凭证或连接串。补全所有大列fixture之前不得将本轮658请求称为完整全路由验收。
