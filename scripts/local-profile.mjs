#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, delimiter, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { isIPv4 } from 'node:net';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profilesRoot = resolve(process.env.REMI_PROFILES_ROOT || join(homedir(), '.remi', 'profiles'));
const settings = {
  stable: { webPort: 13000, apiPort: 16120, hostname: '127.0.0.1', backgroundJobs: '1' },
  dev: { webPort: 14000, apiPort: 16220, hostname: 'localhost', backgroundJobs: '0' },
};

function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}

function validateProfilesRoot() {
  const path = relative(realpathSync(repository), canonicalPath(profilesRoot));
  if (!path || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))) {
    throw new Error('REMI_PROFILES_ROOT must be outside the source repository, including through symbolic links');
  }
}

function execute(command, args, options = {}) {
  const environment = { ...process.env };
  if (command === 'docker') {
    // Shell variables override Compose --env-file. Never let a previous profile
    // or a remote Docker session silently redirect this local operation.
    for (const key of Object.keys(environment)) {
      if (/^(REMI_|MULTIREMI_|POSTGRES_|COMPOSE_)/iu.test(key)
        || /^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDX_CONFIG|BUILDX_BUILDER|BUILDKIT_HOST)$/iu.test(key)) delete environment[key];
    }
    args = ['--context', process.platform === 'win32' ? 'desktop-linux' : 'default', ...args];
  }
  // Docker Desktop's credential helper is not always on a PowerShell PATH.
  if (process.platform === 'win32') {
    const helpers = join(process.env.ProgramFiles || 'C:/Program Files', 'Docker', 'Docker', 'resources', 'bin');
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') || 'Path';
    environment[pathKey] = `${helpers}${delimiter}${environment[pathKey] || ''}`;
  }
  const result = spawnSync(command, args, { cwd: repository, env: environment, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ''} failed (${result.status})`);
  return typeof result.stdout === 'string' ? result.stdout.trim() : result.stdout;
}

function capture(command, args) {
  return execute(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function saveJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function secret() { return randomBytes(32).toString('hex'); }

function validateLanHost(hostname) {
  const [a, b] = hostname.split('.').map(Number);
  if (!isIPv4(hostname) || !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error('--lan-host must be a private IPv4 address of this machine, not a URL, loopback, or 0.0.0.0');
  }
  return hostname;
}

function networkSettings(deployment) {
  return deployment.network ?? { hostname: settings[deployment.profile].hostname, bindAddress: '127.0.0.1' };
}

function envValue(value) {
  const text = String(value).replaceAll('\\', '/');
  if (/[\r\n']/u.test(text)) throw new Error('Profile paths and values cannot contain newlines or single quotes');
  return `'${text}'`;
}

function initialize(profile) {
  const root = join(profilesRoot, profile);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'backups'), { recursive: true, mode: 0o700 });
  const credentials = join(root, 'credentials.json');
  if (!existsSync(credentials)) {
    saveJson(credentials, { databasePassword: secret() });
  }
  const apiEnv = join(root, 'api.env');
  if (!existsSync(apiEnv)) {
    writeFileSync(apiEnv, [
      '# Local profile credentials. Keep outside Git; never copy stable credentials into dev.',
      `MULTIREMI_TOKEN=${secret()}`, `JWT_SECRET=${secret()}`, `MULTIREMI_SHARE_SECRET=${secret()}`,
      `MULTIREMI_SCM_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
      'MULTIREMI_ALLOW_EMAIL_CODE_LOGIN=0', 'ANALYTICS_DISABLED=true', '',
    ].join('\n'), { mode: 0o600 });
  }
  return root;
}

function composeArgs(root, ...args) {
  const deployment = readJson(join(root, 'deployment.json'));
  if (!Object.hasOwn(settings, deployment.profile) || resolve(root) !== resolve(profilesRoot, deployment.profile)) {
    throw new Error('Profile metadata does not match its directory; refusing to operate on another environment');
  }
  const flags = ['compose', '-p', `remi-${deployment.profile}`, '--env-file', join(root, 'compose.env'), '-f', join(root, 'compose.yml')];
  if (deployment.profile === 'dev') flags.push('-f', join(root, 'compose.dev.yml'));
  return [...flags, ...args];
}

