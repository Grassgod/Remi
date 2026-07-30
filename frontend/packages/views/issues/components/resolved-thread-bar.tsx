import { CheckCircle2, ChevronRight } from "lucide-react";
import { useActorName } from "@multiremi/core/workspace/hooks";
import type { TimelineEntry } from "@multiremi/core/types";
import { useT } from "../../i18n";

interface ResolvedThreadBarProps {
  /** The resolved comment. */
  entry: TimelineEntry;
  onExpand: () => void;
}

// Collapsed form of a single resolved comment. The session timeline is flat —
// replies are entries of their own, so a resolved comment folds away on its
// own and never drags a subtree with it. Card-less, like the message rows it
// sits between: a boxed row among unboxed ones read as a different kind of
// thing rather than as a folded one.
export function ResolvedThreadBar({ entry, onExpand }: ResolvedThreadBarProps) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();

  const count = 1;
  const authorsLabel = getActorName(entry.actor_type, entry.actor_id);

  return (
    <button
      type="button"
      onClick={onExpand}
      className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/30"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {t(($) => $.comment.resolve.bar, { count, authors: authorsLabel })}
        </span>
      </span>
      <ChevronRight className="h-3.5 w-3.5 rotate-90 shrink-0 text-muted-foreground" />
    </button>
  );
}
