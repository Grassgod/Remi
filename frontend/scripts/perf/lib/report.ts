/**
 * Report rendering for the MUL-383 page-speed probe.
 *
 * Kept out of `page-speed.ts` so the measurement driver and the three output
 * formats stay separable: the driver owns browser state, this module owns text.
 * Everything here is pure, taking an already-collected report.
 *
 * The HTML output is self-contained: inline CSS, inline data, no external
 * stylesheet / script / font reference, no storage or parent-frame access, so it
 * renders both from disk and inside an issue comment's sandboxed iframe.
 */

import type { PerfScenarioStats, PerfSelectorEquivalence } from "./jump-recorder";

export interface ReportRoundSummary {
  round: number;
  readyMs: number | null;
  readyTimeout: boolean;
  firstRealMs: number | null;
  anchorVisibleMs: number | null;
  anchorName: string | null;
  anchorRule: string;
  appReadyMs: number | null;
  appReadyForced: boolean;
  dataFreshAtReady: boolean;
  jumpCount: number;
  jumpPx: number;
  /** Per-jump detail: a bare count cannot say where or in which direction. */
  jumps: Array<{ startMs: number; endMs: number; px: number; scrollPx: number; kind: string; frames: number }>;
  layoutShiftCount: number;
  cls: number;
  serialDepth: number | null;
  apiCallsTotal: number;
  apiFirstScreen: number;
  /** Script/JS chunk accounting for the round. */
  chunksLoaded: number;
  chunkBytes: number;
  lcpMs: number | null;
  slowestServerTotalMs: number | null;
  /** Failure text for the round (`warm target not found`, navigation errors, ...). */
  error?: string;
  blockedWrites: number;
  heapBytes: number | null;
  /** The anchor's rect at the ready frame, in root-relative coordinates. */
  anchorRectAtReady?: { top: number; bottom: number; height: number; rootHeight: number } | null;
  /**
   * Deep-link depth, from the `/comments` responses this round already made.
   * Recorded on every round so a target that sits deeper in one run than another
   * is visible in the report instead of hiding behind a matching identifier.
   */
  targetDepth?: TargetDepth;
  /**
   * Contract-vs-legacy element identity at the ready frame, sampled in contract
   * rounds only. This is the evidence behind the rollout gate, so it belongs in
   * the artifact rather than only in the probe's stdout.
   */
  selectorEquivalence?: PerfSelectorEquivalence | null;
}

export interface TargetDepth {
  timelineRequests: number;
  targetIndexFromLatest: number | null;
}

export interface ReportScenario {
  key: string;
  mode: "cold" | "warm";
  /** Reported identifier only; never a raw id list. */
  target: { identifier: string; note?: string };
  /**
   * Timeline entries seen for this fixture, next to the comment count in the
   * target note. The two differ because activity entries are not comments.
   */
  timelineEntries?: number | null;
  rule: string;
  anchorRule: string;
  selectorMode: "contract" | "legacy";
  /** True when the scenario was deliberately not measured. */
  skipped: boolean;
  /** The machine-readable reason for `skipped`; null when it was measured. */
  skipReason: string | null;
  targetSelection?: string;
  /** Deep-link bookkeeping: which notification/issue was measured, and where. */
  inboxItemId?: string | null;
  issueHasRunningTask?: boolean;
  /** Position in the `/api/inbox/page` response, for comparison with the DOM row. */
  inboxApiIndex?: number | null;
  /** The DOM row the warm click must use, from the page's grouping functions. */
  inboxDomRowIndex?: number | null;
  hoverLeadMs: number | null;
  rounds: ReportRoundSummary[];
  stats: PerfScenarioStats;
}

export function fmtMs(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : value.toFixed(1);
}

export function fmtBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

