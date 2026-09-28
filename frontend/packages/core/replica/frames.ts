/**
 * Small helpers over frame batches, shared by the page and the Worker.
 *
 * Its own module rather than a function in `worker.ts` on purpose: `worker.ts`
 * imports `sqlite-wasm`, and a page-side `import { rangeOfFrames } from
 * "./worker"` drags the whole wasm build into the page bundle — measured at
 * 24 KB → 495 KB for the fixture page. The Worker must be the only place that
 * pays for it.
 */

/**
 * The inclusive range a batch covers.
 *
 * The batch's own span, not the union of its seqs: a batch is delivered in order,
 * so the span is what the reader tabs re-read, and a patch inside it changes a row
 * they already hold.
 *
 * A loop rather than `Math.min(...seqs)`: a reconnect replay can be a few hundred
 * frames, and spreading that passes every seq as a call argument.
 */
export function rangeOfFrames(frames: readonly { seq: number }[]): { from: number; to: number } | null {
  if (frames.length === 0) return null;
  let from = frames[0]!.seq;
  let to = frames[0]!.seq;
  for (const frame of frames) {
    if (frame.seq < from) from = frame.seq;
    if (frame.seq > to) to = frame.seq;
  }
  return { from, to };
}
