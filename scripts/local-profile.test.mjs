import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(join(repository, 'scripts/local-profile.mjs'), 'utf8');
const OLD_REF = 'a'.repeat(40);
const NEW_REF = 'b'.repeat(40);

// Every child runs a copy of the real CLI in a temporary repository. Patch the
// process boundary before its ESM imports load: no real Git, Docker, tar, or
// network request can run, including for deploy/stop/up failure scenarios.
const mockSource = String.raw`
import childProcess from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const succeed = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = () => ({ status: 1, stdout: '', stderr: 'Injected test failure' });
childProcess.spawnSync = (command, args, options = {}) => {
  const metadataPath = join(process.env.TEST_PROFILE_ROOT, 'deployment.json');
  const selection = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
  appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({
    command, args,
    // Log only names, never inherited values or the generated credentials.
    environmentKeys: Object.keys(options.env || {}),
    selectedRef: selection?.ref ?? null,
    selectedProfile: selection?.profile ?? null,
  }) + '\n');
  if (command === 'git' && args[0] === 'rev-parse') return succeed(process.env.TEST_COMMIT + '\n');
  if (command === 'git' && args[0] === 'archive') {
    writeFileSync(args[args.indexOf('--output') + 1], 'Test archive');
    return succeed();
  }
  if (command === 'tar' && args.includes('-xf')) {
    const source = args[args.indexOf('-C') + 1];
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"version":"0.2.60"}\n');
    return succeed();
  }
  if (command !== 'docker') throw new Error('Unmocked command: ' + command);
  if (process.env.TEST_FAIL === 'config' && args.includes('config')) return fail();
  if (process.env.TEST_FAIL === 'build' && args.includes('build')) return fail();
  if (args.includes('pg_dump')) {
    writeSync(options.stdio[1], 'PGDMP test fixture');
    return succeed();
  }
  if (args.includes('tar')) {
    if (process.env.TEST_FAIL === 'tar') return fail();
    writeSync(options.stdio[1], 'Home archive test fixture');
    return succeed();
  }
  // In particular, ps returns no running services. active.json must still
  // protect the data when an already stopped deployment is upgraded.
  return succeed();
};
for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw new Error('Unmocked process API: ' + name); };
}
syncBuiltinESMExports();
globalThis.fetch = async () => ({ status: 200 });
`;

function fixture(t) {
  const temporaryParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryParent, 'remi-local-profile-test-'));
  t.after(() => {
    // The Windows cleanup target is verified before recursive deletion. Any
    // test-created junction points only at another directory inside this root.
    const target = realpathSync(root);
    assert.equal(dirname(target), temporaryParent);
    assert.match(relative(temporaryParent, target), /^remi-local-profile-test-[^/\\]+$/u);
    rmSync(target, { recursive: true, force: true });
  });
  const source = join(root, 'source repo 中文');
  const profilesRoot = join(root, 'profiles with spaces');
  const script = join(source, 'scripts/local-profile.mjs');
  const mock = join(root, 'mock-process.mjs');
  const log = join(root, 'commands.jsonl');
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(source, 'deploy/docker'), { recursive: true });
  writeFileSync(script, scriptSource);
  writeFileSync(join(source, 'package.json'), '{"version":"0.2.60"}\n');
  for (const name of ['compose.local.yml', 'compose.local-dev.yml']) {
    copyFileSync(join(repository, 'deploy/docker', name), join(source, 'deploy/docker', name));
  }
  writeFileSync(mock, mockSource);

  function run(profile, action, { args = [], commit = OLD_REF, fail = '', environment = {}, profileBase = profilesRoot } = {}) {
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, script, profile, action, ...args], {
      env: {
        ...process.env,
        ...environment,
        NODE_OPTIONS: '',
        REMI_PROFILES_ROOT: profileBase,
        TEST_PROFILE_ROOT: join(profileBase, profile),
        TEST_COMMAND_LOG: log,
        TEST_COMMIT: commit,
        TEST_FAIL: fail,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    assert.ifError(result.error);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls };
  }
  const profileRoot = (profile = 'stable') => join(profilesRoot, profile);
  const readProfile = (name, profile = 'stable') => JSON.parse(readFileSync(join(profileRoot(profile), name), 'utf8'));
  function activate() {
    succeeds(run('stable', 'prepare'));
    succeeds(run('stable', 'up'));
    assert.equal(readProfile('active.json').ref, OLD_REF);
  }
  return { root, source, profilesRoot, profileRoot, readProfile, run, activate };
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
}

