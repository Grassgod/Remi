/** Serializes provider execution with final archive-and-delete for one Issue. */
export class IssueWorkspaceLifecycleLocker {
  private tails = new Map<string, Promise<void>>();

  async acquire(issueId: string): Promise<() => void> {
    const key = issueId.trim();
    if (!key) throw new Error("Issue workspace lifecycle lock requires an Issue id");

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

  async runExclusive<T>(issueId: string, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(issueId);
    try {
      return await action();
    } finally {
      release();
    }
  }
}
