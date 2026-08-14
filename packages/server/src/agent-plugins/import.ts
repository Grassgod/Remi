import { createHash } from "node:crypto";
import type {
  ImportAgentPluginInput,
  MultiremiAgentPluginArtifactFile,
  MultiremiAgentPluginProvider,
  MultiremiAgentPluginSourceType,
} from "@multiremi/contracts/types.js";

const MAX_ARTIFACT_FILES = 2_000;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class AgentPluginValidationError extends Error {
  constructor(message: string, readonly code = "invalid_agent_plugin") {
    super(message);
    this.name = "AgentPluginValidationError";
  }
}

export interface NormalizedAgentPluginArtifact {
  provider: MultiremiAgentPluginProvider;
  name: string;
  description: string;
  version: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  files: MultiremiAgentPluginArtifactFile[];
  artifactDigest: string;
  artifactSize: number;
  artifactJson: string;
  sourceType: MultiremiAgentPluginSourceType;
}

export function normalizeAgentPluginProvider(value: unknown): MultiremiAgentPluginProvider {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "claude" || provider === "codex") return provider;
  throw new AgentPluginValidationError('provider must be "claude" or "codex"', "invalid_provider");
}

export function expectedAgentPluginManifestPath(provider: MultiremiAgentPluginProvider): string {
  return provider === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
}

export function normalizeAgentPluginSourceType(value: unknown): MultiremiAgentPluginSourceType {
  const source = String(value ?? "manifest").trim().toLowerCase();
  if (source === "manifest" || source === "git" || source === "marketplace" || source === "zip" || source === "runtime") {
    return source;
  }
  throw new AgentPluginValidationError("invalid plugin source type", "invalid_source_type");
}

export function buildAgentPluginArtifact(
  raw: Pick<ImportAgentPluginInput, "provider" | "name" | "description" | "version" | "manifestPath" | "manifest_path" | "manifest" | "files" | "sourceType" | "source_type">,
): NormalizedAgentPluginArtifact {
  const provider = normalizeAgentPluginProvider(raw.provider);
  if (!isRecord(raw.manifest)) {
    throw new AgentPluginValidationError("manifest must be a JSON object", "invalid_manifest");
  }
  const manifest = canonicalClone(raw.manifest) as Record<string, unknown>;
  const manifestPath = normalizeArtifactPath(raw.manifestPath ?? raw.manifest_path ?? expectedAgentPluginManifestPath(provider));
  const expectedManifestPath = expectedAgentPluginManifestPath(provider);
  if (manifestPath !== expectedManifestPath) {
    throw new AgentPluginValidationError(
      `${provider} plugins require ${expectedManifestPath}`,
      "invalid_manifest_path",
    );
  }

  const name = cleanString(raw.name) ?? cleanString(manifest.name);
  if (!name) throw new AgentPluginValidationError("plugin name is required", "missing_name");
  const version = cleanString(raw.version) ?? cleanString(manifest.version);
  if (!version) throw new AgentPluginValidationError("plugin version is required", "missing_version");
  if (!SEMVER_PATTERN.test(version)) {
    throw new AgentPluginValidationError("plugin version must be valid SemVer", "invalid_version");
  }
  const description = cleanString(raw.description) ?? cleanString(manifest.description) ?? "";
  const sourceType = normalizeAgentPluginSourceType(raw.sourceType ?? raw.source_type);

  const rawFiles = Array.isArray(raw.files) ? raw.files : [];
  if (rawFiles.length > MAX_ARTIFACT_FILES) {
    throw new AgentPluginValidationError(`plugin artifact exceeds ${MAX_ARTIFACT_FILES} files`, "artifact_too_large");
  }

  const byPath = new Map<string, MultiremiAgentPluginArtifactFile>();
  for (const file of rawFiles) {
    if (!file || typeof file !== "object") {
      throw new AgentPluginValidationError("plugin files must be objects", "invalid_artifact_file");
    }
    const path = normalizeArtifactPath(file.path);
    if (path === manifestPath) continue;
    if (byPath.has(path)) {
      throw new AgentPluginValidationError(`duplicate plugin file: ${path}`, "duplicate_artifact_file");
    }
    const encoding = file.encoding === "base64" ? "base64" : "utf8";
    const content = String(file.content ?? "");
    const bytes = decodeArtifactContent(content, encoding, path);
    byPath.set(path, {
      path,
      encoding,
      content,
      size: bytes.byteLength,
      digest: sha256(bytes),
      ...(file.executable === true ? { executable: true } : {}),
    });
  }

  const manifestContent = `${canonicalJson(manifest)}\n`;
  const manifestBytes = Buffer.from(manifestContent, "utf8");
  byPath.set(manifestPath, {
    path: manifestPath,
    encoding: "utf8",
    content: manifestContent,
    size: manifestBytes.byteLength,
    digest: sha256(manifestBytes),
  });

  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const artifactSize = files.reduce((total, file) => total + file.size, 0);
  if (artifactSize > MAX_ARTIFACT_BYTES) {
    throw new AgentPluginValidationError(`plugin artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`, "artifact_too_large");
  }
  const artifact = canonicalClone({ provider, manifestPath, manifest, files });
  const artifactJson = canonicalJson(artifact);
  return {
    provider,
    name,
    description,
    version,
    manifestPath,
    manifest,
    files,
    artifactDigest: sha256(Buffer.from(artifactJson, "utf8")),
    artifactSize,
    artifactJson,
    sourceType,
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalClone(value));
}

function canonicalClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) normalized[key] = canonicalClone(value[key]);
  return normalized;
}

function normalizeArtifactPath(value: unknown): string {
  const path = String(value ?? "").trim();
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new AgentPluginValidationError(`invalid plugin file path: ${path || "(empty)"}`, "invalid_artifact_path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AgentPluginValidationError(`invalid plugin file path: ${path}`, "invalid_artifact_path");
  }
  return segments.join("/");
}

function decodeArtifactContent(content: string, encoding: "utf8" | "base64", path: string): Buffer {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  const compact = content.replace(/\s+/g, "");
  if (compact && (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)) {
    throw new AgentPluginValidationError(`invalid base64 content for ${path}`, "invalid_artifact_file");
  }
  return Buffer.from(compact, "base64");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanString(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
