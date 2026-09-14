import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRuntimeVersions } from "@acp/runtime-latest.js";
import { activateRuntimeSelection, activeRuntimeSelection, configureRuntimeUpdates, runtimeUpdateSettings, selectedRuntimeVersions } from "@acp/runtime-update-state.js";
import { BRIDGE_PACKAGE, RUNTIME_PIN, releaseRuntimeVersions, type RuntimeSelection } from "@acp/runtime-versions.js";

const savedHome = process.env.REMI_HOME;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "runtime-updates-")); process.env.REMI_HOME = root; });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.REMI_HOME; else process.env.REMI_HOME = savedHome;
});

const future: RuntimeSelection = {
  claude: { acp: "9.0.0", sdk: "9.0.0", executable: "9.0.0" },
  codex: { acp: "9.0.0", sdk: "9.0.0", executable: "9.0.0" },
};

test("checks both ACPs, Claude SDK/CC and Codex against the public stable tag", async () => {
  const seen: string[] = [];
  const versions = await latestRuntimeVersions(["claude", "codex"], async (url) => {
    expect(url).toStartWith("https://registry.npmjs.org/");
    expect(url).toEndWith("/latest");
    const name = url.slice("https://registry.npmjs.org/".length, -"/latest".length);
    seen.push(name);
    return Response.json({ name, version: "9.0.0" });
  });
  expect(versions).toEqual(future);
  expect(new Set(seen)).toEqual(new Set([BRIDGE_PACKAGE.claude, BRIDGE_PACKAGE.codex, RUNTIME_PIN.claude.package, "@anthropic-ai/claude-code", "@openai/codex"]));
  expect(seen).toHaveLength(5);
  expect(activeRuntimeSelection()).toEqual({});
});

test.each(["9.0.0-beta.1", "../escape", "latest", "99"])('rejects unsupported latest version %s', async (version) => {
  await expect(latestRuntimeVersions(["codex"], async (url) => Response.json({ name: url.slice("https://registry.npmjs.org/".length, -7), version }))).rejects.toThrow("stable release");
  expect(activeRuntimeSelection()).toEqual({});
});

test("a registry failure or downgraded dist-tag never changes the active runtime", async () => {
  activateRuntimeSelection(future);
  await expect(latestRuntimeVersions(["codex"], async () => new Response("unavailable", { status: 503 }))).rejects.toThrow("503");
  await expect(latestRuntimeVersions(["codex"], async (url) => Response.json({
    name: url.slice("https://registry.npmjs.org/".length, -7), version: "8.0.0",
  }))).rejects.toThrow("older");
  expect(activeRuntimeSelection()).toEqual(future);
});

test("a verified newer selection survives reload instead of reverting to the release pin", () => {
  activateRuntimeSelection(future);
  expect(selectedRuntimeVersions("claude")).toEqual(future.claude!);
  expect(selectedRuntimeVersions("codex")).toEqual(future.codex!);
  expect(() => activateRuntimeSelection({ claude: releaseRuntimeVersions("claude") })).toThrow("downgraded");
  expect(activeRuntimeSelection()).toEqual(future);
});

test("settings persist and validate intervals, defaulting to enabled daily checks", () => {
  expect(runtimeUpdateSettings()).toEqual({ enabled: true, intervalHours: 24 });
  configureRuntimeUpdates({ enabled: false, intervalHours: 6 });
  expect(runtimeUpdateSettings()).toEqual({ enabled: false, intervalHours: 6 });
  expect(() => configureRuntimeUpdates({ intervalHours: 0 })).toThrow();
  expect(() => configureRuntimeUpdates({ intervalHours: 1.5 })).toThrow();
  expect(runtimeUpdateSettings()).toEqual({ enabled: false, intervalHours: 6 });
});
