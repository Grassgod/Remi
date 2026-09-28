# MUL-472 返工报告

执行方记录，待严验 QA 复核。六个冷/热场景（共 16 轮）正式 recorder 与目标页固定锚点均为 0px，门控请求 0 违例；热路径总请求 51→50，其中切页部分 23→23。


## 提交与口径

| 项目 | 值 |
| --- | --- |
| 实际合入 main / before | 0c2b386556805321f37badf30dace2a22c11fde6 |
| after 被测代码提交 | 5a79357e6605479f231e62c83cbc4a2428ac9f41 |
| after frontend tree | 581f758591c895e25149bb9302b94ab25a95ae32 |
| PR | https://github.com/Grassgod/Remi/pull/297；标题 MUL-472；保持 Draft |
| recorder SHA-256（before/after 相同） | 9c1f7c91166d104258f23a777f2db38603ff41d40b3ec6d963a2e92128f4c119 |

最终交付 head 及其 CI 链接写在同单交付评论；被测代码提交之后仅增加 reports/performance 产物，frontend tree 必须与上表一致。before 与 after 的 packages/server tree 相同：396dba54f7a79e9e8587baa1c57478dd51d79240。

按带头大哥本轮授权使用仓库现有 jump-recorder.ts、profilesFor、computeRoundMeasurement、computeJumps；没有改 recorder、跳动阈值或 selector profile。六场景为 page-issues、page-inbox、detail-short 的 cold/warm，n=3/2/3，与 58ae8ed0 已留档产物相同。viewport=1440x900，quiet=500ms，首行后窗口=1500ms。list 的既有 profile 是 h1-no-skeleton 且 items 为空，正式结果不能单独证明列表行没动，所以另外记录目标路由固定 Element 的首行位移。

同机、同 SQLite fixture、同 Next dev 参数；先编译三个路由，冷轮使用新 BrowserContext，热轮从入口页真实点击，hover 150ms，入口内容出现后等 2200ms。聊天窗统一最小化。门控接口响应额外延迟 900ms，主体 issues 列表响应额外延迟 300ms，CLI 新版为 999.0.0。真实请求均记录发起时刻，未抓 trace/HAR，未使用 frontend/e2e，未访问 209。


## 31px 原始证据与根因

原探针在点击前开始采样，并在每个 rAF 重新选择首行，混合了入口页与目标页两个不同元素。原始 JSONL 完整保留，未覆盖。issues→inbox 的第 15→16 帧（0 起始）发生锚点身份切换，160→129 的坐标差为 31px；两帧 sidebar-inset 均为 x=256、y=8、width=1176、height=884。它不是同一列表行、侧栏或 reveal 的布局位移。

| 导航 | 帧 | 原始 t(ms) | route | 锚点 id | top(px) |
| --- | --- | --- | --- | --- | --- |
| issues→inbox | 15 | 4418.1 | /local/issues | iss_detail | 160 |
| issues→inbox | 16 | 5721.5 | /local/inbox | inb_probe_2 | 129 |

另一份原始 inbox→issues 采样在 1.5s 结束前仍停留在入口页，记录值为 0；它只作为原始事实保留，不用来证明目标页稳定。交叉验证使用原探针同样的可见性条件，在 pathname 到达目标路由之后只绑定一个真实 Element，后续不再重新选行。下方 16 轮中同一锚点首行后 1.5s、扩展至 3s 都是 0px；3s 同时覆盖延迟数据实际到达后的 UI。

<details><summary>原探针全部逐帧采样（保留 route / key / top / inset）</summary>

```text
{"entry":"inbox","target":"issues","samples":[{"t":5589.100002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5609.400001525879,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5622.400001525879,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5639,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5655.600002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5679,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5689.600002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5705.799999237061,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5722.299999237061,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5738.799999237061,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5755.600002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5772.200000762939,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5788.900001525879,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5805.600002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5822.299999237061,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5839,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5856,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5872.400001525879,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5889.200000762939,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5905.600002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5922.299999237061,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5942,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5958.700000762939,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5975.799999237061,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}}],"transitions":[{"t":5589.100002288818,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}}],"maxShift":0}
{"entry":"issues","target":"inbox","samples":[{"t":4171.899997711182,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4181,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4197.5,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4214.399997711182,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4234.200000762939,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4248.399997711182,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4264.599998474121,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4281.099998474121,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4297.700000762939,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4314.599998474121,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4331.099998474121,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4347.700000762939,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4364.399997711182,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4388.700000762939,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4399.5,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":4418.099998474121,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5721.5,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5723,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5752,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}}],"transitions":[{"t":4171.899997711182,"path":"/local/issues","top":160,"key":"iss_detail","kind":"issue","text":"MUL-4Detail page fixturedetailUnassigned","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}},{"t":5721.5,"path":"/local/inbox","top":129,"key":"inb_probe_2","kind":"inbox","text":"LUSecond probe notificationAssigned1h","inset":{"x":256,"y":8,"width":1176,"height":884,"top":8,"right":1432,"bottom":892,"left":256}}],"maxShift":31}
```
</details>


## gate 定义

页面发布主内容终态后，等待一帧，再等 requestIdleCallback(timeout=1000ms)。列表就绪源与 useListPerfMarker 相同：本次请求成功且非 placeholder，空数据也就绪；失败打开 gate，但不写成功的新数据 marker。详情在 IssueDetailMain 的 timeline 真正 reveal 后发布，外层只发布最终 error/not-found。每次路由访问的 content-ready 单调，后续同页筛选不能把已打开的 gate 关回去。

