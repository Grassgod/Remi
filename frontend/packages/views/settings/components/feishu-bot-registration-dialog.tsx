"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { QRCode } from "react-qr-code";
import { api } from "@multiremi/core/api";
import type { FeishuBotRegistrationBrand, FeishuBotRegistrationStatus } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { useT } from "../../i18n";

/**
 * What the dialog hands back on success. Deliberately **not** the secret: the
 * server keeps the scanned app secret against the session id and the save
 * quotes that id, so the plaintext never reaches this process.
 */
export interface ClaimedRegistration {
  sessionId: string;
  appId: string;
  appSecretAvailable: boolean;
}

/**
 * Optional credential fill for the concierge (MUL-206): scan a QR in Feishu,
 * get an app back, skip copying an App ID and Secret out of the open platform
 * console by hand. Manual entry stays the primary path — this is a shortcut,
 * and every failure here leaves the form exactly as it was.
 */
export function FeishuBotRegistrationDialog({
  workspaceId,
  open,
  onOpenChange,
  onClaimed,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClaimed: (claimed: ClaimedRegistration) => void;
}) {
  const { t } = useT("settings");
  const [brand, setBrand] = useState<FeishuBotRegistrationBrand>("feishu");
  const [session, setSession] = useState<null | {
    sessionId: string;
    verificationUri: string;
    userCode: string;
    pollIntervalSeconds: number;
  }>(null);
  const [status, setStatus] = useState<FeishuBotRegistrationStatus>("pending");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [beginning, setBeginning] = useState(false);
  // Reset on every mount, not at construction: StrictMode's double-effect
  // would otherwise leave the guard latched from the first pass and every
  // await would bail before rendering a QR.
  const closedRef = useRef(false);

  async function begin(nextBrand: FeishuBotRegistrationBrand) {
    setBeginning(true);
    setStatus("pending");
    setErrorMessage(null);
    setSession(null);
    try {
      const started = await api.beginFeishuBotRegistration(workspaceId, nextBrand);
      if (closedRef.current) return;
      setSession({
        sessionId: started.session_id,
        verificationUri: started.verification_uri,
        userCode: started.user_code,
        pollIntervalSeconds: started.poll_interval_seconds,
      });
    } catch (error) {
      if (closedRef.current) return;
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBeginning(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    closedRef.current = false;
    void begin(brand);
    return () => { closedRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- brand changes re-run through the picker's own handler
  }, [open]);

  useEffect(() => {
    if (!open || !session || status !== "pending") return;
    const intervalMs = Math.max(2000, session.pollIntervalSeconds * 1000);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const current = await api.getFeishuBotRegistration(workspaceId, session.sessionId);
        if (cancelled) return;
        setStatus(current.status);
        if (current.status === "ready") {
          onClaimed({
            sessionId: current.session_id,
            appId: current.app_id ?? "",
            appSecretAvailable: current.app_secret_available,
          });
          return;
        }
        // `denied`, `expired` and `error` are all terminal — the session is
        // gone server-side, so polling on would spin against nothing.
        if (current.status !== "pending") {
          setErrorMessage(current.error_message);
          return;
        }
        timer = setTimeout(() => void poll(), intervalMs);
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    };

    timer = setTimeout(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, session, status, workspaceId, onClaimed]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.feishu.concierge.scan_dialog_title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.feishu.concierge.scan_dialog_description)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          <div className="w-full space-y-1.5">
            <Select
              value={brand}
              disabled={beginning}
              onValueChange={(value) => {
                if (!value) return;
                const next = value as FeishuBotRegistrationBrand;
                setBrand(next);
                void begin(next);
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">{t(($) => $.feishu.concierge.domain_feishu)}</SelectItem>
                <SelectItem value="lark">{t(($) => $.feishu.concierge.domain_lark)}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {beginning && !session && (
            <p className="text-sm text-muted-foreground">{t(($) => $.feishu.concierge.scan_starting)}</p>
          )}

          {session && status === "pending" && (
            <>
              <div className="rounded-md border bg-white p-3">
                {/* Inline SVG: no external image fetch, prints at any DPI. */}
                <QRCode value={session.verificationUri} size={180} />
              </div>
              {session.userCode && (
                <p className="font-mono text-sm tracking-widest">{session.userCode}</p>
              )}
              <p className="text-center text-xs text-muted-foreground">
                {t(($) => $.feishu.concierge.scan_hint)}
              </p>
              <a
                href={session.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline"
              >
                {t(($) => $.feishu.concierge.scan_open_link)}
              </a>
            </>
          )}

          {status === "ready" && (
            <p className="text-sm font-medium">{t(($) => $.feishu.concierge.scan_ready)}</p>
          )}

          {(status === "denied" || status === "expired" || status === "error") && (
            <div className="space-y-2 text-center">
              <p className="text-sm font-medium text-destructive">
                {status === "denied"
                  ? t(($) => $.feishu.concierge.scan_error_denied)
                  : status === "expired"
                    ? t(($) => $.feishu.concierge.scan_error_expired)
                    : t(($) => $.feishu.concierge.scan_error_generic)}
              </p>
              {errorMessage && (
                <p className="break-all text-[10px] text-muted-foreground">{errorMessage}</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t(($) => $.feishu.concierge.cancel)}
          </Button>
          {status !== "pending" && status !== "ready" && (
            <Button size="sm" disabled={beginning} onClick={() => void begin(brand)}>
              <RefreshCw className="size-3.5" />
              {t(($) => $.feishu.concierge.scan_retry)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
