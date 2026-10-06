import type { TaskUsageEntry } from "@multiremi/contracts/types.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

/** Compatibility display projection. Canonical reports retain nullable evidence,
 * provenance and context separately; this legacy shape contains actual consumption only. */
export function taskUsageProjection(db: SqlDatabase, ids: readonly string[]): Map<string, TaskUsageEntry[]> {
  const result = new Map<string, TaskUsageEntry[]>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const rows = db.query(`SELECT task_id,provider,COALESCE(model,requested_model,'unknown') AS model,
      SUM(COALESCE(input_tokens,0)) AS input_tokens,SUM(COALESCE(output_tokens,0)) AS output_tokens,
      SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens,SUM(COALESCE(cache_write_tokens,0)) AS cache_write_tokens,
      SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)+COALESCE(actual_unsplit_tokens,0)) AS total_tokens
      FROM multiremi_usage_units WHERE task_id IN (${batch.map(() => '?').join(',')})
        AND source<>'context_snapshot' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR actual_unsplit_tokens IS NOT NULL)
      GROUP BY task_id,provider,COALESCE(model,requested_model,'unknown') ORDER BY task_id,provider,model`).all(...batch) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.task_id), entries = result.get(id) ?? [];
      entries.push({ provider: String(row.provider), model: String(row.model), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens), cacheWriteTokens: Number(row.cache_write_tokens), totalTokens: Number(row.total_tokens) });
      result.set(id, entries);
    }
  }
  return result;
}
