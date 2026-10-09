---
title: 统一问题与责任路由
status: active
summary: 原会话中的唯一问题、责任路由、答复版本与provider等待和续接消费。
---

# 统一问题

[`Questions`](../../packages/server/src/store/inbox/questions.ts)以原会话的 decision 消息为问题主体，状态保存在 `metadata.question`，不建立第二个问答表。原题在 `human_request.payload.questions`；Remi 总结独立保存，选项不改写。跨会话通知只带 `root_question_id`，`reply_to_id` 仍只允许同会话引用。

新责任问题只由 provider 的原生 AskUserQuestion 进入；CLI 不提供另建业务 Q 的入口。`remi issue responsibility <issue>`读取责任归属，`remi message question`操作既有原 Q。普通 `message send --kind decision` 是会话消息选择，不进入责任链；Leader 咨询 Senior 仍用普通协作消息。

[`QuestionView`](../../packages/contracts/src/question.ts)是 Web 与 CLI 的共享投影。`GET /api/issues/:id/questions` 返回待答和历史；`GET /api/messages/:id/question`读取一个原问题。答复、升级、责任移交、Remi 总结、例外续接及显式关闭使用 `/api/messages/:id/question/{answer,escalate,transfer,present,continue,close}`。所有写操作提交 `expected_route_revision`；已答问题只有指定人类可以显式 `revise`，且必须给原因和 `expected_answer_revision`。正常答复重放不当作改答。原 provider 上下文在 `original_context`，责任不可解析原因在 `route_reason`；均与 Remi 总结分开。关闭保存原因和完整历史，并取消尚存的原 provider 等待。

责任从唯一 Issue resolver 读取。Worker 先问本单执行统筹人，再逐级问父单执行统筹人，最后问顶层明确人类。重复负责人和提问者自己被跳过。缺少 Leader 不能替换成普通成员；父链循环、父单缺失或跨工作区链保持不可处理状态。无 Issue 的普通 Chat 只从明确创建人映射人类；飞书 transport Chat 只使用配置的 `responsibleMemberId`，技术会话创建人不授予人类答复权，不取工作区 owner。明确来源和可用性事实形成责任 hash；配置或实体变更在其事务调用 Chat 刷新 hook，定位相关会话的待答或待恢复 Q、记录移交并使旧卡失效，GET 不写迁移。密钥或域名更新不改变责任 hash。权限请求直接交人类，Remi 只总结同一个 Q。

列表使用 `limit`（默认100，最多200）、`before`（前页最后 Q 的 id）及 `nextCursor`。SQL只读取目标 Issue 子树会话及这些会话里的同Q通知，责任刷新也只定位受影响子树。已答但等待仍分离的 Q 同样移交新的明确人类，保留原答案及恢复原因，只发送待恢复状态通知，不重新向Agent提问；新责任人可在原执行条件恢复后授权唯一续接。原来源 Issue 或会话被移到其他工作区时冻结 Q 不授予新工作区处理权；内部审计投影显示不可处理原因，HTTP原Q入口返回404，Issue问题列表隐藏该Q正文和答案历史。没有明确可用顶层人类时整条 Q 授权保持关闭。

答复身份必须是当前处理者；Agent 还必须提交属于自己和同一工作区的当前执行轮。明确人类来源只按成员ID或普通Chat创建者userId解析，不按姓名或ID前缀猜测；permission、merge和production_change授权直接跳过Agent处理者。Question专属HTTP入口允许当前处理者、原提问者、明确人类责任人和人类阶段的Remi定点读取原Q及提问者提供的必要背景；不授予私有Agent消息、Chat或trace的通用读取权。非处理Agent和跨工作区身份不能借运行宿主的权限读取Q。责任变更在同一事务重新路由、记录移交历史、增加路由版本并使旧卡凭据失效，不改变原消息冻结收件人。答案和原会话 reply、问题结算以及可靠通知和卡片更新意图同事务保存，实时推送在提交后执行。

业务问题与 provider 调用分开：超时保留待答 Q，将等待标为 `detached`。授权答复可安排原产品会话、原 execution scope 与原委派血缘的新续接轮，持久冻结旧轮的委派回程并先取消旧轮避免并发。旧provider可能保留未完成工具调用，所以新轮通过既有reset/bootstrap机制冷启动provider，读取原产品会话和同Q答案。短暂WS断线仍使用原nonce及原provider。续接状态先是 `continuation_pending`，由真实输入消费确认后才成为 `continuation_consumed`；完成后仍只回原派活人。原Agent不可用或调度失败时保存合法答案和具体分离原因，并通知指定人类；恢复执行条件后可显式continue，同Q不重复创建消费者。显式取消不自动开新轮。原回调仍活着时，答案回填原调用，daemon 的 `turn.decision.consume` 确认消费后才标 `consumed`。`none` 表示历史 decision 没有原 AUQ；不会补造等待对象。

原生等待有进程内 nonce，随 `hello.runtimes[].active_question_waits` 和 `runtime.ready` 的清单声明。短暂断线保留同一 nonce；新进程没有旧回调清单，服务端在恢复普通孤儿任务前分离该等待并取消旧 attempt 权限。若答案已保存，自动安排唯一新消费者。数据库中的 `running` 或 `awaiting_human` 只用于检查 attempt 仍有效，不能证明退出进程的回调存在；兼容入口没有 nonce 时直接为 `detached/native_wait_unverified`，正常答复走受控续接，不回填不存在的回调。保存答复与实际消费是两个不同状态。

任务终止只取消原 provider 等待：同一事务中重复取消只产生一次提交后的 `HumanRequestEvent.cancelled`，回滚不发通知。该事件表示宿主等待已释放，业务 Q 仍为 `pending/detached`，不能显示为已撤回；只有显式关闭才结束业务 Q。

