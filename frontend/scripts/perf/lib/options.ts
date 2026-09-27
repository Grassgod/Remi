/**
 * The probe's command line and its fixture exclusions.
 *
 * Extracted from `page-speed.ts` (MUL-395 S9-0) because that file calls `main()`
 * at import time and therefore cannot be unit-tested: the exclusion list and the
 * argument defaults are exactly the kind of contract that used to change without
 * a test noticing.
 */

import type { SelectorModeOption } from "./selectors";

export const DEFAULT_BASE_URL = "http://n37-117-209.byted.org";
export const DEFAULT_ROUNDS = 3;
export const DEFAULT_OUT_DIR = "reports/performance";
export const DEFAULT_QUIET_MS = 500;
export const DEFAULT_HOVER_LEAD_MS = 150;
/**
 * Entry-page quiet window and the cap that bounds it.
 *
 * The window defaults to 500ms (MUL-383 pending item A1, answered 2026-09-27):
 * a warm round waits until the entry page has had no new `/api/**` request for
 * that long before clicking, so the number describes "navigating away from a
 * settled page". The cap is 5s; a round that hits it clicks anyway and records
 * `entrySettled: false` rather than failing, so a permanently busy entry page
 * still produces a measurement with the reason attached.
 *
 * `--entry-quiet-ms 0` turns the rule off (the pre-A1 behaviour: click as soon as
 * a row renders).
 */
export const DEFAULT_ENTRY_QUIET_MS = 500;
export const ENTRY_QUIET_CAP_MS = 5_000;
/** Poll interval for the entry-page quiet rule and the API-activity check. */
export const ENTRY_API_POLL_MS = 100;

/**
 * How many inbox API pages the probe may read to find a deep-link target.
 *
 * The target must exist in the account's inbox, not necessarily on page one: the
 * first page only covers a few hours on a busy account, so a page-one-only rule
 * made the scenario untestable for most of the day (MUL-384 `cmt_sr7dl2nrdyq7`).
 */
export const DEFAULT_INBOX_PROBE_PAGES = 10;

/** The long fixture that MUL-395's before/after comparison is pinned to. */
export const DEFAULT_ISSUE_SHORT = "iss_in41j1x1dq66";
export const DEFAULT_ISSUE_LONG = "iss_enbrunyg86jc";
/**
 * The ≥200-comment fixture for `detail-xlong` (MUL-454).
 *
 * `detail-long` stays on MUL-70: that is the fixture MUL-395's before/after
 * comparison is defined against, and moving it would break every pairing. The
 * "long (≥170)" semantics the parent issue asked for get their own scenario so
 * neither number is ambiguous.
 */
export const DEFAULT_ISSUE_XLONG = "iss_o2skonppbq2u";

/**
 * MUL-383 and every child of it: excluded from the running-issue pick, together
 * with their children (fetched at run time by `loadExcludedIssueIds`).
 */
export const EXCLUDED_RUNNING_ISSUE_PARENTS = ["iss_j67lb0r8djw4"];

/**
 * Leaf issues that must never become `detail-running`'s target.
 *
 * MUL-454 is the ≥200-comment long fixture: it is deliberately kept in progress
 * and assigned to nobody, so the probe's "some running task's issue" search would
 * happily pick it and then measure the long fixture twice under two names.
 */
export const EXCLUDED_RUNNING_ISSUE_IDS = ["iss_o2skonppbq2u"];

/**
 * Every issue id the running-issue pick must skip: the leaf list, the parents and
 * the children of those parents.
 */
export function collectExcludedRunningIssueIds(childrenOfParents: Iterable<string> = []): Set<string> {
  const excluded = new Set<string>([...EXCLUDED_RUNNING_ISSUE_PARENTS, ...EXCLUDED_RUNNING_ISSUE_IDS]);
  for (const child of childrenOfParents) excluded.add(child);
  return excluded;
}

export interface Options {
  /** Set by `--help`; the caller prints the usage text and stops. */
  help: boolean;
  baseUrl: string;
  rounds: number;
  outDir: string;
  name: string | null;
  compare: string | null;
  quietMs: number;
  window: "peak" | "offpeak";
  selectors: SelectorModeOption;
  issueShort: string;
  issueLong: string;
  /**
   * The ≥200-comment fixture for `detail-xlong`, or null to skip that scenario.
   * Separate from `issueLong` so MUL-395's comparison fixture stays pinned.
   */
  issueXlong: string | null;
  issueRunning: string | null;
  inboxItem: string | null;
  inboxProbePages: number;
  hoverLeadMs: number;
  /**
   * Milliseconds of entry-page API quiet required before the warm click, or null
   * when the rule is off. Defaults to {@link DEFAULT_ENTRY_QUIET_MS}; capped at
   * {@link ENTRY_QUIET_CAP_MS}.
   */
  entryQuietMs: number | null;
  only: string | null;
  warmup: boolean;
}

export function defaultOptions(): Options {
  return {
    help: false,
    baseUrl: DEFAULT_BASE_URL,
    rounds: DEFAULT_ROUNDS,
    outDir: DEFAULT_OUT_DIR,
    name: null,
    compare: null,
    quietMs: DEFAULT_QUIET_MS,
    window: "offpeak",
    selectors: "auto",
    issueShort: DEFAULT_ISSUE_SHORT,
    issueLong: DEFAULT_ISSUE_LONG,
    issueXlong: DEFAULT_ISSUE_XLONG,
    issueRunning: null,
    inboxItem: null,
    inboxProbePages: DEFAULT_INBOX_PROBE_PAGES,
    hoverLeadMs: DEFAULT_HOVER_LEAD_MS,
    entryQuietMs: DEFAULT_ENTRY_QUIET_MS,
    only: null,
    warmup: false,
  };
}

