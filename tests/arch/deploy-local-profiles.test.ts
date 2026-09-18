import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dir, "../..");
type Compose = {
  name?: string;
  services: Record<string, Record<string, any>>;
  volumes?: Record<string, { external?: boolean; name?: string } | null>;
  networks?: Record<string, unknown>;
};
const readCompose = (name: string): Compose => parse(readFileSync(resolve(repoRoot, "deploy/docker", name), "utf8"));
const base = readCompose("compose.local.yml");
const dev = readCompose("compose.local-dev.yml");

describe("local stable and dev isolation", () => {
  test("scopes every persistent resource to the caller's Compose project", () => {
    expect(Object.keys(base.services).sort()).toEqual(["api", "postgres", "web"]);
    expect(Object.keys(dev.services).sort()).toEqual(["api", "web"]);
    expect(Object.keys(base.volumes ?? {}).sort()).toEqual(["api-home", "postgres-data"]);
    for (const model of [base, dev]) {
      expect(model.name).toBeUndefined();
      expect(model.networks).toBeUndefined();
      for (const volume of Object.values(model.volumes ?? {})) {
        expect(volume?.external).toBeUndefined();
        expect(volume?.name).toBeUndefined();
      }
      for (const service of Object.values(model.services)) {
        expect(service.container_name).toBeUndefined();
        expect(service.network_mode).toBeUndefined();
        expect(service.privileged).toBeUndefined();
        for (const mount of service.volumes ?? []) {
          // Only project-owned named volumes; no source, host SSH, or socket binds.
          expect(mount).toMatch(/^(api-home|postgres-data):\//u);
        }
      }
    }
    expect(base.services.postgres!.volumes).toEqual(["postgres-data:/var/lib/postgresql/data"]);
    expect(base.services.api!.volumes).toEqual(["api-home:/srv/multiremi"]);
    expect(dev.volumes).toBeUndefined();
  });

  test("keeps PostgreSQL private and defaults published API and Web ports to loopback", () => {
    expect(base.services.postgres!.image).toBe("pgvector/pgvector:pg17");
    expect(base.services.postgres!.ports).toBeUndefined();
    for (const name of ["api", "web"]) {
      expect(base.services[name]!.ports).toHaveLength(1);
      expect(base.services[name]!.ports[0]).toMatch(/^\$\{REMI_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{REMI_(API|WEB)_BIND_PORT:-\d+\}:\d+$/u);
      // An override with another published port would append a second mapping.
      expect(dev.services[name]!.ports).toBeUndefined();
    }
  });

  test("binds API storage and authentication mode to the selected environment", () => {
    const api = base.services.api!;
    expect(api.environment.NODE_ENV).toBe("production");
    expect(dev.services.api!.environment.NODE_ENV).toBeUndefined();
    expect(api.env_file).toEqual(["${REMI_API_ENV_FILE:?set REMI_API_ENV_FILE to an absolute external env file}"]);
    expect(api.environment.MULTIREMI_DATABASE_URL).toMatch(/^postgresql:\/\/multiremi:\$\{POSTGRES_PASSWORD:\?[^}]+\}@postgres:5432\/multiremi$/u);
    expect(base.services.postgres!.environment.POSTGRES_PASSWORD).toMatch(/^\$\{POSTGRES_PASSWORD:\?/u);
    expect(api.environment.MULTIREMI_PROJECT_KNOWLEDGE_MODE).toBe("sql");
    expect(api.environment.MULTIREMI_SSH_MESH_CONTROL_PLANE).toBe("0");
    expect(api.environment.MULTIREMI_PUBLIC_URL).toContain("${REMI_PUBLIC_URL:?");
    expect(api.environment.MULTIREMI_DAEMON_DIRECT_BASE_URL).toContain("${REMI_DAEMON_SERVER_URL:?");
    expect(api.environment.MULTIREMI_ALLOW_PASSWORD_LOGIN).toBe("1");
    expect(api.environment.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN).toBe("0");
    for (const key of ["HOME", "MULTIREMI_UPLOAD_DIR", "MULTIREMI_SESSION_ARCHIVE_ROOT", "MULTIREMI_SSH_MESH_CONTROL_PLANE_ROOT"]) {
      expect(api.environment[key]).toMatch(/^\/srv\/multiremi(?:\/|$)/u);
    }
    expect(dev.services.api!.environment.MULTIREMI_BACKGROUND_JOBS).toBe("${REMI_BACKGROUND_JOBS:-0}");
  });

  test("initializes named volume ownership before dropping API privileges", () => {
    const api = base.services.api!;
    const setup = api.entrypoint[2] as string;
    expect(api.environment.REMI_RUNTIME_UID).toBe("1000");
    expect(api.environment.REMI_RUNTIME_GID).toBe("1000");
    expect(setup).toContain("chown 1000:1000 /srv/multiremi");
    expect(setup).not.toMatch(/chown\s+-R/u);
    expect(setup).toContain('exec /app/deploy/docker/api-entrypoint.sh "$$@"');
    expect(api.entrypoint[3]).toBeTruthy(); // sh -c consumes this as $0, preserving Bun as $1.
    expect(api.command).toEqual(["bun", "run", "apps/server/main.ts", "serve"]);
  });

  test("keeps stable immutable while dev synchronizes source without host dependencies", () => {
    expect(base.services.web!.build.target).toBe("runtime");
    expect(dev.services.web!.build.target).toBe("development");
    expect(dev.services.api!.command).toEqual(["bun", "--watch", "run", "apps/server/main.ts", "serve"]);
    for (const name of ["api", "web"]) {
      expect(base.services[name]!.develop).toBeUndefined();
      expect(base.services[name]!.build.labels["org.opencontainers.image.revision"]).toContain("${REMI_BUILD_REF:?");
      const rules = dev.services[name]!.develop.watch as Record<string, any>[];
      const sync = rules.filter((rule) => rule.action === "sync");
      expect(sync).toHaveLength(1);
      expect(sync[0]!.target).toBe("/app");
      expect(sync[0]!.ignore).toEqual(expect.arrayContaining([
        ".git/", "**/node_modules/", "**/.next/", "**/.env", "**/.env.*", "**/package.json", "bun.lock",
      ]));
      for (const rule of rules) {
        expect(rule.include).toBeUndefined();
        expect(rule.initial_sync).toBeUndefined(); // Local Docker Compose 2.30 compatibility.
      }
    }
    expect(base.services.web!.build.args.NEXT_PUBLIC_SITE_URL).toContain("${REMI_PUBLIC_URL:?");
    expect(base.services.web!.build.args.REMOTE_API_URL).toBe("http://api:6120");
    expect(base.services.web!.build.args.NEXT_PUBLIC_WS_URL).toContain("${REMI_PUBLIC_WS_URL:?");
  });

  test("rebuilds when any current workspace dependency manifest changes", () => {
    const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const manifests = new Set(["package.json", "bun.lock", "bunfig.toml", ".dockerignore", "deploy/docker/Dockerfile.api", "deploy/docker/Dockerfile.web"]);
    for (const workspace of rootManifest.workspaces as string[]) {
      const directories = workspace.endsWith("/*")
        ? readdirSync(resolve(repoRoot, workspace.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${workspace.slice(0, -1)}${entry.name}`)
        : [workspace];
      for (const directory of directories) {
        if (existsSync(resolve(repoRoot, directory, "package.json"))) manifests.add(`${directory}/package.json`);
      }
    }
    for (const name of ["api", "web"]) {
      const rebuildPaths = dev.services[name]!.develop.watch
        .filter((rule: Record<string, any>) => rule.action === "rebuild")
        .map((rule: Record<string, any>) => rule.path);
      expect(rebuildPaths.sort()).toEqual([...manifests].map((path) => `\${REMI_SOURCE_DIR}/${path}`).sort());
    }
  });
});
