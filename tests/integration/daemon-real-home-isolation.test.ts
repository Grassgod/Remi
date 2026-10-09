import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

// Include directories, even empty ones: a leftover lock directory is a write.
function homeSnapshot(home: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  function visit(relativePath: string): void {
    const path = join(home, relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      snapshot[relativePath] = "directory";
      for (const name of readdirSync(path).sort()) visit(join(relativePath, name));
    } else if (stat.isSymbolicLink()) {
      snapshot[relativePath] = `symlink:${readlinkSync(path)}`;
    } else if (stat.isFile()) {
      snapshot[relativePath] = createHash("sha256").update(readFileSync(path)).digest("hex");
    } else {
      snapshot[relativePath] = `special:${stat.mode}`;
    }
  }
  for (const name of readdirSync(home).sort()) visit(name);
  return snapshot;
}

function childEnv(home: string, cacheRoot: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cacheRoot, "transpiler"),
    BUN_INSTALL_CACHE_DIR: join(cacheRoot, "install") };
  for (const name of Object.keys(env)) {
    if (name.startsWith("XDG_")) delete (env as NodeJS.ProcessEnv)[name];
  }
  return env;
}

it("leaves the entire startup home untouched after daemon and archive tests", async () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-real-home-isolation-"));
  const home = join(root, "home");
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
    [join(home, ".multiremi", "outbox", "sentinel")]: "preserve outbox\n",
    [join(home, ".remi", "multiremi", "session-archives", "sentinel")]: "preserve archives\n",
    [join(home, ".remi", "multiremi", "workspaces", "sentinel")]: "preserve workspaces\n",
  };
  try {
    for (const [path, contents] of Object.entries(fixtures)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: 0o600 });
    }
    const before = homeSnapshot(home);
    const files = [
      "tests/integration/multiremi-daemon-steer.test.ts",
      "tests/integration/multiremi-approval-e2e.test.ts",
      "tests/integration/multiremi-drain-outbox.test.ts",
    ];
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    let budgetExpired = false;
    const timeout = setTimeout(() => {
      budgetExpired = true;
      for (const child of children) if (child.exitCode === null) child.kill();
    }, 90_000);
    try {
      const runChild = async (file: string) => {
        if (budgetExpired) throw new Error("Daemon/archive children exceeded the shared 90s budget");
        const startedAt = performance.now();
        const child = Bun.spawn([process.execPath, "test", file], {
          cwd: REPO_ROOT, env: childEnv(home, join(root, "cache")),
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        children.push(child);
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        console.info(`[home-isolation] ${file}: ${(performance.now() - startedAt).toFixed(0)}ms, exit=${exitCode}`);
        return { file, exitCode, stdout, stderr };
      };
      const results = await Promise.all(files.map(runChild));
      if (budgetExpired) throw new Error("Daemon/archive children exceeded the shared 90s budget");
      const failures = results.filter(result => result.exitCode !== 0);
      if (failures.length) throw new Error(failures.map(result =>
        `${result.file} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`).join("\n"));
      expect(homeSnapshot(home)).toEqual(before);
    } finally {
      clearTimeout(timeout);
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map(child => child.exited));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it("the whole-home snapshot detects added, changed and deleted files", async () => {
  const root = mkdtempSync(join(tmpdir(), "home-snapshot-canary-"));
  const home = join(root, "home");
  mkdirSync(home);
  try {
    writeFileSync(join(home, "existing"), "before");
    const before = homeSnapshot(home);
    const child = Bun.spawn([process.execPath, "-e", `
      import { homedir } from "node:os";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      mkdirSync(join(homedir(), ".remi"));
      writeFileSync(join(homedir(), ".remi", "canary"), "canary");
      writeFileSync(join(homedir(), "existing"), "after");
    `], { cwd: REPO_ROOT, env: childEnv(home, join(root, "cache")), stdout: "pipe", stderr: "pipe" });
    const [exitCode, , stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const after = homeSnapshot(home);
    expect(after).not.toEqual(before);
    expect(after[join(".remi", "canary")]).toBeDefined();
    expect(after.existing).not.toBe(before.existing);
    rmSync(join(home, "existing"));
    expect(homeSnapshot(home).existing).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);
