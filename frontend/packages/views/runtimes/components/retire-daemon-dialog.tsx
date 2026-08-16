"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  KeyRound,
  ListRestart,
  LoaderCircle,
  MessageSquare,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@multiremi/core/api";
import { DaemonRetirementPlanResponseSchema } from "@multiremi/core/api/schemas";
import {
  daemonRetirementPlanOptions,
  useRetireDaemon,
  type DaemonRetirementPlan,
} from "@multiremi/core/runtimes";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
import { useT } from "../../i18n";
import { ProviderLogo } from "./provider-logo";

interface RetireDaemonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wsId: string;
  daemonId: string;
  machineName: string;
  onRetired: () => void;
}

export function RetireDaemonDialog({
  open,
  onOpenChange,
  wsId,
  daemonId,
  machineName,
  onRetired,
}: RetireDaemonDialogProps) {
  const { t } = useT("runtimes");
  const planQuery = useQuery({
    ...daemonRetirementPlanOptions(wsId, daemonId),
    enabled: open,
  });
  const retireMutation = useRetireDaemon(wsId);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(
    null,
  );
  const [serverPlan, setServerPlan] = useState<DaemonRetirementPlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [abandonIssueWorkspaces, setAbandonIssueWorkspaces] = useState(false);

  useEffect(() => {
    if (!open) return;
    setServerPlan(null);
    setNotice(null);
    setAbandonIssueWorkspaces(false);
  }, [open, daemonId]);

  const plan = serverPlan ?? planQuery.data ?? null;
  const confirmed =
    !!plan &&
    plan.snapshot.length > 0 &&
    confirmedSnapshot === plan.snapshot;

  useEffect(() => {
    if (!open) return;
    setConfirmedSnapshot(null);
    setAbandonIssueWorkspaces(false);
  }, [open, daemonId, plan?.snapshot]);

  const submitting = retireMutation.isPending;
  const canAbandonIssueWorkspaces = plan ? isIssueWorkspaceOnlyBlocker(plan) : false;
  const retirementAllowed = plan?.can_retire === true || (
    canAbandonIssueWorkspaces && abandonIssueWorkspaces
  );
  const canSubmit =
    !!plan &&
    retirementAllowed &&
    plan.already_retired !== true &&
    plan.snapshot.length > 0 &&
    confirmed &&
    !planQuery.isFetching &&
    !submitting;

  const handleOpenChange = (next: boolean) => {
    if (!submitting) onOpenChange(next);
  };

  const handleRetire = async () => {
    if (!plan || !canSubmit) return;
    setNotice(null);
    try {
      const result = await retireMutation.mutateAsync({
        daemonId,
        expectedSnapshot: plan.snapshot,
        abandonIssueWorkspaces,
      });
      if (
        result.status !== "retired" ||
        result.workspace_id !== wsId ||
        result.daemon_id !== daemonId ||
        result.retired_at.length === 0
      ) {
        throw new Error(t(($) => $.machine.retire.toast_failed));
      }
      toast.success(t(($) => $.machine.retire.toast_success, { name: machineName }));
      onOpenChange(false);
      onRetired();
    } catch (error) {
      const conflict = parseRetirementConflict(error, wsId, daemonId);
      if (conflict) {
        setServerPlan(conflict.plan);
        setConfirmedSnapshot(null);
        setNotice(
          conflict.code === "daemon_retirement_plan_changed"
            ? t(($) => $.machine.retire.plan_changed)
            : t(($) => $.machine.retire.now_blocked),
        );
        return;
      }
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.machine.retire.toast_failed),
      );
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        overlayClassName="z-[60]"
        className="z-[60] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] !max-w-[620px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-lg p-0"
      >
        <div className="border-b px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0">
              <AlertDialogTitle className="text-base font-semibold">
                {t(($) => $.machine.retire.title)}
              </AlertDialogTitle>
              <AlertDialogDescription className="mt-1 text-left text-sm leading-5 text-muted-foreground">
                {t(($) => $.machine.retire.description, { name: machineName })}
              </AlertDialogDescription>
              <div className="mt-3 flex min-w-0 items-baseline gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <span className="shrink-0 text-muted-foreground">
                  {t(($) => $.machine.retire.daemon_id)}
                </span>
                <code className="min-w-0 break-all font-mono text-foreground">
                  {daemonId}
                </code>
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {planQuery.isLoading && !plan ? (
            <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t(($) => $.machine.retire.loading)}
            </div>
          ) : planQuery.isError && !plan ? (
            <div className="flex min-h-36 flex-col items-center justify-center text-center">
              <p className="text-sm font-medium">
                {t(($) => $.machine.retire.load_failed)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => planQuery.refetch()}
              >
                {t(($) => $.machine.retire.retry)}
              </Button>
            </div>
          ) : plan ? (
            <PlanBody
              plan={plan}
              notice={notice}
              confirmed={confirmed}
              abandonIssueWorkspaces={abandonIssueWorkspaces}
              canAbandonIssueWorkspaces={canAbandonIssueWorkspaces}
              onConfirmedChange={(next) =>
                setConfirmedSnapshot(next ? plan.snapshot : null)
              }
              onAbandonIssueWorkspacesChange={(next) => {
                setAbandonIssueWorkspaces(next);
                setConfirmedSnapshot(null);
              }}
            />
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t bg-muted/25 px-5 py-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            {t(($) => $.machine.retire.cancel)}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full sm:w-auto"
            disabled={!canSubmit}
            onClick={handleRetire}
          >
            {submitting
              ? t(($) => $.machine.retire.submitting)
              : t(($) => $.machine.retire.confirm)}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PlanBody({
  plan,
  notice,
  confirmed,
  abandonIssueWorkspaces,
  canAbandonIssueWorkspaces,
  onConfirmedChange,
  onAbandonIssueWorkspacesChange,
}: {
  plan: DaemonRetirementPlan;
  notice: string | null;
  confirmed: boolean;
  abandonIssueWorkspaces: boolean;
  canAbandonIssueWorkspaces: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onAbandonIssueWorkspacesChange: (abandon: boolean) => void;
}) {
  const { t } = useT("runtimes");
  const blocked = plan.can_retire !== true;

  if (plan.already_retired) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t(($) => $.machine.retire.already_retired)}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="border-l-2 border-warning bg-warning/5 px-3 py-2 text-sm text-foreground"
        >
          {notice}
        </div>
      )}

      {blocked && (
        <section aria-label={t(($) => $.machine.retire.blockers_title)}>
          <h3 className="text-sm font-medium text-destructive">
            {t(($) => $.machine.retire.blockers_title)}
          </h3>
          <div className="mt-2 divide-y border-y text-sm">
            {plan.active_tasks.length > 0 && (
              <BlockerRow
                label={t(($) => $.machine.retire.blocker_active_tasks, {
                  count: plan.active_tasks.length,
                })}
                detail={plan.active_tasks
                  .map((task) => {
                    const agent = plan.agents.find((item) => item.id === task.agent_id);
                    return [agent?.name, task.issue_id ?? task.id].filter(Boolean).join(" · ");
                  })
                  .join(", ")}
              />
            )}
            {plan.local_directory_resources.length > 0 && (
              <BlockerRow
                label={t(($) => $.machine.retire.blocker_local_directories, {
                  count: plan.local_directory_resources.length,
                })}
                detail={plan.local_directory_resources
                  .map((resource) => resource.project_title || resource.label)
                  .filter(Boolean)
                  .join(", ")}
              />
            )}
            {plan.issue_workspaces.length > 0 && (
              <BlockerRow
                label={t(($) => $.machine.retire.blocker_issue_workspaces, {
                  count: plan.issue_workspaces.length,
                })}
                detail={plan.issue_workspaces
                  .map((workspace) => workspace.issue_id)
                  .join(", ")}
              />
            )}
            {plan.active_tasks.length === 0 &&
              plan.local_directory_resources.length === 0 &&
              plan.issue_workspaces.length === 0 && (
                <BlockerRow label={t(($) => $.machine.retire.blocker_unknown)} />
              )}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {canAbandonIssueWorkspaces
              ? t(($) => $.machine.retire.abandon_workspaces_hint)
              : t(($) => $.machine.retire.blockers_hint)}
          </p>
          {canAbandonIssueWorkspaces && (
            <label className="mt-3 flex cursor-pointer items-start gap-3 border-t pt-3 text-sm leading-5">
              <Checkbox
                checked={abandonIssueWorkspaces}
                onCheckedChange={(checked) =>
                  onAbandonIssueWorkspacesChange(checked === true)
                }
                className="mt-0.5"
              />
              <span>{t(($) => $.machine.retire.abandon_workspaces)}</span>
            </label>
          )}
        </section>
      )}

      <section aria-label={t(($) => $.machine.retire.impact_title)}>
        <h3 className="text-sm font-medium">
          {t(($) => $.machine.retire.impact_title)}
        </h3>
        <div className="mt-2 divide-y border-y">
          <ImpactRow
            icon={Server}
            label={t(($) => $.machine.retire.impact_runtimes, {
              count: plan.impact.runtimes_removed,
            })}
          />
          <ImpactRow
            icon={Bot}
            label={t(($) => $.machine.retire.impact_agents, {
              count: plan.impact.agents_detached,
            })}
          />
          <ImpactRow
            icon={ListRestart}
            label={t(($) => $.machine.retire.impact_tasks, {
              count: plan.impact.queued_tasks_requeued,
            })}
          />
          <ImpactRow
            icon={MessageSquare}
            label={t(($) => $.machine.retire.impact_sessions, {
              count:
                plan.impact.session_lanes_reset +
                plan.impact.chat_sessions_reset,
            })}
          />
          <ImpactRow
            icon={KeyRound}
            label={t(($) => $.machine.retire.impact_tokens, {
              count: plan.impact.tokens_revoked,
            })}
          />
        </div>
      </section>

      {plan.runtimes.length > 0 && (
        <section>
          <h3 className="text-sm font-medium">
            {t(($) => $.machine.retire.runtimes_title)}
          </h3>
          <div className="mt-2 divide-y border-y">
            {plan.runtimes.map((runtime) => (
              <div key={runtime.id} className="flex items-center gap-2 py-2 text-sm">
                <ProviderLogo provider={runtime.provider} className="size-4" />
                <span className="min-w-0 flex-1 truncate">{runtime.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {runtime.provider}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(!blocked || (canAbandonIssueWorkspaces && abandonIssueWorkspaces)) && (
        <label className="flex cursor-pointer items-start gap-3 border-t pt-4 text-sm leading-5">
          <Checkbox
            checked={confirmed}
            onCheckedChange={(checked) => onConfirmedChange(checked === true)}
            className="mt-0.5"
          />
          <span>{t(($) => $.machine.retire.acknowledge)}</span>
        </label>
      )}
    </div>
  );
}

function isIssueWorkspaceOnlyBlocker(plan: DaemonRetirementPlan): boolean {
  return plan.can_abandon_issue_workspaces === true
    && plan.can_retire !== true
    && plan.issue_workspaces.length > 0
    && plan.active_tasks.length === 0
    && plan.local_directory_resources.length === 0
    && plan.blocking_reasons.length > 0
    && plan.blocking_reasons.every((reason) => reason === "active_issue_workspaces");
}

function BlockerRow({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="py-2.5">
      <p className="font-medium">{label}</p>
      {detail && (
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

function ImpactRow({
  icon: Icon,
  label,
}: {
  icon: typeof Server;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 py-2.5 text-sm">
      <Icon className="size-4 text-muted-foreground" />
      <span>{label}</span>
    </div>
  );
}

function parseRetirementConflict(
  error: unknown,
  workspaceId: string,
  daemonId: string,
): { code: string; plan: DaemonRetirementPlan } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (!error.body || typeof error.body !== "object") return null;
  const body = error.body as Record<string, unknown>;
  if (
    body.code !== "daemon_retirement_plan_changed" &&
    body.code !== "daemon_retirement_blocked"
  ) {
    return null;
  }
  const parsed = DaemonRetirementPlanResponseSchema.safeParse({ plan: body.plan });
  if (!parsed.success) return null;
  if (
    parsed.data.plan.workspace_id !== workspaceId ||
    parsed.data.plan.daemon_id !== daemonId
  ) {
    return null;
  }
  return { code: body.code, plan: parsed.data.plan };
}
