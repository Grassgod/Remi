import { cookies } from "next/headers";
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { workspaceKeys } from "@multiremi/core/workspace/queries";
import { SSRWorkspaceProvider } from "@multiremi/core/platform/ssr-workspace";
import { parseShellPreferences, ShellPreferencesProvider } from "@multiremi/views/layout";
import { readSSRWorkspace } from "../../features/issues/server-log";
import WorkspaceLayoutClient from "./layout-client";

export default async function WorkspaceLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const [initial, cookieStore] = await Promise.all([readSSRWorkspace(workspaceSlug), cookies()]);
  // The nav and the Chat list render as the user left them, with no jump after hydration.
  const shell = parseShellPreferences((name) => cookieStore.get(name)?.value);
  const queries = new QueryClient();
  if (initial) queries.setQueryData(workspaceKeys.list(), initial.workspaces);
  return (
    <HydrationBoundary state={dehydrate(queries)}>
      <SSRWorkspaceProvider user={initial?.user ?? null}>
        <ShellPreferencesProvider initial={shell}>
          <WorkspaceLayoutClient params={params}>{children}</WorkspaceLayoutClient>
        </ShellPreferencesProvider>
      </SSRWorkspaceProvider>
    </HydrationBoundary>
  );
}
