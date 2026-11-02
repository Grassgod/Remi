import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anyCursorInstall, cursorHealthProblem, cursorInstallDir, cursorInstallProblem, cursorPlatformKey, cursorRoot,
  ensureCursorAgent, installedCursor, resolveCursorAgentExecutable, type EnsureCursorOptions,
} from "@acp/cursor-install.js";
import { CURSOR_PIN, cursorPinProblem, isCursorVersion, type CursorPin } from "@acp/runtime-versions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-install-")));
  roots.push(root);
  return root;
}
const ARCHIVE = Buffer.from("fixture Cursor archive");
const VERSION = "2026.10.22-27dcf5f";
function pinFor(body = ARCHIVE, version = VERSION): CursorPin {
  return { version, artifacts: { "linux-x64": {
    url: `https://downloads.cursor.com/lab/${version}/linux/x64/agent-cli-package.tar.gz`,
    sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length,
  } } };
}
function extractor(names = ["cursor-agent", "node", "index.js"], marker = "fixture") {
  return (_archive: string, into: string) => {
    for (const name of names) writeFileSync(join(into, name), `#!/bin/sh\n# ${marker}\nexit 99\n`);
  };
}
function options(root: string, overrides: Partial<EnsureCursorOptions> = {}): EnsureCursorOptions {
  return {
    root, env: {}, pin: pinFor(), platform: "linux-x64", fetch: async () => new Response(ARCHIVE),
    extract: extractor(), freeBytes: () => 10 * 1024 ** 3, now: () => new Date("2026-10-29T12:00:00Z"),
    ...overrides,
  };
}

