"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { QRCode } from "react-qr-code";
import { toast } from "sonner";
import {
  feishuKeys,
  feishuMessageAuthorizationOptions,
  useBeginFeishuMessageAuthorization,
  useCreateFeishuMessageConnection,
  type FeishuMessageAuthorization,
} from "@multiremi/core/feishu";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { useT } from "../../../i18n";

interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}

interface Draft {
  name: string;
  appId: string;
  appSecret: string;
}

const EMPTY_DRAFT: Draft = { name: "", appId: "", appSecret: "" };

export function ConnectionDialog({ open, onOpenChange, workspaceId }: ConnectionDialogProps) {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [connectionId, setConnectionId] = useState("");
  const [session, setSession] = useState<FeishuMessageAuthorization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completedSession = useRef("");
  const createConnection = useCreateFeishuMessageConnection(workspaceId);
  const beginAuthorization = useBeginFeishuMessageAuthorization(workspaceId);
  const authorizationQuery = useQuery(feishuMessageAuthorizationOptions(
    workspaceId,
    connectionId,
    session?.id ?? "",
    open && session !== null,
  ));
  const authorization = authorizationQuery.data?.authorization ?? session;
  const pending = createConnection.isPending || beginAuthorization.isPending;

  useEffect(() => {
    if (authorization?.status !== "ready" || completedSession.current === authorization.id) return;
    completedSession.current = authorization.id;
    void queryClient.invalidateQueries({ queryKey: feishuKeys.all(workspaceId) });
    toast.success(t(($) => $.feishu.endpoint.connection_dialog.authorized));
    onOpenChange(false);
  }, [authorization, onOpenChange, queryClient, t, workspaceId]);

  useEffect(() => {
    if (!authorizationQuery.isError) return;
    setError(t(($) => $.feishu.endpoint.connection_dialog.poll_failed));
  }, [authorizationQuery.isError, t]);

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setConnectionId("");
    setSession(null);
    setError(null);
    completedSession.current = "";
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const startAuthorization = (id: string) => {
    setError(null);
    beginAuthorization.mutate(id, {
      onSuccess: (response) => {
        setSession(response.authorization);
        const url = response.authorization.verificationUrl;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      },
      onError: () => setError(t(($) => $.feishu.endpoint.connection_dialog.authorize_failed)),
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!draft.name.trim() || !draft.appId.trim() || !draft.appSecret) {
      setError(t(($) => $.feishu.endpoint.connection_dialog.required));
      return;
    }
    createConnection.mutate({
      name: draft.name.trim(),
      appId: draft.appId.trim(),
      appSecret: draft.appSecret,
    }, {
      onSuccess: (connection) => {
        createConnection.reset();
        setConnectionId(connection.id);
        setDraft((current) => ({ ...current, appSecret: "" }));
        startAuthorization(connection.id);
      },
      onError: () => {
        createConnection.reset();
        setError(t(($) => $.feishu.endpoint.connection_dialog.create_failed));
      },
    });
  };

  const terminal = authorization
    && ["expired", "denied", "failed"].includes(authorization.status);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.feishu.endpoint.connection_dialog.title)}</DialogTitle>
          <DialogDescription>
            {authorization
              ? t(($) => $.feishu.endpoint.connection_dialog.authorization_description)
              : t(($) => $.feishu.endpoint.connection_dialog.description)}
          </DialogDescription>
        </DialogHeader>

        {!authorization && !connectionId ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="feishu-message-connection-name">
                {t(($) => $.feishu.endpoint.connection_dialog.name_label)}
              </Label>
              <Input
                id="feishu-message-connection-name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder={t(($) => $.feishu.endpoint.connection_dialog.name_placeholder)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feishu-message-app-id">
                {t(($) => $.feishu.endpoint.connection_dialog.app_id_label)}
              </Label>
              <Input
                id="feishu-message-app-id"
                value={draft.appId}
                onChange={(event) => setDraft((current) => ({ ...current, appId: event.target.value }))}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feishu-message-app-secret">
                {t(($) => $.feishu.endpoint.connection_dialog.app_secret_label)}
              </Label>
              <Input
                id="feishu-message-app-secret"
                type="password"
                value={draft.appSecret}
                onChange={(event) => setDraft((current) => ({ ...current, appSecret: event.target.value }))}
                autoComplete="new-password"
              />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t(($) => $.feishu.endpoint.connection_dialog.cancel)}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                {t(($) => $.feishu.endpoint.connection_dialog.configure_and_authorize)}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            {beginAuthorization.isPending && !authorization && (
              <div className="flex min-h-48 items-center justify-center">
                <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden />
              </div>
            )}
            {authorization?.status === "pending" && authorization.verificationUrl && (
              <div className="flex flex-col items-center gap-4">
                <div className="rounded-md border bg-white p-3">
                  <QRCode value={authorization.verificationUrl} size={184} />
                </div>
                {authorization.userCode && (
                  <p className="font-mono text-sm tracking-widest">{authorization.userCode}</p>
                )}
                <Button
                  nativeButton={false}
                  render={(
                    <a href={authorization.verificationUrl} target="_blank" rel="noopener noreferrer" />
                  )}
                >
                  <ExternalLink className="size-4" aria-hidden />
                  {t(($) => $.feishu.endpoint.connection_dialog.open_authorization)}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  {t(($) => $.feishu.endpoint.connection_dialog.waiting)}
                </p>
              </div>
            )}
            {terminal && (
              <div className="space-y-3 text-center">
                <p className="text-sm text-destructive" role="alert">
                  {authorization?.status === "expired"
                    ? t(($) => $.feishu.endpoint.connection_dialog.expired)
                    : authorization?.status === "denied"
                      ? t(($) => $.feishu.endpoint.connection_dialog.denied)
                      : t(($) => $.feishu.endpoint.connection_dialog.authorize_failed)}
                </p>
                <Button onClick={() => startAuthorization(connectionId)} disabled={beginAuthorization.isPending}>
                  <RefreshCw className="size-4" aria-hidden />
                  {t(($) => $.feishu.endpoint.connection_dialog.retry)}
                </Button>
              </div>
            )}
            {error && !terminal && <p className="text-center text-sm text-destructive" role="alert">{error}</p>}
            {authorizationQuery.isError && authorization && (
              <div className="flex justify-center">
                <Button onClick={() => startAuthorization(connectionId)} disabled={beginAuthorization.isPending}>
                  <RefreshCw className="size-4" aria-hidden />
                  {t(($) => $.feishu.endpoint.connection_dialog.retry)}
                </Button>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t(($) => $.feishu.endpoint.connection_dialog.close)}
              </Button>
              {!authorization && connectionId && !beginAuthorization.isPending && (
                <Button onClick={() => startAuthorization(connectionId)}>
                  <RefreshCw className="size-4" aria-hidden />
                  {t(($) => $.feishu.endpoint.connection_dialog.retry)}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
