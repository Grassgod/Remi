import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const out = resolve(import.meta.dir, "../../reports/performance/MUL-395-s9-3b");
type Position = { name: string; mode: string; finalPositionMs: number; firstScreenRequests: number;
  listRequests: number; archivedCountRequests: number; fixedAnchorShiftPx: number; disconnectedFrames: number; jump: { jumpPx: number } };
type NativeRound = { readyMs: number; apiFirstScreen: number; jumpPx: number };
const before = await Bun.file(`${out}/before-positions.json`).json() as { beforeHead: string; results: Position[] };
const after = await Bun.file(`${out}/after-positions.json`).json() as { results: Position[] };
const validation = await Bun.file(`${out}/validation.json`).json() as { mainHead: string; implementationHead: string;
  checks: { command: string; result: string }[]; notes: string[]; ownFiles: string[] };
const ownFiles = execFileSync("git", ["show", "--pretty=", "--name-only", "4b848ec5", "42595775"],
  { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8" }).trim().split("\n").filter(Boolean);
for await (const file of new Bun.Glob("reports/performance/MUL-395-s9-3b/*").scan({ cwd: resolve(import.meta.dir, "../..") })) ownFiles.push(file);
ownFiles.push("tests/manual/mul395-s9-3b-positions.ts", "tests/manual/mul395-s9-3b-report.ts",
  "reports/performance/MUL-395-s9-3b-report.md", "reports/performance/MUL-395-s9-3b-report.html");
validation.ownFiles = [...new Set(ownFiles)].sort();
const q = (values: number[], p = 0.5) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]!;
const fmt = (n: number) => n.toFixed(1);
const rows: string[][] = [];
for (const name of ["issues", "my-issues-all"]) for (const mode of ["cold", "warm"]) {
  const old = before.results.filter((row) => row.name === name && row.mode === mode);
  const next = after.results.filter((row) => row.name === name && row.mode === mode);
  if (old.length !== 5 || next.length !== 5) throw new Error(`Incomplete paired sample: ${name}/${mode}`);
  rows.push([name, mode, "5", `${old[0]!.listRequests}+${old[0]!.archivedCountRequests} → ${next[0]!.listRequests}+${next[0]!.archivedCountRequests}`,
    `${q(old.map((r) => r.firstScreenRequests))} → ${q(next.map((r) => r.firstScreenRequests))}`,
    `${fmt(q(old.map((r) => r.finalPositionMs)))} → ${fmt(q(next.map((r) => r.finalPositionMs)))}`,
    `${fmt(q(old.map((r) => r.finalPositionMs), 0.95))} → ${fmt(q(next.map((r) => r.finalPositionMs), 0.95))}`,
    `${Math.max(...old.map((r) => r.fixedAnchorShiftPx))} → ${Math.max(...next.map((r) => r.fixedAnchorShiftPx))}`]);
}
const nativeRows: string[][] = [];
for (const page of ["page-issues", "page-my-issues"]) {
  const old = await Bun.file(`${out}/before-${page}.json`).json() as { scenarios: { mode: string; rounds: NativeRound[] }[] };
  const next = await Bun.file(`${out}/after-${page}.json`).json() as typeof old;
  for (const mode of ["cold", "warm"]) {
    const a = old.scenarios.find((s) => s.mode === mode)!.rounds;
    const b = next.scenarios.find((s) => s.mode === mode)!.rounds;
    nativeRows.push([page, mode, `${q(a.map((r) => r.apiFirstScreen))} → ${q(b.map((r) => r.apiFirstScreen))}`,
      `${fmt(q(a.map((r) => r.readyMs)))} → ${fmt(q(b.map((r) => r.readyMs)))}`,
      `${fmt(q(a.map((r) => r.readyMs), 0.95))} → ${fmt(q(b.map((r) => r.readyMs), 0.95))}`,
      `${Math.max(...a.map((r) => r.jumpPx))} → ${Math.max(...b.map((r) => r.jumpPx))}`]);
  }
}
const extras = after.results.filter((row) => row.name.startsWith("472-") || row.name === "MUL-454");
if (extras.length !== 8 || after.results.some((row) => row.fixedAnchorShiftPx || row.jump.jumpPx || row.disconnectedFrames)) {
  throw new Error("After must have all eight additional samples and zero position changes");
}
const audit = [
  ["core/issues/queries.ts: issueListOptions / myIssueListOptions", "原 key 不变；每次 queryFn 执行均取分组首页。数字归档计数是 skipToken 被动订阅，由活跃状态/负责人列表写入。"],
  ["core/issues/mutations.ts", "create / update / unarchive / delete / batch update / move：list 或 issues 根前缀失效；my 乐观缓存/删除清理和旧失效规则保留。"],
  ["core/issues/delete-cache.ts", "删除后的 list + myAll 失效走各自同一个分组 queryFn。"],
  ["core/issues/ws-updaters.ts", "issue created / updated / deleted、labels、metadata、kind：保留直接 cache patch；需 refetch 的 my/负责人/位置列表走现有 key。归档和取消归档额外刷新活跃 workspace 列表，以更新随页计数。"],
  ["core/realtime/use-realtime-sync.ts", "重连时 issueKeys.all(wsId) 失效。"],
  ["core/realtime/sync/prefix-refresh.ts", "squad 删除、label 事件的 issues 根前缀；其 tasks/sessions/usage/detail 前缀不匹配 workspace list/my key。"],
  ["core/realtime/sync/workspace.ts；views/settings/components/workspace-tab.tsx", "工作区快照/设置变化触发 issues 根前缀。"],
  ["core/labels/mutations.ts；views/issues/components/issue-description-section.tsx", "标签修改/删除与描述保存触发 issues 根前缀。"],
  ["core/query-client.ts；QueryObserver.refetch / invalidateQueries / focusManager", "生产默认 staleTime=Infinity、窗口聚焦不重新拉取、重连重新拉取。显式 refetch 或启用聚焦并失效时使用同一分组 queryFn；守卫覆盖这三种情况。"],
];
const mutations = [
  ["fetchFirstPages 恢复循环", "3 fail；issues 预期 1、收到 7；assigned 预期 1、收到 6；all 预期 3、收到 18（status-pages.test.ts:143）。"],
  ["仅预热后改用逐状态请求", "1 fail；invalidate 后预期 1、收到 6（status-pages.test.ts:148）。冷开守卫先通过。"],
  ["删除 include_archived_total", "5 fail；List response is missing requested archived_total；归档失效守卫的 isSuccess 预期 true、收到 false（:168）。"],
  ["删除 404 兜底", "2 fail；两个 404 用例收到 ApiError: not found，未得到预期缓存；401/500 两用例仍通过。"],
];
const table = (headers: string[], body: string[][]) => `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body.map((r) => `| ${r.join(" | ")} |`).join("\n")}`;
const parts = [
  ["MUL-395 S9-3b：分组首页前后对比", `before Web：${before.beforeHead}\nafter 产品实现：${validation.implementationHead}\n合入 main：${validation.mainHead}\nDraft PR：https://github.com/Grassgod/Remi/pull/331（依赖 PR #297；472 合入 main 前不合入）。`],
  ["实测口径", "同机 n37-066-008、Bun 1.3.14、Chromium 1440×900、同一进程内 SQLite fixture（5 条 issue；MUL-454 的 210 条评论副本）。before 是 git archive 的 472 head，工作区包链接指向 archive 自身。after 使用本单实现；前后 Web 顺序运行 Next dev --webpack。未访问生产。\n原 S1 CLI 每页 cold/warm 各 5 轮；My Issues 默认 assigned。另用相同 S1 recorder、selectors、测量层采集真实首行位置；该组显式固定 my scope=all，主列表延迟 300ms、延后请求延迟 900ms，与 472 的位置验证一致。cold 从文档原点、warm 从点击计时；warm 入口 issues←inbox，其他目标←issues，500ms 请求安静窗口/5s 上限，hover=150ms。\n位置指标是固定真实行到达最终 top 的首帧；观察首行后 3000ms，同时计算 S1 前 1500ms jumpPx。固定行必须存在、可见且未断连。数字为中位数和最近秩 p95（n=5 即最大值），全部采样保留。Next dev、合成延迟和共享机器负载下的数值不代表生产 p95。"],
  ["真实列表位置与请求", table(["页面", "模式", "n", "主列表+归档 HTTP", "首屏全部 API p50", "最终位置 ms p50", "最终位置 ms p95", "固定行 px max"], rows)],
  ["原 S1 CLI", table(["页面（my 默认 assigned）", "模式", "首屏全部 API p50", "ready ms p50", "ready ms p95", "S1 jumpPx max"], nativeRows)],
  ["472 六场景与长样本", table(["场景", "模式", "n", "固定行 px", "S1 jumpPx", "断连帧"], extras.map((r) => [r.name, r.mode, "1", String(r.fixedAnchorShiftPx), String(r.jump.jumpPx), String(r.disconnectedFrames)]))],
  ["接口与兼容", "issues 状态首页显式传当前六个 PAGINATED_STATUSES、limit=50、原 sort/filter，以及 include_archived_total=true；groups[status] 的 issues/total 填入原 {byStatus} 缓存，archived_total 写入原数字计数 key。\nmy assigned/created/agents 各 1 次，all 按 assignee/creator/involves 三个原筛选各 1 次，18→3；合并顺序、去重和 total 规则不变，未增加后端 relation=any 或修正旧 creator/involves/sort 语义。加载更多仍是 /api/issues 单状态，offset 等于该桶已加载条数。\n404 每 API client 只探测一次（并发 all 共享探测），随后本会话走旧路径；新会话重新探测。401/500 不当作版本错配。工作区负责人看板在 /api/issues/grouped 上也显式请求可选归档计数，保持隐藏状态子树不订阅；旧 API 忽略此字段时只在兼容分支恢复旧归档请求。两服务端 grouped 路由默认字段/查询成本不变，CLI issue grouped 新增 --include-archived-total。"],
  ["失效与 refetch 清单", table(["来源", "行为"], audit)],
  ["测试与回归", table(["复现命令", "结果"], validation.checks.map((r) => [r.command, r.result]))],
  ["变异与恢复", table(["临时变异", "实际失败"], mutations) + "\n\n四项逐个还原；每次 git diff --exit-code -- frontend/ packages/ 退出 0，恢复后 core 四文件 72/72。临时修改未提交。"],
  ["限制与复核事项", validation.notes.join("\n\n")],
  ["临时 PG", "仅使用自起的 PostgreSQL 18.4，端口 55433，数据目录 /tmp/mul395-pg/data。公共 @embedded-postgres/linux-x64@18.4.0-beta.17 提供二进制及 ICU；LD_LIBRARY_PATH 指向同目录的 libshim 和 package/native/lib。initdb/pg_ctl 均通过 unshare --user --map-user=1000 --map-group=1000 运行。启动参数 -p 55433 -k /tmp/mul395-pg/socket -h 127.0.0.1；停止用 pg_ctl -D /tmp/mul395-pg/data -m fast -w stop。测试连接设置仅存在子进程内存，runner 清除 MULTIREMI_TOKEN。没有使用 5433，没有读取其他实例配置。"],
  ["本单非 merge 文件", validation.ownFiles.map((file) => `- ${file}`).join("\n")],
];
const markdown = parts.map(([title, content], index) => `${index ? "##" : "#"} ${title}\n\n${content}`).join("\n\n") + "\n";
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const render = (content: string) => {
  const lines = content.split("\n");
  let html = "";
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.startsWith("|")) {
      const cells = (line: string) => line.split("|").slice(1, -1).map((s) => s.trim());
      html += `<div class="table-wrap"><table><thead><tr>${cells(lines[i]!).map((s) => `<th>${escape(s)}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i]!.startsWith("|")) html += `<tr>${cells(lines[i++]!).map((s) => `<td>${escape(s)}</td>`).join("")}</tr>`;
      html += "</tbody></table></div>";
    } else if (lines[i]!.startsWith("- ")) {
      html += "<ul>";
      while (i < lines.length && lines[i]!.startsWith("- ")) html += `<li><code>${escape(lines[i++]!.slice(2))}</code></li>`;
      html += "</ul>";
    } else { html += lines[i] ? `<p>${escape(lines[i]!)}</p>` : ""; i++; }
  }
  return html;
};
await Bun.write(resolve(out, "../MUL-395-s9-3b-report.md"), markdown);
await Bun.write(resolve(out, "../MUL-395-s9-3b-report.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUL-395 S9-3b</title><style>body{margin:0;background:#fff;color:#202427;font:15px/1.65 system-ui,sans-serif;letter-spacing:0}main{max-width:1180px;margin:auto;padding:28px 20px 60px}h1{font-size:25px}h2{font-size:19px;border-top:1px solid #d6dddf;padding-top:22px;margin-top:30px;color:#136357}p{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dce1e4;padding:9px 10px;min-width:70px}th{background:#f1f4f5;color:#303d43}tbody tr:nth-child(even){background:#f8faf9}.table-wrap{overflow:auto}code{font-size:12px;overflow-wrap:anywhere}li{margin:4px 0}@media(max-width:600px){main{padding:18px 12px}h1{font-size:21px}table{min-width:680px}}</style><main>${parts.map(([title, content], index) => `<section><${index ? "h2" : "h1"}>${escape(title!)}</${index ? "h2" : "h1"}>${render(content!)}</section>`).join("")}</main></html>`);
console.log("Wrote self-contained S9-3b Markdown and HTML reports");
