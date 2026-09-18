import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import type { RuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import { mergeCodexConfig } from "@daemon/agent-runtime/relay-sync.js";
import { readCapped } from "@multiremi/relay/http.js";
import { validateCodexModelCatalog } from "@acp/model-catalog-validation.js";
import { writePrivateFileIfChanged } from "@daemon/agent-runtime/workspace/session-home.js";

/** Attach provider-authored Codex metadata after the session config has been rebuilt. */
export async function prepareRuntimeCodexModelCatalog(
  profile: RuntimeCodexProfile,
  token: string,
  home: string,
  signal: AbortSignal,
  validate: typeof validateCodexModelCatalog = validateCodexModelCatalog,
): Promise<void> {
  let response: Response | undefined;
  let text: string;
  try {
    response = await fetch(profile.base_url.replace(/\/+$/, "") + "/models", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    text = await readCapped(response, 1_000_000);
  } catch {
    await response?.body?.cancel().catch(() => {});
    // Transport errors and provider bodies can contain URLs or echoed credentials.
    throw new Error(response && !response.ok
      ? `Runtime codex model catalog HTTP ${response.status}`
      : "Runtime codex model catalog request failed");
  }
  signal.throwIfAborted();
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new Error("Runtime codex model catalog returned invalid JSON"); }
  if (!isObject(body)) throw new Error("Runtime codex model catalog returned an invalid object");
  // Standard OpenAI model lists only expose IDs; never invent metadata from them.
  if (!("models" in body)) return;
  const models = body.models;
  if (!Array.isArray(models) || !models.some(model => isObject(model) && model.slug === profile.model)) {
    throw new Error("Runtime codex model catalog returned invalid or missing model metadata");
  }
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(home, ".remi-model-catalog-"));
    const candidate = join(temporary, "models.json");
    const content = JSON.stringify({ models }) + "\n";
    await writeFile(candidate, content, { mode: 0o600 });
    // Use the task's native decoder, including nested/optional fields, rather
    // than maintaining a partial copy of Codex's evolving model schema.
    await validate(candidate, home, signal);
    signal.throwIfAborted();
    const catalogPath = resolve(home, "remi-model-catalog.json");
    const configPath = resolve(home, "config.toml");
    const config = mergeCodexConfig(await readFile(configPath, "utf8"), stringify({ model_catalog_json: catalogPath }));
    signal.throwIfAborted();
    await writePrivateFileIfChanged(catalogPath, content);
    await writePrivateFileIfChanged(configPath, config);
  } catch {
    throw new Error("Runtime codex model catalog could not be validated or prepared");
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
