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

import type { PerfApiEntry, PerfApiPathStats, PerfScenarioStats, PerfSelectorEquivalence } from "./jump-recorder";

/**
 * The artifact schema version.
 *
 * 2 → 3 (MUL-395 S9-0): warm rounds are re-based on the click, the first-screen
 * set is bounded below by that click, and every round now persists `navStartMs`,
 * `clickT`, the entry-page state, `serialChain` and the per-request
 * `apiFirstScreenEntries`. Schema 2 warm rows measured from the entry page's
 * document origin, so their `readyMs`/`apiFirstScreen`/`serialDepth` are not
 * comparable with a schema 3 warm row; the cold rows are unchanged.
 */
export const REPORT_SCHEMA = 3;

export interface ReportRoundSummary {
  round: number;
  /**
   * Time origin this round's numbers are relative to: 0 for cold rounds, the
   * in-page click timestamp for warm ones. Persisted so a reader can re-base a
   * round after the fact — the 09-27 baseline could not, because the driver
   * never wrote it down (MUL-395 §4.3).
   */
  navStartMs: number;
  /** The raw click timestamp (`performance.now()` of the entry page), null for cold. */
  clickT: number | null;
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
  /** Paths along the chain that produced `serialDepth`, deepest last. */
  serialChain: string[];
  apiCallsTotal: number;
  apiFirstScreen: number;
  /**
   * The first-screen requests themselves: one row per request with its wave, the
   * predecessor it waited on, its `Server-Timing` and the client/server gap.
   * This is the per-request evidence QA asked for; `apiFirstScreen` stays as the
   * count so the two can be cross-checked.
   */
  apiFirstScreenEntries: PerfApiEntry[];
  /** Script/JS chunk accounting for the round. */
  chunksLoaded: number;
  chunkBytes: number;
  lcpMs: number | null;
  slowestServerTotalMs: number | null;
  /** Failure text for the round (`warm target not found`, navigation errors, ...). */
  error?: string;
  /** Writes the guard stopped; always aborted, never sent to the server. */
  blockedWrites: number;
  /** Writes the allow-list fulfilled inside the browser (see lib/stub-writes.ts). */
  stubbedWrites: number;
  /** Milliseconds from the click to the `?issue=` commit; a correctness check. */
  urlCommitMs: number | null;
  /** Milliseconds from landing on the entry page to finding the target row. */
  entryReadyMs: number | null;
  /** API requests in flight when the warm click happened; null for cold rounds. */
  entryInflightAtClick: number | null;
  /** Whether the entry page was quiet before the click; null when the rule was off. */
  entrySettled: boolean | null;
  /** True when the browser's first inbox page had the target injected. */
  inboxInjected: boolean;
  /** GET `/api/inbox/page` responses served before the first stubbed write. */
  inboxPageRequestsBeforeStub: number | null;
  /**
   * Text of the row the warm click targeted. The acceptance check is "the clicked
   * row is the target issue", and only the row's own text can show that.
   */
  clickedRowText?: string | null;
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
  /** Read state of the chosen notification, per the third review round. */
  targetRead?: boolean;
  /** True when any notification on the target's rendered row is unread. */
  targetGroupHasUnread?: boolean;
  /** 1-based API page the probe read the target from. */
  inboxApiPage?: number | null;
  hoverLeadMs: number | null;
  rounds: ReportRoundSummary[];
  stats: ReportScenarioStats;
}

