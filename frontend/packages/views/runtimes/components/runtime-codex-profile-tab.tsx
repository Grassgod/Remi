import type { AgentRuntime } from "@multiremi/core/types";
import { RuntimeProviderProfileTab } from "./runtime-provider-profile-tab";
export function RuntimeCodexProfileTab(props: { runtime: AgentRuntime; canManage: boolean }) {
  return <RuntimeProviderProfileTab {...props} provider="codex" />;
}
