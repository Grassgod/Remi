---
title: 统一问题与上交路由
status: active
summary: 原会话中的唯一问题、沿执行负责人链上交、到顶由工作区成员处理、答复版本与 provider 等待和续接消费。
---

# 统一问题

[`Questions`](../../packages/server/src/store/inbox/questions.ts)以原会话的 decision 消息为问题主体，状态保存在 `metadata.question`，不建立第二个问答表。原题在 `human_request.payload.questions`；Remi 总结独立保存，选项不改写。跨会话通知只带 `root_question_id`，`reply_to_id` 仍只允许同会话引用。

新问题只由 provider 的原生 AskUserQuestion 或权限请求进入；CLI 不提供另建业务 Q 的入口。`remi issue responsibility <issue>`读取执行负责人链，`remi message question`操作既有原 Q。普通 `message send --kind decision` 是会话消息选择，不进入上交链；Leader 咨询 Senior 仍用普通协作消息。

[`QuestionView`](../../packages/contracts/src/question.ts)是 Web 与 CLI 的共享投影。`GET /api/issues/:id/questions` 返回待答和历史；`GET /api/messages/:id/question`读取一个原问题。答复、升级、Remi 总结、例外续接及显式关闭使用 `/api/messages/:id/question/{answer,escalate,present,continue,close}`；没有转交动作，旧的 transfer 接口返回410。所有写操作提交 `expected_route_revision`；已答问题只有人工阶段的处理者可以显式 `revise` 人工阶段给出的答案，且必须给原因和 `expected_answer_revision`；是否可修订看答案由谁给出（成员的答案只来自人工阶段），不看当前步骤，Agent 的答案保持原样；历史业务 decision 没有原生等待、答复后不再重新路由，仍按其当前步骤判断，处于人工阶段时成员可以推翻其中负责人 Agent 的答案。正常答复重放不当作改答。原 provider 上下文在 `original_context`；问题在根单之前就进入人工阶段的原因在 `route_reason`，格式为逗号拼接的 `<issueId>:<原因>`，均与 Remi 总结分开。关闭保存原因和完整历史，并取消尚存的原 provider 等待。

## 上交路由

路由从唯一 Issue resolver 读取，原则见 [Issue 执行与上交](issue-responsibility.md)。来自 Issue 的问题依次交给本单执行负责人、各级父单执行负责人和根单执行负责人，之后进入人工阶段；重复负责人和提问者自己被跳过。某一层没有可用执行负责人（未指派、团队无 Leader、Agent 已归档或跨工作区），或父链缺失、循环、跨工作区、Issue 缺失时，不跳级、不猜人，在断点处直接进入人工阶段并记录 `route_reason`。缺少 Leader 不能替换成普通成员。来源 Issue 或会话已被移到其他工作区时 Q 冻结（`source_workspace_changed`），不授予新工作区处理权；内部审计投影显示不可处理原因，HTTP 原 Q 入口返回404，Issue 问题列表隐藏该Q正文和答案历史。

`permission`、`merge` 和 `production_change` 权限请求与普通问题一样先交给执行负责人链。Leader 答复时 `selected_options` 取所选项的 value，即权限请求的 `option_id`，也接受 `{"option_id": ...}`；服务端规范化答复后写入原会话回复，provider 从回复正文读取 `option_id` 恢复原调用，与答复者是成员还是 Agent 无关。Agent 答不了用 `escalate` 交给下一级，越过根单后进入人工阶段。

Issue Q 的人工阶段不指定成员，`current_handler` 为 null：来源工作区任何有效真实成员都可以读取、答复、修订人工阶段给出的答案、关闭和授权续接；Task 凭据、daemon、Runtime 技术 owner 和飞书外部发送人都不算成员。交给 Agent 的阶段对成员只读，成员只能为已答且等待分离的 Issue Q 授权续接，或修订重新路由前在人工阶段给出的成员答案。无 Issue 的普通 Chat 只从明确创建人映射处理成员；飞书 transport Chat 只使用 bot 配置的 `responsibleMemberId`，技术会话创建人不授予答复权，不取工作区 owner。这两种 Chat 的人工阶段保持一个明确成员，没有成员时不可处理。

