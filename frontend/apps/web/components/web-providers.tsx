"use client";

import { Suspense, useMemo } from "react";
import { CoreProvider } from "@multiremi/core/platform";
import { api } from "@multiremi/core/api";
import { createBrowserCookieLocaleAdapter } from "@multiremi/core/i18n/browser";
import type { LocaleResources, SupportedLocale } from "@multiremi/core/i18n";
import packageJson from "../package.json";
import { WebNavigationProvider } from "@/platform/navigation";
import {
  setLoggedInCookie,
  clearLoggedInCookie,
} from "@/features/auth/auth-cookie";
import { PageviewTracker } from "./pageview-tracker";

// Derive WebSocket URL from the page origin so self-hosted / LAN deployments
// work without explicit NEXT_PUBLIC_WS_URL.  The Next.js rewrite rule
// (/ws → backend) handles proxying.
function deriveWsUrl(): string | undefined {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  if (typeof window === "undefined") return undefined;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

// Build-time version preferred (CI sets NEXT_PUBLIC_APP_VERSION to a git tag
// or sha so different deploys are distinguishable in server logs); fall back
// to the package.json version so local dev still reports something useful.
const WEB_VERSION =
  process.env.NEXT_PUBLIC_APP_VERSION || packageJson.version || "dev";

export function WebProviders({
  children,
  locale,
  resources,
}: {
  children: React.ReactNode;
  locale: SupportedLocale;
  resources: Record<string, LocaleResources>;
}) {
  // Keep bearer-token authentication for token-based login. Password login also
  // establishes an HttpOnly browser session, which the Web logout hook clears.
  const cookieAuth = false;
  // Stable identity reference so downstream effects keyed on it don't see a
  // new object on every parent render.
  const identity = useMemo(
    () => ({ platform: "web", version: WEB_VERSION }),
    [],
  );
  const localeAdapter = useMemo(() => createBrowserCookieLocaleAdapter(), []);
  return (
    <CoreProvider
      apiBaseUrl={process.env.NEXT_PUBLIC_API_URL}
      wsUrl={deriveWsUrl()}
      cookieAuth={cookieAuth}
      onLogin={setLoggedInCookie}
      onLogout={() => {
        clearLoggedInCookie();
        // The token-mode store has already cleared its bearer token. Include
        // browser cookies so the server revokes this session and expires the
        // HttpOnly cookie; native token-only clients keep their existing flow.
        void api.logout().catch(() => {});
      }}
      identity={identity}
      locale={locale}
      resources={resources}
      localeAdapter={localeAdapter}
    >
      {/* Suspense boundary is required by Next.js for useSearchParams in
          a client component mounted this high in the tree. */}
      <Suspense fallback={null}>
        <PageviewTracker />
      </Suspense>
      <WebNavigationProvider>{children}</WebNavigationProvider>
    </CoreProvider>
  );
}