问题查询和表达式索引使用同一安全字段提取；历史损坏 metadata 不产生 Q 事实，也不妨碍旧日志更新或启动。合法 JSON 的无关字段含 PostgreSQL 不可表示的字符时，只读取所需路径，保留原始文本和正常的 Q 引用。启动按固定名称移除旧无保护索引并幂等安装 v2 索引，不改写历史数据。

公共 `recovery` 投影保留答复消息、续接消息和消费者 Turn 的引用；`consumer_attempt_id`
只在实际消费确认后提供。Web 问题卡保留这些源消息入口，确认消费后可按现有 Task 权限
打开对应执行记录；待续接状态不显示一个虚构的消费 attempt，也不绕过私有 trace 权限。

飞书卡和降级文字引用同一个 Q。正常先通知配置的 Remi 读取并总结，再由 `present`解除发卡等待；Remi不可用、自己提问或60秒总结期限到期才允许发原题。待呈现意图使用既有飞书持久 outbox operations，在 Remi/bot 忙碌或离线时可重试。当前人类必须能唯一映射到 bot 应用的 open_id；映射不明降级到带原 Q、原上下文、原选项及工作台入口的文字，不选择群主。路由版本随一次性 token 发卡；重新投递或移交立即失效旧卡。业务 Q 和卡片没有 provider等待期限，原调用超时不会抹掉问题或令其卡片自动过期。

无 Issue 的 Worker Chat 仍绑定原执行 Agent；Remi 在自己的通知 Chat 接收同 Q 呈现任务，不改变原 Chat 执行归属。只有当前版本通知对应的 Remi 会话与 scope 可定点读原 Q，不能借另一个 Remi 轮读取私有原消息。Chat 交互卡也等待同 Q 总结或明确超时，收件人按指定人类映射，不能继承原消息发送者；映射缺失发送无猜测 @ 的工作台文字，旧路由或失去授权时不发送空卡。

Chat 降级文字的工作台链接打开 Inbox 原 Q 专属定位入口，不要求指定人类拥有原 private Chat 的一般读取权；原题、选项和背景仍由 Question 授权服务读取。

已成功送达的原生 Q 卡片在五十分钟后最多提醒一次；等待超时不取消这次提醒。提醒仍使用当前 Q、当前路由和已验证的指定人类映射，令牌更新、提醒槽和出站意图同事务提交，回滚后可以重试。旧历史请求保留其原有截止窗口。已答、已关闭或仅降级文字的 Q 不生成卡片提醒。

旧 IssueDecision独立创建、答复、升级和撤回 writer返回410。历史 `decision_record` 和 `human_request` 通过统一投影保留原问题、上下文、答案、原因及历史；没有 native nonce证据的历史 AUQ显示等待分离，历史业务decision为 `none`。读取不迁移数据库；后续答复、修订或关闭在统一写路径落地，不调用旧writer。历史业务问题按原 `source_task_id` 的真实会话、Agent及execution scope回传普通协作通知，同会话答复直接投递原reply；`notify` 历史保留通知来源或不可运行原因。普通回传不改变wait、consumer或continuation事实；派发失败用savepoint隔离，保留合法答案及可读待处理消息。原问题禁止删除或修改正文，关闭必须保留原因和历史。

Web 的 Issue 和 Chat 主线按 `question`、`human_request`、具有上述 Issue 身份的完整
`decision_record` 或明确同 Q 通知的 `root_question_id` 识别原 Q，前后端共用 contracts 判据。
历史业务记录同样先读取统一投影，展示当前处理者与版本后答复；
不能落回没有路由版本的旧回复表单。权限问题也保留原上下文及截断提示。原问题链接使用
Inbox 的 `?item=<Q>&question=<Q>` 专属定位，只读取 Question API，不扩大原私有消息或 Turn
的权限。历史链接保留真实 `source_message_id`，通过 `question_source` 打开同 Q 的历史，
不把收件通知误定位到子单时间线，也不承诺能读取原来源的全部消息或执行轨迹。

普通消息中的选项选择使用 `message_choice`，仅其指定收件人按普通 reply 作答；这不创建责任 Q。旧的仅含状态的 `decision_record` 仍按原载体答复和拒绝重复提交。只有 `source_issue_id` 或 `issue_id` 为非空字符串的完整历史业务记录才按责任 Q 读取、分页和鉴权，前后端共用 contracts 判据；读取不改写旧记录。原生 AUQ、`human_request` 和明确的同 Q 通知仍走版本化 Question API。

初建 Q 的题目、路由和通知在同事务保存，由原消息提交后发布最终完整 entry；初次保存不另外发布相同 revision 的 patch。后续答复和移交仍发布真正的新 revision patch，保留 WebSocket 客户端已收到的完整行作为更新基准。

验证入口：[`issue-questions.test.ts`](../../tests/unit/multiremi/issue-questions.test.ts)覆盖 SQLite 和配置的真实 PostgreSQL 上的路由、答复、重复负责人、超时、来源尝试替换和移交。[`decision-callback-integration.test.ts`](../../tests/unit/daemon/decision-callback-integration.test.ts)使用原生 WS 与 mock provider callback，包含短断线保留 nonce 和真实 SIGKILL 后新进程执行唯一续接、读取上下文并确认消费。在线 provider 或飞书在线行为需要独立端到端验证，不由 mock 用例推断。

[`responsibility-http-integration.test.ts`](../../tests/unit/remi/responsibility-http-integration.test.ts)
使用 Web 的 ApiClient 和真实鉴权 HTTP 路由，验证原私有 Q 的定点读取、原消息和 Turn
继续拒绝读取、答复/修订与原等待消费引用；组件测试验证续接消息入口和消费记录的按需读取。