明确来源和可用性事实形成责任 hash。责任事实或 Chat 配置变更在其事务调用刷新 hook，定位相关会话的待答或待恢复 Q、重新计算路由、增加路由版本、记录 `transfer` 历史并使旧卡失效；密钥或域名更新不改变责任 hash。答复、升级、关闭、呈现、续接和卡片答复在执行前另开事务自动重新路由 `responsibility_revision` 已过期的待答或待恢复 Q，持旧路由版本的客户端得到一次 `409 question_route_changed`，刷新后重试；Web 问题卡会重读该问题，当前成员仍可执行同一操作且答案版本未变时用新路由版本自动重交一次，否则显示「问题已重新路由」一类说明而不是错误码。GET 不写库：旧记录在读取时规范化，人工步骤上残留的成员 handler 按无指定人处理，曾因缺少指定人类而冻结的 Issue Q 补上人工阶段；其中已在人工阶段或冻结的记录以 `human_required` 保持在人工阶段，重新路由不会退回 Agent，仍在 Agent 步骤的旧记录与新记录一样沿执行负责人链路由。历史 `human_request` 与升级过或权限类的历史 `decision_record` 同样读作人工阶段。

列表使用 `limit`（默认100，最多200）、`before`（前页最后 Q 的 id）及 `nextCursor`。SQL只读取目标 Issue 子树会话及这些会话里的同Q通知，责任刷新也只定位受影响子树。已答但等待仍分离的 Q 同样重新路由，保留原答案及恢复原因，只发送待恢复状态通知，不重新向Agent提问；人工阶段的成员可在原执行条件恢复后授权唯一续接。

答复身份必须是当前处理者；Agent 还必须提交属于自己和同一工作区的当前执行轮。Chat 的明确成员只按成员ID或普通Chat创建者userId解析，不按姓名或ID前缀猜测。Question专属HTTP入口允许当前处理者、原提问者、人工阶段可处理的成员和人工阶段的Remi定点读取原Q及提问者提供的必要背景；不授予私有Agent消息、Chat或trace的通用读取权。非处理Agent和跨工作区身份不能借运行宿主的权限读取Q。重新路由增加路由版本并使旧卡凭据失效，不改变原消息冻结收件人。答案和原会话 reply、问题结算以及可靠通知和卡片更新意图同事务保存，实时推送在提交后执行。

## 通知

交给 Agent 的阶段在该层 Issue 的默认会话唤醒执行负责人，通知正文给出原 Q、路由版本、答复格式和升级方式。进入 Issue Q 的人工阶段（创建、升级或重新路由）时，Inbox 提醒根单创建人（如果是有效成员）和来源 Issue 的成员订阅者，每人一条写在来源 Issue 默认会话的 `inbox_only` 通知；零人时不发，历史照记。Chat Q 仍提醒其指定成员。提醒只是通知，不限制谁能处理；续接失败和待恢复提醒发给同一批人。

## 等待与续接

业务问题与 provider 调用分开：超时保留待答 Q，将等待标为 `detached`。授权答复可安排原产品会话、原 execution scope 与原委派血缘的新续接轮，持久冻结旧轮的委派回程并先取消旧轮避免并发。旧provider可能保留未完成工具调用，所以新轮通过既有reset/bootstrap机制冷启动provider，读取原产品会话和同Q答案。短暂WS断线仍使用原nonce及原provider。续接状态先是 `continuation_pending`，由真实输入消费确认后才成为 `continuation_consumed`；完成后仍只回原派活人。原Agent不可用或调度失败时保存合法答案和具体分离原因，并发出待恢复提醒；恢复执行条件后可显式continue，同Q不重复创建消费者。显式取消不自动开新轮。原回调仍活着时，答案回填原调用，daemon 的 `turn.decision.consume` 确认消费后才标 `consumed`。`none` 表示历史 decision 没有原 AUQ；不会补造等待对象。

原生等待有进程内 nonce，随 `hello.runtimes[].active_question_waits` 和 `runtime.ready` 的清单声明。短暂断线保留同一 nonce；新进程没有旧回调清单，服务端在恢复普通孤儿任务前分离该等待并取消旧 attempt 权限。若答案已保存，自动安排唯一新消费者。数据库中的 `running` 或 `awaiting_human` 只用于检查 attempt 仍有效，不能证明退出进程的回调存在；兼容入口没有 nonce 时直接为 `detached/native_wait_unverified`，正常答复走受控续接，不回填不存在的回调。保存答复与实际消费是两个不同状态。

任务终止只取消原 provider 等待：同一事务中重复取消只产生一次提交后的 `HumanRequestEvent.cancelled`，回滚不发通知。该事件表示宿主等待已释放，业务 Q 仍为 `pending/detached`，不能显示为已撤回；只有显式关闭才结束业务 Q。

