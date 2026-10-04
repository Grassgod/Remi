import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

// Include directories, even empty ones: a leftover lock directory is a write.
function sshSnapshot(home: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  function visit(relativePath: string): void {
    const path = join(home, relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      snapshot[relativePath] = "directory";
      for (const name of readdirSync(path).sort()) visit(join(relativePath, name));
    } else {
      snapshot[relativePath] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  visit(".multiremi/ssh");
  visit(".ssh");
  return snapshot;
}

it("leaves the process startup home's Mesh and OpenSSH files untouched after daemon steer tests", async () => {
  const home = mkdtempSync(join(tmpdir(), "daemon-real-home-isolation-"));
  const meshRoot = join(home, ".multiremi", "ssh");
  const workspaceRoot = join(meshRoot, "workspaces", "workspace-25bf8e1a2393f110");
  const fixtures: Record<string, string> = {
    [join(workspaceRoot, "config")]: "Host remi-fixture\n  HostName 10.0.0.1\n",
    [join(workspaceRoot, "known_hosts")]: `remi-fixture ssh-ed25519 ${"B".repeat(64)}\n`,
    [join(workspaceRoot, "state.json")]: JSON.stringify({ daemonId: "real-home-sentinel", status: "ready" }),
    [join(meshRoot, "config.d", "x.conf")]: "# Preserve this existing mesh include\n",
    [join(home, ".ssh", "config")]: [
      "# >>> multiremi ssh mesh >>>",
      `Include "${join(meshRoot, "config.d", "*.conf")}"`,
      "# <<< multiremi ssh mesh <<<",
      "Host personal\n  HostName 10.0.0.2\n",
    ].join("\n"),
    [join(home, ".ssh", "authorized_keys")]: `ssh-ed25519 ${"A".repeat(64)} personal\n`,
  };
  try {
    for (const [path, contents] of Object.entries(fixtures)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: 0o600 });
    }
    const before = sshSnapshot(home);
    const child = Bun.spawn([process.execPath, "test", "tests/integration/multiremi-daemon-steer.test.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 45_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Steer child exited ${exitCode}\n${stdout}\n${stderr}`);
      expect(sshSnapshot(home)).toEqual(before);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
