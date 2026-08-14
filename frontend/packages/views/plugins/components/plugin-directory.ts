import type {
  AgentPluginProvider,
  ImportAgentPluginInput,
} from "@multiremi/core/plugins";

const MANIFEST_PATHS: Record<AgentPluginProvider, string> = {
  claude: ".claude-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
};

const MAX_FILES = 2_000;
const MAX_BYTES = 25 * 1024 * 1024;

export interface PluginDirectoryFile {
  name: string;
  size: number;
  webkitRelativePath?: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ParsedPluginDirectory {
  provider: AgentPluginProvider;
  folderName: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  files: NonNullable<ImportAgentPluginInput["files"]>;
  fileCount: number;
  totalBytes: number;
}

export type PluginDirectoryErrorCode =
  | "empty_directory"
  | "too_many_files"
  | "artifact_too_large"
  | "manifest_missing"
  | "multiple_manifests"
  | "invalid_manifest"
  | "invalid_directory";

export class PluginDirectoryError extends Error {
  constructor(readonly code: PluginDirectoryErrorCode) {
    super(code);
    this.name = "PluginDirectoryError";
  }
}

function relativePath(file: PluginDirectoryFile): string {
  return (file.webkitRelativePath || file.name).replaceAll("\\", "/");
}

function matchManifest(path: string) {
  return (Object.entries(MANIFEST_PATHS) as Array<
    [AgentPluginProvider, string]
  >).flatMap(([provider, manifestPath]) => {
    if (path === manifestPath) {
      return [{ provider, manifestPath, rootPrefix: "" }];
    }
    const suffix = `/${manifestPath}`;
    if (!path.endsWith(suffix)) return [];
    return [
      {
        provider,
        manifestPath,
        rootPrefix: path.slice(0, -manifestPath.length),
      },
    ];
  });
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function parsePluginDirectory(
  input: ReadonlyArray<PluginDirectoryFile>,
): Promise<ParsedPluginDirectory> {
  if (input.length === 0) throw new PluginDirectoryError("empty_directory");
  if (input.length > MAX_FILES) {
    throw new PluginDirectoryError("too_many_files");
  }

  const totalBytes = input.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_BYTES) {
    throw new PluginDirectoryError("artifact_too_large");
  }

  const matches = input.flatMap((file) =>
    matchManifest(relativePath(file)).map((match) => ({ file, ...match })),
  );
  if (matches.length === 0) {
    throw new PluginDirectoryError("manifest_missing");
  }
  if (matches.length > 1) {
    throw new PluginDirectoryError("multiple_manifests");
  }

  const match = matches[0]!;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await match.file.text());
  } catch {
    throw new PluginDirectoryError("invalid_manifest");
  }
  if (!isRecord(manifest)) {
    throw new PluginDirectoryError("invalid_manifest");
  }

  const files = await Promise.all(
    input.flatMap((file) => {
      if (file === match.file) return [];
      const path = relativePath(file);
      if (!path.startsWith(match.rootPrefix)) {
        throw new PluginDirectoryError("invalid_directory");
      }
      const artifactPath = path.slice(match.rootPrefix.length);
      if (
        !artifactPath ||
        artifactPath.startsWith("/") ||
        artifactPath.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new PluginDirectoryError("invalid_directory");
      }
      return [
        file.arrayBuffer().then((buffer) => ({
          path: artifactPath,
          encoding: "base64" as const,
          content: bytesToBase64(buffer),
        })),
      ];
    }),
  );

  const root = match.rootPrefix.replace(/\/$/, "");
  const folderName = root.split("/").at(-1) || String(manifest.name ?? "plugin");
  return {
    provider: match.provider,
    folderName,
    manifestPath: match.manifestPath,
    manifest,
    files,
    fileCount: input.length,
    totalBytes,
  };
}
