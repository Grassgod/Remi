"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CheckCircle2, Circle, FileOutput, Loader2, Plus, Share2, Users, XCircle } from "lucide-react";
import type { Agent, IssueSession, IssueSessionTask, SessionResult } from "@multiremi/core/types";
import {
  issueSessionResultsOptions,
  issueSessionTasksOptions,
  useAddSessionParticipant,
  useCreateIssueSession,
  useCreateSessionTask,
  usePublishSessionResult,
} from "@multiremi/core/issues";
import { Button } from "@multiremi/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@multiremi/ui/components/ui/popover";
import { AvatarGroup, AvatarGroupCount } from "@multiremi/ui/components/ui/avatar";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";

interface IssueSessionBarProps {
  issueId: string;
  sessions: IssueSession[];
  selectedSessionId: string;
  agents: Agent[];
  onSelectSession: (sessionId: string) => void;
}

export function IssueSessionBar({
  issueId,
  sessions,
  selectedSessionId,
  agents,
  onSelectSession,
}: IssueSessionBarProps) {
  const { t } = useT("issues");
  const selected = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const createSession = useCreateIssueSession(issueId);
  const addParticipant = useAddSessionParticipant(issueId, selectedSessionId);
  const createTask = useCreateSessionTask(issueId, selectedSessionId);
  const publishResult = usePublishSessionResult(issueId, selectedSessionId);
  const [createOpen, setCreateOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [resultTitle, setResultTitle] = useState("");
  const [resultBody, setResultBody] = useState("");

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived_at),
    [agents],
  );
  const participantAgentIds = new Set(
    (selected?.participants ?? [])
      .filter((participant) => participant.participant_type === "agent")
      .map((participant) => participant.participant_id),
  );
  const availableAgents = activeAgents.filter((agent) => !participantAgentIds.has(agent.id));

  const submitCreate = async () => {
    const title = sessionTitle.trim();
    if (!title) return;
    try {
      const session = await createSession.mutateAsync({ title });
      if (session.id) onSelectSession(session.id);
      setSessionTitle("");
      setCreateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.session_create_failed));
    }
  };

  const submitDelegate = async () => {
    const resolvedAgentId = agentId || activeAgents[0]?.id || "";
    if (!resolvedAgentId || !prompt.trim()) return;
    try {
      await createTask.mutateAsync({ agentId: resolvedAgentId, prompt: prompt.trim() });
      setPrompt("");
      setAgentId("");
      setDelegateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.delegate_failed));
    }
  };

  const submitResult = async () => {
    if (!resultBody.trim()) return;
    try {
      await publishResult.mutateAsync({
        title: resultTitle.trim(),
        body: resultBody.trim(),
      });
      setResultTitle("");
      setResultBody("");
      setPublishOpen(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.publish_result_failed));
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {t(($) => $.detail.sessions_label)}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors",
                session.id === selectedSessionId
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {session.title}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t(($) => $.detail.new_session)}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {selected && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/40 px-3 py-2">
          <Popover>
            <PopoverTrigger
              render={
                <button type="button" className="flex min-w-0 items-center gap-2">
                  {selected.participants.length > 0 ? (
                    <AvatarGroup>
                      {selected.participants.slice(0, 4).map((participant) => (
                        <ActorAvatar
                          key={`${participant.participant_type}-${participant.participant_id}`}
                          actorType={participant.participant_type}
                          actorId={participant.participant_id}
                          size={22}
                        />
                      ))}
                      {selected.participants.length > 4 && (
                        <AvatarGroupCount>+{selected.participants.length - 4}</AvatarGroupCount>
                      )}
                    </AvatarGroup>
                  ) : (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed text-muted-foreground">
                      <Users className="h-3 w-3" />
                    </span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    {t(($) => $.detail.session_participants)}
                  </span>
                </button>
              }
            />
            <PopoverContent align="start" className="w-64 p-2">
              <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">
                {t(($) => $.detail.add_agent)}
              </div>
              {availableAgents.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {t(($) => $.detail.no_agents_available)}
                </p>
              ) : (
                <div className="space-y-1">
                  {availableAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                      onClick={() => addParticipant.mutate({
                        participantType: "agent",
                        participantId: agent.id,
                      })}
                    >
                      <ActorAvatar actorType="agent" actorId={agent.id} size={22} />
                      <span className="truncate">{agent.name}</span>
                      {addParticipant.isPending && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" />}
                    </button>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPublishOpen(true)}
            >
              <Share2 className="h-3.5 w-3.5" />
              {t(($) => $.detail.publish_result)}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAgentId(activeAgents[0]?.id ?? "");
                setDelegateOpen(true);
              }}
              disabled={activeAgents.length === 0}
            >
              <Bot className="h-3.5 w-3.5" />
              {t(($) => $.detail.delegate_task)}
            </Button>
          </div>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t(($) => $.detail.new_session_title)}</DialogTitle>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span>{t(($) => $.detail.session_name)}</span>
            <Input
              value={sessionTitle}
              onChange={(event) => setSessionTitle(event.target.value)}
              placeholder={t(($) => $.detail.session_name_placeholder)}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitCreate();
              }}
            />
          </label>
          <div className="flex justify-end">
            <Button
              onClick={() => void submitCreate()}
              disabled={!sessionTitle.trim() || createSession.isPending}
            >
              {createSession.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(($) => $.detail.create_session)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={delegateOpen} onOpenChange={setDelegateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t(($) => $.detail.delegate_task_title)}</DialogTitle>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span>{t(($) => $.detail.delegate_agent)}</span>
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span>{t(($) => $.detail.delegate_prompt)}</span>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t(($) => $.detail.delegate_prompt_placeholder)}
              rows={5}
            />
          </label>
          <div className="flex justify-end">
            <Button
              onClick={() => void submitDelegate()}
              disabled={!agentId || !prompt.trim() || createTask.isPending}
            >
              {createTask.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(($) => $.detail.delegate_submit)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t(($) => $.detail.publish_result_title)}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t(($) => $.detail.publish_result_description)}
          </p>
          <label className="space-y-2 text-sm">
            <span>{t(($) => $.detail.result_title)}</span>
            <Input
              value={resultTitle}
              onChange={(event) => setResultTitle(event.target.value)}
              placeholder={t(($) => $.detail.result_title_placeholder)}
              autoFocus
            />
          </label>
          <label className="space-y-2 text-sm">
            <span>{t(($) => $.detail.result_body)}</span>
            <Textarea
              value={resultBody}
              onChange={(event) => setResultBody(event.target.value)}
              placeholder={t(($) => $.detail.result_body_placeholder)}
              rows={7}
            />
          </label>
          <div className="flex justify-end">
            <Button
              onClick={() => void submitResult()}
              disabled={!resultBody.trim() || publishResult.isPending}
            >
              {publishResult.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(($) => $.detail.publish_result_submit)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function taskStatusIcon(task: IssueSessionTask) {
  switch (task.status) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    case "failed":
    case "cancelled":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "running":
    case "dispatched":
    case "waiting_local_directory":
      return <Loader2 className="h-4 w-4 animate-spin text-info" />;
    default:
      return <Circle className="h-4 w-4 text-warning" />;
  }
}

