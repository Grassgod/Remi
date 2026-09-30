import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { SSRWorkspaceProvider } from "@multiremi/core/platform/ssr-workspace";
import { readSSRWorkspace } from "../../features/issues/server-log";
import WorkspaceLayoutClient from "./layout-client";

export default async function WorkspaceLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const initial = await readSSRWorkspace(workspaceSlug);
  const queries = new QueryClient();
  if (initial) queries.setQueryData(workspaceKeys.list(), initial.workspaces);
  return (
    <HydrationBoundary state={dehydrate(queries)}>
      <SSRWorkspaceProvider user={initial?.user ?? null}>
        <WorkspaceLayoutClient params={params}>{children}</WorkspaceLayoutClient>
      </SSRWorkspaceProvider>
    </HydrationBoundary>
  );
}