export function parseArgs(argv: string[]): Options {
  const opts = defaultOptions();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--base-url":
        opts.baseUrl = next().replace(/\/+$/, "");
        break;
      case "--rounds":
        opts.rounds = Number.parseInt(next(), 10);
        break;
      case "--out":
        opts.outDir = next();
        break;
      case "--name":
        opts.name = next();
        break;
      case "--compare":
        opts.compare = next();
        break;
      case "--quiet-ms":
        opts.quietMs = Number.parseInt(next(), 10);
        break;
      case "--window": {
        const value = next();
        if (value !== "peak" && value !== "offpeak") throw new Error("--window must be peak or offpeak");
        opts.window = value;
        break;
      }
      case "--selectors": {
        const value = next();
        if (value !== "auto" && value !== "contract" && value !== "legacy") {
          throw new Error("--selectors must be auto, contract or legacy");
        }
        opts.selectors = value;
        break;
      }
      case "--issue-short":
        opts.issueShort = next();
        break;
      case "--issue-long":
        opts.issueLong = next();
        break;
      case "--issue-xlong": {
        const value = next();
        // An explicit empty value is how a caller drops the scenario without
        // editing the script; `--only` cannot express that.
        opts.issueXlong = value === "" || value === "none" ? null : value;
        break;
      }
      case "--issue-running":
        opts.issueRunning = next();
        break;
      case "--inbox-item":
        opts.inboxItem = next();
        break;
      case "--inbox-probe-pages":
        opts.inboxProbePages = Number.parseInt(next(), 10);
        break;
      case "--hover-lead-ms":
        opts.hoverLeadMs = Number.parseInt(next(), 10);
        break;
      case "--entry-quiet-ms":
        opts.entryQuietMs = Number.parseInt(next(), 10);
        break;
      case "--only":
        opts.only = next();
        break;
      case "--warmup":
        opts.warmup = true;
        break;
      case "--help":
      case "-h":
        // The caller prints and exits; parsing more arguments after `--help`
        // would fail on the flag the user was asking about.
        opts.help = true;
        return opts;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.rounds) || opts.rounds < 1) throw new Error("--rounds must be >= 1");
  if (!Number.isFinite(opts.inboxProbePages) || opts.inboxProbePages < 1) {
    throw new Error("--inbox-probe-pages must be >= 1");
  }
  if (opts.entryQuietMs !== null && (!Number.isFinite(opts.entryQuietMs) || opts.entryQuietMs < 0)) {
    throw new Error("--entry-quiet-ms must be >= 0 (0 disables the rule)");
  }
  // 0 is the documented way to turn the rule off: keeping it as a 0ms window
  // would still pay a full poll interval per round and report `entrySettled`.
  if (opts.entryQuietMs === 0) opts.entryQuietMs = null;
  return opts;
}

/** Usage text, kept next to the parser so the two cannot drift. */
export function usageLines(): string[] {
  return [
    "Read-only MUL-383 page-speed probe. Token comes from MULTIREMI_QA_WEB_TOKEN only.",
    "",
    `  --base-url <url>       target origin (default ${DEFAULT_BASE_URL})`,
    `  --rounds <n>           repetitions per scenario, each in a fresh context (default ${DEFAULT_ROUNDS})`,
    `  --window peak|offpeak  label recorded in the report (default offpeak)`,
    "  --selectors auto|contract|legacy   DOM contract to use (default auto)",
    `  --issue-short <id>     short issue for detail-short (default ${DEFAULT_ISSUE_SHORT}, MUL-67)`,
    `  --issue-long <id>      long issue for detail-long (default ${DEFAULT_ISSUE_LONG}, MUL-70; the MUL-395 comparison fixture)`,
    `  --issue-xlong <id>     >=200-comment issue for detail-xlong (default ${DEFAULT_ISSUE_XLONG}, MUL-454); pass "" to skip the scenario`,
    "  --issue-running <id>   agent-running issue; auto-selected when omitted",
    "  --inbox-item <id>      deep-link inbox item; auto-selected from the probe window when omitted",
    `  --inbox-probe-pages <n>  how many inbox API pages the target probe may read (default ${DEFAULT_INBOX_PROBE_PAGES})`,
    `  --hover-lead-ms <n>    hover lead before an in-app click (default ${DEFAULT_HOVER_LEAD_MS})`,
    `  --entry-quiet-ms <n>   warm rounds: wait until the entry page has had no new /api request for <n> ms before clicking (default ${DEFAULT_ENTRY_QUIET_MS}; cap ${ENTRY_QUIET_CAP_MS} ms, then click anyway with entrySettled=false). 0 disables the rule.`,
    `  --out <dir>            output directory (default ${DEFAULT_OUT_DIR})`,
    "  --name <stem>          output file stem (default mul383-page-speed-<timestamp>)",
    "  --compare <baseline>   also emit a before/after comparison",
    "  --only <prefix>        run only scenarios whose key starts with this prefix",
    "  --warmup               visit every scenario once first (for a `next dev` server; not for baselines)",
    "",
  ];
}
