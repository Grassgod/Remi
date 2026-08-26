import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowUpCircle,
  Check,
  MonitorCog,
} from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@multiremi/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import { api } from "@multiremi/core/api";
import type { RuntimeUpdateStatus } from "@multiremi/core/types";
import { useT } from "../../i18n";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cachedLatestVersion: string | null = null;
let cachedAt = 0;

// Proxied through the backend (GET /api/cli/latest-version): a direct
// api.github.com call from the browser hits rate limits and logs a console
// error on every visit.
async function fetchLatestVersion(): Promise<string | null> {
  if (cachedLatestVersion && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedLatestVersion;
  }
  try {
    cachedLatestVersion = await api.getLatestCliVersion();
    cachedAt = Date.now();
    return cachedLatestVersion;
  } catch {
    return null;
  }
}

function stripV(v: string): string {
  return v.replace(/^v/, "");
}

function isNewer(latest: string, current: string): boolean {
  const l = stripV(latest).split(".").map(Number);
  const c = stripV(current).split(".").map(Number);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

const statusConfig: Record<
  RuntimeUpdateStatus,
  { icon: typeof Loader2; color: string }
> = {
  pending: { icon: Loader2, color: "text-muted-foreground" },
  running: { icon: Loader2, color: "text-info" },
  completed: { icon: CheckCircle2, color: "text-success" },
  failed: { icon: XCircle, color: "text-destructive" },
  timeout: { icon: XCircle, color: "text-warning" },
};

interface UpdateFlow {
  status: RuntimeUpdateStatus | null;
  error: string;
  output: string;
  active: boolean;
  run: (initiate: () => Promise<{ id: string }>) => Promise<void>;
}

// One update lifecycle (initiate → poll → status), shared by the CLI / Agent /
// ACP rows so the poll + status machinery isn't triplicated.
function useUpdateFlow(
  runtimeId: string,
  completedFallback: string,
  onRefresh: () => void,
): UpdateFlow {
  const { t } = useT("runtimes");
  const [status, setStatus] = useState<RuntimeUpdateStatus | null>(null);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const run = useCallback(
    async (initiate: () => Promise<{ id: string }>) => {
      cleanup();
      setStatus("pending");
      setError("");
      setOutput("");
      try {
        const update = await initiate();
        pollRef.current = setInterval(async () => {
          try {
            const result = await api.getUpdateResult(runtimeId, update.id);
            setStatus(result.status as RuntimeUpdateStatus);
            if (result.status === "completed") {
              setOutput(result.output ?? completedFallback);
              cleanup();
              // The daemon restarts + re-registers after the update, so the new
              // version lands a few seconds later. Refetch the runtime now and
              // again over the next ~20s to catch it without a manual reload.
              onRefresh();
              [5000, 12000, 20000].forEach((ms) =>
                setTimeout(onRefresh, ms),
              );
              // Clear the completed pill after the row has had a chance to
              // refresh to the new version.
              setTimeout(() => setStatus(null), 6000);
            } else if (
              result.status === "failed" ||
              result.status === "timeout"
            ) {
              setError(result.error ?? t(($) => $.update.unknown_error));
              cleanup();
            }
          } catch {
            // ignore poll errors
          }
        }, 2000);
      } catch {
        setStatus("failed");
        setError(t(($) => $.update.initiate_failed));
      }
    },
    [runtimeId, completedFallback, cleanup, t, onRefresh],
  );

  const active = status === "pending" || status === "running";
  return { status, error, output, active, run };
}

function UpdateRow({
  label,
  version,
  hint,
  showAction,
  actionLabel,
  onAction,
  flow,
  retryLabel,
}: {
  label: string;
  version: string | null;
  hint?: React.ReactNode;
  showAction: boolean;
  actionLabel: string;
  onAction: () => void;
  flow: UpdateFlow;
  retryLabel: string;
}) {
  const { t } = useT("runtimes");
  const config = flow.status ? statusConfig[flow.status] : null;
  const Icon = config?.icon;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-mono">{version ?? "—"}</span>
        {hint}
        {showAction && (
          <Button
            variant="outline"
            size="xs"
            onClick={onAction}
            disabled={flow.active}
          >
            <ArrowUpCircle className="h-3 w-3" />
            {actionLabel}
          </Button>
        )}
        {config && Icon && flow.status && (
          <span
            className={`inline-flex items-center gap-1 text-xs ${config.color}`}
          >
            <Icon className={`h-3 w-3 ${flow.active ? "animate-spin" : ""}`} />
            {t(($) => $.update.status[flow.status as RuntimeUpdateStatus])}
          </span>
        )}
      </div>

      {flow.status === "completed" && flow.output && (
        <div className="rounded-lg border bg-success/5 px-3 py-2">
          <p className="text-xs text-success">{flow.output}</p>
        </div>
      )}

      {(flow.status === "failed" || flow.status === "timeout") && flow.error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">{flow.error}</p>
          {flow.status === "failed" && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-1"
              onClick={onAction}
            >
              {retryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface UpdateSectionProps {
  runtimeId: string;
  agentVersion: string | null;
  acpVersion: string | null;
  isOnline: boolean;
}

export function UpdateSection({
  runtimeId,
  agentVersion,
  acpVersion,
  isOnline,
}: UpdateSectionProps) {
  const { t } = useT("runtimes");
  const qc = useQueryClient();

  // Refetch the runtime list (which feeds this detail view) so the version
  // number refreshes once the daemon re-registers after an update.
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["runtimes"] });
  }, [qc]);

  const agentFlow = useUpdateFlow(runtimeId, "Agent updated", refresh);
  const acpFlow = useUpdateFlow(runtimeId, "ACP bridge updated", refresh);

  return (
    <div className="space-y-2.5">
      <UpdateRow
        label={t(($) => $.update.agent_label)}
        version={agentVersion}
        showAction={isOnline && !agentFlow.active}
        actionLabel={t(($) => $.update.agent_action)}
        onAction={() =>
          agentFlow.run(() =>
            api.initiateUpdate(runtimeId, "latest", "agent"),
          )
        }
        flow={agentFlow}
        retryLabel={t(($) => $.update.retry)}
      />

      <UpdateRow
        label={t(($) => $.update.acp_label)}
        version={acpVersion}
        showAction={isOnline && !acpFlow.active}
        actionLabel={t(($) => $.update.acp_action)}
        onAction={() =>
          acpFlow.run(() => api.initiateUpdate(runtimeId, "latest", "acp"))
        }
        flow={acpFlow}
        retryLabel={t(($) => $.update.retry)}
      />
    </div>
  );
}

interface MachineCliUpdateProps {
  runtimeId: string | null;
  currentVersion: string | null;
  cliVersions: string[];
  managedByDesktop: boolean;
}

export function MachineCliUpdate({
  runtimeId,
  currentVersion,
  cliVersions,
  managedByDesktop,
}: MachineCliUpdateProps) {
  const { t } = useT("runtimes");
  const qc = useQueryClient();
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["runtimes"] });
  }, [qc]);
  const flow = useUpdateFlow(runtimeId ?? "", "CLI updated", refresh);
  const reconciling = !currentVersion && cliVersions.length > 1;

  useEffect(() => {
    if (!currentVersion || reconciling) return;
    void fetchLatestVersion().then(setLatestVersion);
  }, [currentVersion, reconciling]);

  const hasUpdate =
    !!currentVersion &&
    !!latestVersion &&
    isNewer(latestVersion, currentVersion);
  const runUpdate = () => {
    if (!runtimeId || !latestVersion) return;
    void flow.run(() => api.initiateUpdate(runtimeId, latestVersion));
  };
  const config = flow.status ? statusConfig[flow.status] : null;
  const StatusIcon = config?.icon;

  return (
    <span
      data-testid="machine-cli-update"
      className="inline-flex h-6 w-48 max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border bg-background px-1.5 align-middle"
    >
      <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
        CLI
      </span>
      {reconciling ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="min-w-0 truncate text-xs text-warning">
                {t(($) => $.update.versions_reconciling)}
              </span>
            }
          />
          <TooltipContent className="max-w-sm break-words">
            {t(($) => $.update.versions_reconciling_title, {
              versions: cliVersions.join(", "),
            })}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="shrink-0 font-mono text-xs text-foreground">
          {currentVersion ?? t(($) => $.update.version_unknown)}
        </span>
      )}

      {managedByDesktop ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex min-w-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled
                  className="h-5 min-w-0 gap-1 px-1.5"
                >
                  <MonitorCog className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {t(($) => $.update.managed_by_desktop)}
                  </span>
                </Button>
              </span>
            }
          />
          <TooltipContent className="max-w-sm">
            {t(($) => $.update.managed_by_desktop_title)}
          </TooltipContent>
        </Tooltip>
      ) : flow.status === "failed" || flow.status === "timeout" ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={`h-5 min-w-0 gap-1 px-1.5 ${config?.color ?? ""}`}
              >
                {StatusIcon && <StatusIcon className="h-3 w-3 shrink-0" />}
                <span className="truncate">
                  {t(($) => $.update.status[flow.status!])}
                </span>
              </Button>
            }
          />
          <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
            <PopoverHeader>
              <PopoverTitle>{t(($) => $.update.failure_details)}</PopoverTitle>
              <PopoverDescription className="break-words text-destructive">
                {flow.error}
              </PopoverDescription>
            </PopoverHeader>
            {flow.status === "failed" && (
              <Button type="button" variant="outline" size="xs" onClick={runUpdate}>
                {t(($) => $.update.retry)}
              </Button>
            )}
          </PopoverContent>
        </Popover>
      ) : config && StatusIcon && flow.status ? (
        <span className={`inline-flex min-w-0 items-center gap-1 text-xs ${config.color}`}>
          <StatusIcon className={`h-3 w-3 shrink-0 ${flow.active ? "animate-spin" : ""}`} />
          <span className="truncate">
            {t(($) => $.update.status[flow.status as RuntimeUpdateStatus])}
          </span>
        </span>
      ) : hasUpdate ? (
        <>
          <span className="shrink-0 text-xs text-muted-foreground">→</span>
          <span className="shrink-0 font-mono text-xs text-info">
            {latestVersion}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex min-w-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-5 min-w-0 gap-1 px-1.5"
                    onClick={runUpdate}
                    disabled={!runtimeId}
                  >
                    <ArrowUpCircle className="h-3 w-3 shrink-0" />
                    <span className="truncate">{t(($) => $.update.action)}</span>
                  </Button>
                </span>
              }
            />
            {!runtimeId && (
              <TooltipContent>{t(($) => $.update.machine_offline_title)}</TooltipContent>
            )}
          </Tooltip>
        </>
      ) : currentVersion && latestVersion ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-success">
          <Check className="h-3 w-3 shrink-0" />
          <span className="truncate">{t(($) => $.update.latest)}</span>
        </span>
      ) : null}
    </span>
  );
}
