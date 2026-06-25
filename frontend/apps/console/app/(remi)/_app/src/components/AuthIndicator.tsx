import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";
import { useAuthStore } from "../stores/auth";
import { UserMenu } from "./UserMenu";
import { listSsoProviders, ssoLoginUrl, type SsoProviderInfo } from "../api/client";

/**
 * Top-right auth widget for the public Board/Home SPA.
 *   - signed in            → <UserMenu/> (avatar + sign-out)
 *   - SSO active, no login  → "Sign in" button (returns to current path)
 *   - SSO not configured    → nothing (open mode)
 */
export function AuthIndicator() {
  const { user, ssoConfigured, initialized, fetchMe } = useAuthStore();
  const [providers, setProviders] = useState<SsoProviderInfo[]>([]);

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (initialized && ssoConfigured && !user) {
      listSsoProviders().then(setProviders).catch(() => {});
    }
  }, [initialized, ssoConfigured, user]);

  if (!initialized || !ssoConfigured) return null;
  if (user) return <UserMenu />;
  if (providers.length === 0) return null;

  const login = () => {
    const next = window.location.pathname + window.location.search;
    window.location.href = ssoLoginUrl(providers[0].id, next);
  };

  return (
    <button
      onClick={login}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
    >
      <LogIn className="h-3.5 w-3.5" />
      Sign in
    </button>
  );
}
