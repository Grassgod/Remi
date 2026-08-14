"use client";

import { use } from "react";
import { PluginDetailPage } from "@multiremi/views/plugins";

export default function PluginDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <PluginDetailPage pluginId={id} />;
}
