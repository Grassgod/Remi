#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DATA_PATH = resolve(ROOT, "reports/performance/MUL-176-api-route-baseline.json");
const OUTPUT_PATH = resolve(ROOT, "reports/performance/MUL-176-api-route-audit.html");

interface Result {
  router: string;
  method: string;
  path: string;
  representative: boolean;
  status: number;
  sqlCount: number;
  p50Ms: number;
  p95Ms: number;
  responseBytes: number;
  repeatedBuckets: Array<{ sql: string; params: unknown[]; count: number }>;
  topSql: Array<{ sql: string; count: number }>;
}

interface Baseline {
  meta: Record<string, any>;
  results: Result[];
  indexes: Array<{ name: string; tableName: string; sql: string | null }>;
  queryPlans: Array<{ name: string; sql: string; plan: string[] }>;
  indexExperiments: Array<{ name: string; index: string; sql: string; before: string[]; after: string[] }>;
}

const data = await Bun.file(DATA_PATH).json() as Baseline;

const causeByPath: Record<string, string> = {
  "/api/workspaces/local/repos": "remote git I/O on GET",
  "/api/multiremi/issues/iss_snapshot": "N+1 + unbounded payload",
  "/api/multiremi/issues": "N+1 task summary + unbounded",
  "/api/agents": "double skills hydration N+1",
  "/api/issues/iss_snapshot/comments": "N+1 + unbounded",
  "/api/issues/iss_snapshot/timeline": "N+1 + unbounded",
  "/api/multiremi/issues/iss_snapshot/comments": "N+1 + unbounded",
  "/api/multiremi/issues/iss_snapshot/timeline": "N+1 + unbounded",
  "/api/issues/iss_snapshot/task-runs": "N+1 + unbounded",
  "/api/issues/iss_snapshot/active-task": "N+1 + unbounded",
  "/api/issues/iss_snapshot/sessions/ise_snapshot/tasks": "N+1 + JS filter",
  "/api/issues/search?q=benchmark&workspace_id=local": "N+1 + JS filter",
  "/api/multiremi/tasks": "unbounded + payload",
  "/api/issues/iss_snapshot": "repeated row",
  "/api/multiremi/daemons/dmn_snapshot/retirement-plan?workspace_id=local": "query fan-out",
  "/api/multiremi/agents?workspaceId=local": "N+1",
  "/api/issues?workspace_id=local": "unbounded",
  "/api/issues/grouped?workspace_id=local&limit=50": "unbounded + JS paging",
  "/api/runtimes/rt_snapshot/task-activity": "unbounded scan",
  "/api/multiremi/tasks/tsk_snapshot/inspection": "query fan-out",
};

