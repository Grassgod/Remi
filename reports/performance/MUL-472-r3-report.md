# MUL-472 第三轮返工

仅修 R1 observer 旁路和 R2 页面卸载生命周期；轮询、已读重试、计数算法、fallback 2000ms、正文就绪定义及测速契约均保持。长样本 210/250 评论沿用 QA 第二轮结论，本轮不声称重新运行。

正式 before=36fb03c47eba7914be7a4d026f19e360b83a0f83（实际合入的 main，locked detached worktree），after 浏览器及回归代码=a5b1d899de5cb20215ccae21eabee099148644de，前后使用同一 main，正式 recorder/selectors 含 MUL-414 更新，fixture 参数相同；最终报告提交的 head 和 CI 见交付评论，其 frontend tree 为 34246cab00e5d7680a962b146d62146383d8dce9。实际 merge 为 093989ea（dd560871）、69d60a46（60c057be）、a5b1d899（36fb03c4）。另建返工前 89de3ef030afaad121c08dd6068e22c9986d012f，仅用于 R2 同路径热返回：从合并结果移除本轮 8 个文件的改动，保留所有 MUL-414 语义，tree=69c03ad301d843f9033691d9d16f5dfb682b578b；它不是正式请求数/零跳动 before。旧 main 的测量数字不作为本轮基线。

## 同步 main 与冲突解决

| 冲突文件 | 区域 | 解决方式 |
| --- | --- | --- |
| issue-detail.tsx | 成员查询、agents、loading 及终态 publisher | 保留 414 membersQuery 与成员/子单 pending 加载条件；保留 472 agents 门控和空/失败终态 publisher，正文就绪仍由 Main reveal 后发布 |
| issue-detail-main.test.tsx | 测试 wrapper 与上下文 | 同时提供 QueryClientProvider 和 NavigationProvider；保留 414 控件/强制开始测试与 472 reveal/门控测试 |
| use-issue-actions.test.tsx | imports、beforeEach | 同时保留 ApiError/toast 与 gate helpers；异步 beforeEach 设置 414 user 身份并打开 472 受控 gate，两侧测试均保留 |
| core/realtime/sync/chat.test.ts | query key imports | 同时导入 414 issueKeys 与 472 chatKeys/pendingChatTasksOptions，保留全部测试 |

| 自动合并文件 | 语义复核 |
| --- | --- |
| issue-detail-main.tsx | 414 decisions/dependencies 主体查询、固定 h10 提示槽、决策/等待/强制开始控件均保留；472 reveal 后发布就绪仍在 |
| core/api/endpoints/issues.ts | 414 strictIssueDetailSchema、决策/授权/依赖接口均保留；未手工改变后端协议 |
| core/issues/queries.ts | 414 detailAll/decisions/dependencies key/options 与 472 childProgress enabled 均保留 |
| use-issue-actions.ts | 414 updateField onSuccess、状态错误处理和用户权限保留；472 pins 页级 enabled 保留 |
| scripts/perf/lib/selectors.ts | 414 inboxRowSelector 指定 inboxItemId 与 472 列表契约接入均保留；算法/阈值不变，本轮 before/after 均重测 |

## R1

SessionDropdown 采用 chatVisible || shellGateOpen；ChatWindow 的两处调用都传入 chatVisible。隐藏状态必须等待 shell gate，用户打开立即加载。全仓审计还发现 ProjectDetail 的 pin 工具栏 observer 未等待门控，已补 userId && afterFirstScreen；该图标不构成主列表。真实 DashboardLayout、AppSidebar、WorkspacePresencePrefetch、ChatFab、隐藏 ChatWindow 与其子组件一起挂载的 QueryClient 守卫，在 gate 前断言十组附属 API 0 次，放行后各 1 次；另记录所有延后 key 的 QueryCache fetch 事件，包括 child-progress、PinRow detail、聊天消息及 per-session pending，让没有专用 API spy 的新增 observer 也会变红。只隔离 WS 传输和平台导航，不替换任何 observer。

## R2

