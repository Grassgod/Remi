"use client";

import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { UsagePanel } from "../../usage/usage-panel";

export function UsageSection({ runtime }: { runtime: AgentRuntime }) {
  const wsId = useWorkspaceId();
  return <UsagePanel wsId={wsId} runtimeId={runtime.id} />;
}
