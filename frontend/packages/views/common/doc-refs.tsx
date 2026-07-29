"use client";

import { ArrowUpRight } from "lucide-react";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { cn } from "@multiremi/ui/lib/utils";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { ProjectDocRef } from "@multiremi/core/types";
import { AppLink } from "../navigation";

// The sources an agent cited on a piece of content it wrote. Shared by the
// project knowledge base (wiki pages / memory entries) and published Session
// results — both carry the same open `{type, value}` shape, so both render the
// same badge row.

const EXTERNAL_HREF_RE = /^https?:\/\//i;

// A ref that navigates and a ref that is only data must not look identical —
// otherwise every badge reads as a dead end (or as a broken link). The linked
// variant carries an arrow glyph plus a hover state; the inert one carries
// neither. `title` restores the full value for the truncated ones.
function DocRefBadge({ docRef }: { docRef: ProjectDocRef }) {
  const paths = useWorkspacePaths();
  const badge = (linked: boolean) => (
    <Badge
      variant="outline"
      title={docRef.value}
      className={cn(
        "max-w-64 font-normal",
        linked && "transition-colors hover:bg-accent hover:text-foreground",
      )}
    >
      <span className="text-muted-foreground">{docRef.type}</span>
      <span className="truncate">{docRef.value}</span>
      {linked && <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
    </Badge>
  );

  if (docRef.type === "issue") {
    return <AppLink href={paths.issueDetail(docRef.value)}>{badge(true)}</AppLink>;
  }
  // The protocol check is not cosmetic: `value` is whatever an agent wrote,
  // and a `javascript:` href would execute on click.
  if (docRef.type === "url" && EXTERNAL_HREF_RE.test(docRef.value)) {
    return (
      <a href={docRef.value} target="_blank" rel="noopener noreferrer">
        {badge(true)}
      </a>
    );
  }
  // Everything else stays plain text: a task has no page of its own, and an
  // unknown ref type is data we can show but not resolve into a URL.
  return badge(false);
}

export function DocRefs({
  refs,
  className,
}: {
  refs: ProjectDocRef[];
  className?: string;
}) {
  if (refs.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {refs.map((docRef, index) => (
        <DocRefBadge
          key={`${docRef.type}:${docRef.value}:${index}`}
          docRef={docRef}
        />
      ))}
    </div>
  );
}
