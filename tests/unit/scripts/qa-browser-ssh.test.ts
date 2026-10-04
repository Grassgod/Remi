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
//
// MUL-497：桩完全不看默认用户配置，只认 -F 显式加载、且确实定义了该别名的
// workspace config，否则像真 ssh 一样把别名当主机名解析失败。这对应 Agent 以
// root 运行、HOME 不等于 passwd home 时，OpenSSH 读不到 $HOME/.ssh/config 的
// Mesh Include 的真实情况。
const SSH_STUB = `#!/usr/bin/env bash
no_stdin=0
is_probe=0
config=""
host=""
while (( $# > 0 )); do
  case "$1" in
    -F) config="$2"; shift 2 ;;
    -o) shift 2 ;;
    -n) no_stdin=1; shift ;;
    -*) shift ;;
    *) host="$1"; shift; break ;;
  esac
done
if [[ -z "$config" ]] || ! grep -qx "Host $host" "$config"; then
  echo "ssh: Could not resolve hostname $host: Name or service not known" >&2
  exit 255
fi
# 别名探针的远端命令是 \`test -x <wrapper>\`，拆成了多个 argv
[[ "$1" == "test" ]] && is_probe=1
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

  test("loads the workspace config that owns the 212 alias explicitly", () => {
    const { root, meshRoot, binDir } = makeEnv();
    try {
      // 排在前面的 workspace 不含 212：脚本必须用别名所在的那份 config 去 -F，
      // 探针和最终 exec 都一样，不能依赖 OpenSSH 默认的用户配置路径。
      rmSync(join(meshRoot, "workspaces", "ws-1"), { recursive: true });
      mkdirSync(join(meshRoot, "workspaces", "ws-0"), { recursive: true });
      writeFileSync(
        join(meshRoot, "workspaces", "ws-0", "config"),
        "Host other-alias\n  HostName 10.37.117.209\n",
      );
      mkdirSync(join(meshRoot, "workspaces", "ws-2"), { recursive: true });
      writeFileSync(
        join(meshRoot, "workspaces", "ws-2", "config"),
        "Host other-alias-2\n  HostName 10.37.66.8\n\nHost stub-desktop-alias\n  HostName 10.36.0.212\n",
      );

      const check = run(["check"], "", meshRoot, binDir);
      expect(check.code).toBe(0);
      expect(check.stdout).toBe("QA browser ready via stub-desktop-alias\n");

      const exec = run(["authenticate", "MUL-497"], "placeholder", meshRoot, binDir);
      expect(exec.code).toBe(0);
      expect(exec.stdout).toBe("REMOTE_STDIN:placeholder");
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
