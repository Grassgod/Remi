"use client";

import { resolvePublicFileUrl } from "@multiremi/core/workspace/avatar-url";
import { AvatarUploadButton } from "../../../common/avatar-upload-button";
import { Users } from "lucide-react";
import { ActorAvatar as ActorAvatarBase } from "@multiremi/ui/components/common/actor-avatar";
import type { Squad } from "@multiremi/core/types";

// Large click-to-upload avatar editor. Mirrors AvatarEditor in
// agent-detail-inspector.tsx — square (rounded-md) treatment is reserved
// for non-human actors (agent, squad), circles for humans.
export function SquadAvatarEditor({
  squad,
  initials,
  uploading,
  onUpload,
}: {
  squad: Squad;
  initials: string;
  uploading: boolean;
  onUpload: (url: string) => Promise<unknown>;
}) {
  return (
    <AvatarUploadButton
      className="h-16 w-16 rounded-lg bg-muted"
      busy={uploading}
      // Pre-existing i18n gap: this surface never got locale keys, unlike the
      // other four upload buttons. Kept verbatim so the extraction stays a
      // no-op; wiring it into the squads namespace is its own change.
      ariaLabel="Change squad avatar"
      successMessage="Avatar updated"
      errorMessage="Failed to upload avatar"
      onUploaded={onUpload}
    >
      {squad.avatar_url ? (
        <ActorAvatarBase
          name={squad.name}
          initials={initials}
          avatarUrl={resolvePublicFileUrl(squad.avatar_url)}
          size={64}
          className="rounded-none"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Users className="h-7 w-7" />
        </div>
      )}
    </AvatarUploadButton>
  );
}
