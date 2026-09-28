# MUL-472 第四轮返工

仅修第四轮 B1 与同类隐藏 observer。实际 main / before=b95dd2fa5e301588ba1e04aa9bacc370240d664c；merge=0c727a2a8e0808b727a5612f346c9eb6ba90bc00，无冲突。产品/测试提交=e64794a16ddc2170196b1349ae30fcb20197ea6c；frontend tree=eee7aa4a52f29cce83958dc9147e83e365b486e6。最终报告提交 head 和该 SHA 的 CI 6/6 核对记录随交付评论列出，PR #297 保持 Draft。

## B1

隐藏 ChatWindow 仍挂载缓存消息，任务 id 合法就会使 observer active；462 的合法 degraded header invalidate 因而触发 refetch。ChatMessageList 的 live 和 AssistantMessage 两处改为 visible && 原条件，ChatWindow 传实际 chatVisible。隐藏仅 stale，重开立即读取 stale，打开时 header 正常 refetch。没有使用 visible || shellGateOpen；角标/完成状态由已门控的 aggregate pending 和 WS 缓存更新承担，不依赖隐藏的 transcript 查询。

按 key 审计另补 HumanRequestDock 的 enabled=chatVisible（详情默认 true），以及隐藏虚拟列表 startReached 的 visible 条件，避免命令式 fetchNextPage 绕过 enabled。成员/项目候选同 key 的必要权限、主体读取明确列为不门控。未改 gate registry、aggregate pending、462 实现、服务端、正式 recorder 或阈值。

## 按 key 扫描与来源

不是 factory 白名单：TypeScript checker 解析全仓 runtime 调用的 queryKey tuple、别名、spread、useQueries map、命令式调用。19 个相关 key 家族的全部 observer 列在下表；所有 379 个查询操作及 414 个 invalidate/refetchQueries 操作（包括范围外的 key）也完整保存在 JSON，解析遗漏=0。170 处相关来源均为 invalidateQueries 默认 active；没有 refetchQueries 或 refetchType=all 调用。enabled=false 的隐藏 observer 不 active，只置 stale；必要主体和已打开交互例外逐项列出，不对其施加附属 gate。

| key | tuple | observer | invalidate | 分类依据 |
| --- | --- | --- | --- | --- |
| agents | ["workspaces","*","agents"] | 32 | 32 | 壳层 presence 等首次 gate；页面附属每次 gate；筛选/分组主体、聊天打开不延后。 |
| squads | ["workspaces","*","squads"] | 9 | 20 | presence/姓名/头像/选择器的附属列表等 gate；squad 主体与已打开交互保留立即读取。 |
| snapshot | ["workspaces","*","agent-task-snapshot","list"] | 13 | 17 | presence/行指示等 gate；agentRunningFilter 输入立即读取，pending 保持加载。 |
| pins | ["pins","*","*","list"] | 3 | 3 | AppSidebar 会话 gate；IssueActions / ProjectDetail 附属各自 gate。 |
| invitations | ["invitations","mine"] | 2 | 9 | AppSidebar 会话 gate；InvitationsPage 的邀请主体立即读取。 |
| cli | ["runtimes","latestVersion"] | 3 | 2 | 侧栏提示会话 gate；运行环境的显式升级/主体不延后。 |
| summary | ["inbox","*","summary"] | 2 | 6 | 导航会话 gate；Inbox attention 等本页 gate；未挂载桌面 badge 也列出。 |
| workbench | ["issues","*","workbench","pending-count"] | 1 | 24 | 侧栏合并 count 会话 gate；主看板状态列表是另一个 key。 |
| childProgress | ["issues","*","child-progress"] | 4 | 29 | 附属完成度等页面 gate；详情子任务主体独立 key，不延后。 |
| issueDetail | ["issues","*","detail","*"] | 14 | 31 | PinRow 会话 gate；搜索/聊天 recents 仅打开；当前详情、用户打开父单选择器不延后。 |
| projectDetail | ["projects","*","detail","*"] | 7 | 14 | PinRow 会话 gate；聊天 recents 仅打开；当前项目主体不延后。 |
| sessions | ["chat","*","sessions"] | 2 | 11 | ChatFab 会话 gate；ChatWindow 可见后立即订阅。 |
| aggregatePending | ["chat","*","pending-tasks"] | 2 | 10 | ChatFab 会话 gate；SessionDropdown 为 chatVisible \|\| shellGateOpen。 |
| messagesPage | ["chat","messages-page","*"] | 1 | 7 | ChatWindow 可见；隐藏 startReached 不调用 fetchNextPage；重试来自用户操作。 |
| pendingTask | ["chat","pending-task","*"] | 1 | 9 | ChatWindow 可见；缓存存在不代表 observer active。 |
| taskMessages | ["task-messages","*"] | 4 | 1 | 两个聊天消息 observer 只在 visible；详情 SessionAgentStreamRow 主体与打开的 TranscriptButton 不等首屏 gate。 |
| humanRequests | ["task-human-requests","*"] | 1 | 3 | 聊天表单只在 chatVisible；详情 AgentLiveCard 默认 enabled 保持。 |
| members | ["workspaces","*","members"] | 45 | 16 | 聊天提及候选只在 chatVisible；同 key 的权限/成员主体 observer 保持原条件。 |
| projectList | ["projects","*","list"] | 22 | 15 | 聊天提及候选只在 chatVisible；同 key 的项目主体/分组输入 observer 保持原条件。 |