/** `stats` plus the per-path aggregate that only the report needs to carry. */
export interface ReportScenarioStats extends PerfScenarioStats {
  /**
   * Per-path aggregate over the scenario's rounds. The acceptance rule is stated
   * per path ("每个 path 的 total p95 ≤ 200ms; gap p50 ≤ 80ms" — plan §9), so a
   * round-level "slowest API" cannot express it.
   */
  apiByPath: PerfApiPathStats[];
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
  /** Writes fulfilled by the allow-list, reported separately from the aborts. */
  stubbedWrites?: Array<{ page: string; method: string; path: string; attempts: number }>;
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
    entryQuietMs?: number | null;
    entryQuietCapMs?: number;
    entryQuietNote?: string;
    writeGuardSelfTest?: { blocked?: boolean; target?: string; detail?: string };
    ambientLatency?: { before?: { medianMs?: number | null }; after?: { medianMs?: number | null } };
  };
  const lines: string[] = [];
  lines.push(`# MUL-383 页面测速基线（schema ${REPORT_SCHEMA}）`);
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
  lines.push(
    "- cold 用 `page.goto`；warm 先 hover 后真实 click，`navStartMs` 取页面内记录的 click 时间戳。**warm 的每一毫秒都从 click 起算**：帧、跳动、`Server-Timing` 与首屏集合都先减 `navStartMs`，首屏集合另有 `startMs ≥ navStartMs` 的下界，所以入口页的尾请求不计入目标页；cold 的 `navStartMs = 0`，数字与旧口径一致。",
  );
  // The entry-page quiet rule is a measurement-contract switch, not a detail:
  // the number it produces means something different when it is off.
  const entryQuiet = meta.entryQuietMs ?? null;
  lines.push(
    entryQuiet === null
      ? "- 入口页安静：**关闭**（`--entry-quiet-ms 0`）。warm 轮在目标行一出现就点击，量的是「从一个还在加载的页面切走」。"
      : `- 入口页安静（MUL-383 A1，2026-09-27 定案）：warm 轮在目标行出现后再等入口页 \`${entryQuiet}\` ms 内没有新的 \`/api/**\` 请求开始，最多等 \`${meta.entryQuietCapMs ?? 5_000}\` ms；超时照点并记 \`entrySettled=false\`。点击时的在途数记 \`entryInflightAtClick\`。`,
  );
  lines.push(
    "- 串行深度：`wave = 1 + max(wave(p) | p.responseEnd ≤ start + 8ms)`；`Server-Timing` 由 resource timing 同源读取。口径不变，另存 `serialChain` 与逐请求 `wave/after`。",
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
    "| 场景 | 模式 | 轮 | ready ms | firstReal ms | anchorVisible ms | anchor | anchorRect(top/bottom/height/root) | appReady ms | 跳动数 | 位移 px | CLS | LCP ms | 最慢 Server-Timing ms | chunks | chunk bytes | 串行深度 | 首屏 API | 拦截写请求 | 桩写请求 | URL 提交 ms | 目标前置 | 前置前 inbox 请求 | 点击行文本 | error |",
  );
  lines.push(
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  );
  for (const scenario of report.scenarios) {
    for (const round of scenario.rounds) {
      const rect = round.anchorRectAtReady;
      const rectText = rect
        ? `${rect.top}/${rect.bottom}/${rect.height}/${rect.rootHeight}`
        : "-";
      lines.push(
        `| ${scenario.key} | ${scenario.mode} | ${round.round} | ${fmtMs(round.readyMs)}${round.readyTimeout ? " ⚠" : ""} | ${fmtMs(round.firstRealMs)} | ${fmtMs(round.anchorVisibleMs)} | ${round.anchorName ?? "-"} | ${rectText} | ${fmtMs(round.appReadyMs)}${round.appReadyForced ? " (forced)" : ""} | ${round.jumpCount} | ${fmtMs(round.jumpPx)} | ${round.cls} | ${fmtMs(round.lcpMs)} | ${fmtMs(round.slowestServerTotalMs)} | ${round.chunksLoaded} | ${fmtBytes(round.chunkBytes)} | ${round.serialDepth ?? "-"} | ${round.apiFirstScreen}/${round.apiCallsTotal} | ${round.blockedWrites} | ${round.stubbedWrites} | ${fmtMs(round.urlCommitMs)} | ${round.inboxInjected ? "注入" : "-"} | ${round.inboxPageRequestsBeforeStub ?? "-"} | ${(round.clickedRowText ?? "-").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 60)} | ${round.error ?? "-"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 首屏 API 表（按 path 聚合，跨本场景各轮）");
  lines.push("");
  lines.push(
    "口径：只统计 `startMs ≥ navStartMs` 且不晚于就绪帧的请求（warm 从 click 起算）；"
      + "`total` 是服务端 `Server-Timing`，`gap` 是客户端 duration 减服务端 total（排队与连接）。"
      + "分位数用最近秩法，`n` 是本场景各轮的请求总数，`轮` 是出现过该 path 的轮数。",
  );
  lines.push("");
  const pathRows = report.scenarios.filter((scenario) => (scenario.stats.apiByPath ?? []).length > 0);
  if (pathRows.length === 0) {
    lines.push("_没有可聚合的首屏请求（场景全部跳过或基线早于 schema 3）。_");
    lines.push("");
  }
  for (const scenario of pathRows) {
    lines.push(`### ${scenario.key}（${scenario.mode}）`);
    lines.push("");
    lines.push(
      "| path | 方法 | n | 轮 | total p50 | total p95 | db p95 | dbq max | dbb max | gap p50 |",
    );
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const row of scenario.stats.apiByPath ?? []) {
      lines.push(
        `| \`${row.path}\` | ${row.method} | ${row.count} | ${row.rounds} | ${fmtMs(row.totalP50)} | ${fmtMs(row.totalP95)} | ${fmtMs(row.dbP95)} | ${row.dbqMax ?? "-"} | ${fmtBytes(row.dbbMax)} | ${fmtMs(row.gapP50)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## 逐轮时基与串行链");
  lines.push("");
  lines.push(
    "_逐请求明细（`path`/`wave`/`after`/`startMs`/`Server-Timing`/`gapMs`）在 JSON 的 "
      + "`scenarios[].rounds[].apiFirstScreenEntries[]`，HTML 里按场景折叠显示。_",
  );
  lines.push("");
  lines.push("| 场景 | 模式 | 轮 | navStart ms | clickT ms | 入口就绪 ms | 点击时在途 API | 入口安静 | 串行链 |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const scenario of report.scenarios) {
    for (const round of scenario.rounds) {
      const entrySettled = round.entrySettled === null || round.entrySettled === undefined
        ? "-"
        : round.entrySettled ? "是" : "超时";
      const chain = (round.serialChain ?? []).join(" → ") || "-";
      lines.push(
        `| ${scenario.key} | ${scenario.mode} | ${round.round} | ${fmtMs(round.navStartMs)} | ${fmtMs(round.clickT)} | ${fmtMs(round.entryReadyMs)} | ${round.entryInflightAtClick ?? "-"} | ${entrySettled} | \`${chain}\` |`,
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
  const stubs = report.stubbedWrites ?? [];
  if (stubs.length > 0) {
    lines.push("## 被允许表接管的写请求（在浏览器内 fulfill，未到达服务端）");
    lines.push("");
    lines.push("| 页面 | 方法 | path 模式 | 次数 |");
    lines.push("| --- | --- | --- | ---: |");
    for (const write of stubs) {
      lines.push(`| ${write.page} | ${write.method} | \`${write.path}\` | ${write.attempts} |`);
    }
    lines.push("");
    lines.push("> 仅 `POST /api/inbox/:id/read`；响应在浏览器内生成，服务器仍为零写入。");
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
  stubbedWrites?: Array<{ page: string; method: string; path: string; attempts: number }>;
  compareTable?: CompareRow[] | null;
  /** Per-path comparison; pairs on `key::mode::path` (see `buildCompare`). */
  comparePathTable?: ComparePathRow[] | null;
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

  // Per-path first-screen table, one `<section>` per scenario: this is the view
  // the acceptance rule is written against ("每个 path 的 total p95 ≤ 200ms;
  // gap p50 ≤ 80ms"), so a reader must not have to aggregate the round table.
  const apiPathTables = report.scenarios
    .filter((scenario) => (scenario.stats.apiByPath ?? []).length > 0)
    .map((scenario) => {
      const body = (scenario.stats.apiByPath ?? [])
        .map((row) => {
          const overBudget = (row.totalP95 ?? 0) > 200 || (row.gapP50 ?? 0) > 80;
          return `<tr>
      <td><code>${esc(row.path)}</code></td>
      <td class="muted">${esc(row.method)}</td>
      <td class="num">${row.count}</td>
      <td class="num">${row.rounds}</td>
      <td class="num">${fmtMs(row.totalP50)}</td>
      <td class="num${overBudget ? " bad" : " good"}">${fmtMs(row.totalP95)}</td>
      <td class="num">${fmtMs(row.dbP95)}</td>
      <td class="num">${row.dbqMax ?? "-"}</td>
      <td class="num">${fmtBytes(row.dbbMax)}</td>
      <td class="num${(row.gapP50 ?? 0) > 80 ? " bad" : " good"}">${fmtMs(row.gapP50)}</td>
    </tr>`;
        })
        .join("\n");
      return `<h3>${esc(scenario.key)}（${esc(scenario.mode)}）</h3>
<div class="tablewrap"><table>
<thead><tr><th>path</th><th>方法</th><th class="num">n</th><th class="num">轮</th><th class="num">total p50</th><th class="num">total p95</th><th class="num">db p95</th><th class="num">dbq max</th><th class="num">dbb max</th><th class="num">gap p50</th></tr></thead>
<tbody>
${body}
</tbody>
</table></div>`;
    })
    .join("\n");

  // Per-request rows, wrapped in a `<details>` per scenario so a 5-round baseline
  // does not open with ~5000 rows of table.
  const apiEntrySections = report.scenarios
    .map((scenario) => {
      const rounds = scenario.rounds.filter((round) => (round.apiFirstScreenEntries ?? []).length > 0);
      if (rounds.length === 0) return "";
      const body = rounds
        .flatMap((round) =>
          (round.apiFirstScreenEntries ?? []).map((entry) => `<tr>
      <td class="num">${round.round}</td>
      <td><code>${esc(entry.path)}</code></td>
      <td class="muted">${esc(entry.method)}</td>
      <td class="num">${entry.wave}</td>
      <td class="num">${entry.after ?? "-"}</td>
      <td class="num">${fmtMs(entry.startMs)}</td>
      <td class="num">${fmtMs(entry.responseEndMs)}</td>
      <td class="num">${fmtMs(entry.durationMs)}</td>
      <td class="num">${fmtMs(entry.serverTiming.total)}</td>
      <td class="num">${fmtMs(entry.serverTiming.db)}</td>
      <td class="num">${entry.serverTiming.dbq ?? "-"}</td>
      <td class="num">${fmtBytes(entry.encodedBytes)}</td>
      <td class="num">${fmtMs(entry.gapMs)}</td>
    </tr>`),
        )
        .join("\n");
      return `<details><summary>${esc(scenario.key)}（${esc(scenario.mode)}）：${rounds.length} 轮</summary>
<div class="tablewrap"><table>
<thead><tr><th class="num">轮</th><th>path</th><th>方法</th><th class="num">wave</th><th class="num">after</th><th class="num">start ms</th><th class="num">end ms</th><th class="num">duration ms</th><th class="num">total ms</th><th class="num">db ms</th><th class="num">dbq</th><th class="num">bytes</th><th class="num">gap ms</th></tr></thead>
<tbody>
${body}
</tbody>
</table></div></details>`;
    })
    .filter(Boolean)
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
      <td class="num">${round.stubbedWrites}</td>
      <td class="num">${fmtMs(round.urlCommitMs)}</td>
      <td>${round.inboxInjected ? "注入" : "-"}</td>
      <td class="num">${round.inboxPageRequestsBeforeStub ?? "-"}</td>
      <td class="muted">${esc((round.clickedRowText ?? "-").slice(0, 60))}</td>
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

  const stubbedRows = (report.stubbedWrites ?? [])
    .map(
      (write) =>
        `<tr><td>${esc(write.page)}</td><td>${esc(write.method)}</td><td><code>${esc(write.path)}</code></td><td class="num">${write.attempts}</td></tr>`,
    )
    .join("\n");

  const blockedRows = report.blockedWrites
    .map(
      (write) =>
        `<tr><td>${esc(write.page)}</td><td>${esc(write.method)}</td><td><code>${esc(write.path)}</code></td><td class="num">${write.attempts}</td></tr>`,
    )
    .join("\n");

  const comparePathRows = (report.comparePathTable ?? [])
    .map((row) => {
      const delta = (before: number | null, after: number | null): string => {
        if (before === null || after === null) return '<span class="muted">-</span>';
        const diff = after - before;
        const cls = diff > 0 ? "bad" : diff < 0 ? "good" : "muted";
        return `<span class="${cls}">${diff > 0 ? "+" : ""}${diff.toFixed(1)}</span>`;
      };
      // Withheld pairing: the same phrase the Markdown uses, and no numeric cell.
      if (!row.comparable) {
        return `<tr class="withheld">
      <td class="key">${esc(row.key)}</td><td>${esc(row.mode)}</td>
      <td><code>${esc(row.path)}</code></td>
      <td class="muted" colspan="8">不可比（schema 2 warm 已作废）</td>
    </tr>`;
      }
      return `<tr>
      <td class="key">${esc(row.key)}</td><td>${esc(row.mode)}</td>
      <td><code>${esc(row.path)}</code></td>
      <td class="num">${row.beforeCount ?? "-"} → ${row.afterCount ?? "-"}</td>
      <td class="num">${fmtMs(row.beforeTotalP95)} → ${fmtMs(row.afterTotalP95)}</td><td class="num">${delta(row.beforeTotalP95, row.afterTotalP95)}</td>
      <td class="num">${fmtMs(row.beforeGapP50)} → ${fmtMs(row.afterGapP50)}</td><td class="num">${delta(row.beforeGapP50, row.afterGapP50)}</td>
      <td class="num">${row.beforeDbqMax ?? "-"} → ${row.afterDbqMax ?? "-"}</td>
    </tr>`;
    })
    .join("\n");

  const compareRows = (report.compareTable ?? [])
    .map((row) => {
      const delta = (before: number | null, after: number | null): string => {
        if (before === null || after === null) return '<span class="muted">-</span>';
        const diff = after - before;
        const cls = diff > 0 ? "bad" : diff < 0 ? "good" : "muted";
        return `<span class="${cls}">${diff > 0 ? "+" : ""}${diff.toFixed(1)}</span>`;
      };
      if (!row.comparable) {
        return `<tr class="withheld">
      <td class="key">${esc(row.key)}</td><td>${esc(row.mode)}</td>
      <td>${esc(row.beforeMode ?? "-")} → ${esc(row.afterMode ?? "-")}</td>
      <td class="muted" colspan="7">不可比（schema 2 warm 已作废）</td>
    </tr>`;
      }
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
<title>MUL-383 页面测速基线（schema ${REPORT_SCHEMA}）</title>
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
  tr.withheld td { color: #71717a; font-style: italic; }
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
<h1>MUL-383 页面测速基线（schema ${REPORT_SCHEMA}）</h1>
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
  <dt>warm 时基</dt><dd>页面内记录的 click（<code>navStartMs</code>）；帧、跳动与首屏集合都从它起算，cold 为文档 origin</dd>
  <dt>入口页安静</dt><dd>${meta.entryQuietMs === null || meta.entryQuietMs === undefined
    ? "关闭（<code>--entry-quiet-ms 0</code>）"
    : `${esc(meta.entryQuietMs)} ms 无新 <code>/api</code> 请求才开始点击，上限 ${esc(meta.entryQuietCapMs ?? 5_000)} ms`}</dd>
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
<thead><tr><th>场景</th><th>模式</th><th class="num">轮</th><th class="num">ready ms</th><th class="num">firstReal ms</th><th class="num">anchorVisible ms</th><th>anchor</th><th>anchorRect(top/bottom/height/root)</th><th class="num">appReady ms</th><th class="num">跳动数</th><th class="num">位移 px</th><th class="num">CLS</th><th class="num">LCP ms</th><th class="num">最慢 Server-Timing ms</th><th class="num">chunks</th><th class="num">chunk bytes</th><th class="num">串行深度</th><th class="num">首屏 API</th><th class="num">拦截写请求</th><th class="num">桩写请求</th><th class="num">URL 提交 ms</th><th>目标前置</th><th class="num">前置前 inbox 请求</th><th>点击行文本</th><th>error</th></tr></thead>
<tbody>
${detailRows}
</tbody>
</table></div>
${apiPathTables ? `<h2>首屏 API 表（按 path 聚合）</h2>\n<p class="muted">只统计 <code>startMs ≥ navStartMs</code> 且不晚于就绪帧的请求（warm 从 click 起算）；<code>gap</code> = 客户端 duration − 服务端 <code>total</code>。红色表示超出 total p95 ≤ 200ms 或 gap p50 ≤ 80ms。${meta.entryQuietMs === null || meta.entryQuietMs === undefined ? "本轮入口页安静规则关闭。" : `本轮入口页安静：${esc(meta.entryQuietMs)} ms / 上限 ${esc(meta.entryQuietCapMs ?? 5_000)} ms。`}</p>\n${apiPathTables}` : ""}
${apiEntrySections ? `<h2>逐请求明细</h2>\n<p class="muted">JSON <code>scenarios[].rounds[].apiFirstScreenEntries[]</code> 的展开视图。</p>\n${apiEntrySections}` : ""}
${jumpRows ? `<h2>跳动明细</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>场景</th><th>模式</th><th class="num">轮</th><th class="num">start ms</th><th class="num">end ms</th><th class="num">位移 px</th><th class="num">scroll px</th><th>kind</th><th class="num">frames</th></tr></thead>\n<tbody>\n${jumpRows}\n</tbody>\n</table></div>` : ""}
${stubbedRows ? `<h2>被允许表接管的写请求（浏览器内 fulfill）</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>页面</th><th>方法</th><th>path 模式</th><th class="num">次数</th></tr></thead>\n<tbody>\n${stubbedRows}\n</tbody>\n</table></div>` : ""}
${blockedRows ? `<h2>被拦截的写请求（全部为 abort）</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>页面</th><th>方法</th><th>path 模式</th><th class="num">尝试</th></tr></thead>\n<tbody>\n${blockedRows}\n</tbody>\n</table></div>` : ""}
${comparePathRows ? `<h2>与基线对比：按 path</h2>\n<div class="tablewrap"><table>\n<thead><tr><th>场景</th><th>模式</th><th>path</th><th class="num">n</th><th class="num">total p95</th><th class="num">Δ</th><th class="num">gap p50</th><th class="num">Δ</th><th class="num">dbq max</th></tr></thead>\n<tbody>\n${comparePathRows}\n</tbody>\n</table></div>` : ""}
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
  /**
   * False when the two sides are not the same quantity and must not be
   * subtracted. Only one case exists today: a schema 2 baseline's warm row
   * measured from the entry page's document origin, against a schema 3 warm row
   * measured from the click. Every numeric field is null on such a row, so no
   * renderer can print a delta even by accident.
   */
  comparable: boolean;
  /** Why the row is not comparable; null when `comparable` is true. */
  notComparableReason: string | null;
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

/** One `key::mode::path` pairing in the per-path comparison table. */
export interface ComparePathRow {
  key: string;
  mode: string;
  path: string;
  method: string;
  /**
   * False when this scenario::mode pairing was withheld upstream (see
   * {@link CompareRow.comparable}). Always explicit rather than inferred from
   * null values, so a genuinely absent `Server-Timing` is never mistaken for an
   * incomparable pairing.
   */
  comparable: boolean;
  beforeCount: number | null;
  afterCount: number | null;
  beforeTotalP50: number | null;
  afterTotalP50: number | null;
  beforeTotalP95: number | null;
  afterTotalP95: number | null;
  beforeGapP50: number | null;
  afterGapP50: number | null;
  beforeDbqMax: number | null;
  afterDbqMax: number | null;
  beforeDbbMax: number | null;
  afterDbbMax: number | null;
}

/**
 * `--compare` pairing for the per-path table: `key::mode::path`.
 *
 * The scenario table answers "did this page get faster"; this one answers "which
 * endpoint did it", which is the question every later S9 item is graded on (plan
 * §9). Paths only present on one side are still emitted, with the other column
 * blank: a path that disappeared *is* the result for an optimization that removes
 * a request.
 */
export function buildCompareByPath(
  baseline: { scenarios: ReportScenario[]; meta?: { schema?: number } },
  current: { scenarios: ReportScenario[]; meta?: { schema?: number } },
): ComparePathRow[] {
  const bucket = (scenarios: ReportScenario[]): Map<string, PerfApiPathStats> => {
    const out = new Map<string, PerfApiPathStats>();
    for (const scenario of scenarios) {
      for (const stat of scenario.stats.apiByPath ?? []) {
        out.set(`${scenario.key}::${scenario.mode}::${stat.path}::${stat.method}`, stat);
      }
    }
    return out;
  };
  const before = bucket(baseline.scenarios);
  const after = bucket(current.scenarios);
  const keys: string[] = [];
  for (const key of before.keys()) keys.push(key);
  for (const key of after.keys()) if (!keys.includes(key)) keys.push(key);
  const rows = keys.map((key) => {
    const [scenarioKey = "", mode = "", path = "", method = ""] = key.split("::");
    const a = before.get(key) ?? null;
    const b = after.get(key) ?? null;
    // A withheld scenario::mode carries through to every one of its paths: the
    // endpoints were collected under the same broken time base *and* the same
    // unbounded first-screen set, so neither their p95s nor their counts are
    // subtractable from a schema 3 warm path. (A schema 2 count also included the
    // entry page's trailing requests, which is what the lower bound removed.)
    const withhold = compareIncomparability(baseline, mode) !== null;
    return {
      key: scenarioKey,
      mode,
      path,
      method: a?.method ?? b?.method ?? method,
      comparable: !withhold,
      beforeCount: withhold ? null : a?.count ?? null,
      afterCount: withhold ? null : b?.count ?? null,
      beforeTotalP50: withhold ? null : a?.totalP50 ?? null,
      afterTotalP50: withhold ? null : b?.totalP50 ?? null,
      beforeTotalP95: withhold ? null : a?.totalP95 ?? null,
      afterTotalP95: withhold ? null : b?.totalP95 ?? null,
      beforeGapP50: withhold ? null : a?.gapP50 ?? null,
      afterGapP50: withhold ? null : b?.gapP50 ?? null,
      beforeDbqMax: withhold ? null : a?.dbqMax ?? null,
      afterDbqMax: withhold ? null : b?.dbqMax ?? null,
      beforeDbbMax: withhold ? null : a?.dbbMax ?? null,
      afterDbbMax: withhold ? null : b?.dbbMax ?? null,
    };
  });
  return rows.sort((left, right) =>
    left.key.localeCompare(right.key)
    || left.mode.localeCompare(right.mode)
    || left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method));
}

/**
 * The reason a comparison is impossible, or null when the two sides measure the
 * same quantity.
 *
 * A schema 2 warm row was collected from the entry page's *document* origin
 * (MUL-395 §1, A2): its `readyMs`, first-screen count and serial depth are not the
 * quantities a schema 3 warm row reports from the click. Subtracting them
 * produces a number that looks like an improvement and means nothing — the
 * review found exactly that in a 4000ms → 500ms sample, printed as `-3500.0`.
 * Cold rows share the document origin on both sides, so they stay comparable.
 */
export function compareIncomparability(
  baseline: { meta?: { schema?: number } },
  mode: string,
): string | null {
  if (mode !== "warm") return null;
  const baselineSchema = baseline.meta?.schema;
  if (baselineSchema === undefined) return null;
  if (baselineSchema >= 3) return null;
  if (baselineSchema === 2) {
    return "schema 2 的 warm 行从入口页文档起算，schema 3 从 click 起算：09-27 基线的 warm 行已作废，不可与任何 schema 3 warm 行相减";
  }
  // Schema 1 (MUL-367) predates the warm round and this report shape entirely;
  // its warm rows are not this quantity at all.
  return `schema ${baselineSchema} 的 warm 行不是本轮口径，不可与 schema 3 warm 行相减`;
}

/**
 * `--compare` pairing and its warnings. Pairing is by `key + mode`; a differing
 * `selectorMode` or inbox target is reported but never blocks the comparison,
 * because the two runs legitimately differ while the contract rolls out. The one
 * thing that *does* block numbers is the warm time-base mismatch above: those
 * rows are emitted without values and only warn.
 */
export function buildCompare(
  baseline: { scenarios: ReportScenario[]; meta?: { schema?: number } },
  current: { scenarios: ReportScenario[]; meta?: { schema?: number } },
): { rows: CompareRow[]; pathRows: ComparePathRow[]; warnings: CompareWarning[]; markdown: string } {
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
    // Not gated on the row existing on both sides: a warm row whose counterpart is
    // missing from the baseline still sits in a table whose baseline side is the
    // invalidated time base, and its current numbers would read as the other half
    // of a comparison that cannot be made. Those numbers are in the scenario's own
    // `rounds[]`/`stats` (schema 3, same run) for anyone who wants them alone.
    const incomparableReason = compareIncomparability(baseline, mode);
    // Withheld means *every* number is null, not "the renderer remembers to hide
    // it": a later consumer reading `batch.rows` from the JSON gets nothing to
    // subtract either.
    const withhold = incomparableReason !== null;
    rows.push({
      key: scenarioKey,
      mode,
      comparable: !withhold,
      notComparableReason: incomparableReason,
      beforeMode: a?.selectorMode ?? null,
      afterMode: b?.selectorMode ?? null,
      beforeReadyP75: withhold ? null : a?.stats.readyP75 ?? null,
      afterReadyP75: withhold ? null : b?.stats.readyP75 ?? null,
      beforeReadyP95: withhold ? null : a?.stats.readyP95 ?? null,
      afterReadyP95: withhold ? null : b?.stats.readyP95 ?? null,
      beforeJumpsMax: withhold ? null : a?.stats.jumpsMax ?? null,
      afterJumpsMax: withhold ? null : b?.stats.jumpsMax ?? null,
      beforeSerialDepthMax: withhold ? null : a?.stats.serialDepthMax ?? null,
      afterSerialDepthMax: withhold ? null : b?.stats.serialDepthMax ?? null,
      beforeApiFirstScreenP50: withhold ? null : a?.stats.apiFirstScreenP50 ?? null,
      afterApiFirstScreenP50: withhold ? null : b?.stats.apiFirstScreenP50 ?? null,
      beforeTimelineRequests: withhold ? null : deepestTargetDepth(a)?.timelineRequests ?? null,
      afterTimelineRequests: withhold ? null : deepestTargetDepth(b)?.timelineRequests ?? null,
    });
    if (incomparableReason !== null) {
      warnings.push({ key: scenarioKey, mode, message: incomparableReason });
    }
    // The remaining comparisons are advisory only, and a withheld row has nothing
    // left to warn about beyond the reason itself.
    if (!withhold && a && b && a.selectorMode !== b.selectorMode) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `选择器模式不同（${a.selectorMode} → ${b.selectorMode}）：数字不可直接比较`,
      });
    }
    if (!withhold && a && b && a.target.identifier !== b.target.identifier) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `目标不同（${a.target.identifier} → ${b.target.identifier}）`,
      });
    }
    if (!withhold && a && b && a.targetSelection !== b.targetSelection) {
      warnings.push({
        key: scenarioKey,
        mode,
        message: `深链目标选择方式不同（${a.targetSelection ?? "-"} → ${b.targetSelection ?? "-"}）`,
      });
    }
    const beforeDepth = deepestTargetDepth(a);
    const afterDepth = deepestTargetDepth(b);
    if (!withhold && beforeDepth && afterDepth && beforeDepth.timelineRequests !== afterDepth.timelineRequests) {
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
    // A withheld row renders as one phrase across its numeric columns. There is no
    // "-3500.0" to misread: the row's values are null upstream, and this branch
    // never formats a number for it.
    if (!row.comparable) {
      lines.push(
        `| ${row.key} | ${row.mode} | ${row.beforeMode ?? "-"} → ${row.afterMode ?? "-"} | 不可比（schema 2 warm 已作废） | - | 不可比（schema 2 warm 已作废） | - | - | - | - |`,
      );
      continue;
    }
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
  const pathRows = buildCompareByPath(baseline, current);
  if (pathRows.length > 0) {
    lines.push("");
    lines.push("### 按 path 对比（`key::mode::path` 配对）");
    lines.push("");
    lines.push(
      "| 场景 | 模式 | path | 方法 | n | total p50 | total p95 | 差值 | gap p50 | 差值 | dbq max |",
    );
    lines.push("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const row of pathRows) {
      // Same rule as the scenario table: no deltas for a withheld pairing, and
      // "every number is null" is what makes that true rather than the formatting.
      const withheld = !row.comparable;
      const count = row.beforeCount === null || row.afterCount === null
        ? `${row.beforeCount ?? "-"} → ${row.afterCount ?? "-"}`
        : `${row.beforeCount} → ${row.afterCount}`;
      if (withheld) {
        // Counts are withheld too: the schema 2 count also carried the entry
        // page's trailing requests, so "5 → 3" would put a corrected number next
        // to an uncorrected one.
        lines.push(
          `| ${row.key} | ${row.mode} | \`${row.path}\` | ${row.method} | 不可比（schema 2 warm 已作废） | - | - | - | - | - | - |`,
        );
        continue;
      }
      const delta = (before: number | null, after: number | null): string =>
        before === null || after === null ? "-" : `${after - before > 0 ? "+" : ""}${(after - before).toFixed(1)}`;
      lines.push(
        `| ${row.key} | ${row.mode} | \`${row.path}\` | ${row.method} | ${count} | ${fmtMs(row.beforeTotalP50)} → ${fmtMs(row.afterTotalP50)} | ${fmtMs(row.beforeTotalP95)} → ${fmtMs(row.afterTotalP95)} | ${delta(row.beforeTotalP95, row.afterTotalP95)} | ${fmtMs(row.beforeGapP50)} → ${fmtMs(row.afterGapP50)} | ${delta(row.beforeGapP50, row.afterGapP50)} | ${row.beforeDbqMax ?? "-"} → ${row.afterDbqMax ?? "-"} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "> 差值只在同一台机器、同一网络位置、同一 rounds 下可比；schema 1（MUL-367）与新口径不可比。"
      + "schema 2 的 warm 行整行不可比（时基从入口页文档起算），只列警告、不出数字；cold 行照常配对。",
  );
  return { rows, pathRows, warnings, markdown: lines.join("\n") };
}
