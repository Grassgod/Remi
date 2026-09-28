import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const out = resolve(import.meta.dir, "..");
const repo = resolve(out, "../../..");
const main = "b95dd2fa5e301588ba1e04aa9bacc370240d664c";
const codeHead = "ca53b9a581fb91e3d64cf2ba9dfd1ebd88fe7678";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const read = (name: string) => JSON.parse(readFileSync(resolve(out, `MUL-472-r4-${name}.json`), "utf8"));
const data = {
  before: read("before-timing"), after: read("after-timing"), audit: read("key-audit"),
  beforeLong: read("before-long"), afterLong: read("after-long"),
  beforePath: read("before-hot-path"), afterPath: read("after-hot-path"),
  beforeOpen: read("before-chat-open"), afterOpen: read("after-chat-open"),
};
const after = [...data.after.results, ...data.afterLong.results];
for (const round of after) {
  if (!round.firstVisibleMs || !round.readyMs || round.violations || round.jump1500.jumpCount
    || round.jumpAtReady.count || round.fixedAnchorShiftPx || round.fixedAnchorShift3000Px
    || round.disconnectedFrames || round.gatedRequests.some((q: { afterFirstMs: number }) => q.afterFirstMs <= 0)) {
    throw new Error(`Invalid after evidence: ${round.name}/${round.mode}/${round.round}`);
  }
}
if (data.after.results.length !== 16 || data.afterLong.results.length !== 2
  || data.audit.unresolvedOperations.length || data.audit.observers.some((r: { category: string }) => r.category === "待逐项核对")
  || data.afterPath.hotTotal > data.beforePath.hotTotal) throw new Error("Incomplete evidence or hot-request regression");
if (data.afterOpen.firstVisibleMs !== null || data.afterOpen.requests.some((q: { afterClickMs: number }) => q.afterClickMs < 0)) throw new Error("Chat interaction did not bypass the closed gate correctly");
if (git("rev-parse", `${codeHead}:packages/server`) !== git("rev-parse", `${main}:packages/server`)
  || git("rev-parse", `${codeHead}:frontend/scripts/perf/lib/jump-recorder.ts`) !== git("rev-parse", `${main}:frontend/scripts/perf/lib/jump-recorder.ts`)) throw new Error("Backend or recorder changed");
const mutation = stripVTControlCharacters(readFileSync("/tmp/MUL-472-r4-mutation-final.log", "utf8"));
const historicalMutation = stripVTControlCharacters(readFileSync("/tmp/MUL-472-r4-historical-only-mutation.log", "utf8"));
const pickerBefore = stripVTControlCharacters(readFileSync("/tmp/MUL-472-r4-project-cold-diagnostic.log", "utf8"));
const logs = Object.fromEntries(["frontend", "typecheck", "tsc", "gate", "focused-final", "arch-recorder", "docs-check", "docs-test", "eslint"].map(name =>
  [name, stripVTControlCharacters(readFileSync(`/tmp/MUL-472-r4-${name}.log`, "utf8"))]));
const files = [...new Set(git("log", "--first-parent", "--no-merges", "--format=", "--name-only", `7df3cc68..${codeHead}`)
  .split("\n").filter(file => file && !file.startsWith("reports/")))].sort();
const reportFiles = readdirSync(out).filter(name => name.endsWith(".json")).map(name => `reports/performance/MUL-472-r4/${name}`)
  .concat(["audit", "fixture", "probe", "report", "run", "check-report"].map(name => `reports/performance/MUL-472-r4/scripts/${name}.ts`),
    ["reports/performance/MUL-472-r4-report.html", "reports/performance/MUL-472-r4-report.md"]);