const dockerCalls = (result) => result.calls.filter((call) => call.command === 'docker');
const isAction = (action) => (call) => call.command === 'docker' && call.args.includes(action);

test('token signs a 24-hour local session with only the selected profile secret', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare'));
  succeeds(f.run('dev', 'prepare'));
  const stableEnv = parseEnv(readFileSync(join(f.profileRoot(), 'api.env'), 'utf8'));
  const devEnv = parseEnv(readFileSync(join(f.profileRoot('dev'), 'api.env'), 'utf8'));
  const before = Math.floor(Date.now() / 1000);
  const result = f.run('stable', 'token', { environment: { JWT_SECRET: 'wrong-shell-secret' } });
  const after = Math.floor(Date.now() / 1000);
  succeeds(result);
  assert.equal(result.calls.length, 0, 'Issuing a session must not invoke Docker or Git');
  const [header, claims, signature, extra] = result.stdout.trim().split('.');
  assert.equal(extra, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.sub, 'local');
  assert.ok(payload.iat >= before && payload.iat <= after);
  assert.equal(payload.exp - payload.iat, 24 * 60 * 60);
  const input = `${header}.${claims}`;
  assert.ok(signature === createHmac('sha256', stableEnv.JWT_SECRET).update(input).digest('base64url'));
  assert.ok(signature !== createHmac('sha256', devEnv.JWT_SECRET).update(input).digest('base64url'));
  assert.ok(!result.stdout.includes(stableEnv.MULTIREMI_TOKEN));
  assert.ok(!result.stdout.includes(stableEnv.JWT_SECRET));
});

test('token reads quoted profile secrets and fails without a signing secret', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const envPath = join(f.profileRoot('dev'), 'api.env');
  writeFileSync(envPath, 'MULTIREMI_TOKEN=never-output-master\nJWT_SECRET="test-only-quoted-secret"\n');
  const result = f.run('dev', 'token');
  succeeds(result);
  const [header, claims, signature] = result.stdout.trim().split('.');
  assert.ok(signature === createHmac('sha256', 'test-only-quoted-secret').update(`${header}.${claims}`).digest('base64url'));
  writeFileSync(envPath, 'MULTIREMI_TOKEN=never-output-master\n');
  const missing = f.run('dev', 'token', { environment: { JWT_SECRET: 'wrong-shell-secret' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No local profile JWT_SECRET/u);
  assert.equal(missing.stdout, '');
  assert.equal(missing.calls.length, 0);
});

test('shell profile variables and remote Docker settings cannot override the selected profile', (t) => {
  const f = fixture(t);
  const poisoned = {
    REMI_API_ENV_FILE: '/wrong/profile.env', REMI_SOURCE_DIR: '/wrong/source', REMI_API_BIND_PORT: '19999',
    REMI_API_IMAGE: 'wrong:latest', MULTIREMI_PUBLIC_URL: 'http://wrong.invalid', POSTGRES_PASSWORD: 'test-only',
    COMPOSE_FILE: '/wrong/compose.yml', COMPOSE_PROJECT_NAME: 'remi-stable',
    DOCKER_HOST: 'tcp://wrong.invalid:2375', DOCKER_CONTEXT: 'remote-test', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/wrong/certs',
    remi_web_bind_port: '29999', Compose_Profiles: 'wrong',
  };
  const result = f.run('dev', 'prepare', { args: ['--ref', 'HEAD'], environment: poisoned });
  succeeds(result);
  const calls = dockerCalls(result);
  assert.equal(calls.length, 1);
  for (const call of calls) {
    const passed = new Set(call.environmentKeys.map((key) => key.toLowerCase()));
    for (const key of Object.keys(poisoned)) assert.ok(!passed.has(key.toLowerCase()), `${key} must not reach Docker`);
    assert.deepEqual(call.args.slice(0, 5), ['--context', process.platform === 'win32' ? 'desktop-linux' : 'default', 'compose', '-p', 'remi-dev']);
    assert.equal(call.args[call.args.indexOf('--env-file') + 1], join(f.profileRoot('dev'), 'compose.env'));
    assert.deepEqual(call.args.slice(-2), ['config', '--quiet']);
  }
  assert.equal(f.readProfile('deployment.json', 'dev').source, f.source);
});

test('copied profile metadata cannot make a dev command operate on stable', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const path = join(f.profileRoot('dev'), 'deployment.json');
  writeFileSync(path, JSON.stringify({ ...f.readProfile('deployment.json', 'dev'), profile: 'stable' }));
  const result = f.run('dev', 'build');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /metadata does not match/u);
  assert.equal(dockerCalls(result).length, 0);
});

