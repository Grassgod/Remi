"use client";

import { DashboardLayout } from "@multimira/views/layout";
import { MultimiraIcon } from "@multimira/ui/components/common/multimira-icon";
import { SearchCommand, SearchTrigger } from "@multimira/views/search";
import { ChatFab, ChatWindow } from "@multimira/views/chat";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardLayout
      loadingIndicator={<MultimiraIcon className="size-6" />}
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
