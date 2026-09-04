/**
 * Daemon-side supervisor for the workspace Feishu concierge (MUL-206).
 *
 * The daemon used to read bot identity from process environment once at boot
 * and run the connector for the life of the process. This drives the connector
 * from the control plane instead:
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
  MultiremiFeishuBotDirective,
  MultiremiFeishuBotOutboundDelivery,
} from "@multiremi/contracts/types.js";
import { normalizeFeishuBotErrorCode, redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import type { MultiremiFeishuBotAssignment } from "./client.js";

/** Result of a successful channel start, used to show the bot's identity. */
export interface FeishuConciergeStartResult {
  botName?: string | null;
  botOpenId?: string | null;
}

/**
 * The process that actually owns the connector transport. Implemented by the
 * daemon foreground in `apps/remi/cli/multiremi.ts`; the supervisor stays free
 * of connector dependencies so it is testable without starting an Agent.
 */
export interface FeishuConciergeHost {
  start(assignment: MultiremiFeishuBotAssignment): Promise<FeishuConciergeStartResult>;
  stop(): Promise<void>;
  sendOutbound?(delivery: MultiremiFeishuBotOutboundDelivery): Promise<{ messageId: string }>;
}

/**
 * A failure the caller could name. `fetchConfig` and the host raise it so a
 * specific cause survives into the admin-visible status instead of collapsing
 * into `connector_start_failed`.
 */
export class FeishuConciergeError extends Error {
  constructor(message: string, readonly code: FeishuBotErrorCode) {
    super(message);
    this.name = "FeishuConciergeError";
  }
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
  fetchConfig: () => Promise<MultiremiFeishuBotAssignment | null>;
  report: (input: FeishuConciergeStatusReport) => Promise<void>;
  /** Re-report an unchanged state at least this often to keep it from ageing out. */
  refreshIntervalMs?: number;
  /** Backoff ladder after a failed start, indexed by consecutive failure count. */
  retryBackoffMs?: readonly number[];
  now?: () => number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

/**
 * Directives arrive every few seconds, so a start that fails for a lasting
 * reason — a revoked App Secret, say — would otherwise retry against Feishu at
 * heartbeat rate. Backing off caps that at roughly twelve attempts an hour
 * while still recovering on its own from a transient network failure.
 */
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000];

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
  private consecutiveFailures = 0;
  private retryAtMs = 0;

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

  /**
   * Record a channel that died after a successful start. The host calls this
   * because only it can observe the connector's own run promise; moving to
   * `failed` is what lets the next directive restart it.
   */
  async reportChannelFailure(error: unknown): Promise<void> {
    if (this.state === "stopped") return;
    await this.stopChannel();
    this.state = "failed";
    this.errorCode = errorCodeOf(error);
    this.errorMessage = redactFeishuBotError(error);
    this.noteFailure();
    this.options.log?.warn(`Feishu concierge stopped unexpectedly: ${this.errorMessage}`);
    await this.report(true);
  }

  async sendOutbound(delivery: MultiremiFeishuBotOutboundDelivery): Promise<{ messageId: string }> {
    if (this.state !== "online") throw new Error("Feishu concierge is not online");
    if (!this.options.host.sendOutbound) throw new Error("Feishu concierge host cannot send outbound messages");
    return this.options.host.sendOutbound(delivery);
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
    // A new revision means an admin changed something, which is the one signal
    // worth trusting over the backoff: retry immediately rather than making
    // them wait out a ladder earned by the credentials they just replaced.
    if (this.appliedRevisionChanged(directive.revision)) this.clearBackoff();
    else if (this.state === "failed" && (this.options.now?.() ?? Date.now()) < this.retryAtMs) {
      await this.report(false);
      return;
    }
    await this.startChannel(directive.revision);
  }

  private noteFailure(): void {
    const ladder = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const delay = ladder[Math.min(this.consecutiveFailures, ladder.length - 1)] ?? 0;
    this.consecutiveFailures += 1;
    this.retryAtMs = (this.options.now?.() ?? Date.now()) + delay;
  }

  private clearBackoff(): void {
    this.consecutiveFailures = 0;
    this.retryAtMs = 0;
  }

  private appliedRevisionChanged(revision: number): boolean {
    return this.appliedRevision !== revision;
  }

  private async startChannel(revision: number): Promise<void> {
    // A restart always tears the old channel down first: two connectors on one
    // app id would fight over the same event stream.
    if (this.state !== "stopped") await this.stopChannel();
    this.state = "starting";
    this.appliedRevision = revision;
    this.errorCode = null;
    this.errorMessage = null;
    await this.report(true);
    // Held only for the duration of the start so a thrown message that quotes a
    // credential is scrubbed with the real value, not just with env lookalikes.
    let secrets: string[] = [];
    try {
      const assignment = await this.options.fetchConfig();
      if (!assignment) {
        // The assignment moved between the heartbeat and this fetch. Stay
        // stopped and wait for the next directive rather than guessing.
        this.state = "stopped";
        await this.report(true);
        return;
      }
      this.appliedRevision = assignment.config.revision;
      secrets = [assignment.config.app_secret].filter(Boolean);
      const result = await this.options.host.start(assignment);
      this.state = "online";
      this.botName = result.botName ?? null;
      this.botOpenId = result.botOpenId ?? null;
      this.clearBackoff();
      this.options.log?.info(`Feishu concierge online at revision ${this.appliedRevision}`);
    } catch (error) {
      this.state = "failed";
      this.errorCode = errorCodeOf(error);
      this.errorMessage = redactFeishuBotError(error, secrets);
      this.noteFailure();
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
      this.options.log?.warn(`Feishu concierge stop failed: ${redactFeishuBotError(error)}`);
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
      this.options.log?.warn(`Feishu concierge status report failed: ${redactFeishuBotError(error)}`);
    }
  }
}

/**
 * Recover a named cause from a thrown error. Duck-typed on `code` rather than
 * on a class so a failure raised by the API client survives the trip without
 * this module having to import it.
 */
function errorCodeOf(error: unknown): FeishuBotErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  const normalized = typeof code === "string" ? normalizeFeishuBotErrorCode(code) : null;
  // `normalizeFeishuBotErrorCode` answers "unknown" for any string it does not
  // recognise, including HTTP codes like `runtime_not_found`; those say nothing
  // useful, so an unrecognised code stays a start failure.
  return normalized && normalized !== "unknown" ? normalized : "connector_start_failed";
}
