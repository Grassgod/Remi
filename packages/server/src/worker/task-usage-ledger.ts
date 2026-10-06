import { randomUUID } from "node:crypto";
import type { TaskUsageSnapshot, TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";

/** Stable execution identity and per-unit revisions support bounded durable deltas. */
export class TaskUsageLedger {
  private units = new Map<string, TaskUsageUnit>();
  private revision = 0;
  private complete = false;
  private completionRequested = false;
  private deferredScopes = 0;
  constructor(private connectionId: string | null = null, readonly runId: string = randomUUID()) {}

  observe(units: TaskUsageUnit[]): TaskUsageSnapshot | null {
    const changed: TaskUsageUnit[] = [];
    for (const raw of units) {
      const unit = { ...raw, connectionId: raw.connectionId === undefined ? this.connectionId : raw.connectionId };
      const previous = this.units.get(unit.unitId);
      if (previous && previous.revision >= unit.revision) continue;
      this.units.set(unit.unitId, unit);
      changed.push(unit);
    }
    if (!changed.length) return null;
    this.complete = false;
    this.revision++;
    return { version: 2, runId: this.runId, revision: this.revision, complete: this.complete, units: changed };
  }

  finish(): TaskUsageSnapshot {
    const complete = this.deferredScopes === 0;
    if (!this.completionRequested || this.complete !== complete || !this.revision) this.revision++;
    this.completionRequested = true;
    this.complete = complete;
    return this.snapshot;
  }

  /** Auxiliary calls remain part of the accepted run after main execution ends. */
  deferCompletion(): () => TaskUsageSnapshot | null {
    this.deferredScopes++;
    this.complete = false;
    let released = false;
    return () => {
      if (released) return null;
      released = true;
      this.deferredScopes--;
      if (!this.completionRequested || this.deferredScopes) return null;
      this.complete = true;
      this.revision++;
      return { version: 2, runId: this.runId, revision: this.revision, complete: true, units: [] };
    };
  }

  get snapshot(): TaskUsageSnapshot {
    return { version: 2, runId: this.runId, revision: this.revision, complete: this.complete,
      units: [...this.units.values()].map(unit => ({ ...unit })) };
  }
}