export function buildMarkdown(report: {
  meta: Record<string, unknown>;
  scenarios: ReportScenario[];
  blockedWrites: Array<{ page: string; method: string; path: string; attempts: number }>;
  compare?: string | null;
}): string {
  const meta = report.meta as {
    issue?: string;
    window?: string;
    generatedAt?: string;
    beijingTime?: string;
    baseUrl?: string;
    workspaceSlug?: string;
    memberName?: string;
    rounds?: number;
    runner?: string;
    readingRule?: string;
    apiVersion?: string | null;
    webVersion?: string | null;
    hoverLeadMs?: number;
    selectorMode?: string;
    writeGuardSelfTest?: { blocked?: boolean; target?: string; detail?: string };
    ambientLatency?: { before?: { medianMs?: number | null }; after?: { medianMs?: number | null } };
  };
  const lines: string[] = [];
  lines.push("# MUL-383 页面测速基线（schema 2）");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt ?? "unknown"}（北京时间 ${meta.beijingTime ?? "?"}）`);
  lines.push(`- 目标：${meta.baseUrl ?? "?"}（工作区 \`${meta.workspaceSlug ?? "?"}\`）`);
  lines.push(`- 被测用户：${meta.memberName ?? "?"}　窗口：\`${meta.window ?? "?"}\``);
  lines.push(`- 运行机器：${meta.runner ?? "?"}`);
  lines.push(`- 每场景轮数：${meta.rounds ?? "?"}（最近秩分位数；n=5 时 p95 = max）`);
  lines.push(`- 前端版本：${meta.webVersion ? `\`${meta.webVersion}\`` : "未知"}`);
  lines.push(`- API 版本：${meta.apiVersion ?? "未知"}`);
  lines.push(`- 选择器模式：\`${meta.selectorMode ?? "?"}\``);
  lines.push("");
  lines.push("## 判定口径");
  lines.push("");
  lines.push(`- 终点：${meta.readingRule ?? "-"}`);
  lines.push(
    "- 跳动：首次出现真实内容后，相邻帧中同一 `data-perf-key` 的可见行位移 > 1px（或 scrollTop 位移 > 1px）即为移动帧，连续移动帧合并为一次跳动。`jumps = 0` 才合格。",
  );
  lines.push(
    "- readyMs：anchor 完整可见、骨架为 0、之后 500ms 无移动帧；取该安静窗口的起点。单轮超时 20s，超时轮不进分位数。",
  );
  lines.push("- 冷启动用 `page.goto`；应用内切页先 hover 后真实 click，navStart 取页面内记录的 click 时间戳。");
  lines.push(
    "- 串行深度：`wave = 1 + max(wave(p) | p.responseEnd ≤ start + 8ms)`；`Server-Timing` 由 resource timing 同源读取。",
  );
  const ambient = meta.ambientLatency;
  if (ambient?.before || ambient?.after) {
    lines.push(
      `- 环境参照：\`/api/config\` 中位耗时 运行前 ${fmtMs(ambient.before?.medianMs)} ms / 运行后 ${fmtMs(ambient.after?.medianMs)} ms。`,
    );
  }
  const selfTest = meta.writeGuardSelfTest;
  if (selfTest) {
    lines.push(
      `- 写护栏自检：${selfTest.blocked ? "通过" : "**未通过**"}（${selfTest.detail ?? selfTest.target ?? "-"}）`,
    );
  }
  lines.push("");
  lines.push("## 每场景汇总");
  lines.push("");
  lines.push(
    "| 场景 | 模式 | 状态 | 目标 | 选择器 | anchor | n | ready p50 | p75 | p95 | max | 超时 | firstReal p50 | jumps max | 位移 max | 串行深度 | 首屏 API p50 |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const scenario of report.scenarios) {
    const stats = scenario.stats;
    const status = scenario.skipped ? `skipped: ${scenario.skipReason ?? "unknown"}` : "measured";
    lines.push(
      `| ${scenario.key} | ${scenario.mode} | ${status} | ${scenario.target.identifier}${scenario.target.note ? `（${scenario.target.note}）` : ""} | ${scenario.selectorMode} | ${scenario.anchorRule} | ${stats.n} | ${fmtMs(stats.readyP50)} | ${fmtMs(stats.readyP75)} | ${fmtMs(stats.readyP95)} | ${fmtMs(stats.readyMax)} | ${stats.timeouts} | ${fmtMs(stats.firstRealP50)} | ${stats.jumpsMax ?? "-"} | ${fmtMs(stats.jumpPxMax)} | ${stats.serialDepthMax ?? "-"} | ${fmtMs(stats.apiFirstScreenP50)} |`,
    );
  }
  lines.push("");
  const skipped = report.scenarios.filter((scenario) => scenario.skipped);
  if (skipped.length > 0) {
    lines.push("### 跳过的场景");
    lines.push("");
    for (const scenario of skipped) {
      lines.push(`- \`${scenario.key}\` (${scenario.mode})：${scenario.skipReason ?? "unknown"}`);
    }
    lines.push("");
  }
  lines.push("## 每轮明细");
  lines.push("");
  lines.push(
    "| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 写请求 | error |",
  );
  lines.push(
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const scenario of report.scenarios) {
    for (const round of scenario.rounds) {
      const rect = round.anchorRectAtReady;
      const rectText = rect
        ? `${rect.top}/${rect.bottom}/${rect.height}/${rect.rootHeight}`
        : "-";
      lines.push(
        `| ${scenario.key} | ${scenario.mode} | ${round.round} | ${fmtMs(round.readyMs)}${round.readyTimeout ? " ⚠" : ""} | ${fmtMs(round.firstRealMs)} | ${fmtMs(round.anchorVisibleMs)} | ${round.anchorName ?? "-"} | ${rectText} | ${fmtMs(round.appReadyMs)}${round.appReadyForced ? " (forced)" : ""} | ${round.jumpCount} | ${fmtMs(round.jumpPx)} | ${round.cls} | ${fmtMs(round.lcpMs)} | ${fmtMs(round.slowestServerTotalMs)} | ${round.chunksLoaded} | ${fmtBytes(round.chunkBytes)} | ${round.serialDepth ?? "-"} | ${round.apiFirstScreen}/${round.apiCallsTotal} | ${round.blockedWrites} | ${round.error ?? "-"} |`,
      );
    }
  }
  lines.push("");
  // Jump detail: the acceptance criterion is "every detail page shows its jumps",
  // so the per-jump geometry belongs in the artifact.
  const jumpRows = report.scenarios.flatMap((scenario) => scenario.rounds.flatMap((round) =>
    round.jumps.map((jump) => ({ scenario, round, jump }))));
  if (jumpRows.length > 0) {
    lines.push("### 跳动明细");
    lines.push("");
    lines.push("| 场景 | 模式 | 轮 | start ms | end ms | 位移 px | scroll px | kind | frames |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
    for (const { scenario, round, jump } of jumpRows) {
      lines.push(
        `| ${scenario.key} | ${scenario.mode} | ${round.round} | ${fmtMs(jump.startMs)} | ${fmtMs(jump.endMs)} | ${fmtMs(jump.px)} | ${fmtMs(jump.scrollPx)} | ${jump.kind} | ${jump.frames} |`,
      );
    }
    lines.push("");
  }
  if (report.blockedWrites.length > 0) {
    lines.push("## 被拦截的写请求");
    lines.push("");
    lines.push("| 页面 | 方法 | path 模式 | 尝试次数 |");
    lines.push("| --- | --- | --- | ---: |");
    for (const write of report.blockedWrites) {
      lines.push(`| ${write.page} | ${write.method} | \`${write.path}\` | ${write.attempts} |`);
    }
    lines.push("");
    lines.push("> 全部为 abort，未到达服务端。");
    lines.push("");
  }
  if (report.compare) {
    lines.push("## 与基线对比");
    lines.push("");
    lines.push(report.compare);
    lines.push("");
  }
  return lines.join("\n");
}

