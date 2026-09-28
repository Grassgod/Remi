/**
 * The replica fixture page (MUL-403 C7 acceptance).
 *
 * A page with a real Web Locks API, a real DedicatedWorker, real OPFS and a real
 * WebSocket, driven by `replica-playwright-check.ts`. It exists because the
 * acceptance criteria are about *this browser*: three tabs sharing one
 * subscription, a leader that dies and is replaced, an offline tab that catches
 * up, and the same suite again with OPFS switched off.
 *
 * The socket here is C3's frame protocol mocked against C0's contract
 * (`packages/contracts/src/live-hub.ts`) — C3 has not merged into
 * `agent/MUL-403` yet, and the plan says to mock its frames until it does. The
 * replica under test is the real one: `frontend/packages/core/replica/`, the same
 * modules the app will use.
 *
 * The page exposes `window.__replica` for assertions; nothing here is user-facing
 * code and it is not imported by the app.
 */
import { openBrowserReplica, type BrowserReplica } from "../../../frontend/packages/core/replica/browser";
import { resolveReadRange } from "./read-range";

interface FixtureConfig {
  userId: string;
  workspaceId: string;
  tabId: string;
  sessionId: string;
  /** Same-origin WebSocket path the mock server serves. */
  wsUrl: string;
  /** `off` forces the no-OPFS path. */
  opfs: "on" | "off";
}

function config(): FixtureConfig {
  const params = new URLSearchParams(window.location.search);
  return {
    userId: params.get("userId") ?? "user_1",
    workspaceId: params.get("workspaceId") ?? "ws_1",
    tabId: params.get("tabId") ?? "tab_1",
    sessionId: params.get("sessionId") ?? "sess_1",
    wsUrl: params.get("wsUrl") ?? "/ws",
    opfs: params.get("opfs") === "off" ? "off" : "on",
  };
}

/**
 * The minimal C3 client the fixture needs: subscribe, unsubscribe, forward frames.
 *
 * It reconnects on close with a fixed short backoff, because the offline
 * catch-up criterion is precisely about a socket that dropped and came back:
 * the replica resumes from its stored head, so what the tab sends after the drop
 * is the assertion, not the reconnect itself.
 */
class FixtureSocket {
  private socket: WebSocket | null = null;
  private readonly frameListeners = new Set<(sessionId: string, frames: never[]) => void>();
  private readonly ackListeners = new Set<(sessionId: string, ack: never) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  /** Subscriptions the leader currently holds, replayed verbatim on reconnect. */
  private readonly active = new Map<string, number>();
  /** Every subscribe this page sent, so the check can count them per page. */
  readonly sent: Array<{ type: string; sessionId: string; fromSeq?: number; at: number }> = [];
  /** Reconnect attempts, so the check can wait for "the socket came back". */
  reconnects = 0;
  /**
   * Who re-subscribes after a reconnect.
   *
   * The socket must not pick the cursor itself: only the replica knows the head
   * it has reached, and choosing here would make the catch-up test assert the
   * fixture's arithmetic instead of the replica's behaviour.
   */
  onReconnectSession: ((sessionId: string) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    const socket = new WebSocket(new URL(this.url, window.location.origin).toString());
    this.socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        payload?: Record<string, unknown>;
      };
      // The handshake is C0's: `auth` upward, `auth_ack` downward. The fixture
      // sends no token because the mock accepts any connection, and the real
      // client's token handling is C3's, not this file's.
      if (message.type === "auth_ack") {
        this.flush();
        // On a reconnect the server has forgotten every subscription, so the
        // active set is replayed — but from the *replica's* cursor, not from the
        // one recorded at subscribe time. That is the plan's catch-up path
        // (`from_seq` comes from the database), and it is why the check asserts
        // `head + 1` rather than "a reconnect happened".
        for (const sessionId of [...this.active.keys()]) {
          this.onReconnectSession?.(sessionId);
        }
        return;
      }
      const payload = message.payload ?? {};
      const sessionId = typeof payload.id === "string" ? payload.id : "";
      if (message.type === "stream.ack") {
        for (const listener of [...this.ackListeners]) listener(sessionId, payload as never);
        return;
      }
      if (message.type === "stream.data") {
        const frames = Array.isArray(payload.frames) ? payload.frames : [];
        for (const listener of [...this.frameListeners]) listener(sessionId, frames as never);
      }
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", payload: { token: "fixture" } }));
    socket.onclose = () => {
      this.reconnects += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), 150);
    };
    socket.onerror = () => {
      // `onclose` follows; the reconnect path is the one that matters.
    };
  }

  /**
   * Send, or hold until the socket is open.
   *
   * The replica's `open` runs as soon as the leader has a database, which can be
   * before the socket has finished its handshake; dropping that first
   * `stream.subscribe` would leave the page subscribed to nothing and the check
   * would blame the replica.
   */
  private readonly queued: string[] = [];

  private send(text: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.queued.push(text);
  }

  private flush(): void {
    while (this.queued.length > 0) {
      const next = this.queued.shift()!;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(next);
    }
  }

  subscribe(sessionId: string, fromSeq: number): void {
    this.active.set(sessionId, fromSeq);
    this.sent.push({ type: "subscribe", sessionId, fromSeq, at: Date.now() });
    this.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: sessionId, from_seq: fromSeq } }));
  }

  unsubscribe(sessionId: string): void {
    this.active.delete(sessionId);
    this.sent.push({ type: "unsubscribe", sessionId, at: Date.now() });
    this.send(JSON.stringify({ type: "stream.unsubscribe", payload: { stream: "log", id: sessionId } }));
  }

  /** Reconnect immediately, as `setOffline(false)` would in a real browser. */
  kick(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  onFrames(listener: (sessionId: string, frames: never[]) => void): void {
    this.frameListeners.add(listener);
  }

  onAck(listener: (sessionId: string, ack: never) => void): void {
    this.ackListeners.add(listener);
  }
}

