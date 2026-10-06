import type { TaskUsageSnapshot, TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import { createHash } from "node:crypto";

function* boundedCoverageUnits(unit: TaskUsageUnit, budget: number): Generator<TaskUsageUnit> {
  if (!unit.coveredUnitIds?.length || Buffer.byteLength(JSON.stringify(unit)) + 1 <= budget) {
    yield unit;
    return;
  }
  const covered = [...unit.coveredUnitIds].sort();
  const base = { ...unit, coveredUnitIds: [],
    coverageExpectedCount: unit.coverageExpectedCount ?? covered.length,
    coverageSha256: unit.coverageSha256 ?? createHash("sha256").update(JSON.stringify(covered)).digest("hex"),
  };
  const overhead = Buffer.byteLength(JSON.stringify(base)) + 1;
  let ids: string[] = [], bytes = overhead;
  for (const id of covered) {
    const size = Buffer.byteLength(JSON.stringify(id)) + 1;
    if (ids.length && bytes + size > budget) {
      yield { ...base, coveredUnitIds: ids };
      ids = []; bytes = overhead;
    }
    ids.push(id); bytes += size;
  }
  if (ids.length) yield { ...base, coveredUnitIds: ids };
}

/** Leave room for the protocol envelope and all metadata within the 1 MiB cap. */
export function splitUsageReport(snapshot: TaskUsageSnapshot, budget = 256 * 1024): TaskUsageSnapshot[] {
  const overhead = Buffer.byteLength(JSON.stringify({ ...snapshot, units: [] })) + 4096;
  const chunks: TaskUsageSnapshot[] = [];
  let units: TaskUsageUnit[] = [], bytes = overhead;
  for (const raw of snapshot.units) for (const unit of boundedCoverageUnits(raw, budget - overhead)) {
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
