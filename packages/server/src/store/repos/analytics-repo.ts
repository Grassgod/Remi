// Analytics + metrics domain: the public event/counter readers, the public analytics recorders and
// the per-domain recorder helpers the runtimes/autopilots/webhook bands call. Extracted verbatim
// from MultiremiStore. The buffers themselves and recordAnalyticsEvent/incrementMetricCounter live
// on StoreContext, because every domain writes to them.
import {
  EVENT_AGENT_CREATED,
  EVENT_AUTOPILOT_CREATED,
  EVENT_AUTOPILOT_RUN_COMPLETED,
  EVENT_AUTOPILOT_RUN_FAILED,
  EVENT_AUTOPILOT_RUN_STARTED,
  EVENT_RUNTIME_FAILED,
  EVENT_RUNTIME_OFFLINE,
  EVENT_RUNTIME_READY,
  EVENT_RUNTIME_REGISTERED,
  METRIC_WEBHOOK_DELIVERY,
  normalizeMetricLabel,
  type StoreContext,
} from "@multiremi/store/context.js";
import type {
  MultiremiAnalyticsEvent,
  MultiremiAutopilot,
  MultiremiAutopilotRun,
  MultiremiMetricCounter,
  MultiremiRuntime,
  MultiremiWebhookDelivery,
} from "@multiremi/contracts/types.js";

const KNOWN_WEBHOOK_PROVIDERS = new Set(["github", "generic", "gitlab", "stripe", "other"]);
const KNOWN_WEBHOOK_DELIVERY_STATUSES = new Set(["queued", "dispatched", "failed", "rejected", "ignored", "duplicate", "other"]);

export interface RuntimeFailureAnalyticsInput {
  ownerId?: string | null;
  workspaceId?: string | null;
  daemonId?: string | null;
  provider?: string | null;
  failureReason: string;
  errorType: string;
  recoverable: boolean;
}

export interface AgentCreatedAnalyticsInput {
  actorId: string;
  workspaceId: string;
  agentId: string;
  provider: string;
  runtimeMode: string;
  template?: string | null;
  isFirstAgentInWorkspace: boolean;
}

export class AnalyticsRepo {
  constructor(private ctx: StoreContext) {}

  listAnalyticsEvents(options: {
    name?: string;
    includeMetricsOnly?: boolean;
  } = {}): MultiremiAnalyticsEvent[] {
    const includeMetricsOnly = options.includeMetricsOnly ?? true;
    return this.ctx.analyticsEvents
      .filter((event) => (!options.name || event.name === options.name) && (includeMetricsOnly || !event.metricsOnly))
      .map((event) => ({
        ...event,
        properties: { ...event.properties },
      }));
  }

  listMetricCounters(options: { name?: string } = {}): MultiremiMetricCounter[] {
    return [...this.ctx.metricCounters.values()]
      .filter((counter) => !options.name || counter.name === options.name)
      .map((counter) => ({
        name: counter.name,
        labels: { ...counter.labels },
        value: counter.value,
      }));
  }

  recordRuntimeFailure(input: RuntimeFailureAnalyticsInput): MultiremiAnalyticsEvent {
    const ownerId = input.ownerId ?? "";
    const workspaceId = input.workspaceId ?? null;
    const provider = input.provider?.trim() || "unknown";
    return this.ctx.recordAnalyticsEvent(
      EVENT_RUNTIME_FAILED,
      runtimeFailureDistinctId(ownerId, workspaceId),
      workspaceId,
      withAnalyticsCoreProperties({
        daemon_id: input.daemonId?.trim() ?? "",
        failure_reason: input.failureReason,
        error_type: input.errorType,
        recoverable: input.recoverable,
      }, {
        userId: ownerId,
        source: "manual",
        runtimeMode: "local",
        provider,
      }),
    );
  }

  recordAgentCreated(input: AgentCreatedAnalyticsInput): MultiremiAnalyticsEvent {
    return this.ctx.recordAnalyticsEvent(
      EVENT_AGENT_CREATED,
      input.actorId,
      input.workspaceId,
      withAnalyticsCoreProperties({
        agent_id: input.agentId,
        provider: input.provider,
        runtime_mode: input.runtimeMode,
        template: input.template ?? "",
        is_first_agent_in_workspace: input.isFirstAgentInWorkspace,
      }, {
        userId: input.actorId,
        agentId: input.agentId,
        source: "manual",
        runtimeMode: input.runtimeMode,
        provider: input.provider,
      }),
    );
  }

