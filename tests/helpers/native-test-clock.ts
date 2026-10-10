/** Pure preload capture: no product imports, environment reads or clock samples. */
export const nativeTestClock = Object.freeze({
  Date: globalThis.Date,
  now: Date.now,
  random: Math.random,
  getRandomValues: crypto.getRandomValues,
  randomUUID: crypto.randomUUID,
});
