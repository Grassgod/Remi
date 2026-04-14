import { type ReactNode, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { BottomNav } from "./BottomNav";
import { Header } from "./Header";
import { useAppStore } from "../stores/app";

interface LayoutProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Layout({ title, subtitle, actions, children }: LayoutProps) {
  const status = useAppStore(s => s.status);
  const fetchStatus = useAppStore(s => s.fetchStatus);

  // Fetch daemon status on mount so the indicator is correct on every page,
  // not only when Dashboard happens to be the landing page.
  useEffect(() => {
    if (!status) fetchStatus();
  }, [status, fetchStatus]);

  return (
    <div className="relative z-[1] flex h-dvh">
      <Sidebar daemonPid={status?.daemon.pid ?? null} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          subtitle={subtitle}
          actions={actions}
          daemonAlive={status?.daemon.alive}
          tokensValid={status?.tokens.valid}
          tokensTotal={status?.tokens.total}
        />
        <div className="main-content flex-1 overflow-y-auto p-5">
          {children}
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
