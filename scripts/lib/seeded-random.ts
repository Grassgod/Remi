/**
 * A small seeded PRNG (sfc32 keyed by SHA-256 of a text seed) so samples,
 * synthetic data and benchmark picks can be replayed from the seed recorded in
 * their reports. Not for anything security-related.
 */
import { createHash } from "node:crypto";

export type RandomSource = () => number;

/** Uniform floats in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed: string): RandomSource {
  const key = createHash("sha256").update(seed, "utf8").digest();
  let a = key.readUInt32LE(0);
  let b = key.readUInt32LE(4);
  let c = key.readUInt32LE(8);
  let d = key.readUInt32LE(12);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Discard the first outputs, which are correlated with the key words.
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** An integer in [0, bound). */
export function randomInt(random: RandomSource, bound: number): number {
  return Math.floor(random() * bound);
}

/** `count` distinct items picked uniformly (partial Fisher–Yates over a copy). */
export function sampleWithoutReplacement<T>(random: RandomSource, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + randomInt(random, pool.length - i);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, take);
}
