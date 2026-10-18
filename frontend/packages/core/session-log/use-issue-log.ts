"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StreamSubscription } from "../api/ws-client";
import type { IssueLogBootstrap } from "../api/schemas/session-log";
import { useWorkspaceId } from "../hooks";
import { useAuthStore } from "../auth";
import { useWS } from "../realtime";
import { useReplicaEnv } from "../platform/replica-env";
import { pendingChatTasksOptions } from "../chat/queries";
import { IssueLogReplica } from "./issue-log";
import { chatLogPool, chatLogScope } from "./chat-log-pool";

/** One log per mount: Issue detail and its activity section. */
export function useIssueLog(sessionId: string, initial?: IssueLogBootstrap, commentId?: string, preferCached = false, enabled = true, withActivity = false) {
  const replica = useMemo(() => new IssueLogReplica(sessionId, initial, preferCached, withActivity), [sessionId, initial, preferCached, withActivity]);
  const snapshot = useLogSnapshot(replica, sessionId);
  const [error, setError] = useState(false);

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

  useLiveLog(replica, sessionId, enabled, setError);
  return { replica, snapshot, error };
}

/**
 * Chat's log, leased from the Chat log pool while the chat is shown.
 *
 * A chat shown again paints its retained rows at once, then refreshes the tail
 * in the background and reconnects; the first visit reads the tail as
 * `useIssueLog` does. `initial` seeds only a chat the pool does not hold. The
 * seq-0 head row is never read: Chat does not display it.
 */
export function useChatLog(sessionId: string, initial?: IssueLogBootstrap, enabled = true) {
  const userId = useAuthStore(s => s.user?.id);
  const workspaceId = useWorkspaceId();
  const scope = chatLogScope(userId, workspaceId);
  const pooled = useSyncExternalStore(chatLogPool.subscribe,
    () => (scope && sessionId ? chatLogPool.peek(scope, sessionId) : undefined), () => undefined);
  const key = `${scope ?? ""}\u0000${sessionId}`;
  // A log has one connection: when another window leases this chat's log, this
  // one shows the chat through a log of its own, as before the pool.
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const shared = privateKey === key ? undefined : pooled;
  const replica = useMemo(() => shared ?? new IssueLogReplica(sessionId, initial, true, false, false),
    // A new identity never reuses a log read under the previous one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shared, scope, sessionId, initial]);
  const snapshot = useLogSnapshot(replica, sessionId);
  const [error, setError] = useState(false);
  const blocked = useRef(false);
  const { data: pending } = useQuery({ ...pendingChatTasksOptions(workspaceId), enabled: false });

  useEffect(() => { chatLogPool.setScope(scope); }, [scope]);
  // Chats with a running turn, from the cache the sidebar and the launcher keep
  // current; never fetched here.
  useEffect(() => {
    const running = new Set((pending?.tasks ?? []).map(task => task.chat_session_id));
    chatLogPool.setBusy(id => running.has(id));
  }, [pending]);
  useEffect(() => () => chatLogPool.setBusy(null), []);

  useEffect(() => {
    blocked.current = false;
    if (!sessionId || !enabled) return;
    let active = true;
    setError(false);
    const fail = () => { if (active) setError(true); };
    const lease = scope ? chatLogPool.acquire(scope, sessionId, replica) : null;
    if (scope && !lease && chatLogPool.peek(scope, sessionId) === replica) {
      blocked.current = true;
      setPrivateKey(key);
      return () => { active = false; };
    }
    if (lease?.retained && replica.window) void replica.resume().catch(fail);
    else if (!replica.hasWindowFor()) void replica.loadTail().catch(fail);
    return () => { active = false; lease?.release(); };
  }, [replica, scope, key, sessionId, enabled]);

  useLiveLog(replica, sessionId, enabled, setError, blocked);
  return { replica, snapshot, error };
}

function useLogSnapshot(replica: IssueLogReplica, sessionId: string) {
  return useSyncExternalStore(
    listener => replica.subscribe(sessionId, listener),
    () => replica.getSnapshot(sessionId), () => replica.getSnapshot(sessionId),
  );
}

/** The replica's connection and the page's `log:` stream while the log is shown. */
function useLiveLog(replica: IssueLogReplica, sessionId: string, enabled: boolean,
  setError: (error: boolean) => void, blocked?: RefObject<boolean>) {
  const { subscribeStream, onReconnect } = useWS();
  const userId = useAuthStore(s => s.user?.id);
  const workspaceId = useWorkspaceId();
  const env = useReplicaEnv();
  const qc = useQueryClient();

  useEffect(() => {
    if (!sessionId || !enabled || !userId || !workspaceId || blocked?.current) return;
    const subscriptions = new Map<string, StreamSubscription>();
    let active = true;
    let disconnect: (() => void) | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSurfaces = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (!active) return;
        void qc.invalidateQueries({ queryKey: ["inbox", workspaceId] });
        void qc.invalidateQueries({ queryKey: ["message-detail", workspaceId] });
        void qc.invalidateQueries({ queryKey: ["turns", workspaceId] });
        void qc.invalidateQueries({ queryKey: ["issues", workspaceId, "decisions"] });
        void qc.invalidateQueries({ queryKey: ["decision-replies", workspaceId] });
      }, 100);
    };
    void replica.connect({ userId, workspaceId, env,
      // As the replica's leader this page also subscribes for the sessions other
      // tabs and logs show; `id` is not necessarily this page's session.
      subscribe: (id, fromSeq) => {
        subscriptions.get(id)?.unsubscribe();
        const failed = () => { if (id === sessionId) setError(true); };
        const subscription = subscribeStream("log", id, {
          onFrames: frames => { void replica.hydratedFrames(id, frames).then(refreshSurfaces).catch(failed); },
          onAck: ack => replica.ack(id, ack),
          onGap: gap => {
            void (id === sessionId ? replica.refreshVisible() : replica.backfill(id, { from: gap.from, to: gap.to })).catch(failed);
          },
        }, { fromSeq });
        if (subscription) subscriptions.set(id, subscription);
      },
      unsubscribe: id => { subscriptions.get(id)?.unsubscribe(); subscriptions.delete(id); },
    }).then(cleanup => { if (active) disconnect = cleanup; else cleanup(); }).catch(() => { if (active) setError(true); });
    const offReconnect = onReconnect(() => { void replica.refreshVisible().catch(() => setError(true)); });
    return () => { active = false; if (refreshTimer) clearTimeout(refreshTimer); offReconnect(); disconnect?.(); replica.disconnect(); for (const s of subscriptions.values()) s.unsubscribe(); };
  }, [replica, sessionId, enabled, userId, workspaceId, subscribeStream, onReconnect, env, qc, setError, blocked]);
}
