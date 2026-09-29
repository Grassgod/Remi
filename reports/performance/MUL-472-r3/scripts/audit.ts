import { writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "../../../../node_modules/typescript/lib/typescript.js";

const repo = resolve(import.meta.dir, "../../../..");
const factories = new Set([
  "pendingChatTasksOptions", "pendingChatTaskOptions", "chatSessionsOptions", "chatMessagesPageOptions",
  "agentListOptions", "squadListOptions", "agentTaskSnapshotOptions", "pinListOptions",
  "myInvitationListOptions", "latestCliVersionOptions", "inboxSummaryOptions",
  "childIssueProgressOptions", "workbenchPendingCountOptions", "issueDetailOptions", "projectDetailOptions",
]);
const observers = new Set(["useQuery", "useSuspenseQuery", "useInfiniteQuery", "useQueries", "useSuspenseQueries",
  "prefetchQuery", "ensureQueryData", "fetchQuery", "QueryObserver", "QueriesObserver"]);
const calls: Array<{ file: string; line: number; factory: string; observer: string | null; owner: string; expression: string }> = [];
const imperative: Array<{ file: string; line: number; operation: string; expression: string }> = [];
const glob = new Bun.Glob("frontend/**/*.{ts,tsx}");
for await (const file of glob.scan({ cwd: repo })) {
  if (/node_modules|\.next|\.test\./.test(file)) continue;
  const source = ts.createSourceFile(file, await Bun.file(resolve(repo, file)).text(), ts.ScriptTarget.Latest, true);
  const nameOf = (node: ts.Expression) => ts.isPropertyAccessExpression(node) ? node.name.text : node.getText(source);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ["prefetchQuery", "ensureQueryData", "fetchQuery"].includes(nameOf(node.expression))) {
      imperative.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        operation: nameOf(node.expression), expression: node.getText(source) });
    }
    if (ts.isCallExpression(node) && factories.has(nameOf(node.expression))) {
      let parent: ts.Node | undefined = node.parent;
      let observer: string | null = null;
      let owner = "module";
      let expression = node.getText(source);
      while (parent) {
        if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && observers.has(nameOf(parent.expression))) {
          observer = nameOf(parent.expression);
          expression = parent.getText(source);
        }
        if (ts.isFunctionDeclaration(parent)) {
          owner = parent.name?.text ?? "anonymous";
          break;
        }
        if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isCallExpression(parent.initializer)
          && ["memo", "forwardRef"].includes(nameOf(parent.initializer.expression))) {
          owner = parent.name.getText(source);
          break;
        }
        parent = parent.parent;
      }
      calls.push({ file: relative(repo, resolve(repo, file)), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        factory: nameOf(node.expression), observer, owner, expression });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
calls.sort((a, b) => a.factory.localeCompare(b.factory) || a.file.localeCompare(b.file) || a.line - b.line);