test('profiles cannot be initialized in the source repository', (t) => {
  const f = fixture(t);
  const inside = join(f.source, 'new', 'profiles');
  const result = f.run('dev', 'prepare', { profileBase: inside });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source repository/u);
  assert.equal(result.calls.length, 0);
  assert.ok(!existsSync(inside));
});

test('source-directory rejection resolves a junction or symlink before creating profiles', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'source alias');
  symlinkSync(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run('dev', 'prepare', { profileBase: join(alias, 'new', 'profiles') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source repository/u);
  assert.equal(result.calls.length, 0);
  assert.ok(!existsSync(join(f.source, 'new')));
});

test('failed prepare restores the previous selection and Compose files byte for byte', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare'));
  const names = ['deployment.json', 'compose.env', 'compose.yml'];
  const before = new Map(names.map((name) => [name, readFileSync(join(f.profileRoot(), name))]));
  const result = f.run('stable', 'prepare', { args: ['--ref', 'new-ref'], commit: NEW_REF, fail: 'config' });
  assert.notEqual(result.status, 0);
  assert.equal(dockerCalls(result).find(isAction('config'))?.selectedRef, NEW_REF);
  for (const [name, contents] of before) {
    assert.ok(readFileSync(join(f.profileRoot(), name)).equals(contents), `${name} was not restored`);
  }
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
});

test('a failed first prepare does not leave an executable deployment selection', (t) => {
  const f = fixture(t);
  const result = f.run('dev', 'prepare', { fail: 'config' });
  assert.notEqual(result.status, 0);
  assert.ok(dockerCalls(result).some(isAction('config')));
  for (const name of ['deployment.json', 'compose.env', 'compose.yml', 'compose.dev.yml']) {
    assert.ok(!existsSync(join(f.profileRoot('dev'), name)), `${name} survived failed validation`);
  }
});

test('an activated profile is still backed up before upgrading after stop', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'stop'));
  const result = f.run('stable', 'deploy', { args: ['--ref', 'new-ref'], commit: NEW_REF });
  succeeds(result);
  const calls = dockerCalls(result);
  const build = calls.findIndex(isAction('build'));
  const stop = calls.findIndex(isAction('stop'));
  const dump = calls.findIndex(isAction('pg_dump'));
  const archive = calls.findIndex(isAction('tar'));
  const launch = calls.findIndex((call) => isAction('up')(call) && call.selectedRef === NEW_REF);
  assert.ok(build >= 0 && build < stop && stop < dump && dump < archive && archive < launch);
  assert.equal(calls[dump].selectedRef, OLD_REF);
  assert.equal(calls[archive].selectedRef, OLD_REF);
  assert.ok(calls[archive].args.includes('type=volume,src=remi-stable_api-home,dst=/backup,readonly'));
  assert.ok(calls[archive].args.includes('none'));
  const backups = readdirSync(join(f.profileRoot(), 'backups'));
  assert.equal(backups.length, 1);
  const saved = join(f.profileRoot(), 'backups', backups[0]);
  assert.ok(existsSync(join(saved, 'complete.json')));
  for (const name of ['postgres.dump', 'api-home.tar']) assert.ok(statSync(join(saved, name)).size > 0);
  assert.equal(JSON.parse(readFileSync(join(saved, 'deployment.json'), 'utf8')).ref, OLD_REF);
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
});

test('a failed home archive leaves no completion marker and never starts the new version', (t) => {
  const f = fixture(t);
  f.activate();
  const result = f.run('stable', 'deploy', { args: ['--ref', 'new-ref'], commit: NEW_REF, fail: 'tar' });
  assert.notEqual(result.status, 0);
  const calls = dockerCalls(result);
  assert.ok(calls.some(isAction('pg_dump')));
  assert.ok(calls.some(isAction('tar')));
  assert.ok(!calls.some((call) => isAction('up')(call) && call.selectedRef === NEW_REF));
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  const backups = readdirSync(join(f.profileRoot(), 'backups'));
  assert.equal(backups.length, 1);
  assert.ok(!existsSync(join(f.profileRoot(), 'backups', backups[0], 'complete.json')));
});