registry 增加 publisher/consumer 计数；最后一个 publisher 卸载即结束该页面 visit，保留跨页 shellPassed。无 publisher 的路由由最后一个 consumer 释放。releaseRoute 清掉 fallback/idle，consumer 清掉 0ms arm timer，publisher 原有 cleanup 取消帧回调。idle/fallback/arm 回调检查 registry 对象身份，已排队的旧回调不能打开同 pathname 的新实例。不同 publisher 同时拥有一页时不会提前释放。

## 六个冷热场景

同机本地内存 SQLite API、Chromium 1440×900、Next dev 预热路由；issues/inbox/detail-short 的 cold+warm n=3/2/3 共 16 轮。冷相对文档导航，热相对实际 click，目标路由匹配后锁定固定 Element；1.5s 正式 recorder 和固定元素采样，另连续 3s 核对固定元素不移动/断开。使用仓库 installRecorderOnContext/profilesFor/computeJumps/computeRoundMeasurement（quiet=500ms），未改算法或阈值。fixture pin=1、邀请=1、CLI=999.0.0、workbench=2，延后响应 900ms、主列表响应 300ms。gated() 本轮纳入 aggregate pending、sessions、PinRow 详情。所有新门控请求均严格晚于目标首行；无新请求表示缓存/壳层常驻，并非将请求清单排除。

| 场景 | n | 首行 ms | 门控请求首行后 ms | recorder / 固定元素 px | 违例 |
| --- | --- | --- | --- | --- | --- |
| issues 冷 | 3 | 3125.9 / 2911.9 / 2926.8 | 1042.9 .. 2107.4 | 0 / 0 | 0 |
| issues 热 | 3 | 1893.3 / 1850.2 / 1830.7 | 111.9 .. 113.9 | 0 / 0 | 0 |
| inbox 冷 | 2 | 2501.4 / 3250.6 | 67.3 .. 1133.1 | 0 / 0 | 0 |
| inbox 热 | 2 | 1496.0 / 1432.4 | 无新门控请求（缓存） | 0 / 0 | 0 |
| detail-short 冷 | 3 | 3354.3 / 3277.6 / 3312.0 | 463.3 .. 1725.3 | 0 / 0 | 0 |
| detail-short 热 | 3 | 2462.2 / 2448.5 / 2407.1 | 无新门控请求（缓存） | 0 / 0 | 0 |

### issues 冷 (n=3)

首行 3125.9 / 2911.9 / 2926.8ms；锚点 iss_pin_me。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 4169.8 (+1043.9) | 3956.2 (+1044.3) | 3969.7 (+1042.9) |
| /api/agent-task-snapshot | 4171.9 (+1046.0) | 3958.3 (+1046.4) | 3971.9 (+1045.1) |
| /api/squads | 4173.9 (+1048.0) | 3960.3 (+1048.4) | 3973.9 (+1047.1) |
| /api/invitations | 4176.2 (+1050.3) | 3962.4 (+1050.5) | 3975.9 (+1049.1) |
| /api/inbox/summary?timezone_offset=-480 | 4178.2 (+1052.3) | 3964.3 (+1052.4) | 3977.9 (+1051.1) |
| /api/cli/latest-version | 4180.1 (+1054.2) | 3966.0 (+1054.1) | 3979.7 (+1052.9) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 4181.9 (+1056.0) | 3967.9 (+1056.0) | 3981.6 (+1054.8) |
| /api/pins | 4183.7 (+1057.8) | 3969.7 (+1057.8) | 3983.4 (+1056.6) |
| /api/issues/child-progress | 4188.4 (+1062.5) | 3974.1 (+1062.2) | 3988.0 (+1061.2) |
| /api/chat/pending-tasks | 4190.7 (+1064.8) | 3976.4 (+1064.5) | 3990.2 (+1063.4) |
| /api/chat/sessions?status=all | 4193.4 (+1067.5) | 3979.0 (+1067.1) | 3992.8 (+1066.0) |
| /api/issues/iss_pin_me | 5201.5 (+2075.6) | 4975.7 (+2063.8) | 5034.2 (+2107.4) |

### issues 热 (n=3)

