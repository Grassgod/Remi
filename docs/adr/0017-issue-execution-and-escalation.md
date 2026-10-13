# ADR 0017：Issue 执行与上交

- 状态：已接受。设计与用户逐条确认，替代 PR #404 引入的顶层指定人类、正式交付与验收、问题最终交给指定人类三部分；#404 的其他改动（统一 Q、provider 等待与续接、凭据收紧、创建人来自凭据、执行指派只接受 Agent/团队、Issue 移动）保留。
- 修订：[ADR 0003](0003-parent-status-derived-from-children.md)（决策 1、3、4、6、8、9、10：done 规则、等待答案时的状态、merge 只记录）；[ADR 0011](0011-question-card-one-time-token.md)（Issue 问题人工阶段的卡片收件人）；[ADR 0016](0016-unified-message-inbox-and-turn.md)（决策 7：轮结束从不派生 `done`，intake 正常结束为 `in_review`，等待 Leader 回答时保持 `in_progress`）。
- 编号：顺延 0016。仓库已有两份 0010、0011、0012，引用时需带文档标题。

## 背景

PR #404 给根单增加 `responsible_member_id` 作为顶层指定人类：问题最终交给这个人，关单必须由指定 reviewer 验收一份具体交付。使用中暴露出几个问题：

- 新建根单、自动化和飞书 bot 必须先选人或配置责任人才能建单；
- 缺少指定人类时整条问题链被关闭，连 Leader 都答不了；
- 权限、合并、生产变更类请求直达人类，跳过了本可以处理的 Leader；
- 问题在 Agent 之间流转时 Issue 也被标成 `in_review`，人看到「审核中」却无事可做；
- 关单要先提交交付、取得验收收据，SCM merge 产生 hold，parent-done grant 又与之冲突。

## 决策

1. **去掉顶层指定人类。** 每张 Issue 只有一个责任配置：执行负责人，即指派的 Agent 或指派团队的可用 Leader；resolver 对它的解析不变。`IssueResponsibility` 去掉 `reviewOwner` 和 `rootHuman`，失败原因去掉 `human_missing`、`human_unavailable`，`revision` 只哈希执行负责人链及其可用性。任何入口建单都不要求、也不推断人类。`responsible_member_id` 列和各处可选输入字段保留以兼容旧客户端和测试夹具：接受后忽略，不校验、不落库，也不被路由、授权或展示读取，响应不再返回它。改父单不再需要人类确认。历史责任映射接口退役，设置页删除。
2. **去掉正式交付。** 执行负责人这一轮的最后一条回复就是总结，这一轮结束后 Issue 自动进入 `in_review`。交付 store、路由、contracts 类型、activity 类型、CLI 命令、前端和 daemon 提示词段落全部删除。历史消息里的 `issue_delivery` metadata 留在数据库，按普通消息展示，不迁移。
3. **问题链到顶交给工作区成员。** 来自 Issue 的问题，包括 `permission`、`merge`、`production_change` 权限请求，按本单 → 父单 → … → 根单的执行负责人路由，跳过重复负责人和提问者本人，之后进入人工阶段。某一层没有可用执行负责人，或父链结构异常时，在断点处直接进入人工阶段并记录 `route_reason`，不跳级、不猜人；来源已被移到其他工作区的问题保持冻结。人工阶段不指定成员：来源工作区里任何有效真实成员都可以读取、回答、修订人工阶段给出的答案、关闭和授权续接；能否修订看答案由谁给出，不看重新路由后的当前步骤，Agent 的答案保持原样（历史业务 decision 答复后不再重新路由，仍按当前步骤判断）。Agent 阶段对成员只读。去掉显式 transfer，责任事实变化后自动重新路由；Agent 阶段的「升级到下一级」保留。无 Issue 的 Chat 问题路由不变。
4. **新的 done 规则。** 真实成员可以把任何 Issue 改成 `done`；Agent（Task 凭据）只能把自己作为直接父单执行负责人的子单改成 `done`，不能改自己担任执行负责人的单，也不能改根单。PATCH、兼容入口和 batch 共用这套规则，batch 遇到拒绝整体回滚。规则按写入时的父单判断，是流程约束而不是安全边界：改父单和改派不需要成员确认，同工作区的 Task 凭据先移动、再关单不会被拦截，这些移动以该 Agent 的身份留在 activity 里。子单未完成守卫和只允许成员使用的 `force` 不变。SCM merge 不再关单，也不产生 hold，只记录 `scm_merge_completed` activity。parent-done grant 的写入口退役，数据库列保留。
5. **`in_review` 只表示需要人操作或阅读。** 两种情况派生 `in_review`：执行负责人这一轮正常结束；或本单有问题停在人工阶段，等待成员回答。问题还在等 Leader（Agent）回答时 Issue 保持 `in_progress`；升级到人工阶段的同一事务里切到 `in_review`，人工阶段的父单不受未完成子单守卫约束。有轮在运行时仍以 `in_progress` 为准；回答后原调用恢复运行，回到 `in_progress`。评论唤醒执行负责人后回到 `in_progress`，这一轮结束再回到 `in_review`。

