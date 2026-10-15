// PR 4 §1.2-1.4: the per-machine Antigravity server install. Downloads are
// verified (size, sha256) in a stage, renamed atomically, and never replace a
// working install on failure; the first install needs explicit terms consent.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_ADMIN_SETTINGS, AntigravityInstallError, anyAntigravityInstall, antigravityAdminPolicyFile, antigravityConsentOnRecord,
  antigravityHealthProblem, antigravityInstallDir, antigravityInstallProblem, antigravityPlatformKey, antigravityRoot,
  antigravityTermsAccepted, ensureAntigravityServer, installedAntigravity, resolveAntigravityServer, type EnsureAntigravityOptions,
} from "@acp/antigravity-install.js";
import { resolveAcpHealthCheckCommand } from "@acp/index.js";
import { ANTIGRAVITY_CONTRACT_MODEL, verifyAntigravityRuntime } from "@acp/runtime-verify.js";
import { contractCheckShim } from "@daemon/agent-runtime/antigravity/gateway-shim.js";
import type { AntigravityPin } from "@acp/runtime-versions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-install-")));
  roots.push(root);
  return join(root, "acp", "antigravity");
}

const ARCHIVE = Buffer.from("fake antigravity archive bytes");
function pinFor(body: Buffer = ARCHIVE, server = "9.9.9"): AntigravityPin {
  return {
    server, terms: "https://antigravity.google/terms",
    artifacts: { "linux-x64": {
      url: `https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${server}-linux-x86_64.zip`,
      sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, args: ["--uid="],
    } },
  };
}

/** Writes the two binaries the archive would contain (or omits some). */
function extractor(binaries = ["agy_acp_server.par", "localharness_external"], marker = "new") {
  return (_archive: string, into: string) => {
    for (const binary of binaries) writeFileSync(join(into, binary), `#!/bin/sh\n# ${marker}\n`);
  };
}

