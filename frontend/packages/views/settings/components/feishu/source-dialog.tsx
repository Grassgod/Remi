"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { toast } from "sonner";
import {
  feishuAvailableChatsOptions,
  useCreateFeishuSource,
  useUpdateFeishuSource,
  type FeishuEndpointHealth,
  type FeishuSource,
} from "@multiremi/core/feishu";
import { Button } from "@multiremi/ui/components/ui/button";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { useT } from "../../../i18n";
import { truncateId } from "./shared";

interface SourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** null → create. The chat picker only appears when editing: the chat
   *  directory is looked up through an existing source, and the rollout runbook
   *  deliberately creates a source disabled with an empty allowlist first. */
  source: FeishuSource | null;
  endpoints: FeishuEndpointHealth[];
}

interface Draft {
  name: string;
  endpointName: string;
  enabled: boolean;
  allowlist: string[];
  retentionDays: string;
  pollIntervalSeconds: string;
  unprocessedRetrySeconds: string;
  unprocessedRetryLimit: string;
}

function draftFrom(source: FeishuSource | null, endpoints: FeishuEndpointHealth[]): Draft {
  return {
    name: source?.name ?? "",
    endpointName: source?.endpointName ?? endpoints[0]?.name ?? "",
    enabled: source?.enabled ?? false,
    allowlist: source?.allowlist.map((entry) => entry.chatId) ?? [],
    retentionDays: String(source?.retentionDays ?? 30),
    pollIntervalSeconds: String(source?.pollIntervalSeconds ?? 60),
    unprocessedRetrySeconds: String(source?.unprocessedRetrySeconds ?? 900),
    unprocessedRetryLimit: String(source?.unprocessedRetryLimit ?? 3),
  };
}