  recordRuntimeRegisteredAnalytics(runtime: MultiremiRuntime): void {
    const ownerId = runtime.ownerId ?? "";
    this.ctx.recordAnalyticsEvent(
      EVENT_RUNTIME_REGISTERED,
      runtimeDistinctId(ownerId, runtime.workspaceId),
      runtime.workspaceId,
      runtimeAnalyticsProperties(runtime, {
        runtime_version: stringMetadata(runtime.metadata, "version"),
        cli_version: stringMetadata(runtime.metadata, "cli_version"),
      }),
    );
  }

  recordRuntimeReadyAnalytics(runtime: MultiremiRuntime, readyDurationMs: number): void {
    const ownerId = runtime.ownerId ?? "";
    this.ctx.recordAnalyticsEvent(
      EVENT_RUNTIME_READY,
      runtimeDistinctId(ownerId, runtime.workspaceId),
      runtime.workspaceId,
      runtimeAnalyticsProperties(runtime, readyDurationMs > 0 ? { ready_duration_ms: readyDurationMs } : {}),
    );
  }

  recordRuntimeOfflineAnalytics(runtime: MultiremiRuntime): void {
    const ownerId = runtime.ownerId ?? "";
    this.ctx.recordAnalyticsEvent(
      EVENT_RUNTIME_OFFLINE,
      runtimeDistinctId(ownerId, runtime.workspaceId),
      runtime.workspaceId,
      runtimeAnalyticsProperties(runtime),
    );
  }

  recordAutopilotCreatedAnalytics(autopilot: MultiremiAutopilot): void {
    const actorId = autopilotActorId(autopilot);
    this.ctx.recordAnalyticsEvent(EVENT_AUTOPILOT_CREATED, actorId, autopilot.workspaceId, withAnalyticsCoreProperties({
      autopilot_id: autopilot.id,
      cadence: "manual",
      trigger_kind: "manual",
    }, {
      userId: nonAgentUserId(actorId),
      source: "manual",
    }));
  }

  recordAutopilotRunStartedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun): void {
    const actorId = autopilotActorId(autopilot);
    const assignee = this.autopilotAssigneeAnalytics(autopilot);
    this.ctx.recordAnalyticsEvent(EVENT_AUTOPILOT_RUN_STARTED, actorId, autopilot.workspaceId, this.autopilotRunAnalyticsProperties({
      autopilot,
      run,
      actorId,
      assignee,
      triggerSource: run.source,
    }));
  }

  recordAutopilotRunCompletedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun): void {
    const actorId = autopilotActorId(autopilot);
    const assignee = this.autopilotAssigneeAnalytics(autopilot);
    this.ctx.recordAnalyticsEvent(EVENT_AUTOPILOT_RUN_COMPLETED, actorId, autopilot.workspaceId, this.autopilotRunAnalyticsProperties({
      autopilot,
      run,
      actorId,
      assignee,
      triggerSource: run.source,
      extra: {
        duration_ms: autopilotRunDurationMs(run),
      },
    }));
  }

  recordAutopilotRunFailedAnalytics(autopilot: MultiremiAutopilot, run: MultiremiAutopilotRun, reason: string): void {
    const actorId = autopilotActorId(autopilot);
    const assignee = this.autopilotAssigneeAnalytics(autopilot);
    this.ctx.recordAnalyticsEvent(EVENT_AUTOPILOT_RUN_FAILED, actorId, autopilot.workspaceId, this.autopilotRunAnalyticsProperties({
      autopilot,
      run,
      actorId,
      assignee,
      triggerSource: run.source,
      extra: {
        duration_ms: autopilotRunDurationMs(run),
        failure_reason: reason || "unknown",
        error_type: autopilotErrorType(reason || "unknown"),
        will_retry: false,
      },
    }));
  }

  private autopilotRunAnalyticsProperties(input: {
    autopilot: MultiremiAutopilot;
    run: MultiremiAutopilotRun;
    actorId: string;
    assignee: { agentId: string; assigneeType: string; squadId: string };
    triggerSource: string;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> {
    const props: Record<string, unknown> = {
      ...(input.extra ?? {}),
      trigger_source: input.triggerSource,
      trigger_kind: input.triggerSource,
    };
    if (input.triggerSource) props.cadence = input.triggerSource;
    const withCore = withAnalyticsCoreProperties(props, {
      userId: nonAgentUserId(input.actorId),
      agentId: input.assignee.agentId,
      autopilotRunId: input.run.id,
      source: "autopilot",
    });
    withCore.autopilot_id = input.autopilot.id;
    if (input.assignee.assigneeType) withCore.assignee_type = input.assignee.assigneeType;
    if (input.assignee.squadId) withCore.squad_id = input.assignee.squadId;
    return withCore;
  }

  private autopilotAssigneeAnalytics(autopilot: MultiremiAutopilot): { agentId: string; assigneeType: string; squadId: string } {
    if (autopilot.assigneeType === "squad") {
      return {
        agentId: this.ctx.resolveAutopilotAgent(autopilot)?.id ?? autopilot.assigneeId,
        assigneeType: "squad",
        squadId: autopilot.assigneeId,
      };
    }
    return {
      agentId: autopilot.assigneeId,
      assigneeType: "agent",
      squadId: "",
    };
  }

  recordWebhookDeliveryMetric(delivery: MultiremiWebhookDelivery): void {
    this.ctx.incrementMetricCounter(METRIC_WEBHOOK_DELIVERY, {
      provider: normalizeWebhookProviderLabel(delivery.provider),
      status: normalizeWebhookDeliveryStatusLabel(delivery.status),
    });
  }
}

function normalizeWebhookProviderLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_WEBHOOK_PROVIDERS, "other");
}

