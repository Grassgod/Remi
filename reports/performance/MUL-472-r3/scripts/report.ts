import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const out = resolve(import.meta.dir, "..");
const repo = resolve(out, "../../..");
const main = "36fb03c47eba7914be7a4d026f19e360b83a0f83";
const beforeHead = main;
const reworkBeforeHead = "89de3ef030afaad121c08dd6068e22c9986d012f";
const browserCodeHead = "a5b1d899de5cb20215ccae21eabee099148644de";
const codeHead = browserCodeHead;
const frontendTree = "34246cab00e5d7680a962b146d62146383d8dce9";
const read = (name: string) => JSON.parse(readFileSync(resolve(out, `MUL-472-r3-${name}.json`), "utf8"));
const data = {
  before: read("before-timing"), after: read("after-timing"), observers: read("observers"),
  beforeReturn: read("rework-before-hot-return"), afterReturn: read("after-hot-return"),
  initialReturn: read("initial-hot-return"),
  beforePath: read("before-hot-path"), afterPath: read("after-hot-path"),
};
for (const round of data.after.results) {
  if (round.violations || round.jump1500.jumpCount || round.jumpAtReady.count || round.fixedAnchorShiftPx || round.fixedAnchorShift3000Px || round.disconnectedFrames) {
    throw new Error(`Nonzero after measurement: ${round.name}/${round.mode}/${round.round}`);
  }
}
for (const round of data.afterReturn.results) {
  if (round.jump.jumpCount || round.fixedAnchorShiftPx || round.disconnectedFrames || round.gatedRequests.some((q: any) => q.afterFirstMs <= 0)) {
    throw new Error(`Nonzero hot return measurement: ${round.round}`);
  }
}
if (data.afterPath.hotTotal > data.beforePath.hotTotal) throw new Error("Hot navigation request regression");
if (data.after.results.length !== 16 || data.observers.calls.length !== 95) throw new Error("Incomplete evidence");
const mutations = Object.fromEntries(["R1", "R1-cache", "R2", "project-pin"].map((name) => [name,
  stripVTControlCharacters(readFileSync(`/tmp/MUL-472-r3-mutation-${name}.log`, "utf8")),
]));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commits = git("log", "--first-parent", "--no-merges", "--format=%H", "275422a6..HEAD").split("\n").filter(Boolean)
  .map((sha) => ({ sha, subject: git("show", "-s", "--format=%s", sha), files: git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n") }));
const reportFiles = readdirSync(out).filter((name) => name.endsWith(".json")).map((name) => `reports/performance/MUL-472-r3/${name}`)
  .concat(["audit", "fixture", "probe", "run", "report"].map((name) => `reports/performance/MUL-472-r3/scripts/${name}.ts`),
    ["reports/performance/MUL-472-r3-report.md", "reports/performance/MUL-472-r3-report.html"]);
const checks = [
  ["env -u MULTIREMI_TOKEN bunx tsc --noEmit", "exit 0"],
  ["env -u MULTIREMI_TOKEN bun run typecheck:frontend", "ui/core/views/web exit 0"],
  ["env -u MULTIREMI_TOKEN bun run test:frontend", "core 1085 pass; views 2452 pass / 18 existing skip; web 55 pass; 0 fail"],
  ["core: vitest run platform/use-after-first-screen.test.tsx platform/mul472-qa-unmount.test.tsx", "22 pass = original 16 + new 6"],
  ["views: vitest run shell-deferred-queries / session-dropdown / chat-window-project / project-detail", "41 pass (4 files)"],
  ["bun test tests/arch/ tests/unit/scripts/perf-jump-recorder.test.ts --timeout 20000", "228 pass / 0 fail = 105 arch + 123 recorder"],
  ["npm run docs:check", "exit 0"],
  ["npm run docs:test", "13 pass / 0 fail"],
  ["Changed frontend files: eslint", "0 errors; ProjectDetail's existing exhaustive-deps warning remains"],
  ["Report scripts: repository base eslint config", "0 errors / 0 warnings"],
  ["HTML preview and JSON download", "1440x900 + 390x844: 95 audit rows, no page overflow or script errors; download contains 16 rounds / 95 observers"],
  ["Credential / connection pattern scan", "0 matching files"],
];
const fmt = (n: number) => Number.isFinite(n) ? n.toFixed(1) : "-";
const esc = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const table = (heads: string[], rows: unknown[][], raw = false) => `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${raw ? String(cell) : esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const mdTable = (heads: string[], rows: unknown[][]) => [
  `| ${heads.join(" | ")} |`, `| ${heads.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map((c) => String(c).replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`),
].join("\n");
const labels: Record<string, string> = { issues: "issues", inbox: "inbox", detail: "detail-short", cold: "冷", warm: "热" };
const groupRows: unknown[][] = [];
const timingBlocks: string[] = [];
const timingMarkdown: string[] = [];
for (const name of ["issues", "inbox", "detail"]) for (const mode of ["cold", "warm"]) {
  const rounds = data.after.results.filter((r: any) => r.name === name && r.mode === mode);
  const first = rounds.map((r: any) => fmt(r.firstVisibleMs)).join(" / ");
  const allGated = rounds.flatMap((r: any) => r.gatedRequests);
  groupRows.push([`${labels[name]} ${labels[mode]}`, rounds.length, first,
    allGated.length ? `${fmt(Math.min(...allGated.map((r: any) => r.afterFirstMs)))} .. ${fmt(Math.max(...allGated.map((r: any) => r.afterFirstMs)))}` : "无新门控请求（缓存）",
    "0 / 0", "0"]);
  const paths = [...new Set<string>(allGated.map((r: any) => r.path))];
  const heads = ["被门控请求", ...rounds.map((r: any) => `r${r.round} 发起 ms（首行后 ms）`)];
  const rows = paths.map((path) => [path, ...rounds.map((r: any) => r.gatedRequests.filter((q: any) => q.path === path)
    .map((q: any) => `${fmt(q.t)} (+${fmt(q.afterFirstMs)})`).join("; ") || "无新请求")]);
  timingBlocks.push(`<h3>${labels[name]} ${labels[mode]} · n=${rounds.length}</h3><p>首行 ${first}ms；固定锚点 ${esc(rounds[0].anchor)}。</p>${rows.length ? table(heads, rows) : "<p>壳层保持已开启，缓存命中；目标观察窗内无新的门控请求。</p>"}`);
  timingMarkdown.push(`### ${labels[name]} ${labels[mode]} (n=${rounds.length})\n\n首行 ${first}ms；锚点 ${rounds[0].anchor}。\n\n${rows.length ? mdTable(heads, rows) : "无新门控请求（缓存）。"}`);
}
const countRows = ["issues", "inbox", "detail"].flatMap((name) => ["cold", "warm"].map((mode) => {
  const b = data.before.results.filter((r: any) => r.name === name && r.mode === mode);
  const a = data.after.results.filter((r: any) => r.name === name && r.mode === mode);
  return [`${labels[name]} ${labels[mode]}`, b.map((r: any) => r.firstScreenRequests).join(" / "),
    a.map((r: any) => r.firstScreenRequests).join(" / "), b.map((r: any) => r.requests.length).join(" / "), a.map((r: any) => r.requests.length).join(" / ")];
}));
const returnRows = [data.beforeReturn, data.afterReturn].flatMap((d) => d.results.map((r: any) => [
  d.phase, r.round, fmt(r.firstVisibleMs), r.gateIdleFires?.map((q: any) => fmt(q.t)).join(" / ") || "-",
  r.gateIdleAfterFirstMs?.map(fmt).join(" / ") || "-", r.gatedRequests.length ? r.gatedRequests.map((q: any) => `${q.path} ${fmt(q.t)}`).join("; ") : "无新请求（缓存）", r.fixedAnchorShiftPx,
]));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const returnBeforeMedian = median(data.beforeReturn.results.flatMap((r: any) => r.gateIdleAfterFirstMs));
const returnAfterMedian = median(data.afterReturn.results.flatMap((r: any) => r.gateIdleAfterFirstMs));
const initialBeforeMedian = median(data.initialReturn.before.results.flatMap((r: any) => r.gateIdleAfterFirstMs));
const initialAfterMedian = median(data.initialReturn.after.results.flatMap((r: any) => r.gateIdleAfterFirstMs));
const pendingBefore = data.before.results.filter((r: any) => r.mode === "cold").map((r: any) => [
  `${labels[r.name]} r${r.round}`, fmt(r.firstVisibleMs), ...r.gatedRequests.filter((q: any) => q.path === "/api/chat/pending-tasks").flatMap((q: any) => [fmt(q.t), fmt(q.afterFirstMs)]),
]);
const categories = Object.entries(data.observers.calls.reduce((acc: Record<string, number>, call: any) => {
  acc[call.category] = (acc[call.category] ?? 0) + 1; return acc;
}, {}));
const auditRows = data.observers.calls.map((call: any) => `<tr data-category="${esc(call.category)}"><td><code>${esc(call.factory)}</code><br>${esc(call.observer)}</td><td><code>${esc(call.file)}:${call.line}</code><br>${esc(call.owner)}</td><td>${esc(call.category)}</td><td>${esc(call.reason)}<details><summary>实际 observer</summary><pre>${esc(call.expression)}</pre></details></td></tr>`).join("");
const imperativeRows = data.observers.imperative.map((call: any) => [
  `${call.file}:${call.line}`, call.operation, call.expression.includes("notificationPreferenceOptions") ? "通知偏好必需查询，与延后 key 不同"
    : call.file.endsWith("issue-dependency-editor.tsx") ? "用户打开依赖选择器时读取父单链，交互优先；不是冷首屏预取"
      : "workspaceList 骨架查询，与延后 key 不同",
]);
const fileHtml = commits.map((commit) => `<h3>${esc(commit.sha.slice(0, 8))} · ${esc(commit.subject)}</h3><ul>${commit.files.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul>`).join("");
const fileMarkdown = commits.map((commit) => `### ${commit.sha.slice(0, 8)} ${commit.subject}\n\n${commit.files.map((file) => `- \`${file}\``).join("\n")}`).join("\n\n");
const scope = "仅修 R1 observer 旁路和 R2 页面卸载生命周期；轮询、已读重试、计数算法、fallback 2000ms、正文就绪定义及测速契约均保持。长样本 210/250 评论沿用 QA 第二轮结论，本轮不声称重新运行。";
const overview = `正式 before=${beforeHead}（实际合入的 main，locked detached worktree），after 浏览器及回归代码=${codeHead}，前后使用同一 main，正式 recorder/selectors 含 MUL-414 更新，fixture 参数相同；最终报告提交的 head 和 CI 见交付评论，其 frontend tree 为 ${frontendTree}。实际 merge 为 093989ea（dd560871）、69d60a46（60c057be）、a5b1d899（36fb03c4）。另建返工前 ${reworkBeforeHead}，仅用于 R2 同路径热返回：从合并结果移除本轮 8 个文件的改动，保留所有 MUL-414 语义，tree=69c03ad301d843f9033691d9d16f5dfb682b578b；它不是正式请求数/零跳动 before。旧 main 的测量数字不作为本轮基线。`;
const conflicts = [
  ["issue-detail.tsx", "成员查询、agents、loading 及终态 publisher", "保留 414 membersQuery 与成员/子单 pending 加载条件；保留 472 agents 门控和空/失败终态 publisher，正文就绪仍由 Main reveal 后发布"],
  ["issue-detail-main.test.tsx", "测试 wrapper 与上下文", "同时提供 QueryClientProvider 和 NavigationProvider；保留 414 控件/强制开始测试与 472 reveal/门控测试"],
  ["use-issue-actions.test.tsx", "imports、beforeEach", "同时保留 ApiError/toast 与 gate helpers；异步 beforeEach 设置 414 user 身份并打开 472 受控 gate，两侧测试均保留"],
  ["core/realtime/sync/chat.test.ts", "query key imports", "同时导入 414 issueKeys 与 472 chatKeys/pendingChatTasksOptions，保留全部测试"],
];
const semanticMerges = [
  ["issue-detail-main.tsx", "414 decisions/dependencies 主体查询、固定 h10 提示槽、决策/等待/强制开始控件均保留；472 reveal 后发布就绪仍在"],
  ["core/api/endpoints/issues.ts", "414 strictIssueDetailSchema、决策/授权/依赖接口均保留；未手工改变后端协议"],
  ["core/issues/queries.ts", "414 detailAll/decisions/dependencies key/options 与 472 childProgress enabled 均保留"],
  ["use-issue-actions.ts", "414 updateField onSuccess、状态错误处理和用户权限保留；472 pins 页级 enabled 保留"],
  ["scripts/perf/lib/selectors.ts", "414 inboxRowSelector 指定 inboxItemId 与 472 列表契约接入均保留；算法/阈值不变，本轮 before/after 均重测"],
];
const r1 = "SessionDropdown 采用 chatVisible || shellGateOpen；ChatWindow 的两处调用都传入 chatVisible。隐藏状态必须等待 shell gate，用户打开立即加载。全仓审计还发现 ProjectDetail 的 pin 工具栏 observer 未等待门控，已补 userId && afterFirstScreen；该图标不构成主列表。真实 DashboardLayout、AppSidebar、WorkspacePresencePrefetch、ChatFab、隐藏 ChatWindow 与其子组件一起挂载的 QueryClient 守卫，在 gate 前断言十组附属 API 0 次，放行后各 1 次；另记录所有延后 key 的 QueryCache fetch 事件，包括 child-progress、PinRow detail、聊天消息及 per-session pending，让没有专用 API spy 的新增 observer 也会变红。只隔离 WS 传输和平台导航，不替换任何 observer。";
const r2 = "registry 增加 publisher/consumer 计数；最后一个 publisher 卸载即结束该页面 visit，保留跨页 shellPassed。无 publisher 的路由由最后一个 consumer 释放。releaseRoute 清掉 fallback/idle，consumer 清掉 0ms arm timer，publisher 原有 cleanup 取消帧回调。idle/fallback/arm 回调检查 registry 对象身份，已排队的旧回调不能打开同 pathname 的新实例。不同 publisher 同时拥有一页时不会提前释放。";
const hotExplanation = `R2 专项比较返工前 ${reworkBeforeHead} 与返工后 ${codeHead}，两者均含 main ${main}；缓存热返回为 issues → inbox → issues，各 n=3。新 QueryClient 的 pending 重挂由 QA 原用例验证。浏览器热返回仍使用同一个 QueryClient 的缓存，表中逐条列出新门控请求；缓存命中无请求的轮次明确记为无新请求，不能捏造发起时间。首次测量 idle 首行后中位数 ${fmt(initialBeforeMedian)}→${fmt(initialAfterMedian)}ms，原始六轮全部保留在 initial-hot-return.json 和 HTML 下载数据中。为核对数十毫秒的 dev 波动，用已编译路由同参数再各跑三轮，得到 ${fmt(returnBeforeMedian)}→${fmt(returnAfterMedian)}ms。真实 next-dev 的忙碌时段仍由 requestIdleCallback 选择空闲；受控单测证明缓存就绪在下一帧加 idle 后放行，没有新增固定延迟。`;
const pathExplanation = `本轮完整链路（含冷进入 issues） ${data.beforePath.total}→${data.afterPath.total}；初入 issues ${data.beforePath.initialIssues}→${data.afterPath.initialIssues}，热 inbox ${data.beforePath.inboxLeg}→${data.afterPath.inboxLeg}，热 detail ${data.beforePath.detailLeg}→${data.afterPath.detailLeg}；纯热两段 ${data.beforePath.hotTotal}→${data.afterPath.hotTotal}。上一轮 main=0c2b3865 的 51→50 是完整链路，纯热仍为 23→23；不得把 51→50 称作纯热切页。旧 593ff2ba 的 27→22 / 19→15 / 36→35 只作历史参考，不与本轮不同 main 的数字直接比较。`;
const measurement = "同机本地内存 SQLite API、Chromium 1440×900、Next dev 预热路由；issues/inbox/detail-short 的 cold+warm n=3/2/3 共 16 轮。冷相对文档导航，热相对实际 click，目标路由匹配后锁定固定 Element；1.5s 正式 recorder 和固定元素采样，另连续 3s 核对固定元素不移动/断开。使用仓库 installRecorderOnContext/profilesFor/computeJumps/computeRoundMeasurement（quiet=500ms），未改算法或阈值。fixture pin=1、邀请=1、CLI=999.0.0、workbench=2，延后响应 900ms、主列表响应 300ms。gated() 本轮纳入 aggregate pending、sessions、PinRow 详情。所有新门控请求均严格晚于目标首行；无新请求表示缓存/壳层常驻，并非将请求清单排除。";
const tests = "QA patch 的两个原始 remount 断言收进 platform/mul472-qa-unmount.test.tsx；首值在 render 内记录。另测卸载取消 idle（并手动调用旧回调）、帧/兜底取消、多 publisher 所有权、缓存下一帧 idle 和 shell 不关闭。原 16 gate 用例不改验收断言。SessionDropdown 缺 gate 的变异使真实全壳守卫 1 fail：expected listPendingChatTasks not to be called, got 1；补 QueryCache 断言后再变异仍 1 fail：expected [['chat','ws-1','pending-tasks']] to deeply equal []。删除 releaseRoute cleanup 使 6 fail，其中 QA 两项为 expected true to be false、expected queryFn not to be called, got 1。ProjectDetail pin 去 gate 的额外变异 1 fail：expected last call false, got true。全部还原后 gate 22/22、相关 views 41/41，补守卫后完整前端全套再次通过。变异的 skipped 来自 -t 定向选择，无新增 skip。";
const security = "未访问 209，未运行 frontend/e2e，未抓 trace/HAR，未改后端或 Wiki，未调整零跳动口径。服务和浏览器均为本任务独立实例，fixture 认证值只在内存中生成/传递。原 31px 身份切换证据保留在上一轮 MUL-472-rework-* 报告，不删改。报告包含原始逐帧与网络采样，可从附带数据下载。";
const raw = { main, beforeHead, reworkBeforeHead, browserCodeHead, codeHead, frontendTree, ...data, mutations, checks, commits, conflicts, semanticMerges, reportFiles };
const rawJson = JSON.stringify(raw).replaceAll("<", "\\u003c");
const body = `<header><p class="eyebrow">PR #297 · Draft · 第三轮返工</p><h1>MUL-472</h1><p>内容就绪门控：隐藏聊天 observer、同路径卸载重挂</p><p class="result">16 轮：0px · 0 门控违例；QA 原用例 + 新守卫全部通过</p></header>
<main>
<section><h2>同步 main 与冲突解决</h2><p>${esc(overview)}</p>${table(["冲突文件", "区域", "解决方式"], conflicts)}${table(["自动合并文件", "语义复核"], semanticMerges)}<p>四处均保留两边功能，没有进行取舍；合并后的前端全套单测通过。</p></section>
<section><h2>范围与基线</h2><p>${esc(scope)}</p><p>${esc(overview)}</p></section>
<section><h2>R1：共享 key 的全部 observer</h2><p>${esc(r1)}</p><p>改动位置：session-dropdown.tsx:133；chat-window.tsx 两处 SessionDropdown；project-detail.tsx:488；shell-deferred-queries.test.tsx 的 complete shell observer guard。</p><details><summary>修复前 aggregate pending 提前请求（同一 main）</summary>${table(["冷场景", "首行 ms", "pending ms", "相对首行 ms"], pendingBefore)}</details></section>
<section><h2>R2：页面 visit 的卸载清理</h2><p>${esc(r2)}</p><p>改动位置：core/platform/use-after-first-screen.ts 的 releaseRoute、publisher layout cleanup、consumer cleanup 和回调身份检查；新增 mul472-qa-unmount.test.tsx。</p></section>
<section><h2>六场景时序</h2><p>${esc(measurement)}</p>${table(["场景", "n", "首行 ms（各轮）", "门控请求在首行后 ms", "recorder / 固定元素 px", "违例"], groupRows)}${timingBlocks.join("")}</section>
<section><h2>同路径缓存热返回</h2><p>${esc(hotExplanation)}</p>${table(["代码", "轮", "首行 ms", "idle ms", "首行后 idle ms", "门控请求", "px"], returnRows)}</section>
<section><h2>请求数与名称</h2><p>${esc(pathExplanation)}</p>${table(["场景", "首屏 before（各轮）", "首屏 after", "观察窗 before", "观察窗 after"], countRows)}<p>首屏以现有 recorder 的 ready/500ms quiet 定义统计；观察窗到首行后 3s。before 的每个冷场景 pending observer 都提前，after 把同一请求移动到首行之后，总量不增加。</p></section>
<section><h2>全仓 observer 清单</h2><p>扫描全部 frontend runtime TypeScript（排除 tests/build/node_modules），15 个 factory 的 95 个调用点。每行保留准确条件和组件归属；同 factory 不等于同用途，当前详情主体 key、分组/筛选输入及用户打开的工具单独分类。</p>${table(["分类", "调用点"], categories)}
<div class="filters"><label>分类 <select id="category"><option value="">全部</option>${categories.map(([category]) => `<option>${esc(category)}</option>`).join("")}</select></label><label>检索 <input id="search" type="search"></label><span id="count">95 / 95</span></div>
<div class="table-wrap"><table id="audit"><thead><tr><th>查询 / observer</th><th>位置 / 组件</th><th>分类</th><th>条件与依据</th></tr></thead><tbody>${auditRows}</tbody></table></div>
<h3>命令式查询、裸 API 与 key 搜索</h3>${table(["位置", "操作", "结论"], imperativeRows)}${table(["位置", "裸 API", "依据"], data.observers.directApiExceptions.map((c: any) => [c.file, c.operation, c.reason]))}<p>${esc(data.observers.keyAudit)} 没有 runtime useSuspenseQuery/useSuspenseQueries、prefetchQuery 或自建 QueryObserver/QueriesObserver 调用；七个 fetchQuery/ensureQueryData 分别属于 workspaceList、notificationPreference 和用户打开依赖选择器后的父单读取。</p><p>useActorName 的立即例外仅 board-view.tsx:145–146、swimlane-view.tsx:483–484；useDesktopUnreadBadge 只导出未挂载。WorkspaceAvailability 仅 ChatWindow 调用并传 chatVisible；summary、CLI 和 workbench 的壳层 helper 唯一有效调用方均为 AppSidebar。</p></section>
<section><h2>测试与变异</h2><p>${esc(tests)}</p>${Object.entries(mutations).map(([name, log]) => `<details><summary>${esc(name)} 变异原始失败输出</summary><pre>${esc(log)}</pre></details>`).join("")}${table(["命令", "结果"], checks)}</section>
<section><h2>本轮非 merge 文件</h2>${fileHtml}<h3>报告提交</h3><ul>${reportFiles.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul><p>main merge 带入的后端/其他单文件不计入手工改动；packages/server tree 与 main 相同，jump-recorder.ts blob 与 main 相同（69d5d56cf766446449bd9a7a9209b5d1f4928f50）。</p></section>
<section><h2>原始数据</h2><p>${esc(security)}</p><button id="download-data" type="button">下载本轮原始数据 JSON</button></section>
</main>`;
writeFileSync(resolve(out, "../MUL-472-r3-report.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUL-472 第三轮返工</title><style>
*{box-sizing:border-box}body{margin:0;color:#202426;background:#fff;font:14px/1.65 system-ui,sans-serif;letter-spacing:0}header,main{max-width:1280px;margin:auto;padding:24px}header{border-bottom:2px solid #187b6b}h1{font-size:30px;margin:4px 0}h2{font-size:21px;margin:0 0 12px}h3{font-size:16px;margin:20px 0 8px}p{margin:10px 0;overflow-wrap:anywhere}.eyebrow{color:#687277;font-size:12px}.result{color:#146d52;font-weight:600}section{padding:26px 0;border-bottom:1px solid #d8dfe0}code,pre{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere}pre{white-space:pre-wrap;word-break:break-word;max-height:480px;overflow:auto;background:#f4f6f7;padding:12px}.table-wrap{max-width:100%;overflow:auto;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;background:#edf4f3}td,th{padding:10px;border:1px solid #d5dedc;vertical-align:top;overflow-wrap:anywhere}td:first-child{min-width:140px}#audit td:nth-child(2){min-width:190px}#audit td:nth-child(4){min-width:250px}details{margin:10px 0}summary{cursor:pointer;color:#176f61}button,select,input{font:inherit;max-width:100%;padding:7px 10px;border:1px solid #9fb5af;border-radius:4px;background:#fff;color:#202426}button{background:#176f61;color:white;cursor:pointer}.filters{display:flex;align-items:center;gap:16px;flex-wrap:wrap}ul{padding-left:20px}li{overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:600px){header,main{padding:16px}h1{font-size:26px}td,th{padding:8px}section{padding:22px 0}.filters label{width:100%}.filters input,.filters select{width:100%}}
</style></head><body>${body}<script id="raw" type="application/json">${rawJson}</script><script>
const category=document.getElementById('category'),search=document.getElementById('search');
function filter(){let count=0;for(const row of document.querySelectorAll('#audit tbody tr')){const show=(!category.value||row.dataset.category===category.value)&&row.textContent.toLowerCase().includes(search.value.toLowerCase());row.hidden=!show;if(show)count++}document.getElementById('count').textContent=count+' / 95'}
category.addEventListener('change',filter);search.addEventListener('input',filter);
document.getElementById('download-data').addEventListener('click',()=>{const blob=new Blob([document.getElementById('raw').textContent],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='MUL-472-r3-evidence.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
</script></body></html>`);
const md = [
  "# MUL-472 第三轮返工", scope, overview,
  "## 同步 main 与冲突解决", mdTable(["冲突文件", "区域", "解决方式"], conflicts),
  mdTable(["自动合并文件", "语义复核"], semanticMerges),
  "## R1", r1, "## R2", r2, "## 六个冷热场景", measurement,
  mdTable(["场景", "n", "首行 ms", "门控请求首行后 ms", "recorder / 固定元素 px", "违例"], groupRows),
  timingMarkdown.join("\n\n"), "## 同路径热返回", hotExplanation,
  mdTable(["代码", "轮", "首行 ms", "idle ms", "首行后 idle ms", "门控请求", "px"], returnRows),
  "## 请求数", pathExplanation,
  mdTable(["场景", "首屏 before", "首屏 after", "观察窗 before", "观察窗 after"], countRows),
  "## Observer 分类", "完整 95 项、7 个命令式调用和 3 个裸 API 例外见附件 HTML 与 MUL-472-r3-observers.json；每项含位置、实际表达式、分类及依据。",
  mdTable(["分类", "调用点"], categories), mdTable(["命令式查询位置", "操作", "依据"], imperativeRows),
  "## 测试与变异", tests, mdTable(["命令", "结果"], checks),
  Object.entries(mutations).map(([name, log]) => `### ${name}\n\n\`\`\`text\n${log}\n\`\`\``).join("\n\n"),
  "## 非 merge 提交", fileMarkdown, "报告提交：",
  reportFiles.map((file) => `- \`${file}\``).join("\n"), security, "",
].join("\n\n");
writeFileSync(resolve(out, "../MUL-472-r3-report.md"), md);
console.log(JSON.stringify({ report: "MUL-472-r3-report.html", rounds: data.after.results.length, observers: data.observers.calls.length, returnBeforeMedian, returnAfterMedian }));
