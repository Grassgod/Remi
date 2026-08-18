import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENCRYPTION_ENV = "MULTIREMI_SSH_MESH_ENCRYPTION_KEY";
const ENVELOPE_VERSION = "v1";

export interface SshMeshKeyMaterial {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export class SshMeshKeyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SshMeshKeyError";
  }
}

export function encryptSshMeshPrivateKey(
  plaintext: string,
  workspaceId: string,
  keyVersion: number,
): string {
  const key = sshMeshEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(sshMeshAad(workspaceId, keyVersion), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptSshMeshPrivateKey(
  envelope: string,
  workspaceId: string,
  keyVersion: number,
): string {
  const [version, nonceValue, ciphertextValue, tagValue, ...extra] = envelope.split(".");
  if (
    version !== ENVELOPE_VERSION
    || !nonceValue
    || !ciphertextValue
    || !tagValue
    || extra.length
  ) {
    throw new SshMeshKeyError("SSH Mesh private key envelope is invalid", "invalid_key_envelope");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      sshMeshEncryptionKey(),
      Buffer.from(nonceValue, "base64url"),
    );
    decipher.setAAD(Buffer.from(sshMeshAad(workspaceId, keyVersion), "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SshMeshKeyError) throw error;
    throw new SshMeshKeyError(
      "SSH Mesh private key could not be decrypted with the configured key",
      "key_decryption_failed",
    );
  }
}

/** Generate an OpenSSH-native Ed25519 key. The private material never enters argv. */
export async function generateSshMeshKeyMaterial(workspaceId: string): Promise<SshMeshKeyMaterial> {
  return withTemporaryKeyFile(async (keyPath) => {
    const result = await runSshKeygen([
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      `multiremi-ssh-mesh@${safeKeyComment(workspaceId)}`,
      "-f",
      keyPath,
    ]);
    if (result.exitCode !== 0) {
      throw new SshMeshKeyError(
        `ssh-keygen could not generate an Ed25519 key: ${safeSshKeygenError(result.stderr)}`,
        "key_generation_failed",
      );
    }
    const privateKey = ensureTrailingNewline(await readFile(keyPath, "utf8"));
    const publicKey = normalizeEd25519PublicKey(await readFile(`${keyPath}.pub`, "utf8"), workspaceId);
    return { privateKey, publicKey, fingerprint: sshPublicKeyFingerprint(publicKey) };
  });
}

function sshMeshEncryptionKey(): Buffer {
  const raw = process.env[ENCRYPTION_ENV]?.trim() ?? "";
  if (!raw) {
    throw new SshMeshKeyError(
      `${ENCRYPTION_ENV} must be configured before SSH Mesh can store or read private keys`,
      "encryption_key_missing",
    );
  }
  const value = raw.startsWith("base64:") ? raw.slice("base64:".length) : raw;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length !== 32) {
    throw new SshMeshKeyError(
      `${ENCRYPTION_ENV} must be a base64-encoded 32-byte key`,
      "encryption_key_invalid",
    );
  }
  return decoded;
}

function sshMeshAad(workspaceId: string, keyVersion: number): string {
  return `multiremi:ssh-mesh:${workspaceId}:key:${keyVersion}`;
}

function normalizeEd25519PublicKey(value: string, workspaceId: string): string {
  const [algorithm, encoded] = value.trim().split(/\s+/);
  if (algorithm !== "ssh-ed25519" || !encoded) {
    throw new SshMeshKeyError("SSH Mesh only supports Ed25519 private keys", "unsupported_key_type");
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(encoded, "base64");
  } catch {
    blob = Buffer.alloc(0);
  }
  if (!blob.length) throw new SshMeshKeyError("SSH public key is invalid", "invalid_public_key");
  return `ssh-ed25519 ${encoded} multiremi-ssh-mesh@${safeKeyComment(workspaceId)}`;
}

function sshPublicKeyFingerprint(publicKey: string): string {
  const encoded = publicKey.trim().split(/\s+/)[1] ?? "";
  const digest = createHash("sha256").update(Buffer.from(encoded, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/g, "")}`;
}

async function withTemporaryKeyFile<T>(callback: (keyPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "multiremi-ssh-mesh-"));
  try {
    return await callback(join(directory, "id_ed25519"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runSshKeygen(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let processHandle: ReturnType<typeof Bun.spawn>;
  try {
    processHandle = Bun.spawn(["ssh-keygen", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new SshMeshKeyError("ssh-keygen is required on the Multiremi server", "ssh_keygen_missing");
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout as ReadableStream<Uint8Array>).text(),
    new Response(processHandle.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function safeSshKeygenError(stderr: string): string {
  return stderr.trim().replace(/[\r\n]+/g, " ").slice(0, 240) || "unknown error";
}

function safeKeyComment(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "workspace";
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
