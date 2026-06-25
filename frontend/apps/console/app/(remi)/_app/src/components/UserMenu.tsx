import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../stores/auth";
import { LogOut, User as UserIcon } from "lucide-react";
import { cn } from "~remiadmin/lib/utils";

export function UserMenu() {
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  if (!user) return null;

  const display = user.nickname || user.name || user.username;
  const initial = (display || user.username).slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
        title={user.email}
      >
        <div className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-xs font-medium text-primary">
          {user.picture ? (
            <img
              src={user.picture}
              alt={display}
              className="h-full w-full object-cover"
            />
          ) : (
            initial
          )}
        </div>
        <span className="hidden text-xs font-medium md:inline">{display}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-sm font-medium text-primary">
                {user.picture ? (
                  <img
                    src={user.picture}
                    alt={display}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  initial
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{display}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {user.email}
                </div>
              </div>
            </div>
            {user.tenantAlias && (
              <div className="mt-2 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                <UserIcon className="h-2.5 w-2.5" />
                {user.tenantAlias}
              </div>
            )}
          </div>
          <button
            onClick={logout}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent",
            )}
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
