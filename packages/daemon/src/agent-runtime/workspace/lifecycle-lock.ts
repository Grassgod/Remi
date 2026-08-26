/** Serializes provider execution with final archive-and-delete for one owned workspace root. */
export class IssueWorkspaceLifecycleLocker {
  private tails = new Map<string, Promise<void>>();

  async acquire(workspaceKey: string): Promise<() => void> {
    const key = workspaceKey.trim();
    if (!key) throw new Error("Workspace lifecycle lock requires an ownership key");

    const previous = this.tails.get(key);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.tails.set(key, gate);
    if (previous) await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.tails.get(key) === gate) this.tails.delete(key);
      releaseGate();
    };
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