问题查询和表达式索引使用同一安全字段提取；历史损坏 metadata 不产生 Q 事实，也不妨碍旧日志更新或启动。合法 JSON 的无关字段含 PostgreSQL 不可表示的字符时，只读取所需路径，保留原始文本和正常的 Q 引用。启动按固定名称移除旧无保护索引并幂等安装 v2 索引，不改写历史数据。

公共 `recovery` 投影保留答复消息、续接消息和消费者 Turn 的引用；`consumer_attempt_id`
只在实际消费确认后提供。Web 问题卡保留这些源消息入口，确认消费后可按现有 Task 权限
打开对应执行记录；待续接状态不显示一个虚构的消费 attempt，也不绕过私有 trace 权限。

## 飞书卡片与 Remi 总结

飞书卡和降级文字引用同一个 Q。正常先通知配置的 Remi 读取并总结，再由 `present`解除发卡等待；Remi不可用、自己提问或60秒总结期限到期才允许发原题。Issue Q 的呈现请求同样写在来源 Issue 的默认会话，正文只说明问题已交给工作区成员处理。待呈现意图使用既有飞书持久 outbox operations，在 Remi/bot 忙碌或离线时可重试。卡片收件人：Issue Q 的人工阶段为根单创建人，Chat Q 为其指定成员；收件人必须能唯一映射到 bot 应用的 open_id，映射不明降级到带原 Q、原上下文、原选项及工作台入口的文字，不选择群主。卡片操作人必须解析为来源工作区的一个有效成员，令牌仍绑定收件人 open_id。路由版本随一次性 token 发卡；重新投递或重新路由立即失效旧卡。业务 Q 和卡片没有 provider等待期限，原调用超时不会抹掉问题或令其卡片自动过期。

无 Issue 的 Worker Chat 仍绑定原执行 Agent；Remi 在自己的通知 Chat 接收同 Q 呈现任务，不改变原 Chat 执行归属。只有当前版本通知对应的 Remi 会话与 scope 可定点读原 Q，不能借另一个 Remi 轮读取私有原消息。Chat 交互卡也等待同 Q 总结或明确超时，收件人按指定成员映射，不能继承原消息发送者；映射缺失发送无猜测 @ 的工作台文字，旧路由或失去授权时不发送空卡。

Chat 降级文字的工作台链接打开 Inbox 原 Q 专属定位入口，不要求指定成员拥有原 private Chat 的一般读取权；原题、选项和背景仍由 Question 授权服务读取。

已成功送达的原生 Q 卡片在五十分钟后最多提醒一次；等待超时不取消这次提醒。提醒仍使用当前 Q、当前路由和已验证的收件人映射，令牌更新、提醒槽和出站意图同事务提交，回滚后可以重试。旧历史请求保留其原有截止窗口。已答、已关闭或仅降级文字的 Q 不生成卡片提醒。

## 历史记录与 Web

旧 IssueDecision独立创建、答复、升级和撤回 writer返回410。历史 `decision_record` 和 `human_request` 通过统一投影保留原问题、上下文、答案、原因及历史；没有 native nonce证据的历史 AUQ显示等待分离，历史业务decision为 `none`。读取不迁移数据库；后续答复、修订或关闭在统一写路径落地，不调用旧writer。历史业务问题按原 `source_task_id` 的真实会话、Agent及execution scope回传普通协作通知，同会话答复直接投递原reply；`notify` 历史保留通知来源或不可运行原因。普通回传不改变wait、consumer或continuation事实；派发失败用savepoint隔离，保留合法答案及可读待处理消息。原问题禁止删除或修改正文，关闭必须保留原因和历史。

