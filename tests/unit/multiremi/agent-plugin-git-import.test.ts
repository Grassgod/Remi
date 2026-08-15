import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentPluginGitImportError,
  resolveAgentPluginGitSource,
} from "@multiremi/agent-plugins/git-import.js";

const TEST_FILE_URL_ENV = "MULTIREMI_AGENT_PLUGIN_TEST_ALLOW_FILE_URLS";
const tempRoots: string[] = [];
let previousNodeEnv: string | undefined;
let previousFileUrlOptIn: string | undefined;

beforeEach(() => {
  previousNodeEnv = process.env.NODE_ENV;
  previousFileUrlOptIn = process.env[TEST_FILE_URL_ENV];
  process.env.NODE_ENV = "test";
  process.env[TEST_FILE_URL_ENV] = "1";
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  restoreEnv("NODE_ENV", previousNodeEnv);
  restoreEnv(TEST_FILE_URL_ENV, previousFileUrlOptIn);
});

describe("Agent Plugin Git import", () => {
  it("resolves the default branch, discovers provider manifests and emits canonical artifact inputs", async () => {
    const repo = createRepository("main");
    writeJson(join(repo, "plugins/claude/.claude-plugin/plugin.json"), {
      name: "lark-tools",
      description: "Lark tools",
    });
    writeFile(join(repo, "plugins/claude/skills/lark/SKILL.md"), "# Lark\n");
    writeJson(join(repo, "plugins/codex/.codex-plugin/plugin.json"), {
      name: "wiki-tools",
      description: "Wiki tools",
      version: "1.2.3",
    });
    const executable = join(repo, "plugins/codex/bin/index.sh");
    writeFile(executable, "#!/bin/sh\necho wiki\n");
    chmodSync(executable, 0o755);
    const revision = commitAll(repo, "plugins");
    git(repo, "branch", "release");

    const resolved = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
      sourceSubdir: "plugins",
      includeFiles: true,
    });

    expect(resolved).toMatchObject({
      sourceRef: "main",
      defaultBranch: "main",
      branches: ["main", "release"],
      sourceRevision: revision,
    });
    expect(resolved.candidates).toHaveLength(2);

    const claude = resolved.candidates.find((candidate) => candidate.provider === "claude")!;
    expect(claude).toMatchObject({
      name: "lark-tools",
      description: "Lark tools",
      version: `0.0.0+git.${revision.slice(0, 12)}`,
      pluginSubdir: "plugins/claude",
      manifestPath: ".claude-plugin/plugin.json",
      fileCount: 2,
    });
    expect(claude.files).toEqual([{
      path: "skills/lark/SKILL.md",
      content: Buffer.from("# Lark\n").toString("base64"),
      encoding: "base64",
    }]);
    expect(claude.artifactSizeKnown).toBe(true);
    expect(claude.artifactSize).toBeGreaterThan(0);

    const codex = resolved.candidates.find((candidate) => candidate.provider === "codex")!;
    expect(codex).toMatchObject({
      name: "wiki-tools",
      description: "Wiki tools",
      version: "1.2.3",
      pluginSubdir: "plugins/codex",
      manifestPath: ".codex-plugin/plugin.json",
      fileCount: 2,
    });
    expect(codex.files).toEqual([{
      path: "bin/index.sh",
      content: Buffer.from("#!/bin/sh\necho wiki\n").toString("base64"),
      encoding: "base64",
      executable: true,
    }]);
    expect(codex.files?.some((file) => file.path === codex.manifestPath)).toBe(false);
  });

  it("fetches an explicit tag and filters discovery to one Plugin subtree", async () => {
    const repo = createRepository("trunk");
    const manifestPath = join(repo, "packages/wiki/.claude-plugin/plugin.json");
    writeJson(manifestPath, { name: "wiki", version: "1.0.0" });
    writeFile(join(repo, "packages/wiki/README.md"), "v1\n");
    const taggedRevision = commitAll(repo, "v1");
    git(repo, "tag", "v1.0.0");
    writeJson(manifestPath, { name: "wiki", version: "2.0.0" });
    commitAll(repo, "v2");

    const resolved = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
      sourceRef: "v1.0.0",
      sourceSubdir: "packages/wiki",
    });

    expect(resolved.defaultBranch).toBe("trunk");
    expect(resolved.sourceRef).toBe("v1.0.0");
    expect(resolved.sourceRevision).toBe(taggedRevision);
    expect(resolved.candidates).toEqual([
      expect.objectContaining({
        provider: "claude",
        version: "1.0.0",
        pluginSubdir: "packages/wiki",
        fileCount: 2,
        artifactSize: 0,
        artifactSizeKnown: false,
      }),
    ]);
    expect(resolved.candidates[0]!.files).toBeUndefined();
  });

  it("inspects a partial clone without downloading unrelated Plugin payloads", async () => {
    const repo = createRepository("main");
    git(repo, "config", "uploadpack.allowFilter", "true");
    writeJson(join(repo, ".claude-plugin/plugin.json"), {
      name: "metadata-only",
      version: "1.0.0",
    });
    writeFile(join(repo, "skills/review/SKILL.md"), "# Payload that inspection must not fetch\n");
    commitAll(repo, "partial clone");
    const manifestObjectId = git(repo, "rev-parse", "HEAD:.claude-plugin/plugin.json");
    const payloadObjectId = git(repo, "rev-parse", "HEAD:skills/review/SKILL.md");
    const traceRoot = mkdtempSync(join(tmpdir(), "multiremi-plugin-git-trace-"));
    tempRoots.push(traceRoot);
    const tracePath = join(traceRoot, "packets.log");
    const previousTracePacket = process.env.GIT_TRACE_PACKET;

    try {
      process.env.GIT_TRACE_PACKET = tracePath;
      const resolved = await resolveAgentPluginGitSource({
        sourceUrl: pathToFileURL(repo).href,
      });
      expect(resolved.candidates[0]).toMatchObject({
        name: "metadata-only",
        artifactSize: 0,
        artifactSizeKnown: false,
      });
    } finally {
      restoreEnv("GIT_TRACE_PACKET", previousTracePacket);
    }

    const packetTrace = readFileSync(tracePath, "utf8");
    expect(packetTrace).toContain(manifestObjectId);
    expect(packetTrace).not.toContain(payloadObjectId);
  });

  it("imports only the selected Plugin subtree from a partial clone", async () => {
    const repo = createRepository("main");
    git(repo, "config", "uploadpack.allowFilter", "true");
    writeJson(join(repo, "plugins/selected/.claude-plugin/plugin.json"), {
      name: "selected",
      version: "1.0.0",
    });
    writeFile(join(repo, "plugins/selected/skills/review/SKILL.md"), "# Selected\n");
    writeJson(join(repo, "plugins/other/.claude-plugin/plugin.json"), {
      name: "other",
      version: "1.0.0",
    });
    writeFile(join(repo, "plugins/other/skills/review/SKILL.md"), "# Other\n");
    commitAll(repo, "multiple plugins");
    const selectedPayloadId = git(
      repo,
      "rev-parse",
      "HEAD:plugins/selected/skills/review/SKILL.md",
    );
    const otherPayloadId = git(
      repo,
      "rev-parse",
      "HEAD:plugins/other/skills/review/SKILL.md",
    );
    const traceRoot = mkdtempSync(join(tmpdir(), "multiremi-plugin-git-import-trace-"));
    tempRoots.push(traceRoot);
    const tracePath = join(traceRoot, "packets.log");
    const previousTracePacket = process.env.GIT_TRACE_PACKET;

    try {
      process.env.GIT_TRACE_PACKET = tracePath;
      const resolved = await resolveAgentPluginGitSource({
        sourceUrl: pathToFileURL(repo).href,
        sourceSubdir: "plugins/selected",
        provider: "claude",
        manifestPath: ".claude-plugin/plugin.json",
        includeFiles: true,
        exactSourceSubdir: true,
      });
      expect(resolved.candidates[0]?.files).toEqual([{
        path: "skills/review/SKILL.md",
        content: Buffer.from("# Selected\n").toString("base64"),
        encoding: "base64",
      }]);
    } finally {
      restoreEnv("GIT_TRACE_PACKET", previousTracePacket);
    }

    const packetTrace = readFileSync(tracePath, "utf8");
    expect(packetTrace).toContain(selectedPayloadId);
    expect(packetTrace).not.toContain(otherPayloadId);
  });

  it("resolves an explicit commit even when the remote has no valid default branch", async () => {
    const repo = createRepository("main");
    writeJson(join(repo, ".claude-plugin/plugin.json"), { name: "detached" });
    const revision = commitAll(repo, "detached");
    git(repo, "branch", "other");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/missing");

    const resolved = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
      sourceRef: revision,
    });

    expect(resolved).toMatchObject({
      sourceRef: revision,
      sourceRevision: revision,
      defaultBranch: "",
    });
    expect(resolved.candidates).toHaveLength(1);
  });

  it("keeps valid candidates selectable when a different manifest is malformed", async () => {
    const repo = createRepository("main");
    writeJson(join(repo, "plugins/valid/.claude-plugin/plugin.json"), {
      name: "valid-tools",
      version: "1.0.0",
    });
    writeFile(join(repo, "plugins/broken/.codex-plugin/plugin.json"), "[]\n");
    commitAll(repo, "mixed candidates");

    const inspected = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
    });
    expect(inspected.candidates).toEqual([
      expect.objectContaining({
        provider: "claude",
        name: "valid-tools",
        pluginSubdir: "plugins/valid",
      }),
    ]);

    const imported = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
      sourceSubdir: "plugins/valid",
      provider: "claude",
      manifestPath: ".claude-plugin/plugin.json",
      includeFiles: true,
      exactSourceSubdir: true,
    });
    expect(imported.candidates).toHaveLength(1);
  });

  it("imports only the explicitly selected root Plugin when a nested manifest is malformed", async () => {
    const repo = createRepository("main");
    writeJson(join(repo, ".claude-plugin/plugin.json"), {
      name: "root-tools",
      version: "1.0.0",
    });
    writeFile(join(repo, "nested/.claude-plugin/plugin.json"), "[]\n");
    commitAll(repo, "nested malformed candidate");

    const inspected = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
    });
    expect(inspected.candidates).toEqual([
      expect.objectContaining({
        provider: "claude",
        name: "root-tools",
        pluginSubdir: "",
      }),
    ]);

    const imported = await resolveAgentPluginGitSource({
      sourceUrl: pathToFileURL(repo).href,
      sourceSubdir: "",
      provider: "claude",
      manifestPath: ".claude-plugin/plugin.json",
      includeFiles: true,
      exactSourceSubdir: true,
    });
    expect(imported.candidates).toEqual([
      expect.objectContaining({
        name: "root-tools",
        pluginSubdir: "",
      }),
    ]);
  });

  it("requires Codex versions and rejects explicitly invalid Claude versions", async () => {
    const codexRepo = createRepository("main");
    writeJson(join(codexRepo, ".codex-plugin/plugin.json"), { name: "codex-no-version" });
    commitAll(codexRepo, "codex");
    await expectGitError(
      resolveAgentPluginGitSource({ sourceUrl: pathToFileURL(codexRepo).href }),
      "plugin_version_missing",
    );

    const claudeRepo = createRepository("main");
    writeJson(join(claudeRepo, ".claude-plugin/plugin.json"), {
      name: "claude-bad-version",
      version: "main",
    });
    commitAll(claudeRepo, "claude");
    await expectGitError(
      resolveAgentPluginGitSource({ sourceUrl: pathToFileURL(claudeRepo).href }),
      "plugin_version_invalid",
    );
  });

  it("rejects symlinks and artifacts over the file-count or byte-size limits", async () => {
    const linkedRepo = createRepository("main");
    writeJson(join(linkedRepo, ".claude-plugin/plugin.json"), { name: "linked" });
    writeFile(join(linkedRepo, "target.txt"), "target\n");
    mkdirSync(join(linkedRepo, "skills"), { recursive: true });
    symlinkSync("../target.txt", join(linkedRepo, "skills/link.txt"));
    commitAll(linkedRepo, "linked");
    await expectGitError(
      resolveAgentPluginGitSource({ sourceUrl: pathToFileURL(linkedRepo).href }),
      "plugin_artifact_file_invalid",
    );

    const largeRepo = createRepository("main");
    git(largeRepo, "config", "uploadpack.allowFilter", "true");
    writeJson(join(largeRepo, ".claude-plugin/plugin.json"), { name: "many-files" });
    for (let index = 0; index < 2_000; index++) {
      writeFile(join(largeRepo, `files/${String(index).padStart(4, "0")}.txt`), "x");
    }
    commitAll(largeRepo, "many files");
    const payloadObjectId = git(largeRepo, "rev-parse", "HEAD:files/0000.txt");
    const traceRoot = mkdtempSync(join(tmpdir(), "multiremi-plugin-git-limit-trace-"));
    tempRoots.push(traceRoot);
    const tracePath = join(traceRoot, "packets.log");
    const previousTracePacket = process.env.GIT_TRACE_PACKET;
    try {
      process.env.GIT_TRACE_PACKET = tracePath;
      await expectGitError(
        resolveAgentPluginGitSource({
          sourceUrl: pathToFileURL(largeRepo).href,
          includeFiles: true,
        }),
        "plugin_artifact_too_large",
      );
    } finally {
      restoreEnv("GIT_TRACE_PACKET", previousTracePacket);
    }
    expect(readFileSync(tracePath, "utf8")).not.toContain(payloadObjectId);

    const oversizedRepo = createRepository("main");
    writeJson(join(oversizedRepo, ".claude-plugin/plugin.json"), { name: "oversized" });
    const oversizedPath = join(oversizedRepo, "payload.bin");
    mkdirSync(dirname(oversizedPath), { recursive: true });
    writeFileSync(oversizedPath, Buffer.alloc(25 * 1024 * 1024));
    commitAll(oversizedRepo, "oversized");
    await expectGitError(
      resolveAgentPluginGitSource({
        sourceUrl: pathToFileURL(oversizedRepo).href,
        includeFiles: true,
      }),
      "plugin_artifact_too_large",
    );
  });

  it("keeps local paths behind the explicit test hook and validates subdirectories before Git runs", async () => {
    const repo = createRepository("main");
    writeJson(join(repo, ".claude-plugin/plugin.json"), { name: "local" });
    commitAll(repo, "local");

    delete process.env[TEST_FILE_URL_ENV];
    await expectGitError(
      resolveAgentPluginGitSource({ sourceUrl: pathToFileURL(repo).href }),
      "plugin_git_url_invalid",
    );
    await expectGitError(
      resolveAgentPluginGitSource({ sourceUrl: repo }),
      "plugin_git_url_invalid",
    );

    process.env[TEST_FILE_URL_ENV] = "1";
    await expectGitError(
      resolveAgentPluginGitSource({
        sourceUrl: pathToFileURL(repo).href,
        sourceSubdir: "../outside",
      }),
      "plugin_git_subdir_invalid",
    );

    await expectGitError(
      resolveAgentPluginGitSource({
        sourceUrl: "https://token@example.com/plugins.git",
      }),
      "plugin_git_url_invalid",
    );
    await expectGitError(
      resolveAgentPluginGitSource({
        sourceUrl: "https://example.com/plugins.git?token=secret",
      }),
      "plugin_git_url_invalid",
    );
    await expectGitError(
      resolveAgentPluginGitSource({
        sourceUrl: "http://127.0.0.1/plugins.git",
      }),
      "plugin_git_host_not_allowed",
    );
    await expectGitError(
      resolveAgentPluginGitSource({
        sourceUrl: "http://[::ffff:7f00:1]/plugins.git",
      }),
      "plugin_git_host_not_allowed",
    );
  });
});

function createRepository(defaultBranch: string): string {
  const root = mkdtempSync(join(tmpdir(), "multiremi-plugin-git-test-"));
  tempRoots.push(root);
  git(null, "init", "-q", "-b", defaultBranch, root);
  git(root, "config", "user.email", "plugins@example.test");
  git(root, "config", "user.name", "Plugin Test");
  return root;
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "--all");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function git(cwd: string | null, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: cwd ?? undefined,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8") || `git ${args.join(" ")} failed`);
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function expectGitError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected AgentPluginGitImportError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPluginGitImportError);
    expect((error as AgentPluginGitImportError).code).toBe(code);
    expect((error as AgentPluginGitImportError).status).toBe(400);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
