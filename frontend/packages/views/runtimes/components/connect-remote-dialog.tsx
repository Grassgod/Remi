"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Terminal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { runtimeKeys } from "@multiremi/core/runtimes/queries";
import { useWSEvent } from "@multiremi/core/realtime";
import { paths, useWorkspaceSlug } from "@multiremi/core/paths";
import { useConfigStore } from "@multiremi/core/config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import { CODE_LIGATURE_CLASS } from "@multiremi/ui/lib/code-style";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { cn } from "@multiremi/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

type Step = "instructions" | "success";

const SERVER_URL_PLACEHOLDER = "<SERVER_URL>";
const WORKSPACE_ID_PLACEHOLDER = "<WORKSPACE_ID>";
const INSTALL_CMD =
  "curl -fsSL https://github.com/Grassgod/remi/releases/latest/download/install-remi.sh | bash";

function normalizeCommandURL(url: string | undefined) {
  return url?.trim().replace(/\/+$/, "") ?? "";
}

function daemonCommands(
  serverUrl: string | undefined,
  workspaceId: string | undefined,
  token: string | null,
) {
  const normalizedServerUrl = normalizeCommandURL(serverUrl) || SERVER_URL_PLACEHOLDER;
  const normalizedWorkspaceId = workspaceId?.trim() || WORKSPACE_ID_PLACEHOLDER;
  const setupToken = token?.trim() || "<YOUR_TOKEN>";
  const setupBase =
    `remi multiremi setup --server-url ${normalizedServerUrl} --workspace-id ${normalizedWorkspaceId}`;

  return {
    setupCmd: `${setupBase} --token ${setupToken} --start`,
    tokenCmd: `${setupBase}
remi multiremi login --token ${setupToken}
remi multiremi daemon start`,
  };
}

