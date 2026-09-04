"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@multiremi/core/auth";
import { issueTopicConfigOptions } from "@multiremi/core/feishu-bot/queries";
import { useSaveIssueTopicConfig } from "@multiremi/core/feishu-bot/mutations";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { projectListOptions } from "@multiremi/core/projects";
import type { IssueTopicConfig } from "@multiremi/core/types";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { useT } from "../../i18n";

const EMPTY_CONFIG: IssueTopicConfig = {
  enabled: false,
  chat_id: "",
  project_ids: null,
};

export function IssueTopicSection() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const user = useAuthStore((state) => state.user);
  const membersQuery = useQuery(memberListOptions(workspaceId));
  const role = (membersQuery.data ?? []).find((member) => member.user_id === user?.id)?.role;
  const canManage = role === "owner" || role === "admin";
  const configQuery = useQuery(issueTopicConfigOptions(workspaceId));
  const projectsQuery = useQuery(projectListOptions(workspaceId));
  const save = useSaveIssueTopicConfig(workspaceId);
  const [draft, setDraft] = useState<IssueTopicConfig>(EMPTY_CONFIG);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty || !configQuery.data) return;
    setDraft(configQuery.data.config);
  }, [configQuery.data, dirty]);

  if (membersQuery.isPending || configQuery.isPending) {
    return <div className="h-28 animate-pulse rounded border bg-muted/30" />;
  }

  const projects = (projectsQuery.data ?? []).filter((project) => project.archived_at === null);
  const limited = draft.project_ids !== null;
  const canSave = canManage
    && !save.isPending
    && (!draft.enabled || draft.chat_id.trim().length > 0)
    && (!limited || (draft.project_ids?.length ?? 0) > 0);

  function edit(patch: Partial<IssueTopicConfig>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  function toggleProject(projectId: string, checked: boolean) {
    const selected = draft.project_ids ?? [];
    edit({
      project_ids: checked
        ? [...selected, projectId]
        : selected.filter((id) => id !== projectId),
    });
  }

  async function handleSave() {
    if (!canSave) return;
    try {
      const response = await save.mutateAsync({
        enabled: draft.enabled,
        chat_id: draft.chat_id.trim(),
        project_ids: draft.project_ids,
      });
      setDraft(response.config);
      setDirty(false);
      toast.success(t(($) => $.feishu.issueTopics.toast_saved));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.feishu.issueTopics.toast_save_failed));
    }
  }

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t(($) => $.feishu.issueTopics.title)}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(($) => $.feishu.issueTopics.description)}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="issue-topic-enabled">{t(($) => $.feishu.issueTopics.enabled)}</Label>
              <p className="text-xs text-muted-foreground">{t(($) => $.feishu.issueTopics.enabled_hint)}</p>
            </div>
            <Switch
              id="issue-topic-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) => edit({ enabled })}
              disabled={!canManage}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issue-topic-chat-id">{t(($) => $.feishu.issueTopics.chat_id)}</Label>
            <Input
              id="issue-topic-chat-id"
              value={draft.chat_id}
              onChange={(event) => edit({ chat_id: event.target.value })}
              placeholder="oc_xxxxxxxxxxxxxxxx"
              disabled={!canManage}
            />
            <p className="text-xs text-muted-foreground">{t(($) => $.feishu.issueTopics.chat_id_hint)}</p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="issue-topic-project-filter">{t(($) => $.feishu.issueTopics.project_filter)}</Label>
                <p className="text-xs text-muted-foreground">{t(($) => $.feishu.issueTopics.project_filter_hint)}</p>
              </div>
              <Switch
                id="issue-topic-project-filter"
                checked={limited}
                onCheckedChange={(checked) => edit({ project_ids: checked ? [] : null })}
                disabled={!canManage}
              />
            </div>

            {limited && (
              <div className="max-h-44 overflow-y-auto rounded-md border">
                {projects.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">{t(($) => $.feishu.issueTopics.no_projects)}</p>
                ) : projects.map((project) => {
                  const checked = draft.project_ids?.includes(project.id) === true;
                  return (
                    <label
                      key={project.id}
                      className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => toggleProject(project.id, value === true)}
                        disabled={!canManage}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.title}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {limited && (draft.project_ids?.length ?? 0) === 0 && (
              <p className="text-xs text-destructive">{t(($) => $.feishu.issueTopics.project_required)}</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            {!canManage ? (
              <p className="text-xs text-muted-foreground">{t(($) => $.feishu.issueTopics.read_only)}</p>
            ) : <span />}
            {canManage && (
              <Button onClick={handleSave} disabled={!canSave || !dirty}>
                {save.isPending
                  ? <LoaderCircle className="size-4 animate-spin" />
                  : <Save className="size-4" />}
                {save.isPending
                  ? t(($) => $.feishu.issueTopics.saving)
                  : t(($) => $.feishu.issueTopics.save)}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