页面级读取按当前 render 的 pathname 返回 gate，NavigationProvider 的 route context 优先于晚一轮 effect 更新的 lastPath；新路由第一次 render 即 false，滞后的消费者不能驱逐当前路由的 gate。外壳 scope=shell 只在会话首个页面等待，随后常驻 true。注册了 publisher 的慢页面禁用兜底；没有 publisher 的路由从首次观察该路由起等 2000ms，再走相同 idle 步骤。

补掉的早发来源包括 presence/name 子订阅、AssigneePicker 与 prefetch 的 squads、inbox 自己的 summary、详情执行日志 agents；issues 的 archive-count 原来还在显示主体 skeleton，但 marker 已经发布，现同步等待其终态。运行中 agent 筛选是 snapshot 的主体依赖，issues/my-issues/project-detail 与筛选 chip 保持立即查询，snapshot pending 时显示加载态，不显示空列表，也不发布新数据 marker。


## 查询分类（按订阅组件，而非只按 URL）

| 分类 | 查询 | 依据 |
| --- | --- | --- |
| 外壳 | pins；PinRow issue/project 详情 | AppSidebar / PinRow 跨路由常驻；详情跟随 shell gate；useIssueActions 的 pins 读同一外壳缓存 |
| 外壳 | invitations | AppSidebar workspace switcher 常驻，enabled=shellGateOpen |
| 外壳 | cli/latest-version | AppSidebar 的 CLI 更新提示跨路由常驻 |
| 外壳 | inbox/summary（导航 attention 角标） | AppSidebar 常驻 |
| 外壳 | issues?statuses=in_review,blocked&limit=1（workbench 计数） | AppSidebar 常驻，合并计数保持原有逻辑 |
| 外壳 | agents?include_archived；squads；agent-task-snapshot 预取 | WorkspacePresencePrefetch 挂在 layout，切页不卸载；只等会话首 gate |
| 外壳 | ChatFab sessions(all)；pending-task aggregate | 浮动入口跨路由常驻；只等会话首 gate |
| 页面级 | agent-task-snapshot（非运行筛选时） | IssuesPage / MyIssuesPage / ProjectIssuesContent 随页挂载 |
| 页面级 | agent-task-snapshot（行指示与工作中 chip） | IssueAgentActivityIndicator / WorkspaceAgentWorkingChip 随页挂载；chip value=true 例外 |
| 页面级 | agents + snapshot（presence） | useAgentPresence / useAgentPresenceByAgentId 默认等待当前 render 路由 |
| 页面级 | agents + squads（名称/头像） | useActorName / ActorAvatar / AgentStatusDot 随页展示；主体分组标题显式例外 |
| 页面级 | agents + squads（IssuesHeader / AssigneePicker） | 页内筛选与选择器随页挂载 |
| 页面级 | agents（IssueDetail / ExecutionLogSection） | 详情侧信息和日志名称查询随详情挂载 |
| 页面级 | issues/child-progress | BoardView / SwimLaneView / ListView 的页内附属进度；详情 childIssues 主体查询不延后 |
| 页面级 | inbox/summary（inbox 页内 attention） | InboxPage 自身订阅，与常驻导航使用同 key，但生命周期不同 |
| 不门控 | snapshot：running-agent 筛选为 true | 决定 issues/my-issues/project-detail 行集合；pending 必须加载态 |
| 不门控 | snapshot：workbench；runtime/activity 主体 | workbench 用它划分 review 桶；runtime/activity 页本身展示任务状态 |
| 不门控 | agents/squads：页面主体、profile/detail、活动与 runtime/skill 展示 | 这些页面展示对象本身或其主体关联数据；AgentsPage 的 agentList 不能依赖自己的 gate |
| 不门控 | agents/squads：assignee board / swimlane 标题 | 主体分组名字依赖此数据时 useActorName 显式 enabled=true |
| 不门控 | 列表、详情 issue、timeline、childIssues、archive-count、members、runtimes metadata | 主内容及其加载/分组输入；不是外壳附属数据 |
| 按交互 | SearchCommand recents(limit=20) | 面板 open 才取，与路由 gate 独立 |
| 按交互 | ChatWindow sessions/messages/pending-task/context recents/agents | 窗口可见时立即取，最小化关闭；只加 enabled，不重排 chat-window JSX |
| 按交互 | 创建/编辑 modal、hover profile、独立 invitations 页面 | 用户已经打开该主体；不因路由 gate 延后其输入数据 |

相同 query key 可以同时有 shell 与 page 订阅。热切页时 shell 保持 enabled；页面首次 render 仍为 false，但可直接使用缓存，不再因关闭/重开 shell 而多发一次请求。runtimes 预取维持立即查询，不改 WS 或服务端。


## 显式就绪与兜底路由

| 就绪来源 | 路由（workspace 前缀省略） |
| --- | --- |
| useListPerfMarker | /issues、/my-issues、/inbox、/projects、/agents、/runtimes、/skills、/autopilots、/workbench |
| timeline reveal / error / not-found | /issues/[id]；同页嵌入 IssueDetail 时也可发布该页面 |
| 2000ms + idle 兜底 | /repos、/repos/[id]/wiki/[[...path]]、/knowledge、/chat、/usage、/settings |
| 2000ms + idle 兜底 | /plugins、/plugins/[id]、/squads、/squads/[id]、/members/[id] |
| 2000ms + idle 兜底 | /agents/[id]、/runtimes/[id]、/skills/[id]、/autopilots/[id] |
| 2000ms + idle 兜底 | /projects/[id]、/projects/[id]/wiki、/projects/[id]/wiki/[slug]（没有嵌入详情 publisher 时） |

