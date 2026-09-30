"use client";

import { createContext, use, type ReactNode } from "react";
import type { User } from "../types";
import { useAuthStore } from "../auth";

const SSRUserContext = createContext<User | null>(null);

export function SSRWorkspaceProvider({ user, children }: { user: User | null; children: ReactNode }) {
  return <SSRUserContext.Provider value={user}>{children}</SSRUserContext.Provider>;
}

/** The seed supplies presentation only while Bearer auth is being confirmed. */
export function useSSRUser() {
  const seed = use(SSRUserContext);
  const user = useAuthStore(s => s.user);
  const pending = useAuthStore(s => s.isLoading);
  return { user: pending ? seed ?? user : user, isLoading: pending && !seed };
}
