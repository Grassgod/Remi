"use client";

import { useId, useState } from "react";
import { FolderGit2, Loader2, MessagesSquare, Plus } from "lucide-react";
import { useCreateIssueSession } from "@multiremi/core/issues";
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
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { useT } from "../../i18n";

// The one create-session affordance, with exactly one mount point: the
// session rail's header. The rail is always on screen, so a second copy in
// the right panel would only make "where do sessions come from?" ambiguous.
export function NewSessionButton({
  issueId,
  onCreated,
}: {
  issueId: string;
  onCreated?: (sessionId: string) => void;
}) {
  const { t } = useT("issues");
  const createSession = useCreateIssueSession(issueId);
  const [createOpen, setCreateOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("");
  const [holdsWorkspace, setHoldsWorkspace] = useState(true);
  const titleFieldId = useId();

  const submitCreate = async () => {
    const title = sessionTitle.trim();
    if (!title) return;
    try {
      const session = await createSession.mutateAsync({
        title,
        holds_workspace: holdsWorkspace,
      });
      if (session.id) onCreated?.(session.id);
      setSessionTitle("");
      setHoldsWorkspace(true);
      setCreateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.session_create_failed));
    }
  };

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

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setHoldsWorkspace(true);
        }}
      >
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
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitCreate();
                }}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {t(($) => $.detail.session_type)}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={holdsWorkspace}
                  onClick={() => setHoldsWorkspace(true)}
                  className={cn(
                    "flex min-h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm transition-colors",
                    holdsWorkspace
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <FolderGit2 className="h-4 w-4 shrink-0" />
                  <span>{t(($) => $.detail.session_type_work)}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={!holdsWorkspace}
                  onClick={() => setHoldsWorkspace(false)}
                  className={cn(
                    "flex min-h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm transition-colors",
                    !holdsWorkspace
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <MessagesSquare className="h-4 w-4 shrink-0" />
                  <span>{t(($) => $.detail.session_type_discussion)}</span>
                </button>
              </div>
            </fieldset>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              {t(($) => $.detail.dialog_cancel)}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              disabled={!sessionTitle.trim() || createSession.isPending}
            >
              {createSession.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(($) => $.detail.create_session)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