首行 1893.3 / 1850.2 / 1830.7ms；锚点 iss_pin_me。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/issues/child-progress | 2005.2 (+111.9) | 1963.4 (+113.2) | 1944.6 (+113.9) |

### inbox 冷 (n=2)

首行 2501.4 / 3250.6ms；锚点 inb_probe_2。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） |
| --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 2570.2 (+68.8) | 3317.9 (+67.3) |
| /api/agent-task-snapshot | 2572.3 (+70.9) | 3320.1 (+69.5) |
| /api/squads | 2574.5 (+73.1) | 3322.0 (+71.4) |
| /api/invitations | 2577.2 (+75.8) | 3324.6 (+74.0) |
| /api/inbox/summary?timezone_offset=-480 | 2579.2 (+77.8) | 3326.6 (+76.0) |
| /api/cli/latest-version | 2581.2 (+79.8) | 3328.6 (+78.0) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 2583.4 (+82.0) | 3330.8 (+80.2) |
| /api/pins | 2585.4 (+84.0) | 3332.7 (+82.1) |
| /api/chat/pending-tasks | 2588.3 (+86.9) | 3335.6 (+85.0) |
| /api/chat/sessions?status=all | 2591.1 (+89.7) | 3338.5 (+87.9) |
| /api/issues/iss_pin_me | 3611.3 (+1109.9) | 4383.7 (+1133.1) |

### inbox 热 (n=2)

首行 1496.0 / 1432.4ms；锚点 inb_probe_2。

无新门控请求（缓存）。

### detail-short 冷 (n=3)

首行 3354.3 / 3277.6 / 3312.0ms；锚点 cmt_q2dk30g7ojhe。

| 被门控请求 | r1 发起 ms（首行后 ms） | r2 发起 ms（首行后 ms） | r3 发起 ms（首行后 ms） |
| --- | --- | --- | --- |
| /api/agents?workspace_id=local&include_archived=true | 3818.6 (+464.3) | 3740.9 (+463.3) | 3781.5 (+469.5) |
| /api/agent-task-snapshot | 3820.6 (+466.3) | 3742.9 (+465.3) | 3783.7 (+471.7) |
| /api/squads | 3822.6 (+468.3) | 3744.9 (+467.3) | 3785.6 (+473.6) |
| /api/invitations | 3825.1 (+470.8) | 3747.4 (+469.8) | 3788.0 (+476.0) |
| /api/inbox/summary?timezone_offset=-480 | 3827.0 (+472.7) | 3749.2 (+471.6) | 3790.0 (+478.0) |
| /api/cli/latest-version | 3829.0 (+474.7) | 3751.1 (+473.5) | 3791.8 (+479.8) |
| /api/issues?limit=1&statuses=in_review%2Cblocked | 3831.3 (+477.0) | 3753.2 (+475.6) | 3794.0 (+482.0) |
| /api/pins | 3833.4 (+479.1) | 3755.2 (+477.6) | 3796.0 (+484.0) |
| /api/chat/pending-tasks | 3841.1 (+486.8) | 3762.6 (+485.0) | 3803.3 (+491.3) |
| /api/chat/sessions?status=all | 3844.2 (+489.9) | 3765.5 (+487.9) | 3806.0 (+494.0) |
| /api/issues/iss_pin_me | 5079.6 (+1725.3) | 4887.0 (+1609.4) | 4942.8 (+1630.8) |

### detail-short 热 (n=3)

首行 2462.2 / 2448.5 / 2407.1ms；锚点 cmt_q2dk30g7ojhe。

无新门控请求（缓存）。

## 同路径热返回

