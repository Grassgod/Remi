---
title: Issue 执行与上交
status: active
summary: 执行负责人与上交链、问题到顶交给工作区成员、done 规则、等待答案时的状态、SCM 合并与已退役的责任接口。
---

# Issue 执行与上交

每张 Issue 只有一个责任配置：执行负责人。上一级由 Issue 树推出，不能配置；问题沿执行负责人链
往上交，到根单之上交给工作区成员。取舍记录在 [ADR 0017](../adr/0017-issue-execution-and-escalation.md)。
[共享类型](../../packages/contracts/src/issue-responsibility.ts)定义稳定投影；
[resolver](../../packages/server/src/store/issue-responsibility.ts)是唯一解析入口，普通 Task/Turn 协作不改变这些事实。

## 执行负责人

`executionOwner` 是明确指派的 Agent，或指派团队的可用 Leader；`chain` 从本单到根单逐级给出各层的
执行负责人，重复负责人保留供审计。无 Leader、团队不可用、归档或跨工作区 Agent、未指派，以及父链缺失、
循环、跨工作区或 Issue 不存在，都记入 `unresolved`；不取普通队员、Agent 所属第一个团队或 workspace owner。
`revision` 只哈希执行负责人链及其可用性，普通评论和更新时间不改变版本。Issue 不再指定人类，
没有根人类或上级结果责任人。

新的执行指派仅接受 Agent 或团队，成员指派返回 `issue_execution_owner_required`；历史 member 指派保留
为缺少执行负责人的记录，不能将它猜成某个 Agent。新项目默认执行指派同样只接受 Agent 或团队，成员写入
返回 `409 project_execution_owner_required`。旧 member 项目默认保留原事实及待配置提示，无关编辑不会改写它，
也不复制到新单；须显式清空或改为 Agent/团队后才作为有效默认。

`responsible_member_id` 列保留在 Issue、自动化与 topic 存储里，不迁移、不删除。Issue 创建、更新、
快速创建，自动化创建、更新，Issue topic 配置和消息转 Issue 仍接受该输入以兼容旧客户端和测试夹具，
但不校验、不落库，也不被任何路由、授权或展示读取；这些响应不再返回它。飞书 bot 的
`responsible_member_id` 是另一回事：它指定无 Issue 的飞书 Chat 里问题的处理人，从不作为建单前提。

建单不要求、也不推断人类：HTTP 建单、Agent 建根单、自动化 `create_issue`、飞书 bot 与群 topic、
消息转 Issue 和入门引导都只配置执行负责人。创建人仍来自凭据，Task 和 daemon 凭据记为 null，不把
Runtime owner 记为创建人。消息转 Issue 的人类确认只在路由层 `requireHumanApprover`，飞书外部发送人
或 Runtime owner 不冒充审批成员。改父单或执行指派不需要人类确认，`issue_responsibility_transferred`
审计父单与执行指派的变化；它与指派、父单变更的记录重复，属于系统 activity，只在时间线的系统详情里显示。

显式跨工作区移动在同事务建立目标工作区的新 Main，并以 `issue_main_session_rotated` 审计主线替换；
旧 Session、head、消息、Q 和 provider 历史留在原工作区，不自动迁走。目标 Issue 的会话、任务、评论、
时间线及共享聚合只包含目标工作区历史；原会话直接读取仍按其原工作区鉴权。派发失败时移动、新 Main 和
审计共同回滚，进行中执行仍阻止移动。活动新增 nullable `workspace_id` 保存审计发生时的来源。旧未知活动
不猜回填；首次显式移动在原事务冻结来源，已有评论/Task 的空间事实优先，其余沿当时 Issue 归属。原正文和
数据保留；目标聚合只读目标来源，跨空间历史中未知来源的活动也不能因 null 越权显示。附件读取同样核对附件
和原评论 conversation head 的来源；原空间成员可读历史附件，旧评论在移动后只读，目标空间不能用已知旧
评论/附件 ID 上传、重新关联或通过新分享取文件。

显式派活的取消、指派变更、Task/轮创建和派生状态共享调用方事务；gate 与 unassign 也不另开事务。
派活失败全部回滚，事件及子状态副作用统一在提交后处理一次。Task 请求在选择会话前沿 W→I 锁定并重新
核对 Issue 与 Agent 的工作区；移动先完成时，后来的旧空间派活会被结构校验拒绝，不进入目标主线或目标
工作区锁。消息到轮的建单阶段复用当前同步调用持有的 Issue 锁，调用结束或失败即释放复用标记，不跨事务缓存。
Native/兼容 PATCH 的条件派发由 store 与字段更新同事务完成；真实派发故障回滚归属、Question 路由、
旧卡凭据和任务，不返回成功的半归属。无可运行的已配置负责人保留明确的 `dispatch_skipped` 审计。

