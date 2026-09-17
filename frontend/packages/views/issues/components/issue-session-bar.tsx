"use client";

import { useId, useState } from "react";
import { FolderGit2, Loader2, MessagesSquare, Plus } from "lucide-react";
import { useCreateIssueSession } from "@multiremi/core/issues";
import type { IssueSession } from "@multiremi/core/types";
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
import { NativeSelect, NativeSelectOption } from "@multiremi/ui/components/ui/native-select";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { getSessionDisplayName } from "../utils/session-display";

export function NewSessionButton({
  issueId,
  sessions,
  onCreated,
}: {
  issueId: string;
  sessions: IssueSession[];
  onCreated?: (sessionId: string) => void;
}) {
  const { t } = useT("issues");
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t(($) => $.detail.new_session)}
        onClick={() => setCreateOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
      <NewSessionDialog
        issueId={issueId}
        sessions={sessions}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={onCreated}
      />
    </>
  );
}

interface NewSessionDialogProps {
  issueId: string;
  sessions: IssueSession[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (sessionId: string) => void;
  parentSessionId?: string;
}

export function NewSessionDialog({ open, ...props }: NewSessionDialogProps) {
  const createSession = useCreateIssueSession(props.issueId);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!createSession.isPending) props.onOpenChange(nextOpen);
      }}
    >
      {/* Each opening starts a fresh form using the current session list. */}
      {open && <NewSessionForm key={props.parentSessionId ?? "new"} {...props} createSession={createSession} />}
    </Dialog>
  );
}

function NewSessionForm({
  sessions,
  onOpenChange,
  onCreated,
  parentSessionId,
  createSession,
}: Omit<NewSessionDialogProps, "open"> & {
  createSession: ReturnType<typeof useCreateIssueSession>;
}) {
  const { t } = useT("issues");
  const parentSessions = sessions.filter((session) => session.parent_session_id == null);
  const discussionOnly = parentSessionId !== undefined;
  const [sessionTitle, setSessionTitle] = useState("");
  const [holdsWorkspace, setHoldsWorkspace] = useState(!discussionOnly);
  // Undefined follows the default as sessions load; an empty string is the
  // user's explicit choice not to inherit and must survive query refreshes.
  const [inheritFrom, setInheritFrom] = useState(parentSessionId);
  const requestedParentId = inheritFrom ?? parentSessions.find((session) => session.is_default === true)?.id ?? "";
  const selectedParentId = parentSessions.some((session) => session.id === requestedParentId) ? requestedParentId : "";
  const titleFieldId = useId();
  const parentFieldId = useId();
  const workDescriptionId = useId();
  const discussionDescriptionId = useId();

  const submitCreate = async () => {
    const title = sessionTitle.trim();
    if (!title || createSession.isPending) return;
    try {
      const session = await createSession.mutateAsync({
        title,
        holds_workspace: holdsWorkspace,
        ...(!holdsWorkspace && selectedParentId ? { parent_session_id: selectedParentId } : {}),
      });
      if (session.id) onCreated?.(session.id);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.session_create_failed));
    }
  };

  return (
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t(($) => $.detail.new_session_title)}</DialogTitle>
        <DialogDescription>
          {t(($) => $.detail.new_session_description)}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto outline-none">
        <div className="space-y-2">
          <Label htmlFor={titleFieldId}>{t(($) => $.detail.session_name)}</Label>
          <Input
            id={titleFieldId}
            value={sessionTitle}
            onChange={(event) => setSessionTitle(event.target.value)}
            placeholder={t(($) => $.detail.session_name_placeholder)}
            disabled={createSession.isPending}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void submitCreate();
            }}
          />
        </div>
        <fieldset className="space-y-2" disabled={createSession.isPending}>
          <legend className="text-sm font-medium">
            {t(($) => $.detail.session_type)}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-label={t(($) => $.detail.session_type_work)}
              aria-describedby={workDescriptionId}
              aria-pressed={holdsWorkspace}
              disabled={discussionOnly}
              onClick={() => setHoldsWorkspace(true)}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-md border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                holdsWorkspace
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50",
              )}
            >
              <span className="flex items-center gap-2">
                <FolderGit2 className="h-4 w-4 shrink-0" />
                <span>{t(($) => $.detail.session_type_work)}</span>
              </span>
              <span id={workDescriptionId} className="text-xs leading-relaxed text-muted-foreground">
                {t(($) => $.detail.session_type_working_description)}
              </span>
            </button>
            <button
              type="button"
              aria-label={t(($) => $.detail.session_type_discussion)}
              aria-describedby={discussionDescriptionId}
              aria-pressed={!holdsWorkspace}
              onClick={() => setHoldsWorkspace(false)}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-md border p-3 text-left text-sm transition-colors",
                !holdsWorkspace
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50",
              )}
            >
              <span className="flex items-center gap-2">
                <MessagesSquare className="h-4 w-4 shrink-0" />
                <span>{t(($) => $.detail.session_type_discussion)}</span>
              </span>
              <span id={discussionDescriptionId} className="text-xs leading-relaxed text-muted-foreground">
                {t(($) => $.detail.session_type_discussion_description)}
              </span>
            </button>
          </div>
        </fieldset>
        {!holdsWorkspace && (
          <div className="space-y-2">
            <Label htmlFor={parentFieldId}>{t(($) => $.detail.session_inherit_from)}</Label>
            <NativeSelect
              id={parentFieldId}
              className="w-full"
              value={selectedParentId}
              disabled={createSession.isPending}
              onChange={(event) => setInheritFrom(event.target.value)}
            >
              <NativeSelectOption value="">{t(($) => $.detail.session_inherit_none)}</NativeSelectOption>
              {parentSessions.map((session) => (
                <NativeSelectOption key={session.id} value={session.id}>
                  {getSessionDisplayName(t, session)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={createSession.isPending} onClick={() => onOpenChange(false)}>
          {t(($) => $.detail.dialog_cancel)}
        </Button>
        <Button onClick={() => void submitCreate()} disabled={!sessionTitle.trim() || createSession.isPending}>
          {createSession.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t(($) => $.detail.create_session)}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
