// MUL-155: the Feishu ingestion sidecar shares the API container's network
// namespace. Two invariants matter here: the sidecar is detached before the API
// container is replaced and reattached afterwards (otherwise Docker refuses the
// switch and the sidecar ends up orphaned), and a sidecar that will not start
// never fails a platform release — it degrades to an Unreachable endpoint.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiPlatformOperation, MultiremiPlatformServiceId } from "@multiremi/contracts";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import type { CommandRunner } from "@remi-platform/updater/types.js";

const DIGEST = `ghcr.io/grassgod/remi-api@sha256:${"a".repeat(64)}`;
const WEB_DIGEST = `ghcr.io/grassgod/remi-web@sha256:${"b".repeat(64)}`;
const OLD_DIGEST = `ghcr.io/grassgod/remi-api@sha256:${"c".repeat(64)}`;
const OLD_WEB_DIGEST = `ghcr.io/grassgod/remi-web@sha256:${"d".repeat(64)}`;
const CORE_SERVICES: MultiremiPlatformServiceId[] = ["api", "web", "ssh-mesh-control-plane"];

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function operation(kind: "update" | "restart" = "update"): MultiremiPlatformOperation {
  return {
    id: "pop_sidecar",
    kind,
    status: "preparing",
    driver: "docker_compose",
    targetVersion: "1.2.3",
    targetRef: "ref",
    targetManifest: { version: "1.2.3", ref: "ref", apiImage: DIGEST, webImage: WEB_DIGEST },
    progress: {},
    requestedBy: "tester",
    output: null,
    error: null,
    previousRelease: null,
    resultRelease: null,
    cancelRequested: false,
    createdAt: "",
    updatedAt: "",
    startedAt: null,
    finishedAt: null,
  };
}

interface Bed {
  driver: DockerComposeDriver;
  commands: string[][];
  compose: () => string[];
  stop: () => void;
}

/**
 * @param sidecarEnabled whether `docker compose config --services` reports the
 *   profile-gated service, i.e. whether the operator enabled ingestion at all.
 */
function driverBed(options: {
  sidecarEnabled: boolean;
  failSidecarStart?: boolean;
  psRows?: Record<string, unknown>[];
}): Bed {
  const root = mkdtempSync(join(tmpdir(), "compose-sidecar-"));
  tempDirs.push(root);
  const envFile = join(root, "platform.env");
  writeFileSync(envFile, `REMI_API_IMAGE=${OLD_DIGEST}\nREMI_WEB_IMAGE=${OLD_WEB_DIGEST}\n`);
  const composeFile = join(root, "compose.yaml");
  writeFileSync(composeFile, "services: {}\n");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "current-release.json"), JSON.stringify({
    version: "1.2.2",
    ref: "previous-ref",
    publishedAt: new Date(0).toISOString(),
    apiImage: OLD_DIGEST,
    webImage: OLD_WEB_DIGEST,
  }));

  const services = [...CORE_SERVICES, ...(options.sidecarEnabled ? ["feishu-sidecar"] : [])];
  const commands: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      commands.push([command, ...args]);
      const line = args.join(" ");
      if (line.includes("config --services")) {
        return { exitCode: 0, stdout: `${services.join("\n")}\n`, stderr: "" };
      }
      if (line.includes("ps --format json")) {
        return {
          exitCode: 0,
          stdout: (options.psRows ?? []).map((row) => JSON.stringify(row)).join("\n"),
          stderr: "",
        };
      }
      if (options.failSidecarStart && args.includes("feishu-sidecar") && args.includes("up")) {
        return { exitCode: 1, stdout: "", stderr: "sidecar image pull failed" };
      }
      if (command === "find") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const driver = new DockerComposeDriver({
    composeFile,
    envFile,
    stateDir,
    apiHealthUrl: `http://127.0.0.1:${health.port}/readyz`,
    webHealthUrl: `http://127.0.0.1:${health.port}/login`,
  }, runner);

  return {
    driver,
    commands,
    compose: () => commands.filter((args) => args[1] === "compose").map((args) => args.join(" ")),
    stop: () => health.stop(true),
  };
}