const unbounded = [
  ["issues", "GET /api/issues", "issues-repo.ts:312", "默认 limit=∞；SELECT workspace 全量后返回", "workspace issues"],
  ["issues", "GET /api/multiremi/issues", "routers/issues.ts:293", "无默认 limit；逐 issue 读取 tasks 汇总", "workspace issues × tasks per issue"],
  ["issues", "GET /api/multiremi/issues/:id", "routers/issues.ts:649", "组合返回全部 comments/tasks/activity/dependencies", "comments + tasks + activity per issue"],
  ["issues", "GET /api/issues/grouped", "issues-repo.ts:348", "先 listIssues(limit:undefined)，再在 JS 分组/截取", "workspace issues"],
  ["issues", "GET /api/issues/search", "issues-repo.ts:684", "加载全局 issues，再逐 issue 搜评论，最后 JS slice", "global issues × issue comments"],
  ["issues", "GET /api/issues/:id/comments", "issues-repo.ts:1664", "先加载并 hydrate issue 全部 comments，再做 session/filter/page", "comments per issue"],
  ["issues", "GET /api/issues/:id/timeline", "issues-repo.ts:1842", "全量 comments/activity；session 过滤在 JS", "comments + activity per issue"],
  ["issues", "GET /api/issues/:id/task-runs", "routers/issues.ts:744", "返回 issue 全部 tasks；queued task 逐行查 blocker", "tasks per issue"],
  ["tasks", "GET /api/multiremi/tasks", "tasks-repo.ts:734", "SELECT 全表，无 workspace/limit", "global tasks"],
  ["agents", "GET /api/agents/:id/tasks", "tasks-repo.ts:741", "agent tasks 全量返回", "tasks per agent"],
  ["agents", "workspace task snapshot", "tasks-repo.ts:750", "先 listTasks 全表，再 JS workspace/status 过滤", "global tasks"],
  ["tasks", "GET task messages", "tasks-repo.ts:1625", "仅 sinceSeq，无 page size/上限", "messages per task over time"],
  ["agents", "GET /api/*/agents", "agents-skills-repo.ts:676", "agents 全表；native route 再 JS workspace 过滤", "global agents"],
  ["skills", "GET /api/*/skills", "agents-skills-repo.ts:507", "workspace skills 无上限", "skills per workspace"],
  ["chat", "GET chat sessions", "chat-repo.ts:122", "workspace/user sessions 无 limit", "chat sessions per user/workspace"],
  ["chat", "GET chat messages", "chat-repo.ts:206", "session messages 全量", "messages per chat session"],
  ["chat", "pending chat tasks", "chat-repo.ts:185", "listTasks 全表后 JS filter", "global tasks"],
  ["projects", "GET /api/*/projects", "projects-repo.ts:161", "workspace projects 全量 + issue counts", "projects × issues per workspace"],
  ["projects", "GET /api/projects/search", "projects-repo.ts:168", "先 listProjects 全量，再 JS filter/slice", "projects per workspace"],
  ["projects", "resources/docs", "projects-repo.ts:384 / :548", "project 子资源/文档无分页", "resources/docs per project"],
  ["workspaces", "GET /api/workspaces", "workspaces-repo.ts:422", "workspaces 全表", "workspaces visible to user"],
  ["members", "GET workspace members", "workspaces-repo.ts:127", "workspace members 全量", "members per workspace"],
  ["invitations", "GET invitations", "workspaces-repo.ts:882 / :904", "workspace/current-user invitations 全量", "invitations per workspace/user"],
  ["tokens", "GET access tokens", "access-tokens-repo.ts:93", "workspace non-task tokens 全量", "tokens per workspace"],
  ["agent-plugins", "plugins/versions/bindings", "agent-plugins-repo.ts:86 / :289 / :363", "各层列表均无分页", "plugins per workspace/version/binding"],
  ["autopilots", "GET autopilots/deliveries", "autopilots-repo.ts:227 / :1392", "workspace autopilots、delivery 列表无分页", "autopilots/deliveries per workspace"],
  ["labels/inbox", "GET labels / inbox", "issues-repo.ts:1942 / :2060", "workspace labels/member inbox 全量", "labels per workspace / inbox over time"],
  ["sessions", "sessions/participants/events/results", "issue-sessions-repo.ts:121 / :199 / :250 / :384", "产品 session 四层列表均无 page size", "sessions per issue and events over time"],
  ["archives", "GET issue session archives", "session-archives-repo.ts:90", "issue archives 全量", "archives per issue over time"],
  ["runtimes", "GET runtimes/models", "runtimes-repo.ts:324 / :863", "runtimes 全局列表、models per runtime 无分页", "global runtimes / models per runtime"],
  ["squads", "GET squads", "squads-repo.ts:78", "workspace squads 全量", "squads per workspace"],
  ["pins", "GET pins", "projects-repo.ts:318", "user/workspace pins 全量", "pins per user/workspace"],
  ["feishu", "sources/chats/outcomes", "feishu-ingest-repo.ts:179 / :525 / :542", "sources/chats/outcomes 无分页；messages/proposals 已分页", "Feishu sources/chats/outcomes"],
];

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function badge(value: string): string {
  const cls = value.includes("已验证") ? "ok" : value.includes("建模") ? "warn" : "muted";
  return `<span class="badge ${cls}">${esc(value)}</span>`;
}