function classify(call: typeof calls[number]): { category: string; reason: string } {
  const { owner, factory, expression } = call;
  const shell = (reason: string) => ({ category: "外壳", reason });
  const page = (reason: string) => ({ category: "页面级", reason });
  const primary = (reason: string) => ({ category: "不门控（主体）", reason });
  const interaction = (reason: string) => ({ category: "不等首屏 gate（交互）", reason });
  if (owner === "ChatFab") return shell("跨路由常驻；sessions/aggregate pending 都等待 shell gate。");
  if (owner === "SessionDropdown") return { category: "外壳 / 交互优先", reason: "隐藏窗口常驻；chatVisible || shellGateOpen。两处调用均传 chatVisible，用户打开立即加载。" };
  if (owner === "AppSidebar" || owner === "PinRow") return shell("侧栏跨路由常驻；shellGateOpen。PinRow 详情还检查 item_type 和 detailsEnabled。");
  if (owner === "useWorkspacePresencePrefetch") return shell("WorkspacePresencePrefetch 跨路由常驻；warmChildSurfaces 来自 shell gate。");
  if (owner === "useMyRuntimesNeedUpdate") return shell("唯一调用方 AppSidebar 传 shellGateOpen；runtime 更新角标非主体数据。");
  if (owner === "useWorkbenchPendingCount") return shell("唯一调用方 AppSidebar 传 shellGateOpen；combined total 的独立 pending-count key。");
  if (owner === "useInboxUnreadCount") return page("InboxPage 唯一调用方传本页 afterFirstScreen；summary 不决定 inbox 主列表。");
  if (owner === "useInboxAttentionUnreadCount") return { category: "外壳 / 原生调用例外", reason: "AppSidebar 传 shellGateOpen；useDesktopUnreadBadge 默认立即订阅，但全仓无挂载调用，web 壳层不使用它。" };
  if (owner === "useWorkspacePresenceMap" || owner === "useAgentPresenceDetail") return page("agents 与 snapshot 同时使用 snapshotEnabled ?? gateOpen；现有行/头像调用保持门控。");
  if (owner === "useActorName") return { category: "页面级 / 主体例外", reason: "默认 gateOpen；仅 assignee board/swimlane 的列标题显式 agentsEnabled/squadsEnabled=true（主体分组名称）。" };
  if (owner === "useIssueActions" || (owner === "ProjectDetail" && factory === "pinListOptions")) return page("页面挂载的 pin 工具栏状态非主体；userId && afterFirstScreen。ProjectDetail 的遗漏在本轮 R1 observer 审计中补齐。");
  if (["ExecutionLogSection", "ActorSubContent", "AssigneePicker", "IssueAgentActivityIndicator"].includes(owner)
    || (owner === "IssueDetail" && factory === "agentListOptions")) return page("页面附属名称、在线点或执行信息；afterFirstScreen。");
  if (["IssuesPage", "MyIssuesPage", "ProjectIssuesContent", "WorkspaceAgentWorkingChip"].includes(owner)) {
    if (factory === "agentTaskSnapshotOptions") return { category: "页面级 / 筛选必需例外", reason: "默认等本页 gate；running-agent 筛选启用时立即请求，pending 显示加载态且不发布就绪标记。" };
    if (factory === "childIssueProgressOptions") return page("页面行附属 child-progress；afterFirstScreen。");
  }
  if (owner === "ChatWindow" || owner === "useWorkspaceAgentAvailability") return interaction("窗口常驻但隐藏时 enabled=chatVisible；打开后立即加载 sessions/messages page/per-session pending/agents。");
  if (owner === "useChatContextItems") {
    return expression.includes("recentsEnabled")
      ? interaction("最近上下文 useQueries 的 recentsEnabled 由 ChatWindow 传 chatVisible；隐藏时关闭。")
      : primary("当前路由的 issue/project 上下文共用主体 detail key；只匹配实际路由，不为最近记录预载。");
  }
  if (owner === "SearchCommand") return expression.includes("enabled: open")
    ? interaction("最近 20 条 issue 详情只在搜索面板 open 后启用。")
    : primary("当前详情路由的命令共用主 issue detail key；currentIssueId 存在时加载。");
  if (owner === "InvitationsPage") return primary("邀请页面自己的主列表，不是侧栏附属提示。");
  if (owner === "useUpdatableRuntimeIds") return primary("唯一调用方 RuntimesPage 需要最新 CLI 版本来构成 runtime 更新列表。");
  if (owner === "useWorkspaceActivityMap") return primary("AgentsPage/ActivityTab 的主体 activity 图依赖 agent 集合。");
  const interactive = new Set(["AgentActivityHoverContent", "AgentLivePeekCard", "AgentProfileCard", "MemberProfileCard",
    "SquadProfileCard", "ActorIssuesPanel", "CurrentIssueRow", "AutopilotDialog", "AgentPicker", "CreateSquadModal",
    "AgentCreatePanel", "DeleteRuntimeDialog", "AddChildIssueModal", "ManualCreatePanel"]);
  if (interactive.has(owner)) return interaction("用户打开的 profile/peek、picker 或 modal 才挂载；是该交互的主体数据。");
  const primaryOwners = new Set(["AgentDetailPage", "AgentsPage", "DashboardPage", "RuntimeDetail", "RuntimeList",
    "RuntimesPage", "CostByBlock", "SkillDetailPage", "SkillsPage", "SquadDetailPage", "SquadsPage", "ActivityTab",
    "WorkbenchPage", "IssueChip", "IssueCreationRelationSection", "IssueDetail", "AutopilotDetailPage", "ProjectChip", "ProjectDetail"]);
  if (primaryOwners.has(owner)) return primary("当前页面/可见对象的主体数据或渲染输入；不属于附属首屏延后。详情主 key 与 PinRow 的不同 id 逐项区分。");
  throw new Error(`Unclassified observer: ${factory} ${owner} ${call.file}:${call.line}`);
}

const classified = calls.map((call) => ({ ...call, ...classify(call) }));
writeFileSync(resolve(import.meta.dir, "../MUL-472-r3-observers.json"), JSON.stringify({
  scope: "all frontend runtime TypeScript, excluding tests/build/dependencies; AST calls plus direct API/key audit in report",
  calls: classified,
  imperative,
  directApiExceptions: [
    { file: "frontend/apps/web/app/(auth)/login/page.tsx:43", operation: "api.listMyInvitations", reason: "认证完成后的入口路由选择必需；不在 dashboard 壳层。" },
    { file: "frontend/apps/web/app/auth/callback/page.tsx:76", operation: "api.listMyInvitations", reason: "OAuth 完成后的入口路由选择必需；不在 dashboard 壳层。" },
    { file: "frontend/packages/views/runtimes/components/update-section.tsx:42", operation: "api.getLatestCliVersion", reason: "MachineCliUpdate 的版本比较；当前 runtime 更新 UI 主体，10 分钟模块缓存，不是 sidebar key observer。" },
  ],
  keyAudit: "aggregate pending 仅 ChatFab/SessionDropdown 两个 observer；其他 key 的裸调用为定义、缓存读取/写入或 invalidate，另有依赖选择器在用户点击后 fetchQuery 父单链（交互优先），没有冷首屏命令式预取旁路。chatMessagesOptions 无 runtime observer。",
}, null, 2));
console.log(JSON.stringify({ calls: classified.length, imperative: imperative.length, factories: [...factories] }));
