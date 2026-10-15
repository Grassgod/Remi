// PR 4 §2: the Antigravity access config — process environment, seeded home
// files, mode map and session metadata. The real gateway key must never reach
// the server process; it only ever sees the shim URL and a placeholder key.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_ACCESS, ANTIGRAVITY_BLANKED_ENV, ANTIGRAVITY_PLACEHOLDER_KEY, accessConfigFor, antigravityHomeFiles,
  buildAntigravityEnv, mapAntigravityPermissionMode, seedAntigravityHome,
} from "@acp/access/index.js";
import { ANTIGRAVITY_FOREGROUND_NOTE, AntigravityAdapter } from "@acp/adapters/antigravity.js";
import { resolveAntigravityServer } from "@acp/antigravity-install.js";
import { resolveAcpPermissionMode, resolveAvailableAcpPermissionMode } from "@acp/index.js";
import { ANTIGRAVITY_PIN } from "@acp/runtime-versions.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempDir(prefix = "agy-access-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const SHIM = "http://127.0.0.1:41234/r_abcdef";

describe("buildAntigravityEnv", () => {
  const daemonEnv = {
    PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.corp:3128", HTTP_PROXY: "http://proxy.corp:3128", NO_PROXY: "internal.corp,localhost",
    GEMINI_API_KEY: "AIza-real-personal-key", GOOGLE_APPLICATION_CREDENTIALS: "/home/u/adc.json", AGY_LLM_GATEWAY_PROXY_URL: "socks5://x",
    AGY_LLM_GATEWAY_API_KEY: "sk-gateway-real-secret", AGY_ACP_CCPA_PROJECT: "proj", AGY_ACP_CCPA_BASE_URL: "https://ccpa",
    AGY_ACP_DISABLE_WORKSPACE_TRUST: "1",
  };

  it("routes the gateway to the shim with a placeholder key and owns the agent home", () => {
    const env = buildAntigravityEnv({ home: "/lanes/l1/home", shimUrl: `${SHIM}/`, model: "gemini-2.5-pro", daemonEnv });
    expect(env).toMatchObject({
      GEMINI_HOME: "/lanes/l1/home",
      AGY_ACP_ENABLE_GATEWAY_AUTH: "1",
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      BROWSER: "/usr/bin/false",
      AGY_LLM_GATEWAY_URL: SHIM,
      AGY_LLM_GATEWAY_API_KEY: ANTIGRAVITY_PLACEHOLDER_KEY,
      AGY_ACP_DEFAULT_MODEL: "gemini-2.5-pro",
    });
    // No real credential of any kind is in the overlay.
    expect(JSON.stringify(env)).not.toContain("real");
    expect(env.AGY_LLM_GATEWAY_API_KEY).not.toBe(daemonEnv.AGY_LLM_GATEWAY_API_KEY);
  });

  it("blanks every inherited credential, routing and trust override, including the CCPA family", () => {
    const env = buildAntigravityEnv({ home: "/h", shimUrl: SHIM, model: null, daemonEnv });
    for (const name of ANTIGRAVITY_BLANKED_ENV) expect(env[name]).toBe("");
    expect(env.AGY_ACP_CCPA_PROJECT).toBe("");
    expect(env.AGY_ACP_CCPA_BASE_URL).toBe("");
    // Never a proxy for the loopback discovery call (server 1.4.0 would send the loopback discovery call through it).
    expect(env.AGY_LLM_GATEWAY_PROXY_URL).toBe("");
    // Set means "trusted": it may only ever be blank.
    expect(env.AGY_ACP_DISABLE_WORKSPACE_TRUST).toBe("");
    expect(env).not.toHaveProperty("AGY_ACP_DEFAULT_MODEL");
    // The harness path key is never present-but-empty (server 1.4.0 takes an empty one as set).
    expect(env).not.toHaveProperty("ANTIGRAVITY_HARNESS_PATH");
  });

  it("merges loopback into no_proxy and leaves the daemon's proxies to inheritance", () => {
    const env = buildAntigravityEnv({ home: "/h", shimUrl: SHIM, model: null, daemonEnv });
    expect(env.NO_PROXY).toBe("internal.corp,localhost,127.0.0.1,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).not.toHaveProperty("HTTP_PROXY");
    // A daemon without proxies still gets a non-empty no_proxy (stops the macOS system SOCKS lookup).
    expect(buildAntigravityEnv({ home: "/h", shimUrl: SHIM, model: null, daemonEnv: {} }).no_proxy).toBe("127.0.0.1,localhost,::1");
    expect(buildAntigravityEnv({ home: "/h", shimUrl: SHIM, model: null, daemonEnv: { no_proxy: "a" } }).NO_PROXY).toBe("a,127.0.0.1,localhost,::1");
  });

  it("points the server at its own harness for the pinned launch", () => {
    const env = buildAntigravityEnv({ home: "/h", shimUrl: SHIM, model: null, daemonEnv: {},
      launch: { executable: "/remi/acp/antigravity/1.4.0-linux-x64/agy_acp_server.par", args: ["--uid="] } });
    expect(env.ANTIGRAVITY_HARNESS_PATH).toBe("/remi/acp/antigravity/1.4.0-linux-x64/localharness_external");
  });

  it("accepts only the loopback shim, without /v1beta", () => {
    for (const shimUrl of ["https://ai.openremi.fun/antigravity", "http://10.0.0.5:4000/r_x", `${SHIM}/v1beta`, `${SHIM}/v1`,
      "http://user:pw@127.0.0.1:1/r_x", `${SHIM}?key=x`, "not a url"]) {
      expect(() => buildAntigravityEnv({ home: "/h", shimUrl, model: null, daemonEnv: {} })).toThrow("antigravity_gateway_unconfigured");
    }
    expect(buildAntigravityEnv({ home: "/h", shimUrl: "http://localhost:9/r_x", model: null, daemonEnv: {} }).AGY_LLM_GATEWAY_URL)
      .toBe("http://localhost:9/r_x");
    expect(buildAntigravityEnv({ home: "/h", shimUrl: "http://[::1]:9/r_x", model: null, daemonEnv: {} }).AGY_LLM_GATEWAY_URL)
      .toBe("http://[::1]:9/r_x");
  });
});

describe("seeded home files", () => {
  it("selects gateway auth and marks the task directories untrusted", () => {
    const cwd = tempDir(), workspace = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(cwd, link);
    const files = Object.fromEntries(antigravityHomeFiles({ cwd: link, workspaceDir: workspace }).map((file) => [file.path, JSON.parse(file.content)]));
    expect(files).toEqual({
      [join("antigravity-acp", "settings.json")]: { auth: { type: "gateway" } },
      // Canonical paths, as server 1.4.0 compares them.
      [join("antigravity-acp", "trusted_workspaces.json")]: { trusted: [], untrusted: [cwd, workspace] },
    });
    expect(antigravityHomeFiles({ cwd, workspaceDir: cwd })[1]!.content).toContain(`"untrusted": [\n    ${JSON.stringify(cwd)}\n  ]`);
  });

  it("writes them mode 0600 and replaces earlier copies", () => {
    const home = tempDir(), cwd = tempDir();
    mkdirSync(join(home, "antigravity-acp"));
    writeFileSync(join(home, "antigravity-acp", "settings.json"), '{"auth":{"type":"oauth-personal"}}', { mode: 0o644 });
    seedAntigravityHome({ home, cwd });
    const settings = join(home, "antigravity-acp", "settings.json");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ auth: { type: "gateway" } });
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "antigravity-acp", "trusted_workspaces.json")).mode & 0o777).toBe(0o600);
  });
});