function compose(root, ...args) { return execute('docker', composeArgs(root, ...args)); }

function writeComposeEnvironment(root, deployment) {
  const config = settings[deployment.profile];
  const network = networkSettings(deployment);
  const credentials = readJson(join(root, 'credentials.json'));
  const variables = {
    REMI_PROFILE: deployment.profile,
    POSTGRES_PASSWORD: credentials.databasePassword,
    REMI_API_ENV_FILE: join(root, 'api.env'),
    REMI_SOURCE_DIR: deployment.source,
    REMI_API_IMAGE: deployment.apiImage,
    REMI_WEB_IMAGE: deployment.webImage,
    REMI_BUILD_REF: deployment.ref,
    REMI_APP_VERSION: deployment.version,
    REMI_PUBLIC_URL: `http://${network.hostname}:${config.webPort}`,
    REMI_PUBLIC_WS_URL: `ws://${network.hostname}:${config.apiPort}/ws`,
    REMI_DAEMON_SERVER_URL: `http://${network.hostname}:${config.apiPort}`,
    REMI_BIND_ADDRESS: network.bindAddress,
    REMI_API_BIND_PORT: config.apiPort,
    REMI_WEB_BIND_PORT: config.webPort,
    REMI_BACKGROUND_JOBS: config.backgroundJobs,
  };
  writeFileSync(join(root, 'compose.env'), Object.entries(variables).map(([key, value]) => `${key}=${envValue(value)}`).join('\n') + '\n', { mode: 0o600 });
}

function prepare(profile, ref, lanHost) {
  const root = initialize(profile);
  const previous = existsSync(join(root, 'deployment.json')) ? readJson(join(root, 'deployment.json')) : { profile };
  const network = lanHost
    ? { hostname: validateLanHost(lanHost), bindAddress: '0.0.0.0' }
    : profile === 'dev' ? { hostname: settings.dev.hostname, bindAddress: '127.0.0.1' } : networkSettings(previous);
  const managedFiles = ['deployment.json', 'compose.env', 'compose.yml', 'compose.dev.yml'];
  const original = new Map(managedFiles.map((name) => [name, existsSync(join(root, name)) ? readFileSync(join(root, name)) : null]));
  const sha = capture('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('A full Git commit is required');
  let source = repository;
  if (profile === 'stable') {
    source = join(root, 'releases', sha);
    if (!existsSync(join(source, '.remi-profile-source'))) {
      mkdirSync(source, { recursive: true });
      const archive = join(root, 'releases', `${sha}.tar`);
      execute('git', ['archive', '--format=tar', '--output', archive, sha]);
      execute('tar', ['-xf', archive, '-C', source]);
      writeFileSync(join(source, '.remi-profile-source'), `${sha}\n`);
    }
  }
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  const buildId = profile === 'stable' ? sha : 'working-tree';
  const deployment = {
    profile, ref: sha, source, network, version: `${version}-${profile}.${sha.slice(0, 8)}`,
    apiImage: `remi-api:${profile}-${buildId}`, webImage: `remi-web:${profile}-${buildId}`,
  };
  copyFileSync(join(repository, 'deploy/docker/compose.local.yml'), join(root, 'compose.yml'));
  if (profile === 'dev') copyFileSync(join(repository, 'deploy/docker/compose.local-dev.yml'), join(root, 'compose.dev.yml'));
  saveJson(join(root, 'deployment.json'), deployment);
  writeComposeEnvironment(root, deployment);
  // Quiet validation: docker compose config without -q prints environment secrets.
  try { compose(root, 'config', '--quiet'); }
  catch (error) {
    for (const [name, contents] of original) {
      if (contents) writeFileSync(join(root, name), contents);
      else if (existsSync(join(root, name))) unlinkSync(join(root, name));
    }
    throw error;
  }
  return root;
}

function backup(root) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backupDir = join(root, 'backups', timestamp);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const name of ['api.env', 'credentials.json', 'compose.env', 'deployment.json', 'active.json', 'compose.yml', 'compose.dev.yml']) {
    if (existsSync(join(root, name))) copyFileSync(join(root, name), join(backupDir, name));
  }
  const db = openSync(join(backupDir, 'postgres.dump'), 'w', 0o600);
  try {
    execute('docker', composeArgs(root, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'multiremi', '-d', 'multiremi', '-Fc'), { stdio: ['ignore', db, 'inherit'] });
  } finally { closeSync(db); }
  const files = openSync(join(backupDir, 'api-home.tar'), 'w', 0o600);
  try {
    const deployment = readJson(join(root, 'deployment.json'));
    execute('docker', ['run', '--rm', '--network', 'none', '--mount', `type=volume,src=remi-${deployment.profile}_api-home,dst=/backup,readonly`, '--entrypoint', 'tar', deployment.apiImage, '-C', '/backup', '-cf', '-', '.'], { stdio: ['ignore', files, 'inherit'] });
  } finally { closeSync(files); }
  saveJson(join(backupDir, 'complete.json'), { completedAt: new Date().toISOString() });
  console.log(`Backup: ${backupDir}`);
  return backupDir;
}