R2 专项比较返工前 89de3ef030afaad121c08dd6068e22c9986d012f 与返工后 a5b1d899de5cb20215ccae21eabee099148644de，两者均含 main 36fb03c47eba7914be7a4d026f19e360b83a0f83；缓存热返回为 issues → inbox → issues，各 n=3。新 QueryClient 的 pending 重挂由 QA 原用例验证。浏览器热返回仍使用同一个 QueryClient 的缓存，表中逐条列出新门控请求；缓存命中无请求的轮次明确记为无新请求，不能捏造发起时间。首次测量 idle 首行后中位数 127.3→169.0ms，原始六轮全部保留在 initial-hot-return.json 和 HTML 下载数据中。为核对数十毫秒的 dev 波动，用已编译路由同参数再各跑三轮，得到 163.6→165.3ms。真实 next-dev 的忙碌时段仍由 requestIdleCallback 选择空闲；受控单测证明缓存就绪在下一帧加 idle 后放行，没有新增固定延迟。

| 代码 | 轮 | 首行 ms | idle ms | 首行后 idle ms | 门控请求 | px |
| --- | --- | --- | --- | --- | --- | --- |
| rework-before | 1 | 775.5 | 939.1 | 163.6 | 无新请求（缓存） | 0 |
| rework-before | 2 | 651.8 | 795.9 | 144.1 | 无新请求（缓存） | 0 |
| rework-before | 3 | 641.1 | 815.2 | 174.1 | 无新请求（缓存） | 0 |
| after | 1 | 801.9 | 967.2 | 165.3 | 无新请求（缓存） | 0 |
| after | 2 | 633.7 | 804.9 | 171.2 | 无新请求（缓存） | 0 |
| after | 3 | 641.7 | 766.9 | 125.2 | 无新请求（缓存） | 0 |

## 请求数

本轮完整链路（含冷进入 issues） 53→52；初入 issues 28→27，热 inbox 22→22，热 detail 3→3；纯热两段 25→25。上一轮 main=0c2b3865 的 51→50 是完整链路，纯热仍为 23→23；不得把 51→50 称作纯热切页。旧 593ff2ba 的 27→22 / 19→15 / 36→35 只作历史参考，不与本轮不同 main 的数字直接比较。

| 场景 | 首屏 before | 首屏 after | 观察窗 before | 观察窗 after |
| --- | --- | --- | --- | --- |
| issues 冷 | 27 / 27 / 27 | 15 / 15 / 15 | 28 / 28 / 28 | 27 / 27 / 27 |
| issues 热 | 9 / 9 / 9 | 8 / 8 / 8 | 9 / 9 / 9 | 9 / 9 / 9 |
| inbox 冷 | 19 / 19 | 8 / 8 | 20 / 20 | 19 / 19 |
| inbox 热 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| detail-short 冷 | 39 / 39 / 39 | 27 / 27 / 27 | 39 / 39 / 39 | 38 / 38 / 38 |
| detail-short 热 | 18 / 18 / 18 | 18 / 18 / 18 | 18 / 18 / 18 | 18 / 18 / 18 |

## Observer 分类

完整 95 项、7 个命令式调用和 3 个裸 API 例外见附件 HTML 与 MUL-472-r3-observers.json；每项含位置、实际表达式、分类及依据。

| 分类 | 调用点 |
| --- | --- |
| 不门控（主体） | 32 |
| 页面级 | 17 |
| 不等首屏 gate（交互） | 27 |
| 外壳 | 11 |
| 页面级 / 主体例外 | 2 |
| 页面级 / 筛选必需例外 | 4 |
| 外壳 / 原生调用例外 | 1 |
| 外壳 / 交互优先 | 1 |

| 命令式查询位置 | 操作 | 依据 |
| --- | --- | --- |
| frontend/packages/core/realtime/sync/workspace.ts:66 | fetchQuery | workspaceList 骨架查询，与延后 key 不同 |
| frontend/packages/core/realtime/sync/inbox.ts:33 | ensureQueryData | workspaceList 骨架查询，与延后 key 不同 |
| frontend/packages/core/realtime/sync/inbox.ts:83 | ensureQueryData | 通知偏好必需查询，与延后 key 不同 |
| frontend/packages/views/invitations/invitations-page.tsx:100 | fetchQuery | workspaceList 骨架查询，与延后 key 不同 |
| frontend/packages/views/issues/components/issue-dependency-editor.tsx:38 | fetchQuery | 用户打开依赖选择器时读取父单链，交互优先；不是冷首屏预取 |
| frontend/packages/views/layout/app-sidebar.tsx:450 | fetchQuery | workspaceList 骨架查询，与延后 key 不同 |
| frontend/packages/views/invite/invite-page.tsx:79 | fetchQuery | workspaceList 骨架查询，与延后 key 不同 |