/**
 * Start the fixture in this page.
 *
 * Exported rather than run at import time so the same bundle works whether the
 * page loads it as a module script or a test imports it.
 */
export async function boot(): Promise<void> {
  const cfg = config();
  const socket = new FixtureSocket(cfg.wsUrl);
  socket.onReconnectSession = () => replica?.resubscribe(cfg.sessionId);
  socket.connect();
  const readRange = resolveReadRange(cfg.sessionId);

  let replica: BrowserReplica | null = null;
  const ready = openBrowserReplica({
    userId: cfg.userId,
    workspaceId: cfg.workspaceId,
    tabId: cfg.tabId,
    subscribe: (sessionId, fromSeq) => socket.subscribe(sessionId, fromSeq),
    unsubscribe: (sessionId) => socket.unsubscribe(sessionId),
    readRange,
    env: {
      ...(cfg.opfs === "off" ? { hasOpfs: false } : {}),
      // The real Worker, built from `worker-entry.ts`: the fixture must not
      // exercise a same-thread stand-in, because the OPFS refusal on the page's
      // thread is exactly why the Worker exists.
      createWorker: () => {
        const worker = new Worker("/worker-entry.js", { type: "module" });
        const responses: unknown[] = [];
        (window as unknown as { __qaWorkerResponses: unknown[] }).__qaWorkerResponses = responses;
        worker.addEventListener("message", (event) => responses.push(event.data));
        return worker as unknown as {
          postMessage(message: never): void;
          addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
          terminate(): void;
        };
      },
    },
    onCleared: (reason) => {
      (window as unknown as { __replicaCleared?: string[] }).__replicaCleared ??= [];
      (window as unknown as { __replicaCleared: string[] }).__replicaCleared.push(reason);
    },
    onDegraded: (reason) => {
      (window as unknown as { __replicaDegraded?: string[] }).__replicaDegraded ??= [];
      (window as unknown as { __replicaDegraded: string[] }).__replicaDegraded.push(reason);
    },
  }).then((created) => {
    replica = created;
    socket.onFrames((sessionId, frames) => created.frames(sessionId, frames));
    socket.onAck((sessionId, ack) => created.ack(sessionId, ack));
    created.open(cfg.sessionId);
    return created;
  });

  (window as unknown as { __replica: unknown }).__replica = {
    ready,
    /** The list's view: entries, head, freshness and the replica's storage. */
    state: () => {
      const instance = replica;
      if (!instance) return null;
      const snapshot = instance.port.getSnapshot(cfg.sessionId);
      return {
        entries: snapshot.entries.map((entry) => ({ seq: entry.seq, revision: entry.revision, body_md: entry.body_md })),
        head: snapshot.head,
        fresh: snapshot.fresh,
        ready: snapshot.ready,
        isLeader: instance.isLeader,
        storage: instance.storage,
        degraded: instance.degraded,
        sent: socket.sent.slice(),
        degradedReasons: (window as unknown as { __replicaDegraded?: string[] }).__replicaDegraded ?? [],
      };
    },
    /** A deep link or a scroll window, through the read route. */
    loadWindow: (from: number, to: number) => replica?.loadWindow(cfg.sessionId, { from, to }) ?? Promise.resolve(),
    open: () => replica?.open(cfg.sessionId),
    resubscribe: () => replica?.resubscribe(cfg.sessionId),
    close: () => instanceSafe()?.close(cfg.sessionId),
    dispose: () => instanceSafe()?.dispose(),
    clear: (reason: "logout" | "user_mismatch" | "schema_upgrade") => {
      instanceSafe()?.clear(reason);
      return Promise.resolve();
    },
    /** A clear this tab received, so the check can tell it acted on the broadcast. */
    clearedEvents: () => (window as unknown as { __replicaCleared?: string[] }).__replicaCleared ?? [],
    /** Drop and restore the socket, to exercise the offline catch-up path. */
    kickSocket: () => socket.kick(),
    reconnects: () => socket.reconnects,
  };

  function instanceSafe(): BrowserReplica | null {
    return replica;
  }
}
