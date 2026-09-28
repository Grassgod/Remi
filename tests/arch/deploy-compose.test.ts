// MUL-205: Feishu ingestion runs inside the API container through lark-cli,
// so the deployment has no ingestion service, port, or endpoint registry left
// to get wrong. These assertions guard the invariants the API cannot enforce
// at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { parse } from "yaml";
import { isTerminalPlatformOperationStatus } from "@multiremi/store/repos/platform-operations-repo.js";
import type { MultiremiPlatformOperationStatus } from "@multiremi/contracts/types.js";

const repoRoot = resolve(import.meta.dir, "../..");
const compose = parse(readFileSync(resolve(repoRoot, "deploy/docker/compose.application.yml"), "utf8")) as {
  name?: string;
  services: Record<string, Record<string, any>>;
  volumes?: Record<string, unknown>;
};
const envExample = readFileSync(resolve(repoRoot, "deploy/docker/application.env.example"), "utf8");
const apiEnvExample = readFileSync(resolve(repoRoot, "deploy/docker/api.env.example"), "utf8");
const apiDockerfile = readFileSync(resolve(repoRoot, "deploy/docker/Dockerfile.api"), "utf8");
const splitUpstream = readFileSync(resolve(repoRoot, "deploy/nginx/api-runtime-split-upstream.conf"), "utf8");
const splitLocations = readFileSync(resolve(repoRoot, "deploy/nginx/api-runtime-split-locations.conf"), "utf8");
const deployReadme = readFileSync(resolve(repoRoot, "deploy/README.md"), "utf8");

/** The "Split API roles" section only, so assertions cannot match other sections. */
function splitSection(readme: string): string {
  const start = readme.indexOf("## Split API roles");
  const end = readme.indexOf("## Drain-protected updates", start);
  return readme.slice(start, end);
}

