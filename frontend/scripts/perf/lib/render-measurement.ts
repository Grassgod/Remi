import type { PerfStateTransition } from "./jump-recorder";
import { nearestRankPercentile } from "./jump-recorder";

export interface LogWindowTiming { startMs: number; responseEndMs: number }
export interface RenderMeasurement {
  renderMs: number | null;
  renderSource: "csr-window" | "ssr-seed" | "unobserved";
  renderReason: string | null;
  windowResponseEndMs: number | null;
}

/** A browser window that actually preceded this visit's first normal reveal. */
export function measureLogRender(input: {
  navStartMs: number;
  states: readonly PerfStateTransition[];
  windows: readonly LogWindowTiming[];
  ssrSeed: boolean;
}): RenderMeasurement {
  const absent = (reason: string): RenderMeasurement => ({ renderMs: null, renderSource: "unobserved", renderReason: reason, windowResponseEndMs: null });
  if (input.ssrSeed) return { ...absent("window arrived in SSR HTML; no browser responseEnd"), renderSource: "ssr-seed" };
  const state = input.states.find(state => state.t >= input.navStartMs && (state.scrollRoot === undefined || state.scrollRoot === "issue-detail") && (state.value === "ready-forced" || (state.value === "ready" && (state.fresh == null || state.fresh === "1"))));
  if (!state) return absent("normal reveal not observed");
  if (state.value !== "ready") return absent("forced reveal");
  const window = input.windows.find(window => window.startMs >= input.navStartMs && window.responseEndMs > 0 && window.responseEndMs <= state.t);
  if (!window) return absent("target window responseEnd before reveal not observed");
  return { renderMs: Math.round((state.t - window.responseEndMs) * 10) / 10, renderSource: "csr-window", renderReason: null, windowResponseEndMs: window.responseEndMs - input.navStartMs };
}

export function renderStatsBySource(rounds: readonly (Partial<RenderMeasurement> & { ssrSeed?: boolean; readyMs: number | null; readyTimeout: boolean })[]) {
  return (["SSR", "CSR"] as const).map(source => {
    const group = rounds.filter(round => (round.ssrSeed ? "SSR" : "CSR") === source);
    const render = group.flatMap(round => round.renderSource === "csr-window" && round.renderMs != null && !round.readyTimeout ? [round.renderMs] : []);
    const ready = group.flatMap(round => round.readyMs != null && !round.readyTimeout ? [round.readyMs] : []);
    return { source, n: group.length, renderObserved: render.length,
      renderP50: nearestRankPercentile(render, .5), renderP95: nearestRankPercentile(render, .95), renderMax: render.length ? Math.max(...render) : null,
      readyP50: nearestRankPercentile(ready, .5), readyP95: nearestRankPercentile(ready, .95) };
  }).filter(group => group.n > 0);
}
