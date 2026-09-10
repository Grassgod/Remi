type Waiter = { shared: boolean; resolve: (release: () => void) => void };
type LockState = { readers: number; writer: boolean; queue: Waiter[] };

/** Executions share a root; migration/archive/GC require exclusive ownership. */
export class IssueWorkspaceLifecycleLocker {
  private states = new Map<string, LockState>();

  acquire(workspaceKey: string): Promise<() => void> {
    return this.enqueue(workspaceKey, false);
  }

  acquireShared(workspaceKey: string): Promise<() => void> {
    return this.enqueue(workspaceKey, true);
  }

  private enqueue(workspaceKey: string, shared: boolean): Promise<() => void> {
    const key = workspaceKey.trim();
    if (!key) return Promise.reject(new Error("Workspace lifecycle lock requires an ownership key"));
    let state = this.states.get(key);
    if (!state) {
      state = { readers: 0, writer: false, queue: [] };
      this.states.set(key, state);
    }
    const current = state;
    return new Promise((resolve) => {
      current.queue.push({ shared, resolve });
      this.drain(key, current);
    });
  }

  private drain(key: string, state: LockState): void {
    if (state.writer) return;
    while (state.queue.length) {
      const next = state.queue[0]!;
      if (!next.shared && state.readers) return;
      state.queue.shift();
      if (next.shared) state.readers++;
      else state.writer = true;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        if (next.shared) state.readers--;
        else state.writer = false;
        this.drain(key, state);
      });
      if (!next.shared) return;
    }
    if (!state.readers) this.states.delete(key);
  }

  async runExclusive<T>(workspaceKey: string, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(workspaceKey);
    try {
      return await action();
    } finally {
      release();
    }
  }
}