function options(root: string, overrides: Partial<EnsureAntigravityOptions> = {}): EnsureAntigravityOptions {
  const fetches: string[] = [];
  return {
    pin: pinFor(), platform: "linux-x64", root, acceptTerms: true, env: {},
    fetch: async (url) => { fetches.push(url); return new Response(ARCHIVE); },
    extract: extractor(), freeBytes: () => 100 * 1024 ** 3, now: () => new Date("2026-10-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("platform and location", () => {
  it("names the four pinned platforms and refuses everything else, Windows included", () => {
    expect(antigravityPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(antigravityPlatformKey("darwin", "x64")).toBe("darwin-x64");
    expect(antigravityPlatformKey("linux", "x64")).toBe("linux-x64");
    expect(antigravityPlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(antigravityPlatformKey("win32", "x64")).toBeNull();
    expect(antigravityPlatformKey("linux", "ia32")).toBeNull();
  });

  it("installs under REMI_HOME, one directory per version and platform", () => {
    expect(antigravityRoot({ REMI_HOME: "/r" })).toBe("/r/acp/antigravity");
    expect(antigravityInstallDir({ pin: pinFor(), platform: "linux-x64", root: "/r/acp/antigravity" })).toBe("/r/acp/antigravity/9.9.9-linux-x64");
  });

  it("fails clearly on an unsupported platform", async () => {
    const root = tempRoot();
    await expect(ensureAntigravityServer(options(root, { platform: null }))).rejects.toThrow("antigravity_unsupported_platform");
    await expect(ensureAntigravityServer(options(root, { platform: "darwin-arm64" }))).rejects.toThrow("has no pinned darwin-arm64 archive");
    expect(antigravityInstallProblem({ pin: pinFor(), platform: null, root })).toContain("not supported");
  });
});

describe("ensureAntigravityServer", () => {
  it("requires terms consent for the first install, from the flag or the environment", async () => {
    const root = tempRoot();
    const error = await ensureAntigravityServer(options(root, { acceptTerms: false })).catch((e) => e);
    expect(error).toBeInstanceOf(AntigravityInstallError);
    expect(error.code).toBe("antigravity_terms_required");
    expect(error.message).toContain("https://antigravity.google/terms");
    expect(error.message).toContain("--accept-antigravity-terms");
    expect(existsSync(root) && readdirSync(root).length).toBeFalsy();
    expect(antigravityTermsAccepted(false, { REMI_ACCEPT_ANTIGRAVITY_TERMS: "1" })).toBe(true);
    expect(antigravityTermsAccepted(undefined, { REMI_ACCEPT_ANTIGRAVITY_TERMS: "0" })).toBe(false);
    const installed = await ensureAntigravityServer(options(root, { acceptTerms: false, env: { REMI_ACCEPT_ANTIGRAVITY_TERMS: "1" } }));
    expect(installed.manifest.termsAcceptedAt).toBe("2026-10-15T12:00:00.000Z");
  });

  it("verifies, installs executables with a manifest and becomes a no-op", async () => {
    const root = tempRoot();
    const logs: string[] = [];
    const installed = await ensureAntigravityServer(options(root, { log: (message) => logs.push(message) }));
    const dir = join(root, "9.9.9-linux-x64");
    expect(installed).toEqual({
      dir, executable: join(dir, "agy_acp_server.par"), args: ["--uid="],
      manifest: { version: "9.9.9", platform: "linux-x64", sha256: pinFor().artifacts["linux-x64"]!.sha256, bytes: ARCHIVE.length,
        installedAt: "2026-10-15T12:00:00.000Z", termsAcceptedAt: "2026-10-15T12:00:00.000Z" },
    });
    expect(logs[0]).toContain("https://antigravity.google/terms");
    expect(readdirSync(root).sort()).toEqual(["9.9.9-linux-x64"]);
    expect(installedAntigravity({ pin: pinFor(), platform: "linux-x64", root })).toEqual(installed);
    expect(resolveAntigravityServer({ pin: pinFor(), platform: "linux-x64", root })).toEqual({ executable: installed.executable, args: ["--uid="] });
    let fetched = false;
    await ensureAntigravityServer(options(root, { acceptTerms: false, fetch: async () => { fetched = true; return new Response(ARCHIVE); } }));
    expect(fetched).toBe(false);
  });

  it("leaves the working install untouched on a sha256, size or content failure", async () => {
    const root = tempRoot();
    const first = await ensureAntigravityServer(options(root));
    const before = readFileSync(first.executable, "utf8");
    const failures: Array<[Partial<EnsureAntigravityOptions>, string]> = [
      [{ fetch: async () => new Response(Buffer.from("tampered archive bytes!!!!!!!!")) }, "sha256 mismatch"],
      [{ fetch: async () => new Response(ARCHIVE.subarray(0, 5)) }, "size mismatch"],
      [{ fetch: async () => new Response(Buffer.concat([ARCHIVE, ARCHIVE])) }, "larger than the pinned"],
      [{ fetch: async () => new Response("nope", { status: 404 }) }, "HTTP 404"],
      [{ extract: extractor(["agy_acp_server.par"]) }, "missing localharness_external"],
      [{ extract: () => { throw new Error("corrupt zip"); } }, "corrupt zip"],
      [{ freeBytes: () => 1024 }, "GB free"],
    ];
    for (const [override, message] of failures) {
      await expect(ensureAntigravityServer(options(root, { force: true, ...override }))).rejects.toThrow(message);
      expect(readFileSync(first.executable, "utf8")).toBe(before);
      expect(installedAntigravity({ pin: pinFor(), platform: "linux-x64", root })).not.toBeNull();
      // No stage, lock or partial copy is left behind.
      expect(readdirSync(root)).toEqual(["9.9.9-linux-x64"]);
    }
  });

  it("refuses to run while another install holds the lock", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".install.lock"), { recursive: true });
    writeFileSync(join(root, ".install.lock", "pid"), String(process.pid));
    await expect(ensureAntigravityServer(options(root))).rejects.toThrow("already in progress");
    rmSync(join(root, ".install.lock"), { recursive: true });
    // A dead owner's lock is reclaimed.
    mkdirSync(join(root, ".install.lock"));
    writeFileSync(join(root, ".install.lock", "pid"), "999999999");
    await expect(ensureAntigravityServer(options(root))).resolves.toBeTruthy();
    expect(existsSync(join(root, ".install.lock"))).toBe(false);
  });

  it("reinstalls by rename, keeps exactly one previous copy, and carries consent", async () => {
    const root = tempRoot();
    const old = await ensureAntigravityServer(options(root, { pin: pinFor(ARCHIVE, "9.9.7"), now: () => new Date("2026-10-01T00:00:00.000Z") }));
    await ensureAntigravityServer(options(root, { pin: pinFor(ARCHIVE, "9.9.8"), acceptTerms: false, now: () => new Date("2026-10-02T00:00:00.000Z") }));
    expect(antigravityConsentOnRecord(root)).toBe(old.manifest.termsAcceptedAt);
    const current = await ensureAntigravityServer(options(root, { acceptTerms: false, now: () => new Date("2026-10-03T00:00:00.000Z") }));
    // Accepted once, on the first install; pin bumps keep that record.
    expect(current.manifest.termsAcceptedAt).toBe("2026-10-01T00:00:00.000Z");
    // After a pin bump the previous version stays: a daemon that has not restarted may still spawn it.
    expect(readdirSync(root).sort()).toEqual(["9.9.8-linux-x64", "9.9.9-linux-x64"]);

    await ensureAntigravityServer(options(root, { force: true, extract: extractor(undefined, "second"), now: () => new Date("2026-10-04T00:00:00.000Z") }));
    await ensureAntigravityServer(options(root, { force: true, extract: extractor(undefined, "third"), now: () => new Date("2026-10-05T00:00:00.000Z") }));
    const names = readdirSync(root).sort();
    expect(names.filter((name) => name.includes(".previous-"))).toHaveLength(1);
    expect(names.filter((name) => !name.includes(".previous-"))).toEqual(["9.9.9-linux-x64"]);
    expect(readFileSync(current.executable, "utf8")).toContain("third");
    const previous = names.find((name) => name.includes(".previous-"))!;
    expect(readFileSync(join(root, previous, "agy_acp_server.par"), "utf8")).toContain("second");
    expect(anyAntigravityInstall(root)).toBe(true);
    expect(anyAntigravityInstall(join(root, "missing"))).toBe(false);
  });
});

