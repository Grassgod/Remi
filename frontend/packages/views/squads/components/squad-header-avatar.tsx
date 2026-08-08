"use client";

import { resolvePublicFileUrl } from "@multiremi/core/workspace/avatar-url";
import { Users } from "lucide-react";
import { ActorAvatar as ActorAvatarBase } from "@multiremi/ui/components/common/actor-avatar";
import type { Squad } from "@multiremi/core/types";

// Compact 16px avatar shown next to the name in the page header. Falls back
// to the Users icon when no custom avatar is set so the squad still has a
// recognisable glyph in the breadcrumb strip.
export function SquadHeaderAvatar({ squad, initials }: { squad: Squad; initials: string }) {
  if (!squad.avatar_url) {
    return <Users className="h-4 w-4 text-muted-foreground" />;
  }
  return (
    <ActorAvatarBase
      name={squad.name}
      initials={initials}
      avatarUrl={resolvePublicFileUrl(squad.avatar_url)}
      size={16}
      className="rounded"
    />
  );
}