auth、landing、附件预览不挂上述 dashboard 外壳，不列为 shell 兜底路由。/chat 虽已有 perf DOM 属性，但没有接入本次 request-gate publisher，因此仍明确列为兜底。


## 角标本地更新核对

593ff2ba 的 useUpdateIssue.onSettled 失效的是 detail/list/assigneeGroups/myAssigneeGroups/projectGantt/projects 等 key，不包含 workbenchKeys.all。旧角标 key 与 list 是 sibling，旧版本地改状态、WS 尚未到时也不会刷新；上一轮 QueryObserver 探针在 593ff2ba 和返工分支表现一致，源码核对一致。按派单保持这一路径不变，WS 的 workbench invalidate 保持原行为。


## 三页筛选与排序

| 页面/模式 | 操作 | 类型与 marker |
| --- | --- | --- |
| issues 普通 list / status board | scope(all/members/agents)、status、priority、assignee/no-assignee、creator、project/no-project、label、running-agent | 客户端过滤；通常不换 list key，marker 保持；running-agent 尚无 snapshot 时暂停 marker 并显示加载态 |
| issues | sortBy / sortDirection（position 时 direction 不进参数） | 更换 list query key；placeholder 期间 marker 消失，当前响应到达后恢复 |
| issues assignee board | scope、status、priority、assignee、creator、project、label 等 server filter / 分组方式 | assigneeGroups query key 改变；只按当前查询的新数据发布 marker |
| my-issues | scope assigned/created/agents/all；sortBy / sortDirection | 更换 list query key；实测 marker 1→0→1 |
| my-issues 普通 list / status board | status、priority、running-agent | 客户端过滤；marker 保持（snapshot 主体 pending 例外） |
| my-issues assignee board | status、priority、scope 的 server filter | 更换 assigneeGroups query key；placeholder 期间不写 marker |
| inbox | 来源 source；按日期分组；选择通知/详情 | 客户端过滤/展示；不换 inbox page key，marker 1→1 |
| inbox | 排序 | 当前没有暴露更换服务端排序的控件；cursor 翻页属于分页 |

list-perf-marker-query.test.tsx 使用真实 myIssueListOptions、QueryClient、受控六个 status 响应验证 scope 与排序切换，同时验证客户端筛选不额外请求、marker 不消失。不是要求所有客户端筛选都走 keepPreviousData。


## 真实浏览器六场景

| 页 | 轮 | n | 首个可见行 ms（各次） | 第 1 次门控发起 ms（完整参数） | recorder px | 固定行 px | 违例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| issues | cold | 3 | 3165.6 / 2943.6 / 3255.5 | /api/agents?workspace_id=local&include_archived=true @ 4207.9; /api/agent-task-snapshot @ 4210.0; /api/squads @ 4212.0; /api/invitations @ 4214.2; /api/inbox/summary?timezone_offset=-480 @ 4216.2; /api/cli/latest-version @ 4218.1; /api/issues?limit=1&statuses=in_review%2Cblocked @ 4219.9; /api/pins @ 4221.7; /api/issues/child-progress @ 4226.3; PinRow detail @ 5231.7 | 0 | 0 | 0 |
| issues | warm | 3 | 1910.0 / 1879.7 / 1997.6 | /api/issues/child-progress @ 2025.4 | 0 | 0 | 0 |
| inbox | cold | 2 | 2513.0 / 2542.7 | /api/agents?workspace_id=local&include_archived=true @ 2584.0; /api/agent-task-snapshot @ 2586.3; /api/squads @ 2588.3; /api/invitations @ 2591.0; /api/inbox/summary?timezone_offset=-480 @ 2593.2; /api/cli/latest-version @ 2595.2; /api/issues?limit=1&statuses=in_review%2Cblocked @ 2597.3; /api/pins @ 2599.3; PinRow detail @ 3606.8 | 0 | 0 | 0 |
| inbox | warm | 2 | 1480.0 / 1480.1 | 无新门控请求（已有 shell 缓存） | 0 | 0 | 0 |
| detail | cold | 3 | 3354.3 / 3765.7 / 3593.9 | /api/agents?workspace_id=local&include_archived=true @ 3807.9; /api/agent-task-snapshot @ 3809.9; /api/squads @ 3812.0; /api/invitations @ 3814.3; /api/inbox/summary?timezone_offset=-480 @ 3816.3; /api/cli/latest-version @ 3818.2; /api/issues?limit=1&statuses=in_review%2Cblocked @ 3820.3; /api/pins @ 3822.2; PinRow detail @ 4933.7 | 0 | 0 | 0 |
| detail | warm | 3 | 2476.4 / 2652.0 / 2304.9 | 无新门控请求（已有 shell 缓存） | 0 | 0 | 0 |

cold 时间原点是新文档 performance.now；warm 时间原点是实际点击。每一条请求必须严格晚于该目标页首个可见行，不以容忍阈值抹平提前请求。PinRow detail 单独核对，全部晚于首行；同页真正晚于首行的结果不因接口响应额外 900ms 而改变。

