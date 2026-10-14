/**
 * Reclaim reports the server has not acknowledged (ADR 0018, section 4).
 *
 * The workspace is already gone when `gc.subject_reclaimed` fails, so the
 * report is kept in `.daemon/reports/` and sent again at the start of the next
 * round. One file per subject: a newer report supersedes an older one, and a
 * report is dropped when the subject was reopened or restored in the meantime.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DaemonGcSubjectReclaimedPayload } from "@multiremi/contracts/daemon-protocol.js";
import { createLogger } from "@shared/logger.js";
import { segment, pendingReportsRoot } from "./layout.js";

const log = createLogger("multiremi-reclaim-reports");

export function enqueueReclaimReport(root: string, payload: DaemonGcSubjectReclaimedPayload): void {
  const directory = pendingReportsRoot(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${segment(payload.subject.id, "subject id")}.json`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(payload)}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
}

export interface FlushReportsOptions {
  root: string;
  /** Resolves when the server accepted the report; rejects with the transport error otherwise. */
  send: (payload: DaemonGcSubjectReclaimedPayload) => Promise<void>;
  /** True when the server will never accept this report, so keeping it would only retry forever. */
  rejected: (error: unknown) => boolean;
  /** Ownership fence, called before every deletion. */
  assertRootOwner?: () => void;
  /** False when the subject was reopened or restored after the report was queued; the report is then dropped. */
  stillReclaimed: (payload: DaemonGcSubjectReclaimedPayload) => boolean;
  /** The Runtime registered now; it may differ from the one that queued the report. */
  runtimeId: string;
}

/** Send every queued report; returns how many were delivered or dropped. */
export async function flushReclaimReports(options: FlushReportsOptions): Promise<number> {
  const directory = pendingReportsRoot(options.root);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let settled = 0;
  for (const name of names) {
    const path = join(directory, name);
    let payload: DaemonGcSubjectReclaimedPayload;
    try {
      payload = JSON.parse(readFileSync(path, "utf8")) as DaemonGcSubjectReclaimedPayload;
    } catch (error) {
      log.warn(`Dropping unreadable reclaim report ${path}: ${error instanceof Error ? error.message : String(error)}`);
      options.assertRootOwner?.();
      rmSync(path, { force: true });
      continue;
    }
    if (!options.stillReclaimed(payload)) {
      options.assertRootOwner?.();
      rmSync(path, { force: true });
      settled++;
      continue;
    }
    try {
      await options.send({ ...payload, runtime_id: options.runtimeId });
    } catch (error) {
      if (!options.rejected(error)) {
        log.warn(`Reclaim report for ${payload.subject.id} stays queued: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      log.warn(`Server rejected the reclaim report for ${payload.subject.id}; dropping it: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.assertRootOwner?.();
    rmSync(path, { force: true });
    settled++;
  }
  return settled;
}
