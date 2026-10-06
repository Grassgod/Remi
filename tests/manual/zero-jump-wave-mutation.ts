/** A real local A -> B -> C chain must still fail the CI reveal-wave gate. */
import { computeInFlightWaves, preRevealWaveFailure } from "../integration/zero-jump-waves";
import { groupResults, type RoundResult } from "../integration/zero-jump-check";
import { judgeZeroJumpRun } from "../../frontend/scripts/perf/lib/zero-jump-verdict";

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request =>
  new Response(new URL(request.url).pathname, { headers: { "content-type": "text/plain" } }),
});
try {
  const requests = [];
  for (const [index, path] of ["/A", "/B", "/C"].entries()) {
    const startMs = performance.now();
    const response = await fetch(new URL(path, server.url));
    await response.text(); // B starts only after A's complete body, and likewise C.
    requests.push({ index, path, startMs, responseEndMs: performance.now() });
  }
  const waves = computeInFlightWaves(requests);
  // This mutation isolates the wave gate; other structural facts are healthy.
  // Use the actual S7 round-to-verdict path, rather than just checking depth.
  const round = {
    key: "detail-image-fast", mode: "warm", round: 1,
    error: preRevealWaveFailure("blocking", waves.serialDepth),
    jumpCount: 0, readyTimeout: false, readyMs: 1, firstRealMs: 1,
    skeletons: 0, appReadyMs: 1, appReadyForced: false,
  } as RoundResult;
  const verdict = judgeZeroJumpRun({ results: groupResults([round]), allowlist: { rows: [] }, strict: true });
  console.log(JSON.stringify({ requests, waves, error: round.error, verdict }));
  process.exitCode = verdict.ok ? 0 : 1;
} finally {
  server.stop(true);
}
