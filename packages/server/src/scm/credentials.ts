import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SCM_KEY_ENV = "MULTIREMI_SCM_ENCRYPTION_KEY";
const PREVIOUS_KEYS_ENV = "MULTIREMI_SCM_ENCRYPTION_PREVIOUS_KEYS";
const FALLBACK_KEY_ENVS = ["MULTIREMI_SSH_MESH_ENCRYPTION_KEY", "MULTIREMI_TOKEN"] as const;

export class ScmCredentialEncryptionError extends Error {
  constructor(message: string, readonly code: "encryption_key_missing" | "encryption_key_invalid" | "decryption_failed") {
    super(message);
  }
}

export function encryptScmCredential(
  plaintext: string,
  context: { workspaceId: string; connectionId: string; field: "access_token" | "webhook_secret" },
): string {
  const { id: keyId, key } = resolveEncryptionKeys()[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad(context), "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v2", keyId, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptScmCredential(
  ciphertext: string,
  context: { workspaceId: string; connectionId: string; field: "access_token" | "webhook_secret" },
): string {
  try {
    const parts = ciphertext.split(".");
    const version = parts[0];
    const keyId = version === "v2" ? parts[1] : null;
    const values = version === "v2" ? parts.slice(2) : parts.slice(1);
    const [ivValue, tagValue, encryptedValue, ...rest] = values;
    if ((version !== "v1" && version !== "v2") || !ivValue || !tagValue || encryptedValue === undefined || rest.length) {
      throw new Error("invalid encrypted credential envelope");
    }
    const candidates = resolveEncryptionKeys().filter((candidate) => keyId == null || candidate.id === keyId);
    for (const candidate of candidates) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", candidate.key, Buffer.from(ivValue, "base64url"));
        decipher.setAAD(Buffer.from(aad(context), "utf8"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(encryptedValue, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Try the remaining configured keys for legacy v1 envelopes.
      }
    }
    throw new Error("no configured key could decrypt the credential");
  } catch (error) {
    if (error instanceof ScmCredentialEncryptionError) throw error;
    throw new ScmCredentialEncryptionError(
      "SCM credential could not be decrypted with the configured key",
      "decryption_failed",
    );
  }
}

function resolveEncryptionKeys(): Array<{ id: string; key: Buffer }> {
  const candidates: Buffer[] = [];
  const configured = process.env[SCM_KEY_ENV]?.trim();
  if (configured) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/u, "") !== configured.replace(/=+$/u, "")) {
      throw new ScmCredentialEncryptionError(
        `${SCM_KEY_ENV} must be a base64-encoded 32-byte key`,
        "encryption_key_invalid",
      );
    }
    candidates.push(decoded);
  }

  for (const name of FALLBACK_KEY_ENVS) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    candidates.push(createHash("sha256").update(`multiremi-scm\0${name}\0${value}`).digest());
  }
  for (const value of (process.env[PREVIOUS_KEYS_ENV] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
      throw new ScmCredentialEncryptionError(
        `${PREVIOUS_KEYS_ENV} must contain comma-separated base64-encoded 32-byte keys`,
        "encryption_key_invalid",
      );
    }
    candidates.push(decoded);
  }
  if (!candidates.length) {
    throw new ScmCredentialEncryptionError(
      `${SCM_KEY_ENV} (or the deployment master token) must be configured before SCM credentials can be stored`,
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

function aad(context: { workspaceId: string; connectionId: string; field: string }): string {
  return `multiremi-scm\0${context.workspaceId}\0${context.connectionId}\0${context.field}`;
}
