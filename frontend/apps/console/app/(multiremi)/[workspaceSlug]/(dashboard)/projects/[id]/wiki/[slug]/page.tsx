"use client";

import { use } from "react";
import { ProjectDetail } from "@multiremi/views/projects/components";

// Agent-written slugs are often non-ASCII, and Next has not been consistent
// about whether a route param arrives already decoded. Decoding an
// already-decoded value throws on a lone `%`, so a failed decode falls back to
// the raw param rather than blanking the page.
function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function ProjectWikiSlugPage({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id, slug } = use(params);
  return (
    <ProjectDetail projectId={id} contentTab="wiki" wikiSlug={decodeSlug(slug)} />
  );
}