describe("fast health", () => {
  it("passes a matching install and reports a mismatch, missing executables or a machine policy", async () => {
    const root = tempRoot();
    const location = { pin: pinFor(), platform: "linux-x64" as const, root };
    expect(antigravityHealthProblem({ ...location, adminPolicy: () => null })).toContain("is not installed");
    const installed = await ensureAntigravityServer(options(root));
    expect(antigravityHealthProblem({ ...location, adminPolicy: () => null })).toBeNull();
    expect(antigravityHealthProblem({ ...location, adminPolicy: () => "/etc/antigravity/admin_settings.json" }))
      .toContain("machine policy overrides gateway routing");

    chmodSync(installed.executable, 0o644);
    expect(antigravityHealthProblem({ ...location, adminPolicy: () => null })).toContain("missing an executable agy_acp_server.par");
    chmodSync(installed.executable, 0o755);

    const manifest = JSON.parse(readFileSync(join(installed.dir, "install.json"), "utf8"));
    writeFileSync(join(installed.dir, "install.json"), JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    expect(antigravityHealthProblem({ ...location, adminPolicy: () => null })).toContain("does not match the release pin");
    expect(installedAntigravity(location)).toBeNull();
    expect(() => resolveAntigravityServer(location)).toThrow("antigravity_not_installed");
  });

  it("detects the per-platform admin policy file", () => {
    expect(ANTIGRAVITY_ADMIN_SETTINGS.darwin).toBe("/Library/Application Support/Antigravity/admin_settings.json");
    expect(ANTIGRAVITY_ADMIN_SETTINGS.linux).toBe("/etc/antigravity/admin_settings.json");
    expect(antigravityAdminPolicyFile("linux", (path) => path === "/etc/antigravity/admin_settings.json")).toBe("/etc/antigravity/admin_settings.json");
    expect(antigravityAdminPolicyFile("darwin", () => false)).toBeNull();
    expect(antigravityAdminPolicyFile("win32", () => true)).toBeNull();
  });

  it("is the daemon-start health check, which never spawns", () => {
    // Hermetic REMI_HOME has no install: the check fails without spawning anything.
    const check = resolveAcpHealthCheckCommand("antigravity", null, "agy_acp_server.par");
    expect(check.args).toBeUndefined();
    expect(check.failure).toBeTruthy();
    // An explicit override is health-checked like any other ACP executable, unless it is the retired CLI.
    expect(resolveAcpHealthCheckCommand("antigravity", "/opt/fake/agy-acp", "agy_acp_server.par")).toEqual({ command: "/opt/fake/agy-acp" });
    expect(() => resolveAcpHealthCheckCommand("antigravity", "/usr/local/bin/agy", "agy_acp_server.par"))
      .toThrow("points at the retired agy CLI; clear it");
  });
});

describe("verifyAntigravityRuntime", () => {
  /** A stdio ACP agent that, like the real server, lists the gateway's models on session/new. */
  function fakeServer(version = "9.9.9"): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-verify-")));
    roots.push(dir);
    const script = join(dir, "agy_acp_server.mjs");
    writeFileSync(script, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === "initialize") {
    return send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: ${JSON.stringify(version)} },
      agentCapabilities: { loadSession: true } } });
  }
  if (message.method === "session/new") {
    // Gateway auth needs the env gate; the harness sends Bearer and the placeholder x-goog-api-key.
    let models = [];
    if (process.env.AGY_ACP_ENABLE_GATEWAY_AUTH === "1") {
      const key = process.env.AGY_LLM_GATEWAY_API_KEY;
      const response = await fetch(process.env.AGY_LLM_GATEWAY_URL + "/v1beta/models?pageSize=1000",
        { headers: { authorization: "Bearer " + key, "x-goog-api-key": key } });
      models = response.ok ? (await response.json()).models.map((m) => m.name.replace(/^models\\//, "")) : [];
    }
    return send({ id: message.id, result: { sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select",
      currentValue: models[0] ?? "none", options: models.map((value) => ({ value, name: value })) }],
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] } } });
  }
  if (message.method === "session/set_mode") return send({ id: message.id, result: {} });
  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`);
    chmodSync(script, 0o755);
    return script;
  }

  /** A minimal stand-in for the daemon shim (Task C): forwards with the real key, drops x-goog-api-key unless told not to. */
  function forwardingShim(dropGoogKey = true) {
    return async (upstream: { baseUrl: string; apiKey: string }) => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url);
        const headers = new Headers({ authorization: `Bearer ${upstream.apiKey}` });
        const goog = request.headers.get("x-goog-api-key");
        if (!dropGoogKey && goog) headers.set("x-goog-api-key", goog);
        return fetch(upstream.baseUrl + url.pathname.replace(/^\/r_test/, "") + url.search, { headers });
      } });
      const channel = { baseUrl: `http://127.0.0.1:${server.port}/r_test`, subscribe: () => () => {}, settled: async () => {},
        beginPrompt: () => () => {}, abortInflight: () => {}, close: () => {} };
      return { host: { open: () => channel }, close: () => server.stop(true) };
    };
  }

  const pin = pinFor();
  const silence = () => spyOn(console, "warn").mockImplementation(() => {});

  it("proves the server identity and the credential-free gateway contract", async () => {
    const server = { executable: fakeServer(), args: [] };
    const warn = silence();
    try {
      expect(await verifyAntigravityRuntime({ server, pin })).toEqual({ version: "9.9.9", models: [ANTIGRAVITY_CONTRACT_MODEL] });
      expect(await verifyAntigravityRuntime({ server, pin, shim: forwardingShim() })).toEqual({ version: "9.9.9", models: [ANTIGRAVITY_CONTRACT_MODEL] });
      // The daemon's real shim, as `remi runtime prepare` runs it.
      expect(await verifyAntigravityRuntime({ server, pin, shim: contractCheckShim })).toEqual({ version: "9.9.9", models: [ANTIGRAVITY_CONTRACT_MODEL] });
    } finally {
      warn.mockRestore();
    }
  });

  it("fails on another server version and on a shim that forwards the placeholder key", async () => {
    const warn = silence();
    try {
      await expect(verifyAntigravityRuntime({ server: { executable: fakeServer("9.9.8"), args: [] }, pin })).rejects.toThrow("version mismatch");
      await expect(verifyAntigravityRuntime({ server: { executable: fakeServer(), args: [] }, pin, shim: forwardingShim(false) }))
        .rejects.toThrow("forwarded x-goog-api-key");
    } finally {
      warn.mockRestore();
    }
  });
});
