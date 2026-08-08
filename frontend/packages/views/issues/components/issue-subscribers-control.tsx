"use client";

import { Users } from "lucide-react";
import { Popover, PopoverTrigger } from "@multiremi/ui/components/ui/popover";
import { AvatarGroup, AvatarGroupCount } from "@multiremi/ui/components/ui/avatar";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import { useIssueSubscribers } from "../hooks/use-issue-subscribers";
import { SubscriberPopoverContent } from "./subscriber-popover-content";

/**
 * Subscribe toggle + subscriber avatars for the activity header. Owns the
 * subscription query so nothing above it has to thread four callbacks down.
 */
export function IssueSubscribersControl({
  issueId,
  currentUserId,
  members,
  agents,
}: {
  issueId: string;
  currentUserId?: string;
  members: { user_id: string; name: string }[];
  agents: { id: string; name: string; archived_at?: string | null }[];
}) {
  const { t } = useT("issues");
  const { subscribers, isSubscribed, toggleSubscribe, toggleSubscriber } =
    useIssueSubscribers(issueId, currentUserId);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggleSubscribe}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {isSubscribed ? t(($) => $.detail.unsubscribe) : t(($) => $.detail.subscribe)}
      </button>
      <Popover>
        <PopoverTrigger className="cursor-pointer hover:opacity-80 transition-opacity">
          {subscribers.length > 0 ? (
            <AvatarGroup>
              {subscribers.slice(0, 4).map((sub) => (
                <ActorAvatar
                  key={`${sub.user_type}-${sub.user_id}`}
                  actorType={sub.user_type}
                  actorId={sub.user_id}
                  size={24}
                  enableHoverCard
                />
              ))}
              {subscribers.length > 4 && (
                <AvatarGroupCount>+{subscribers.length - 4}</AvatarGroupCount>
              )}
            </AvatarGroup>
          ) : (
            <span className="flex items-center justify-center h-6 w-6 rounded-full border border-dashed border-muted-foreground/30 text-muted-foreground">
              <Users className="h-3 w-3" />
            </span>
          )}
        </PopoverTrigger>
        <SubscriberPopoverContent
          members={members}
          agents={agents}
          subscribers={subscribers}
          toggleSubscriber={toggleSubscriber}
          t={t}
        />
      </Popover>
    </div>
  );
}
