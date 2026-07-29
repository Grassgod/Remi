"use client";

import { useMemo, useState } from "react";
import { Bot, Loader2, Plus, Share2 } from "lucide-react";
import type { Agent } from "@multiremi/core/types";
import {
  useCreateIssueSession,
  useCreateSessionTask,
  usePublishSessionResult,
} from "@multiremi/core/issues";
import { Button } from "@multiremi/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { toast } from "sonner";
import { useT } from "../../i18n";

// Publish-result / delegate-task / new-session actions for one session, as
// buttons. Rendered from the issue detail's right panel on single-session
// issues; multi-session issues reach the same dialogs from the session list's
// per-row menu and its header instead.
export function IssueSessionActions({
  issueId,
  issueSessionId,
  agents,
  onSelectSession,
}: {
  issueId: string;
  issueSessionId: string;
  agents: Agent[];
  onSelectSession?: (sessionId: string) => void;
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
      <NewSessionButton issueId={issueId} onCreated={onSelectSession} />

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

// The one create-session affordance. Two mount points, one implementation:
// the session list's column header (`iconOnly`, multi-session issues) and the
// right panel's action row (labelled, single-session issues) — without the
// latter a single-session issue would have no way to open a second session.
export function NewSessionButton({
  issueId,
  onCreated,
  iconOnly = false,
}: {
  issueId: string;
  onCreated?: (sessionId: string) => void;
  iconOnly?: boolean;
}) {
  const { t } = useT("issues");
  const createSession = useCreateIssueSession(issueId);
  const [createOpen, setCreateOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("");

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
        size={iconOnly ? "icon-sm" : "sm"}
        aria-label={t(($) => $.detail.new_session)}
        onClick={() => setCreateOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        {!iconOnly && t(($) => $.detail.new_session)}
      </Button>

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
    </>
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

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived_at),
    [agents],
  );
  // The select shows the first active agent until the user picks another,
  // so the dialog never submits an empty agent on the default path.
  const resolvedAgentId = agentId || activeAgents[0]?.id || "";

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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.detail.delegate_task_title)}</DialogTitle>
        </DialogHeader>
        <label className="space-y-2 text-sm">
          <span>{t(($) => $.detail.delegate_agent)}</span>
          <select
            value={resolvedAgentId}
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
            disabled={!resolvedAgentId || !prompt.trim() || createTask.isPending}
          >
            {createTask.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(($) => $.detail.delegate_submit)}
          </Button>
        </div>
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
  );
}
