/**
 * Authenticated symmetric encryption for secrets at rest (Lark app_secret and
 * any future per-tenant secret column) — the Bun port of Go
 * server/internal/util/secretbox.
 *
 * AES-256-GCM with a per-message 12-byte random nonce prepended to the
 * ciphertext: the sealed layout is nonce(12) || ciphertext || tag(16), wire-
 * compatible with the Go implementation, so a secret sealed by the Go server
 * opens here and vice versa. GCM authenticates, so a tampered row throws.
 *
 * Key: 32 bytes, loaded from a base64 env var (loadKey). Rotation is not
 * supported (single master key), matching Go.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_SIZE = 32;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

export class Box {
  private readonly key: Buffer;

  constructor(key: Buffer | Uint8Array) {
    if (key.length !== KEY_SIZE) throw new Error("secretbox: key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  /** Encrypt; returns nonce || ciphertext || tag. Random nonce per call. */
  seal(plaintext: Buffer | Uint8Array | string): Buffer {
    const nonce = randomBytes(NONCE_SIZE);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ct, tag]);
  }

  /** Reverse seal. Throws on a too-short input or a GCM auth failure. */
  open(sealed: Buffer | Uint8Array): Buffer {
    const buf = Buffer.from(sealed);
    if (buf.length < NONCE_SIZE + TAG_SIZE) throw new Error("secretbox: ciphertext too short");
    const nonce = buf.subarray(0, NONCE_SIZE);
    const tag = buf.subarray(buf.length - TAG_SIZE);
    const ct = buf.subarray(NONCE_SIZE, buf.length - TAG_SIZE);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  /** Convenience: open and decode the plaintext as UTF-8. */
  openString(sealed: Buffer | Uint8Array): string {
    return this.open(sealed).toString("utf8");
  }
}

/**
 * Load a base64-encoded 32-byte key from `envVar`. Returns null when the var
 * is unset (feature-off), throws when set but malformed (fail loud, never use
 * a zero key). Mirrors the Go LoadKey contract minus the "unset = error" — the
 * Bun callers treat unset as "Lark outbound disabled".
 */
export function loadKey(envVar: string): Buffer | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`secretbox: ${envVar} is not valid base64`);
  }
  if (key.length !== KEY_SIZE) {
    throw new Error(`secretbox: ${envVar} decodes to ${key.length} bytes, expected ${KEY_SIZE}`);
  }
  return key;
}

/** A Box built from `envVar`'s key, or null when the var is unset. */
export function boxFromEnv(envVar: string): Box | null {
  const key = loadKey(envVar);
  return key ? new Box(key) : null;
}