describe("modes, launch and capabilities", () => {
  const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto Edit" }, { id: "yolo", name: "YOLO" }] };

  it("maps Remi's mode names onto default / auto_edit / yolo and defaults to bypass", () => {
    expect(mapAntigravityPermissionMode("bypassPermissions")).toEqual(["yolo"]);
    expect(mapAntigravityPermissionMode("dontAsk")).toEqual(["yolo"]);
    expect(mapAntigravityPermissionMode("auto")).toEqual(["yolo"]);
    expect(mapAntigravityPermissionMode("acceptEdits")).toEqual(["auto_edit"]);
    expect(mapAntigravityPermissionMode("plan")).toEqual(["default"]);
    expect(mapAntigravityPermissionMode("unknown")).toEqual([]);
    const adapter = new AntigravityAdapter();
    expect(resolveAcpPermissionMode("antigravity", null)).toBe("bypassPermissions");
    expect(resolveAvailableAcpPermissionMode(resolveAcpPermissionMode("antigravity", null), modes, adapter)).toBe("yolo");
    expect(resolveAvailableAcpPermissionMode("acceptEdits", modes, adapter)).toBe("auto_edit");
    expect(resolveAvailableAcpPermissionMode("default", modes, adapter)).toBe("default");
  });

  it("declares a strict, effortless, shim-metered access config only for Antigravity", () => {
    expect(accessConfigFor("antigravity")).toBe(ANTIGRAVITY_ACCESS);
    expect(accessConfigFor("claude")).toBeNull();
    expect(accessConfigFor("codex")).toBeNull();
    expect(accessConfigFor("toString")).toBeNull();
    expect(ANTIGRAVITY_ACCESS).toMatchObject({ strictModel: true, modelRequired: true, effort: "none", usage: "gateway-shim",
      defaultContextWindow: 1_048_576, permissionQuestions: true, denyWorkspaceTrust: true, serviceMessages: true, requiresHome: true });
    expect(ANTIGRAVITY_ACCESS.retiredExecutables).toEqual(["agy", "agy.exe"]);
    expect(new AntigravityAdapter().promptUsageSettleScope).toBe("last-request");
  });

  it("launches agy_acp_server.par with the registry's --uid= on Linux only", () => {
    const root = tempDir();
    for (const platform of ["linux-x64", "darwin-arm64"] as const) {
      const artifact = ANTIGRAVITY_PIN.artifacts[platform]!;
      const dir = join(root, `${ANTIGRAVITY_PIN.server}-${platform}`);
      mkdirSync(dir);
      for (const binary of ["agy_acp_server.par", "localharness_external"]) {
        writeFileSync(join(dir, binary), "#!/bin/sh\n");
        chmodSync(join(dir, binary), 0o755);
      }
      writeFileSync(join(dir, "install.json"), JSON.stringify({ version: ANTIGRAVITY_PIN.server, platform, sha256: artifact.sha256,
        bytes: artifact.bytes, installedAt: "2026-10-15T00:00:00.000Z", termsAcceptedAt: "2026-10-15T00:00:00.000Z" }));
    }
    expect(resolveAntigravityServer({ root, platform: "linux-x64" })).toEqual({
      executable: join(root, `${ANTIGRAVITY_PIN.server}-linux-x64`, "agy_acp_server.par"), args: ["--uid="] });
    expect(resolveAntigravityServer({ root, platform: "darwin-arm64" }).args).toEqual([]);
  });
});

