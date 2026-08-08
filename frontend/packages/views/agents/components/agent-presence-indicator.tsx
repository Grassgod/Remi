"use client";

import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import type {
  AgentAvailability,
  AgentPresenceDetail,
  Workload,
} from "@multiremi/core/agents";
import { availabilityConfig, workloadConfig } from "../presence";
import { useT } from "../../i18n";

/**
 * The availability dot + its label. The single renderer for the dot — the
 * agents table's Availability column and the full presence indicator below
 * both go through it, so the dot vocabulary can only ever be changed once.
 */
export function AvailabilityChip({
  availability,
}: {
  availability: AgentAvailability;
}) {
  const { t } = useT("agents");
  const av = availabilityConfig[availability];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${av.dotClass}`} />
      <span className={`text-xs ${av.textClass}`}>
        {t(($) => $.availability[availability])}
      </span>
    </span>
  );
}

/**
 * Queued's amber comes from workloadConfig as the *severe* tone — meant for
 * "stuck on offline runtime", which is the dominant cause. But on a healthy
 * runtime, queued is just a brief race between enqueue and the daemon's
 * claim, and amber there reads as a warning that isn't there. Compose with
 * availability: online ⇒ muted (transient), otherwise ⇒ keep amber (genuine
 * stuck signal).
 */
export function workloadTone(
  workload: Workload,
  availability: AgentAvailability
): string {
  const wl = workloadConfig[workload];
  if (workload !== "queued") return wl.textClass;
  return availability === "online" ? "text-muted-foreground" : wl.textClass;
}

/**
 * The dense workload chip — icon + label + optional counts — used by the
 * agents table and the runtimes table. Those two tables feed it different
 * count strings (per-agent running/capacity vs runtime-level aggregates) and
 * the agents table composes its own tone via `workloadTone`, so both are
 * props; everything else is fixed here.
 *
 * The icon only renders for working/queued — those carry visual meaning
 * (spinner = in motion, clock = waiting). Idle adding an icon read as a
 * warning marker, which is the wrong signal.
 */
export function WorkloadChip({
  workload,
  tone,
  counts,
  countsClassName,
}: {
  workload: Workload;
  /** Defaults to the workloadConfig tone; pass `workloadTone(...)` to compose. */
  tone?: string;
  counts?: string | null;
  /** Extra classes on the counts span (the runtimes table tabular-aligns). */
  countsClassName?: string;
}) {
  const { t } = useT("agents");
  const wl = workloadConfig[workload];
  const labelTone = tone ?? wl.textClass;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {workload !== "idle" && (
        <wl.icon
          className={`h-3 w-3 shrink-0 ${labelTone} ${workload === "working" ? "animate-spin" : ""}`}
        />
      )}
      <span className={`shrink-0 ${labelTone}`}>
        {t(($) => $.workload[workload])}
      </span>
      {counts && (
        <span
          className={
            countsClassName
              ? `truncate ${countsClassName} text-muted-foreground`
              : "truncate text-muted-foreground"
          }
        >
          {counts}
        </span>
      )}
    </span>
  );
}

interface PresenceIndicatorProps {
  // null/undefined = still loading. Caller passes the detail computed at
  // the page level (or via the useAgentPresenceDetail hook for single-agent
  // views). Keeping this as a prop avoids per-row hook subscriptions in
  // long lists.
  detail: AgentPresenceDetail | null | undefined;
  // Compact = dot only, no label / no workload chip. Used in dense rows.
  compact?: boolean;
}

/**
 * Renders an agent's two-dimension presence: an availability dot + an
 * optional workload chip. The dot's colour reads only from the
 * availability dimension (3 colours), so a runtime-healthy agent whose
 * last task failed shows a green dot — workload no longer carries
 * historical state at all.
 *
 * Compact mode collapses to dot-only — used in dense surfaces where the
 * full chip would crowd the row.
 *
 * Pure presentation — takes the already-derived detail object as a prop.
 * The page-level component is responsible for sourcing it (via
 * `useAgentPresenceDetail` for a single agent, or `useWorkspacePresenceMap`
 * for lists).
 */
export function AgentPresenceIndicator({
  detail,
  compact,
}: PresenceIndicatorProps) {
  const { t } = useT("agents");
  if (!detail) {
    return compact ? (
      <Skeleton className="h-1.5 w-1.5 rounded-full" />
    ) : (
      <Skeleton className="h-3 w-24 rounded" />
    );
  }

  const av = availabilityConfig[detail.availability];
  const availabilityLabel = t(($) => $.availability[detail.availability]);
  const workloadLabel = t(($) => $.workload[detail.workload]);
  const isWorking = detail.workload === "working";
  const isQueued = detail.workload === "queued";
  const showQueueBadge = isWorking && detail.queuedCount > 0;
  const labelTone = workloadTone(detail.workload, detail.availability);

  if (compact) {
    return (
      <span
        className="inline-flex items-center"
        title={`${availabilityLabel}${detail.workload !== "idle" ? ` · ${workloadLabel}` : ""}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${av.dotClass}`} />
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {/* Availability — dot + label. Single dimension, single colour. */}
      <AvailabilityChip availability={detail.availability} />

      {/* Workload — separator + label, with counts when working/queued.
          All three workload states render here for symmetry: idle gets
          its own "Idle" label so the difference between "no presence
          data" (no chip at all) and "agent is idle" (explicit Idle chip)
          is visible. Archived agents skip the workload chip entirely —
          "Archived" already says everything; "Archived · Idle" is noise. */}
      {detail.availability !== "archived" && (
      <span className="inline-flex items-center gap-1">
        <span className="text-xs text-muted-foreground">·</span>
        <span className={`text-xs ${labelTone}`}>
          {workloadLabel}
        </span>
        {isWorking && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {detail.runningCount} / {detail.capacity}
          </span>
        )}
        {showQueueBadge && (
          <span className="rounded-md bg-muted px-1 py-0 text-xs font-medium text-muted-foreground">
            {t(($) => $.presence.queue_badge, { count: detail.queuedCount })}
          </span>
        )}
        {/* Queued (no running) — show the queued count directly, since
            there's no running/capacity ratio to anchor on. Honestly
            surfaces "stuck" on offline runtimes. */}
        {isQueued && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {detail.queuedCount}
          </span>
        )}
      </span>
      )}
    </span>
  );
}
