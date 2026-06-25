import type { ReactNode } from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme } from "~remiadmin/hooks/useTheme";
import { Button } from "./ui/button";
import { cn } from "~remiadmin/lib/utils";
import { UserMenu } from "./UserMenu";

interface HeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  daemonAlive?: boolean;
  tokensValid?: number;
  tokensTotal?: number;
}

export function Header({ title, subtitle, actions, daemonAlive, tokensValid, tokensTotal }: HeaderProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="flex min-h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-border bg-card/50 px-4 py-2 sm:gap-4 sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground shrink-0">{title}</span>
          {subtitle && (
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          )}
        </div>
        {/* Second row: page-specific actions */}
        {actions && <div className="mt-0.5">{actions}</div>}
      </div>

      {/* Status indicators */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <div
            className={cn("h-2 w-2 rounded-full", daemonAlive ? "bg-success" : "bg-destructive")}
            title="Daemon"
          />
          {tokensTotal !== undefined && (
            <span className="text-[10px] text-muted-foreground">
              {tokensValid ?? 0}/{tokensTotal} tokens
            </span>
          )}
        </div>

        {/* Theme toggle */}
        <Button variant="ghost" size="icon" onClick={toggleTheme} className="h-8 w-8">
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>

        {/* User menu (visible when signed in via SSO) */}
        <UserMenu />
      </div>
    </header>
  );
}
