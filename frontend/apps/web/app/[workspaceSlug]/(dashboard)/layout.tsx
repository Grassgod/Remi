"use client";

import { useNavigation } from "@multiremi/views/navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { DashboardLayout } from "@multiremi/views/layout";
import { MultiremiIcon } from "@multiremi/ui/components/common/multimira-icon";
import { SearchCommand, SearchTrigger } from "@multiremi/views/search";
import { ChatFab, ChatWindow } from "@multiremi/views/chat";

export default function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useNavigation();
  const paths = useWorkspacePaths();
  const isChatPage = pathname === paths.chat();
  return (
    <DashboardLayout
      loadingIndicator={<MultiremiIcon className="size-6" />}
      searchSlot={<SearchTrigger />}
      extra={
        <>
          <SearchCommand />
          {!isChatPage && (
            <>
              <ChatWindow />
              <ChatFab />
            </>
          )}
        </>
      }
    >
      {children}
    </DashboardLayout>
  );
}
