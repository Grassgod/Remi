"use client";

import { useId, useMemo, useState } from "react";
import { Bot, ChevronDown, Loader2, Plus, Share2 } from "lucide-react";
import type { Agent } from "@multiremi/core/types";
import {
  useCreateIssueSession,
  useCreateSessionTask,
  usePublishSessionResult,
} from "@multiremi/core/issues";
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
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { toast } from "sonner";
import { ActorAvatar } from "../../common/actor-avatar";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";
import { PickerEmpty, PickerItem, PropertyPicker } from "./pickers/property-picker";

// Publish-result / delegate-task actions for the active session, as buttons.
// Rendered from the issue detail's right panel; the session list's per-row
// menu reaches the same dialogs for any other session. Creating a session is
// deliberately absent — the rail header owns that, and only that.
export function IssueSessionActions({
  issueId,
  issueSessionId,
  agents,
}: {
  issueId: string;
  issueSessionId: string;
  agents: Agent[];
}) {
  const { t } = useT("issues");
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const hasActiveAgents = agents.some((agent) => !agent.archived_at);

  return (
    <>
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
        onClick={() => setDelegateOpen(true)}
        disabled={!hasActiveAgents}
      >
        <Bot className="h-3.5 w-3.5" />
        {t(($) => $.detail.delegate_task)}
      </Button>

      <SessionDelegateTaskDialog
        issueId={issueId}
        issueSessionId={issueSessionId}
        agents={agents}
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
      />
      <SessionPublishResultDialog
        issueId={issueId}
        issueSessionId={issueSessionId}
        open={publishOpen}
        onOpenChange={setPublishOpen}
      />
    </>
  );
}

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
  const titleFieldId = useId();

  const submitCreate = async () => {
    const title = sessionTitle.trim();
    if (!title) return;
    try {
      const session = await createSession.mutateAsync({ title });
      if (session.id) onCreated?.(session.id);
      setSessionTitle("");
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t(($) => $.detail.new_session_title)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.detail.new_session_description)}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto outline-none">
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

// Same Popover + picker-row shell the assignee picker uses, so an agent is
// always shown with its avatar and live presence dot. A native <select> can
// carry neither, and on an agent-first product the presence dot is the whole
// decision — delegating to an offline agent just queues work nobody runs.
function DelegateAgentPicker({
  id,
  agents,
  value,
  onChange,
}: {
  id: string;
  agents: Agent[];
  value: string;
  onChange: (agentId: string) => void;
}) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const query = filter.trim().toLowerCase();
  const filtered = agents.filter(
    (agent) =>
      !query
      || agent.name.toLowerCase().includes(query)
      || matchesPinyin(agent.name, query),
  );
  const selected = agents.find((agent) => agent.id === value) ?? null;

  return (
    <PropertyPicker
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter("");
      }}
      width="w-[var(--anchor-width)]"
      align="start"
      searchable
      searchPlaceholder={t(($) => $.detail.delegate_agent_search_placeholder)}
      onSearchChange={setFilter}
      triggerRender={
        <button
          type="button"
          id={id}
          className="flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
        />
      }
      trigger={
        <>
          {selected ? (
            <>
              <ActorAvatar actorType="agent" actorId={selected.id} size={20} showStatusDot />
              <span className="min-w-0 flex-1 truncate">{selected.name}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {t(($) => $.detail.delegate_agent_placeholder)}
            </span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </>
      }
    >
      {filtered.map((agent) => (
        <PickerItem
          key={agent.id}
          selected={agent.id === value}
          onClick={() => {
            onChange(agent.id);
            setOpen(false);
          }}
        >
          <ActorAvatar actorType="agent" actorId={agent.id} size={18} showStatusDot />
          <span className="truncate">{agent.name}</span>
        </PickerItem>
      ))}
      {filtered.length === 0 && <PickerEmpty />}
    </PropertyPicker>
  );
}

export function SessionDelegateTaskDialog({
  issueId,
  issueSessionId,
  agents,
  open,
  onOpenChange,
}: {
  issueId: string;
  issueSessionId: string;
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("issues");
  const createTask = useCreateSessionTask(issueId, issueSessionId);
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const agentFieldId = useId();
  const promptFieldId = useId();

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived_at),
    [agents],
  );
  // The picker shows the first active agent until the user picks another,
  // so the dialog never submits an empty agent on the default path.
  const resolvedAgentId = agentId || activeAgents[0]?.id || "";
  const hasAgents = activeAgents.length > 0;

  const submitDelegate = async () => {
    if (!resolvedAgentId || !prompt.trim()) return;
    try {
      await createTask.mutateAsync({ agentId: resolvedAgentId, prompt: prompt.trim() });
      setPrompt("");
      setAgentId("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.delegate_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.detail.delegate_task_title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.detail.delegate_task_description)}
          </DialogDescription>
        </DialogHeader>
        {/* The row menu can open this dialog on a workspace that has no
            agents at all. Say so instead of presenting an empty picker and
            a permanently disabled submit button. */}
        {!hasAgents ? (
          <p className="min-h-0 flex-1 overflow-y-auto outline-none rounded-md border border-dashed bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            {t(($) => $.detail.no_agents_in_workspace)}
          </p>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto outline-none">
            <div className="space-y-2">
              <Label htmlFor={agentFieldId}>{t(($) => $.detail.delegate_agent)}</Label>
              <DelegateAgentPicker
                id={agentFieldId}
                agents={activeAgents}
                value={resolvedAgentId}
                onChange={setAgentId}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={promptFieldId}>{t(($) => $.detail.delegate_prompt)}</Label>
              <Textarea
                id={promptFieldId}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t(($) => $.detail.delegate_prompt_placeholder)}
                rows={5}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.detail.dialog_cancel)}
          </Button>
          <Button
            onClick={() => void submitDelegate()}
            disabled={!resolvedAgentId || !prompt.trim() || createTask.isPending}
          >
            {createTask.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(($) => $.detail.delegate_submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SessionPublishResultDialog({
  issueId,
  issueSessionId,
  open,
  onOpenChange,
}: {
  issueId: string;
  issueSessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("issues");
  const publishResult = usePublishSessionResult(issueId, issueSessionId);
  const [resultTitle, setResultTitle] = useState("");
  const [resultBody, setResultBody] = useState("");
  const titleFieldId = useId();
  const bodyFieldId = useId();

  const submitResult = async () => {
    if (!resultBody.trim()) return;
    try {
      await publishResult.mutateAsync({
        title: resultTitle.trim(),
        body: resultBody.trim(),
      });
      setResultTitle("");
      setResultBody("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.detail.publish_result_failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.detail.publish_result_title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.detail.publish_result_description)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto outline-none">
          <div className="space-y-2">
            <Label htmlFor={titleFieldId}>{t(($) => $.detail.result_title)}</Label>
            <Input
              id={titleFieldId}
              value={resultTitle}
              onChange={(event) => setResultTitle(event.target.value)}
              placeholder={t(($) => $.detail.result_title_placeholder)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={bodyFieldId}>{t(($) => $.detail.result_body)}</Label>
            <Textarea
              id={bodyFieldId}
              value={resultBody}
              onChange={(event) => setResultBody(event.target.value)}
              placeholder={t(($) => $.detail.result_body_placeholder)}
              rows={7}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.detail.dialog_cancel)}
          </Button>
          <Button
            onClick={() => void submitResult()}
            disabled={!resultBody.trim() || publishResult.isPending}
          >
            {publishResult.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(($) => $.detail.publish_result_submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
