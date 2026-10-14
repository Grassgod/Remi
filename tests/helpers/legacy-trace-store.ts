import { InMemoryTraceStore, type TraceAppendResult } from "@multiremi/worker/trace-store.js";
import type { LegacyTraceEventInput, TraceEventInput } from "@multiremi/contracts/trace.js";

/**
 * An in-memory daemon store fed with legacy fragment events, for the server
 * read-path, share and CLI tests that have not switched to turn + items yet.
 * The store treats the fragments as opaque bodies, exactly as it treats any
 * unknown event type (and drops one over the 1 MiB event ceiling).
 *
 * TODO(PR 2 P2b): rewrite those tests on turn + items events and delete this.
 */
export class LegacyFragmentTraceStore extends InMemoryTraceStore {
  // `any` keeps the legacy fields (`content`, `tool`, ...) readable at the call sites.
  override append(taskId: string, events: Array<TraceEventInput | LegacyTraceEventInput>): Omit<TraceAppendResult, "events"> & { events: any[] } {
    return super.append(taskId, events as TraceEventInput[]);
  }
}
