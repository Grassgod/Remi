export interface MultiremiCliUpdateParticipant {
  provider: string;
  activeTaskCount(): number;
  pendingClaimCount(): number;
  claimsPaused(): boolean;
  pauseClaims(): void;
  releaseClaims(): void;
}

export type MultiremiCliUpdatePauseResult =
  | { ok: true }
  | { ok: false; error: string };

/** Coordinates updates to the CLI binary shared by every provider on a machine. */
export class MultiremiCliUpdateCoordinator {
  private readonly participants: MultiremiCliUpdateParticipant[] = [];

  register(participant: MultiremiCliUpdateParticipant): void {
    this.participants.push(participant);
  }

  tryPauseClaims(): MultiremiCliUpdatePauseResult {
    const busy = this.participants
      .map((participant) => ({
        provider: participant.provider,
        activeTaskCount: participant.activeTaskCount(),
      }))
      .filter((participant) => participant.activeTaskCount > 0);
    if (busy.length > 0) {
      const providers = busy
        .map(({ provider, activeTaskCount }) => `${provider} (${activeTaskCount} active task${activeTaskCount === 1 ? "" : "s"})`)
        .join(", ");
      return {
        ok: false,
        error: `CLI update blocked: provider${busy.length === 1 ? " is" : "s are"} busy: ${providers}; retry when all providers are idle`,
      };
    }

    const claiming = this.participants.filter((participant) => participant.pendingClaimCount() > 0);
    if (claiming.length > 0) {
      return {
        ok: false,
        error: `CLI update blocked: provider${claiming.length === 1 ? " is" : "s are"} checking for new work: ${claiming.map(({ provider }) => provider).join(", ")}; retry when all providers are idle`,
      };
    }

    const paused = this.participants.find((participant) => participant.claimsPaused());
    if (paused) {
      return {
        ok: false,
        error: `CLI update blocked: ${paused.provider} provider has already paused claims for maintenance; retry when it completes`,
      };
    }

    // The check and pause run synchronously in one event-loop turn, so no
    // provider can claim work between the machine-idle gate and this pause.
    for (const participant of this.participants) participant.pauseClaims();
    return { ok: true };
  }

  releaseClaims(): void {
    for (const participant of this.participants) participant.releaseClaims();
  }
}
