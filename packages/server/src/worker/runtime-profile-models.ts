import type { RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import type { RuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { readCapped } from "@multiremi/relay/http.js";

/** Runs on the owning Runtime: custom connections intentionally support loopback/LAN. */
export async function discoverRuntimeProfileModels(
  provider: "codex" | "claude",
  profile: RuntimeCodexProfile | RuntimeClaudeProfile,
  token: string,
  signal: AbortSignal,
): Promise<MultiremiRuntimeModel[]> {
  const base = profile.base_url.replace(/\/+$/, "");
  const url = new URL(base + (provider === "claude" && !base.endsWith("/v1") ? "/v1/models" : "/models"));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "claude" && (profile as RuntimeClaudeProfile).auth_header === "x-api-key") headers["x-api-key"] = token;
  else headers.Authorization = `Bearer ${token}`;
  if (provider === "claude") headers["anthropic-version"] = "2023-06-01";
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const models = new Map<string, MultiremiRuntimeModel>();
  const cursors = new Set<string>();
  for (;;) {
    const response = await fetch(url, { headers, signal: requestSignal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      // Never include a provider response body, which may echo authentication headers.
      throw new Error(`Runtime ${provider} model discovery HTTP ${response.status}`);
    }
    const text = await readCapped(response, 1_000_000);
    let body: { data?: unknown; has_more?: boolean; last_id?: unknown };
    try { body = JSON.parse(text); }
    catch { throw new Error(`Runtime ${provider} model discovery returned invalid JSON`); }
    if (!body || !Array.isArray(body.data)) throw new Error(`Runtime ${provider} model discovery requires a data array`);
    for (const row of body.data) {
      if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
      const id = row.id.trim();
      if (models.has(id)) continue;
      models.set(id, { id, label: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : id,
        provider, default: id === profile.model });
    }
    if (provider !== "claude" || !body.has_more) break;
    const cursor = typeof body.last_id === "string" ? body.last_id : "";
    if (!cursor || cursors.has(cursor)) throw new Error("Runtime claude model discovery returned an invalid pagination cursor");
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  if (!models.size) throw new Error(`Runtime ${provider} model discovery returned no models`);
  // Keep the explicitly configured default usable even if the endpoint omits aliases.
  if (!models.has(profile.model)) models.set(profile.model, { id: profile.model, label: profile.model, provider, default: true });
  return [...models.values()];
}
