// MUL-205 retired the Feishu ingestion sidecar: lark-cli now runs inside the
// API container, so the Compose file no longer declares that service. An
// installation upgrading across that change still has the old container
// running, and because it borrowed the API container's network namespace,
// Docker refuses to replace the API container until it is gone. These tests
// guard the two things that follow: the leftover container is removed before
// the switch, and an installation that never ran ingestion pays nothing for it.
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
const LEFTOVER_ID = "0f1e2d3c4b5a";

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
  docker: () => string[];
  stop: () => void;
}

/**
 * @param leftover whether a container carrying the retired service's Compose
 *   label is still on the host, i.e. whether this host ran ingestion before.
 */
function driverBed(options: { leftover: boolean; psRows?: Record<string, unknown>[] }): Bed {
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

  const commands: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      commands.push([command, ...args]);
      const line = args.join(" ");
      if (line.startsWith("ps -aq --filter")) {
        return { exitCode: 0, stdout: options.leftover ? `${LEFTOVER_ID}\n` : "\n", stderr: "" };
      }
      if (line.includes("ps --format json")) {
        return {
          exitCode: 0,
          stdout: (options.psRows ?? []).map((row) => JSON.stringify(row)).join("\n"),
          stderr: "",
        };
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
    docker: () => commands.map((args) => args.join(" ")),
    stop: () => health.stop(true),
  };
}

describe("Docker Compose driver: retired Feishu ingestion sidecar", () => {
  it("removes the leftover container before replacing the API container", async () => {
    const bed = driverBed({ leftover: true });
    try {
      const release = await bed.driver.execute(operation(), async () => {});
      expect(release?.version).toBe("1.2.3");

      const lines = bed.docker();
      const remove = lines.findIndex((line) => line === `docker rm --force ${LEFTOVER_ID}`);
      const switchIndex = lines.findIndex((line) => line.includes(`up -d --no-deps ${CORE_SERVICES.join(" ")}`));
      expect(remove).toBeGreaterThanOrEqual(0);
      // Docker refuses to replace a container whose namespace another running
      // container borrows, so this ordering is load-bearing, not cosmetic.
      expect(switchIndex).toBeGreaterThan(remove);
      // Named volumes hold the operator's own Feishu credential. Retiring the
      // service removes the container; deleting that data stays their call.
      expect(lines.some((line) => line.includes("rm") && line.includes("--volumes"))).toBe(false);
    } finally {
      bed.stop();
    }
  });

  it("issues no removal on a host that never ran ingestion", async () => {
    const bed = driverBed({ leftover: false });
    try {
      const release = await bed.driver.execute(operation(), async () => {});
      expect(release?.version).toBe("1.2.3");
      const lines = bed.docker();
      expect(lines.some((line) => line.includes("up -d --no-deps api web ssh-mesh-control-plane"))).toBe(true);
      expect(lines.filter((line) => line.startsWith("docker rm"))).toEqual([]);
    } finally {
      bed.stop();
    }
  });

  it("restarts only the core services, and never names the retired one", async () => {
    const bed = driverBed({ leftover: true });
    try {
      await bed.driver.execute(operation("restart"), async () => {});
      const lines = bed.docker();
      expect(lines.some((line) => line.includes(`restart ${CORE_SERVICES.join(" ")}`))).toBe(true);
      // A restart keeps the API container, so nothing is blocking and nothing
      // needs removing. Naming a service the file no longer declares would
      // make the whole Compose command fail.
      expect(lines.filter((line) => line.includes("feishu-sidecar") && !line.includes("--filter"))).toEqual([]);
    } finally {
      bed.stop();
    }
  });

  it("leaves the retired service out of the platform service panel", async () => {
    const bed = driverBed({
      leftover: true,
      psRows: [
        { Service: "api", State: "running", Status: "Up", Image: "api:test" },
        { Service: "web", State: "running", Status: "Up", Image: "web:test" },
        { Service: "ssh-mesh-control-plane", State: "running", Status: "Up", Image: "api:test" },
        { Service: "feishu-sidecar", State: "exited", Status: "Exited (1)", Image: "sidecar:test" },
      ],
    });
    try {
      const services = (await bed.driver.inspect()).services;
      // Even with the old container still on the host, the panel describes the
      // topology this release ships — there is no ingestion service any more.
      expect(services.map((service) => service.id)).toEqual([...CORE_SERVICES, "postgres", "openviking"]);
    } finally {
      bed.stop();
    }
  });
});
