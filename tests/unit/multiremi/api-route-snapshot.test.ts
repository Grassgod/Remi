import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  captureApiSnapshot,
  GOLDEN_PATH,
  scrubString,
  serializeSnapshot,
  type SnapshotFile,
} from "../../../scripts/snapshot-api-routes.js";

const goldenText = readFileSync(GOLDEN_PATH, "utf8");
const golden = JSON.parse(goldenText) as SnapshotFile;

/** First line where two documents diverge, or null when byte-identical. The
 *  golden is ~560 KB, so a raw string equality failure would be unreadable. */
function firstDiff(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
    if (actualLines[i] === expectedLines[i]) continue;
    return [
      `line ${i + 1} differs (${actual.length} chars captured vs ${expected.length} golden)`,
      `  captured: ${actualLines[i] ?? "<end of document>"}`,
      `  golden:   ${expectedLines[i] ?? "<end of document>"}`,
      `regenerate with: bun run scripts/snapshot-api-routes.ts`,
    ].join("\n");
  }
  return `documents differ but no differing line found (${actual.length} vs ${expected.length} chars)`;
}

describe("api route golden snapshot", () => {
  it("scrubs machine identity only in path-shaped contexts", () => {
    const identity = { hostname: "unknown", username: "unknown" };

    expect(scrubString('provider: "unknown"; mode: "local"', identity)).toBe('provider: "unknown"; mode: "local"');
    expect(scrubString("/home/unknown/project C:\\Users\\unknown\\repo", identity)).toBe(
      "/home/<user>/project C:\\Users\\<user>\\repo",
    );
    expect(scrubString("https://unknown:6120/api \\\\unknown\\share", identity)).toBe(
      "https://<hostname>:6120/api \\\\<hostname>\\share",
    );
    expect(scrubString(
      "local-1767225600243 local-contact-1767225600244 local-lark-1767225600257 local-cs_snapshot",
      identity,
    )).toBe(
      "local-<timestamp> local-contact-<timestamp> local-lark-<timestamp> local-cs_snapshot",
    );
  });

  // MUL-181: `$HOME` used to be replaced as a bare substring, so a root
  // identity ($HOME=/root) rewrote the literal URL ".../debugging/root-cause-tracing"
  // into ".../debugging<home>-cause-tracing" and this suite failed 100% of the
  // time in any container running as root.
  it("scrubs $HOME only at path-token boundaries", () => {
    const identity = { hostname: "unknown", username: "unknown", homedir: "/root" };
    const scrub = (value: string) => scrubString(value, identity);

    // real machine paths still get scrubbed
    expect(scrub("/root")).toBe("<home>");
    expect(scrub("/root/.remi/multiremi/uploads/a.txt")).toBe("<home>/.remi/multiremi/uploads/a.txt");
    expect(scrub("EACCES: permission denied, mkdir '/root/.remi'")).toBe(
      "EACCES: permission denied, mkdir '<home>/.remi'",
    );
    expect(scrub("PATH=/root/bin:/usr/bin")).toBe("PATH=<home>/bin:/usr/bin");
    expect(scrub("file:///root/x")).toBe("file://<home>/x");

    // literals that merely start with the same characters must survive
    expect(scrub("https://github.com/obra/superpowers-skills/tree/main/skills/debugging/root-cause-tracing")).toBe(
      "https://github.com/obra/superpowers-skills/tree/main/skills/debugging/root-cause-tracing",
    );
    expect(scrub("/root-cause-tracing")).toBe("/root-cause-tracing");
    expect(scrub("/root.bak/x")).toBe("/root.bak/x");
    expect(scrub("/rootfs/etc")).toBe("/rootfs/etc");
    expect(scrub("https://example.invalid/root/page")).toBe("https://example.invalid/root/page");
    // a sub-path named after the home dir is a different directory
    expect(scrub("/root/root")).toBe("<home>/root");

    // a degenerate $HOME must not rewrite every separator in the document
    expect(scrubString("/root/a /b", { ...identity, homedir: "/" })).toBe("/root/a /b");
    // a trailing separator must not move the boundary past it
    expect(scrubString("/root/.remi", { ...identity, homedir: "/root/" })).toBe("<home>/.remi");
  });

  // The golden is captured on one machine and byte-compared on another, so it
  // must contain nothing the scrubber would still rewrite — including under the
  // short `$HOME` values (`/root`) that only appear in containers.
  it("golden is a fixed point of the scrubber under a root identity", () => {
    const identity = { hostname: "unknown-host.invalid", username: "unknown-user", homedir: "/root" };
    expect(scrubString(goldenText, identity)).toBe(goldenText);
  });

  it("runs green and matches the golden route inventory", async () => {
    const snapshot = await captureApiSnapshot();

    // (a) the harness itself is healthy
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.some((entry) => entry.status === "threw")).toBe(false);

    // (b) route COUNT matches the golden file — catches a registration dropped
    // by a router move even where body scrubbing is loose.
    expect(snapshot.meta.routeCount).toBe(golden.meta.routeCount);
    expect(snapshot.meta.routeCountByPrefix).toEqual(golden.meta.routeCountByPrefix);
    expect(snapshot.routes).toEqual(golden.routes);

    // Coverage must not silently shrink either.
    expect(snapshot.coveredRoutes).toEqual(golden.coveredRoutes);
    expect(snapshot.entries.map((entry) => entry.key)).toEqual(golden.entries.map((entry) => entry.key));

    // (c) byte-identical to the committed golden. (a)/(b) only compare keys,
    // statuses and the route inventory, so a changed RESPONSE BODY slips past
    // them; this makes plain `bun test` as strict as the --check CLI. The
    // harness pins clock, uuid, random, hostname and env, so it is stable.
    expect(firstDiff(serializeSnapshot(snapshot), goldenText)).toBeNull();
  }, 15_000);

  it("covers every GET route (websocket upgrades status-only)", async () => {
    const getRoutes = golden.routes.filter((route) => route.startsWith("GET "));
    const covered = new Set(golden.coveredRoutes);
    for (const route of getRoutes) expect(covered.has(route)).toBe(true);
    expect(golden.meta.statusOnlyRoutes).toEqual(["GET /api/daemon/ws", "GET /api/realtime/ws", "GET /ws"]);
  });
});
