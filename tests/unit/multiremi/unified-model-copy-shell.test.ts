import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const script = resolve(import.meta.dir, "../../../scripts/rehearse-unified-model-copy.sh");
const digest = (char: string) => `${char.repeat(64)}`;
const sha = (char: string) => char.repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mul493-shell-test-")); dirs.push(dir);
  const bin = join(dir, "bin"), backup = join(dir, "backup"), homeCopy = join(dir, "source-home");
  mkdirSync(bin); mkdirSync(backup); mkdirSync(homeCopy);
  writeFileSync(join(homeCopy, "copy-state"), "offline copy only");
  writeFileSync(join(backup, "platform.pgdump"), "fixture dump");
  expect(spawnSync("tar", ["-C", homeCopy, "-czf", join(backup, "api-home.tar.gz"), "."]).status).toBe(0);
  const sums = spawnSync("sha256sum", ["platform.pgdump", "api-home.tar.gz"], { cwd: backup, encoding: "utf8" });
  expect(sums.status).toBe(0);
  writeFileSync(join(backup, "SHA256SUMS"), sums.stdout);
  // Model host identity alongside Docker so root test runners cannot execute
  // a real privileged rehearsal, while the job UID/GID gate remains covered.
  writeFileSync(join(bin, "id"), `#!/usr/bin/env bash
case "$1" in
  -u) printf '%s\\n' "\${COPY_OPERATOR_UID:-1000}";;
  -g) printf '1000\\n';;
  *) exit 2;;
esac
`, { mode: 0o755 });
  // Stub every Docker call. These tests cannot reach any Docker daemon.
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env python3
import os,sys,json
args=sys.argv[1:]
assert args[:2]==['--host','unix:///var/run/docker.sock']
args=args[2:]
with open(os.environ['COPY_DOCKER_CALLS'],'a') as f: f.write(json.dumps(args)+'\\n')
if args[:2]==['image','inspect']:
    if '--format' in args: print('${sha('a')}' if 'candidate@' in args[-1] else '${sha('b')}')
elif args[:2]==['network','create']: print('new-network-id')
elif args[:2]==['volume','create']: print('new-volume-name')
elif args[0]=='run':
    if '-d' in args: print('new-pg-id')
    elif 'scripts/rehearse-unified-model-copy.ts' in args: sys.exit(int(os.environ.get('COPY_CANDIDATE_FAIL','0')))
elif args[0]=='exec':
    if '-i' in args: sys.stdin.buffer.read()
    if 'psql' in args and 'SHOW server_version_num' in args: print('170005')
    elif 'pg_dump' in args: print('stable fixture schema and data')
    elif 'pg_restore' in args and '--list' in args: print('fixture restore list')
`, { mode: 0o755 });
  const args = [script, "--copy-backup-dir", backup, "--work-dir", join(dir, "new-run"),
    "--pg-image", `postgres@sha256:${digest('c')}`, "--pg-major", "17",
    "--candidate-image", `candidate@sha256:${digest('a')}`, "--candidate-sha", sha('a'),
    "--old-image", `old@sha256:${digest('b')}`, "--old-sha", sha('b')];
  const calls = join(dir, "docker-calls.jsonl");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COPY_DOCKER_CALLS: calls };
  return { dir, args, calls, env };
}

test.skipIf(process.platform === "win32")("default plan and missing approval never invoke Docker or create a work directory", () => {
  const f = fixture();
  const plan = spawnSync("bash", f.args, { env: f.env, encoding: "utf8" });
  expect(plan.status, plan.stderr).toBe(0);
  expect(plan.stdout).toContain("PLAN ONLY");
  expect(existsSync(f.calls)).toBe(false);
  expect(existsSync(join(f.dir, "new-run"))).toBe(false);
  const denied = spawnSync("bash", [...f.args, "--execute", "--operator", "Remi-CC"], { env: f.env, encoding: "utf8" });
  expect(denied.status).toBe(2);
  expect(denied.stderr).toContain("approval reference");
  expect(existsSync(f.calls)).toBe(false);
});

test.skipIf(process.platform === "win32")("candidate failure still restores and verifies the copy, cleaning only newly created resources", () => {
  const f = fixture();
  const result = spawnSync("bash", [...f.args, "--execute", "--operator", "Remi-CC", "--approval-ref", "synthetic-approval"], {
    env: { ...f.env, COPY_CANDIDATE_FAIL: "1" }, encoding: "utf8", timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("copy rollback was verified");
  const calls = readFileSync(f.calls, "utf8").trim().split('\n').map(line => JSON.parse(line) as string[]);
  expect(calls.find(a => a[0] === 'network' && a[1] === 'create')).toContain('--internal');
  const candidate = calls.find(a => a.includes('scripts/rehearse-unified-model-copy.ts'))!;
  expect(candidate).toContain('--read-only');
  expect(candidate[candidate.indexOf('--user') + 1]).toBe('1000:1000');
  expect(candidate).toContain('ALL');
  expect(candidate).not.toContain('-p');
  expect(calls.filter(a => a.includes('pg_restore') && a.includes('--exit-on-error')).length).toBe(2);
  expect(calls.filter(a => a.includes('-e')).length).toBe(2); // old startup before + after rollback
  expect(calls.slice(-3)).toEqual([['rm', '-f', 'new-pg-id'], ['volume', 'rm', 'new-volume-name'], ['network', 'rm', 'new-network-id']]);
  const evidence = join(f.dir, 'new-run/evidence');
  expect(readFileSync(join(evidence, 'authorization.txt'), 'utf8')).toContain('operator_uid=1000\noperator_gid=1000');
  expect(readFileSync(join(evidence, 'pre-cutover-data.sha256'), 'utf8')).toBe(readFileSync(join(evidence, 'old-restart-data.sha256'), 'utf8'));
  expect(readFileSync(join(evidence, 'durations-ms.tsv'), 'utf8')).toContain('rollback-restore-db');
});

test.skipIf(process.platform === "win32")("root operator is refused before Docker or work directory creation even with approval", () => {
  const f = fixture();
  const result = spawnSync("bash", [...f.args, "--execute", "--operator", "Remi-CC", "--approval-ref", "synthetic-approval"], {
    env: { ...f.env, COPY_OPERATOR_UID: "0" }, encoding: "utf8",
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("non-root host operator UID");
  expect(existsSync(f.calls)).toBe(false);
  expect(existsSync(join(f.dir, "new-run"))).toBe(false);
});
