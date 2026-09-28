import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DAEMON_V1_RELEASE = {
  tag: "v0.2.82",
  url: "https://github.com/Grassgod/Remi/releases/tag/v0.2.82",
  sha256: {
    "linux-x64": "97f966b1978b0c091eb05efdc3089f2addf86eca688e5ba5cab541f61a19b836",
    "linux-arm64": "fd133dce6822864e04841165065cfb441560331cf5d6f9a7fe429ae27e459d44",
    "darwin-x64": "f7b5081f55967b662423cc0c129e9e3855fb760c7079ee5253c658ecc9098f2c",
    "darwin-arm64": "0daf3545da5a1bf9376deb6221f70dcdd024ebb4d197e6b3b72b4f532adffbd2",
  },
} as const;

export function daemonV1Asset(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const sha256 = DAEMON_V1_RELEASE.sha256[target as keyof typeof DAEMON_V1_RELEASE.sha256];
  if (!sha256) throw new Error("No v0.2.82 release fixture for this platform");
  const name = `remi-0.2.82-${target}.tar.gz`;
  return { name, sha256, url: `https://github.com/Grassgod/Remi/releases/download/v0.2.82/${name}` };
}

export function localDaemonTestUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The release fixture requires an explicit local HTTP server port");
  }
  return url.origin;
}

export function daemonV1TestEnv(root: string, serverUrl: string, token: string, installerUrl: string) {
  const home = join(root, "home");
  return {
    HOME: home,
    USER: "legacy-release-fixture",
    PATH: [join(root, "payload"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    REMI_HOME: join(home, ".remi"),
    NPM_CONFIG_PREFIX: join(root, "npm"),
    MULTIREMI_STATE_DIR: join(root, "state"),
    MULTIREMI_WORKSPACES_ROOT: join(root, "workspaces"),
    MULTIREMI_BIN_DIR: join(root, "payload"),
    MULTIREMI_TOKEN: token,
    MULTIREMI_SERVER_URL: localDaemonTestUrl(serverUrl),
    MULTIREMI_INSTALLER_URL: installerUrl,
    MULTIREMI_ANTIGRAVITY_PATH: join(root, "agy-fixture"),
    MULTIREMI_GC_ENABLED: "0",
  };
}

/** The daemon is the published binary; only its provider and installer are inert. */
export class DaemonV1ReleaseHarness {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private output = "";
  private readers: Promise<void>[] = [];
  private installer: ReturnType<typeof Bun.serve> | null = null;
  private disposed = false;
  private constructor(readonly root: string, readonly binary: string) {}

  static prepare(archive: string): DaemonV1ReleaseHarness {
    const asset = daemonV1Asset();
    if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== asset.sha256) {
      throw new Error(`SHA-256 mismatch for ${asset.name}`);
    }
    const root = mkdtempSync(join(tmpdir(), "mul418-v1-binary-"));
    try {
      const payload = join(root, "payload");
      mkdirSync(payload);
      mkdirSync(join(root, "home"));
      execFileSync("tar", ["xzf", resolve(archive), "--no-same-owner", "-C", payload, "remi", "remi-claude-agent-acp", "runtime-bundle.json"]);
      const binary = join(payload, "remi");
      const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000,
        env: { HOME: join(root, "home"), PATH: "/usr/bin:/bin" } }).trim();
      if (version !== "0.2.82") throw new Error("Release fixture binary version mismatch");
      const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;
      writeFileSync(join(root, "agy-fixture"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "antigravity-cli.mjs"))} "$@"\n`, { mode: 0o755 });
      return new DaemonV1ReleaseHarness(root, binary);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  start(serverUrl: string, token: string): void {
    if (this.disposed || this.child) throw new Error("Release fixture is already started or disposed");
    const url = localDaemonTestUrl(serverUrl);
    this.installer = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => new Response("exit 42\n", { headers: { "Content-Type": "text/x-shellscript" } }) });
    const installerUrl = `http://127.0.0.1:${this.installer.port}/fixture-installer.sh`;
    this.child = Bun.spawn([this.binary, "daemon", "start", "--foreground", "--provider", "antigravity",
      "--server", url, "--workspace", "local", "--daemon-id", "dmn_release_fixture", "--device-name", "release-fixture", "--daemon-port", "0"], {
      cwd: this.root, env: daemonV1TestEnv(this.root, url, token, installerUrl), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          this.output = (this.output + decoder.decode(chunk.value, { stream: true })).slice(-65_536);
        }
      } finally { reader.releaseLock(); }
    };
    this.readers = [collect(this.child.stdout as ReadableStream<Uint8Array>), collect(this.child.stderr as ReadableStream<Uint8Array>)];
  }

  localPort(): number | null {
    return Number(/Repo checkout server listening on 127\.0\.0\.1:(\d+)/.exec(this.output)?.[1]) || null;
  }

  async health(): Promise<Record<string, unknown> | null> {
    const port = this.localPort();
    if (!port) return null;
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return await response.json() as Record<string, unknown>;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.child && this.child.exitCode === null) {
        this.child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3_000); });
        try {
          if (await Promise.race([this.child.exited, timedOut]) === null) {
            this.child.kill("SIGKILL");
            await this.child.exited;
            throw new Error("Legacy release daemon did not stop gracefully");
          }
        } finally { clearTimeout(timer); }
      }
    } finally {
      try {
        await Promise.all(this.readers);
      } finally {
        try { void this.installer?.stop(true); } finally { rmSync(this.root, { recursive: true, force: true }); }
      }
    }
  }
}
