import { CheckCircle2, ChevronRight } from "lucide-react";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { Card } from "@multiremi/ui/components/ui/card";
import type { TimelineEntry } from "@multiremi/core/types";
import { useT } from "../../i18n";

interface ResolvedThreadBarProps {
  /** The resolved comment. */
  entry: TimelineEntry;
  onExpand: () => void;
}

// Collapsed form of a single resolved comment. The session timeline is flat —
// replies are entries of their own, so a resolved comment folds away on its
// own and never drags a subtree with it.
export function ResolvedThreadBar({ entry, onExpand }: ResolvedThreadBarProps) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();

  const count = 1;
  const authorsLabel = getActorName(entry.actor_type, entry.actor_id);

  return (
    <Card className="!py-0 !gap-0 overflow-hidden">
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        <span className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="truncate">
            {t(($) => $.comment.resolve.bar, { count, authors: authorsLabel })}
          </span>
        </span>
        <ChevronRight className="h-3.5 w-3.5 rotate-90 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}
