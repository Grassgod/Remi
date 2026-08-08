"use client";

import { useTimeAgo } from "../../i18n";
import { PropRow } from "../../common/prop-row";
import { ActorAvatar } from "../../common/actor-avatar";
import type { Squad } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { SquadAvatarEditor } from "./inspector/squad-avatar-editor";
import { SquadNameEditor } from "./inspector/squad-name-editor";
import { SquadDescriptionEditor } from "./inspector/squad-description-editor";

// ---------------------------------------------------------------------------
// SquadDetailInspector — left 320px column, mirrors AgentDetailInspector.
// Holds identity (avatar / name / description) + leader / member count /
// timestamps. All inline-editable.
// ---------------------------------------------------------------------------
export function SquadDetailInspector({
  squad,
  memberCount,
  leaderName,
  creatorName,
  uploadingAvatar,
  onUploadAvatar,
  onRename,
  onUpdateDescription,
}: {
  squad: Squad;
  memberCount: number;
  leaderName: string;
  creatorName: string;
  uploadingAvatar: boolean;
  onUploadAvatar: (url: string) => Promise<unknown>;
  onRename: (next: string) => Promise<void>;
  onUpdateDescription: (next: string) => Promise<void>;
}) {
  const { t } = useT("squads");
  const timeAgo = useTimeAgo();
  const initials = squad.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <aside className="flex w-full flex-col rounded-lg border bg-background md:h-full md:min-h-0 md:overflow-y-auto">
      {/* Identity */}
      <div className="flex flex-col gap-3 border-b px-5 pb-5 pt-5">
        <SquadAvatarEditor
          squad={squad}
          initials={initials}
          uploading={uploadingAvatar}
          onUpload={onUploadAvatar}
        />
        <div className="flex flex-col gap-1">
          <SquadNameEditor value={squad.name} onSave={onRename} />
          <SquadDescriptionEditor
            value={squad.description ?? ""}
            onSave={onUpdateDescription}
          />
        </div>
      </div>

      {/* Details — read-only */}
      <div className="border-b px-5 py-4">
        <div className="mb-1 -mx-2 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t(($) => $.inspector.details_section)}
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <PropRow interactive={false} label="Leader">
            <span className="flex min-w-0 items-center gap-1.5">
              <ActorAvatar actorType="agent" actorId={squad.leader_id} size={14} />
              <span className="truncate">{leaderName}</span>
            </span>
          </PropRow>
          <PropRow interactive={false} label="Members">
            <span className="text-muted-foreground tabular-nums">{memberCount}</span>
          </PropRow>
          <PropRow interactive={false} label="Created by">
            <span className="flex min-w-0 items-center gap-1.5">
              <ActorAvatar actorType="member" actorId={squad.creator_id} size={14} />
              <span className="truncate">{creatorName}</span>
            </span>
          </PropRow>
          <PropRow interactive={false} label="Created">
            <span className="text-muted-foreground">{timeAgo(squad.created_at)}</span>
          </PropRow>
          <PropRow interactive={false} label="Updated">
            <span className="text-muted-foreground">{timeAgo(squad.updated_at)}</span>
          </PropRow>
        </div>
      </div>
    </aside>
  );
}
