import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowUpCircle,
  Check,
} from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
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
  currentVersion: string | null;
  agentVersion: string | null;
  acpVersion: string | null;
  isOnline: boolean;
  /**
   * Non-null when the daemon process was spawned by a managed launcher
   * (e.g. "desktop" for the Electron app). In that case the CLI binary
   * is shipped and upgraded by the launcher itself, so in-app self-update
   * is disabled — upgrading would be clobbered on the next launch anyway.
   */
  launchedBy?: string | null;
}

export function UpdateSection({
  runtimeId,
  currentVersion,
  agentVersion,
  acpVersion,
  isOnline,
  launchedBy,
}: UpdateSectionProps) {
  const { t } = useT("runtimes");
  const qc = useQueryClient();
  const isManaged = launchedBy === "desktop";
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  // Refetch the runtime list (which feeds this detail view) so the version
  // number refreshes once the daemon re-registers after an update.
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["runtimes"] });
  }, [qc]);

  const cliFlow = useUpdateFlow(runtimeId, "CLI updated", refresh);
  const agentFlow = useUpdateFlow(runtimeId, "Agent updated", refresh);
  const acpFlow = useUpdateFlow(runtimeId, "ACP bridge updated", refresh);

  // Fetch latest CLI version on mount (only the CLI row gates its button on it).
  useEffect(() => {
    fetchLatestVersion().then(setLatestVersion);
  }, []);

  const hasCliUpdate =
    !!currentVersion &&
    !!latestVersion &&
    !isManaged &&
    isNewer(latestVersion, currentVersion);

  const cliHint = isManaged ? (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      title={t(($) => $.update.managed_by_desktop_title)}
    >
      {t(($) => $.update.managed_by_desktop)}
    </span>
  ) : hasCliUpdate && !cliFlow.status ? (
    <>
      <span className="text-xs text-muted-foreground">→</span>
      <span className="text-xs font-mono text-info">{latestVersion}</span>
      <span className="text-xs text-muted-foreground">
        {t(($) => $.update.available)}
      </span>
    </>
  ) : currentVersion && latestVersion && !cliFlow.status ? (
    <span className="inline-flex items-center gap-1 text-xs text-success">
      <Check className="h-3 w-3" />
      {t(($) => $.update.latest)}
    </span>
  ) : null;

  return (
    <div className="space-y-2.5">
      <UpdateRow
        label={t(($) => $.update.cli_version_label)}
        version={currentVersion}
        hint={cliHint}
        showAction={hasCliUpdate && isOnline && !cliFlow.status}
        actionLabel={t(($) => $.update.action)}
        onAction={() =>
          latestVersion &&
          cliFlow.run(() => api.initiateUpdate(runtimeId, latestVersion))
        }
        flow={cliFlow}
        retryLabel={t(($) => $.update.retry)}
      />

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