## 测试与变异

QA patch 的两个原始 remount 断言收进 platform/mul472-qa-unmount.test.tsx；首值在 render 内记录。另测卸载取消 idle（并手动调用旧回调）、帧/兜底取消、多 publisher 所有权、缓存下一帧 idle 和 shell 不关闭。原 16 gate 用例不改验收断言。SessionDropdown 缺 gate 的变异使真实全壳守卫 1 fail：expected listPendingChatTasks not to be called, got 1；补 QueryCache 断言后再变异仍 1 fail：expected [['chat','ws-1','pending-tasks']] to deeply equal []。删除 releaseRoute cleanup 使 6 fail，其中 QA 两项为 expected true to be false、expected queryFn not to be called, got 1。ProjectDetail pin 去 gate 的额外变异 1 fail：expected last call false, got true。全部还原后 gate 22/22、相关 views 41/41，补守卫后完整前端全套再次通过。变异的 skipped 来自 -t 定向选择，无新增 skip。

| 命令 | 结果 |
| --- | --- |
| env -u MULTIREMI_TOKEN bunx tsc --noEmit | exit 0 |
| env -u MULTIREMI_TOKEN bun run typecheck:frontend | ui/core/views/web exit 0 |
| env -u MULTIREMI_TOKEN bun run test:frontend | core 1085 pass; views 2452 pass / 18 existing skip; web 55 pass; 0 fail |
| core: vitest run platform/use-after-first-screen.test.tsx platform/mul472-qa-unmount.test.tsx | 22 pass = original 16 + new 6 |
| views: vitest run shell-deferred-queries / session-dropdown / chat-window-project / project-detail | 41 pass (4 files) |
| bun test tests/arch/ tests/unit/scripts/perf-jump-recorder.test.ts --timeout 20000 | 228 pass / 0 fail = 105 arch + 123 recorder |
| npm run docs:check | exit 0 |
| npm run docs:test | 13 pass / 0 fail |
| Changed frontend files: eslint | 0 errors; ProjectDetail's existing exhaustive-deps warning remains |
| Report scripts: repository base eslint config | 0 errors / 0 warnings |
| HTML preview and JSON download | 1440x900 + 390x844: 95 audit rows, no page overflow or script errors; download contains 16 rounds / 95 observers |
| Credential / connection pattern scan | 0 matching files |

### R1

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
08:23:45.365 [chat.store] setOpen { from: true, to: false }