describe("Cursor managed installation", () => {
  it("validates the official pinned version and archive source", () => {
    expect(cursorPinProblem(CURSOR_PIN)).toBeNull();
    expect(cursorPinProblem(pinFor())).toBeNull();
    expect(isCursorVersion("2026.02.30-27dcf5f")).toBe(false);
    expect(isCursorVersion("latest")).toBe(false);
    const invalid = pinFor();
    invalid.artifacts["linux-x64"]!.url = "https://example.com/agent-cli-package.tar.gz";
    expect(cursorPinProblem(invalid)).toContain("official");
    expect(cursorPlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cursorPlatformKey("win32", "x64")).toBeNull();
    expect(cursorRoot({ REMI_HOME: "/fixture/remi" })).toBe("/fixture/remi/acp/cursor");
  });

  it("prepares from an empty machine without credentials and reuses the verified install", async () => {
    const root = join(tempRoot(), "acp", "cursor");
    const config = options(root);
    expect(cursorInstallProblem(config)).toContain("not installed");
    const installed = await ensureCursorAgent(config);
    expect(installed).toEqual({
      dir: join(root, `${VERSION}-linux-x64`), executable: join(root, `${VERSION}-linux-x64`, "cursor-agent"), args: ["acp"],
      manifest: { version: VERSION, platform: "linux-x64", bytes: ARCHIVE.length,
        sha256: pinFor().artifacts["linux-x64"]!.sha256, installedAt: "2026-10-29T12:00:00.000Z" },
    });
    expect(cursorInstallProblem(config)).toBeNull();
    expect(installedCursor(config)).toEqual(installed);
    expect(await ensureCursorAgent({ ...config, fetch: async () => { throw new Error("unexpected download"); } })).toEqual(installed);
    expect(readdirSync(root)).toEqual([`${VERSION}-linux-x64`]);
  });

  it("extracts the official dist-package layout into the managed version directory", async () => {
    const source = tempRoot(), dist = join(source, "dist-package");
    mkdirSync(dist);
    extractor()("", dist);
    const archive = join(source, "package.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, "dist-package"]);
    const body = readFileSync(archive);
    const config = options(join(tempRoot(), "cursor"), { pin: pinFor(body), fetch: async () => new Response(body), extract: undefined });
    const installed = await ensureCursorAgent(config);
    expect(readFileSync(join(installed.dir!, "index.js"), "utf8")).toContain("fixture");
    expect(existsSync(join(installed.dir!, "dist-package"))).toBe(false);
    expect(cursorInstallProblem(config)).toBeNull();
  });

  it("recognizes an earlier managed version for preparation while launch requires the current pin", async () => {
    const home = tempRoot(), root = join(home, "acp", "cursor");
    const earlier = options(root, { pin: pinFor(ARCHIVE, "2026.10.21-a1b2c3d") });
    expect(anyCursorInstall(root)).toBe(false);
    const installed = await ensureCursorAgent(earlier);
    expect(anyCursorInstall(root)).toBe(true);
    expect(installedCursor(options(root))).toBeNull();
    expect(resolveCursorAgentExecutable({ REMI_HOME: home, PATH: "" })).toBeNull();
    rmSync(join(installed.dir!, "node"));
    expect(anyCursorInstall(root)).toBe(false);
    await ensureCursorAgent(earlier);
    const manifest = join(installed.dir!, "install.json");
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), sha256: "invalid" }));
    expect(anyCursorInstall(root)).toBe(false);
  });

  it("retains a usable install when a replacement download or extraction fails", async () => {
    const root = tempRoot(), config = options(root);
    const first = await ensureCursorAgent(config);
    const before = readFileSync(first.executable, "utf8");
    const failures: Array<[Partial<EnsureCursorOptions>, string]> = [
      [{ fetch: async () => new Response(Buffer.alloc(ARCHIVE.length, 120)) }, "sha256 mismatch"],
      [{ fetch: async () => new Response(ARCHIVE.subarray(0, 3)) }, "size mismatch"],
      [{ fetch: async () => new Response(Buffer.concat([ARCHIVE, ARCHIVE])) }, "larger than the pinned"],
      [{ fetch: async () => new Response("unavailable", { status: 503 }) }, "HTTP 503"],
      [{ extract: extractor(["cursor-agent", "index.js"]) }, "missing node"],
      [{ extract: () => { throw new Error("invalid tar"); } }, "invalid tar"],
      [{ freeBytes: () => 1024 }, "GB free"],
    ];
    for (const [override, message] of failures) {
      await expect(ensureCursorAgent({ ...config, force: true, ...override })).rejects.toThrow(message);
      expect(readFileSync(first.executable, "utf8")).toBe(before);
      expect(cursorInstallProblem(config)).toBeNull();
      expect(readdirSync(root)).toEqual([`${VERSION}-linux-x64`]);
    }
  });

  it("rejects concurrent installation and recovers a dead owner's lock", async () => {
    const root = tempRoot(), lock = join(root, ".install.lock");
    mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid));
    await expect(ensureCursorAgent(options(root))).rejects.toThrow("already in progress");
    expect(existsSync(lock)).toBe(true);
    writeFileSync(join(lock, "pid"), "999999999");
    await expect(ensureCursorAgent(options(root))).resolves.toBeTruthy();
    expect(existsSync(lock)).toBe(false);
  });

  it("preserves the previous copy during a forced replacement", async () => {
    const root = tempRoot(), config = options(root);
    const installed = await ensureCursorAgent(config);
    await ensureCursorAgent({ ...config, force: true, extract: extractor(undefined, "replacement") });
    expect(readFileSync(installed.executable, "utf8")).toContain("replacement");
    const previous = readdirSync(root).find((name) => name.includes(".previous-"))!;
    expect(readFileSync(join(root, previous, "cursor-agent"), "utf8")).toContain("fixture");
    expect(cursorInstallProblem(config)).toBeNull();
  });

  it("respects an explicit executable, rejects invalid overrides, and never falls back to PATH", async () => {
    const home = tempRoot(), executable = join(home, "cursor-agent");
    writeFileSync(executable, "#!/bin/sh\nexit 99\n"); chmodSync(executable, 0o755);
    const env = { REMI_HOME: home, REMI_CURSOR_AGENT_EXECUTABLE: executable };
    expect(await ensureCursorAgent({ env, fetch: async () => { throw new Error("unexpected download"); } })).toEqual({ executable, args: ["acp"] });
    expect(cursorHealthProblem(env)).toBeNull();
    expect(resolveCursorAgentExecutable(env)).toBe(executable);
    expect(resolveCursorAgentExecutable({ REMI_HOME: home, PATH: home })).toBeNull();
    chmodSync(executable, 0o644);
    expect(cursorHealthProblem(env)).toContain("not available");
    await expect(ensureCursorAgent({ env })).rejects.toThrow("cursor_not_installed");
    expect(resolveCursorAgentExecutable(env)).toBeNull();
  });

  it("reports unsupported platforms and repairs an incomplete pinned install", async () => {
    const root = tempRoot(), config = options(root);
    await expect(ensureCursorAgent({ ...config, platform: null })).rejects.toThrow("cursor_unsupported_platform");
    const installed = await ensureCursorAgent(config);
    rmSync(join(installed.dir!, "index.js"));
    expect(cursorInstallProblem(config)).toContain("missing index.js");
    await ensureCursorAgent(config);
    expect(cursorInstallProblem(config)).toBeNull();
    expect(cursorInstallDir(config)).toBe(installed.dir!);
  });
});
