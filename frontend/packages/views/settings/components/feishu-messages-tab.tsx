"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { feishuEndpointsOptions, feishuSourcesOptions } from "@multiremi/core/feishu";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { Separator } from "@multiremi/ui/components/ui/separator";
import { useT } from "../../i18n";
import { EndpointPanel } from "./feishu/endpoint-panel";
import { MessageSection } from "./feishu/message-section";
import { SourceSection } from "./feishu/source-section";

/**
 * Settings → Feishu messages.
 *
 * Deliberately its own tab rather than a section of Integrations: the Feishu
 * login and notification settings there configure an outbound bot, while this
 * one governs an inbound ingestion pipeline with its own operator surface.
 * Merging them would put a destructive "delete source" next to a login form.
 */
export function FeishuMessagesTab() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const user = useAuthStore((state) => state.user);
  const membersQuery = useQuery(memberListOptions(workspaceId));
  const role = membersQuery.data?.find((member) => member.user_id === user?.id)?.role;
  // Endpoint health and source configuration are operator surfaces. A Member
  // never issues those requests — hiding the controls alone would still expose
  // the data through the network tab.
  const permitted = role === "owner" || role === "admin";

  const endpointsQuery = useQuery(feishuEndpointsOptions(workspaceId, permitted));
  const sourcesQuery = useQuery(feishuSourcesOptions(workspaceId, permitted));

  const endpoints = endpointsQuery.data?.endpoints ?? [];
  const sources = sourcesQuery.data?.sources ?? [];
  // One connection is the supported topology; the panel shows the first one and
  // the source list carries the per-source binding.
  const endpoint = endpoints[0] ?? null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{t(($) => $.feishu.title)}</h2>
        <p className="text-sm text-muted-foreground">{t(($) => $.feishu.description)}</p>
      </header>

      <EndpointPanel
        permitted={permitted}
        configured={endpointsQuery.data?.configured === true}
        endpoint={endpoint}
        loading={membersQuery.isPending || endpointsQuery.isPending}
        refreshFailed={endpointsQuery.isError}
        workspaceId={workspaceId}
      />

      <Separator />

      <SourceSection
        permitted={permitted}
        workspaceId={workspaceId}
        sources={sources}
        endpoints={endpoints}
        loading={sourcesQuery.isPending}
      />

      <Separator />

      <MessageSection workspaceId={workspaceId} sources={sources} />
    </div>
  );
}
