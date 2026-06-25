"use client";

import { DashboardLayout } from "@multiremi/views/layout";
import { MultiremiIcon } from "@multiremi/ui/components/common/multimira-icon";
import { SearchCommand, SearchTrigger } from "@multiremi/views/search";
import { ChatFab, ChatWindow } from "@multiremi/views/chat";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardLayout
      loadingIndicator={<MultiremiIcon className="size-6" />}
      searchSlot={<SearchTrigger />}
      extra={
        <>
          <SearchCommand />
          <ChatWindow />
          <ChatFab />
        </>
      }
    >
      {children}
    </DashboardLayout>
  );
}