| 页/轮/次 | 首行 ms | 锁定锚点 | 采样帧 n | recorder 1.5s px | recorder ready px | 固定行 1.5s px | 固定行 3s px | 门控最早 Δms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| issues/cold/1 | 3165.6 | iss_pin_me | 84 | 0 | 0 | 0 | 0 | 1042.3 |
| issues/cold/2 | 2943.6 | iss_pin_me | 86 | 0 | 0 | 0 | 0 | 1044.4 |
| issues/cold/3 | 3255.5 | iss_pin_me | 83 | 0 | 0 | 0 | 0 | 1048.6 |
| issues/warm/1 | 1910.0 | iss_pin_me | 87 | 0 | 0 | 0 | 0 | 115.4 |
| issues/warm/2 | 1879.7 | iss_pin_me | 86 | 0 | 0 | 0 | 0 | 112.8 |
| issues/warm/3 | 1997.6 | iss_pin_me | 87 | 0 | 0 | 0 | 0 | 98.5 |
| inbox/cold/1 | 2513.0 | inb_probe_2 | 82 | 0 | 0 | 0 | 0 | 71.0 |
| inbox/cold/2 | 2542.7 | inb_probe_2 | 83 | 0 | 0 | 0 | 0 | 67.1 |
| inbox/warm/1 | 1480.0 | inb_probe_2 | 91 | 0 | 0 | 0 | 0 | cache / 无请求 |
| inbox/warm/2 | 1480.1 | inb_probe_2 | 91 | 0 | 0 | 0 | 0 | cache / 无请求 |
| detail/cold/1 | 3354.3 | cmt_yeaknexfuuu8 | 64 | 0 | 0 | 0 | 0 | 453.6 |
| detail/cold/2 | 3765.7 | cmt_yeaknexfuuu8 | 64 | 0 | 0 | 0 | 0 | 450.3 |
| detail/cold/3 | 3593.9 | cmt_yeaknexfuuu8 | 68 | 0 | 0 | 0 | 0 | 403.9 |
| detail/warm/1 | 2476.4 | cmt_yeaknexfuuu8 | 85 | 0 | 0 | 0 | 0 | cache / 无请求 |
| detail/warm/2 | 2652.0 | cmt_yeaknexfuuu8 | 77 | 0 | 0 | 0 | 0 | cache / 无请求 |
| detail/warm/3 | 2304.9 | cmt_yeaknexfuuu8 | 78 | 0 | 0 | 0 | 0 | cache / 无请求 |


## 每条门控请求时序（全部 16 轮）