export function SourceDialog({ open, onOpenChange, workspaceId, source, endpoints }: SourceDialogProps) {
  const { t } = useT("settings");
  const [draft, setDraft] = useState<Draft>(() => draftFrom(source, endpoints));
  const [error, setError] = useState<string | null>(null);
  const [chatQuery, setChatQuery] = useState("");
  const [debouncedChatQuery, setDebouncedChatQuery] = useState("");
  const createMutation = useCreateFeishuSource(workspaceId);
  const updateMutation = useUpdateFeishuSource(workspaceId);
  const pending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(source, endpoints));
    setError(null);
    setChatQuery("");
    setDebouncedChatQuery("");
    // `endpoints` is a fresh array on every render of the parent; keying the
    // reset on its length keeps the draft from being clobbered mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.id, endpoints.length]);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedChatQuery(chatQuery), 300);
    return () => clearTimeout(handle);
  }, [chatQuery]);

  const chatsQuery = useQuery(feishuAvailableChatsOptions(
    workspaceId,
    source?.id ?? "",
    { q: debouncedChatQuery || undefined, limit: 50 },
    open && source !== null,
  ));

  const selected = useMemo(() => new Set(draft.allowlist), [draft.allowlist]);
  const chats = chatsQuery.data?.chats ?? [];

  const toggleChat = (chatId: string) => {
    setDraft((current) => ({
      ...current,
      allowlist: current.allowlist.includes(chatId)
        ? current.allowlist.filter((id) => id !== chatId)
        : [...current.allowlist, chatId],
    }));
  };

  const handleSave = () => {
    setError(null);
    const input = {
      name: draft.name.trim(),
      endpointName: draft.endpointName,
      enabled: draft.enabled,
      allowlist: draft.allowlist,
      retentionDays: Number(draft.retentionDays),
      pollIntervalSeconds: Number(draft.pollIntervalSeconds),
      unprocessedRetrySeconds: Number(draft.unprocessedRetrySeconds),
      unprocessedRetryLimit: Number(draft.unprocessedRetryLimit),
    };
    const onSuccess = () => {
      toast.success(source
        ? t(($) => $.feishu.sources.toast_updated)
        : t(($) => $.feishu.sources.toast_created));
      onOpenChange(false);
    };
    // The dialog stays open on failure so the operator does not lose the draft.
    const onError = (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t(($) => $.feishu.sources.error_save));
    };
    if (source) {
      updateMutation.mutate({ sourceId: source.id, input }, { onSuccess, onError });
    } else {
      createMutation.mutate(input, { onSuccess, onError });
    }
  };

  const emptyAllowlist = draft.allowlist.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {source
              ? t(($) => $.feishu.sources.dialog.edit_title)
              : t(($) => $.feishu.sources.dialog.create_title)}
          </DialogTitle>
          <DialogDescription>{t(($) => $.feishu.sources.dialog.description)}</DialogDescription>
        </DialogHeader>

        {error !== null && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="feishu-source-name">{t(($) => $.feishu.sources.dialog.name_label)}</Label>
            <Input
              id="feishu-source-name"
              value={draft.name}
              placeholder={t(($) => $.feishu.sources.dialog.name_placeholder)}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="feishu-source-endpoint">{t(($) => $.feishu.sources.dialog.endpoint_label)}</Label>
            {/* Names only. There is no free-text variant of this control by
                design — a URL typed here would be an SSRF vector. */}
            <Select
              value={draft.endpointName}
              onValueChange={(value) => setDraft((current) => ({ ...current, endpointName: String(value) }))}
            >
              <SelectTrigger id="feishu-source-endpoint" className="w-full">
                <SelectValue placeholder={t(($) => $.feishu.sources.dialog.endpoint_empty)} />
              </SelectTrigger>
              <SelectContent>
                {endpoints.map((endpoint) => (
                  <SelectItem key={endpoint.name} value={endpoint.name}>{endpoint.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(($) => $.feishu.sources.dialog.endpoint_help)}</p>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="feishu-source-enabled">{t(($) => $.feishu.sources.dialog.enabled_label)}</Label>
              <p className="text-xs text-muted-foreground">{t(($) => $.feishu.sources.dialog.enabled_help)}</p>
            </div>
            <Switch
              id="feishu-source-enabled"
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
            />
          </div>

          {emptyAllowlist && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t(($) => $.feishu.sources.empty_allowlist_notice)}
            </p>
          )}

          {source
            ? (
              <div className="space-y-2">
                <Label htmlFor="feishu-chat-search">{t(($) => $.feishu.sources.dialog.allowlist_label)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.feishu.sources.dialog.allowlist_help)}
                </p>
                {draft.allowlist.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {draft.allowlist.map((chatId) => {
                      const known = chats.find((chat) => chat.chatId === chatId);
                      return (
                        <li key={chatId}>
                          <button
                            type="button"
                            onClick={() => toggleChat(chatId)}
                            className="flex min-h-8 items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs"
                            aria-label={t(($) => $.feishu.sources.dialog.remove_chat, {
                              chat: known?.name ?? chatId,
                            })}
                          >
                            <span className="max-w-40 truncate">{known?.name ?? truncateId(chatId)}</span>
                            <X className="size-3" aria-hidden />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    id="feishu-chat-search"
                    className="pl-8"
                    value={chatQuery}
                    placeholder={t(($) => $.feishu.sources.dialog.allowlist_search)}
                    onChange={(event) => setChatQuery(event.target.value)}
                  />
                </div>
                <div className="max-h-56 overflow-y-auto rounded-md border">
                  {chatsQuery.isPending && (
                    <p className="p-3 text-xs text-muted-foreground">
                      {t(($) => $.feishu.sources.dialog.allowlist_loading)}
                    </p>
                  )}
                  {chatsQuery.isError && (
                    <p className="p-3 text-xs text-destructive">
                      {t(($) => $.feishu.sources.dialog.allowlist_error)}
                    </p>
                  )}
                  {!chatsQuery.isPending && !chatsQuery.isError && chats.length === 0 && (
                    <p className="p-3 text-xs text-muted-foreground">
                      {t(($) => $.feishu.sources.dialog.allowlist_empty)}
                    </p>
                  )}
                  <ul>
                    {chats.map((chat) => (
                      <li key={chat.chatId}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
                          <Checkbox
                            checked={selected.has(chat.chatId)}
                            onCheckedChange={() => toggleChat(chat.chatId)}
                            aria-label={chat.name ?? chat.chatId}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm">{chat.name ?? chat.chatId}</span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">
                              {truncateId(chat.chatId)}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )
            : (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t(($) => $.feishu.sources.dialog.allowlist_after_create)}
              </p>
            )}

          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              id="feishu-source-retention"
              label={t(($) => $.feishu.sources.dialog.retention_label)}
              value={draft.retentionDays}
              onChange={(value) => setDraft((current) => ({ ...current, retentionDays: value }))}
            />
            <NumberField
              id="feishu-source-poll"
              label={t(($) => $.feishu.sources.dialog.poll_label)}
              value={draft.pollIntervalSeconds}
              onChange={(value) => setDraft((current) => ({ ...current, pollIntervalSeconds: value }))}
            />
            <NumberField
              id="feishu-source-retry-interval"
              label={t(($) => $.feishu.sources.dialog.retry_interval_label)}
              value={draft.unprocessedRetrySeconds}
              onChange={(value) => setDraft((current) => ({ ...current, unprocessedRetrySeconds: value }))}
            />
            <NumberField
              id="feishu-source-retry-limit"
              label={t(($) => $.feishu.sources.dialog.retry_limit_label)}
              value={draft.unprocessedRetryLimit}
              onChange={(value) => setDraft((current) => ({ ...current, unprocessedRetryLimit: value }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t(($) => $.feishu.sources.dialog.cancel)}
          </Button>
          <Button onClick={handleSave} disabled={pending || draft.endpointName === ""}>
            {pending
              ? t(($) => $.feishu.sources.dialog.saving)
              : t(($) => $.feishu.sources.dialog.save)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ id, label, value, onChange }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={1} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