## 上交链与人工阶段

来自 Issue 的问题（含 `permission`、`merge`、`production_change` 权限请求）按本单执行负责人 →
父单执行负责人 → … → 根单执行负责人 → 人工阶段的顺序路由，跳过重复负责人和提问者本人。某一层没有可用
执行负责人，或父链结构异常时，不跳级、不猜人，在断点处直接进入人工阶段，并在 `route_reason` 记录
`<issueId>:<原因>`。来源已移到其他工作区（`source_workspace_changed`）的问题保持冻结，无人可处理。

人工阶段不指定具体成员：问题来源工作区里任何有效（未归档）的真实成员都可以读取原问题、回答、修订在
人工阶段给出的答案、关闭和授权续接。能否修订看答案由谁给出：成员的答案只能来自人工阶段，可以修订；
Agent 的答案保持原样。自动重新路由移动已答问题的当前步骤，不改变这一点；历史业务 decision 的例外见
[统一问题](questions.md)。Task 凭据、daemon、Runtime 技术 owner 和飞书外部发送人都不算
成员。交给 Agent 的阶段对成员只读；Agent 答不了用 `escalate` 交给下一级。没有转交给另一个人的动作：
责任事实变化（指派、团队 Leader、Agent 可用性或工作区、父单）在原变更事务刷新受影响子树的待答和待恢复
Q，增加路由版本、记录 `transfer` 历史并使旧卡凭据失效；答复、升级、关闭、呈现、续接和卡片答复执行前
还会自动重新路由版本已过期的 Q，GET 不写库。
成员变化只刷新无 Issue 的 Chat 问题；普通资料编辑不重新路由问题。路由、答复格式、读时升级与续接细节见
[统一问题](questions.md)。

进入人工阶段时，Inbox 提醒根单创建人（如果是有效成员）和来源 Issue 的成员订阅者，每人一条，零人时只
记录历史；Remi 总结流程不变。飞书卡片发给根单创建人，前提是能唯一映射到 bot 应用的 open_id，否则降级为
原问题文字加工作台入口。提醒只是通知，不限制谁能处理。续接失败与待恢复提醒发给同一批人。

## 状态与关单

`in_review` 表示需要人操作或阅读。执行负责人这一轮的最后一条回复就是总结；这一轮正常结束后 Issue 自动派生为
`in_review`。本单有问题停在人工阶段时 Issue 同样是 `in_review`，问题还在等 Leader 回答时保持 `in_progress`，
升级到人工阶段时自动切换；回答后原调用恢复运行，回到 `in_progress`。评论唤醒执行负责人后回到
`in_progress`，这一轮结束再回到 `in_review`。派生规则见[统一收件箱 Store](inbox-store.md)。

改成 `done` 是一次普通的状态修改，PATCH、兼容 PATCH/PUT 和 batch 共用 store 里的同一套规则：

| 操作者 | 可以改成 `done` 的 Issue |
| --- | --- |
| 真实成员 | 任何 Issue |
| Agent（Task 凭据） | 只有「自己是其直接父单执行负责人」的子单；不能改自己担任执行负责人的单，不能改根单 |

Agent 越权返回 `403 issue_done_requires_parent_owner` 或（无同工作区父单时）`403 issue_done_requires_member`。
子单未完成守卫（[ADR 0003](../adr/0003-parent-status-derived-from-children.md) Guard A）照常执行，`force` 只允许
成员。done 规则不受 `MULTIREMI_PARENT_STATUS_GUARD` 影响。批量写入先对每行预检，任一行被拒整批回滚，
写循环中的拒绝同样抛出，不吞成 `200 updated:0`；已 `done` 行的状态 no-op 保持可用。直接以 `done` 创建
Issue 返回 `409 issue_create_done_unsupported`。父单执行负责人看完子单结果，没问题把子单改成 `done`，
有问题给子单发消息；根单由任何成员改成 `done`，有问题直接评论。

done 规则按写入时 Issue 当前的父单判断，是流程约束，不是安全边界。改父单和改执行指派不需要成员确认，
同工作区的 Task 凭据仍可以先把一张根单挂到自己执行的单下，或把自己执行的单改派给别的 Agent，再以父单
执行负责人的身份把它改成 `done`；同一次请求里同时改父单和状态，仍按改动前的父单判断。这些移动都以该
Agent 的身份记入 `issue_updated` 与 `issue_responsibility_transferred`，可以审计。需要硬隔离时应收紧
Task 凭据对父单与指派的写权限，而不是让 done 规则推断历史。

