"use client";

import { use } from "react";
import { RepositoryWikiPage } from "@multiremi/views/repositories";

export default function Page({
  params,
}: {
  params: Promise<{ id: string; path?: string[] }>;
}) {
  const { id, path } = use(params);
  return <RepositoryWikiPage repositoryId={id} wikiPath={path?.join("/") ?? null} />;
}