| 页/轮/次 | 首行 ms | 请求 | 发起 ms | 晚于首行 Δms |
| --- | --- | --- | --- | --- |
| issues/cold/1 | 3165.6 | /api/agents?workspace_id=local&include_archived=true | 4207.9 | 1042.3 |
| issues/cold/1 | 3165.6 | /api/agent-task-snapshot | 4210.0 | 1044.4 |
| issues/cold/1 | 3165.6 | /api/squads | 4212.0 | 1046.4 |
| issues/cold/1 | 3165.6 | /api/invitations | 4214.2 | 1048.6 |
| issues/cold/1 | 3165.6 | /api/inbox/summary?timezone_offset=-480 | 4216.2 | 1050.6 |
| issues/cold/1 | 3165.6 | /api/cli/latest-version | 4218.1 | 1052.5 |
| issues/cold/1 | 3165.6 | /api/issues?limit=1&statuses=in_review%2Cblocked | 4219.9 | 1054.3 |
| issues/cold/1 | 3165.6 | /api/pins | 4221.7 | 1056.1 |
| issues/cold/1 | 3165.6 | /api/issues/child-progress | 4226.3 | 1060.7 |
| issues/cold/1 | 3165.6 | /api/issues/iss_pin_me | 5231.7 | 2066.1 |
| issues/cold/2 | 2943.6 | /api/agents?workspace_id=local&include_archived=true | 3988.0 | 1044.4 |
| issues/cold/2 | 2943.6 | /api/agent-task-snapshot | 3990.2 | 1046.6 |
| issues/cold/2 | 2943.6 | /api/squads | 3992.1 | 1048.5 |
| issues/cold/2 | 2943.6 | /api/invitations | 3994.4 | 1050.8 |
| issues/cold/2 | 2943.6 | /api/inbox/summary?timezone_offset=-480 | 3996.3 | 1052.7 |
| issues/cold/2 | 2943.6 | /api/cli/latest-version | 3998.2 | 1054.6 |
| issues/cold/2 | 2943.6 | /api/issues?limit=1&statuses=in_review%2Cblocked | 4000.0 | 1056.4 |
| issues/cold/2 | 2943.6 | /api/pins | 4002.0 | 1058.4 |
| issues/cold/2 | 2943.6 | /api/issues/child-progress | 4006.7 | 1063.1 |
| issues/cold/2 | 2943.6 | /api/issues/iss_pin_me | 5010.9 | 2067.3 |
| issues/cold/3 | 3255.5 | /api/agents?workspace_id=local&include_archived=true | 4304.1 | 1048.6 |
| issues/cold/3 | 3255.5 | /api/agent-task-snapshot | 4306.1 | 1050.6 |
| issues/cold/3 | 3255.5 | /api/squads | 4308.2 | 1052.7 |
| issues/cold/3 | 3255.5 | /api/invitations | 4310.4 | 1054.9 |
| issues/cold/3 | 3255.5 | /api/inbox/summary?timezone_offset=-480 | 4312.4 | 1056.9 |
| issues/cold/3 | 3255.5 | /api/cli/latest-version | 4314.2 | 1058.7 |
| issues/cold/3 | 3255.5 | /api/issues?limit=1&statuses=in_review%2Cblocked | 4316.0 | 1060.5 |
| issues/cold/3 | 3255.5 | /api/pins | 4317.9 | 1062.4 |
| issues/cold/3 | 3255.5 | /api/issues/child-progress | 4322.5 | 1067.0 |
| issues/cold/3 | 3255.5 | /api/issues/iss_pin_me | 5325.9 | 2070.4 |
| issues/warm/1 | 1910.0 | /api/issues/child-progress | 2025.4 | 115.4 |
| issues/warm/2 | 1879.7 | /api/issues/child-progress | 1992.5 | 112.8 |
| issues/warm/3 | 1997.6 | /api/issues/child-progress | 2096.1 | 98.5 |
| inbox/cold/1 | 2513.0 | /api/agents?workspace_id=local&include_archived=true | 2584.0 | 71.0 |
| inbox/cold/1 | 2513.0 | /api/agent-task-snapshot | 2586.3 | 73.3 |
| inbox/cold/1 | 2513.0 | /api/squads | 2588.3 | 75.3 |
| inbox/cold/1 | 2513.0 | /api/invitations | 2591.0 | 78.0 |
| inbox/cold/1 | 2513.0 | /api/inbox/summary?timezone_offset=-480 | 2593.2 | 80.2 |
| inbox/cold/1 | 2513.0 | /api/cli/latest-version | 2595.2 | 82.2 |
| inbox/cold/1 | 2513.0 | /api/issues?limit=1&statuses=in_review%2Cblocked | 2597.3 | 84.3 |
| inbox/cold/1 | 2513.0 | /api/pins | 2599.3 | 86.3 |
| inbox/cold/1 | 2513.0 | /api/issues/iss_pin_me | 3606.8 | 1093.8 |
| inbox/cold/2 | 2542.7 | /api/agents?workspace_id=local&include_archived=true | 2609.8 | 67.1 |
| inbox/cold/2 | 2542.7 | /api/agent-task-snapshot | 2611.9 | 69.2 |
| inbox/cold/2 | 2542.7 | /api/squads | 2613.8 | 71.1 |
| inbox/cold/2 | 2542.7 | /api/invitations | 2616.6 | 73.9 |
| inbox/cold/2 | 2542.7 | /api/inbox/summary?timezone_offset=-480 | 2618.5 | 75.8 |
| inbox/cold/2 | 2542.7 | /api/cli/latest-version | 2620.4 | 77.7 |
| inbox/cold/2 | 2542.7 | /api/issues?limit=1&statuses=in_review%2Cblocked | 2622.5 | 79.8 |
| inbox/cold/2 | 2542.7 | /api/pins | 2624.4 | 81.7 |
| inbox/cold/2 | 2542.7 | /api/issues/iss_pin_me | 3649.8 | 1107.1 |
| detail/cold/1 | 3354.3 | /api/agents?workspace_id=local&include_archived=true | 3807.9 | 453.6 |
| detail/cold/1 | 3354.3 | /api/agent-task-snapshot | 3809.9 | 455.6 |
| detail/cold/1 | 3354.3 | /api/squads | 3812.0 | 457.7 |
| detail/cold/1 | 3354.3 | /api/invitations | 3814.3 | 460.0 |
| detail/cold/1 | 3354.3 | /api/inbox/summary?timezone_offset=-480 | 3816.3 | 462.0 |
| detail/cold/1 | 3354.3 | /api/cli/latest-version | 3818.2 | 463.9 |
| detail/cold/1 | 3354.3 | /api/issues?limit=1&statuses=in_review%2Cblocked | 3820.3 | 466.0 |
| detail/cold/1 | 3354.3 | /api/pins | 3822.2 | 467.9 |
| detail/cold/1 | 3354.3 | /api/issues/iss_pin_me | 4933.7 | 1579.4 |
| detail/cold/2 | 3765.7 | /api/agents?workspace_id=local&include_archived=true | 4216.0 | 450.3 |
| detail/cold/2 | 3765.7 | /api/agent-task-snapshot | 4218.1 | 452.4 |
| detail/cold/2 | 3765.7 | /api/squads | 4220.1 | 454.4 |
| detail/cold/2 | 3765.7 | /api/invitations | 4222.6 | 456.9 |
| detail/cold/2 | 3765.7 | /api/inbox/summary?timezone_offset=-480 | 4224.5 | 458.8 |
| detail/cold/2 | 3765.7 | /api/cli/latest-version | 4226.3 | 460.6 |
| detail/cold/2 | 3765.7 | /api/issues?limit=1&statuses=in_review%2Cblocked | 4228.4 | 462.7 |
| detail/cold/2 | 3765.7 | /api/pins | 4230.2 | 464.5 |
| detail/cold/2 | 3765.7 | /api/issues/iss_pin_me | 5475.9 | 1710.2 |
| detail/cold/3 | 3593.9 | /api/agents?workspace_id=local&include_archived=true | 3997.8 | 403.9 |
| detail/cold/3 | 3593.9 | /api/agent-task-snapshot | 3999.9 | 406.0 |
| detail/cold/3 | 3593.9 | /api/squads | 4001.8 | 407.9 |
| detail/cold/3 | 3593.9 | /api/invitations | 4004.1 | 410.2 |
| detail/cold/3 | 3593.9 | /api/inbox/summary?timezone_offset=-480 | 4006.1 | 412.2 |
| detail/cold/3 | 3593.9 | /api/cli/latest-version | 4008.0 | 414.1 |
| detail/cold/3 | 3593.9 | /api/issues?limit=1&statuses=in_review%2Cblocked | 4010.1 | 416.2 |
| detail/cold/3 | 3593.9 | /api/pins | 4012.0 | 418.1 |
| detail/cold/3 | 3593.9 | /api/issues/iss_pin_me | 5255.3 | 1661.4 |