export function IssueSessionTaskCards({
  issueId,
  issueSessionId,
}: {
  issueId: string;
  issueSessionId: string;
}) {
  const { t } = useT("issues");
  const { data: tasks = [] } = useQuery(issueSessionTasksOptions(issueId, issueSessionId));
  if (tasks.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        {t(($) => $.detail.session_tasks)}
      </div>
      {tasks.map((task) => (
        <div key={task.id} className="flex items-start gap-2.5 rounded-lg border bg-card/40 px-3 py-2.5">
          <div className="mt-0.5">{taskStatusIcon(task)}</div>
          <ActorAvatar actorType="agent" actorId={task.agent_id} size={22} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm">{task.prompt ?? task.trigger_summary ?? task.id}</p>
            <p className="mt-1 text-xs capitalize text-muted-foreground">{task.status.replaceAll("_", " ")}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function IssueSessionResultCards({
  issueId,
  issueSessionId,
  sessions,
}: {
  issueId: string;
  issueSessionId: string;
  sessions: IssueSession[];
}) {
  const { t } = useT("issues");
  const { data: issueResults = [] } = useQuery(issueSessionResultsOptions(issueId));
  if (issueResults.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        {t(($) => $.detail.published_results)}
      </div>
      {issueResults.map((result) => (
        <SessionResultCard
          key={result.id}
          result={result}
          sourceTitle={
            sessions.find((session) => session.id === result.source_session_id)?.title
            ?? result.source_session_id
          }
          isCurrentSession={result.source_session_id === issueSessionId}
        />
      ))}
    </div>
  );
}

function SessionResultCard({
  result,
  sourceTitle,
  isCurrentSession,
}: {
  result: SessionResult;
  sourceTitle: string;
  isCurrentSession: boolean;
}) {
  const { t } = useT("issues");
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-dashed bg-card/40 px-3 py-2.5">
      <FileOutput className="mt-0.5 h-4 w-4 shrink-0 text-info" />
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-xs text-muted-foreground">
          {isCurrentSession
            ? t(($) => $.detail.result_from_current_session)
            : t(($) => $.detail.result_from_session, { session: sourceTitle })}
        </p>
        {result.title && <p className="text-sm font-medium">{result.title}</p>}
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{result.body}</p>
      </div>
    </div>
  );
}