父单执行负责人持续收到子单状态通知，包括阻塞、失败、取消与结果；父链其他层的缺口不影响这条通知。
角色收件人 `issue_owner` 与 `leader` 解析为本单执行负责人，`parent_owner` 解析为父单执行负责人；没有时
消息照常落库，收件人为空，`metadata.responsibility_unresolved` 记录原因，不回退到人。普通派活报告仍回到
实际派活人的原 Session 和 execution scope，跨团队不改变 Issue 责任。

SCM merge 不关单，也不写 hold：effect 锁定关联 Issue，追加 `scm_merge_completed` activity（change request、
编号、链接、分支、事件和归属）后标记已应用，状态按上面的派生规则走。这条记录默认显示在时间线里
（「关联的代码变更 #N 已合并」）。effect 类型名 `complete_issue_on_merge` 作为数据库值保留。#404 期间合入
留下的 `issue_delivery_acceptance_required` hold 记录按「合入后未改变 issue 状态」显示，不再声称子单未结束。

Issue 详情的 `pending_decision_count` 只统计本单人工阶段的待答问题，等待 Agent 回答的问题不计入。

## 接口

接口在 [Issue routes](../../packages/server/src/api/routers/issues.ts)：`GET /api/issues/:id/responsibility`
返回 `IssueResponsibility`。下列接口已退役，返回 `410 route_retired` 和替代说明，同名 CLI 命令登记为 retired：

| 已退役 | 替代 |
| --- | --- |
| `GET`/`POST /api/issues/:id/deliveries`、`POST …/deliveries/:deliveryId/respond`、`POST …/deliveries/:deliveryId/authorize` | 最后一条回复就是总结；用 `remi issue status <issue> done` 关单 |
| `GET /api/workspaces/:workspaceId/issue-responsibility-migration`、`POST …/issue-responsibility-migration/map` | `remi issue responsibility <issue>`；用 `remi issue assign` 配置执行负责人 |
| `POST /api/messages/:id/question/transfer` | 责任变更后自动重新路由 |
| `POST`/`DELETE /api/issues/:id/parent-done-grant` 与 `/api/multiremi/issues/:id/parent-done-grant` | 父单执行负责人直接关闭子单；成员可关闭任何 Issue |

历史消息里的 `issue_delivery` metadata 留在数据库，按普通消息展示；`parent_done_grant_*` 列和历史 activity
保留只读，不再授权关单。完整的 CLI 替代见 [CLI 命令契约](../cli-command-migration.md)。

## 验证入口

`bun run test tests/unit/multiremi/issue-questions.test.ts tests/unit/multiremi/issue-responsibility-transfer-hooks.test.ts`
覆盖路由顺序、断点直接进入人工阶段、权限请求、成员答复与责任变更时的自动重新路由；
`tests/unit/multiremi/inbox-issue-status.test.ts`、`multiremi-issue-status-sync.test.ts` 和 `issue-questions.test.ts` 覆盖等待答案时的状态派生（Leader 阶段 `in_progress`、升级到人工阶段 `in_review`、回答后回到 `in_progress`），
[`issue-done-rule.test.ts`](../../tests/unit/multiremi/issue-done-rule.test.ts) 覆盖 done 规则（成员、父单执行
负责人、自己与根单被拒、Guard A 与 `force`、PATCH/兼容入口/batch 一致、批量整体回滚、先移动后关单的流程约束），
[`issue-responsibility-resolver.test.ts`](../../tests/unit/multiremi/issue-responsibility-resolver.test.ts) 覆盖
resolver 的父链缺失与循环、Leader 缺失和不取普通成员，`tests/unit/multiremi/scm-store.test.ts` 覆盖 merge 只记录。
SQLite 使用内存库；设置 `MULTIREMI_TEST_POSTGRES_URL` 后运行同一组真实 PostgreSQL 用例，未配置 PG 显示
skipped，不计作通过。
[`responsibility-http-integration.test.ts`](../../tests/unit/remi/responsibility-http-integration.test.ts) 用 Web
ApiClient 走实际鉴权 HTTP 路由。API 快照脚本的责任流程显式检查路由起点、成员在 Agent 阶段只读、人工阶段
无具体处理人、Remi 总结、原等待消费、done 规则与退役接口 410。这些验证不代替真实浏览器或 PPE 环境的检查。

通用测试创建用 `createResponsibleTestIssue`（保留的 responsible 参数被忽略）；结束用
`acceptTestIssueDelivery` 以真实成员身份把 Issue 改成 `done`，不覆盖生产 Store 方法。
