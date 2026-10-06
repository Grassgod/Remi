import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { computeInFlightWaves, preRevealWaveFailure } from "../../integration/zero-jump-waves";

describe("CI reveal waves", () => {
  it("counts two overlapping requests followed by a dependent request as two waves", () => {
    const result = computeInFlightWaves([
      { index: 0, path: "/A", startMs: 0, responseEndMs: 100 },
      { index: 1, path: "/B", startMs: 95, responseEndMs: 200 },
      { index: 2, path: "/C", startMs: 201, responseEndMs: 250 },
    ]);
    expect(result.serialDepth).toBe(2);
    expect(result.rows.map(row => row.wave)).toEqual([1, 1, 2]);
    expect(result.rows.map(row => row.after)).toEqual([null, null, 1]);
    expect(result.chain).toEqual([1, 2]);
    expect(preRevealWaveFailure("blocking", result.serialDepth)).toBeNull();
  });

  it("keeps overlaps through a third request in the same wave, regardless of input order", () => {
    const result = computeInFlightWaves([
      { index: 3, path: "/D", startMs: 250, responseEndMs: 300 },
      { index: 2, path: "/C", startMs: 180, responseEndMs: 250 },
      { index: 0, path: "/A", startMs: 0, responseEndMs: 100 },
      { index: 1, path: "/B", startMs: 50, responseEndMs: 200 },
    ]);
    expect(result.rows.map(row => row.wave)).toEqual([1, 1, 1, 2]);
    expect(result.serialDepth).toBe(2);
    expect(result.chain).toEqual([2, 3]);
  });

  it("replays the CI warm failure's overlapping runtime and PNG requests as one wave", () => {
    const result = computeInFlightWaves([
      { index: 0, path: "/api/runtime-workspaces", startMs: 11009.6, responseEndMs: 11016.6 },
      { index: 1, path: "/api/runtimes", startMs: 11011.2, responseEndMs: 11071.2 },
      { index: 2, path: "/api/attachments/attachment-1/content", startMs: 11066, responseEndMs: 11081.4 },
    ]);
    expect(result.serialDepth).toBe(1);
    expect(result.rows.map(row => row.wave)).toEqual([1, 1, 1]);
    expect(preRevealWaveFailure("blocking", result.serialDepth)).toBeNull();
  });

  it("does not split nested requests when a shorter request has already finished", () => {
    expect(computeInFlightWaves([
      { index: 0, path: "/long", startMs: 0, responseEndMs: 100 },
      { index: 1, path: "/short", startMs: 10, responseEndMs: 20 },
      { index: 2, path: "/later", startMs: 30, responseEndMs: 90 },
    ]).serialDepth).toBe(1);
  });

  it("retains the blocking limit and record-only behavior", () => {
    expect(computeInFlightWaves([])).toEqual({ rows: [], serialDepth: 0, chain: [] });
    expect(preRevealWaveFailure("blocking", 2)).toBeNull();
    expect(preRevealWaveFailure("blocking", 3)).toBe("pre-reveal waves: 3");
    expect(preRevealWaveFailure("blocking", null)).not.toBeNull();
    expect(preRevealWaveFailure("record-only", 3)).toBeNull();
  });

  it("rejects a mutation with three genuinely sequential HTTP requests through the S7 strict verdict", async () => {
    const probe = Bun.spawn([process.execPath, "tests/manual/zero-jump-wave-mutation.ts"], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(probe.stdout).text();
    expect(await probe.exited).toBe(1);
    const result = JSON.parse(await output);
    for (let index = 1; index < result.requests.length; index += 1) {
      expect(result.requests[index].startMs).toBeGreaterThanOrEqual(result.requests[index - 1].responseEndMs);
    }
    expect(result.waves.serialDepth).toBe(3);
    expect(result.waves.rows.map((row: { wave: number }) => row.wave)).toEqual([1, 2, 3]);
    expect(result.error).toBe("pre-reveal waves: 3");
    expect(result.verdict.ok).toBe(false);
    expect(result.verdict.failures[0].rule).toBe("unlisted-violation");
  });
});