完整 167 observer、170 invalidate、11 显式 refetch 与 379 查询操作 inventory 见 HTML / key-audit.json，逐项保留原表达式、位置、enabled 条件和依据。

| 位置 | 额外来源 | 依据 |
| --- | --- | --- |
| realtime/sync/prefix-refresh.ts:30 | predicate invalidateSquadMemberStatusQueries | 只匹配 squads/.../members-status；不匹配被延后的 squads 静态 list key。 |
| issues/components/agent-live-card.tsx | api.listTaskMessages | 详情主体 hydration；可见任务执行数据不门控，无隐藏 ChatWindow 调用。 |
| runtimes/components/machine-cli-update.tsx | api.getLatestCliVersion | 运行环境升级主体；模块缓存，不是冷首屏侧栏提示 observer。 |
| auth callback / login | api.listMyInvitations | 认证/加入工作区主体流程，不是隐藏壳层。 |
| chatKeys.messages legacy | 全仓 key inventory | 没有 runtime observer；实际窗口用 messagesPage，不因旧 factory 名漏算。 |

## 守卫与变异

真实 DashboardLayout + ChatFab + ChatWindow（仅隔离 WS 传输），给 17 组附属 key 全部预置缓存，包括 messagesPage/pendingTask、PinRow details、聊天 recents、任务消息和人工请求。逐 key invalidate，再经真实 createTaskHandlers 发送合法 degraded header：gate 前 QueryCache fetch 事件=0。gate 后壳层请求正常，隐藏消息/表单仍 inactive；打开后立即取 stale。两个 QA 原负控收进正式文件；另有 live/assistant 独立用例、隐藏分页回调以及详情 degraded-header 正控。

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

 ❯ chat/components/chat-message-list.test.tsx (10 tests | 2 failed) 152ms
     × keeps the live observer inactive while hidden and refetches stale data on reopen 24ms
     × keeps the assistant observer inactive while hidden and refetches stale data on reopen 21ms
stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
12:17:35.350 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
12:17:35.351 [chat.store] setActiveSession { from: null, to: 'cs_qa_refetch' }
12:17:35.351 [chat.store] setOpen { from: false, to: true }
12:17:35.465 [chat.ui] ChatWindow mount {
  isOpen: true,
  activeSessionId: 'cs_qa_refetch',
  pendingTaskId: 'tsk_qa_refetch',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
12:17:35.541 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
12:17:35.558 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_qa_refetch', pendingTaskId: 'tsk_qa_refetch' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
12:17:35.565 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
12:17:35.565 [chat.store] setActiveSession { from: null, to: 'cs_qa_hidden' }
12:17:35.608 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: 'cs_qa_hidden',
  pendingTaskId: 'tsk_qa_hidden',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
12:17:35.653 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_qa_hidden', pendingTaskId: 'tsk_qa_hidden' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
12:17:35.797 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
12:17:35.799 [chat.store] setActiveSession { from: null, to: 'cs_guard_cached' }
12:17:35.942 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: 'cs_guard_cached',
  pendingTaskId: 'tsk_guard_live',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
12:17:35.969 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_guard_cached', pendingTaskId: 'tsk_guard_live' }

 ❯ layout/shell-deferred-queries.test.tsx (6 tests | 3 failed) 746ms
     × QA: a failed-reference header refetches an open chat but not a hidden cached chat 214ms
     × QA: an initially hidden cached chat does not refetch before page readiness 90ms
     × keeps cached deferred keys quiet on invalidation, including a real degraded header 174ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ layout/shell-deferred-queries.test.tsx:262:100
    260|       await act(async () => {});
    261|       listTaskMessages.mockClear();
    262|       expect(client.getQueryCache().find({ queryKey: chatKeys.taskMess…
       |                                                                                                    ^
    263|       await act(async () => { sync.handlers["task:message"]?.({ task_i…
    264|       expect(listTaskMessages).not.toHaveBeenCalled();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
AssertionError: expected "listTaskMessages" to not be called at all, but actually been called 1 times

Received:

  1st listTaskMessages call:

    Array [
      "tsk_qa_hidden",
    ]


Number of calls: 1

 ❯ layout/shell-deferred-queries.test.tsx:293:36
    291|       expect(useChatStore.getState().isOpen).toBe(false);
    292|       await act(async () => { sync.handlers["task:message"]?.({ task_i…
    293|       expect(listTaskMessages).not.toHaveBeenCalled();
       |                                    ^
    294|     } finally {
    295|       view.unmount(); sync.dispose?.(); client.clear();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/5]⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
AssertionError: expected [ [ 'task-messages', …(1) ], …(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   [
+     "task-messages",
+     "tsk_guard_live",
+   ],
+   [
+     "task-messages",
+     "tsk_guard_live",
+   ],
+ ]

 ❯ layout/shell-deferred-queries.test.tsx:369:27
    367|         sync.handlers["task:message"]?.({ task_id: taskId, degraded: t…
    368|       });
    369|       expect(startedKeys).toEqual([]);
       |                           ^
    370|       expect(listTaskMessages).not.toHaveBeenCalled();
    371|       expect(listTaskHumanRequests).not.toHaveBeenCalled();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/5]⎯

 FAIL  chat/components/chat-message-list.test.tsx > cached message observer visibility > keeps the live observer inactive while hidden and refetches stale data on reopen
 FAIL  chat/components/chat-message-list.test.tsx > cached message observer visibility > keeps the assistant observer inactive while hidden and refetches stale data on reopen
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

Received:

  1st vi.fn() call:

    Array [
      "tsk_visibility",
    ]


Number of calls: 1

 ❯ chat/components/chat-message-list.test.tsx:82:36
     80|     try {
     81|       await act(async () => { sync.handlers["task:message"]?.({ task_i…
     82|       expect(listTaskMessages).not.toHaveBeenCalled();
       |                                    ^
     83|       expect(client.getQueryCache().find({ queryKey: chatKeys.taskMess…
     84|       view.rerender(content(true));

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/5]⎯


 Test Files  2 failed (2)
      Tests  5 failed | 11 passed (16)
   Start at  20:17:27
   Duration  8.66s (transform 5.00s, setup 140ms, import 9.41s, tests 898ms, environment 1.12s)


```

## 时序与位移

同机 Chromium 146 / 1440×900，隔离内存 SQLite，before/after 均使用 main b95dd2fa 的服务端和正式 recorder；附属响应延迟 900ms，主体列表 300ms。冷新 context；热真实 click、核对目标路由后固定原 Element。issues/detail 各 n=3 冷+3热，inbox n=2 冷+2热；MUL-454 210 条合成正文取自 QA 附件，仅重新放入本地 fixture，冷/热各 n=1。正式 ready/500ms quiet、1.5s recorder 及固定 Element 3s 交叉验证均保留。before detail cold r1 编译/机器负载 13120.1ms 原始值留档，不当 p75。未访问 209、未跑 frontend/e2e、未抓 trace/HAR。

| 场景 | n | 首行 ms | 请求首行后 ms | recorder / 固定元素 px | 违例 |
| --- | --- | --- | --- | --- | --- |
| issues 冷 | 3 | 3103.3 / 2838.6 / 2847.2 | 1049.5 .. 2153.3 | 0 / 0 | 0 |
| issues 热 | 3 | 1903.3 / 1848.4 / 1754.4 | 124.3 .. 125.2 | 0 / 0 | 0 |
| inbox 冷 | 2 | 2445.5 / 2700.5 | 69.3 .. 1114.6 | 0 / 0 | 0 |
| inbox 热 | 2 | 1449.6 / 1378.4 | 无新请求（缓存） | 0 / 0 | 0 |
| detail 冷 | 3 | 3276.1 / 3409.4 / 3282.0 | 262.4 .. 1641.2 | 0 / 0 | 0 |
| detail 热 | 3 | 2329.9 / 2124.6 / 2359.7 | 无新请求（缓存） | 0 / 0 | 0 |
| MUL-454 冷 | 1 | 4108.2 | 484.9 .. 1645.1 | 0 / 0 | 0 |
| MUL-454 热 | 1 | 2876.3 | 无新请求（缓存） | 0 / 0 | 0 |

### issues 冷

首行 3103.3 / 2838.6 / 2847.2ms；锚点 iss_pin_me。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 4152.8 (+1049.5) | 3897.1 (+1058.5) | 3921.4 (+1074.2) |
| /api/agent-task-snapshot | 4155.1 (+1051.8) | 3899.2 (+1060.6) | 3923.5 (+1076.3) |
| /api/squads | 4157.1 (+1053.8) | 3901.2 (+1062.6) | 3925.4 (+1078.2) |
| /api/invitations | 4159.6 (+1056.3) | 3903.5 (+1064.9) | 3927.6 (+1080.4) |
| /api/inbox/summary?timezone_offset=-480 | 4161.5 (+1058.2) | 3905.9 (+1067.3) | 3929.5 (+1082.3) |
| /api/cli/latest-version | 4163.5 (+1060.2) | 3907.8 (+1069.2) | 3931.3 (+1084.1) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 4165.5 (+1062.2) | 3909.7 (+1071.1) | 3933.1 (+1085.9) |
| /api/pins | 4167.7 (+1064.4) | 3911.6 (+1073.0) | 3934.9 (+1087.7) |
| /api/issues/child-progress | 4172.9 (+1069.6) | 3916.6 (+1078.0) | 3939.9 (+1092.7) |
| /api/chat/pending-tasks | 4175.5 (+1072.2) | 3918.8 (+1080.2) | 3942.1 (+1094.9) |
| /api/chat/sessions?status=all | 4178.3 (+1075.0) | 3921.9 (+1083.3) | 3944.8 (+1097.6) |
| /api/issues/iss_pin_me | 5229.1 (+2125.8) | 4950.6 (+2112.0) | 5000.5 (+2153.3) |

### issues 热

首行 1903.3 / 1848.4 / 1754.4ms；锚点 iss_pin_me。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/issues/child-progress | 2028.1 (+124.8) | 1972.7 (+124.3) | 1879.6 (+125.2) |

### inbox 冷

首行 2445.5 / 2700.5ms；锚点 inb_probe_2。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） |
| --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 2514.8 (+69.3) | 2770.3 (+69.8) |
| /api/agent-task-snapshot | 2517.5 (+72.0) | 2772.8 (+72.3) |
| /api/squads | 2519.9 (+74.4) | 2775.2 (+74.7) |
| /api/invitations | 2523.0 (+77.5) | 2778.1 (+77.6) |
| /api/inbox/summary?timezone_offset=-480 | 2525.5 (+80.0) | 2780.5 (+80.0) |
| /api/cli/latest-version | 2527.8 (+82.3) | 2782.9 (+82.4) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 2530.4 (+84.9) | 2785.4 (+84.9) |
| /api/pins | 2532.7 (+87.2) | 2787.7 (+87.2) |
| /api/chat/pending-tasks | 2536.0 (+90.5) | 2791.0 (+90.5) |
| /api/chat/sessions?status=all | 2539.2 (+93.7) | 2794.3 (+93.8) |
| /api/issues/iss_pin_me | 3560.1 (+1114.6) | 3791.7 (+1091.2) |

### inbox 热

首行 1449.6 / 1378.4ms；锚点 inb_probe_2。

无新门控请求（缓存）。

### detail 冷

首行 3276.1 / 3409.4 / 3282.0ms；锚点 cmt_fqvm9ako4ept。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 3771.2 (+495.1) | 3671.8 (+262.4) | 3758.1 (+476.1) |
| /api/agent-task-snapshot | 3773.3 (+497.2) | 3673.9 (+264.5) | 3760.2 (+478.2) |
| /api/squads | 3775.2 (+499.1) | 3675.8 (+266.4) | 3762.1 (+480.1) |
| /api/invitations | 3777.7 (+501.6) | 3678.1 (+268.7) | 3764.5 (+482.5) |
| /api/inbox/summary?timezone_offset=-480 | 3779.6 (+503.5) | 3680.0 (+270.6) | 3766.3 (+484.3) |
| /api/cli/latest-version | 3781.5 (+505.4) | 3682.0 (+272.6) | 3768.3 (+486.3) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 3783.5 (+507.4) | 3684.1 (+274.7) | 3770.3 (+488.3) |
| /api/pins | 3785.4 (+509.3) | 3685.9 (+276.5) | 3772.3 (+490.3) |
| /api/chat/pending-tasks | 3793.0 (+516.9) | 3693.3 (+283.9) | 3779.7 (+497.7) |
| /api/chat/sessions?status=all | 3795.9 (+519.8) | 3696.1 (+286.7) | 3782.8 (+500.8) |
| /api/issues/iss_pin_me | 4917.3 (+1641.2) | 4928.4 (+1519.0) | 4903.7 (+1621.7) |

### detail 热

首行 2329.9 / 2124.6 / 2359.7ms；锚点 cmt_fqvm9ako4ept。

无新门控请求（缓存）。

### MUL-454 冷

首行 4108.2ms；锚点 cmt_hovywyyvgeen。

| 被门控请求 | r1 发起 ms（首行后 ms） |
| --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 4593.1 (+484.9) |
| /api/agent-task-snapshot | 4595.3 (+487.1) |
| /api/squads | 4597.4 (+489.2) |
| /api/invitations | 4599.8 (+491.6) |
| /api/inbox/summary?timezone_offset=-480 | 4601.9 (+493.7) |
| /api/cli/latest-version | 4603.8 (+495.6) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 4606.0 (+497.8) |
| /api/pins | 4608.1 (+499.9) |
| /api/chat/pending-tasks | 4616.7 (+508.5) |
| /api/chat/sessions?status=all | 4619.5 (+511.3) |
| /api/issues/iss_pin_me | 5753.3 (+1645.1) |

### MUL-454 热

首行 2876.3ms；锚点 cmt_hovywyyvgeen。

无新门控请求（缓存）。

## 主动打开聊天

点击 2504.2ms，主列表未出现，gate 未开。

| 请求 | 发起 ms | 点击后 ms |
| --- | --- | --- |
| /api/chat/pending-tasks | 2566.2 | 62.0 |
| /api/chat/sessions?status=all | 2575.1 | 70.9 |
| /api/chat/sessions/cs_fixture/messages/page?limit=50 | 2578.0 | 73.8 |
| /api/chat/sessions/cs_fixture/pending-task | 2580.5 | 76.3 |
| /api/tasks/tsk_chat_fixture/messages | 2696.7 | 192.5 |
| /api/tasks/tsk_chat_fixture/human-requests | 2698.8 | 194.6 |

## 同 main 对比

新 fixture 的完整链路（含冷进入 issues）56→53：初入 29→27，热 inbox 23→22，热 detail 4→4。纯热两段 27→26。旧报告 51→50 是完整链路，23→23 才是纯热；第三轮 53→52 / 25→25 是旧 fixture 参考，均不充当本轮 b95dd2fa 基线。593ff2ba 原首屏 27→22 / 19→15 / 36→35 保留为历史参考。新增非空聊天任务会触发 aggregate pending 轮询，本轮逐请求原样保留，不混用观察窗。

| 场景 | 首屏 before | 首屏 after | 观察窗 before | 观察窗 after |
| --- | --- | --- | --- | --- |
| issues cold | 27 / 27 / 27 | 15 / 15 / 15 | 29 / 29 / 29 | 27 / 27 / 27 |
| issues warm | 10 / 10 / 10 | 8 / 8 / 8 | 11 / 11 / 11 | 9 / 9 / 9 |
| inbox cold | 19 / 19 | 8 / 8 | 20 / 20 | 19 / 19 |
| inbox warm | 2 / 2 | 1 / 1 | 3 / 2 | 1 / 1 |
| detail cold | 39 / 39 / 39 | 27 / 27 / 27 | 40 / 40 / 40 | 38 / 38 / 38 |
| detail warm | 19 / 19 / 19 | 18 / 18 / 18 | 20 / 20 / 20 | 18 / 18 / 18 |

## 回归

| 检查 | 结果 |
| --- | --- |
| env -u MULTIREMI_TOKEN bunx tsc --noEmit | exit 0 |
| env -u MULTIREMI_TOKEN bun run typecheck:frontend | ui/core/views/web exit 0 |
| env -u MULTIREMI_TOKEN bun run test:frontend --testTimeout 20000 | core 1087 + views 2459 + web 55 = 3601 pass；18 existing skip；0 fail |
| core gate / QA unmount / realtime tasks，--testTimeout 20000 | 26 pass；原 22 个 gate 用例全部通过 |
| views shell / message-list / human-request-dock / issue stream，--testTimeout 20000 | 36 pass；含两个 QA 负控、打开聊天正控、详情主体正控和分页守卫 |
| env -u MULTIREMI_TOKEN bun test tests/arch/ tests/unit/scripts/perf-jump-recorder.test.ts --timeout 20000 | 231 pass / 0 fail = 108 arch + 123 recorder |
| npm run docs:check；npm run docs:test | exit 0；13 pass |
| 修改的前端文件 eslint | 0 error / 0 warning |
| 按 key audit.ts | 379 个查询操作；167 个匹配 observer；170 个 invalidate 来源；0 unresolved |
| 真实 Chromium 六场景 + 210 评论长样本 | 18 轮 recorder / 固定 Element 1.5s、3s 均 0px；0 提前请求 |
| HTML desktop / mobile / sandbox 预览 | 167 行筛选正常；无横向溢出或脚本错误；原始数据下载含 16+2 轮 |
| 报告脚本 eslint；凭证和连接串模式扫描 | 仓库 base config 0 error / 0 warning；MUL-472 全部产物 0 hits |

## 非 merge 提交文件

- `docs/dev/performance.md`
- `frontend/packages/views/chat/components/chat-message-list.test.tsx`
- `frontend/packages/views/chat/components/chat-message-list.tsx`
- `frontend/packages/views/chat/components/chat-window.tsx`
- `frontend/packages/views/common/human-request-dock.tsx`
- `frontend/packages/views/issues/components/session-agent-stream-row.test.tsx`
- `frontend/packages/views/layout/shell-deferred-queries.test.tsx`
- `frontend/packages/views/test/task-handlers.ts`
- `reports/performance/MUL-472-r4/MUL-472-r4-before-long.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-after-hot-path.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-after-chat-open.json`
- `reports/performance/MUL-472-r4/MUL-454-fixture.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-key-audit.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-before-timing.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-before-chat-open.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-after-long.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-before-hot-path.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-verification.json`
- `reports/performance/MUL-472-r4/MUL-472-r4-after-timing.json`
- `reports/performance/MUL-472-r4/scripts/audit.ts`
- `reports/performance/MUL-472-r4/scripts/fixture.ts`
- `reports/performance/MUL-472-r4/scripts/probe.ts`
- `reports/performance/MUL-472-r4/scripts/report.ts`
- `reports/performance/MUL-472-r4/scripts/run.ts`
- `reports/performance/MUL-472-r4/scripts/check-report.ts`
- `reports/performance/MUL-472-r4-report.html`
- `reports/performance/MUL-472-r4-report.md`

