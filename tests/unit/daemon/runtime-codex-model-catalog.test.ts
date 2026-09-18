import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { prepareRuntimeCodexModelCatalog } from "@multiremi/worker/runtime-codex-model-catalog.js";

const token = "private-catalog-test-key";
const model = {
  slug: "gemini-3.8-flash", display_name: "Gemini Flash", description: "Provider-authored model",
  supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
  shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 0,
  support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10_000 },
  experimental_supported_tools: [], context_window: 270_000,
  input_modalities: ["text", "image"], base_instructions: "Provider instructions",
  model_messages: { instructions_template: "Provider instructions" },
};
const homes: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function setup(respond: (request: Request) => Response, validate = async (_path: string, _home: string, _signal: AbortSignal) => {}) {
  const home = await mkdtemp(join(tmpdir(), "remi-model-catalog-"));
  homes.push(home);
  await writeFile(join(home, "config.toml"), 'model = "gemini-3.8-flash"\nmodel_provider = "remi_custom"\n');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
  servers.push(server);
  const profile = { name: "custom", base_url: `http://127.0.0.1:${server.port}/v2/`, model: model.slug, env_key: "REMI_CODEX_KEY" };
  return { home, profile, prepare: (signal = new AbortController().signal) => prepareRuntimeCodexModelCatalog(profile, token, home, signal, validate) };
}

it("preserves provider-authored capabilities and all models in a private Codex catalog", async () => {
  const models = [model, { ...model, slug: "another-model", context_window: 128_000 }];
  const fixture = await setup(request => {
    expect(new URL(request.url).pathname).toBe("/v2/models");
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
    return Response.json({ data: [{ id: model.slug }], models });
  });
  await fixture.prepare();
  const config = parse(await readFile(join(fixture.home, "config.toml"), "utf8"));
  expect(config).toMatchObject({ model: model.slug, model_provider: "remi_custom", model_catalog_json: join(fixture.home, "remi-model-catalog.json") });
  const text = await readFile(String(config.model_catalog_json), "utf8");
  expect(JSON.parse(text)).toEqual({ models });
  expect(text).not.toContain(token);
  expect((await stat(String(config.model_catalog_json))).mode & 0o777).toBe(0o600);
});

it("keeps standard data-only providers unchanged and does not attach stale catalog files", async () => {
  const fixture = await setup(() => Response.json({ data: [{ id: model.slug }] }));
  await writeFile(join(fixture.home, "remi-model-catalog.json"), JSON.stringify({ models: [model] }));
  const before = await readFile(join(fixture.home, "config.toml"), "utf8");
  await fixture.prepare();
  expect(await readFile(join(fixture.home, "config.toml"), "utf8")).toBe(before);
});

it("rejects missing selected models before changing config", async () => {
  let models: unknown;
  const fixture = await setup(() => Response.json({ models }));
  const before = await readFile(join(fixture.home, "config.toml"), "utf8");
  for (const invalid of [null, [], [{ slug: "other" }], [{ error: token }]]) {
    models = invalid;
    await expect(fixture.prepare()).rejects.toThrow("invalid or missing model metadata");
    expect(await readFile(join(fixture.home, "config.toml"), "utf8")).toBe(before);
  }
});

it("leaves the prior config and catalog intact when the native decoder rejects metadata", async () => {
  const invalid = { ...model, effective_context_window_percent: null };
  const fixture = await setup(() => Response.json({ models: [invalid] }), async path => {
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ models: [invalid] });
    throw new Error(`native decoder rejected ${token}`);
  });
  const before = await readFile(join(fixture.home, "config.toml"), "utf8");
  await writeFile(join(fixture.home, "remi-model-catalog.json"), "previous catalog");
  await expect(fixture.prepare()).rejects.toThrow("could not be validated or prepared");
  expect(await readFile(join(fixture.home, "config.toml"), "utf8")).toBe(before);
  expect(await readFile(join(fixture.home, "remi-model-catalog.json"), "utf8")).toBe("previous catalog");
  expect((await readdir(fixture.home)).some(file => file.startsWith(".remi-model-catalog-"))).toBe(false);
});

it("refuses symlinked output files without changing their targets", async () => {
  for (const filename of ["remi-model-catalog.json", "config.toml"]) {
    const fixture = await setup(() => Response.json({ models: [model] }));
    const outside = join(fixture.home, "outside.toml");
    await writeFile(outside, 'model = "unchanged"\n', { mode: 0o644 });
    await rm(join(fixture.home, filename), { force: true });
    await symlink(outside, join(fixture.home, filename));
    await expect(fixture.prepare()).rejects.toThrow("could not be validated or prepared");
    expect(await readFile(outside, "utf8")).toBe('model = "unchanged"\n');
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
  }
});

it("does not publish a catalog when cancellation arrives during native validation", async () => {
  const controller = new AbortController();
  const fixture = await setup(() => Response.json({ models: [model] }), async () => { controller.abort(); });
  const before = await readFile(join(fixture.home, "config.toml"), "utf8");
  await expect(fixture.prepare(controller.signal)).rejects.toThrow("could not be validated or prepared");
  expect(await readFile(join(fixture.home, "config.toml"), "utf8")).toBe(before);
  expect(await Bun.file(join(fixture.home, "remi-model-catalog.json")).exists()).toBe(false);
});

it("sanitizes provider failures, invalid JSON and oversized bodies without exposing secrets", async () => {
  let response = () => new Response(token, { status: 401 });
  const fixture = await setup(() => response());
  for (const respond of [() => new Response(token, { status: 401 }), () => new Response(token),
    () => new Response(token.repeat(50_000)), () => Response.json({ models: [{ error: token }] })]) {
    response = respond;
    const error = await fixture.prepare().catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(token);
    expect(error.cause).toBeUndefined();
  }
  expect(parse(await readFile(join(fixture.home, "config.toml"), "utf8")).model_catalog_json).toBeUndefined();
});

it("does not follow redirects or deliver credentials to their target", async () => {
  let redirectedRequests = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    redirectedRequests++;
    return Response.json({ models: [model] });
  } });
  servers.push(target);
  const fixture = await setup(() => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/${token}` } }));
  await expect(fixture.prepare()).rejects.toThrow("Runtime codex model catalog request failed");
  expect(redirectedRequests).toBe(0);
});

it("honors caller cancellation and sanitizes filesystem errors", async () => {
  const fixture = await setup(() => Response.json({ models: [model] }));
  const controller = new AbortController();
  controller.abort(new Error(token));
  await expect(fixture.prepare(controller.signal)).rejects.toThrow("Runtime codex model catalog request failed");
  await expect(prepareRuntimeCodexModelCatalog(fixture.profile, token, join(fixture.home, token), new AbortController().signal))
    .rejects.toThrow("Runtime codex model catalog could not be validated or prepared");
});