pin、邀请点、CLI 点与 workbench=2 在全部 16 个上下文内均出现。额外真实 Chromium 操作打开 workspace switcher 后，Join 与 Decline 均可见且 enabled，未发送接受/拒绝邀请写请求。搜索最近与展开聊天的功能由现有实组件测试断言覆盖。


## 同基线前后请求对比

| 场景 | n | before 首屏 API（各次） | after 首屏 API（各次） | before 总 API（各次） | after 总 API（各次） |
| --- | --- | --- | --- | --- | --- |
| issues/cold | 3 | 27 / 27 / 27 | 16 / 16 / 16 | 28 / 28 / 28 | 27 / 27 / 27 |
| issues/warm | 3 | 9 / 9 / 9 | 8 / 8 / 8 | 9 / 9 / 9 | 9 / 9 / 9 |
| inbox/cold | 2 | 19 / 20 | 9 / 9 | 20 / 20 | 19 / 19 |
| inbox/warm | 2 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| detail/cold | 3 | 37 / 37 / 37 | 26 / 26 / 26 | 37 / 37 / 37 | 36 / 36 / 36 |
| detail/warm | 3 | 16 / 16 / 16 | 16 / 16 / 16 | 16 / 16 / 16 | 16 / 16 / 16 |

| issues → inbox → detail 同一上下文 | before | after |
| --- | --- | --- |
| 初始 issues（含延后到达） | 28 | 27 |
| inbox leg（含打开通知内详情） | 20 | 20 |
| full detail leg | 3 | 3 |
| 热切页部分合计 | 23 | 23 |
| 整条路径合计 | 51 | 50 |

hot path 包括实际 inbox 已读 POST；每次路径测量前在本地 fixture 重置两条通知 read=0，before/after 顺序执行，避免写请求让后一轮状态不同。前后共用服务端 tree，相同接口延迟、窗口和等待参数。冷 inbox before 第 2 次文档加载较慢（首行 10696.8ms），因此多一个 PinRow 详情落入 ready 前，保留 19/20 原值，不抹平异常轮。

| 593ff2ba 历史参考（旧 fixture/旧 gate） | before | 58ae8ed0 after |
| --- | --- | --- |
| issues cold | 27 | 22 |
| inbox cold | 19 | 15 |
| detail-short cold | 36 | 35 |

历史 MUL-472-local-* 产物及上述原数字全部保留；它们不是本轮 main=0c2b3865 的对照组。此次严格等待主体可见后才发附属请求，首屏减少数量变化不通过更换 ready 算法获得。


## 变异与还原

| 变异 | 结果 | 关键失败信息 | 命令 |
| --- | --- | --- | --- |
| 去掉邀请 enabled | exit 1；1 failed / 6 passed | expected undefined to be defined | views: bun run test layout/app-sidebar.test.tsx --reporter=dot |
| 恢复单 boolean pagePassed | exit 1；2 failed / 14 passed | first render '/test/inbox': open true, expected false | core: bun run test platform/use-after-first-screen.test.tsx --reporter=dot |
| 挂载后直接 markRouteContentReady → idle | exit 1；5 failed / 11 passed | queryFn expected 0 calls, received 1; requests ['/test/issues', '/test/inbox'], expected ['/test/issues'] | core: bun run test platform/use-after-first-screen.test.tsx --reporter=dot |
| 去掉 running-agent 筛选例外 | exit 1；1 failed / 0 passed | No issues elements: expected 0, received 6 | views: bun run test issues/components/issues-page.test.tsx -t 'does not show an empty list' --reporter=dot |

四个变异逐项执行，均已还原；git diff 确认 frontend 与被测代码提交一致。还原后 core gate 16/16，相关 views 六文件 44/44 全绿。以下保存原始失败输出。

<details><summary>去掉邀请 enabled</summary>

