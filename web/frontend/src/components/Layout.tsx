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
    <div style={{
      display: "flex", height: "100dvh",
      position: "relative", zIndex: 1,
    }}>
      <Sidebar daemonPid={status?.daemon.pid ?? null} />
      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        minWidth: 0, overflow: "hidden",
      }}>
        <Header
          title={title}
          subtitle={subtitle}
          daemonAlive={status?.daemon.alive}
          tokensValid={status?.tokens.valid}
          tokensTotal={status?.tokens.total}
        />
        <div style={{
          flex: 1, overflowY: "auto", padding: 20,
        }} className="main-content">
          {children}
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
