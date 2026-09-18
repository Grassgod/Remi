// MUL-334：PPE 桌面 QA 登录引导的失败路径回归。
//
// 这两个脚本唯一的职责就是「只对隔离 PPE 签发、注入、撤销一枚短期本地 PAT」，
// 所以最值得钉住的不是成功路径（需要真实 PPE + 212 桌面），而是它拒绝做事的
// 那些时刻：非 PPE Origin、非无认证环境、重复会话、以及撤销失败时有没有留下
// 可恢复信息。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const scriptsDir = resolve(
  import.meta.dir,
  "../../../deploy/zadig/skill/multiremi-web-qa/scripts",
);
const session = join(scriptsDir, "ppe-qa-session.sh");
const mint = join(scriptsDir, "ppe-qa-mint.py");

function runSession(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bash", session, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "ppe-qa-state-"));
}

describe("ppe-qa-session.sh", () => {
  test("refuses every origin that is not an isolated PPE slot", () => {
    const rejected = [
      // 生产：无端口，永远不能走这条路径
      "http://n37-117-209.byted.org",
      "http://n37-117-209.byted.org/agents",
      // 端口在 PPE 区间外
      "http://10.37.117.209:32107",
      "http://10.37.117.209:3000",
      // 协议不符
      "https://10.37.117.209:32101",
      // 主机名不在白名单
      "http://evil.example.com:32101",
      // 端口看着像但拼在主机名里
      "http://10.37.117.209.evil.com:32101",
    ];
    for (const url of rejected) {
      const result = runSession(["login", "MUL-334", url], {
        MULTIREMI_PPE_QA_STATE_DIR: stateDir(),
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("refusing a non-PPE URL");
    }
  });

  test("validates the origin before touching the network", () => {
    // 非法 URL 必须在任何 HTTP 请求之前就被挡掉，否则 CI/离线环境会卡在
    // curl 超时上，真实故障也会被网络错误盖住。
    const started = Date.now();
    const result = runSession(["login", "MUL-334", "http://example.com:32101"], {
      MULTIREMI_PPE_QA_STATE_DIR: stateDir(),
    });
    expect(result.code).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("rejects an unusable issue key", () => {
    const result = runSession(["login", "../../etc", "http://10.37.117.209:32101"], {
      MULTIREMI_PPE_QA_STATE_DIR: stateDir(),
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid issue key");
  });

  test("refuses to start a second session on top of a live one", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "MUL-334.state"), "http://10.37.117.209:32101\ntok_existing\n");
    const result = runSession(["login", "MUL-334", "http://10.37.117.209:32101"], {
      MULTIREMI_PPE_QA_STATE_DIR: dir,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("already exists");
    rmSync(dir, { recursive: true, force: true });
  });

  test("status reports both the active and the empty case", () => {
    const dir = stateDir();
    expect(runSession(["status", "MUL-334"], { MULTIREMI_PPE_QA_STATE_DIR: dir }).stdout)
      .toContain("no active PPE QA session");
    writeFileSync(join(dir, "MUL-334.state"), "http://10.37.117.209:32101\ntok_abc\n");
    const active = runSession(["status", "MUL-334"], { MULTIREMI_PPE_QA_STATE_DIR: dir });
    expect(active.stdout).toContain("origin=http://10.37.117.209:32101");
    expect(active.stdout).toContain("token_id=tok_abc");
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the state file and prints recovery details when revocation fails", () => {
    // 撤销打不通时不能假装收干净了：状态文件要留着，stderr 要带上重试命令，
    // 退出码非零，这样上层才知道还有一枚 PAT 挂在那个 PPE 上。
    const dir = stateDir();
    const state = join(dir, "MUL-334.state");
    // 指向一个不会应答的地址，让 DELETE 必然失败。本地是立刻拒绝，CI 的出口网络
    // 会一路挂到 curl 超时，所以这里显式把超时压到 1 秒，别让默认的 15 秒把用例
    // 拖过 bun 的超时（这正是本用例在 CI 上挂过的原因）。
    writeFileSync(state, "http://10.37.117.209:32106\ntok_unreachable\n");
    const result = runSession(["logout", "MUL-334"], {
      MULTIREMI_PPE_QA_STATE_DIR: dir,
      MULTIREMI_PPE_QA_HTTP_TIMEOUT: "1",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("failed to revoke the PPE PAT");
    expect(result.stderr).toContain("token_id=tok_unreachable");
    expect(result.stderr).toContain("/api/tokens/tok_unreachable");
    expect(existsSync(state)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 15000);

  test("logout is safe when there is nothing to clean up", () => {
    const dir = stateDir();
    const result = runSession(["logout", "MUL-334"], { MULTIREMI_PPE_QA_STATE_DIR: dir });
    expect(result.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ppe-qa-mint.py", () => {
  function runMint(env: Record<string, string>) {
    const proc = Bun.spawnSync(["python3", mint], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: proc.exitCode, stderr: proc.stderr.toString() };
  }

  test("enforces the PPE allowlist even when called directly", () => {
    const dir = stateDir();
    for (const origin of [
      "http://n37-117-209.byted.org",
      "http://127.0.0.1:32101",
      "https://10.37.117.209:32101",
      "http://10.37.117.209:32100",
    ]) {
      const result = runMint({
        MULTIREMI_PPE_QA_ORIGIN: origin,
        MULTIREMI_PPE_QA_STATE: join(dir, "direct.state"),
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("refusing a non-PPE origin");
    }
    expect(existsSync(join(dir, "direct.state"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires both the origin and the state path", () => {
    const result = runMint({ MULTIREMI_PPE_QA_ORIGIN: "", MULTIREMI_PPE_QA_STATE: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("are required");
  });
});