```text
$ vitest run layout/app-sidebar.test.tsx "--reporter=dot"

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

stderr | layout/app-sidebar.test.tsx > shell gate wiring (MUL-472 b rework) > passes the shell gate's value into the invitation query instead of leaving it always-on
react-i18next:: useTranslation: You will need to pass in an i18next instance by using initReactI18next { code: 'NO_I18NEXT_INSTANCE' }

stderr | layout/app-sidebar.test.tsx > PinRow > renders loaded details
In HTML, <button> cannot be a descendant of <button>.
This will cause a hydration error.

  <AppSidebar>
    <Sidebar variant="inset">
      <SidebarHeader>
      <SidebarContent ref={{current:null}} style={undefined}>
        <SidebarGroup>
        <Collapsible defaultOpen={true}>
          <SidebarGroup className="group/pinned">
            <SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                <DndContext sensors={undefined} collisionDetection={function Mock} onDragStart={function} ...>
                  <SortableContext items={[...]} strategy={function Mock}>
                    <SidebarMenu className="gap-0.5">
                      <PinRow pin={{id:"pin-1", ...}} href="/acme/issu..." pathname="/acme/issues" ...>
                        <SortablePinItem pin={{id:"pin-1", ...}} href="/acme/issu..." pathname="/acme/issues" ...>
                          <SidebarMenuItem ref={function Mock} style={{...}} className="group/pin">
                            <SidebarMenuButton size="sm" isActive={false} render={<AppLink>} onClick={function onClick} ...>
>                             <button type="button" data-active="false" data-href="/acme/issues/issue-1">
                                <StatusIcon>
                                <span>
                                <Tooltip>
                                  <TooltipTrigger render={<span>} className="hidden siz..." onClick={function onClick}>
>                                   <button type="button">
                                  ...
        ...
      ...

<button> cannot contain a nested <button>.
See this log for the ancestor stack trace.

x······

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  layout/app-sidebar.test.tsx > shell gate wiring (MUL-472 b rework) > passes the shell gate's value into the invitation query instead of leaving it always-on
AssertionError: expected undefined to be defined
 ❯ layout/app-sidebar.test.tsx:181:29
    179|     // 865 ms (issues) / 1540 ms (detail) before the first content row.
    180|     for (const query of invitations) {
    181|       expect(query.enabled).toBeDefined();
       |                             ^
    182|       expect(query.enabled).not.toBe(true);
    183|     }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
   Start at  13:58:59
   Duration  2.32s (transform 918ms, setup 68ms, import 1.38s, tests 201ms, environment 545ms)

error: script "test" exited with code 1
```
</details>

<details><summary>恢复单 boolean pagePassed</summary>

```text
$ vitest run platform/use-after-first-screen.test.tsx "--reporter=dot"

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/core

······x·x·······

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  platform/use-after-first-screen.test.tsx > useAfterFirstScreen route identity (MUL-472 b) > uses the render's pathname even while persisted navigation still points at the old route
AssertionError: expected { route: '/test/inbox', open: true } to deeply equal { route: '/test/inbox', open: false }

- Expected
+ Received

  {
-   "open": false,
+   "open": true,
    "route": "/test/inbox",
  }

 ❯ platform/use-after-first-screen.test.tsx:196:24
    194|     renders.length = 0;
    195|     rerender(tree("/test/inbox", false));
    196|     expect(renders[0]).toEqual({ route: "/test/inbox", open: false });
       |                        ^
    197|     await act(async () => { flushIdle(); });
    198|     expect(requests).toEqual(["/test/issues"]);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  platform/use-after-first-screen.test.tsx > useAfterFirstScreen route identity (MUL-472 b) > returns false on the first render of a new route, without waiting for an effect
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ platform/use-after-first-screen.test.tsx:261:58
    259|     // one is the one that gates the new page's queries.
    260|     expect(seen.length).toBeGreaterThan(0);
    261|     expect(seen.every((entry) => entry.value === false)).toBe(true);
       |                                                          ^
    262|     expect(seen[0]).toEqual({ routeKey: "/test/inbox", value: false });
    263|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed | 14 passed (16)
   Start at  13:59:22
   Duration  1.94s (transform 839ms, setup 0ms, import 232ms, tests 1.03s, environment 551ms)

error: script "test" exited with code 1
```
</details>

<details><summary>挂载后直接 markRouteContentReady → idle</summary>

```text
$ vitest run platform/use-after-first-screen.test.tsx "--reporter=dot"

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/core

x···x·x··x·····x

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  platform/use-after-first-screen.test.tsx > useAfterFirstScreen timing (MUL-472 b) > stays closed while the route's content is not ready, however idle the browser is
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/use-after-first-screen.test.tsx:93:28
     91|       flushIdle();
     92|     });
     93|     expect(result.current).toBe(false);
       |                            ^
     94|     expect(idleQueue).toHaveLength(0);
     95|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯

 FAIL  platform/use-after-first-screen.test.tsx > useAfterFirstScreen timing (MUL-472 b) > opens on the fallback timer for a route that never publishes readiness
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/use-after-first-screen.test.tsx:142:28
    140|       vi.advanceTimersByTime(AFTER_FIRST_SCREEN_CONTENT_FALLBACK_MS - …
    141|     });
    142|     expect(result.current).toBe(false);
       |                            ^
    143|
    144|     await act(async () => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/5]⎯

 FAIL  platform/use-after-first-screen.test.tsx > useAfterFirstScreen route identity (MUL-472 b) > uses the render's pathname even while persisted navigation still points at the old route
AssertionError: expected [ '/test/issues', '/test/inbox' ] to deeply equal [ '/test/issues' ]

- Expected
+ Received

  [
    "/test/issues",
+   "/test/inbox",
  ]

 ❯ platform/use-after-first-screen.test.tsx:198:22
    196|     expect(renders[0]).toEqual({ route: "/test/inbox", open: false });
    197|     await act(async () => { flushIdle(); });
    198|     expect(requests).toEqual(["/test/issues"]);
       |                      ^
    199|     rerender(tree("/test/inbox", true));
    200|     await act(async () => { flushIdle(); });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/5]⎯

 FAIL  platform/use-after-first-screen.test.tsx > useAfterFirstScreen route identity (MUL-472 b) > keeps a route closed until that route's own content is ready
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/use-after-first-screen.test.tsx:282:28
    280|       flushIdle();
    281|     });
    282|     expect(result.current).toBe(false);
       |                            ^
    283|
    284|     act(() => {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/5]⎯

 FAIL  platform/use-after-first-screen.test.tsx > gated query factories (MUL-472 b) > a gated query stays quiet until the gate opens, then runs once
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

Received:

  1st vi.fn() call:

    Array [
      Object {
        "client": QueryClient {},
        "meta": undefined,
        "queryKey": Array [
          "gated",
          "/test/issues",
        ],
        "signal": AbortSignal {
          Symbol(kEvents): Map {},
          Symbol(events.maxEventTargetListeners): 0,
          Symbol(events.maxEventTargetListenersWarned): false,
          Symbol(kHandlers): Map {},
          Symbol(kAborted): false,
          Symbol(kReason): undefined,
          Symbol(kComposite): false,
        },
      },
    ]


Number of calls: 1

 ❯ platform/use-after-first-screen.test.tsx:433:25
    431|       flushIdle();
    432|     });
    433|     expect(queryFn).not.toHaveBeenCalled();
       |                         ^
    434|
    435|     rerender(

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/5]⎯


 Test Files  1 failed (1)
      Tests  5 failed | 11 passed (16)
   Start at  13:59:45
   Duration  1.85s (transform 785ms, setup 0ms, import 219ms, tests 964ms, environment 540ms)

error: script "test" exited with code 1
```
</details>

