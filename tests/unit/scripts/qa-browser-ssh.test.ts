// MUL-334：qa-browser-ssh.sh 的凭证管道回归。
//
// 这个脚本在真正执行远端命令之前，会先用一次 ssh 探测可用的 212 别名。凭证是
// 通过管道喂进来的（authenticate / ppe-authenticate），而 ssh 会把本地 stdin
// 转发给远端命令——探针不加 `-n` 就会把管道抽干，凭证永远到不了最后那次 exec。
// 这里用桩 ssh 忠实模拟「带 -n 不读 stdin / 不带 -n 读 stdin」的差异，钉住
// 「管道内容必须原样到达最终 exec」这一条。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const script = resolve(
  import.meta.dir,
  "../../../deploy/zadig/skill/multiremi-web-qa/scripts/qa-browser-ssh.sh",
);

// 桩 ssh：带 -n 时不碰 stdin；不带 -n 时像真 ssh 一样把 stdin 读干净并转发。
// 最终那次调用（远端命令不是 `test`）把收到的 stdin 原样吐到 stdout，
// 测试据此判断凭证有没有活着走完全程。
const SSH_STUB = `#!/usr/bin/env bash
no_stdin=0
is_probe=0
for arg in "$@"; do
  [[ "$arg" == "-n" ]] && no_stdin=1
  # 别名探针的远端命令是 \`test -x <wrapper>\`，拆成了多个 argv
  [[ "$arg" == "test" ]] && is_probe=1
done
if (( is_probe == 1 )); then
  # 真 ssh 会把本地 stdin 转发给远端命令，所以不带 -n 时必须把管道读干净。
  if (( no_stdin == 0 )); then
    cat >/dev/null
  fi
  exit 0
fi
# 最终执行：把拿到的 stdin 回显出来
printf 'REMOTE_STDIN:'
cat
`;

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "qa-browser-ssh-"));
  const meshRoot = join(root, "mesh");
  mkdirSync(join(meshRoot, "workspaces", "ws-1"), { recursive: true });
  writeFileSync(
    join(meshRoot, "workspaces", "ws-1", "config"),
    "Host stub-desktop-alias\n  HostName 10.36.0.212\n",
  );
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const sshStub = join(binDir, "ssh");
  writeFileSync(sshStub, SSH_STUB);
  chmodSync(sshStub, 0o755);
  return { root, meshRoot, binDir };
}

function run(args: string[], stdin: string, meshRoot: string, binDir: string) {
  const proc = Bun.spawnSync(["bash", script, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      MULTIREMI_SSH_MESH_ROOT: meshRoot,
    },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("qa-browser-ssh.sh", () => {
  test("delivers piped credentials past the alias probe", () => {
    const { root, meshRoot, binDir } = makeEnv();
    try {
      // 探针跑在前面；凭证必须完整到达最终 exec，而不是被探针吃掉。
      const result = run(
        ["ppe-authenticate", "MUL-334", "http://10.37.117.209:32101"],
        "mul_secret_placeholder_value",
        meshRoot,
        binDir,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("REMOTE_STDIN:mul_secret_placeholder_value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delivers piped credentials for the production authenticate path too", () => {
    const { root, meshRoot, binDir } = makeEnv();
    try {
      const result = run(
        ["authenticate", "MUL-334", "http://n37-117-209.byted.org"],
        "production_placeholder_value",
        meshRoot,
        binDir,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("REMOTE_STDIN:production_placeholder_value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check stays a pure probe and reports the resolved alias", () => {
    const { root, meshRoot, binDir } = makeEnv();
    try {
      const result = run(["check"], "", meshRoot, binDir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("stub-desktop-alias");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a missing mesh configuration instead of silently proceeding", () => {
    const { root, binDir } = makeEnv();
    try {
      const result = run(["check"], "", join(root, "absent"), binDir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("SSH Mesh configuration is missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
