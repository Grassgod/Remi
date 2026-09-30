"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { StreamSubscription } from "../api/ws-client";
import type { IssueLogBootstrap } from "../api/schemas/session-log";
import { useWorkspaceId } from "../hooks";
import { useAuthStore } from "../auth";
import { useWS } from "../realtime";
import { useReplicaEnv } from "../platform/replica-env";
import { IssueLogReplica } from "./issue-log";

export function useIssueLog(sessionId: string, initial?: IssueLogBootstrap, commentId?: string, preferCached = false, enabled = true) {
  const replica = useMemo(() => new IssueLogReplica(sessionId, initial, preferCached), [sessionId, initial, preferCached]);
  const snapshot = useSyncExternalStore(
    listener => replica.subscribe(sessionId, listener),
    () => replica.getSnapshot(sessionId), () => replica.getSnapshot(sessionId),
  );
  const [error, setError] = useState(false);
  const { subscribeStream, onReconnect } = useWS();
  const userId = useAuthStore(s => s.user?.id);
  const workspaceId = useWorkspaceId();
  const env = useReplicaEnv();

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let active = true;
    setError(false);
    if (!replica.hasWindowFor(commentId)) {
      const load = commentId ? replica.loadAround(commentId) : replica.loadTail();
      void load.catch(() => { if (active) setError(true); });
    }
    return () => { active = false; };
  }, [replica, sessionId, initial, commentId, enabled]);

  useEffect(() => {
    if (!sessionId || !enabled || !userId || !workspaceId) return;
    const subscriptions = new Map<string, StreamSubscription>();
    let active = true;
    let disconnect: (() => void) | undefined;
    void replica.connect({ userId, workspaceId, env,
      subscribe: (id, fromSeq) => {
        subscriptions.get(id)?.unsubscribe();
        const subscription = subscribeStream("log", id, {
          onFrames: frames => { void replica.hydratedFrames(id, frames).catch(() => setError(true)); },
          onAck: ack => replica.ack(id, ack),
          onGap: () => { void replica.refreshVisible().catch(() => setError(true)); },
        }, { fromSeq });
        if (subscription) subscriptions.set(id, subscription);
      },
      unsubscribe: id => { subscriptions.get(id)?.unsubscribe(); subscriptions.delete(id); },
    }).then(cleanup => { if (active) disconnect = cleanup; else cleanup(); }).catch(() => { if (active) setError(true); });
    const offReconnect = onReconnect(() => { void replica.refreshVisible().catch(() => setError(true)); });
    return () => { active = false; offReconnect(); disconnect?.(); replica.disconnect(); for (const s of subscriptions.values()) s.unsubscribe(); };
  }, [replica, sessionId, enabled, userId, workspaceId, subscribeStream, onReconnect, env]);
  return { replica, snapshot, error };
}