## 实施要点

- **退役接口。** 4 条 deliveries 路由、2 条 `issue-responsibility-migration` 路由、`POST /api/messages/:id/question/transfer`，以及 `/api/issues/:id` 与 `/api/multiremi/issues/:id` 下 parent-done-grant 的 POST/DELETE，登记为 retired，返回 `410 route_retired` 与替代说明；对应 CLI 命令同样登记 retired。旧 daemon 自带的 CLI 和提示词在升级前仍可能调用这些接口，410 加替代说明比 404 更可行动。完整列表见 [CLI 命令契约](../cli-command-migration.md)。
- **读时升级。** 不做数据迁移。revision 格式变化后，存量 Q 的 `responsibility_revision` 全部过期。读取时规范化旧记录但不写库：人工步骤上残留的成员 handler 按无指定人处理，曾因缺少指定人类而冻结的 Issue Q 补上人工阶段；已在人工阶段或冻结的记录保持在人工阶段，仍在 Agent 步骤的旧记录照常沿链路由。answer、escalate、close、present、continue 和卡片答复执行前若发现版本过期，另开事务自动重新路由；持旧路由版本的客户端得到一次 `409 question_route_changed`，刷新后重试；Web 问题卡在当前成员仍可执行同一操作时用新版本自动重交一次，否则显示本地化说明。
- **通知。** 进入人工阶段时，Inbox 提醒根单创建人（如果是有效成员）和来源 Issue 的成员订阅者；飞书卡片发给能唯一映射到 open_id 的根单创建人，否则降级为原问题文字加工作台入口；Remi 总结流程保留。通知只是提醒，不限制谁能处理。原调用回填、续接、`route_revision` 校验、一次性卡片 token 和旧卡失效机制不变。
- **提示条计数。** `pending_decision_count` 只统计本单人工阶段的待答问题，Issue 顶部提示条据此显示；等待 Agent 回答的问题不计入。

## 未采用的方案

- **人工阶段指定一个具体成员（例如根单创建人）。** 创建人可能是 Agent 或自动化，也可能离开工作区，问题又会因为无人可用而卡住；创建人只作为提醒对象。
- **某层缺少执行负责人时跳到更上一级。** 会把问题交给不了解该层情况的负责人，并掩盖配置缺口；直接交给成员并显示原因更容易被发现和修复。
- **parent-done grant 返回自定义的 `parent_done_grant_removed`。** 仓库已有统一的 retired 路由契约，单独造错误码不提供额外信息。
- **数据迁移改写存量 Q 与 Issue。** 读时规范化加自动重新路由足以让旧记录可处理，同时遵守 GET 不写库，也不需要停机迁移。

## 影响

- 建单、自动化和飞书 topic 不再因缺少人类责任人而失败；响应里的 `responsible_member_id` 与 `parent_done_grant*` 字段消失，读取它们的旧客户端需要升级。
- 部署后存量 Q 第一次被处理时自动重新路由；持旧 revision 的客户端会遇到一次 409，旧卡 token 被重置并重新发卡。
- 曾因缺少指定人类而冻结的 Q 显示为人工阶段并保持在人工阶段，不会自动退回 Agent 链。
- 人工阶段的提醒对象可能为零（根单由 Agent 或自动化创建且无订阅者）：问题仍在 Issue 页面提示条与工作台可见，但没有人收到 Inbox 提醒。
- 工作台保持原来的划分：`in_review` 列表按是否有 `awaiting_human` 任务拆成「等待你回复」与「待审核」；等待 Leader 回答的 Issue 是 `in_progress`，不进入这两组，也不计入侧栏 badge。问题因原调用超时而分离、但仍在人工阶段时，Issue 保持 `in_review`，在工作台归入「待审核」。
- 成员不能关闭 Agent 阶段的问题；卡住的 Agent 阶段问题依靠评论、改派或来源 Agent 关闭。
- 删除最终总结信号（A1）与 parent-done grant（A4）后，成员可以在父单执行负责人尚未总结时直接关单，只受未完成子单守卫约束。
- 消息转 Issue 去掉 store 层的人类门槛后，安全边界完全依赖路由层的 `requireHumanApprover`。

实现入口见 [Issue 执行与上交](../dev/issue-responsibility.md) 与 [统一问题](../dev/questions.md)。