describe("AntigravityAdapter.buildSessionMeta", () => {
  it("appends Remi's system prompt and the home's runtime-context instructions", () => {
    const home = tempDir();
    writeFileSync(join(home, "AGENTS.md"), "# Runtime workspace local context\nUse bun.\n");
    expect(new AntigravityAdapter().buildSessionMeta({ systemPrompt: "You are Remi.", home })).toEqual({
      antigravity: { systemPrompt: { append: `${ANTIGRAVITY_FOREGROUND_NOTE}\n\nYou are Remi.\n\n# Runtime workspace local context\nUse bun.` } },
    });
    // The session notes always go out, even without a system prompt.
    expect(new AntigravityAdapter().buildSessionMeta({ systemPrompt: "  ", home: tempDir() })).toEqual({
      antigravity: { systemPrompt: { append: ANTIGRAVITY_FOREGROUND_NOTE } },
    });
    expect(new AntigravityAdapter().buildSessionMeta({ systemPrompt: "Only Remi." })).toEqual({
      antigravity: { systemPrompt: { append: `${ANTIGRAVITY_FOREGROUND_NOTE}\n\nOnly Remi.` } },
    });
  });

  it("asks for foreground shell commands, since a background one holds the turn open", () => {
    expect(ANTIGRAVITY_FOREGROUND_NOTE).toContain("in the foreground");
    expect(ANTIGRAVITY_FOREGROUND_NOTE).toContain("could run for a long time, say so");
  });

  it("names the session cwd first, so shell commands run there and not in the server's skills directory (R5)", () => {
    const meta = new AntigravityAdapter().buildSessionMeta({ systemPrompt: "You are Remi.", cwd: "/work/project" });
    expect(meta).toEqual({ antigravity: { systemPrompt: { append: "The working directory of this session is /work/project. Run every shell command "
      + `in that directory (set it as the command's working directory) unless the task names another directory.\n${ANTIGRAVITY_FOREGROUND_NOTE}\n\nYou are Remi.` } } });
  });

  it("rejects Agent Plugins and ignores allowedTools with a warning", () => {
    expect(() => new AntigravityAdapter().buildSessionMeta({ pluginPaths: ["/plugins/a"] })).toThrow("Antigravity does not support Remi Agent Plugins");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(new AntigravityAdapter().buildSessionMeta({ allowedTools: ["Bash"] })).toEqual({ antigravity: { systemPrompt: { append: ANTIGRAVITY_FOREGROUND_NOTE } } });
      expect(warn.mock.calls.join(" ")).toContain("ignoring allowedTools");
    } finally {
      warn.mockRestore();
    }
  });
});