export function buildHtml(report: {
  meta: Record<string, unknown>;
  scenarios: ReportScenario[];
  blockedWrites: Array<{ page: string; method: string; path: string; attempts: number }>;
  compareTable?: CompareRow[] | null;
}): string {
  const esc = (value: unknown): string =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const meta = report.meta as Record<string, unknown>;
  const rows = report.scenarios
    .map((scenario) => {
      const stats = scenario.stats;
      const bad = (stats.jumpsMax ?? 0) > 0;
      const status = scenario.skipped
        ? `<span class="warn">skipped: ${esc(scenario.skipReason ?? "unknown")}</span>`
        : '<span class="good">measured</span>';
      return `<tr>
      <td class="key">${esc(scenario.key)}</td>
      <td>${esc(scenario.mode)}</td>
      <td>${status}</td>
      <td>${esc(scenario.target.identifier)}${scenario.target.note ? ` <span class="muted">${esc(scenario.target.note)}</span>` : ""}</td>
      <td class="muted">${esc(scenario.selectorMode)}</td>
      <td class="muted">${esc(scenario.anchorRule)}</td>
      <td class="num">${stats.n}</td>
      <td class="num">${fmtMs(stats.readyP50)}</td>
      <td class="num">${fmtMs(stats.readyP75)}</td>
      <td class="num">${fmtMs(stats.readyP95)}</td>
      <td class="num">${fmtMs(stats.readyMax)}</td>
      <td class="num">${stats.timeouts}</td>
      <td class="num">${fmtMs(stats.firstRealP50)}</td>
      <td class="num${bad ? " bad" : " good"}">${stats.jumpsMax ?? "-"}</td>
      <td class="num">${fmtMs(stats.jumpPxMax)}</td>
      <td class="num">${stats.serialDepthMax ?? "-"}</td>
      <td class="num">${fmtMs(stats.apiFirstScreenP50)}</td>
    </tr>`;
    })
    .join("\n");

  const detailRows = report.scenarios
    .flatMap((scenario) =>
      scenario.rounds.map(
        (round) => `<tr>
      <td class="key">${esc(scenario.key)}</td>
      <td>${esc(scenario.mode)}</td>
      <td class="num">${round.round}</td>
      <td class="num">${fmtMs(round.readyMs)}${round.readyTimeout ? ' <span class="warn">⚠</span>' : ""}</td>
      <td class="num">${fmtMs(round.firstRealMs)}</td>
      <td class="num">${fmtMs(round.anchorVisibleMs)}</td>
      <td class="muted">${esc(round.anchorName ?? "-")}</td>
      <td class="num">${round.anchorRectAtReady
        ? `${round.anchorRectAtReady.top}/${round.anchorRectAtReady.bottom}/${round.anchorRectAtReady.height}/${round.anchorRectAtReady.rootHeight}`
        : "-"}</td>
      <td class="num">${fmtMs(round.appReadyMs)}${round.appReadyForced ? " (forced)" : ""}</td>
      <td class="num${round.jumpCount > 0 ? " bad" : " good"}">${round.jumpCount}</td>
      <td class="num">${fmtMs(round.jumpPx)}</td>
      <td class="num">${round.cls}</td>
      <td class="num">${fmtMs(round.lcpMs)}</td>
      <td class="num">${fmtMs(round.slowestServerTotalMs)}</td>
      <td class="num">${round.chunksLoaded}</td>
      <td class="num">${fmtBytes(round.chunkBytes)}</td>
      <td class="num">${round.serialDepth ?? "-"}</td>
      <td class="num">${round.apiFirstScreen}/${round.apiCallsTotal}</td>
      <td class="num">${round.blockedWrites}</td>
      <td class="muted">${esc(round.error ?? "-")}</td>
    </tr>`,
      ),
    )
    .join("\n");

  const jumpRows = report.scenarios
    .flatMap((scenario) => scenario.rounds.flatMap((round) =>
      round.jumps.map((jump) => `<tr>
      <td class="key">${esc(scenario.key)}</td>
      <td>${esc(scenario.mode)}</td>
      <td class="num">${round.round}</td>
      <td class="num">${fmtMs(jump.startMs)}</td>
      <td class="num">${fmtMs(jump.endMs)}</td>
      <td class="num">${fmtMs(jump.px)}</td>
      <td class="num">${fmtMs(jump.scrollPx)}</td>
      <td>${esc(jump.kind)}</td>
      <td class="num">${jump.frames}</td>
    </tr>`)))
    .join("\n");

  const blockedRows = report.blockedWrites
    .map(
      (write) =>
        `<tr><td>${esc(write.page)}</td><td>${esc(write.method)}</td><td><code>${esc(write.path)}</code></td><td class="num">${write.attempts}</td></tr>`,
    )
    .join("\n");

  const compareRows = (report.compareTable ?? [])
    .map((row) => {
      const delta = (before: number | null, after: number | null): string => {
        if (before === null || after === null) return '<span class="muted">-</span>';
        const diff = after - before;
        const cls = diff > 0 ? "bad" : diff < 0 ? "good" : "muted";
        return `<span class="${cls}">${diff > 0 ? "+" : ""}${diff.toFixed(1)}</span>`;
      };
      return `<tr>
      <td class="key">${esc(row.key)}</td><td>${esc(row.mode)}</td>
      <td>${esc(row.beforeMode ?? "-")} → ${esc(row.afterMode ?? "-")}</td>
      <td class="num">${fmtMs(row.beforeReadyP75)} → ${fmtMs(row.afterReadyP75)}</td><td class="num">${delta(row.beforeReadyP75, row.afterReadyP75)}</td>
      <td class="num">${fmtMs(row.beforeReadyP95)} → ${fmtMs(row.afterReadyP95)}</td><td class="num">${delta(row.beforeReadyP95, row.afterReadyP95)}</td>
      <td class="num">${row.beforeJumpsMax ?? "-"} → ${row.afterJumpsMax ?? "-"}</td>
      <td class="num">${row.beforeSerialDepthMax ?? "-"} → ${row.afterSerialDepthMax ?? "-"}</td>
      <td class="num">${fmtMs(row.beforeApiFirstScreenP50)} → ${fmtMs(row.afterApiFirstScreenP50)}</td>
    </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUL-383 页面测速基线（schema 2）</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; background: #fafafa; color: #18181b; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  .muted { color: #71717a; }
  .warn { color: #b45309; }
  .bad { color: #b91c1c; font-weight: 600; }
  .good { color: #15803d; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 12px 0 0; }
  .meta dt { color: #71717a; }
  .meta dd { margin: 0; }
  .tablewrap { overflow-x: auto; border: 1px solid #e4e4e7; border-radius: 6px; background: #fff; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #f0f0f1; text-align: left; white-space: nowrap; }
  thead th { background: #f4f4f5; font-weight: 600; position: sticky; top: 0; }
  tbody tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.key { font-weight: 600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  footer { margin-top: 28px; color: #71717a; }
</style>
</head>
<body>
<main>
<h1>MUL-383 页面测速基线（schema 2）</h1>
<p class="muted">每轮 20s 超时；超时轮不进分位数。生成于 ${esc(meta.generatedAt ?? "?")}。</p>
<dl class="meta">
  <dt>窗口</dt><dd>${esc(meta.window ?? "?")}</dd>
  <dt>目标</dt><dd>${esc(meta.baseUrl ?? "?")}（工作区 <code>${esc(meta.workspaceSlug ?? "?")}</code>）</dd>
  <dt>被测用户</dt><dd>${esc(meta.memberName ?? "?")}</dd>
  <dt>运行机器</dt><dd>${esc(meta.runner ?? "?")}</dd>
  <dt>轮数</dt><dd>${esc(meta.rounds ?? "?")}</dd>
  <dt>选择器模式</dt><dd>${esc(meta.selectorMode ?? "?")}</dd>
  <dt>前端 / API 版本</dt><dd>${esc(meta.webVersion ?? "?")} / ${esc(meta.apiVersion ?? "?")}</dd>
  <dt>写护栏自检</dt><dd>${esc((meta.writeGuardSelfTest as { detail?: string } | undefined)?.detail ?? "未运行")}</dd>
</dl>
<h2>每场景汇总</h2>
<div class="tablewrap"><table>
<thead><tr><th>场景</th><th>模式</th><th>状态</th><th>目标</th><th>选择器</th><th>anchor</th><th class="num">n</th><th class="num">ready p50</th><th class="num">p75</th><th class="num">p95</th><th class="num">max</th><th class="num">超时</th><th class="num">firstReal p50</th><th class="num">jumps max</th><th class="num">位移 max</th><th class="num">串行深度</th><th class="num">首屏 API p50</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<h2>每轮明细</h2>
<div class="tablewrap"><table>
<thead><tr><th>场景</th><th>模式</th><th class="num">轮</th><th class="num">ready ms</th><th class="num">firstReal ms</th><th class="num">anchorVisible ms</th><th>anchor</th><th>anchorRect(top/bottom/height/root)</th><th class="num">appReady ms</th><th class="num">跳动数</th><th class="num">位移 px</th><th class="num">CLS</th><th class="num">LCP ms</th><th class="num">最慢 Server-Timing ms</th><th class="num">chunks</th><th class="num">chunk bytes</th><th class="num">串行深度</th><th class="num">首屏 API</th><th class="num">写请求</th><th>error</th></tr></thead>
<tbody>
${detailRows}
</tbody>
</table></div>
${jumpRows ? `<h2>跳动明细</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>场景</th><th>模式</th><th class="num">轮</th><th class="num">start ms</th><th class="num">end ms</th><th class="num">位移 px</th><th class="num">scroll px</th><th>kind</th><th class="num">frames</th></tr></thead>\n<tbody>\n${jumpRows}\n</tbody>\n</table></div>` : ""}
${blockedRows ? `<h2>被拦截的写请求（全部为 abort）</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>页面</th><th>方法</th><th>path 模式</th><th class="num">尝试</th></tr></thead>\n<tbody>\n${blockedRows}\n</tbody>\n</table></div>` : ""}
${compareRows ? `<h2>与基线对比</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>场景</th><th>模式</th><th>选择器</th><th class="num">ready p75</th><th class="num">Δ</th><th class="num">ready p95</th><th class="num">Δ</th><th class="num">jumps max</th><th class="num">串行深度</th><th class="num">首屏 API p50</th></tr></thead>\n<tbody>\n${compareRows}\n</tbody>\n</table></div>` : ""}
<footer>由 frontend/scripts/perf/page-speed.ts 生成。自包含 HTML：无外链资源、无存储、无父窗口访问。</footer>
</main>
</body>
</html>
`;
}

export interface CompareRow {
  key: string;
  mode: string;
  beforeMode: string | null;
  afterMode: string | null;
  beforeReadyP75: number | null;
  afterReadyP75: number | null;
  beforeReadyP95: number | null;
  afterReadyP95: number | null;
  beforeJumpsMax: number | null;
  afterJumpsMax: number | null;
  beforeSerialDepthMax: number | null;
  afterSerialDepthMax: number | null;
  beforeApiFirstScreenP50: number | null;
  afterApiFirstScreenP50: number | null;
  beforeTimelineRequests: number | null;
  afterTimelineRequests: number | null;
}

/** The deepest target seen in a scenario, so a target that moved deeper is what warns. */
function deepestTargetDepth(scenario: ReportScenario | null): TargetDepth | null {
  if (!scenario) return null;
  let best: TargetDepth | null = null;
  for (const round of scenario.rounds) {
    const depth = round.targetDepth;
    if (!depth) continue;
    if (!best || depth.timelineRequests > best.timelineRequests) best = depth;
  }
  return best;
}

export interface CompareWarning {
  key: string;
  mode: string;
  message: string;
}

/**
 * `--compare` pairing and its warnings. Pairing is by `key + mode`; a differing
 * `selectorMode` or inbox target is reported but never blocks the comparison,
 * because the two runs legitimately differ while the contract rolls out.
 */
export function buildCompare(
  baseline: { scenarios: ReportScenario[] },
  current: { scenarios: ReportScenario[] },
): { rows: CompareRow[]; warnings: CompareWarning[]; markdown: string } {
  const pairKey = (scenario: { key: string; mode: string }): string => `${scenario.key}::${scenario.mode}`;
  const before = new Map(baseline.scenarios.map((scenario) => [pairKey(scenario), scenario]));
  const after = new Map(current.scenarios.map((scenario) => [pairKey(scenario), scenario]));
  const keys = [...before.keys()];
  for (const key of after.keys()) if (!keys.includes(key)) keys.push(key);

  const rows: CompareRow[] = [];
  const warnings: CompareWarning[] = [];
  for (const key of keys) {
    const [scenarioKey = "", mode = ""] = key.split("::");
    const a = before.get(key) ?? null;
    const b = after.get(key) ?? null;
    rows.push({
      key: scenarioKey,
      mode,
      beforeMode: a?.selectorMode ?? null,
      afterMode: b?.selectorMode ?? null,
      beforeReadyP75: a?.stats.readyP75 ?? null,
      afterReadyP75: b?.stats.readyP75 ?? null,
      beforeReadyP95: a?.stats.readyP95 ?? null,
      afterReadyP95: b?.stats.readyP95 ?? null,
      beforeJumpsMax: a?.stats.jumpsMax ?? null,
      afterJumpsMax: b?.stats.jumpsMax ?? null,
      beforeSerialDepthMax: a?.stats.serialDepthMax ?? null,
      afterSerialDepthMax: b?.stats.serialDepthMax ?? null,
      beforeApiFirstScreenP50: a?.stats.apiFirstScreenP50 ?? null,
      afterApiFirstScreenP50: b?.stats.apiFirstScreenP50 ?? null,
      beforeTimelineRequests: deepestTargetDepth(a)?.timelineRequests ?? null,
      afterTimelineRequests: deepestTargetDepth(b)?.timelineRequests ?? null,
    });
    if (a && b && a.selectorMode !== b.selectorMode) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `选择器模式不同（${a.selectorMode} → ${b.selectorMode}）：数字不可直接比较`,
      });
    }
    if (a && b && a.target.identifier !== b.target.identifier) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `目标不同（${a.target.identifier} → ${b.target.identifier}）`,
      });
    }
    if (a && b && a.targetSelection !== b.targetSelection) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `深链目标选择方式不同（${a.targetSelection ?? "-"} → ${b.targetSelection ?? "-"}）`,
      });
    }
    const beforeDepth = deepestTargetDepth(a);
    const afterDepth = deepestTargetDepth(b);
    if (beforeDepth && afterDepth && beforeDepth.timelineRequests !== afterDepth.timelineRequests) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `深链目标深度不同（timelineRequests ${beforeDepth.timelineRequests} → ${afterDepth.timelineRequests}）：两侧不是同一落点`,
      });
    }
  }

  const lines: string[] = [];
  lines.push("| 场景 | 模式 | 选择器 | ready p75 | 差值 | ready p95 | 差值 | jumps max | 串行深度 | 首屏 API p50 |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
  for (const row of rows) {
    const delta = (beforeValue: number | null, afterValue: number | null): string =>
      beforeValue === null || afterValue === null ? "-" : `${afterValue - beforeValue > 0 ? "+" : ""}${(afterValue - beforeValue).toFixed(1)}`;
    lines.push(
      `| ${row.key} | ${row.mode} | ${row.beforeMode ?? "-"} → ${row.afterMode ?? "-"} | ${fmtMs(row.beforeReadyP75)} → ${fmtMs(row.afterReadyP75)} | ${delta(row.beforeReadyP75, row.afterReadyP75)} | ${fmtMs(row.beforeReadyP95)} → ${fmtMs(row.afterReadyP95)} | ${delta(row.beforeReadyP95, row.afterReadyP95)} | ${row.beforeJumpsMax ?? "-"} → ${row.afterJumpsMax ?? "-"} | ${row.beforeSerialDepthMax ?? "-"} → ${row.afterSerialDepthMax ?? "-"} | ${fmtMs(row.beforeApiFirstScreenP50)} → ${fmtMs(row.afterApiFirstScreenP50)} |`,
    );
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("**警告（不阻断对比）**");
    lines.push("");
    for (const warning of warnings) {
      lines.push(`- \`${warning.key}\` (${warning.mode})：${warning.message}`);
    }
  }
  lines.push("");
  lines.push("> 差值只在同一台机器、同一网络位置、同一 rounds 下可比；schema 1（MUL-367）与新口径不可比。");
  return { rows, warnings, markdown: lines.join("\n") };
}
