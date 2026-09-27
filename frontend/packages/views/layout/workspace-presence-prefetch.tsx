"use client";

import { useWorkspaceId } from "@multiremi/core";
import { useWorkspacePresencePrefetch } from "@multiremi/core/agents";
import { useAfterFirstScreen } from "@multiremi/core/platform/use-after-first-screen";
import { useNavigation } from "../navigation";

// Mount once inside any subtree that's already gated on "workspace resolved"
// (DashboardLayout on web, WorkspaceRouteLayout on desktop). useWorkspaceId
// throws when called outside a resolved workspace — the gating in those
// layouts guarantees this component never sees that state.
export function WorkspacePresencePrefetch() {
  const wsId = useWorkspaceId();
  const { pathname } = useNavigation();
  // MUL-472 b: agents/squads/snapshot are shell warm-ups, not page data, so
  // they wait for the current route's first content commit + idle window.
  const afterFirstScreen = useAfterFirstScreen({ routeKey: pathname });
  useWorkspacePresencePrefetch(wsId, afterFirstScreen);
  return null;
}