const fmt = (value: number) => Number.isFinite(value) ? value.toFixed(1) : "-";
const esc = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const table = (heads: string[], rows: unknown[][], id = "") => `<div class="table-wrap"><table${id ? ` id="${id}"` : ""}><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const mdTable = (heads: string[], rows: unknown[][]) => [
  `| ${heads.join(" | ")} |`, `| ${heads.map(() => "---").join(" | ")} |`,
  ...rows.map(row => `| ${row.map(cell => String(cell).replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`),
].join("\n");
const groups = [["issues", "cold"], ["issues", "warm"], ["inbox", "cold"], ["inbox", "warm"], ["detail", "cold"], ["detail", "warm"], ["MUL-454", "cold"], ["MUL-454", "warm"]];
const groupRows: unknown[][] = [], timingHtml: string[] = [], timingMd: string[] = [];
for (const [name, mode] of groups) {
  const rounds = after.filter(r => r.name === name && r.mode === mode);
  const label = `${name} ${mode === "cold" ? "冷" : "热"}`;
  const first = rounds.map(r => fmt(r.firstVisibleMs)).join(" / ");
  const requests = rounds.flatMap(r => r.gatedRequests);
  groupRows.push([label, rounds.length, first, requests.length ? `${fmt(Math.min(...requests.map(q => q.afterFirstMs)))} .. ${fmt(Math.max(...requests.map(q => q.afterFirstMs)))}` : "无新请求（缓存）", "0 / 0", 0]);
  const paths = [...new Set<string>(requests.map(q => q.path))];
  const heads = ["被门控请求", ...rounds.map(r => `r${r.round} 发起 ms（首行后 ms）`)];
  const rows = paths.map(path => [path, ...rounds.map(r => r.gatedRequests.filter(q => q.path === path)
    .map(q => `${fmt(q.t)} (+${fmt(q.afterFirstMs)})`).join("; ") || "无新请求")]);
  timingHtml.push(`<h3>${esc(label)} · n=${rounds.length}</h3><p>首行 ${esc(first)}ms；固定锚点 ${esc(rounds[0].anchor)}。</p>${rows.length ? table(heads, rows) : "<p>观察窗内没有新的门控请求。</p>"}`);
  timingMd.push(`### ${label}\n\n首行 ${first}ms；锚点 ${rounds[0].anchor}。\n\n${rows.length ? mdTable(heads, rows) : "无新门控请求（缓存）。"}`);
}
const policy: Record<string, string> = {
  agents: "壳层 presence 等首次 gate；页面附属每次 gate；筛选/分组主体、聊天打开不延后。",
  squads: "presence/姓名/头像/选择器的附属列表等 gate；squad 主体与已打开交互保留立即读取。",
  snapshot: "presence/行指示等 gate；agentRunningFilter 输入立即读取，pending 保持加载。",
  pins: "AppSidebar 会话 gate；IssueActions / ProjectDetail 附属各自 gate。",
  invitations: "AppSidebar 会话 gate；InvitationsPage 的邀请主体立即读取。",
  cli: "侧栏提示会话 gate；运行环境的显式升级/主体不延后。",
  summary: "导航会话 gate；Inbox attention 等本页 gate；未挂载桌面 badge 也列出。",
  workbench: "侧栏合并 count 会话 gate；主看板状态列表是另一个 key。",
  childProgress: "附属完成度等页面 gate；详情子任务主体独立 key，不延后。",
  issueDetail: "PinRow 会话 gate；搜索/聊天 recents 仅打开；当前详情、用户打开父单选择器不延后。",
  projectDetail: "PinRow 会话 gate；聊天 recents 仅打开；当前项目主体不延后。",
  sessions: "ChatFab 会话 gate；ChatWindow 可见后立即订阅。",
  aggregatePending: "ChatFab 会话 gate；SessionDropdown 为 chatVisible || shellGateOpen。",
  messagesPage: "ChatWindow 可见；隐藏 startReached 不调用 fetchNextPage；重试来自用户操作。",
  pendingTask: "ChatWindow 可见；缓存存在不代表 observer active。",
  taskMessages: "两个聊天消息 observer 只在 visible；详情 SessionAgentStreamRow 主体与打开的 TranscriptButton 不等首屏 gate。",
  humanRequests: "聊天表单只在 chatVisible；详情 AgentLiveCard 默认 enabled 保持。",
  members: "聊天提及候选只在 chatVisible；同 key 的权限/成员主体 observer 保持原条件。",
  projectList: "聊天提及候选只在 chatVisible；同 key 的项目主体/分组输入 observer 保持原条件。",
};
const familyRows = Object.entries(data.audit.families).map(([key, shape]) => [key, JSON.stringify(shape),
  data.audit.observers.filter(r => r.keys.includes(key)).length, data.audit.sources.filter(r => r.keys.includes(key)).length, policy[key]]);
const observerRows = data.audit.observers.map(r => [`${r.keys.join(", ")}\n${JSON.stringify(r.keyShapes)}`, `${r.file}:${r.line}\n${r.owner}`, r.operation, r.category, r.reason, r.expression]);
const sourceRows = data.audit.sources.map(r => [`${r.file}:${r.line}`, r.owner, r.keys.join(", "), r.closedGate, r.expression]);
const refetchRows = data.audit.explicitRefetches.filter(r => r.keys.length).map(r => [`${r.file}:${r.line}`, r.owner, r.keys.join(", "), r.expression,
  r.operation === "fetchOlderMessages" ? "隐藏时回调 visible=false，0 请求；可见后正常分页。" : "主体重试或可见控件的用户操作；隐藏的不可见按钮没有自动调用来源。"]);
const countRows = groups.filter(([name]) => name !== "MUL-454").map(([name, mode]) => {
  const b = data.before.results.filter(r => r.name === name && r.mode === mode), a = data.after.results.filter(r => r.name === name && r.mode === mode);
  return [`${name} ${mode}`, b.map(r => r.firstScreenRequests).join(" / "), a.map(r => r.firstScreenRequests).join(" / "), b.map(r => r.requests.length).join(" / "), a.map(r => r.requests.length).join(" / ")];
});
const openRows = data.afterOpen.requests.map(q => [q.path, fmt(q.t), fmt(q.afterClickMs)]);
const checks = [
  ["env -u MULTIREMI_TOKEN bunx tsc --noEmit", "exit 0"],
  ["env -u MULTIREMI_TOKEN bun run typecheck:frontend", "ui/core/views/web exit 0"],
  ["env -u MULTIREMI_TOKEN bun run test:frontend --testTimeout 20000", "core 1087 + views 2459 + web 55 = 3601 pass；18 existing skip；0 fail"],
  ["core gate / QA unmount / realtime tasks，--testTimeout 20000", "26 pass；原 22 个 gate 用例全部通过"],
  ["views shell / message-list / human-request-dock / issue stream，--testTimeout 20000", "36 pass；含两个 QA 负控、打开聊天正控、详情主体正控和分页守卫"],
  ["env -u MULTIREMI_TOKEN bun test tests/arch/ tests/unit/scripts/perf-jump-recorder.test.ts --timeout 20000", "231 pass / 0 fail = 108 arch + 123 recorder"],
  ["npm run docs:check；npm run docs:test", "exit 0；13 pass"],
  ["修改的前端文件 eslint", "0 error / 0 warning"],
  ["按 key audit.ts", `379 个查询操作；167 个匹配 observer；${data.audit.sources.length} 个 invalidate 来源；0 unresolved`],
  ["真实 Chromium 六场景 + 210 评论长样本", "18 轮 recorder / 固定 Element 1.5s、3s 均 0px；0 提前请求"],
  ["HTML desktop / mobile / sandbox 预览", "167 行筛选正常；无横向溢出或脚本错误；原始数据下载含 16+2 轮"],
  ["报告脚本 eslint；凭证和连接串模式扫描", "仓库 base config 0 error / 0 warning；MUL-472 全部产物 0 hits"],
];
const scope = `仅修第四轮 B1 与同类隐藏 observer。实际 main / before=${main}；merge=0c727a2a8e0808b727a5612f346c9eb6ba90bc00，无冲突。产品/测试提交=${codeHead}；frontend tree=${git("rev-parse", `${codeHead}:frontend`)}。最终报告提交 head 和该 SHA 的 CI 6/6 核对记录随交付评论列出，PR #297 保持 Draft。`;
const fix = "隐藏 ChatWindow 仍挂载缓存消息，任务 id 合法就会使 observer active；462 的合法 degraded header invalidate 因而触发 refetch。ChatMessageList 的 live 和 AssistantMessage 两处改为 visible && 原条件，ChatWindow 传实际 chatVisible。隐藏仅 stale，重开立即读取 stale，打开时 header 正常 refetch。没有使用 visible || shellGateOpen；角标/完成状态由已门控的 aggregate pending 和 WS 缓存更新承担，不依赖隐藏的 transcript 查询。";
const closure = "按 key 审计另补 HumanRequestDock 的 enabled=chatVisible（详情默认 true），以及隐藏虚拟列表 startReached 的 visible 条件，避免命令式 fetchNextPage 绕过 enabled。扩展到 19 组 key 的冷壳层守卫又定位到无缓存会话时隐藏 WorkLocationPicker 的项目候选：ChatWindow 传 projectsEnabled=chatVisible，其他可见选择器默认 true。修前守卫 1 fail，修后恢复全绿；成员/项目同 key 的必要权限、主体读取明确列为不门控。未改 gate registry、aggregate pending、462 实现、服务端、正式 recorder 或阈值。";
const method = "同机 Chromium 146 / 1440×900，隔离内存 SQLite，before/after 均使用 main b95dd2fa 的服务端和正式 recorder；附属响应延迟 900ms，主体列表 300ms。冷新 context；热真实 click、核对目标路由后固定原 Element。issues/detail 各 n=3 冷+3热，inbox n=2 冷+2热；MUL-454 210 条合成正文取自 QA 附件，仅重新放入本地 fixture，冷/热各 n=1。正式 ready/500ms quiet、1.5s recorder 及固定 Element 3s 交叉验证均保留。before detail cold r1 编译/机器负载 13120.1ms 原始值留档，不当 p75。未访问 209、未跑 frontend/e2e、未抓 trace/HAR。";
const guard = "真实 DashboardLayout + ChatFab + ChatWindow（仅隔离 WS 传输），给 19 组 key 全部预置缓存，包括 messagesPage/pendingTask、PinRow details、聊天 recents、任务消息、人工请求、成员和项目候选。使用库自带 VirtuosoMockContext 提供 jsdom 尺寸，并断言缓存的历史回复行实际挂载；其 task id 与 pending 一致，live observer 被已持久化回复抑制，因此通用守卫直接覆盖嵌套 AssistantMessage，QA 原负控另覆盖 live observer。逐 key invalidate，再经真实 createTaskHandlers 发送合法 degraded header：gate 前 QueryCache fetch 事件=0。gate 后壳层请求正常，隐藏消息/表单/候选仍 inactive；打开后立即取 stale。另有无缓存会话的隐藏项目候选守卫、live/assistant 独立用例、隐藏分页回调以及详情 degraded-header 正控。";
const audit = `不是 factory 白名单：TypeScript checker 解析全仓 runtime 调用的 queryKey tuple、别名、spread、useQueries map、命令式调用。19 个相关 key 家族的全部 observer 列在下表；所有 379 个查询操作及 ${data.audit.allInvalidationOperations.length} 个 invalidate/refetchQueries 操作（包括范围外的 key）也完整保存在 JSON，解析遗漏=0。${data.audit.sources.length} 处相关来源均为 invalidateQueries 默认 active；没有 refetchQueries 或 refetchType=all 调用。enabled=false 的隐藏 observer 不 active，只置 stale；必要主体和已打开交互例外逐项列出，不对其施加附属 gate。`;
const path = `新 fixture 的完整链路（含冷进入 issues）${data.beforePath.total}→${data.afterPath.total}：初入 ${data.beforePath.initialIssues}→${data.afterPath.initialIssues}，热 inbox ${data.beforePath.inboxLeg}→${data.afterPath.inboxLeg}，热 detail ${data.beforePath.detailLeg}→${data.afterPath.detailLeg}。纯热两段 ${data.beforePath.hotTotal}→${data.afterPath.hotTotal}。旧报告 51→50 是完整链路，23→23 才是纯热；第三轮 53→52 / 25→25 是旧 fixture 参考，均不充当本轮 b95dd2fa 基线。593ff2ba 原首屏 27→22 / 19→15 / 36→35 保留为历史参考。新增非空聊天任务会触发 aggregate pending 轮询，本轮逐请求原样保留，不混用观察窗。`;
const manual = [
  ["realtime/sync/prefix-refresh.ts:30", "predicate invalidateSquadMemberStatusQueries", "只匹配 squads/.../members-status；不匹配被延后的 squads 静态 list key。"],
  ["issues/components/agent-live-card.tsx", "api.listTaskMessages", "详情主体 hydration；可见任务执行数据不门控，无隐藏 ChatWindow 调用。"],
  ["runtimes/components/machine-cli-update.tsx", "api.getLatestCliVersion", "运行环境升级主体；模块缓存，不是冷首屏侧栏提示 observer。"],
  ["auth callback / login", "api.listMyInvitations", "认证/加入工作区主体流程，不是隐藏壳层。"],
  ["chatKeys.messages legacy", "全仓 key inventory", "没有 runtime observer；实际窗口用 messagesPage，不因旧 factory 名漏算。"],
];
const verification = { main, codeHead, frontendTree: git("rev-parse", `${codeHead}:frontend`), checks, logs, mutation, historicalMutation, pickerBefore,
  observerCount: data.audit.observers.length, sourceCount: data.audit.sources.length, manual, files, reportFiles };
writeFileSync(resolve(out, "MUL-472-r4-verification.json"), JSON.stringify(verification, null, 2));
const raw = JSON.stringify({ ...verification, ...data }).replaceAll("<", "\\u003c");
const body = `<header><p>MUL-472 · PR #297 · 第四轮返工</p><h1>隐藏缓存 observer 的 refetch 门控</h1><p>${esc(scope)}</p></header><main>
<section><h2>B1 与同类收口</h2><p>${esc(fix)}</p><p>${esc(closure)}</p><p>位置：chat-message-list.tsx:97、132、265；chat-window.tsx 的消息列表、表单与 WorkLocationPicker 传参；common/human-request-dock.tsx:25；runtime-workspace-picker.tsx 的项目 query。</p><details><summary>扩展守卫定位项目候选旁路的修前输出</summary><pre>${esc(pickerBefore)}</pre></details></section>
<section><h2>按 key 的分类与全仓清单</h2><p>${esc(audit)}</p>${table(["key 家族", "tuple", "observer 数", "invalidate 数", "分类及依据"], familyRows)}<label>检索全部 observer <input id="search" type="search"></label><p id="count">${observerRows.length} / ${observerRows.length}</p>${table(["key", "文件 / owner", "操作", "分类", "依据", "完整表达式"], observerRows, "observers")}</section>
<section><h2>invalidate 与命令式 refetch 来源</h2><p>以下逐条覆盖 realtime handlers、mutation onSuccess/onSettled、协调器和组件回调；task-messages 唯一 invalidate 来源是 tasks.ts 的合法 degraded header，真实处理器负控和正控都已覆盖。普通 streaming header 仅更新已 hydrated cache，不发请求。</p>${table(["来源位置", "handler / callback", "触及 key", "gate 关闭时行为", "完整表达式"], sourceRows)}<h3>显式 refetch / fetchNextPage</h3>${table(["位置", "owner", "key", "调用", "门控关闭时行为"], refetchRows)}<h3>predicate 与裸 API</h3>${table(["位置", "来源", "依据"], manual)}<p>扫描脚本：reports/performance/MUL-472-r4/scripts/audit.ts；命令：env -u MULTIREMI_TOKEN bun reports/performance/MUL-472-r4/scripts/audit.ts。</p></section>
<section><h2>缓存 invalidate 守卫与变异</h2><p>${esc(guard)}</p><p>去掉两处消息 observer 的 visible 条件，5 fail / 11 pass：QA 关闭后 active=true；QA 初始隐藏请求=1；全壳层守卫捕获 task-messages 两次 fetch；live / assistant 独立负控请求=1。额外仅去掉 AssistantMessage 的 visible 条件，整壳层守卫也单独变红：1 fail / 5 skip，捕获两次 task-messages fetch。两次执行后均立即还原，定向 36/36、全套 3601/3601 通过。</p><details><summary>最终变异原始输出</summary><pre>${esc(mutation)}</pre></details><details><summary>仅历史 observer 变异原始输出</summary><pre>${esc(historicalMutation)}</pre></details></section>
<section><h2>六场景与 MUL-454 长样本</h2><p>${esc(method)}</p>${table(["场景", "n", "首行 ms，各轮", "请求相对首行 ms", "recorder / 固定元素 px", "提前违例"], groupRows)}${timingHtml.join("")}</section>
<section><h2>用户主动打开聊天</h2><p>点击 ${fmt(data.afterOpen.clickMs)}ms，主体首行仍未出现，gate 未打开。pending 和消息页立即加载；任务消息需先取得 per-session pending 的 task id，因此晚于 pending 响应，但不等待首屏 gate。</p>${table(["请求", "发起 ms", "点击后 ms"], openRows)}</section>
<section><h2>同一 main 的前后对比</h2><p>${esc(path)}</p>${table(["场景", "首屏 before", "首屏 after", "3s观察窗 before", "3s观察窗 after"], countRows)}</section>
<section><h2>回归与提交范围</h2>${table(["检查", "结果"], checks)}<p>本机 Bun 1.3.14，所有 Bun 启动均去除宿主 MULTIREMI_TOKEN，测试超时 20000ms；没有贴近超时上限的失败。测试 helper 首次静态跨包导入触发 TS6059，已改为真实模块动态导入，最终四包类型检查通过，不改变 core 公共 API。</p><h3>本轮非 merge 代码文件，截至 ${codeHead.slice(0, 8)}</h3><ul>${files.map(file => `<li><code>${esc(file)}</code></li>`).join("")}</ul><h3>报告提交文件</h3><ul>${reportFiles.map(file => `<li><code>${esc(file)}</code></li>`).join("")}</ul><p>server tree 与 main 同为 86e9b53438870c6331e678fe3a4eac470b20176b；正式 recorder blob 同为 69d5d56cf766446449bd9a7a9209b5d1f4928f50。最终 head / CI 按 SHA 的结果见交付评论。</p></section>
<section><h2>原始证据</h2><p>完整 before/after 请求、固定锚点 rAF、正式 recorder 帧、审计表达式和测试输出均内嵌；无外部脚本、字体、样式、存储依赖。浏览器 fixture 只在本机隔离内存运行，随机认证值仅传子进程环境，不记录到产物。</p><button id="download" type="button">下载原始证据 JSON</button></section></main>`;
writeFileSync(resolve(out, "../MUL-472-r4-report.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUL-472 第四轮返工</title><style>
*{box-sizing:border-box}body{margin:0;color:#202629;background:white;font:14px/1.65 system-ui,sans-serif;letter-spacing:0}header,main{max-width:1380px;margin:auto;padding:24px}header{border-bottom:3px solid #217e63}h1{font-size:28px;margin:6px 0}h2{font-size:21px;margin:0 0 12px}h3{font-size:16px;margin:20px 0 8px}p,li{overflow-wrap:anywhere}section{padding:24px 0;border-bottom:1px solid #d4dcdf}.table-wrap{width:100%;overflow:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #d5dfe1;padding:10px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#edf4f1}td{min-width:130px}code,pre{font:12px/1.55 ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;background:#f2f5f6;padding:12px}input,button{font:inherit;border:1px solid #829b95;border-radius:4px;padding:8px;max-width:100%}button{background:#217e63;color:white;cursor:pointer}summary{cursor:pointer;color:#217e63}[hidden]{display:none!important}@media(max-width:600px){header,main{padding:16px}h1{font-size:24px}td,th{padding:8px}}
</style></head><body>${body}<script id="raw" type="application/json">${raw}</script><script>
document.getElementById('search').addEventListener('input',event=>{let count=0;for(const row of document.querySelectorAll('#observers tbody tr')){row.hidden=!row.textContent.toLowerCase().includes(event.target.value.toLowerCase());if(!row.hidden)count++}document.getElementById('count').textContent=count+' / ${observerRows.length}'});
document.getElementById('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([document.getElementById('raw').textContent],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='MUL-472-r4-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
</script></body></html>`);
writeFileSync(resolve(out, "../MUL-472-r4-report.md"), [
  "# MUL-472 第四轮返工", scope, "## B1", fix, closure,
  "## 按 key 扫描与来源", audit, mdTable(["key", "tuple", "observer", "invalidate", "分类依据"], familyRows),
  `完整 167 observer、${data.audit.sources.length} invalidate、11 显式 refetch 与 379 查询操作 inventory 见 HTML / key-audit.json，逐项保留原表达式、位置、enabled 条件和依据。`,
  mdTable(["位置", "额外来源", "依据"], manual), "## 守卫与变异", guard,
  `\`\`\`text\n${mutation}\n\`\`\``, "仅移除历史 AssistantMessage 的 visible 条件，通用守卫也变红；立即还原。",
  `\`\`\`text\n${historicalMutation}\n\`\`\``, "## 时序与位移", method,
  mdTable(["场景", "n", "首行 ms", "请求首行后 ms", "recorder / 固定元素 px", "违例"], groupRows), ...timingMd,
  "## 主动打开聊天", `点击 ${fmt(data.afterOpen.clickMs)}ms，主列表未出现，gate 未开。`, mdTable(["请求", "发起 ms", "点击后 ms"], openRows),
  "## 同 main 对比", path, mdTable(["场景", "首屏 before", "首屏 after", "观察窗 before", "观察窗 after"], countRows),
  "## 回归", mdTable(["检查", "结果"], checks), "## 非 merge 提交文件", files.concat(reportFiles).map(file => `- \`${file}\``).join("\n"), "",
].join("\n\n"));
console.log(JSON.stringify({ report: "MUL-472-r4-report.html", afterRounds: after.length, observers: observerRows.length, sources: sourceRows.length }));
