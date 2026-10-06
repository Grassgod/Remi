"use client";

import { useWorkspaceId } from "@multiremi/core/hooks";
import { PageHeader } from "../../layout/page-header";
import { UsagePanel } from "../../usage/usage-panel";
import { useT } from "../../i18n";

export function DashboardPage() {
  const wsId = useWorkspaceId();
  const { t } = useT("usage");
  return <div className="flex h-full min-h-0 flex-col"><PageHeader><h1 className="text-sm font-semibold">{t($ => $.title)}</h1></PageHeader><div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6"><p className="mb-5 text-sm text-muted-foreground">{t($ => $.subtitle)}</p><UsagePanel wsId={wsId} /></div></div>;
}