function normalizeWebhookDeliveryStatusLabel(value: string | null | undefined): string {
  return normalizeMetricLabel(value, KNOWN_WEBHOOK_DELIVERY_STATUSES, "other");
}

function autopilotActorId(autopilot: MultiremiAutopilot): string {
  const id = autopilot.createdById;
  if (autopilot.createdByType === "agent" && id) return `agent:${id}`;
  return id || "system";
}

function nonAgentUserId(distinctId: string): string {
  return distinctId && !distinctId.includes(":") ? distinctId : "";
}

function runtimeDistinctId(ownerId: string, workspaceId: string | null): string {
  if (ownerId) return ownerId;
  return `workspace:${workspaceId ?? ""}`;
}

function runtimeFailureDistinctId(ownerId: string, workspaceId: string | null): string {
  if (ownerId) return ownerId;
  if (workspaceId) return `workspace:${workspaceId}`;
  return "";
}

function runtimeAnalyticsProperties(runtime: MultiremiRuntime, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return withAnalyticsCoreProperties({
    runtime_id: runtime.id,
    daemon_id: runtime.daemonId ?? "",
    provider: runtime.provider,
    runtime_mode: runtime.runtimeMode,
    ...extra,
  }, {
    userId: runtime.ownerId ?? "",
    source: "manual",
    runtimeMode: runtime.runtimeMode,
    provider: runtime.provider,
  });
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

export function withAnalyticsCoreProperties(
  props: Record<string, unknown>,
  core: {
    userId?: string;
    agentId?: string;
    autopilotRunId?: string;
    source?: string;
    runtimeMode?: string;
    provider?: string;
  },
): Record<string, unknown> {
  const next = { ...props };
  if (core.userId) next.user_id = core.userId;
  if (core.agentId) next.agent_id = core.agentId;
  if (core.autopilotRunId) next.autopilot_run_id = core.autopilotRunId;
  if (core.source) next.source = core.source;
  if (core.runtimeMode) next.runtime_mode = core.runtimeMode;
  if (core.provider) next.provider = core.provider;
  next.is_demo = false;
  return next;
}

function autopilotRunDurationMs(run: MultiremiAutopilotRun): number {
  if (!run.completedAt) return 0;
  const start = Date.parse(run.triggeredAt);
  const end = Date.parse(run.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function autopilotErrorType(reason: string): string {
  if (reason.includes("unknown execution_mode")) return "configuration";
  if (reason.startsWith("issue ")) return "issue_terminal";
  if (reason.includes("create issue") || reason.includes("enqueue task") || reason.includes("dispatch")) return "dispatch_error";
  if (reason.startsWith("task ")) return "task_error";
  return "autopilot_error";
}
