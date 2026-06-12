/**
 * secretbox AES-256-GCM: round-trips, the Go-compatible nonce(12)||ct||tag(16)
 * layout, tamper detection, and base64 key loading. No DB, no network.
 */

import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { Box, loadKey, boxFromEnv, KEY_SIZE } from "../src/util/secretbox.js";

const key = randomBytes(KEY_SIZE);

test("seal then open round-trips the plaintext", () => {
  const box = new Box(key);
  const sealed = box.seal("super-secret-app-secret");
  expect(box.openString(sealed)).toBe("super-secret-app-secret");
});

test("sealed layout is nonce(12) || ciphertext || tag(16)", () => {
  const box = new Box(key);
  const pt = Buffer.from("abcdef"); // 6 bytes
  const sealed = box.seal(pt);
  // 12 (nonce) + 6 (ciphertext, GCM is a stream cipher so == plaintext len) + 16 (tag)
  expect(sealed.length).toBe(12 + 6 + 16);
});

test("each seal uses a fresh nonce (non-deterministic ciphertext)", () => {
  const box = new Box(key);
  const a = box.seal("same");
  const b = box.seal("same");
  expect(a.equals(b)).toBe(false);
  expect(box.openString(a)).toBe("same");
  expect(box.openString(b)).toBe("same");
});

test("a tampered ciphertext fails authentication", () => {
  const box = new Box(key);
  const sealed = box.seal("integrity-protected");
  sealed[sealed.length - 1] ^= 0xff; // flip a tag byte
  expect(() => box.open(sealed)).toThrow();
});

test("a too-short input is rejected", () => {
  const box = new Box(key);
  expect(() => box.open(Buffer.alloc(5))).toThrow(/too short/);
});

test("the wrong key cannot open the box", () => {
  const sealed = new Box(key).seal("x");
  expect(() => new Box(randomBytes(KEY_SIZE)).open(sealed)).toThrow();
});

test("a wrong-size key is rejected at construction", () => {
  expect(() => new Box(randomBytes(16))).toThrow(/32 bytes/);
});

test("loadKey: unset → null, malformed → throw, valid → 32 bytes", () => {
  const VAR = "TEST_SECRETBOX_KEY_" + Date.now();
  expect(loadKey(VAR)).toBeNull();
  process.env[VAR] = "not-32-bytes";
  expect(() => loadKey(VAR)).toThrow(/expected 32/);
  process.env[VAR] = key.toString("base64");
  expect(loadKey(VAR)!.length).toBe(KEY_SIZE);
  // boxFromEnv builds a working Box from the same var.
  const box = boxFromEnv(VAR)!;
  expect(box.openString(box.seal("ok"))).toBe("ok");
  delete process.env[VAR];
});
