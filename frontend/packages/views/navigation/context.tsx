"use client";

import { createContext, use, useEffect, useMemo, useTransition } from "react";
import type { NavigationAdapter } from "./types";

const NavigationContext = createContext<NavigationAdapter | null>(null);
const NavigationPendingContext = createContext<boolean>(false);

export function NavigationProvider({
  value,
  children,
}: {
  value: NavigationAdapter;
  children: React.ReactNode;
}) {
  // Wrap push/replace in startTransition so any caller of useNavigation()
  // (sidebar AppLink, command palette, modal post-create jumps) gets a
  // React pending signal during route commit. On web this stays true until
  // Next.js commits the new RSC payload; on desktop it flips off quickly
  // because react-router commits synchronously — both are correct.
  const [isPending, startTransition] = useTransition();
  const wrapped = useMemo<NavigationAdapter>(
    () => ({
      ...value,
      push: (path: string) => startTransition(() => value.push(path)),
      replace: (path: string) => startTransition(() => value.replace(path)),
    }),
    [value],
  );
  // Counterpart of openLink's dispatch in editor/utils/link-handler.ts:
  // internal-path links inside rendered markdown (readonly content, editor,
  // link hover cards) navigate by dispatching "multimira:navigate" instead of
  // importing a router. If a platform shell (e.g. a future desktop app) ships
  // its own listener, it must NOT also mount this provider's listener or every
  // link click would navigate twice.
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path === "string" && path) wrapped.push(path);
    };
    window.addEventListener("multimira:navigate", onNavigate);
    return () => window.removeEventListener("multimira:navigate", onNavigate);
  }, [wrapped]);

  return (
    <NavigationContext.Provider value={wrapped}>
      <NavigationPendingContext.Provider value={isPending}>
        {children}
      </NavigationPendingContext.Provider>
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationAdapter {
  const ctx = use(NavigationContext);
  if (!ctx)
    throw new Error("useNavigation must be used within NavigationProvider");
  return ctx;
}

/** True while a transition-wrapped push/replace is committing. */
export function useIsNavigating(): boolean {
  return use(NavigationPendingContext);
}