describe("application compose stack", () => {
  test("ships no ingestion service, profile, or endpoint registry", () => {
    // The sidecar is retired. Anything left behind here — a service, a profile
    // to enable it, an endpoint name to point at it — would be config that
    // nothing reads, which is how an operator ends up debugging a dead process.
    expect(Object.keys(compose.services).sort()).toEqual(["api", "api-runtime", "ssh-mesh-control-plane", "web"]);
    expect(compose.volumes).toBeUndefined();
    expect(envExample).not.toMatch(/^COMPOSE_PROFILES=/mu);
    expect(envExample).not.toMatch(/^REMI_FEISHU_SIDECAR/mu);
    for (const [name, service] of Object.entries(compose.services)) {
      const environment: Record<string, unknown> = service.environment ?? {};
      for (const key of Object.keys(environment)) {
        expect(key, `${name} env ${key}`).not.toContain("SIDECAR");
      }
    }
  });

  test("keeps the split API role container behind a profile", () => {
    // MUL-464. `api-runtime` is the daemon surface of the same image. It must
    // stay opt-in: no profile means no second API container, and the browser
    // process keeps its name because the Web image bakes REMOTE_API_URL to
    // http://api:6120. A default installation therefore starts the same three
    // services it started before this change.
    const runtime = compose.services["api-runtime"]!;
    expect(runtime.profiles).toEqual(["split"]);
    expect(runtime.environment.MULTIREMI_API_ROLE).toBe("runtime");
    expect(runtime.environment.MULTIREMI_BACKGROUND_JOBS).toBe("0");
    expect(runtime.environment.MULTIREMI_SSH_MESH_CONTROL_PLANE).toBe("0");
    expect(runtime.environment.MULTIREMI_PEER_URL).toBe("http://api:6120");
    // Same image, env file, and mounts as `api`: it is the same server with a
    // different role, and it must read the same database and credentials.
    expect(runtime.image).toBe(compose.services.api!.image);
    expect(runtime.env_file).toEqual(compose.services.api!.env_file);
    expect(runtime.volumes).toEqual(compose.services.api!.volumes);
    expect(runtime.ports).toEqual(["127.0.0.1:${REMI_API_RUNTIME_BIND_PORT:-16121}:6120"]);
    // The role env on `api` is a pass-through with an **empty** default, not
    // `all`. MUL-461 only reports a `role` field in /health and /readyz when the
    // variable is explicitly set, so defaulting to the literal `all` would change
    // those payloads for every existing installation. Empty means "unset" to the
    // server, which resolves it to `all` internally without advertising it.
    expect(compose.services.api!.environment.MULTIREMI_API_ROLE).toBe("${REMI_API_ROLE:-}");
    expect(compose.services.api!.environment.MULTIREMI_PEER_URL).toBe("${REMI_API_PEER_URL:-}");
  });

  test("bakes a pinned, checksum-verified lark-cli into the API image", () => {
    // The Provider spawns `lark-cli` by name, so it has to be on PATH in the
    // API container. Pinning it keeps the image reproducible, and the digest
    // check is what makes downloading a binary at build time acceptable.
    expect(apiDockerfile).toMatch(/^ARG LARK_CLI_VERSION=\d+\.\d+\.\d+$/mu);
    expect(apiDockerfile).toMatch(/^ARG LARK_CLI_SHA256_AMD64=[a-f0-9]{64}$/mu);
    expect(apiDockerfile).toMatch(/^ARG LARK_CLI_SHA256_ARM64=[a-f0-9]{64}$/mu);
    expect(apiDockerfile).toContain("sha256sum -c -");
    expect(apiDockerfile).toContain("/usr/local/bin/lark-cli");
  });

  test("keeps the Feishu credential out of every file in this repository", () => {
    // lark-cli writes its credential into the container's home, which is a bind
    // mount an operator owns. It must never travel through Compose or an env
    // file, both of which are committed as examples and read by the whole team.
    const home = (compose.services.api!.volumes as string[])
      .find((entry) => entry.endsWith(":/srv/multiremi"));
    expect(home).toBe("${REMI_HOME_DIR:?set REMI_HOME_DIR}:/srv/multiremi");
    expect(compose.services.api!.environment.HOME).toBe("/srv/multiremi");
    for (const source of [envExample, apiEnvExample]) {
      expect(source).not.toMatch(/^[A-Z_]*LARK[A-Z_]*=/mu);
      expect(source).not.toMatch(/^MULTIREMI_FEISHU_(?:APP_SECRET|SIDECAR)[A-Z_]*=/mu);
    }
  });

  test("splits the nginx snippet by the context each directive is legal in", () => {
    // MUL-464 QA: the first version shipped one file to paste into a `server`
    // block, which makes `nginx -t` fail with
    // `"upstream" directive is not allowed here`. `upstream` is http-only and
    // `location` is server-only, so the two cannot share one include target.
    expect(splitUpstream).toMatch(/^upstream multica_api_runtime \{ server 127\.0\.0\.1:16121; keepalive 32; \}$/mu);
    expect(splitUpstream).not.toMatch(/^\s*location /mu);
    expect(splitLocations).toMatch(/^location \/api\/daemon\/ \{/mu);
    expect(splitLocations).not.toMatch(/^\s*upstream /mu);
    // The prefix must stay an ordinary prefix with a trailing slash: `^~` would
    // stop the archive-upload regex below it from ever being evaluated, and
    // without the trailing slash `/api/daemons/:id` (a browser route) would be
    // captured too.
    expect(splitLocations).not.toMatch(/\^~\s*\/api\/daemon\//u);
    expect(splitLocations).not.toMatch(/location \/api\/daemon[^/\s]/u);
    // MUL-462's peer endpoints (`/internal/peer/events`, `/internal/peer/health`)
    // are for container-to-container traffic only. Today nothing routes them
    // from the public server, but that is an accident of the current rewrite and
    // catch-all; this location makes the boundary explicit so a future routing
    // change cannot quietly publish them.
    expect(splitLocations).toMatch(/^location \/internal\/ \{ return 404; \}$/mu);
  });

  test("the split runbook restores every file stage A changes", () => {
    // MUL-464 QA: stage A changes three Nginx files (the site, the archive
    // include, and possibly nginx.conf for the http-level upstream) plus the
    // host Compose file and env. The first runbook restored only the site file,
    // so a rollback left large archive uploads pointed at a container that Full
    // return was about to stop. Each changed file must be named in the backup
    // block, covered by the per-file table, and restored by a rollback.
    for (const file of [
      "nginx-site.conf.orig",
      "nginx-session-archive-direct.conf.orig",
      "nginx.conf.orig",
      "compose.application.yml.orig",
      "application.env.orig",
    ]) {
      expect(deployReadme, `backup for ${file}`).toContain(file);
    }
    // The archive include must be restored by the stage A rollback, not only
    // backed up: name it in the rollback block as well.
    const rollback = splitSection(deployReadme).slice(splitSection(deployReadme).indexOf("### Rollback"));
    expect(rollback).toContain("nginx-session-archive-direct.conf.orig");
    // And the rollback must verify both routes came back, which is the check
    // that catches a half-restored host.
    expect(rollback).toMatch(/archive path/);
  });

  test("the split runbook deletes the stage A Compose lines instead of restoring the env backup", () => {
    // MUL-464 QA: the Compose env file is rewritten by the updater on every
    // release (`writeImageEnv`), so restoring a whole backup would roll the
    // image digests back with it. The runbook must say to delete the two lines
    // and must not instruct a full restore of the env file.
    expect(deployReadme).toMatch(/Never restore a whole backup of `\$COMPOSE_ENV`/u);
    expect(deployReadme).toMatch(/do NOT restore the whole backup/u);
    // The peer URL must be cleared before the MUL-405 image is rolled back: the
    // precondition chains Full return, and Full return clears the peer config.
    const rollback = splitSection(deployReadme).slice(splitSection(deployReadme).indexOf("### Rollback"));
    expect(rollback).toMatch(/rolling back the MUL-405 image requires a completed Full[\s>]*return/u);
    expect(rollback).toContain("REMI_API_PEER_URL=http://api-runtime:6120");
  });

  test("Full return deletes the runtime container before the Compose file loses its definition", () => {
    // MUL-464 QA r3 (B1): `stop` leaves the container in state `exited`, and the
    // next step restores the pre-switch Compose file, which no longer declares
    // `api-runtime`. After that nothing can delete it, so the runbook's own
    // "no api-runtime container, running or stopped" gate could never pass.
    // The delete must therefore come after the updater restart, before the
    // Compose restore, with the full prefix and the profile flag.
    const section = splitSection(deployReadme);
    const fullReturn = section.slice(section.indexOf("**Full return to a single process"));
    const rmIndex = fullReturn.indexOf("rm -sf api-runtime");
    const restoreIndex = fullReturn.indexOf('cp "$COMPOSE_DIR/backups/<date>/compose.application.yml.orig"');
    expect(rmIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(rmIndex).toBeLessThan(restoreIndex);
    // Full prefix + profile on the same command line (the line wrap is escaped).
    expect(fullReturn.slice(Math.max(0, rmIndex - 200), rmIndex)).toMatch(
      /docker compose --env-file "\$COMPOSE_ENV" -f "\$COMPOSE_FILE" --profile split/u,
    );
    // `rm -f` alone removes only stopped containers; `-s` is what stops a running
    // one first. Both flags must be present or the step fails on a live runtime.
    expect(fullReturn).toMatch(/rm -sf api-runtime/u);
    expect(fullReturn).not.toMatch(/\n\s*stop api-runtime\n/u);
  });

  test("the runtime-container existence check is scoped to this Compose project", () => {
    // MUL-464 QA r3 (B1): a bare `label=com.docker.compose.service=api-runtime`
    // filter also matches other Compose projects on the same host, so an empty
    // result would not prove this installation was cleaned up. The project name
    // has to be stated, and its source documented (the `name:` key here, since
    // the runbook passes neither `-p` nor a directory override).
    const section = splitSection(deployReadme);
    const checks = section.slice(section.indexOf("Confirm the four single-process checks"));
    expect(checks).toContain("COMPOSE_PROJECT=multiremi-platform-app");
    expect(checks).toMatch(/label=com\.docker\.compose\.project="\$COMPOSE_PROJECT"/u);
    expect(checks).toMatch(/label=com\.docker\.compose\.service=api-runtime/u);
    // The Compose file is the source of that project name.
    expect(compose.name).toBe("multiremi-platform-app");
  });

  test("the peer check accepts both an absent key and an empty value", () => {
    // MUL-464 QA r3 (B2): after Full return restores the pre-switch Compose
    // file, `MULTIREMI_PEER_URL` is absent entirely - a valid "off" state that
    // the old `grep MULTIREMI_PEER_URL=` could not accept (no output, exit 1).
    // Only a non-empty value is a failure.
    const section = splitSection(deployReadme);
    const checks = section.slice(section.indexOf("Confirm the four single-process checks"));
    expect(checks).toContain("peer: unset");
    expect(checks).toContain("peer: empty");
    expect(checks).toMatch(/peer: SET=/u);
    // Both states are named in prose, with the stage each one belongs to.
    expect(checks).toMatch(/key absent: Full return/u);
    expect(checks).toMatch(/empty value: the intermediate state/u);
    // The old single-answer expectation must be gone.
    expect(checks).not.toMatch(/-> MULTIREMI_PEER_URL=   \(empty\)/u);
  });

  test("stage A rollback gates on the nginx -t exit code before counting references", () => {
    // MUL-464 QA r3: with the archive include left pointing at the removed
    // upstream, `nginx -T | grep -c multica_api_runtime` prints 0 while nginx
    // itself fails to parse, so a count-only check reports "restored" on a
    // broken config. The exit code has to be judged first.
    const section = splitSection(deployReadme);
    const verify = section.slice(section.indexOf("Then confirm both public server blocks"), section.indexOf("The `api-runtime` container and the updater list"));
    const gateIndex = verify.indexOf("if ! nginx -t");
    const countIndex = verify.indexOf("nginx -T | grep -c multica_api_runtime");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(gateIndex);
    expect(verify).toMatch(/NOT RESTORED: nginx config does not parse/u);
  });

  test("the split pre-check never calls platform status", () => {
    const section = splitSection(deployReadme);
    expect(section).not.toContain("remi platform status");
    expect(section).not.toContain("without writing anything");
  });

  test("the split pre-check reads the operation list with the maximum limit", () => {
    const section = splitSection(deployReadme);
    expect(section).toContain("remi platform operation list --output json --limit 100");
    expect(section).toContain("multiremi_access_tokens.last_used_at");
    expect(section).toContain("set -o pipefail");
  });

  test("the documented non-terminal statuses equal the complement of TERMINAL_STATUSES", () => {
    const section = splitSection(deployReadme);
    const body = section.match(/python3 -c "([\s\S]*?)\n  "/u)?.[1];
    expect(body, "operation pre-check Python script").toBeDefined();
    const python = spawnSync("python3", ["-c", [
      "import ast,json,sys,textwrap",
      "tree=ast.parse(textwrap.dedent(sys.stdin.read()))",
      "sets={n.targets[0].id:sorted(ast.literal_eval(n.value)) for n in tree.body",
      "      if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name)",
      "      and n.targets[0].id in ('terminal','non_terminal')}",
      "print(json.dumps(sets))",
    ].join("\n")], { input: body!.replaceAll('\\"', '"'), encoding: "utf8" });
    expect(python.status, python.stderr).toBe(0);
    const documented = JSON.parse(python.stdout) as { terminal: string[]; non_terminal: string[] };

    // Parse the contract so adding a status without updating the README is red.
    const source = ts.createSourceFile("types.ts",
      readFileSync(resolve(repoRoot, "packages/contracts/src/types.ts"), "utf8"),
      ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "MultiremiPlatformOperationStatus");
    expect(declaration && ts.isUnionTypeNode(declaration.type)).toBe(true);
    const states = (declaration!.type as ts.UnionTypeNode).types.map((node) => {
      if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) {
        throw new Error("Platform operation statuses must be string literals");
      }
      return node.literal.text as MultiremiPlatformOperationStatus;
    });
    expect(documented.terminal).toEqual(states.filter(isTerminalPlatformOperationStatus).sort());
    expect(documented.non_terminal).toEqual(states.filter((status) => !isTerminalPlatformOperationStatus(status)).sort());
    expect(section).toContain("packages/server/src/store/repos/platform-operations-repo.ts");
  });

  test("grants no container the Docker socket or host control", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      const volumes: string[] = (service.volumes ?? []).filter((entry: unknown) => typeof entry === "string");
      for (const volume of volumes) {
        expect(volume, `${name} volume ${volume}`).not.toContain("docker.sock");
        expect(volume, `${name} volume ${volume}`).not.toContain("/run/systemd");
      }
      expect(service.privileged, `${name} privileged`).toBeUndefined();
    }
    // Host networking stays limited to the control plane, which needs the host
    // sshd and host keys.
    const hostNetworked = Object.entries(compose.services)
      .filter(([, service]) => service.network_mode === "host")
      .map(([name]) => name);
    expect(hostNetworked).toEqual(["ssh-mesh-control-plane"]);
  });
});