Web 的 Issue 和 Chat 主线按 `question`、`human_request`、具有上述 Issue 身份的完整
`decision_record` 或明确同 Q 通知的 `root_question_id` 识别原 Q，前后端共用 contracts 判据。
运行中的 AskUserQuestion 仍是新问题的触发源；运行卡片里每个问题只显示一行摘要（状态、标题和
“回答问题”或“查看”按钮），点击后在右侧抽屉答复，不在主线或运行卡片中嵌入完整表单。抽屉、问题卡片及
答复区复用原 Issue Decision 的布局，统一由 [`decision-panel.tsx`](../../frontend/packages/views/common/decision-panel.tsx)
提供；桌面抽屉宽度为720px，小屏幕按可用宽度收缩。Issue 顶部只在本单有人工阶段待答问题时提示，
提示条打开同一抽屉。
旧 IssueDecision 不再创建独立业务问题。
原题和选项只展示一次；展示以原版 `DecisionCard`（`f80b10674`）为准：明确标题、较淡的背景正文、
分隔后的回答区、右下角提交及预留错误提示行。回答记录默认展示为包含回答人与内容的灰底块，
保留每次修订的原因与说明，当前答案不会在历史末尾重复。抽屉按待回答、等待 Agent 回答与已处理问题分组
（提示条打开的 Issue 抽屉把子 issue 的待回答问题单列一节，已处理问题默认折叠，计数与提示条同一口径），
贴视口顶部与右缘、占满视口高度，宽度按上述720px适配。
原生多题、多选及自定义回答适配这套展示结构；普通答题不附加其他输入。
关闭、升级和修订从“更多操作”进入，原因仅在选定操作后填写；路由版本、来源引用和执行详情
收在“历史与详情”中，主界面只显示已答及执行是否继续。原始响应结构继续用于回填 provider。
历史业务记录同样先读取统一投影，按当前处理者和路由版本答复；
不能落回没有路由版本的旧回复表单。权限问题也保留原上下文及截断提示。原问题链接使用
Inbox 的 `?item=<Q>&question=<Q>` 专属定位，只读取 Question API，不扩大原私有消息或 Turn
的权限。历史链接保留真实 `source_message_id`，通过 `question_source` 打开同 Q 的历史，
不把收件通知误定位到子单时间线，也不承诺能读取原来源的全部消息或执行轨迹。

普通消息中的选项选择使用 `message_choice`，仅其指定收件人按普通 reply 作答；这不创建上交链上的 Q。旧的仅含状态的 `decision_record` 仍按原载体答复和拒绝重复提交。只有 `source_issue_id` 或 `issue_id` 为非空字符串的完整历史业务记录才按 Issue Q 读取、分页和鉴权，前后端共用 contracts 判据；读取不改写旧记录。原生 AUQ、`human_request` 和明确的同 Q 通知仍走版本化 Question API。

历史来源回传和不可执行提醒按其 `question_source_notification` 与 `root_question_id` 继承原 Q 的私有来源及两端工作区可见性；HTTP、WebSocket 和 Inbox 计数/分页使用相同关联，原 Q 不可见或引用缺失时不返回提醒正文。跨会话关联不会创建 `reply_to` 或扩大通用来源读取权。

处理和呈现通知也只授予该条消息及其关联答复、编辑记录的定点读取权：引用必须指向当前版本、来源仍在冻结工作区的真实 Q，并且路由里有人工阶段。Issue Q 发给成员的通知（人工阶段提醒、待恢复通知，即不发给 Agent 的那些）可被来源工作区任何有效成员读取；发给 Agent 的通知（各级执行负责人的处理通知、Remi 呈现请求）正文含原问题，只有收件 Agent 的当前执行轮和工作区 owner/admin 可读。Chat Q 的通知只有其指定成员和工作区 owner/admin 可读。Agent 或 Remi 读取时必须是该通知收件人，且使用当前实际执行轮的同一会话与 scope。其他身份不能借公有父会话或编辑历史读取私有原题。HTTP 与 WebSocket 共用只读事实判据，Inbox 在计数和分页前按相同条件过滤；旧通知保留数据库历史，但过期版本或缺失、非 Q 引用不返回正文。异步 WebSocket 查询只使用原有 read pool 允许的读取，不放宽自定义函数或写操作门禁。

初建 Q 的题目、路由和通知在同事务保存，由原消息提交后发布最终完整 entry；初次保存不另外发布相同 revision 的 patch。后续答复和重新路由仍发布真正的新 revision patch，保留 WebSocket 客户端已收到的完整行作为更新基准。

验证入口：[`issue-questions.test.ts`](../../tests/unit/multiremi/issue-questions.test.ts)覆盖 SQLite 和配置的真实 PostgreSQL 上的路由、断点进入人工阶段、成员答复、重复负责人、超时、来源尝试替换和自动重新路由。[`decision-callback-integration.test.ts`](../../tests/unit/daemon/decision-callback-integration.test.ts)使用原生 WS 与 mock provider callback，包含短断线保留 nonce 和真实 SIGKILL 后新进程执行唯一续接、读取上下文并确认消费。在线 provider 或飞书在线行为需要独立端到端验证，不由 mock 用例推断。

[`responsibility-http-integration.test.ts`](../../tests/unit/remi/responsibility-http-integration.test.ts)
使用 Web 的 ApiClient 和真实鉴权 HTTP 路由，验证原私有 Q 的定点读取、原消息和 Turn
继续拒绝读取、答复/修订与原等待消费引用；组件测试验证续接消息入口和消费记录的按需读取。