describe("Docker Compose driver: Feishu ingestion sidecar", () => {
  it("detaches the sidecar before the switch and reattaches it after verification", async () => {
    const bed = driverBed({ sidecarEnabled: true });
    try {
      const release = await bed.driver.execute(operation(), async () => {});
      expect(release?.version).toBe("1.2.3");

      const lines = bed.compose();
      const detach = lines.findIndex((line) => line.includes("rm --stop --force feishu-sidecar"));
      const switchIndex = lines.findIndex((line) => line.includes(`up -d --no-deps ${CORE_SERVICES.join(" ")}`));
      const attach = lines.findIndex((line) => line.includes("up -d --no-deps --force-recreate feishu-sidecar"));
      expect(detach).toBeGreaterThanOrEqual(0);
      // Docker refuses to replace a container whose namespace another running
      // container borrows, so this ordering is load-bearing, not cosmetic.
      expect(switchIndex).toBeGreaterThan(detach);
      expect(attach).toBeGreaterThan(switchIndex);
      // The sidecar is never bundled into the core switch: a failure there
      // would take the API down with it.
      expect(lines.some((line) => line.includes("up -d --no-deps api") && line.includes("feishu-sidecar"))).toBe(false);
    } finally {
      bed.stop();
    }
  });

  it("issues no sidecar command at all when the profile is disabled", async () => {
    const bed = driverBed({ sidecarEnabled: false });
    try {
      const release = await bed.driver.execute(operation(), async () => {});
      expect(release?.version).toBe("1.2.3");
      const lines = bed.compose();
      expect(lines.some((line) => line.includes("up -d --no-deps api web ssh-mesh-control-plane"))).toBe(true);
      // Naming a service outside the active profiles makes the whole Compose
      // command fail, so an installation without ingestion must never see one.
      expect(lines.filter((line) => line.includes("feishu-sidecar"))).toEqual([]);
    } finally {
      bed.stop();
    }
  });

  it("completes the release when the sidecar refuses to start", async () => {
    const bed = driverBed({ sidecarEnabled: true, failSidecarStart: true });
    try {
      const release = await bed.driver.execute(operation(), async () => {});
      // Ingestion is degraded, the platform is not: the control panel reports
      // the endpoint as Unreachable and no rollback is triggered.
      expect(release?.version).toBe("1.2.3");
      const lines = bed.compose();
      expect(lines.filter((line) => line.includes(`up -d --no-deps ${CORE_SERVICES.join(" ")}`))).toHaveLength(1);
    } finally {
      bed.stop();
    }
  });

  it("restarts the sidecar with the platform, after the core services are healthy", async () => {
    const bed = driverBed({ sidecarEnabled: true });
    try {
      await bed.driver.execute(operation("restart"), async () => {});
      const lines = bed.compose();
      const core = lines.findIndex((line) => line.includes(`restart ${CORE_SERVICES.join(" ")}`));
      const sidecar = lines.findIndex((line) => line.includes("restart feishu-sidecar"));
      expect(core).toBeGreaterThanOrEqual(0);
      expect(sidecar).toBeGreaterThan(core);
      // A restart keeps the API container, so nothing is detached.
      expect(lines.some((line) => line.includes("rm --stop"))).toBe(false);
    } finally {
      bed.stop();
    }
  });

  it("reports the sidecar in the service panel only where it is deployed", async () => {
    const rows = [
      { Service: "api", State: "running", Status: "Up", Image: "api:test" },
      { Service: "web", State: "running", Status: "Up", Image: "web:test" },
      { Service: "ssh-mesh-control-plane", State: "running", Status: "Up", Image: "api:test" },
      { Service: "feishu-sidecar", State: "exited", Status: "Exited (1)", Image: "sidecar:test" },
    ];

    const enabled = driverBed({ sidecarEnabled: true, psRows: rows });
    try {
      const services = (await enabled.driver.inspect()).services;
      const sidecar = services.find((service) => service.id === "feishu-sidecar");
      // A crashed sidecar is visible and named, never silently absent.
      expect(sidecar).toMatchObject({ name: "Feishu Ingestion Sidecar", status: "stopped" });
      expect(sidecar?.detail).toBe("Exited (1)");
    } finally {
      enabled.stop();
    }

    const disabled = driverBed({ sidecarEnabled: false, psRows: rows.slice(0, 3) });
    try {
      const services = (await disabled.driver.inspect()).services;
      // No profile, no permanently stopped row in the panel.
      expect(services.map((service) => service.id)).toEqual([...CORE_SERVICES, "postgres", "openviking"]);
    } finally {
      disabled.stop();
    }
  });
});
