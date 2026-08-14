import { describe, expect, it } from "vitest";
import {
  parsePluginDirectory,
  PluginDirectoryError,
  type PluginDirectoryFile,
} from "./plugin-directory";

function directoryFile(
  path: string,
  content: string,
): PluginDirectoryFile {
  const bytes = new TextEncoder().encode(content);
  return {
    name: path.split("/").at(-1)!,
    size: bytes.byteLength,
    webkitRelativePath: path,
    text: () => Promise.resolve(content),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

describe("parsePluginDirectory", () => {
  it("detects a Claude manifest and recursively encodes artifact files", async () => {
    const parsed = await parsePluginDirectory([
      directoryFile(
        "review-plugin/.claude-plugin/plugin.json",
        JSON.stringify({ name: "Review tools", version: "1.2.3" }),
      ),
      directoryFile("review-plugin/skills/review/SKILL.md", "# Review"),
      directoryFile("review-plugin/bin/icon.bin", "\u0000\u0001"),
    ]);

    expect(parsed).toMatchObject({
      provider: "claude",
      folderName: "review-plugin",
      manifestPath: ".claude-plugin/plugin.json",
      manifest: { name: "Review tools", version: "1.2.3" },
      fileCount: 3,
    });
    expect(parsed.files).toEqual([
      {
        path: "skills/review/SKILL.md",
        encoding: "base64",
        content: "IyBSZXZpZXc=",
      },
      { path: "bin/icon.bin", encoding: "base64", content: "AAE=" },
    ]);
  });

  it("detects a Codex manifest without a synthetic root directory", async () => {
    const parsed = await parsePluginDirectory([
      directoryFile(
        ".codex-plugin/plugin.json",
        JSON.stringify({ name: "Codex tools", version: "2.0.0" }),
      ),
    ]);

    expect(parsed.provider).toBe("codex");
    expect(parsed.manifestPath).toBe(".codex-plugin/plugin.json");
    expect(parsed.files).toEqual([]);
  });

  it("rejects a directory containing multiple provider manifests", async () => {
    await expect(
      parsePluginDirectory([
        directoryFile("bundle/.claude-plugin/plugin.json", "{}"),
        directoryFile("bundle/.codex-plugin/plugin.json", "{}"),
      ]),
    ).rejects.toMatchObject({
      code: "multiple_manifests",
    } satisfies Partial<PluginDirectoryError>);
  });

  it("rejects malformed manifest JSON", async () => {
    await expect(
      parsePluginDirectory([
        directoryFile("broken/.claude-plugin/plugin.json", "not-json"),
      ]),
    ).rejects.toMatchObject({
      code: "invalid_manifest",
    } satisfies Partial<PluginDirectoryError>);
  });
});
