import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  prepareDaemonEnvironment,
  resolveNpmGlobalPrefix,
} from "../../../apps/remi/cli/multiremi/environment.js";

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("Multiremi daemon environment", () => {
  test("prepends managed and user-level bins to a minimal service PATH", async () => {
    const home = "/home/runtime-user";
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    const path = await prepareDaemonEnvironment({
      env,
      homeDir: home,
      resolveNpmPrefix: async () => "/opt/npm-global",
    });

    expect(path.split(delimiter)).toEqual([
      join(home, ".remi", "bin"),
      join(home, ".remi", "node", "bin"),
      "/opt/npm-global/bin",
      join(home, ".npm-global", "bin"),
      join(home, ".local", "bin"),
      "/usr/bin",
      "/bin",
    ]);
    expect(env.PATH).toBe(path);
  });

  test("uses an explicit npm prefix without probing npm", async () => {
    const home = "/home/runtime-user";
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      NPM_CONFIG_PREFIX: "~/.custom-npm",
      REMI_HOME: "~/.custom-remi",
    };
    let probes = 0;

    const path = await prepareDaemonEnvironment({
      env,
      homeDir: home,
      resolveNpmPrefix: async () => {
        probes++;
        return "/should/not/be/used";
      },
    });

    expect(probes).toBe(0);
    expect(path.split(delimiter).slice(0, 3)).toEqual([
      join(home, ".custom-remi", "bin"),
      join(home, ".custom-remi", "node", "bin"),
      join(home, ".custom-npm", "bin"),
    ]);
  });

  test("deduplicates PATH and drops empty/current-directory entries", async () => {
    const home = "/home/runtime-user";
    const remiBin = join(home, ".remi", "bin");
    const localBin = join(home, ".local", "bin");
    const env: NodeJS.ProcessEnv = {
      PATH: [localBin, "", ".", "/usr/bin", remiBin, "/usr/bin"].join(delimiter),
    };

    const path = await prepareDaemonEnvironment({
      env,
      homeDir: home,
      resolveNpmPrefix: async () => null,
    });

    expect(path.split(delimiter)).toEqual([
      remiBin,
      join(home, ".remi", "node", "bin"),
      join(home, ".npm-global", "bin"),
      localBin,
      "/usr/bin",
    ]);
  });

  test("resolves the configured npm global prefix without a login shell", async () => {
    tmp = mkdtempSync(join(tmpdir(), "remi-npm-prefix-"));
    const npm = join(tmp, "npm");
    writeFileSync(npm, "#!/bin/sh\nprintf '/srv/npm-prefix\\n'\n");
    chmodSync(npm, 0o755);

    await expect(resolveNpmGlobalPrefix({ PATH: tmp })).resolves.toBe("/srv/npm-prefix");
  });

  test("makes an npm-global tool directly spawnable by Agent Plugin hooks", async () => {
    tmp = mkdtempSync(join(tmpdir(), "remi-plugin-tool-"));
    const npmBin = join(tmp, ".npm-global", "bin");
    const onePassport = join(npmBin, "1passport");
    mkdirSync(npmBin, { recursive: true });
    writeFileSync(onePassport, "#!/bin/sh\nprintf '1passport-ready\\n'\n");
    chmodSync(onePassport, 0o755);
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    await prepareDaemonEnvironment({
      env,
      homeDir: tmp,
      resolveNpmPrefix: async () => null,
    });
    const proc = Bun.spawn(["1passport"], {
      env: { PATH: env.PATH! },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("1passport-ready\n");
  });
});
