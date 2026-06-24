import { useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "../stores/auth";

function AuthLoading() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading…</div>
    </div>
  );
}

export interface AuthGateProps {
  children: ReactNode;
  /** Paths that are viewable without a login (relative to the active Router). */
  isPublic?: (path: string) => boolean;
  /** Rendered when SSO is active and the user is not logged in on a gated path. */
  renderUnauthenticated: (currentPath: string) => ReactNode;
}

/**
 * Shared auth guard for both SPAs (Dashboard hash-router and Board path-router).
 * Uses wouter's `useLocation`, so it reads the location from whichever Router
 * it is mounted under — no assumption about hash vs path routing.
 *
 * Open mode (no SSO provider enabled) passes everything through unchanged.
 */
export function AuthGate({ children, isPublic, renderUnauthenticated }: AuthGateProps) {
  const { user, ssoConfigured, initialized, loading, fetchMe } = useAuthStore();
  const [location] = useLocation();

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  if (!initialized || loading) return <AuthLoading />;
  if (!ssoConfigured) return <>{children}</>;
  if (isPublic?.(location)) return <>{children}</>;
  if (!user) return <>{renderUnauthenticated(location)}</>;
  return <>{children}</>;
}
