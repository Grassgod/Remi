import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

interface HeaderProps {
  title: string;
  subtitle?: string;
  daemonAlive?: boolean;
  tokensValid?: number;
  tokensTotal?: number;
}

export function Header({ title, subtitle, daemonAlive, tokensValid, tokensTotal }: HeaderProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="flex h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-border bg-card/50 px-4 sm:gap-4 sm:px-6">
      <span className="text-sm font-semibold text-foreground">
        {title}
      </span>
      {subtitle && (
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {subtitle}
        </span>
      )}
      <div className="flex-1" />

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
      </div>
    </header>
  );
}
