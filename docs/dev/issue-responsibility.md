---
title: Issue 执行责任与交付
status: active
summary: Agent 按本单及父单 Leader 请示，用户通过原生 AskUserQuestion 回答，无需指定顶层人类。
---

# Issue 执行责任

责任事实来自 Issue 的执行指派和父子关系；普通 Task/Turn 协作不改写这些事实。
[共享类型](../../packages/contracts/src/issue-responsibility.ts)和
[统一 resolver](../../packages/server/src/store/issue-responsibility.ts)保留本单执行统筹和直接父单结果责任。
明确指派 Agent 或小队可用 Leader 才是执行统筹；不使用普通队员、Agent 的第一个团队或 Runtime owner 兜底。
缺少执行统筹、Leader 不可用、父链缺失、循环或跨工作区，保留对应 Agent/结构缺口。

建单、普通状态变更和原生提问无需 `responsible_member_id`。
网页的手动创建、智能创建、自动化和集成配置不提供“顶层指定人类”选择器；
任务详情只展示执行统筹和父单结果责任。
新根单不把创建者、Runtime owner 或自动化创建者写成指定人类。
飞书消息自动建单沿已有来源、权限和话题设置运行，不增加指定人类前提。

# 提问与请示

子 Agent 先请示本单执行统筹；需要上级判断时，逐级请示父单 Leader。
重复负责人和提问者自己跳过。需要用户判断时，问题进入原生 AskUserQuestion 的用户入口。
权限、合并及生产变更授权直接进入用户阶段，Agent 不得代答批准。
`stage: human`、`current_handler: null` 表示等待用户通过原问题入口回答，不表示责任配置缺失。

用户必须是实际工作区成员，并符合原问题的来源权限；私有 Agent、Chat 创建者和跨工作区边界仍有效。
Agent 只能在当前通知对应的真实执行会话与 scope 处理问题，不借宿主 token owner 的人类权限。
答复保留原 Q、路由版本和原 provider 等待；答案回原会话，重启及超时恢复沿既有唯一续接流程。
可选 Remi 总结和飞书通知引用同一个问题；通知偏好决定运输收件目标，不赋予 Issue 人类责任或额外答复权。
完整提问契约见[统一问题](questions.md)。

升级前缺少指定人类而被阻塞的 Issue Q，在读取投影中按 Agent 链和原生用户入口解析。
保留原消息 ID、答案、历史、路由版本和 provider wait；读取不改库，后续正常操作保存新投影。

# 交付与关闭

[交付服务](../../packages/server/src/store/issue-deliveries.ts)保留可选的消息交付、验收和退回。
子单的正式交付由执行统筹提交、直接父单统筹验收，仍核对责任版本、具体交付和未完成子单。
没有历史人类验收记录的根单由自身执行统筹处理可选交付，不需要指定人类。

普通 PATCH、批量更新和 SCM 合并关闭恢复既有父子状态、依赖及授权守卫，
不强制每张 Issue 先产生人类验收收据。只有交付验收入口传入服务端收据时，才核对该具体收据。
`force` 仍按已有成员权限限制，未完成子单及依赖检查不因移除人类配置而绕过。
父单状态规则见[ADR 0003](../adr/0003-parent-status-derived-from-children.md)。

已有 `responsible_member_id`、`rootHuman` 投影、交付与单次代理授权数据保留，供旧客户端及历史收据兼容。
它们不作为原生 Issue 提问的接收人，也不是新建、普通完成或交付的必填前提。
历史映射和代理授权接口保留一个兼容周期；新网页不展示其配置入口，CLI 将相关参数说明为兼容字段。
不做删除历史字段、猜测填人或全库重写的迁移。

# 验证入口

`bun run test tests/unit/multiremi/native-user-without-designation.test.ts` 验证无需指定人类建单、
Agent 逐级请示、原生答复和实际消费、私有来源及工作区边界、旧阻塞 Q 的只读投影兼容和普通关闭。
SQLite 使用内存库；配置 `MULTIREMI_TEST_POSTGRES_URL` 后运行独立临时 PostgreSQL 数据库，
未配置的 PostgreSQL 用例标为 skipped，不计作通过。

交付兼容验证使用
`bun run test tests/unit/multiremi/issue-responsibility-deliveries.test.ts`；
提问与通知权限验证使用
`bun run test tests/unit/multiremi/issue-questions.test.ts tests/unit/multiremi/question-notification-access.test.ts`。
网页验证入口为创建表单和执行责任侧栏的组件测试。
这些入口不代表已完成真实 provider、飞书在线或生产发布验证。
