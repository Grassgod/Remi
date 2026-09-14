import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntimeBundle, runtimeBundleBridge, runtimeBundlePrefix, verifyRuntimeExecutable } from "@acp/runtime-bundle.js";
import { BRIDGE_PACKAGE, BRIDGE_PIN, RUNTIME_PIN } from "@acp/runtime-versions.js";

const node = Bun.which("node")!;
const savedHome = process.env.REMI_HOME;
let root: string;
afterEach(() => {
  if (savedHome === undefined) delete process.env.REMI_HOME;
  else process.env.REMI_HOME = savedHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { fail?: boolean; executableVersion?: string } = {}) {
  root = mkdtempSync(join(tmpdir(), "runtime-bundle-test-"));
  process.env.REMI_HOME = root;
  const destination = runtimeBundlePrefix("codex");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "previous-install"), "keep this working install");
  const npm = join(root, "npm.cjs");
  // A local stand-in for npm exercises staging, validation and activation. No network.
  writeFileSync(npm, `#!${node}\n` + (options.fail ? 'throw new Error("registry unavailable");' : `
    const fs = require("node:fs"), path = require("node:path");
    const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
    const manifest = JSON.parse(fs.readFileSync(path.join(prefix, "package.json"), "utf8"));
    if (manifest.overrides["@openai/codex"] !== ${JSON.stringify(RUNTIME_PIN.codex.version)}) throw Error("missing SDK override");
    const bridge = path.join(prefix, "node_modules", ${JSON.stringify(BRIDGE_PACKAGE.codex)});
    const sdk = path.join(prefix, "node_modules", "@openai/codex");
    fs.mkdirSync(bridge, {recursive:true});
    fs.mkdirSync(path.join(sdk, "bin"), {recursive:true});
    fs.writeFileSync(path.join(bridge, "package.json"), JSON.stringify({version:${JSON.stringify(BRIDGE_PIN.codex)}}));
    fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({name:"@openai/codex",version:${JSON.stringify(RUNTIME_PIN.codex.version)}}));
    fs.writeFileSync(path.join(sdk, "bin", "codex.js"), ${JSON.stringify(`console.log("codex-cli ${options.executableVersion ?? RUNTIME_PIN.codex.executableVersion}");`)});
  `));
  chmodSync(npm, 0o755);
  return { destination, tools: { node, npm } };
}

test("a download failure leaves the existing bundle untouched and removes staging files", () => {
  const f = fixture({ fail: true });
  expect(() => installRuntimeBundle("codex", f.tools, () => {})).toThrow();
  expect(readFileSync(join(f.destination, "previous-install"), "utf8")).toBe("keep this working install");
  expect(readdirSync(join(root, "acp", "bundles"))).toEqual([f.destination.split("/").at(-1)!]);
});

test("an SDK with the right package version but a wrong executable never activates", () => {
  const f = fixture({ executableVersion: "0.147.0" });
  expect(() => installRuntimeBundle("codex", f.tools, () => {})).toThrow("executable version mismatch");
  expect(existsSync(join(f.destination, "previous-install"))).toBe(true);
});

test("a bridge patch failure never activates the new runtime", () => {
  const f = fixture();
  expect(() => installRuntimeBundle("codex", f.tools, () => { throw Error("unsupported bridge"); })).toThrow("unsupported bridge");
  expect(existsSync(join(f.destination, "previous-install"))).toBe(true);
});

test("verified runtimes activate together and preserve the previous installation", () => {
  const f = fixture();
  installRuntimeBundle("codex", f.tools, (bridge) => {
    expect(bridge).not.toStartWith(f.destination + "/");
    expect(existsSync(join(f.destination, "previous-install"))).toBe(true);
  });
  expect(verifyRuntimeExecutable("codex", runtimeBundleBridge("codex"), node)).toBe(RUNTIME_PIN.codex.executableVersion);
  const backup = readdirSync(join(root, "acp", "bundles")).find((name) => name.includes(".previous-"));
  expect(backup).toBeDefined();
  expect(readFileSync(join(root, "acp", "bundles", backup!, "previous-install"), "utf8")).toBe("keep this working install");
});