stderr | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
react-i18next:: useTranslation: You will need to pass in an i18next instance by using initReactI18next { code: 'NO_I18NEXT_INSTANCE' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
08:23:45.516 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: null,
  pendingTaskId: null,
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
08:23:45.591 [chat.ui] ChatWindow unmount { activeSessionId: null, pendingTaskId: null }

 ❯ layout/shell-deferred-queries.test.tsx (3 tests | 1 failed | 2 skipped) 231ms
     × keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate 228ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
AssertionError: expected "listPendingChatTasks" to not be called at all, but actually been called 1 times

Received:

  1st listPendingChatTasks call:

    Array []


Number of calls: 1

 ❯ layout/shell-deferred-queries.test.tsx:211:27
    209|     for (const request of [listAgents, listSquads, getAgentTaskSnapsho…
    210|       listPins, getInboxSummary, getLatestCliVersion, listIssues, list…
    211|       expect(request).not.toHaveBeenCalled();
       |                           ^
    212|     }
    213|     act(() => { markRouteContentReady(navigation.pathname); });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 2 skipped (3)
   Start at  16:23:36
   Duration  9.54s (transform 4.85s, setup 67ms, import 8.55s, tests 231ms, environment 560ms)


```

### R1-cache

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
09:47:44.949 [chat.store] setOpen { from: true, to: false }

stderr | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
react-i18next:: useTranslation: You will need to pass in an i18next instance by using initReactI18next { code: 'NO_I18NEXT_INSTANCE' }

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
09:47:45.097 [chat.ui] ChatWindow mount {
  isOpen: false,
  activeSessionId: null,
  pendingTaskId: null,
  selectedAgentId: null,
  wsId: 'ws-1'
}

stdout | layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
09:47:45.173 [chat.ui] ChatWindow unmount { activeSessionId: null, pendingTaskId: null }

 ❯ layout/shell-deferred-queries.test.tsx (3 tests | 1 failed | 2 skipped) 229ms
     × keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate 227ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  layout/shell-deferred-queries.test.tsx > complete shell observer guard (MUL-472 R1) > keeps every deferred key quiet with the real hidden ChatWindow, then loads after the gate
AssertionError: expected [ [ 'chat', 'ws-1', 'pending-tasks' ] ] to deeply equal []

- Expected
+ Received

- []
+ [
+   [
+     "chat",
+     "ws-1",
+     "pending-tasks",
+   ],
+ ]

 ❯ layout/shell-deferred-queries.test.tsx:224:25
    222|     await act(async () => { flushIdle(); });
    223|     await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    224|     expect(startedKeys).toEqual([]);
       |                         ^
    225|     for (const request of [listAgents, listSquads, getAgentTaskSnapsho…
    226|       listPins, getInboxSummary, getLatestCliVersion, listIssues, list…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 2 skipped (3)
   Start at  17:47:35
   Duration  9.28s (transform 4.73s, setup 68ms, import 8.31s, tests 229ms, environment 541ms)


```

### R2

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/core

 ❯ platform/mul472-qa-unmount.test.tsx (6 tests | 6 failed) 51ms
   × unmount then remount starts a pending publisher closed 21ms
   × a remounted pending page does not send a new deferred request 11ms
   × cancels the pending idle callback when the page unmounts 3ms
   × cancels queued frames and publisherless fallback timers on unmount 6ms
   × keeps the gate while another publisher still owns the same page 4ms
   × reopens cached content on the next frame and idle without closing the shell 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  platform/mul472-qa-unmount.test.tsx > unmount then remount starts a pending publisher closed
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/mul472-qa-unmount.test.tsx:66:22
     64|     return open;
     65|   });
     66|   expect(renders[0]).toBe(false);
       |                      ^
     67|   expect(second.result.current).toBe(false);
     68| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/6]⎯

 FAIL  platform/mul472-qa-unmount.test.tsx > a remounted pending page does not send a new deferred request
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

Received:

  1st vi.fn() call:

    Array [
      Object {
        "client": QueryClient {},
        "meta": undefined,
        "queryKey": Array [
          "new-page-auxiliary",
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

 ❯ platform/mul472-qa-unmount.test.tsx:81:24
     79|   }, { wrapper: ({ children }) => <QueryClientProvider client={client}…
     80|   await act(async () => { await Promise.resolve(); });
     81|   expect(requests).not.toHaveBeenCalled();
       |                        ^
     82|   second.unmount();
     83|   client.clear();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/6]⎯

 FAIL  platform/mul472-qa-unmount.test.tsx > cancels the pending idle callback when the page unmounts
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ platform/mul472-qa-unmount.test.tsx:92:21
     90|   const staleCallbacks = [...idle.values()];
     91|   first.unmount();
     92|   expect(idle.size).toBe(0);
       |                     ^
     93|   const second = renderHook(() => usePageGate(false));
     94|   // Even an already-dispatched callback cannot open a later visit of …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/6]⎯

 FAIL  platform/mul472-qa-unmount.test.tsx > cancels queued frames and publisherless fallback timers on unmount
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/mul472-qa-unmount.test.tsx:111:33
    109|   expect(idle.size).toBe(0);
    110|   const second = renderHook(() => useAfterFirstScreen({ routeKey: "/lo…
    111|   expect(second.result.current).toBe(false);
       |                                 ^
    112|   vi.useRealTimers();
    113| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/6]⎯

 FAIL  platform/mul472-qa-unmount.test.tsx > keeps the gate while another publisher still owns the same page
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/mul472-qa-unmount.test.tsx:123:32
    121|   second.unmount();
    122|   const third = renderHook(() => usePageGate(false));
    123|   expect(third.result.current).toBe(false);
       |                                ^
    124| });
    125|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/6]⎯

 FAIL  platform/mul472-qa-unmount.test.tsx > reopens cached content on the next frame and idle without closing the shell
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ platform/mul472-qa-unmount.test.tsx:133:33
    131|   expect(shell.result.current).toBe(true);
    132|   const second = renderHook(() => usePageGate(true));
    133|   expect(second.result.current).toBe(false);
       |                                 ^
    134|   act(flushFrames);
    135|   expect(second.result.current).toBe(false);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/6]⎯


 Test Files  1 failed (1)
      Tests  6 failed (6)
   Start at  17:48:01
   Duration  954ms (transform 82ms, setup 0ms, import 203ms, tests 51ms, environment 556ms)