export function ConnectRemoteDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("instructions");
  const wsId = useWorkspaceId();
  const slug = useWorkspaceSlug();
  const qc = useQueryClient();
  const navigation = useNavigation();
  const newRuntimeIdRef = useRef<string | null>(null);

  // `remi multiremi setup ... --start` stores config + token and starts the daemon.
  // The dialog listens for the resulting `daemon:register` WS event.
  const handleDaemonRegister = useCallback(
    (payload: unknown) => {
      if (step !== "instructions") return;
      qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      const p = payload as Record<string, unknown> | null;
      if (p?.runtime_id && typeof p.runtime_id === "string") {
        newRuntimeIdRef.current = p.runtime_id;
      }
      setStep("success");
    },
    [step, qc, wsId],
  );
  useWSEvent("daemon:register", handleDaemonRegister);

  const handleGoToAgents = () => {
    onClose();
    if (slug) {
      navigation.push(paths.workspace(slug).agents());
    }
  };

  const handleGoToRuntime = () => {
    onClose();
    if (slug && newRuntimeIdRef.current) {
      navigation.push(
        paths.workspace(slug).runtimeDetail(newRuntimeIdRef.current),
      );
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        {step === "instructions" && <InstructionsStep onClose={onClose} />}
        {step === "success" && (
          <SuccessStep
            onGoToAgents={handleGoToAgents}
            onGoToRuntime={
              newRuntimeIdRef.current ? handleGoToRuntime : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Copy button + code row — mirrors onboarding/CliInstallInstructions
// ---------------------------------------------------------------------------

function CopyButton({ text, ariaLabel }: { text: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = () => {
    void copyText(text).then((ok) => {
      if (ok) setCopied(true);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={ariaLabel}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

function CommandStep({
  n,
  label,
  cmd,
  copyAria,
}: {
  n: number;
  label: string;
  cmd: string;
  copyAria: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-foreground">
        {n}. {label}
      </p>
      <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 font-mono text-sm">
        <Terminal
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <code
          className={cn(
            "min-w-0 flex-1 break-all whitespace-pre-wrap tabular-nums",
            CODE_LIGATURE_CLASS,
          )}
        >
          {cmd}
        </code>
        <CopyButton text={cmd} ariaLabel={copyAria} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Instructions
// ---------------------------------------------------------------------------

function InstructionsStep({ onClose }: { onClose: () => void }) {
  const { t } = useT("runtimes");
  const daemonServerUrl = useConfigStore((s) => s.daemonServerUrl);
  const wsId = useWorkspaceId();
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [browserOrigin, setBrowserOrigin] = useState("");
  useEffect(() => {
    setBrowserOrigin(window.location.origin);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api
      .createPersonalAccessToken({
        name: `Remi daemon ${new Date().toISOString().slice(0, 10)}`,
        expires_in_days: 365,
      })
      .then((result) => {
        if (!cancelled) setSetupToken(result.token);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const { setupCmd, tokenCmd } = daemonCommands(
    daemonServerUrl || browserOrigin,
    wsId,
    setupToken,
  );
  return (
    <>
      <DialogHeader className="px-6 pt-6 pb-2">
        <DialogTitle className="text-base text-balance">
          {t(($) => $.connect.title)}
        </DialogTitle>
        <DialogDescription className="text-xs text-balance">
          {t(($) => $.connect.description)}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-4">
          <CommandStep
            n={1}
            label={t(($) => $.connect.step1_label)}
            cmd={INSTALL_CMD}
            copyAria={t(($) => $.connect.copy_aria)}
          />

          <div>
            <CommandStep
              n={2}
              label={t(($) => $.connect.step2_label)}
              cmd={setupCmd}
              copyAria={t(($) => $.connect.copy_aria)}
            />
            <p className="mt-1.5 text-[11px] leading-[1.55] text-muted-foreground">
              {t(($) => $.connect.step2_hint)}
            </p>
          </div>

          <LiveListening />

          <TroubleshootingDetails tokenCmd={tokenCmd} />
        </div>
      </div>

      <DialogFooter className="m-0 rounded-b-xl border-t bg-muted/30 px-6 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          {t(($) => $.connect.cancel)}
        </Button>
      </DialogFooter>
    </>
  );
}

function TroubleshootingDetails({ tokenCmd }: { tokenCmd: string }) {
  const { t } = useT("runtimes");
  return (
    <details className="group rounded-lg border border-dashed">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          className="h-3 w-3 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {t(($) => $.connect.troubleshooting)}
      </summary>
      <div className="space-y-2 border-t px-3 pt-2.5 pb-3 text-[11px] leading-[1.55] text-muted-foreground">
        <p>{t(($) => $.connect.trouble_intro)}</p>
        <CommandStep
          n={2}
          label={t(($) => $.connect.step2_label)}
          cmd={tokenCmd}
          copyAria={t(($) => $.connect.copy_aria)}
        />
        <p>
          {t(($) => $.connect.trouble_token_hint_prefix)}
          <span className="font-medium text-foreground">
            {t(($) => $.connect.trouble_token_hint_destination)}
          </span>
          {t(($) => $.connect.trouble_token_hint_suffix)}
        </p>
        <ul className="space-y-1">
          <li className="flex items-center gap-1.5">
            <span>{t(($) => $.connect.trouble_check_status)}</span>
            {/* CLI command — literal shell string, not i18n content. */}
            {/* eslint-disable-next-line i18next/no-literal-string */}
            <code
              className={cn(
                "rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground",
                CODE_LIGATURE_CLASS,
              )}
            >
              {"remi daemon status"}
            </code>
          </li>
          <li className="flex items-center gap-1.5">
            <span>{t(($) => $.connect.trouble_view_logs)}</span>
            {/* CLI command — literal shell string, not i18n content. */}
            {/* eslint-disable-next-line i18next/no-literal-string */}
            <code
              className={cn(
                "rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground",
                CODE_LIGATURE_CLASS,
              )}
            >
              {"remi daemon logs -f"}
            </code>
          </li>
        </ul>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Live-listening indicator
// ---------------------------------------------------------------------------

function LiveListening() {
  const { t } = useT("runtimes");
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs"
      role="status"
      aria-live="polite"
    >
      <span className="relative inline-flex shrink-0" aria-hidden>
        <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      <span className="font-medium text-foreground">
        {t(($) => $.connect.live_listening)}
      </span>
      <span className="text-muted-foreground">
        {t(($) => $.connect.live_listening_hint)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Success
// ---------------------------------------------------------------------------

function SuccessStep({
  onGoToAgents,
  onGoToRuntime,
}: {
  onGoToAgents: () => void;
  onGoToRuntime?: () => void;
}) {
  const { t } = useT("runtimes");
  return (
    <>
      <DialogHeader className="px-6 pt-6 pb-2">
        <DialogTitle className="text-base text-balance">
          {t(($) => $.connect.success_title)}
        </DialogTitle>
        <DialogDescription className="text-xs text-balance">
          {t(($) => $.connect.success_description)}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col items-center gap-3 px-6 py-8">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10"
          aria-hidden
        >
          <Check className="h-6 w-6 text-success" />
        </div>
      </div>

      <DialogFooter className="m-0 rounded-b-xl border-t bg-muted/30 px-6 py-3">
        {onGoToRuntime && (
          <Button variant="ghost" size="sm" onClick={onGoToRuntime}>
            {t(($) => $.connect.view_runtime)}
          </Button>
        )}
        <Button size="sm" onClick={onGoToAgents}>
          {t(($) => $.connect.create_agent)}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DialogFooter>
    </>
  );
}
