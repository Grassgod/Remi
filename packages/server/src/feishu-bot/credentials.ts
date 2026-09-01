/**
 * Envelope encryption for Workspace Feishu bot secrets (MUL-206).
 *
 * Same construction as `packages/server/src/scm/credentials.ts` — AES-256-GCM
 * with the workspace and field bound in as AAD, so a ciphertext lifted out of
 * one row cannot be replayed into another workspace or another field. Keys are
 * resolved per call rather than cached, because the deployment may rotate
 * `MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY` without restarting the API.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_ENV = "MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY";
const PREVIOUS_KEYS_ENV = "MULTIREMI_FEISHU_BOT_ENCRYPTION_PREVIOUS_KEYS";
// A deployment that already stores SCM credentials has a key of the right
// strength; reuse it (derived, never raw) so enabling the Feishu bot does not
// require a second key-management step before the feature works at all.
const FALLBACK_KEY_ENVS = [
  "MULTIREMI_SCM_ENCRYPTION_KEY",
  "MULTIREMI_SSH_MESH_ENCRYPTION_KEY",
  "MULTIREMI_TOKEN",
] as const;

export type FeishuBotSecretField = "app_secret";

export type FeishuBotEncryptionErrorCode =
  | "encryption_key_missing"
  | "encryption_key_invalid"
  | "decryption_failed";

export class FeishuBotEncryptionError extends Error {
  constructor(message: string, readonly code: FeishuBotEncryptionErrorCode) {
    super(message);
    this.name = "FeishuBotEncryptionError";
  }
}

export interface FeishuBotSecretContext {
  workspaceId: string;
  field: FeishuBotSecretField;
}

export function encryptFeishuBotSecret(plaintext: string, context: FeishuBotSecretContext): string {
  const { id: keyId, key } = resolveEncryptionKeys()[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad(context), "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", keyId, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptFeishuBotSecret(ciphertext: string, context: FeishuBotSecretContext): string {
  try {
    const [version, keyId, ivValue, tagValue, encryptedValue, ...rest] = ciphertext.split(".");
    if (version !== "v1" || !keyId || !ivValue || !tagValue || encryptedValue === undefined || rest.length) {
      throw new Error("invalid encrypted secret envelope");
    }
    // A rotated key changes the id, so filter to the writing key first and only
    // fall back to a full sweep when the envelope predates id tagging.
    const keys = resolveEncryptionKeys();
    const candidates = keys.filter((candidate) => candidate.id === keyId);
    for (const candidate of candidates.length ? candidates : keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", candidate.key, Buffer.from(ivValue, "base64url"));
        decipher.setAAD(Buffer.from(aad(context), "utf8"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(encryptedValue, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Try the remaining configured keys before giving up.
      }
    }
    throw new Error("no configured key could decrypt the secret");
  } catch (error) {
    if (error instanceof FeishuBotEncryptionError) throw error;
    throw new FeishuBotEncryptionError(
      "Feishu bot secret could not be decrypted with the configured key",
      "decryption_failed",
    );
  }
}

/** Is a key configured? Lets callers report a setup problem instead of throwing. */
export function feishuBotEncryptionAvailable(): boolean {
  try {
    resolveEncryptionKeys();
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-reversible display hint (`cli_a1b2••••`). Never derived from the secret's
 * own bytes beyond its leading characters, and never stored alongside anything
 * that would let it be extended.
 */
export function feishuBotSecretHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) return "";
  return `${trimmed.slice(0, Math.min(4, trimmed.length))}${"•".repeat(6)}`;
}

function resolveEncryptionKeys(): Array<{ id: string; key: Buffer }> {
  const candidates: Buffer[] = [];
  const configured = process.env[KEY_ENV]?.trim();
  if (configured) candidates.push(decodeBase64Key(configured, KEY_ENV));

  for (const name of FALLBACK_KEY_ENVS) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    candidates.push(createHash("sha256").update(`multiremi-feishu-bot\0${name}\0${value}`).digest());
  }
  for (const value of (process.env[PREVIOUS_KEYS_ENV] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    candidates.push(decodeBase64Key(value, PREVIOUS_KEYS_ENV));
  }
  if (!candidates.length) {
    throw new FeishuBotEncryptionError(
      `${KEY_ENV} (or the deployment master token) must be configured before Feishu bot credentials can be stored`,
      "encryption_key_missing",
    );
  }
  const seen = new Set<string>();
  return candidates.flatMap((key) => {
    const id = createHash("sha256").update(key).digest("base64url").slice(0, 16);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, key }];
  });
}

function decodeBase64Key(value: string, envName: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
    throw new FeishuBotEncryptionError(
      `${envName} must be a base64-encoded 32-byte key`,
      "encryption_key_invalid",
    );
  }
  return decoded;
}

function aad(context: FeishuBotSecretContext): string {
  return `multiremi-feishu-bot\0${context.workspaceId}\0${context.field}`;
}
