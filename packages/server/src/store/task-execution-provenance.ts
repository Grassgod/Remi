import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

export const MISSING_TASK_EXECUTION_PROVENANCE_SQL = `execution_runtime_id IS NULL
  AND NULLIF(execution_fingerprint, '') IS NOT NULL
  AND (codex_profile IS NOT NULL OR claude_profile IS NOT NULL)`;

/** Caller owns the workspace Runtime lifecycle lock inside a transaction. */
export function recoverTaskExecutionRuntimeWithinLock(db: SqlDatabase, workspaceId: string): void {
  const rows = db.query(`SELECT id, provider, execution_fingerprint, codex_profile, claude_profile
    FROM multiremi_tasks WHERE workspace_id = ? AND ${MISSING_TASK_EXECUTION_PROVENANCE_SQL}`).all(workspaceId) as Array<{
    id: string; provider: string | null; execution_fingerprint: string;
    codex_profile: string | null; claude_profile: string | null;
  }>;
  const transitionPrefix = "chat-workspace-transition-";
  const pending: Array<{ taskId: string; origin: string | null; credentialId?: string; provider?: string }> = [];
  const credentialIds = new Set<string>();
  for (const row of rows) {
    if (row.execution_fingerprint.startsWith(transitionPrefix)) {
      // Preserve explicit unknown sources and tolerate malformed history.
      const transition = row.execution_fingerprint.slice(transitionPrefix.length);
      const separator = transition.indexOf(":");
      const encoded = separator < 0 ? "" : transition.slice(0, separator);
      let origin: string | null = null;
      try { origin = decodeURIComponent(encoded) || null; } catch { /* unknown */ }
      pending.push({ taskId: row.id, origin });
      continue;
    }
    // runtime_id is a mutable claimant, including on dispatched tasks.
    // Env references, live profiles and parent runtime_id are not evidence
    // of the machine whose original environment authenticated a snapshot.
    if ((row.codex_profile === null) === (row.claude_profile === null)) continue;
    const provider = row.codex_profile !== null ? "codex" : "claude";
    if (row.provider && row.provider !== provider) continue;
    let profile: unknown;
    try { profile = JSON.parse((row.codex_profile ?? row.claude_profile)!); } catch { continue; }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;
    const { auth_mode, credential_id } = profile as Record<string, unknown>;
    if (auth_mode !== "api_key" || typeof credential_id !== "string"
      || !/^rck_[a-zA-Z0-9_-]{1,100}$/.test(credential_id)) continue;
    credentialIds.add(credential_id);
    pending.push({ taskId: row.id, origin: null, credentialId: credential_id, provider });
  }
  // Missing credentials remain missing on every startup. Batch and dedupe
  // ownership lookups so U unresolved snapshots do not incur U roundtrips;
  // cap placeholders independently of queue/history size. No key is read.
  const owners = new Map<string, { runtime_id: string; provider: string }>();
  const ids = [...credentialIds];
  for (let offset = 0; offset < ids.length; offset += 128) {
    const batch = ids.slice(offset, offset + 128);
    const credentials = db.query(`SELECT c.id, c.runtime_id, r.provider
      FROM multiremi_runtime_provider_credentials c
      JOIN multiremi_runtimes r ON r.id = c.runtime_id
      WHERE COALESCE(r.workspace_id, 'local') = ? AND c.id IN (${batch.map(() => "?").join(",")})`)
      .all(workspaceId, ...batch) as Array<{ id: string; runtime_id: string; provider: string }>;
    for (const credential of credentials) owners.set(credential.id, credential);
  }
  for (const candidate of pending) {
    const credential = candidate.credentialId ? owners.get(candidate.credentialId) : null;
    const origin = candidate.credentialId
      ? credential && credential.provider === candidate.provider ? credential.runtime_id : null
      : candidate.origin;
    if (!origin) continue;
    db.run("UPDATE multiremi_tasks SET execution_runtime_id = ? WHERE id = ? AND execution_runtime_id IS NULL",
      [origin, candidate.taskId]);
  }
  // Ambiguous snapshots remain unknown even while pinned or dispatched.
  // The scheduler diagnoses them instead of choosing another host's key.
}