function routeRows(rows: Result[], includeRank = true): string {
  return rows.map((row, index) => `<tr>
    ${includeRank ? `<td class="num">${index + 1}</td>` : ""}
    <td><span class="tag">${esc(row.router)}</span></td>
    <td><code>${esc(row.method)}</code></td>
    <td class="num">${row.status}</td>
    <td class="path"><code>${esc(row.path)}</code></td>
    <td class="num strong">${row.sqlCount.toLocaleString()}</td>
    <td class="num">${row.p50Ms.toFixed(3)}</td>
    <td class="num">${row.p95Ms.toFixed(3)}</td>
    <td class="num">${bytes(row.responseBytes)}</td>
    <td>${esc(causeByPath[row.path] ?? (row.sqlCount >= 10 ? "query fan-out" : "baseline"))}</td>
  </tr>`).join("");
}

const slowTop = [...data.results].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 20);
const sqlTop = [...data.results].sort((a, b) => b.sqlCount - a.sqlCount || b.p95Ms - a.p95Ms).slice(0, 20);
const representatives = data.results.filter((row) => row.representative).sort((a, b) => a.router.localeCompare(b.router));
const repeated = data.results.flatMap((row) => row.repeatedBuckets.map((bucket) => ({ row, bucket })));
const timeline = data.results.find((row) => row.path.endsWith("/timeline"))!;
const comments = data.results.find((row) => row.path.endsWith("/comments"))!;
const taskRuns = data.results.find((row) => row.path.endsWith("/task-runs"))!;
const issueSearch = data.results.find((row) => row.path.startsWith("/api/issues/search"))!;
const nativeIssue = data.results.find((row) => row.path === "/api/multiremi/issues/iss_snapshot")!;
const nativeIssueList = data.results.find((row) => row.path === "/api/multiremi/issues")!;
const compatAgents = data.results.find((row) => row.path === "/api/agents")!;
const workspaceRepos = data.results.find((row) => row.path === "/api/workspaces/local/repos")!;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MUL-176 API 路由耗时与查询计划审计</title>
<style>
:root{--ink:#182026;--muted:#66717a;--line:#dce2e6;--soft:#f5f7f8;--red:#b42318;--redbg:#fff1ef;--amber:#946200;--amberbg:#fff8db;--green:#176b4d;--greenbg:#eaf8f1;--teal:#0f6b78;--white:#fff}*{box-sizing:border-box}body{margin:0;background:var(--white);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}header{border-bottom:1px solid var(--line);background:#11191d;color:#fff;padding:38px max(24px,calc((100vw - 1240px)/2)) 32px}header h1{font-size:30px;line-height:1.2;margin:0 0 10px;letter-spacing:0}header p{max-width:900px;color:#c7d0d5;margin:0}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.meta span{border:1px solid #425059;padding:5px 9px;border-radius:4px;color:#e9eef1}nav{position:sticky;top:0;z-index:3;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);padding:9px max(24px,calc((100vw - 1240px)/2));display:flex;gap:18px;overflow:auto}nav a{color:#394850;text-decoration:none;white-space:nowrap;font-size:13px}main{max-width:1240px;margin:auto;padding:24px}section{padding:22px 0 30px;border-bottom:1px solid var(--line)}h2{font-size:21px;margin:0 0 14px}h3{font-size:15px;margin:18px 0 8px}.lead{font-size:15px;color:#3f4c53;max-width:920px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}.metric{border:1px solid var(--line);border-radius:6px;padding:14px;background:var(--soft)}.metric b{display:block;font-size:24px;line-height:1.2}.metric span{color:var(--muted);font-size:12px}.finding{display:grid;grid-template-columns:80px 1fr;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.finding:first-of-type{border-top:0}.sev{font-weight:700;color:var(--red)}.finding p{margin:0}.badge,.tag{display:inline-block;border-radius:4px;padding:2px 6px;font-size:12px;white-space:nowrap}.badge.ok{background:var(--greenbg);color:var(--green)}.badge.warn{background:var(--amberbg);color:var(--amber)}.badge.muted,.tag{background:#eef1f3;color:#4d5960}.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:6px}table{width:100%;border-collapse:collapse;min-width:900px}th{position:sticky;top:0;background:#edf1f3;text-align:left;font-size:12px;color:#46535b;padding:9px;border-bottom:1px solid var(--line)}td{padding:9px;border-bottom:1px solid #e8ecee;vertical-align:top}tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}.strong{font-weight:700}.path{max-width:410px;overflow-wrap:anywhere}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.callout{border-left:4px solid var(--amber);background:var(--amberbg);padding:12px 14px;margin:12px 0}.good{border-left-color:var(--green);background:var(--greenbg)}details{border:1px solid var(--line);border-radius:6px;margin:10px 0}summary{cursor:pointer;padding:10px 12px;font-weight:600}details .inside{padding:0 12px 12px}.plan{background:#11191d;color:#dbe5e9;padding:10px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}input{width:100%;max-width:420px;border:1px solid #aeb8be;border-radius:4px;padding:8px 10px;margin:0 0 10px}@media(max-width:760px){header{padding:26px 18px}header h1{font-size:24px}main{padding:16px}.metrics{grid-template-columns:1fr 1fr}.finding{grid-template-columns:1fr}nav{padding-left:16px}.tablewrap{margin-right:-16px;border-right:0;border-radius:6px 0 0 6px}}@media print{nav{display:none}details .inside{display:block}header{background:#fff;color:#111;padding:20px 0}header p,.meta span{color:#444}.meta span{border-color:#aaa}main{padding:0}.tablewrap{overflow:visible}table{font-size:10px}}
</style>
</head>
<body>
<header><h1>MUL-176 · API 路由耗时基线与索引/查询计划审计</h1><p>自上而下从 Hono 路由观察 SQL 放大、响应体积与执行计划。诊断资产，不含产品修复。</p><div class="meta"><span>Bun 1.3.14</span><span>SQLite :memory:</span><span>200 issues / 2,000 comments / 500 tasks / 50 agents</span><span>5 warmups + 30 samples</span><span>commit ${esc(data.meta.gitSha.slice(0, 12))}</span></div></header>
<nav><a href="#summary">结论</a><a href="#slow">慢路由</a><a href="#sql">SQL Top</a><a href="#indexes">索引计划</a><a href="#unbounded">无界查询</a><a href="#repeats">重复取行</a><a href="#cross">方向 1 对照</a><a href="#coverage">38 Router</a><a href="#limits">边界</a></nav>
<main>
<section id="summary"><h2>结论摘要</h2><p class="lead">SQLite 实测显示，最严重的路径主要由查询次数、无界响应或路由内外部 I/O 放大，而不是单条 SQL 慢。现有 comment 外键索引均被使用，无法修复 4N hydration；真正缺索引的热点集中在 tasks、project issue 聚合和列表排序。</p>
<div class="metrics"><div class="metric"><b>${nativeIssue.sqlCount.toLocaleString()}</b><span>native issue detail SQL</span></div><div class="metric"><b>${bytes(nativeIssue.responseBytes)}</b><span>native issue detail response</span></div><div class="metric"><b>${workspaceRepos.p95Ms.toFixed(1)} ms</b><span>repository GET p95</span></div><div class="metric"><b>${data.indexes.length}</b><span>SQLite runtime indexes inventoried</span></div></div>
<div class="finding"><div class="sev">P0</div><p>${badge("已验证")} <b>native issue detail 是最大组合放大器。</b> 2,000 comments 下 <code>GET /api/multiremi/issues/:id</code> 为 ${nativeIssue.sqlCount.toLocaleString()} SQL、p95 ${nativeIssue.p95Ms.toFixed(1)} ms、响应 ${bytes(nativeIssue.responseBytes)}；路由把 tasks、全部 hydrated comments、activity 等一起组装（<code>routers/issues.ts:649</code>）。</p></div>
<div class="finding"><div class="sev">P0</div><p>${badge("已验证")} <b>timeline/comments 延续 4N。</b> 2,000 条评论分别为 ${timeline.sqlCount.toLocaleString()} / ${comments.sqlCount.toLocaleString()} SQL，p95 ${timeline.p95Ms.toFixed(1)} / ${comments.p95Ms.toFixed(1)} ms，响应 ${bytes(timeline.responseBytes)} / ${bytes(comments.responseBytes)}。热点三条语句为 comment 主键取行 4,000 次、attachments 2,000 次、reactions 2,000 次（<code>issues-repo.ts:1664/:1842/:2547</code>）。</p></div>
<div class="finding"><div class="sev">P1</div><p>${badge("已验证·受控失败路径")} <b>repository GET 执行远端 Git I/O。</b> 缺 <code>default_branch</code> 的种子仓库使 <code>GET /api/workspaces/:id/repos</code> 每次触发 <code>git ls-remote</code>；9 SQL 但 p95 ${workspaceRepos.p95Ms.toFixed(1)} ms（<code>routers/workspaces.ts:297</code>、<code>helpers/repositories.ts:145/:267</code>）。这不是数据库慢，且已填 default branch 的正常路径不会触发。</p></div>
<div class="finding"><div class="sev">P1</div><p>${badge("已验证")} <b>native issue list 新 N+1。</b> 200 issues 下逐 issue 调 <code>listTasksForIssue</code>，共 ${nativeIssueList.sqlCount} SQL、p95 ${nativeIssueList.p95Ms.toFixed(1)} ms（<code>routers/issues.ts:293</code>）。</p></div>
<div class="finding"><div class="sev">P1</div><p>${badge("已验证")} <b>task-runs 新 N+1。</b> 500 tasks 中 125 queued，路由逐 task 调 <code>getTaskQueueBlocker</code>，共 129 SQL、p95 ${taskRuns.p95Ms.toFixed(1)} ms，并返回 ${bytes(taskRuns.responseBytes)}（<code>routers/issues.ts:744</code>、<code>tasks-repo.ts:145</code>）。</p></div>
<div class="finding"><div class="sev">P1</div><p>${badge("已验证")} <b>issue search 新 N+1。</b> 200 issues 触发 200 次 comment snippet 查询，总计 ${issueSearch.sqlCount} SQL；每条子查询命中现有 <code>(issue_id, created_at)</code> 索引，问题仍是逐 issue 调用（<code>issues-repo.ts:684/:733</code>）。</p></div>
<div class="finding"><div class="sev">P1</div><p>${badge("已验证")} <b>agents 两层 hydration。</b> native list 为 52 SQL；compat serializer 又逐 agent 调一次 <code>listAgentSkills</code>，compat list 达 ${compatAgents.sqlCount} SQL（<code>agents-skills-repo.ts:676/:693</code>、<code>wire/agents.ts:14/:42</code>）。</p></div>
<div class="finding"><div class="sev">P2</div><p>${badge("已验证")} <b>无界返回已成为独立成本。</b> <code>GET /api/multiremi/tasks</code> 仅 2 SQL，但 500 rows 已产生 ${bytes(data.results.find(r=>r.path==="/api/multiremi/tasks")!.responseBytes)} 响应；issue lists 在 200 rows 时约 115–119 KB。</p></div>
<div class="callout"><b>生产桥开销建模：</b>沿用 MUL-172 已验证的 207–378 µs/SQL 阻塞地板，native issue detail / timeline / comments 仅桥往返均约 1.66–3.04 s，native issue list 42.0–76.7 ms，issue search 41.8–76.4 ms，task-runs 26.7–48.8 ms；均不含真实 Postgres 查询和网络时间。此段是${badge("建模推算")}，不是生产实测。</div>
</section>

<section id="slow"><h2>最慢 Top 20</h2><p>按 SQLite p95 降序。耗时包含 <code>app.request()</code> 和响应体完整消费。</p><div class="tablewrap"><table><thead><tr><th>#</th><th>Router</th><th>Method</th><th>Status</th><th>Path</th><th class="num">SQL</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">Response</th><th>主因</th></tr></thead><tbody>${routeRows(slowTop)}</tbody></table></div></section>

<section id="sql"><h2>SQL 条数 Top 20</h2><p>同一请求内 statement 实际执行次数；SQL 文本与参数同时记录。</p><div class="tablewrap"><table><thead><tr><th>#</th><th>Router</th><th>Method</th><th>Status</th><th>Path</th><th class="num">SQL</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">Response</th><th>主因</th></tr></thead><tbody>${routeRows(sqlTop)}</tbody></table></div>
${[nativeIssue, timeline, comments, nativeIssueList, compatAgents, taskRuns, issueSearch, workspaceRepos].map(row=>`<details><summary>${esc(row.path)} · ${row.sqlCount.toLocaleString()} SQL</summary><div class="inside"><pre class="plan">${esc(row.topSql.slice(0,8).map(q=>`${q.count} × ${q.sql}`).join("\n"))}</pre></div></details>`).join("")}</section>

<section id="indexes"><h2>索引与查询计划</h2><div class="callout good"><b>已验证不是缺索引：</b>comments by issue/search snippet 使用 <code>idx_multiremi_issue_comments_issue(issue_id, created_at)</code>；attachments/reactions 使用各自 <code>comment_id</code> 索引。对 4N 路径继续加索引不会改变 SQL 数。</div>
<h3>临时索引前后对照（SQLite）</h3><div class="tablewrap"><table><thead><tr><th>候选索引</th><th>受益查询</th><th>Before</th><th>After</th><th>结论</th></tr></thead><tbody>${data.indexExperiments.map(e=>`<tr><td><code>${esc(e.index)}</code></td><td>${esc(e.name)}</td><td><code>${esc(e.before.join(" · "))}</code></td><td><code>${esc(e.after.join(" · "))}</code></td><td>${badge("已验证 SQLite")}</td></tr>`).join("")}</tbody></table></div>
<h3>热点计划</h3>${data.queryPlans.map(p=>`<details><summary>${esc(p.name)}</summary><div class="inside"><code>${esc(p.sql)}</code><pre class="plan">${esc(p.plan.join("\n"))}</pre></div></details>`).join("")}
<h3>现有索引清单</h3><p>内存库执行同一份 migration 后从 <code>sqlite_master</code> 枚举，共 ${data.indexes.length} 个非自动索引。</p><input id="indexFilter" placeholder="筛选表名或索引名" oninput="filterIndexes(this.value)"><div class="tablewrap"><table id="indexTable"><thead><tr><th>Table</th><th>Index</th><th>DDL</th></tr></thead><tbody>${data.indexes.map(i=>`<tr><td><code>${esc(i.tableName)}</code></td><td><code>${esc(i.name)}</code></td><td><code>${esc((i.sql??"").replace(/\s+/g," "))}</code></td></tr>`).join("")}</tbody></table></div></section>

<section id="unbounded"><h2>无界查询清单</h2><p>代码审计确认的 API 可达或 API 调用链上的无上限读取。消息/事件类增长维度尤其随时间单调增加。</p><div class="tablewrap"><table><thead><tr><th>域</th><th>路由/调用</th><th>位置</th><th>行为</th><th>增长维度</th></tr></thead><tbody>${unbounded.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>

<section id="repeats"><h2>单请求重复取同一行（≥3）</h2><p>按“规范化 SQL + 完整参数”精确分桶；不同 comment id 不会被误合并。</p><div class="tablewrap"><table><thead><tr><th>Route</th><th class="num">重复次数</th><th>SQL</th><th>参数</th></tr></thead><tbody>${repeated.map(({row,bucket})=>`<tr><td><code>${esc(row.path)}</code></td><td class="num strong">${bucket.count}</td><td><code>${esc(bucket.sql)}</code></td><td><code>${esc(JSON.stringify(bucket.params))}</code></td></tr>`).join("")}</tbody></table></div></section>

<section id="cross"><h2>与方向 1（MUL-175）对照</h2><div class="tablewrap"><table><thead><tr><th>路由层发现</th><th>方向 1 状态</th><th>对照结论</th></tr></thead><tbody>
<tr><td>native detail + timeline/comments 4N</td><td>MUL-175 issue 已列的已验证样本</td><td>${badge("已对上")} 2,000 comments 的 8,034 / 8,011 / 8,004 与每条 comment 4 SQL 一致；常数项来自路由额外 issue/tasks/labels/activity 查询。</td></tr>
<tr><td>native issue list 200 次 task 查询</td><td>MUL-175 尚未发布清单</td><td>${badge("路由新增")} 由 native response 在 <code>routers/issues.ts:293</code> 逐 issue 组装 task summary 触发。</td></tr>
<tr><td>issue search 200+1+1 SQL</td><td>MUL-175 尚未发布清单</td><td>${badge("路由新增")} 逐 issue 的 <code>searchIssueCommentSnippet</code> 是本审计新发现。</td></tr>
<tr><td>3 个 task collection endpoint 各约 125 blocker queries</td><td>MUL-175 尚未发布清单</td><td>${badge("路由新增")} task-runs / active-task / session tasks 都在 route map 中按 queued task 查 blocker。</td></tr>
<tr><td>agents 49 次 hydration；compat 再加 98 次</td><td>MUL-175 尚未发布清单</td><td>${badge("路由新增")} repo hydration 与 compat serializer 叠加后才显出 150 SQL。</td></tr>
<tr><td>repository GET p95 ${workspaceRepos.p95Ms.toFixed(1)} ms / 9 SQL</td><td>repo SQL N+1 审计不会覆盖远端 Git I/O</td><td>${badge("路由独有")} 缺 default branch 时 GET 内执行 <code>git ls-remote</code>；受控失败路径已验证。</td></tr>
<tr><td>方向 1 找到但路由层看不出影响</td><td>没有已发布 Session result</td><td>${badge("未验证")} 截至报告生成时无法诚实列举；需在 MUL-175 发布后补做最终差集。</td></tr>
</tbody></table></div></section>

<section id="coverage"><h2>路由覆盖</h2><p>每个 router 文件至少一个代表入口；同时机械枚举并扫测全部 ${data.meta.registeredGetRoutes - data.meta.websocketStatusOnlyRoutes} 个普通 GET endpoint，另保留带大种子条件的热点探针，共 ${data.meta.probes} probes。3 个 WebSocket upgrade 仅在黄金快照中记录状态，mutation 不做重复延迟压测。254 probes 返回 2xx，22 probes 因固定 fixture、权限或缺资源返回非 2xx；表内保留状态码，失败快路径只代表本地拒绝成本。</p><h3>38 Router 代表样本</h3><div class="tablewrap"><table><thead><tr><th>Router</th><th>Method</th><th>Status</th><th>Path</th><th class="num">SQL</th><th class="num">p50 ms</th><th class="num">p95 ms</th><th class="num">Response</th><th>分类</th></tr></thead><tbody>${routeRows(representatives,false)}</tbody></table></div></section>

<section id="limits"><h2>测量边界与可信度</h2><div class="finding"><div>${badge("已验证")}</div><p>SQLite <code>bun:sqlite</code> 内存库；Hono <code>app.request()</code>；固定规模种子；每探针 5 次预热、30 次顺序采样；响应体完整读取；SQL 在 statement execution 层计数。</p></div><div class="finding"><div>${badge("已验证")}</div><p>SQLite 与 Postgres 在代码层共用 <code>runMigrations(db)</code>：<code>MultiremiStore</code> 构造时统一调用（<code>store.ts:413/:513</code>），PG 的 <code>exec</code> 逐 statement 翻译执行（<code>postgres.ts:216/:230</code>）。因此 schema/index 的源码事实来源一致，不是两套 migration。</p></div><div class="finding"><div>${badge("未验证")}</div><p>本机未配置 <code>MULTIREMI_DATABASE_URL</code> 且无 <code>psql</code>，未读取生产 PG catalog，也未跑 <code>EXPLAIN (ANALYZE, BUFFERS)</code>。部署库是否漏迁移、PG planner 是否选同一索引均未验证；SQLite EQP 不作为 PG 执行计划结论。</p></div><div class="finding"><div>${badge("未验证")}</div><p>645 个注册 endpoint 中，本次逐探针测了全部 275 个普通 GET；3 个 WebSocket GET 仅做状态快照，367 个 mutation 没有重复执行来构造 p50/p95。254 probes 返回 2xx，22 probes 返回 4xx/503；后者仅保留状态和本地失败成本，不外推成功路径。</p></div><div class="finding"><div>${badge("未验证")}</div><p>没有并发、磁盘 SQLite、真实 HTTP socket/TLS、生产数据分布、数据库缓存冷热态、响应压缩、JSON 网络传输与浏览器解析测量。</p></div></section>
</main>
<script>function filterIndexes(q){q=q.toLowerCase();document.querySelectorAll('#indexTable tbody tr').forEach(r=>r.style.display=r.textContent.toLowerCase().includes(q)?'':'none')}</script>
</body></html>`;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const rendered = html.replace(/[ \t]+$/gm, "");
writeFileSync(OUTPUT_PATH, rendered);
console.log(`wrote ${OUTPUT_PATH} (${Buffer.byteLength(rendered)} bytes)`);
