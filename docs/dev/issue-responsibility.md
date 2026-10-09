---
title: Issue 责任与正式交付
status: active
summary: 明确根人类、统一解析单内及父单责任，并通过具体交付验收关闭 Issue。
---

# Issue 责任与正式交付

责任事实来自 Issue，普通 Task/Turn 协作不会改变这些事实。
[共享类型](../../packages/contracts/src/issue-responsibility.ts)定义稳定投影；
[resolver](../../packages/server/src/store/issue-responsibility.ts)是唯一解析入口。

`executionOwner` 是明确指派 Agent 或指派团队的可用 Leader；`reviewOwner` 是直接父单的
`executionOwner`，顶层则为明确人类。`rootHuman` 沿父链读取根单的 `responsible_member_id`。
子单不复制根人类字段。无 Leader、归档或跨工作区 Agent、根人类缺失、父链缺失或循环，
均保留可见 `unresolved` 原因；不取普通队员、Agent 所属第一个团队或 workspace owner。
`revision` 只哈希责任事实及可用性，普通评论和更新时间不改变版本。
新的执行指派仅接受 Agent 或团队；历史 member 指派保留为缺少执行统筹的记录，
不能将它猜成某个 Agent。人类责任单独配置在根单字段；旧 member 项目默认不复制到新单。

创建根单必须传明确 `responsible_member_id`，或由真实人类创建来源承担责任。
HTTP 的创建人来自凭据；Agent 创建新根可继承其真实来源 Issue 的明确人类，
或 Web Chat 实际创建人的有效 workspace member。Task 凭据不把 Runtime owner 记为人类创建人。
飞书绑定 Chat 的 creator 可能只是技术归属，不能证明外部发送人的人类责任；群聊和私聊
都只使用明确配置的 bot `responsible_member_id`，群聊 topic 可显式覆盖。配置缺失时群消息
仍保留在 Chat，并显示可行动的责任缺口；不自动生成未知责任根单。
自动化 `create_issue` 使用配置的 `responsibleMemberId`（compat 为 `responsible_member_id`），
新建 HTTP 自动化可从真实成员凭据或 Task 的有效来源设置初始责任，创建归属也由凭据决定。
显式自动化、bot 或 topic 人类责任配置要求真实 workspace 管理员；普通通用 settings 写入
不能绕过 topic 配置的人类门禁。Agent 可提交与已验证来源相同的创建字段，不能另选人类，
也不能通过改父单将工作移到不同根人类责任下；daemon 不代表其技术 token owner 确认责任。
历史自动化的 `createdBy` 仅作归属，运行时不隐式变成人类责任。没有配置则拒绝建根单。
消息转 Issue 必须由真实成员确认；飞书外部发送人或 Runtime owner 不冒充审批成员。
入门引导从已验证 bootstrap 用户创建；显式 QA seed 和测试工厂使用有名称的合成成员。
历史根单迁移新增 nullable 字段，包含已经 unified 的快照升级，不猜测回填；缺失责任
通过 resolver 和关闭拒绝暴露。
更新根人类、父单、执行指派保留 `issue_responsibility_transferred` 审计。
同事务刷新受影响父链的未解决 Q、保留转交历史并失效旧卡凭据。团队 Leader 变更、移除或归档，
执行 Agent 的工作区移动/归档/恢复，以及根人类工作区移动/归档也执行相同刷新；普通资料编辑不移交问题。
无 Issue 的 Chat 问题在 bot 配置变更/删除及来源 Agent、明确成员的工作区或可用性变更时，
也在原变更事务刷新。移动实体同时核对旧工作区，避免原 Chat 遗留有效旧卡。配置的人类变更
保留实际成员操作人；密钥、域名等不改变责任事实的编辑不旋转问题版本。

父单执行负责人持续接收子单状态及正式交付通知，包含阻塞、失败、取消与结果。
负责人不可用时保留未送达原因，并向明确根人类呈现责任缺口。普通派活报告仍回到实际
派活人的原 Session 和 execution scope，跨团队不改变 Issue 责任。

# 正式交付与验收

[交付服务](../../packages/server/src/store/issue-deliveries.ts)将正式交付放在统一消息的
`issue_delivery` 元数据中，回复通过原会话 `reply_to_id` 引用交付，不建立另一套工作流表。
执行负责人使用自己的 Task 凭据提交非空总结，Issue 进入 `in_review`；父单或根人类收到
可定位的交付对象。只有当前指定 reviewer 能验收或退回，责任 revision 必须一致。

验收同事务写入回复、交付收据、Issue `done` 和审计；任何一项失败均回滚。
有未完成子单不能验收。退回必须填写意见，保存原交付与回复，并向原执行会话和 scope
排入继续处理消息；Issue 保持开放。消息与收据不可通过普通 edit/delete 改写。
Agent 提交及验收只能来自其责任 Issue 的主会话，继承旁支和 Chat 不具备正式交付权限。
交付固定原 Task 会话；取消或归档后不能用 pending 交付重新关单，需先恢复开放状态。
重复相同验收幂等；相反动作、已被新交付替代或责任移交后的旧交付被拒绝。
晚到结果仍保存原子单交付；已关闭或归档的父单仅接收可追溯的
`issue_delivery_review_unavailable` activity，不创建新通知或唤醒轮。交付返回当前
`reviewUnavailableReason`（`review_issue_closed`／`review_issue_archived`），pending 交付在父单
恢复前不能验收或退回；已 settled 收据保持原事实，重复验收仍幂等。

