import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type Scope = { workspaceId: string; runtimeId: string; credentialId: string };
const KEY_ENV = "MULTIREMI_PROVIDER_ENCRYPTION_KEY";
const PREVIOUS_ENV = "MULTIREMI_PROVIDER_ENCRYPTION_PREVIOUS_KEYS";

function keys() {
  const decode = (value: string) => {
    const key = Buffer.from(value, "base64");
    if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      throw new Error(`${KEY_ENV} and ${PREVIOUS_ENV} require base64-encoded 32-byte keys`);
    }
    return key;
  };
  const configured = process.env[KEY_ENV]?.trim();
  const master = process.env.MULTIREMI_TOKEN?.trim();
  const values = [
    ...(configured ? [decode(configured)] : []),
    ...(master ? [createHash("sha256").update(`remi-runtime-provider\0${master}`).digest()] : []),
    ...(process.env[PREVIOUS_ENV] ?? "").split(",").map(value => value.trim()).filter(Boolean).map(decode),
  ];
  if (!values.length) throw new Error(`${KEY_ENV} or MULTIREMI_TOKEN must be configured on the server before storing API keys`);
  return values.map(key => ({ key, id: createHash("sha256").update(key).digest("base64url").slice(0, 16) }));
}

function aad(scope: Scope) { return Buffer.from(JSON.stringify(["remi-runtime-provider", scope.workspaceId, scope.runtimeId, scope.credentialId])); }

export function encryptRuntimeProviderKey(value: string, scope: Scope): string {
  const { key, id } = keys()[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(scope));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptRuntimeProviderKey(value: string, scope: Scope): string {
  const [version, id, iv, tag, data, ...extra] = value.split(".");
  const selected = keys().find(key => key.id === id);
  try {
    if (version !== "v1" || !selected || !iv || !tag || !data || extra.length) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", selected.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aad(scope));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new Error("Runtime provider key could not be decrypted with the configured server key"); }
}