async function status(root) {
  if (!existsSync(join(root, 'deployment.json'))) {
    console.log('Profile has not been prepared. Run prepare (then build/up), or deploy.');
    return;
  }
  const deployment = readJson(join(root, 'deployment.json'));
  const config = settings[deployment.profile];
  console.log(`${deployment.profile}: http://${networkSettings(deployment).hostname}:${config.webPort}`);
  console.log(`Source: ${deployment.source}\nCommit: ${deployment.ref}\nConfiguration: ${root}`);
  compose(root, 'ps');
  for (const [service, url] of [['api', `http://127.0.0.1:${config.apiPort}/readyz`], ['web', `http://127.0.0.1:${config.webPort}/login`]]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      console.log(`${service}: HTTP ${response.status}`);
    } catch { console.log(`${service}: unavailable`); }
  }
}

async function main() {
  const [profile, action, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(settings, profile) || !action || action === '--help') {
    console.log('Usage: node scripts/local-profile.mjs <stable|dev> <prepare|build|deploy|up|stop|status|logs|watch|backup|token> [--ref <commit>] [--lan-host <private IPv4>]');
    console.log('stable deploy: archive a fixed commit, build, back up existing data, then update containers.');
    console.log('dev deploy + dev watch: build current source, then sync changes without touching stable.');
    console.log('stable --lan-host: bind Web/API to 0.0.0.0 and persist the advertised LAN address across deploys.');
    return;
  }
  validateProfilesRoot();
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--ref', '--lan-host'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(flags, key)) {
      throw new Error('Only --ref <commit> and --lan-host <private IPv4> are supported, once each');
    }
    flags[key] = value;
  }
  if (args.length && !['prepare', 'deploy'].includes(action)) throw new Error('--ref and --lan-host are only valid with prepare/deploy');
  if (profile === 'dev' && flags['--ref'] && flags['--ref'] !== 'HEAD') throw new Error('dev runs the working tree; use stable to deploy a fixed ref');
  if (flags['--lan-host']) {
    if (profile !== 'stable') throw new Error('--lan-host is only valid for stable; dev stays on loopback');
    validateLanHost(flags['--lan-host']);
  }
  const root = join(profilesRoot, profile);
  if (action === 'prepare') {
    if (existsSync(join(root, 'active.json'))) throw new Error('An activated profile must be upgraded with deploy');
    prepare(profile, flags['--ref'] || 'HEAD', flags['--lan-host']);
  } else if (action === 'deploy') {
    const oldFiles = new Map();
    for (const name of ['deployment.json', 'compose.env', 'compose.yml', 'compose.dev.yml']) {
      if (existsSync(join(root, name))) oldFiles.set(name, readFileSync(join(root, name)));
    }
    const previous = existsSync(join(root, 'active.json')) ? readJson(join(root, 'active.json')) : null;
    prepare(profile, flags['--ref'] || 'HEAD', flags['--lan-host']);
    try {
      compose(root, 'build', 'api', 'web');
    } catch (error) {
      for (const [name, contents] of oldFiles) writeFileSync(join(root, name), contents);
      throw error;
    }
    let saved;
    if (previous) {
      const candidate = new Map([...oldFiles.keys()].map((name) => [name, readFileSync(join(root, name))]));
      // Stop writers using the old project metadata, including after an earlier stop.
      for (const [name, contents] of oldFiles) writeFileSync(join(root, name), contents);
      compose(root, 'stop', 'web', 'api');
      compose(root, 'up', '-d', '--wait', 'postgres');
      try { saved = backup(root); }
      catch (error) {
        compose(root, 'up', '-d', '--wait', '--wait-timeout', '240');
        throw error;
      }
      for (const [name, contents] of candidate) writeFileSync(join(root, name), contents);
    }
    try { compose(root, 'up', '-d', '--wait', '--wait-timeout', '240'); }
    catch (error) {
      console.error(saved ? `Restore the matching data and configuration from ${saved} before rolling code back.` : 'Start failed; data volumes were retained.');
      throw error;
    }
    saveJson(join(root, 'active.json'), readJson(join(root, 'deployment.json')));
    await status(root);
  } else if (action === 'build') compose(root, 'build', 'api', 'web');
  else if (action === 'up') {
    const candidate = readJson(join(root, 'deployment.json'));
    if (existsSync(join(root, 'active.json')) && JSON.stringify(candidate) !== JSON.stringify(readJson(join(root, 'active.json')))) {
      throw new Error('Deployment differs from the active version; use deploy so data is backed up');
    }
    compose(root, 'up', '-d', '--wait', '--wait-timeout', '240');
    saveJson(join(root, 'active.json'), candidate);
  }
  else if (action === 'stop') compose(root, 'stop');
  else if (action === 'status') await status(root);
  else if (action === 'logs') compose(root, 'logs', '--tail', '80', 'api', 'web');
  else if (action === 'watch') {
    if (profile !== 'dev') throw new Error('Only dev supports source watching');
    // Compose 2.30 lacks initial_sync. Always build before starting a new watch session.
    compose(root, 'up', '-d', '--build', '--wait', '--wait-timeout', '240');
    compose(root, 'watch', '--no-up');
  } else if (action === 'backup') {
    const running = capture('docker', composeArgs(root, 'ps', '--services', '--status', 'running')).split(/\r?\n/u);
    compose(root, 'stop', 'web', 'api');
    compose(root, 'up', '-d', '--wait', 'postgres');
    try { backup(root); }
    finally {
      const writers = ['api', 'web'].filter((name) => running.includes(name));
      if (writers.length) compose(root, 'up', '-d', '--wait', '--wait-timeout', '240', ...writers);
    }
  }
  else if (action === 'token') {
    const { JWT_SECRET: signingSecret } = parseEnv(readFileSync(join(root, 'api.env'), 'utf8'));
    if (!signingSecret) throw new Error('No local profile JWT_SECRET is configured');
    // Existing JWT authentication recognizes the local administrator identity;
    // /api/me mirrors this expiring credential into the attachment auth cookie.
    // Keep the deployment-wide master token and signing secret out of the browser.
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ sub: 'local', iat: issuedAt, exp: issuedAt + 24 * 60 * 60 })).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = createHmac('sha256', signingSecret).update(signingInput).digest('base64url');
    console.log(`${signingInput}.${signature}`);
  }
  else throw new Error(`Unknown action: ${action}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
