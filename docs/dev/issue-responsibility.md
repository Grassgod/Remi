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

创建根单必须传明确 `responsible_member_id`，或由真实人类创建来源承担责任。
HTTP 的创建人来自凭据；Agent 创建新根可继承其真实来源 Issue 的明确人类。
自动化根单从配置的人类创建来源承担；无法取得明确来源时失败，不改用 Runtime owner。
历史根单迁移只新增 nullable 字段，不猜测回填；缺失责任通过 resolver 和关闭拒绝暴露。
更新根人类、父单、执行指派保留 `issue_responsibility_transferred` 审计。

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
重复相同验收幂等；相反动作、已被新交付替代或责任移交后的旧交付被拒绝。

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
| `GET /api/issues/:id/deliveries` | `{ deliveries: IssueDelivery[] }`，包含全部历史 |
| `POST /api/issues/:id/deliveries` | `{ summary, sessionId?, dedupeKey? }`，返回 `{ delivery }` |
| `POST /api/issues/:id/deliveries/:deliveryId/respond` | `{ action: accept\|return, body?, revision }`，返回 `{ delivery, issue }` |
| `POST /api/issues/:id/deliveries/:deliveryId/authorize` | `{ agentId: string\|null, revision }`，null 撤销；返回 `{ delivery }` |

通知与实时投递在事务提交后执行，可靠工作意图保留在统一消息/lane 中；不能把通知已发送
或执行队列为空当作验收完成。实际执行、AUQ 等待恢复以及飞书在线投递需要各自的独立证据。

# 验证入口

运行 `bun run test tests/unit/multiremi/issue-responsibility-deliveries.test.ts`。
SQLite 使用内存库；设置 `MULTIREMI_TEST_POSTGRES_URL` 后每个测试创建独立随机数据库，
运行同一组真实 PostgreSQL 用例并清理自身测试库。未配置 PG 显示 skipped，不计作通过。
这些测试覆盖根人类缺失、Issue 父链、Leader 缺失、验收鉴权、同消息引用、移交失效、
代理授权撤销、退回继续处理及失败回滚；不代表生产历史副本、真实 provider 或飞书在线验收。