顶层指定人类可授权当前执行负责人代理验收，授权仅绑定当前 pending 交付和责任 revision。
授权/撤销均留审计；普通 parent-done-grant 不提供交付授权。代理验收保留原人类责任，
并记录实际 Agent 与授权人。重新提交、改责任或撤销使旧授权失效。

所有 `done` 状态写入都要求服务端正式验收收据，普通 PATCH、batch、`force`、旧 grant、
Task 完成、intake 生成子单和 SCM merge 均不能代替验收。SCM effect 保存
`issue_delivery_acceptance_required` 的 hold 记录并结束该 effect，不无限重试或自动关闭。
旧直接关闭入口返回可行动的 `issue_delivery_acceptance_required`，客户端应展示交付验收。

接口在[Issue routes](../../packages/server/src/api/routers/issues.ts)：

| 请求 | 参数 / 返回 |
| --- | --- |
| `GET /api/issues/:id/responsibility` | `IssueResponsibility` |
| `GET /api/issues/:id/deliveries` | `limit` 默认 50、最大 100，`before` 为上一页最后交付 id；返回 `{ deliveries: IssueDelivery[], nextCursor: string\|null }` |
| `POST /api/issues/:id/deliveries` | `{ summary, sessionId?, dedupeKey? }`，返回 `{ delivery }` |
| `POST /api/issues/:id/deliveries/:deliveryId/respond` | `{ action: accept\|return, body?, revision }`，返回 `{ delivery, issue }` |
| `POST /api/issues/:id/deliveries/:deliveryId/authorize` | `{ agentId: string\|null, revision }`，null 撤销；返回 `{ delivery }` |

通知与实时投递在事务提交后执行，可靠工作意图保留在统一消息/lane 中；不能把通知已发送
或执行队列为空当作验收完成。实际执行、AUQ 等待恢复以及飞书在线投递需要各自的独立证据。

# 验证入口

运行 `bun run test tests/unit/multiremi/issue-responsibility-deliveries.test.ts tests/unit/multiremi/issue-responsibility-transfer-hooks.test.ts`。
SQLite 使用内存库；设置 `MULTIREMI_TEST_POSTGRES_URL` 后每个测试创建独立随机数据库，
运行同一组真实 PostgreSQL 用例并清理自身测试库。未配置 PG 显示 skipped，不计作通过。
这些测试覆盖根人类缺失、Issue 父链、Leader 缺失、验收鉴权、同消息引用、移交失效、
代理授权撤销、退回继续处理、SQL 写入失败回滚、历史未知责任字段迁移与重启，以及
责任事实变更与 Q 转交的原子性；不代表生产历史副本、真实 provider 或飞书在线验收。
`chat-responsibility-mutation-hooks.test.ts` 通过实际配置和实体变更验证 Chat 转交、旧卡失效、
外层事务失败后配置/问题/凭据共同回滚及重启保留原会话；
`issue-responsibility-transfer-hooks.test.ts` 包含深层子单指派和已升级 Q 的真实 HTTP 回归。

# 历史归属复核

`GET /api/workspaces/:workspaceId/issue-responsibility-migration?limit=50&offset=0`
仅真实 workspace 管理员可分页复核缺失或失效人类责任的根单，返回 `total`、`rootCount`、`legacyMemberExecutionCount`、
`items` 和 `nextOffset`。每项保留原执行指派、创建人 ID、resolver revision 和 unresolved。
旧 member 指派及可解析历史创建人只作为有来源、带可用性标志的候选；读取不写入责任。
未知记录保留空候选，历史评论、消息与父链不受影响。

真实 workspace 管理员使用 `POST /api/workspaces/:workspaceId/issue-responsibility-migration/map`，
提交 `{ reason, mappings: [{ issueId, memberId, revision }] }`，返回 `{ mappedIssueIds }`。
每批 1–100 个唯一根单，必须明确选人并解释依据；跨工作区、归档成员、子单或过期 revision
使整批回滚。责任字段、审计和未解决 Q 的移交在同一事务提交；Task/daemon 不可借技术 owner
确认映射。配置执行统筹仍需明确 Agent/团队，映射人类不将历史 member 指派猜成 Agent。

运行 `bun run test tests/unit/multiremi/issue-responsibility-migration.test.ts` 可验证双后端清单
只读、候选来源、显式映射的回滚和重启、真实 HTTP 成员来源、自动化配置及技术 Chat 边界。
真实成员 HTTP 映射同时覆盖原 pending Q 的人类路由、操作人审计和旧卡失效；批量过期版本
使责任字段和 Q 共同保持原状态，成功后仍保留原问题会话及执行轮，重启不另建问题。
通用测试创建用 `createResponsibleTestIssue`；结束用 `acceptTestIssueDelivery` 走实际交付验收，
不覆盖生产 Store 方法，不自动给历史表添加或填充责任。真实生产快照尚需部署迁移前独立复核。

[`responsibility-http-integration.test.ts`](../../tests/unit/remi/responsibility-http-integration.test.ts)
用 Web ApiClient 通过实际鉴权 HTTP 路由验证创建、子单交付/父单验收、根单指定人类验收，
以及自动化、bot/topic 配置和历史显式映射；普通成员映射和过期 revision 都被拒绝。
API 快照脚本对责任与问题流程显式检查预期状态，包括原等待消费、Remi 总结、授权/撤销、
退回和验收，历史夹具使用单独的明确 SQL 构造。这些验证不代替真实浏览器或 PPE 验收。
