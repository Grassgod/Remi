"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  Link2,
  PanelRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Label } from "@multiremi/ui/components/ui/label";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multiremi/core/paths";
import { deriveScmSettings } from "@multiremi/core/scm";
import { memberListOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import { api } from "@multiremi/core/api";
import type { Workspace } from "@multiremi/core/types";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { ScmConnectionsSection } from "./scm-connections-section";

type SettingsKey =
  | "scm_change_sidebar_enabled"
  | "scm_auto_link_enabled"
  | "scm_complete_issue_on_merge_enabled"
  | "co_authored_by_enabled";

export function SourceControlTab() {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const workspacePaths = useWorkspacePaths();
  const user = useAuthStore((state) => state.user);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const currentMember = members.find((member) => member.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";
  const settings = deriveScmSettings(workspace);
  const [savingKey, setSavingKey] = useState<SettingsKey | null>(null);

  async function persistSetting(key: SettingsKey, next: boolean) {
    if (!workspace || savingKey) return;
    setSavingKey(key);
    try {
      const merged = {
        ...((workspace.settings as Record<string, unknown>) ?? {}),
        [key]: next,
      };
      const updated = await api.updateWorkspace(workspace.id, { settings: merged });
      queryClient.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.source_control.toast_failed));
    } finally {
      setSavingKey(null);
    }
  }

  if (!workspace) return null;

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {t(($) => $.source_control.page_description)}
      </p>

      <ScmConnectionsSection workspaceId={wsId} canManage={canManage} />

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.source_control.section_collaboration)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.source_control.section_collaboration_description)}
          </p>
        </div>
        <Card>
          <CardContent className="space-y-4">
            <FeatureRow
              id="scm-change-sidebar"
              icon={<PanelRight className="size-4" />}
              label={t(($) => $.source_control.feature_change_sidebar_label)}
              description={t(($) => $.source_control.feature_change_sidebar_description)}
              checked={settings.changeSidebar}
              disabled={!canManage || savingKey === "scm_change_sidebar_enabled"}
              onCheckedChange={(value) => persistSetting("scm_change_sidebar_enabled", value)}
            />
            <FeatureRow
              id="scm-auto-link"
              icon={<Link2 className="size-4" />}
              label={t(($) => $.source_control.feature_auto_link_label)}
              description={t(($) => $.source_control.feature_auto_link_description)}
              checked={settings.autoLink}
              disabled={!canManage || savingKey === "scm_auto_link_enabled"}
              onCheckedChange={(value) => persistSetting("scm_auto_link_enabled", value)}
            />
            <FeatureRow
              id="scm-complete-on-merge"
              icon={<CheckCircle2 className="size-4" />}
              label={t(($) => $.source_control.feature_complete_on_merge_label)}
              description={t(($) => $.source_control.feature_complete_on_merge_description)}
              checked={settings.completeIssueOnMerge}
              disabled={!canManage || savingKey === "scm_complete_issue_on_merge_enabled"}
              onCheckedChange={(value) =>
                persistSetting("scm_complete_issue_on_merge_enabled", value)
              }
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.source_control.section_commits)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.source_control.section_commits_description)}
          </p>
        </div>
        <Card>
          <CardContent>
            <FeatureRow
              id="scm-coauthor"
              icon={<GitCommitHorizontal className="size-4" />}
              label={t(($) => $.source_control.feature_co_author_label)}
              description={
                <span>
                  {t(($) => $.source_control.feature_co_author_description_prefix)}{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {"Co-authored-by: Remi <remi@openremi.fun>"}
                  </code>{" "}
                  {t(($) => $.source_control.feature_co_author_description_suffix)}
                </span>
              }
              checked={settings.coAuthor}
              disabled={!canManage || savingKey === "co_authored_by_enabled"}
              onCheckedChange={(value) => persistSetting("co_authored_by_enabled", value)}
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t(($) => $.source_control.section_repositories)}</h2>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {t(($) => $.source_control.repositories_shortcut_label)}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigation.push(workspacePaths.repositories())}
            >
              <ExternalLink className="size-3.5" />
              {t(($) => $.source_control.repositories_shortcut_link)}
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function FeatureRow({
  id,
  icon,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  description: React.ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="rounded-md border bg-muted/50 p-2 text-muted-foreground">{icon}</div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
