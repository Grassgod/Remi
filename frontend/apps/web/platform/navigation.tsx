"use client";

import { Suspense } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  NavigationProvider,
  type NavigationAdapter,
} from "@multiremi/views/navigation";

function NavigationProviderInner({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const adapter: NavigationAdapter = {
    push: router.push,
    replace: router.replace,
    // The App Router patches history.replaceState: a call whose state lacks
    // its own `__NA` marker keeps its route tree in the entry and updates
    // usePathname/useSearchParams without fetching the route. Passing the
    // current history.state would carry that marker and skip the update.
    replaceUrl: (path: string) => {
      window.history.replaceState(null, "", path);
    },
    back: router.back,
    pathname,
    searchParams: new URLSearchParams(searchParams.toString()),
    getShareableUrl: (path: string) =>
      typeof window === "undefined" ? path : window.location.origin + path,
    // router.prefetch is a no-op in dev mode by Next.js design; in production
    // it warms the RSC payload + route chunk so the next push() commits with
    // no network round-trip. Safe to call repeatedly — Next dedupes internally.
    prefetch: (path: string) => {
      router.prefetch(path);
    },
  };

  return <NavigationProvider value={adapter}>{children}</NavigationProvider>;
}

export function WebNavigationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense>
      <NavigationProviderInner>{children}</NavigationProviderInner>
    </Suspense>
  );
}
