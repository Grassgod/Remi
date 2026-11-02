import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { anyCursorInstall, ensureCursorAgent, installedCursor } from "@acp/cursor-install.js";
import type { CursorPin } from "@acp/runtime-versions.js";
import { createMultiremiArchive } from "../../scripts/build-multiremi.js";

const repo = resolve(import.meta.dir, "../..");
const body = Buffer.from("Cursor upgrade archive fixture");
function pin(version: string): CursorPin {
  return { version, artifacts: { "linux-x64": {
    url: `https://downloads.cursor.com/lab/${version}/linux/x64/agent-cli-package.tar.gz`,
    bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"),
  } } };
}
function extract(_archive: string, into: string): void {
  for (const name of ["cursor-agent", "node", "index.js"]) writeFileSync(join(into, name), "#!/bin/sh\nexit 0\n");
}

test.each([200, 503])("installer prepares a managed Cursor pin bump before replacing Remi (download HTTP %s)", async (status) => {
  const root = mkdtempSync(join(tmpdir(), "cursor-runtime-upgrade-"));
  try {
    const managed = join(root, "managed"), release = join(root, "release"), bin = join(root, "bin"), mocks = join(root, "mocks");
    for (const directory of [release, bin, mocks]) mkdirSync(directory);
    const earlier = pin("2026.10.21-a1b2c3d"), current = pin("2026.10.22-27dcf5f");
    const location = { root: managed, platform: "linux-x64" as const, env: {} };
    const oldCursor = await ensureCursorAgent({ ...location, pin: earlier, fetch: async () => new Response(body), extract, freeBytes: () => 10 * 1024 ** 3 });
    expect(anyCursorInstall(managed)).toBe(true);
    expect(installedCursor({ ...location, pin: current })).toBeNull();

    const oldBinary = "#!/bin/sh\necho old-remi\n";
    const newBinary = '#!/bin/sh\nexec "$FIXTURE_BUN" --tsconfig-override "$FIXTURE_TSCONFIG" "$FIXTURE_PREPARE" "$@"\n';
    writeFileSync(join(bin, "remi"), oldBinary);
    writeFileSync(join(release, "remi"), newBinary);
    writeFileSync(join(release, "remi-claude-agent-acp"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(release, "runtime-bundle.json"), '{"schema":1}\n');
    const archive = join(root, "release.tar.gz");
    createMultiremiArchive(release, archive, "pipe");
    writeFileSync(join(mocks, "curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "-o" ]; then cp "$FIXTURE_ARCHIVE" "$2"; exit 0; fi\n shift\ndone\nexit 93\n');
    chmodSync(join(mocks, "curl"), 0o755);

    // Exercise the actual command's provider selection and managed installer.
    // No provider exists on PATH; only the previous managed Cursor is present.
    const harness = join(root, "prepare.ts"), events = join(root, "prepared.json");
    writeFileSync(harness, `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePrepareCommandSpec } from ${JSON.stringify(join(repo, "apps/remi/cli/commands/runtime-prepare.ts"))};
import { CommandRegistry } from ${JSON.stringify(join(repo, "apps/remi/cli/core/index.ts"))};
import { detectMultiremiProviders } from ${JSON.stringify(join(repo, "apps/remi/cli/multiremi/daemon-health.ts"))};
import { anyCursorInstall, ensureCursorAgent, installedCursor } from ${JSON.stringify(join(repo, "packages/acp/src/cursor-install.ts"))};
const location = ${JSON.stringify({ ...location, pin: current })};
const registry = new CommandRegistry();
registry.register(runtimePrepareCommandSpec(async () => ({
  configuredProvider: () => undefined,
  detectProviders: () => detectMultiremiProviders({ pathEnv: "", canExecute: () => false, antigravityInstalled: () => false, cursorInstalled: () => false }),
  antigravityInstalled: () => false,
  cursorInstalled: () => anyCursorInstall(location.root),
  prepare: async (providers) => {
    if (readFileSync(${JSON.stringify(join(bin, "remi"))}, "utf8") !== ${JSON.stringify(oldBinary)}) throw new Error("CLI replaced before preparation");
    writeFileSync(${JSON.stringify(events)}, JSON.stringify(providers));
    if (providers.includes("cursor")) await ensureCursorAgent({ ...location,
      fetch: async () => new Response(${JSON.stringify(body.toString())}, { status: ${status} }),
      extract: (_archive, into) => { for (const name of ["cursor-agent", "node", "index.js"]) writeFileSync(join(into, name), "#!/bin/sh\\nexit 0\\n"); },
      freeBytes: () => 10 * 1024 ** 3,
    });
  },
  versions: () => ({ executable: installedCursor(location)!.executable }),
})));
try { await registry.execute(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
    const result = spawnSync("bash", [join(repo, "scripts/install-remi.sh")], {
      cwd: repo, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${mocks}:${process.env.PATH}`, MULTIREMI_VERSION: "0.0.0-test", MULTIREMI_BIN_DIR: bin,
        FIXTURE_ARCHIVE: archive, FIXTURE_PREPARE: harness, FIXTURE_BUN: process.execPath, FIXTURE_TSCONFIG: join(repo, "tsconfig.json") },
    });
    expect(result.status).toBe(status === 200 ? 0 : 1);
    expect(JSON.parse(readFileSync(events, "utf8"))).toEqual(["cursor"]);
    expect(readFileSync(join(bin, "remi"), "utf8")).toBe(status === 200 ? newBinary : oldBinary);
    expect(installedCursor({ ...location, pin: earlier })?.executable).toBe(oldCursor.executable);
    if (status === 200) expect(installedCursor({ ...location, pin: current })).not.toBeNull();
    else {
      expect(result.stderr).toContain("existing remi binary was not replaced");
      expect(installedCursor({ ...location, pin: current })).toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
