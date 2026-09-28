/**
 * `source_revision` is the digest of an archive's content manifest.
 *
 * It deliberately excludes the container: recompressing the same members at a
 * different deflate level produces a different blob `sha256` but the same
 * revision. The GC barrier and the hard-delete barrier key on the revision, so
 * switching the container from tar.gz to ZIP did not invalidate either one.
 *
 * Shared because the daemon writes the value and the server re-derives it while
 * validating an ingest; a drift between the two would break the barrier.
 */

import { createHash } from "node:crypto";
import type { SessionArchiveManifest } from "@multiremi/contracts/session-archive.js";

export function sessionArchiveSourceRevision(manifest: SessionArchiveManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}
