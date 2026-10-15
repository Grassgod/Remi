// Native steering for one task run (ADR 0020 "Native steering"): while a
// provider prompt is streaming, steer batches are handed to the provider's
// `steer()` one call at a time instead of interrupting the prompt. Anything but
// `injected` puts the batch back at the front of the feed, so the run loop
// re-prompts it with the same text after the round — the existing fallback.
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import type { TraceSteerResult } from "@multiremi/contracts/trace.js";
import { STEER_REASONS, type SteerOutcome, type SteerResult } from "@shared/contracts/provider-types.js";

/** Consecutive `failed` answers after which this attempt stops trying native steering. */
export const STEER_PUMP_MAX_CONSECUTIVE_FAILURES = 2;

export interface SteerPumpFeed {
  readonly hasPending: boolean;
  /** The queued messages, oldest first, without taking them. */
  peek(): readonly MultiremiTaskSteerMessage[];
  take(): MultiremiTaskSteerMessage[];
  requeue(messages: MultiremiTaskSteerMessage[]): void;
}

export interface SteerPumpOptions {
  feed: SteerPumpFeed;
  /** The provider's native steer for this run's chat. */
  steer(text: string): Promise<SteerResult>;
  /** The text both paths send: `buildSteerInjectionPrompt` over materialized attachments. */
  prepare(messages: MultiremiTaskSteerMessage[]): Promise<string>;
  /** The batch joined the running prompt; record it (acknowledged after the prompt ends). */
  injected(messages: MultiremiTaskSteerMessage[]): void | Promise<void>;
  /**
   * A batch carrying `force_answer` is being handed to the native call: arm the
   * grace deadline now, not at the next round. The provider may hold the call
   * until a running tool call ends; the grace bounds that wait too.
   */
  armForceAnswer(): void;
  /** The force-answer grace has expired: later steers are recorded, not delivered. */
  forceAnswerExpired(): boolean;
  log?: (message: string) => void;
}

interface Round {
  abort(): void;
  /** `onPromptStarted` fired: the prompt is on the wire. */
  started: boolean;
  /** No fallback has ended native calls for this round yet. */
  steerable: boolean;
}

export class SteerPump {
  private native = true;
  private failures = 0;
  private round: Round | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;
  private readonly fallbacks = new Map<string, TraceSteerResult>();

  constructor(private readonly options: SteerPumpOptions) {}

  /** False after `unsupported` or {@link STEER_PUMP_MAX_CONSECUTIVE_FAILURES} failures in a row. */
  get nativeEnabled(): boolean {
    return this.native && !this.stopped;
  }

  /** A provider prompt round begins; `abort` interrupts it (the fallback). */
  beginRound(abort: () => void): void {
    this.round = { abort, started: false, steerable: true };
  }

  /** `SendOptions.onPromptStarted`: steers may join the round's prompt from now on. */
  promptStarted(): void {
    if (!this.round) return;
    this.round.started = true;
    this.kick();
  }

  /** The round's `session.run()` ended: no new call starts for it and it is never aborted. */
  endRound(): void {
    this.round = null;
  }

  /** The feed's interrupt: steer natively, or interrupt the round once native is off. */
  interrupt(): void {
    // A wrap-up's grace counts from its arrival, even while an earlier steer
    // is still held or in flight (the kick below is then a no-op).
    if (this.options.feed.peek().some((message) => message.kind === "force_answer")) this.options.armForceAnswer();
    if (!this.round) return;
    if (!this.nativeEnabled) {
      this.round.abort();
      return;
    }
    this.kick();
  }

  /** Start draining the feed into the running prompt; at most one call is in flight. */
  kick(): void {
    const round = this.round;
    if (this.draining || !round || !this.callable(round) || !this.options.feed.hasPending
      || this.options.forceAnswerExpired()) return;
    this.draining = this.drain(round).finally(() => {
      this.draining = null;
      // A steer that arrived during the last call is not lost.
      this.kick();
    });
  }

  /** Resolves once no steer call is in flight; the run loop awaits it before `take()`. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  stop(): void {
    this.stopped = true;
    this.round = null;
  }

  /**
   * How a batch about to be re-prompted got there: the native answer that sent
   * it back, or no native call at all. Read once per message.
   */
  takeFallback(messageId: string): TraceSteerResult | null {
    const result = this.fallbacks.get(messageId) ?? null;
    this.fallbacks.delete(messageId);
    return result;
  }

