"use client";

import { use } from "react";
import { ProjectDetail } from "@multiremi/views/projects/components";

export default function ProjectWikiPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ProjectDetail projectId={id} contentTab="wiki" />;
}
