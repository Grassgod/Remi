import { createLogger } from "@shared/logger.js";
import type { RelayHttpRequest } from "@multiremi/relay/http.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { shouldAutoRetitle } from "./eligibility.js";
import { resolveIssueAutoTitleSettings } from "./settings.js";
import {
  issueWithEligibilityContext,
  retitleIssue,
  type IssueRetitleResult,
} from "./service.js";

const log = createLogger("multiremi-issue-title");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_CANDIDATES = 5;

export interface IssueTitleSchedulerOptions {
  store: MultiremiStore;
  intervalMs?: number;
  maxCandidates?: number;
  now?: () => Date;
  httpRequest?: RelayHttpRequest;
  retitle?: typeof retitleIssue;
}

export interface IssueTitleRunResult {
  attempted: number;
  applied: number;
  skipped: number;
  failed: number;
}

export class IssueTitleScheduler {
  private readonly store: MultiremiStore;
  private readonly intervalMs: number;
  private readonly maxCandidates: number;
  private readonly now: () => Date;
  private readonly httpRequest?: RelayHttpRequest;
  private readonly retitle: typeof retitleIssue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickPromise: Promise<IssueTitleRunResult> | null = null;

  constructor(options: IssueTitleSchedulerOptions) {
    this.store = options.store;
    this.intervalMs = Math.max(250, options.intervalMs ?? intervalFromEnv(process.env.MULTIREMI_ISSUE_TITLE_INTERVAL_MS));
    this.maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
    this.now = options.now ?? (() => new Date());
    this.httpRequest = options.httpRequest;
    this.retitle = options.retitle ?? retitleIssue;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(now: Date = this.now()): Promise<IssueTitleRunResult> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runOnceInternal(now)
      .catch((error) => {
        log.warn(`Issue title scan failed: ${errorMessage(error)}`);
        return { attempted: 0, applied: 0, skipped: 0, failed: 1 };
      })
      .finally(() => {
        this.tickPromise = null;
      });
    return this.tickPromise;
  }

  private async runOnceInternal(now: Date): Promise<IssueTitleRunResult> {
    const result: IssueTitleRunResult = { attempted: 0, applied: 0, skipped: 0, failed: 0 };
    for (const workspace of this.store.listWorkspaces()) {
      if (result.attempted >= this.maxCandidates) break;
      if (!resolveIssueAutoTitleSettings(workspace.settings).enabled) continue;
      const issues = this.store.listIssues({
        workspaceId: workspace.id,
        includeArchived: false,
      });
      for (const issue of issues) {
        if (result.attempted >= this.maxCandidates) break;
        if (!shouldAutoRetitle(issueWithEligibilityContext(this.store, issue), now)) continue;
        result.attempted += 1;
        let outcome: IssueRetitleResult;
        try {
          outcome = await this.retitle(this.store, issue.id, {
            source: "auto",
            apply: true,
            now,
            httpRequest: this.httpRequest,
          });
        } catch (error) {
          result.failed += 1;
          log.warn(`Issue title generation failed for ${issue.key}: ${errorMessage(error)}`);
          continue;
        }
        if (outcome.applied) result.applied += 1;
        else if (outcome.reason === "model_failed") {
          result.failed += 1;
          log.warn(`Issue title model failed for ${issue.key}`);
        } else {
          result.skipped += 1;
        }
      }
    }
    return result;
  }
}

function intervalFromEnv(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_INTERVAL_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