  private callable(round: Round): boolean {
    return round === this.round && round.started && round.steerable && this.nativeEnabled;
  }

  private async drain(round: Round): Promise<void> {
    try {
      while (this.callable(round) && this.options.feed.hasPending) {
        if (this.options.forceAnswerExpired()) return;
        const messages = this.options.feed.take();
        if (!messages.length) return;
        let text: string;
        try {
          text = await this.options.prepare(messages);
        } catch (error) {
          // The re-prompt prepares the batch again and reports a lasting failure.
          this.fallBack(round, messages, null, errorText(error), true);
          return;
        }
        if (!this.callable(round) || this.options.forceAnswerExpired()) {
          this.options.feed.requeue(messages);
          return;
        }
        if (messages.some((message) => message.kind === "force_answer")) this.options.armForceAnswer();
        let result: SteerResult;
        try {
          result = await this.options.steer(text);
        } catch (error) {
          result = { outcome: "failed", error: errorText(error) };
        }
        if (this.stopped) return;
        if (result.outcome === "injected") {
          this.failures = 0;
          this.options.log?.(`Steered ${messages.length} message(s) into the running prompt`);
          await this.options.injected(messages);
          continue;
        }
        this.options.log?.(`Native steer answered ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`
          + `${result.error ? `: ${result.error}` : ""}; re-prompting ${messages.length} message(s)`);
        switch (result.outcome) {
          case "promptRequired":
            // No running prompt: the round is ending by itself; re-prompt after it.
            if (result.reason === STEER_REASONS.noActivePrompt) {
              this.fallBack(round, messages, "promptRequired", null, false);
              return;
            }
            // The prompt runs but cannot take the steer (a tool call past the
            // wait cap, a person-facing request, no turn to join): interrupt
            // and re-prompt. Not a native failure.
            this.fallBack(round, messages, "promptRequired", result.reason ?? null, true);
            return;
          // The provider already cancelled the bridge's own turn and waited for
          // it (D3); interrupt only a round that is somehow still streaming.
          case "startedNewTurn":
            this.fallBack(round, messages, "startedNewTurn", null, true);
            return;
          case "unsupported":
            this.native = false;
            this.fallBack(round, messages, "unsupported", null, true);
            return;
          default:
            this.failures++;
            if (this.failures >= STEER_PUMP_MAX_CONSECUTIVE_FAILURES) {
              this.native = false;
              this.options.log?.(`Native steering disabled for this attempt after ${this.failures} failures`);
            }
            this.fallBack(round, messages, "failed", result.error ?? result.reason ?? null, true);
            return;
        }
      }
    } catch (error) {
      this.options.log?.(`Native steer pump failed: ${errorText(error)}`);
    }
  }

  /**
   * Hand the batch back to the run loop's re-prompt; interrupting the round is
   * today's fallback. A round that already ended is never aborted: its abort
   * would mark the next round's tools cut short.
   */
  private fallBack(round: Round, messages: MultiremiTaskSteerMessage[], outcome: SteerOutcome | null,
    error: string | null, interrupt: boolean): void {
    for (const message of messages) this.fallbacks.set(message.id, { via: "reprompt", native_outcome: outcome, error });
    this.options.feed.requeue(messages);
    round.steerable = false;
    if (interrupt && round === this.round) round.abort();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The trace results for a batch about to be recorded, grouped in order so each
 * group is one `trace.steer` call. A re-prompted or undelivered message keeps
 * the native answer that sent it back (`fallback`, read once per message).
 */
export function steerResultGroups(
  messages: MultiremiTaskSteerMessage[],
  via: TraceSteerResult["via"],
  fallback: (messageId: string) => TraceSteerResult | null,
): Array<[TraceSteerResult, MultiremiTaskSteerMessage[]]> {
  const groups: Array<[TraceSteerResult, MultiremiTaskSteerMessage[]]> = [];
  for (const message of messages) {
    const previous = fallback(message.id);
    const result: TraceSteerResult = via === "native"
      ? { via, native_outcome: "injected", error: null }
      : { via, native_outcome: previous?.native_outcome ?? null, error: previous?.error ?? null };
    const last = groups.at(-1);
    if (last && last[0].via === result.via && last[0].native_outcome === result.native_outcome && last[0].error === result.error) {
      last[1].push(message);
    } else {
      groups.push([result, [message]]);
    }
  }
  return groups;
}
