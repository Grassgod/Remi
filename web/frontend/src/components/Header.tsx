import { useEffect, useState } from "react";

interface HeaderProps {
  title: string;
  subtitle?: string;
  daemonAlive?: boolean;
  tokensValid?: number;
  tokensTotal?: number;
}

export function Header({ title, subtitle, daemonAlive, tokensValid, tokensTotal }: HeaderProps) {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      setClock(
        `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())} — ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="flex h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3 sm:gap-4 sm:px-6">
      <span className="text-sm font-semibold tracking-wide text-foreground">
        {title}
      </span>
      {subtitle && (
        <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
          / {subtitle}
        </span>
      )}
      <div className="flex-1" />
      <span className="hidden font-mono text-xs tracking-wider text-muted-foreground sm:inline">
        {clock}
      </span>
      <div className="flex items-center gap-1.5">
        <div
          className={`h-2 w-2 rounded-full ${daemonAlive ? "bg-success" : "bg-destructive"}`}
          title="Daemon"
        />
        {tokensTotal !== undefined && Array.from({ length: tokensTotal }).map((_, i) => (
          <div
            key={i}
            className={`h-2 w-2 rounded-full ${i < (tokensValid ?? 0) ? "bg-success" : "bg-warning"}`}
            title={`Token ${i + 1}`}
          />
        ))}
      </div>
    </header>
  );
}
