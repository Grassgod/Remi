import type { TaskUsageSnapshot, TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";

/** Leave room for the protocol envelope and all metadata within the 1 MiB cap. */
export function splitUsageReport(snapshot: TaskUsageSnapshot, budget = 256 * 1024): TaskUsageSnapshot[] {
  const overhead = Buffer.byteLength(JSON.stringify({ ...snapshot, units: [] })) + 4096;
  const chunks: TaskUsageSnapshot[] = [];
  let units: TaskUsageUnit[] = [], bytes = overhead;
  for (const unit of snapshot.units) {
    const size = Buffer.byteLength(JSON.stringify(unit)) + 1;
    if (units.length && (bytes + size > budget || units.length >= 500)) {
      chunks.push({ ...snapshot, complete: false, units });
      units = []; bytes = overhead;
    }
    units.push(unit); bytes += size;
  }
  if (!chunks.length) return [snapshot];
  if (units.length) chunks.push({ ...snapshot, complete: false, units });
  if (snapshot.complete) chunks.push({ ...snapshot, units: [] });
  return chunks;
}
