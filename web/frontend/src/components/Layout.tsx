import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { BottomNav } from "./BottomNav";
import { Header } from "./Header";
import { useAppStore } from "../stores/app";

interface LayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

export function Layout({ title, subtitle, children }: LayoutProps) {
  const status = useAppStore(s => s.status);

  return (
    <div className="relative z-[1] flex h-dvh">
      <Sidebar daemonPid={status?.daemon.pid ?? null} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          title={title}
          subtitle={subtitle}
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