test('an activated profile cannot bypass deploy using prepare or a changed up selection', (t) => {
  const f = fixture(t);
  f.activate();
  const prepare = f.run('stable', 'prepare', { commit: NEW_REF });
  assert.notEqual(prepare.status, 0);
  assert.match(prepare.stderr, /upgraded with deploy/u);
  assert.equal(prepare.calls.length, 0);
  const path = join(f.profileRoot(), 'deployment.json');
  writeFileSync(path, JSON.stringify({ ...f.readProfile('deployment.json'), ref: NEW_REF }));
  const up = f.run('stable', 'up');
  assert.notEqual(up.status, 0);
  assert.match(up.stderr, /use deploy/u);
  assert.equal(dockerCalls(up).length, 0);
});

test('unsupported or misleading ref arguments fail before running external commands', (t) => {
  const f = fixture(t);
  for (const [profile, action, args] of [
    ['stable', 'build', ['--ref', 'HEAD']],
    ['stable', 'up', ['--ref', 'HEAD']],
    ['stable', 'prepare', ['--ref']],
    ['dev', 'prepare', ['--ref', 'old-release']],
    ['dev', 'deploy', ['--ref', OLD_REF]],
    ['dev', 'prepare', ['--unexpected', 'value']],
  ]) {
    const result = f.run(profile, action, { args });
    assert.notEqual(result.status, 0, `${profile} ${action} accepted invalid ref arguments`);
    assert.match(result.stderr, /--ref|working tree/u);
    assert.equal(result.calls.length, 0);
  }
});

test('stable LAN selection publishes both services and survives upgrades without affecting dev', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare', { args: ['--lan-host', '192.168.40.12'] }));
  succeeds(f.run('stable', 'up'));
  succeeds(f.run('stable', 'deploy', { commit: NEW_REF }));
  const stable = parseEnv(readFileSync(join(f.profileRoot(), 'compose.env'), 'utf8'));
  assert.equal(stable.REMI_BIND_ADDRESS, '0.0.0.0');
  assert.equal(stable.REMI_PUBLIC_URL, 'http://192.168.40.12:13000');
  assert.equal(stable.REMI_PUBLIC_WS_URL, 'ws://192.168.40.12:16120/ws');
  assert.equal(stable.REMI_DAEMON_SERVER_URL, 'http://192.168.40.12:16120');
  assert.deepEqual(f.readProfile('active.json').network, { hostname: '192.168.40.12', bindAddress: '0.0.0.0' });
  assert.match(f.run('stable', 'status').stdout, /http:\/\/192\.168\.40\.12:13000/u);
  succeeds(f.run('dev', 'prepare'));
  const dev = parseEnv(readFileSync(join(f.profileRoot('dev'), 'compose.env'), 'utf8'));
  assert.equal(dev.REMI_BIND_ADDRESS, '127.0.0.1');
  assert.equal(dev.REMI_PUBLIC_URL, 'http://localhost:14000');
  assert.equal(dev.REMI_DAEMON_SERVER_URL, 'http://localhost:16220');
});

test('a failed LAN rebuild leaves the active loopback configuration untouched', (t) => {
  const f = fixture(t);
  f.activate();
  const original = readFileSync(join(f.profileRoot(), 'compose.env'));
  const result = f.run('stable', 'deploy', { args: ['--lan-host', '10.20.30.40'], fail: 'build', commit: NEW_REF });
  assert.notEqual(result.status, 0);
  assert.ok(readFileSync(join(f.profileRoot(), 'compose.env')).equals(original));
  assert.equal(f.readProfile('active.json').network.bindAddress, '127.0.0.1');
  assert.ok(!result.calls.some(isAction('stop')));
});

test('LAN settings reject unreachable bind values and never expose dev', (t) => {
  const f = fixture(t);
  for (const host of ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'http://192.168.1.2', '192.168.1.300', '172.32.1.2']) {
    const result = f.run('stable', 'prepare', { args: ['--lan-host', host] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private IPv4/u);
    assert.equal(result.calls.length, 0);
  }
  const dev = f.run('dev', 'deploy', { args: ['--lan-host', '192.168.1.2'] });
  assert.notEqual(dev.status, 0);
  assert.match(dev.stderr, /only valid for stable/u);
  assert.equal(dev.calls.length, 0);
});
