/**
 * Daemon-side supervisor for the workspace Feishu concierge (MUL-206).
 *
 * The daemon used to read `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
 * `MULTIREMI_BOT_AGENT_ID` once at boot and run the connector for the life of
 * the process. This drives the same connector from the control plane instead:
 * every heartbeat carries a directive (a revision plus a desired state), and
 * this class reconciles the running channel against it.
 *
 * Three rules shape the reconcile, and they are the reason it is not simply
 * "start when told to":
 *
 * 1. **Credentials are fetched, never pushed.** The directive says only that
 *    something changed. The secrets come from a separate route this Runtime is
 *    authenticated for, so they never sit in a heartbeat body or an ack log.
 * 2. **Stopping is confirmed, starting is not assumed.** The control plane
 *    withholds `config_available` until every other Runtime has reported
 *    `stopped`. Reporting our own stop promptly is what lets a handover finish,
 *    so a stop is always reported even when we were already stopped.
 * 3. **One reconcile at a time.** Directives arrive on every heartbeat, which
 *    is faster than a channel takes to boot. Overlapping starts would race two
 *    websockets onto the same bot inside a single process.
 */

import type {
  FeishuBotErrorCode,
  FeishuBotRuntimeState,
  MultiremiFeishuBotDaemonConfig,
  MultiremiFeishuBotDirective,
} from "@multiremi/contracts/types.js";

/** Result of a successful channel start, used to show the bot's identity. */
export interface FeishuConciergeStartResult {
  botName?: string | null;
  botOpenId?: string | null;
}

/**
 * The process that actually owns the connector. Implemented by the daemon
 * foreground in `apps/remi/cli/multiremi.ts`, which is the only place that can
 * boot Remi's core; the supervisor stays free of that dependency so it is
 * testable without spawning an agent.
 */
export interface FeishuConciergeHost {
  start(config: MultiremiFeishuBotDaemonConfig): Promise<FeishuConciergeStartResult>;
  stop(): Promise<void>;
}

export interface FeishuConciergeStatusReport {
  applied_revision: number;
  state: FeishuBotRuntimeState;
  bot_name?: string | null;
  bot_open_id?: string | null;
  error_code?: FeishuBotErrorCode | null;
  error_message?: string | null;
}

export interface FeishuConciergeSupervisorOptions {
  host: FeishuConciergeHost;
  fetchConfig: () => Promise<MultiremiFeishuBotDaemonConfig | null>;
  report: (input: FeishuConciergeStatusReport) => Promise<void>;
  /** Re-report an unchanged state at least this often to keep it from ageing out. */
  refreshIntervalMs?: number;
  now?: () => number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

export class FeishuConciergeSupervisor {
  private state: FeishuBotRuntimeState = "stopped";
  private appliedRevision = 0;
  private botName: string | null = null;
  private botOpenId: string | null = null;
  private errorCode: FeishuBotErrorCode | null = null;
  private errorMessage: string | null = null;
  private lastReportAtMs = 0;
  private reconciling: Promise<void> | null = null;
  private queued: MultiremiFeishuBotDirective | null = null;

  constructor(private readonly options: FeishuConciergeSupervisorOptions) {}

  /** Test/telemetry view of what this Runtime believes it is running. */
  snapshot(): { state: FeishuBotRuntimeState; appliedRevision: number; botName: string | null } {
    return { state: this.state, appliedRevision: this.appliedRevision, botName: this.botName };
  }

  /**
   * Reconcile against a heartbeat directive. Safe to call on every heartbeat:
   * a directive that matches the running channel costs nothing but an
   * occasional keepalive report.
   */
  async apply(directive: MultiremiFeishuBotDirective): Promise<void> {
    // A reconcile in flight always wins the current attempt; the newest
    // directive is remembered so it runs immediately afterwards, and any
    // directive it superseded is simply dropped — it is already stale.
    if (this.reconciling) {
      this.queued = directive;
      return;
    }
    this.reconciling = this.reconcile(directive).finally(() => {
      this.reconciling = null;
    });
    await this.reconciling;
    const queued = this.queued;
    if (queued) {
      this.queued = null;
      await this.apply(queued);
    }
  }

  /** Stop the channel and tell the control plane, e.g. on daemon shutdown. */
  async shutdown(): Promise<void> {
    if (this.state === "stopped") return;
    await this.stopChannel();
    await this.report(true);
  }

  private async reconcile(directive: MultiremiFeishuBotDirective): Promise<void> {
    const wantsRunning = directive.desired_state === "running" && directive.config_available;
    if (!wantsRunning) {
      const wasRunning = this.state !== "stopped";
      if (wasRunning) await this.stopChannel();
      this.appliedRevision = directive.revision;
      // Reported even when nothing was running: a handover is waiting on this
      // Runtime to say it is out of the way.
      await this.report(wasRunning || this.appliedRevisionChanged(directive.revision));
      return;
    }
    if (this.state === "online" && this.appliedRevision === directive.revision) {
      await this.report(false);
      return;
    }
    await this.startChannel(directive.revision);
  }

  private appliedRevisionChanged(revision: number): boolean {
    return this.appliedRevision !== revision;
  }

  private async startChannel(revision: number): Promise<void> {
    // A restart always tears the old channel down first: two Remi cores on one
    // app id would fight over the same event stream.
    if (this.state !== "stopped") await this.stopChannel();
    this.state = "starting";
    this.appliedRevision = revision;
    this.errorCode = null;
    this.errorMessage = null;
    await this.report(true);
    try {
      const config = await this.options.fetchConfig();
      if (!config) {
        // The assignment moved between the heartbeat and this fetch. Stay
        // stopped and wait for the next directive rather than guessing.
        this.state = "stopped";
        await this.report(true);
        return;
      }
      this.appliedRevision = config.revision;
      const result = await this.options.host.start(config);
      this.state = "online";
      this.botName = result.botName ?? null;
      this.botOpenId = result.botOpenId ?? null;
      this.options.log?.info(`Feishu concierge online at revision ${this.appliedRevision}`);
    } catch (error) {
      this.state = "failed";
      this.errorCode = "connector_start_failed";
      this.errorMessage = describeError(error);
      this.options.log?.warn(`Feishu concierge failed to start: ${this.errorMessage}`);
      // Leave nothing half-started behind a failure.
      await this.options.host.stop().catch(() => {});
    }
    await this.report(true);
  }

  private async stopChannel(): Promise<void> {
    try {
      await this.options.host.stop();
    } catch (error) {
      this.options.log?.warn(`Feishu concierge stop failed: ${describeError(error)}`);
    }
    this.state = "stopped";
    this.botName = null;
    this.botOpenId = null;
    this.errorCode = null;
    this.errorMessage = null;
  }

  private async report(force: boolean): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (!force && now - this.lastReportAtMs < interval) return;
    this.lastReportAtMs = now;
    try {
      await this.options.report({
        applied_revision: this.appliedRevision,
        state: this.state,
        bot_name: this.botName,
        bot_open_id: this.botOpenId,
        error_code: this.errorCode,
        error_message: this.errorMessage,
      });
    } catch (error) {
      // A failed report is retried by the next heartbeat. Losing the connector
      // over a transient control-plane blip would be far worse.
      this.lastReportAtMs = 0;
      this.options.log?.warn(`Feishu concierge status report failed: ${describeError(error)}`);
    }
  }
}

/** Credentials must never reach a status report, so errors are summarised. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