<details><summary>去掉 running-agent 筛选例外</summary>

```text
$ vitest run issues/components/issues-page.test.tsx -t "does not show an empty list" "--reporter=dot"

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

-x-----------

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  issues/components/issues-page.test.tsx > IssuesPage (shared) > does not show an empty list while the running-agent filter is waiting for the snapshot
AssertionError: expected 6 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 6

 ❯ issues/components/issues-page.test.tsx:543:55
    541|     // "No issues". With the snapshot still in flight the page must no…
    542|     // claiming that — the rows it would show depend on the snapshot.
    543|     expect(screen.queryAllByText("No issues").length).toBe(0);
       |                                                       ^
    544|     expect(screen.queryByText("Design landing page")).not.toBeInTheDoc…
    545|     expect(document.querySelector('[data-perf-scroll="list"]')).toBeNu…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 12 skipped (13)
   Start at  14:00:11
   Duration  8.39s (transform 4.15s, setup 68ms, import 7.48s, tests 183ms, environment 539ms)

error: script "test" exited with code 1
```
</details>


## 验证结果

| 命令/范围 | 结果 |
| --- | --- |
| bun run test:frontend | core 116 文件 / 1053 tests；views 228 passed + 1 skipped 文件 / 2416 passed + 18 skipped tests；web 12 文件 / 55 tests；exit 0 |
| bun run typecheck:frontend | ui/core/views/web 全部 exit 0 |
| 改动 frontend 文件 eslint | 0 error，3 条既有 warning（project-detail 依赖、search-command 依赖、workbench 依赖）；新增项目页文件单独复查 exit 0 |
| bun test tests/unit/scripts/perf-jump-recorder.test.ts | 123 pass / 0 fail / 680 assertions |
| bun run docs:check | exit 0 |
| 四变异还原后 gate / 相关页面 | 16 + 44 tests passed |
| git diff --check | exit 0 |
| 报告凭证/连接串模式 rg 自检 | 0 hits；检查命令及最终 CI 记录写在交付评论 |

最终 PR CI 必须同一交付 head 6/6 全绿，frontend-zero-jump attempt=1；具体 run 与 head 见交付评论。PR 保持 Draft，未合入、未转 Ready。已停本轮自起 API/control/两个 Next 进程，未使用整机 pkill。


## 复现入口与原始产物

MUL-472-rework/scripts/fixture.ts 与 MUL-472-rework/scripts/probe.ts 位于 reports/performance 下。使用 Bun 1.3.14；仅使用本地 SQLite 测试库。设置本地 fixture 标识 MUL472_FIXTURE_AUTH；两个 Next dev 进程通过 REMOTE_API_URL=http://127.0.0.1:16840 共用 API。before worktree 在 main 0c2b3865，3520；after 在当前任务分支，3521，均使用 next dev --webpack。probe 不读取或记录真实凭证。先分别运行 before/after（全部六场景），再顺序运行 before path / after path。portable probe 只把临时脚本的绝对路径改为仓库相对路径、从环境取得 fixture 标识并复用 Chromium 路径发现；没有改变测量循环/阈值。

<details><summary>复测命令（进程环境中使用同一 fixture 标识）</summary>

```text
bun reports/performance/MUL-472-rework/scripts/fixture.ts
# before worktree 的 frontend/apps/web 下：
REMOTE_API_URL=http://127.0.0.1:16840 FRONTEND_PORT=3520 bun run dev
# after 工作区的 frontend/apps/web 下：
REMOTE_API_URL=http://127.0.0.1:16840 FRONTEND_PORT=3521 bun run dev
# 任务仓库根目录下，依次执行：
bun reports/performance/MUL-472-rework/scripts/probe.ts before
bun reports/performance/MUL-472-rework/scripts/probe.ts after
bun reports/performance/MUL-472-rework/scripts/probe.ts before path
bun reports/performance/MUL-472-rework/scripts/probe.ts after path
```
</details>

完整 before/after 请求、recorder frames、固定锚点 samples、hot-path clicks 与原始 31px JSONL 均随报告提交。HTML 内嵌以下证据数据，无外部 CSS/JS/font，不依赖 cookie/localStorage 或父框架。
