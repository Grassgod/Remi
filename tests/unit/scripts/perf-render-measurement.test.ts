import { describe, expect, it } from "bun:test";
import { measureLogRender, renderStatsBySource } from "../../../frontend/scripts/perf/lib/render-measurement";
import { buildCompare } from "../../../frontend/scripts/perf/lib/report";
import { parseArgs } from "../../../frontend/scripts/perf/lib/options";

const ready = (t: number) => ({ t, value: "ready", fresh: "1", scrollRoot: "issue-detail" });
describe("S9-6 render timing", () => {
  it("measures the target window against the same cold/warm clock, excluding entry-page reads and unrelated roots", () => {
    const result = measureLogRender({ navStartMs: 1000, ssrSeed: false, windows: [{ startMs: 100, responseEndMs: 200 }, { startMs: 1010, responseEndMs: 1100 }],
      states: [{ ...ready(1120), scrollRoot: "list" }, ready(1234.5)] });
    expect(result).toEqual({ renderMs: 134.5, renderSource: "csr-window", renderReason: null, windowResponseEndMs: 100 });
    expect(measureLogRender({ navStartMs: 0, ssrSeed: false, windows: [{ startMs: 10, responseEndMs: 100 }], states: [ready(234.5)] }).renderMs).toBe(134.5);
  });
  it("keeps missing, forced, stale and SSR arrivals unobserved instead of inventing zero", () => {
    const base = { navStartMs: 0, windows: [{ startMs: 1, responseEndMs: 100 }], ssrSeed: false };
    for (const states of [[], [{ ...ready(150), fresh: "0" }], [{ ...ready(150), value: "ready-forced" }]]) expect(measureLogRender({ ...base, states }).renderMs).toBeNull();
    expect(measureLogRender({ ...base, states: [ready(50)] }).renderReason).toContain("responseEnd");
    expect(measureLogRender({ ...base, states: [ready(150)], ssrSeed: true })).toMatchObject({ renderMs: null, renderSource: "ssr-seed", renderReason: "window arrived in SSR HTML; no browser responseEnd" });
  });
  it("separates actual SSR seed from CSR fallback and excludes timeouts from percentiles", () => {
    const groups = renderStatsBySource([
      { ssrSeed: true, renderSource: "ssr-seed", renderMs: null, readyMs: 50, readyTimeout: false },
      { ssrSeed: false, renderSource: "csr-window", renderMs: 150, readyMs: 500, readyTimeout: false },
      { ssrSeed: false, renderSource: "csr-window", renderMs: 9999, readyMs: 9999, readyTimeout: true },
    ]);
    expect(groups).toEqual([
      { source: "SSR", n: 1, renderObserved: 0, renderP50: null, renderP95: null, renderMax: null, readyP50: 50, readyP95: 50 },
      { source: "CSR", n: 2, renderObserved: 1, renderP50: 150, renderP95: 150, renderMax: 150, readyP50: 500, readyP95: 500 },
    ]);
  });
  it("enables the HttpOnly SSR cookie by default and accepts explicit CSR / SSR overrides", () => {
    expect(parseArgs([]).ssrCookie).toBe(true);
    expect(parseArgs(["--no-ssr-cookie"]).ssrCookie).toBe(false);
    expect(parseArgs(["--no-ssr-cookie", "--ssr-cookie"]).ssrCookie).toBe(true);
  });
});


describe("render report comparison", () => {
  const scenario = (ssrSeed: boolean, renderMs: number) => ({ key: "detail-long", mode: "warm", selectorMode: "contract", target: { identifier: "fixture" },
    rounds: [{ ssrSeed, firstRealMs: 1 }], stats: { readyP75: 500, readyP95: 600, jumpsMax: 0, serialDepthMax: 2, apiFirstScreenP50: 2,
      bySource: [{ source: ssrSeed ? "SSR" : "CSR", renderP95: ssrSeed ? null : renderMs }] } }) as any;
  it("persists render independently and refuses to subtract different actual sources or cookie settings", () => {
    const report = (seed: boolean, render: number, cookie = true) => ({ meta: { schema: 3, ssrCookie: cookie }, scenarios: [scenario(seed, render)] });
    const same = buildCompare(report(false, 234), report(false, 123));
    expect(same.rows[0]).toMatchObject({ comparable: true, beforeRenderP95: 234, afterRenderP95: 123 });
    expect(same.markdown).toContain("render p95（CSR）");
    expect(same.markdown).toContain("234.0 → 123.0");
    for (const changed of [report(true, 123), report(false, 123, false)]) {
      const result = buildCompare(report(false, 234), changed);
      expect(result.rows[0]).toMatchObject({ comparable: false, beforeRenderP95: null, afterRenderP95: null, beforeReadyP95: null, afterReadyP95: null });
      expect(result.markdown).toContain("不可比（SSR/CSR 来源）");
    }
  });
});
