"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { BrowserReplicaEnv } from "../replica/browser";

const ReplicaEnvContext = createContext<BrowserReplicaEnv>({});
export function ReplicaEnvProvider({ env, children }: { env: BrowserReplicaEnv; children: ReactNode }) {
  return <ReplicaEnvContext.Provider value={env}>{children}</ReplicaEnvContext.Provider>;
}
export function useReplicaEnv(): BrowserReplicaEnv { return useContext(ReplicaEnvContext); }