```

### project-pin

```text

 RUN  v4.1.10 /data00/home/hehuajie/.remi/multiremi/workspaces/issues/MUL-472/Remi/frontend/packages/views

 ❯ projects/components/project-detail.test.tsx (16 tests | 1 failed | 15 skipped) 98ms
     × defers the project toolbar pin observer until the page gate opens 95ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  projects/components/project-detail.test.tsx > ProjectDetail issues surface > defers the project toolbar pin observer until the page gate opens
AssertionError: expected last "vi.fn()" call to have been called with [ false ]

- Expected
+ Received

  [
-   false,
+   true,
  ]

 ❯ projects/components/project-detail.test.tsx:325:25
    323|   it("defers the project toolbar pin observer until the page gate open…
    324|     const view = renderDetail();
    325|     expect(pinObserver).toHaveBeenLastCalledWith(false);
       |                         ^
    326|     state.gateOpen = true;
    327|     view.rerender(

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 15 skipped (16)
   Start at  16:54:04
   Duration  1.78s (transform 497ms, setup 67ms, import 938ms, tests 98ms, environment 543ms)


```

## 非 merge 提交

### b8297849 MUL-472: guard deferred key fetches across the complete shell

- `frontend/packages/views/layout/shell-deferred-queries.test.tsx`

### 766fa86e MUL-472: gate the remaining project pin observer

- `frontend/packages/views/projects/components/project-detail.test.tsx`
- `frontend/packages/views/projects/components/project-detail.tsx`

### cc935ee7 MUL-472: gate hidden chat observers and release unmounted pages

- `docs/dev/performance.md`
- `frontend/packages/core/platform/mul472-qa-unmount.test.tsx`
- `frontend/packages/core/platform/use-after-first-screen.ts`
- `frontend/packages/views/chat/components/chat-window.tsx`
- `frontend/packages/views/chat/components/session-dropdown.tsx`
- `frontend/packages/views/layout/shell-deferred-queries.test.tsx`

报告提交：

- `reports/performance/MUL-472-r3/MUL-472-r3-rework-before-hot-return.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-after-hot-return.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-initial-hot-return.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-before-timing.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-observers.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-after-timing.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-after-hot-path.json`
- `reports/performance/MUL-472-r3/MUL-472-r3-before-hot-path.json`
- `reports/performance/MUL-472-r3/scripts/audit.ts`
- `reports/performance/MUL-472-r3/scripts/fixture.ts`
- `reports/performance/MUL-472-r3/scripts/probe.ts`
- `reports/performance/MUL-472-r3/scripts/run.ts`
- `reports/performance/MUL-472-r3/scripts/report.ts`
- `reports/performance/MUL-472-r3-report.md`
- `reports/performance/MUL-472-r3-report.html`

未访问 209，未运行 frontend/e2e，未抓 trace/HAR，未改后端或 Wiki，未调整零跳动口径。服务和浏览器均为本任务独立实例，fixture 认证值只在内存中生成/传递。原 31px 身份切换证据保留在上一轮 MUL-472-rework-* 报告，不删改。报告包含原始逐帧与网络采样，可从附带数据下载。

