"use client";

import { useMemo, useState } from "react";
import { Loader2, MoreHorizontal } from "lucide-react";
import type { Agent, IssueSession } from "@multiremi/core/types";
import { useAddSessionParticipant } from "@multiremi/core/issues";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { AvatarGroup, AvatarGroupCount } from "@multiremi/ui/components/ui/avatar";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT, useTimeAgo } from "../../i18n";
import {
  NewSessionButton,
  SessionDelegateTaskDialog,
  SessionPublishResultDialog,
} from "./issue-session-bar";

interface IssueSessionListProps {
  issueId: string;
  sessions: IssueSession[];
  selectedSessionId: string;
  agents: Agent[];
  onSelectSession: (sessionId: string) => void;
}

// Narrow session switcher rail on the far left of the issue detail panel.
// Only mounted on issues that have more than one session — an issue with
// just the default Main session has nothing to switch to, and its session
// actions live in the right properties panel instead.
//
// It is a sibling of the issue's scroll container, not a child: the rail
// keeps the full panel height, scrolls on its own once the list outgrows
// it, and stays put while the timeline scrolls. Width shrinks below the
// `lg` breakpoint so narrow windows keep a usable reading column.
export function IssueSessionList({
  issueId,
  sessions,
  selectedSessionId,
  agents,
  onSelectSession,
}: IssueSessionListProps) {
  const { t } = useT("issues");

  return (
    <div className="w-44 shrink-0 overflow-y-auto border-r px-2 py-8 lg:w-56">
      <div className="flex items-center gap-1 pl-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {t(($) => $.detail.sessions_label)}
        </span>
        <NewSessionButton issueId={issueId} onCreated={onSelectSession} iconOnly />
      </div>

      <div className="mt-1 space-y-0.5">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            issueId={issueId}
            session={session}
            agents={agents}
            isSelected={session.id === selectedSessionId}
            onSelect={onSelectSession}
          />
        ))}
      </div>
    </div>
  );
}

// Enum drift downgrades to the neutral tone instead of crashing.
function sessionStatusTone(status: IssueSession["status"]): string {
  switch (status) {
    case "active":
      return "bg-success";
    default:
      return "bg-muted-foreground/40";
  }
}

function SessionRow({
  issueId,
  session,
  agents,
  isSelected,
  onSelect,
}: {
  issueId: string;
  session: IssueSession;
  agents: Agent[];
  isSelected: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-md pr-1 transition-colors",
        isSelected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", sessionStatusTone(session.status))}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-xs",
              isSelected ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {session.title}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {timeAgo(session.updated_at)}
          </span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t(($) => $.detail.session_actions_aria)}
            />
          }
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuItem onClick={() => setParticipantsOpen(true)}>
            {t(($) => $.detail.session_participants)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setPublishOpen(true)}>
            {t(($) => $.detail.publish_result)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDelegateOpen(true)}>
            {t(($) => $.detail.delegate_task)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs live outside the menu: the menu content unmounts on close,
          which would take an open dialog with it. */}
      <SessionParticipantsDialog
        issueId={issueId}
        session={session}
        agents={agents}
        open={participantsOpen}
        onOpenChange={setParticipantsOpen}
      />
      <SessionPublishResultDialog
        issueId={issueId}
        issueSessionId={session.id}
        open={publishOpen}
        onOpenChange={setPublishOpen}
      />
      <SessionDelegateTaskDialog
        issueId={issueId}
        issueSessionId={session.id}
        agents={agents}
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
      />
    </div>
  );
}

function SessionParticipantsDialog({
  issueId,
  session,
  agents,
  open,
  onOpenChange,
}: {
  issueId: string;
  session: IssueSession;
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("issues");
  const addParticipant = useAddSessionParticipant(issueId, session.id);

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived_at),
    [agents],
  );
  const availableAgents = useMemo(() => {
    const participantAgentIds = new Set(
      session.participants
        .filter((participant) => participant.participant_type === "agent")
        .map((participant) => participant.participant_id),
    );
    return activeAgents.filter((agent) => !participantAgentIds.has(agent.id));
  }, [activeAgents, session.participants]);

  // One mutation object drives every row, so `isPending` alone would spin the
  // whole list. Pair it with the id currently in flight.
  const pendingAgentId = addParticipant.isPending
    ? addParticipant.variables?.participantId
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.detail.session_participants)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.detail.session_participants_description)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {session.participants.length > 0 && (
            <AvatarGroup>
              {session.participants.slice(0, 8).map((participant) => (
                <ActorAvatar
                  key={`${participant.participant_type}-${participant.participant_id}`}
                  actorType={participant.participant_type}
                  actorId={participant.participant_id}
                  size={22}
                />
              ))}
              {session.participants.length > 8 && (
                <AvatarGroupCount>+{session.participants.length - 8}</AvatarGroupCount>
              )}
            </AvatarGroup>
          )}
          <div className="text-xs font-medium text-muted-foreground">
            {t(($) => $.detail.add_agent)}
          </div>
          {availableAgents.length === 0 ? (
            // "Nothing to add" has two very different causes, and the fix the
            // user needs differs: create an agent vs. nothing left to do.
            <p className="text-xs text-muted-foreground">
              {activeAgents.length === 0
                ? t(($) => $.detail.no_agents_in_workspace)
                : t(($) => $.detail.all_agents_in_session)}
            </p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {availableAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  disabled={addParticipant.isPending}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => addParticipant.mutate(
                    { participantType: "agent", participantId: agent.id },
                    {
                      onError: (error) =>
                        toast.error(
                          error instanceof Error && error.message
                            ? error.message
                            : t(($) => $.detail.add_participant_failed),
                        ),
                    },
                  )}
                >
                  <ActorAvatar actorType="agent" actorId={agent.id} size={22} showStatusDot />
                  <span className="truncate">{agent.name}</span>
                  {pendingAgentId === agent.id && (
                    <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.detail.dialog_cancel)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
