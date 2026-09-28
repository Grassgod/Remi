# MUL-472 第四轮返工

仅修第四轮 B1 与同类隐藏 observer。实际 main / before=b95dd2fa5e301588ba1e04aa9bacc370240d664c；merge=0c727a2a8e0808b727a5612f346c9eb6ba90bc00，无冲突。产品/测试提交=ca53b9a581fb91e3d64cf2ba9dfd1ebd88fe7678；frontend tree=3bd1de444a46fcff168148262b36f94d629a05d6。最终报告提交 head 和该 SHA 的 CI 6/6 核对记录随交付评论列出，PR #297 保持 Draft。

## B1

隐藏 ChatWindow 仍挂载缓存消息，任务 id 合法就会使 observer active；462 的合法 degraded header invalidate 因而触发 refetch。ChatMessageList 的 live 和 AssistantMessage 两处改为 visible && 原条件，ChatWindow 传实际 chatVisible。隐藏仅 stale，重开立即读取 stale，打开时 header 正常 refetch。没有使用 visible || shellGateOpen；角标/完成状态由已门控的 aggregate pending 和 WS 缓存更新承担，不依赖隐藏的 transcript 查询。

按 key 审计另补 HumanRequestDock 的 enabled=chatVisible（详情默认 true），以及隐藏虚拟列表 startReached 的 visible 条件，避免命令式 fetchNextPage 绕过 enabled。扩展到 19 组 key 的冷壳层守卫又定位到无缓存会话时隐藏 WorkLocationPicker 的项目候选：ChatWindow 传 projectsEnabled=chatVisible，其他可见选择器默认 true。修前守卫 1 fail，修后恢复全绿；成员/项目同 key 的必要权限、主体读取明确列为不门控。未改 gate registry、aggregate pending、462 实现、服务端、正式 recorder 或阈值。

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

真实 DashboardLayout + ChatFab + ChatWindow（仅隔离 WS 传输），给 19 组 key 全部预置缓存，包括 messagesPage/pendingTask、PinRow details、聊天 recents、任务消息、人工请求、成员和项目候选。使用库自带 VirtuosoMockContext 提供 jsdom 尺寸，并断言缓存的历史回复行实际挂载；其 task id 与 pending 一致，live observer 被已持久化回复抑制，因此通用守卫直接覆盖嵌套 AssistantMessage，QA 原负控另覆盖 live observer。逐 key invalidate，再经真实 createTaskHandlers 发送合法 degraded header：gate 前 QueryCache fetch 事件=0。gate 后壳层请求正常，隐藏消息/表单/候选仍 inactive；打开后立即取 stale。另有无缓存会话的隐藏项目候选守卫、live/assistant 独立用例、隐藏分页回调以及详情 degraded-header 正控。

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

 ❯ chat/components/chat-message-list.test.tsx (10 tests | 2 failed) 153ms
     × keeps the live observer inactive while hidden and refetches stale data on reopen 21ms
     × keeps the assistant observer inactive while hidden and refetches stale data on reopen 16ms
stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
13:17:02.208 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
13:17:02.208 [chat.store] setActiveSession { from: null, to: 'cs_qa_refetch' }
13:17:02.209 [chat.store] setOpen { from: false, to: true }
13:17:02.323 [chat.ui] ChatWindow mount {
  isOpen: true,
  activeSessionId: 'cs_qa_refetch',
  pendingTaskId: 'tsk_qa_refetch',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
13:17:02.418 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
13:17:02.437 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_qa_refetch', pendingTaskId: 'tsk_qa_refetch' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
13:17:02.444 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
13:17:02.445 [chat.store] setActiveSession { from: null, to: 'cs_qa_hidden' }
13:17:02.492 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: 'cs_qa_hidden',
  pendingTaskId: 'tsk_qa_hidden',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
13:17:02.548 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_qa_hidden', pendingTaskId: 'tsk_qa_hidden' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
13:17:02.698 [chat.store] setOpen { from: true, to: false }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
13:17:02.699 [chat.store] setActiveSession { from: null, to: 'cs_guard_cached' }
13:17:02.848 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: 'cs_guard_cached',
  pendingTaskId: 'tsk_guard_live',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
13:17:02.914 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_guard_cached', pendingTaskId: 'tsk_guard_live' }

 ❯ layout/shell-deferred-queries.test.tsx (6 tests | 3 failed) 842ms
     × QA: a failed-reference header refetches an open chat but not a hidden cached chat 237ms
     × QA: an initially hidden cached chat does not refetch before page readiness 105ms
     × keeps cached deferred keys quiet on invalidation, including a real degraded header 218ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: a failed-reference header refetches an open chat but not a hidden cached chat
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ layout/shell-deferred-queries.test.tsx:267:100
    265|       await act(async () => {});
    266|       listTaskMessages.mockClear();
    267|       expect(client.getQueryCache().find({ queryKey: chatKeys.taskMess…
       |                                                                                                    ^
    268|       await act(async () => { sync.handlers["task:message"]?.({ task_i…
    269|       expect(listTaskMessages).not.toHaveBeenCalled();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/5]⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > QA: an initially hidden cached chat does not refetch before page readiness
AssertionError: expected "listTaskMessages" to not be called at all, but actually been called 1 times

Received:

  1st listTaskMessages call:

    Array [
      "tsk_qa_hidden",
    ]


Number of calls: 1

 ❯ layout/shell-deferred-queries.test.tsx:298:36
    296|       expect(useChatStore.getState().isOpen).toBe(false);
    297|       await act(async () => { sync.handlers["task:message"]?.({ task_i…
    298|       expect(listTaskMessages).not.toHaveBeenCalled();
       |                                    ^
    299|     } finally {
    300|       view.unmount(); sync.dispose?.(); client.clear();

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

 ❯ layout/shell-deferred-queries.test.tsx:378:27
    376|         sync.handlers["task:message"]?.({ task_id: taskId, degraded: t…
    377|       });
    378|       expect(startedKeys).toEqual([]);
       |                           ^
    379|       expect(listTaskMessages).not.toHaveBeenCalled();
    380|       expect(listTaskHumanRequests).not.toHaveBeenCalled();

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
   Start at  21:16:53
   Duration  9.02s (transform 5.13s, setup 114ms, import 9.63s, tests 995ms, environment 1.09s)


```

仅移除历史 AssistantMessage 的 visible 条件，通用守卫也变红；立即还原。

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
13:18:00.821 [chat.store] setOpen { from: true, to: false }

stderr | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
react-i18next:: useTranslation: You will need to pass in an i18next instance by using initReactI18next { code: 'NO_I18NEXT_INSTANCE' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
13:18:00.826 [chat.store] setActiveSession { from: null, to: 'cs_guard_cached' }
13:18:01.094 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: 'cs_guard_cached',
  pendingTaskId: 'tsk_guard_live',
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps cached deferred keys quiet on invalidation, including a real degraded header
13:18:01.213 [chat.ui] ChatWindow unmount { activeSessionId: 'cs_guard_cached', pendingTaskId: 'tsk_guard_live' }

 ❯ layout/shell-deferred-queries.test.tsx (6 tests | 1 failed | 5 skipped) 404ms
     × keeps cached deferred keys quiet on invalidation, including a real degraded header 402ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

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

 ❯ layout/shell-deferred-queries.test.tsx:378:27
    376|         sync.handlers["task:message"]?.({ task_id: taskId, degraded: t…
    377|       });
    378|       expect(startedKeys).toEqual([]);
       |                           ^
    379|       expect(listTaskMessages).not.toHaveBeenCalled();
    380|       expect(listTaskHumanRequests).not.toHaveBeenCalled();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
   Start at  21:17:51
   Duration  9.40s (transform 4.62s, setup 68ms, import 8.25s, tests 404ms, environment 551ms)


```

## 时序与位移

同机 Chromium 146 / 1440×900，隔离内存 SQLite，before/after 均使用 main b95dd2fa 的服务端和正式 recorder；附属响应延迟 900ms，主体列表 300ms。冷新 context；热真实 click、核对目标路由后固定原 Element。issues/detail 各 n=3 冷+3热，inbox n=2 冷+2热；MUL-454 210 条合成正文取自 QA 附件，仅重新放入本地 fixture，冷/热各 n=1。正式 ready/500ms quiet、1.5s recorder 及固定 Element 3s 交叉验证均保留。before detail cold r1 编译/机器负载 13120.1ms 原始值留档，不当 p75。未访问 209、未跑 frontend/e2e、未抓 trace/HAR。

| 场景 | n | 首行 ms | 请求首行后 ms | recorder / 固定元素 px | 违例 |
| --- | --- | --- | --- | --- | --- |
| issues 冷 | 3 | 3166.5 / 3074.5 / 3037.3 | 1050.1 .. 2178.1 | 0 / 0 | 0 |
| issues 热 | 3 | 1791.3 / 1831.7 / 1841.6 | 123.6 .. 127.7 | 0 / 0 | 0 |
| inbox 冷 | 2 | 2464.3 / 2747.1 | 67.4 .. 1141.1 | 0 / 0 | 0 |
| inbox 热 | 2 | 1420.2 / 1365.4 | 无新请求（缓存） | 0 / 0 | 0 |
| detail 冷 | 3 | 3333.8 / 3406.5 / 3311.9 | 261.4 .. 1586.4 | 0 / 0 | 0 |
| detail 热 | 3 | 2419.4 / 2363.3 / 2322.8 | 无新请求（缓存） | 0 / 0 | 0 |
| MUL-454 冷 | 1 | 3772.5 | 400.3 .. 1567.8 | 0 / 0 | 0 |
| MUL-454 热 | 1 | 2825.5 | 无新请求（缓存） | 0 / 0 | 0 |

### issues 冷

首行 3166.5 / 3074.5 / 3037.3ms；锚点 iss_pin_me。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 4271.4 (+1104.9) | 4130.0 (+1055.5) | 4087.4 (+1050.1) |
| /api/agent-task-snapshot | 4273.4 (+1106.9) | 4132.1 (+1057.6) | 4089.5 (+1052.2) |
| /api/squads | 4275.4 (+1108.9) | 4134.2 (+1059.7) | 4091.6 (+1054.3) |
| /api/invitations | 4277.8 (+1111.3) | 4136.5 (+1062.0) | 4093.9 (+1056.6) |
| /api/inbox/summary?timezone_offset=-480 | 4279.7 (+1113.2) | 4138.7 (+1064.2) | 4095.9 (+1058.6) |
| /api/cli/latest-version | 4281.5 (+1115.0) | 4140.9 (+1066.4) | 4097.8 (+1060.5) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 4283.4 (+1116.9) | 4142.9 (+1068.4) | 4099.7 (+1062.4) |
| /api/pins | 4285.2 (+1118.7) | 4144.9 (+1070.4) | 4101.5 (+1064.2) |
| /api/issues/child-progress | 4290.3 (+1123.8) | 4150.0 (+1075.5) | 4106.7 (+1069.4) |
| /api/chat/pending-tasks | 4292.5 (+1126.0) | 4152.1 (+1077.6) | 4109.1 (+1071.8) |
| /api/chat/sessions?status=all | 4295.1 (+1128.6) | 4155.1 (+1080.6) | 4111.8 (+1074.5) |
| /api/issues/iss_pin_me | 5344.6 (+2178.1) | 5183.3 (+2108.8) | 5146.6 (+2109.3) |

### issues 热

首行 1791.3 / 1831.7 / 1841.6ms；锚点 iss_pin_me。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/issues/child-progress | 1919.0 (+127.7) | 1955.3 (+123.6) | 1965.5 (+123.9) |

### inbox 冷

首行 2464.3 / 2747.1ms；锚点 inb_probe_2。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） |
| --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 2535.7 (+71.4) | 2814.5 (+67.4) |
| /api/agent-task-snapshot | 2538.5 (+74.2) | 2816.6 (+69.5) |
| /api/squads | 2541.0 (+76.7) | 2818.6 (+71.5) |
| /api/invitations | 2544.4 (+80.1) | 2821.8 (+74.7) |
| /api/inbox/summary?timezone_offset=-480 | 2546.9 (+82.6) | 2823.8 (+76.7) |
| /api/cli/latest-version | 2549.3 (+85.0) | 2825.8 (+78.7) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 2551.9 (+87.6) | 2828.0 (+80.9) |
| /api/pins | 2554.5 (+90.2) | 2830.0 (+82.9) |
| /api/chat/pending-tasks | 2558.1 (+93.8) | 2832.9 (+85.8) |
| /api/chat/sessions?status=all | 2561.9 (+97.6) | 2835.9 (+88.8) |
| /api/issues/iss_pin_me | 3577.6 (+1113.3) | 3888.2 (+1141.1) |

### inbox 热

首行 1420.2 / 1365.4ms；锚点 inb_probe_2。

无新门控请求（缓存）。

### detail 冷

首行 3333.8 / 3406.5 / 3311.9ms；锚点 cmt_jt0832dlduax。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 3771.2 (+437.4) | 3667.9 (+261.4) | 3575.0 (+263.1) |
| /api/agent-task-snapshot | 3773.3 (+439.5) | 3670.1 (+263.6) | 3577.0 (+265.1) |
| /api/squads | 3775.2 (+441.4) | 3672.1 (+265.6) | 3579.0 (+267.1) |
| /api/invitations | 3777.6 (+443.8) | 3674.6 (+268.1) | 3581.4 (+269.5) |
| /api/inbox/summary?timezone_offset=-480 | 3779.5 (+445.7) | 3676.5 (+270.0) | 3583.4 (+271.5) |
| /api/cli/latest-version | 3781.4 (+447.6) | 3678.5 (+272.0) | 3585.2 (+273.3) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 3783.4 (+449.6) | 3680.5 (+274.0) | 3587.3 (+275.4) |
| /api/pins | 3785.4 (+451.6) | 3682.6 (+276.1) | 3589.3 (+277.4) |
| /api/chat/pending-tasks | 3792.9 (+459.1) | 3690.4 (+283.9) | 3597.9 (+286.0) |
| /api/chat/sessions?status=all | 3795.6 (+461.8) | 3693.2 (+286.7) | 3600.9 (+289.0) |
| /api/issues/iss_pin_me | 4920.2 (+1586.4) | 4815.2 (+1408.7) | 4725.2 (+1413.3) |

### detail 热

首行 2419.4 / 2363.3 / 2322.8ms；锚点 cmt_jt0832dlduax。

无新门控请求（缓存）。

### MUL-454 冷

首行 3772.5ms；锚点 cmt_r8usqdc0yr36。

| 被门控请求 | r1 发起 ms（首行后 ms） |
| --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 4172.8 (+400.3) |
| /api/agent-task-snapshot | 4174.8 (+402.3) |
| /api/squads | 4176.8 (+404.3) |
| /api/invitations | 4179.1 (+406.6) |
| /api/inbox/summary?timezone_offset=-480 | 4181.1 (+408.6) |
| /api/cli/latest-version | 4182.9 (+410.4) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 4184.9 (+412.4) |
| /api/pins | 4187.0 (+414.5) |
| /api/chat/pending-tasks | 4194.7 (+422.2) |
| /api/chat/sessions?status=all | 4197.6 (+425.1) |
| /api/issues/iss_pin_me | 5340.3 (+1567.8) |

### MUL-454 热

首行 2825.5ms；锚点 cmt_r8usqdc0yr36。

无新门控请求（缓存）。

## 主动打开聊天

点击 2483.5ms，主列表未出现，gate 未开。

| 请求 | 发起 ms | 点击后 ms |
| --- | --- | --- |
| /api/chat/pending-tasks | 2503.3 | 19.8 |
| /api/chat/sessions?status=all | 2510.8 | 27.3 |
| /api/chat/sessions/cs_fixture/messages/page?limit=50 | 2513.4 | 29.9 |
| /api/chat/sessions/cs_fixture/pending-task | 2515.4 | 31.9 |
| /api/tasks/tsk_chat_fixture/messages | 2622.0 | 138.5 |
| /api/tasks/tsk_chat_fixture/human-requests | 2624.3 | 140.8 |

## 同 main 对比

新 fixture 的完整链路（含冷进入 issues）56→53：初入 29→26，热 inbox 23→23，热 detail 4→4。纯热两段 27→27。旧报告 51→50 是完整链路，23→23 才是纯热；第三轮 53→52 / 25→25 是旧 fixture 参考，均不充当本轮 b95dd2fa 基线。593ff2ba 原首屏 27→22 / 19→15 / 36→35 保留为历史参考。新增非空聊天任务会触发 aggregate pending 轮询，本轮逐请求原样保留，不混用观察窗。

| 场景 | 首屏 before | 首屏 after | 观察窗 before | 观察窗 after |
| --- | --- | --- | --- | --- |
| issues cold | 27 / 27 / 27 | 14 / 14 / 14 | 29 / 29 / 29 | 26 / 26 / 26 |
| issues warm | 10 / 10 / 10 | 8 / 8 / 8 | 11 / 11 / 11 | 9 / 9 / 9 |
| inbox cold | 19 / 19 | 7 / 7 | 20 / 20 | 18 / 18 |
| inbox warm | 2 / 2 | 1 / 1 | 3 / 2 | 1 / 1 |
| detail cold | 39 / 39 / 39 | 27 / 27 / 27 | 40 / 40 / 40 | 38 / 38 / 38 |
| detail warm | 19 / 19 / 19 | 19 / 19 / 19 | 20 / 20 / 20 | 19 / 19 / 19 |

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
- `frontend/packages/views/runtimes/components/runtime-workspace-picker.tsx`
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

