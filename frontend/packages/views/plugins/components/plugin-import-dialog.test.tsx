// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ApiError } from "@multiremi/core/api/client";
import type { AgentPlugin } from "@multiremi/core/plugins";
import enCommon from "../../locales/en/common.json";
import enPlugins from "../../locales/en/plugins.json";
import enRepositories from "../../locales/en/repositories.json";

const mutateAsync = vi.hoisted(() => vi.fn());
const inspectAsync = vi.hoisted(() => vi.fn());
const inspectReset = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/plugins", () => ({
  useImportAgentPlugin: () => ({ mutateAsync, isPending: false }),
  useInspectAgentPluginRepository: () => ({
    mutateAsync: inspectAsync,
    isPending: false,
    reset: inspectReset,
  }),
}));

import { PluginImportDialog } from "./plugin-import-dialog";

const resources = {
  en: { common: enCommon, plugins: enPlugins, repositories: enRepositories },
};

function directoryFile(path: string, content: string) {
  const bytes = Uint8Array.from(content, (character) => character.charCodeAt(0));
  return {
    name: path.split("/").at(-1),
    size: bytes.byteLength,
    webkitRelativePath: path,
    text: () => Promise.resolve(content),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

function renderDialog(
  onImported = vi.fn(),
  targetPlugin?: AgentPlugin,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <PluginImportDialog
          provider="claude"
          targetPlugin={targetPlugin}
          open
          onOpenChange={vi.fn()}
          onImported={onImported}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return onImported;
}

async function selectDirectory(files: ReturnType<typeof directoryFile>[]) {
  await userEvent.click(screen.getByRole("tab", { name: /local folder/i }));
  fireEvent.change(screen.getByLabelText("Plugin folder"), {
    target: { files },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /another folder/i })).toBeEnabled(),
  );
}

function repositoryInspection(overrides: Record<string, unknown> = {}) {
  return {
    sourceUrl: "https://example.test/review.git",
    sourceRef: "main",
    defaultBranch: "main",
    branches: ["develop", "main"],
    sourceRevision: "1234567890abcdef1234567890abcdef12345678",
    candidates: [
      {
        provider: "claude",
        name: "Review tools",
        description: "Review code",
        version: "1.2.0",
        sourceSubdir: "",
        manifestPath: ".claude-plugin/plugin.json",
        manifest: { name: "Review tools", version: "1.2.0" },
        fileCount: 2,
        artifactSize: 128,
        artifactSizeKnown: false,
      },
    ],
    ...overrides,
  };
}

describe("PluginImportDialog", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({ id: "plugin-1", name: "Review tools" });
    inspectAsync.mockResolvedValue(repositoryInspection());
  });

  it("imports a repository from its detected default branch and resolved commit", async () => {
    const user = userEvent.setup();
    const onImported = renderDialog();

    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/review.git",
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));

    expect(await screen.findByText("Review tools")).toBeInTheDocument();
    expect(screen.getByText("1.2.0")).toBeInTheDocument();
    expect(await screen.findByText(/2 files, size checked on import/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Branch, tag, or commit" })).toHaveTextContent("main");
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        mode: "git",
        workspaceId: "ws-1",
        sourceUrl: "https://example.test/review.git",
        sourceRef: "main",
        sourceSubdir: "",
        provider: "claude",
        manifestPath: ".claude-plugin/plugin.json",
        expectedRevision: "1234567890abcdef1234567890abcdef12345678",
        requirements: {},
        activate: true,
      }),
    );
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plugin-1" }),
    );
  });

  it("reads a local Claude directory and lets the server derive a stable version", async () => {
    const user = userEvent.setup();
    renderDialog();

    await selectDirectory([
      directoryFile(
        "review/.claude-plugin/plugin.json",
        JSON.stringify({ name: "Review tools", description: "Review code" }),
      ),
      directoryFile("review/skills/review/SKILL.md", "review"),
    ]);

    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(screen.queryByLabelText("Import version")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          provider: "claude",
          manifestPath: ".claude-plugin/plugin.json",
          manifest: { name: "Review tools", description: "Review code" },
          files: [
            {
              path: "skills/review/SKILL.md",
              encoding: "base64",
              content: "cmV2aWV3",
            },
          ],
          requirements: {},
          activate: true,
        }),
      ),
    );
    expect(mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("version");
  });

  it("accepts a tag or commit in the searchable ref picker", async () => {
    const user = userEvent.setup();
    inspectAsync
      .mockResolvedValueOnce(repositoryInspection())
      .mockResolvedValueOnce(repositoryInspection({ sourceRef: "v2.0.0" }));
    renderDialog();
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/review.git",
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));
    const refPicker = await screen.findByRole("combobox", {
      name: "Branch, tag, or commit",
    });
    await user.click(refPicker);
    await user.type(
      screen.getByPlaceholderText("Search branches or enter a tag or commit..."),
      "v2.0.0",
    );
    await user.click(screen.getByText("v2.0.0"));

    await waitFor(() =>
      expect(inspectAsync).toHaveBeenLastCalledWith({
        sourceUrl: "https://example.test/review.git",
        sourceRef: "v2.0.0",
      }),
    );
    expect(refPicker).toHaveTextContent("v2.0.0");
    await user.click(refPicker);
    expect(screen.getByText("Use tag or commit")).toBeInTheDocument();
  });

  it("maps repository API error codes to localized messages", async () => {
    const user = userEvent.setup();
    inspectAsync.mockRejectedValue(new ApiError(
      "invalid Plugin Git repository URL",
      400,
      "Bad Request",
      { code: "plugin_git_url_invalid" },
    ));
    renderDialog();
    await user.type(screen.getByLabelText("Repository URL"), "not-a-url");
    await user.click(screen.getByRole("button", { name: /read repository/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid Git repository URL.",
    );
    expect(screen.queryByText("invalid Plugin Git repository URL")).not.toBeInTheDocument();
  });

  it("explains repository timeouts instead of showing the generic read error", async () => {
    const user = userEvent.setup();
    inspectAsync.mockRejectedValue(new ApiError(
      "Plugin Git operation timed out",
      504,
      "Gateway Timeout",
      { code: "plugin_git_timeout" },
    ));
    renderDialog();
    await user.type(screen.getByLabelText("Repository URL"), "https://example.test/slow.git");
    await user.click(screen.getByRole("button", { name: /read repository/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The repository took too long to read. Try again.",
    );
  });

  it("can recover an existing Plugin when its stored ref was deleted", async () => {
    const user = userEvent.setup();
    inspectAsync
      .mockRejectedValueOnce(new ApiError(
        "Plugin source ref was not found",
        400,
        "Bad Request",
        { code: "plugin_git_ref_not_found" },
      ))
      .mockResolvedValueOnce(repositoryInspection());
    renderDialog(
      vi.fn(),
      {
        id: "plugin-1",
        provider: "claude",
        name: "Review tools",
        description: "Review code",
        sourceType: "git",
        sourceUrl: "https://example.test/review.git",
        sourceRef: "deleted-release",
        sourceSubdir: "",
        activeVersion: { requirements: {} },
      } as unknown as AgentPlugin,
    );

    await user.click(screen.getByRole("button", { name: /read repository/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That branch, tag, or commit is no longer available.",
    );
    await user.click(screen.getByRole("button", { name: "Use default branch" }));

    await waitFor(() => expect(inspectAsync).toHaveBeenLastCalledWith({
      sourceUrl: "https://example.test/review.git",
      sourceRef: null,
    }));
    expect(await screen.findByText("Review tools")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Branch, tag, or commit" }))
      .toHaveTextContent("main");
  });

  it("keeps the dialog open when the import response is malformed", async () => {
    const user = userEvent.setup();
    mutateAsync.mockResolvedValueOnce(null);
    const onImported = renderDialog();
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/review.git",
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));
    await screen.findByText("Review tools");
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "Import plugin" })).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("ignores a directory read that finishes after switching target Plugins", async () => {
    const user = userEvent.setup();
    let resolveManifest!: (content: string) => void;
    const manifestText = new Promise<string>((resolve) => {
      resolveManifest = resolve;
    });
    const delayedManifest = {
      ...directoryFile("stale/.claude-plugin/plugin.json", ""),
      text: () => manifestText,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const renderTree = (targetPlugin?: AgentPlugin) => (
      <I18nProvider locale="en" resources={resources}>
        <QueryClientProvider client={queryClient}>
          <PluginImportDialog
            provider="claude"
            targetPlugin={targetPlugin}
            open
            onOpenChange={vi.fn()}
          />
        </QueryClientProvider>
      </I18nProvider>
    );
    const view = render(renderTree());

    await user.click(screen.getByRole("tab", { name: /local folder/i }));
    fireEvent.change(screen.getByLabelText("Plugin folder"), {
      target: { files: [delayedManifest] },
    });
    view.rerender(renderTree({
      id: "plugin-2",
      provider: "claude",
      name: "Current tools",
      description: "Current Plugin",
      sourceType: "git",
      sourceUrl: "https://example.test/current.git",
      sourceRef: "main",
      sourceSubdir: "",
      activeVersion: { requirements: {} },
    } as unknown as AgentPlugin));

    await act(async () => {
      resolveManifest(JSON.stringify({ name: "Stale tools", version: "1.0.0" }));
      await manifestText;
    });
    await user.click(screen.getByRole("tab", { name: /local folder/i }));

    expect(screen.queryByText("Stale tools")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose plugin folder/i })).toBeEnabled();
  });

  it("auto-detects a versioned Codex directory independently of the active catalog tab", async () => {
    const user = userEvent.setup();
    renderDialog();
    await selectDirectory([
      directoryFile(
        "codex-tools/.codex-plugin/plugin.json",
        JSON.stringify({ name: "Codex tools", version: "2.1.0" }),
      ),
    ]);

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("2.1.0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "codex",
          manifestPath: ".codex-plugin/plugin.json",
        }),
      ),
    );
  });

  it("requires a version in a local Codex manifest", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("tab", { name: /local folder/i }));
    fireEvent.change(screen.getByLabelText("Plugin folder"), {
      target: {
        files: [
          directoryFile(
            "codex-tools/.codex-plugin/plugin.json",
            JSON.stringify({ name: "Codex tools" }),
          ),
        ],
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Codex plugin manifest must declare a version.",
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("imports the selected plugin when a repository contains multiple manifests", async () => {
    const user = userEvent.setup();
    inspectAsync.mockResolvedValue(
      repositoryInspection({
        candidates: [
          repositoryInspection().candidates[0],
          {
            provider: "claude",
            name: "Release tools",
            description: "Release code",
            version: "3.0.0",
            sourceSubdir: "plugins/release",
            manifestPath: ".claude-plugin/plugin.json",
            manifest: { name: "Release tools", version: "3.0.0" },
            fileCount: 3,
            artifactSize: 256,
          },
        ],
      }),
    );
    renderDialog();
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/review.git",
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));

    const pluginPicker = await screen.findByRole("combobox", { name: "Plugin" });
    await user.click(pluginPicker);
    await user.click(screen.getByText("Release tools"));
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude",
          manifestPath: ".claude-plugin/plugin.json",
          sourceSubdir: "plugins/release",
        }),
      ),
    );
  });

  it("distinguishes Claude and Codex manifests in the same repository directory", async () => {
    const user = userEvent.setup();
    inspectAsync.mockResolvedValue(
      repositoryInspection({
        candidates: [
          repositoryInspection().candidates[0],
          {
            provider: "codex",
            name: "Codex review tools",
            description: "Review code with Codex",
            version: "2.0.0",
            sourceSubdir: "",
            manifestPath: ".codex-plugin/plugin.json",
            manifest: { name: "Codex review tools", version: "2.0.0" },
            fileCount: 2,
            artifactSize: 160,
          },
        ],
      }),
    );
    renderDialog();
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/review.git",
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));

    await user.click(await screen.findByRole("combobox", { name: "Plugin" }));
    await user.click(screen.getByText("Codex review tools"));
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "codex",
          manifestPath: ".codex-plugin/plugin.json",
          sourceSubdir: "",
        }),
      ),
    );
  });

  it("preserves Runtime requirements when importing a candidate from Git", async () => {
    const user = userEvent.setup();
    renderDialog(
      vi.fn(),
      {
        id: "plugin-1",
        provider: "claude",
        name: "Review tools",
        description: "Review code",
        sourceType: "git",
        sourceUrl: "https://example.test/review.git",
        sourceRef: "main",
        sourceSubdir: "",
        activeVersion: { requirements: { binaries: ["review-cli"] } },
      } as unknown as AgentPlugin,
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));
    await screen.findByText("1.2.0");
    await user.click(screen.getByRole("button", { name: "Import version" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "plugin-1",
          requirements: { binaries: ["review-cli"] },
          activate: false,
        }),
      ),
    );
  });

  it("supports Runtime requirements without putting them in the primary import flow", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://example.test/review.git",
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));
    await screen.findByText("Review tools");

    await user.click(screen.getByText("Runtime setup"));
    const requirements = screen.getByLabelText("Runtime requirements JSON");
    fireEvent.change(requirements, {
      target: { value: JSON.stringify({ binaries: ["review-cli"] }) },
    });
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ requirements: { binaries: ["review-cli"] } }),
      ),
    );
  });

  it("requires explicit selection when an existing Plugin source path disappears", async () => {
    const user = userEvent.setup();
    inspectAsync.mockResolvedValue(
      repositoryInspection({
        candidates: [{
          ...repositoryInspection().candidates[0],
          name: "Replacement tools",
          sourceSubdir: "plugins/replacement",
        }],
      }),
    );
    renderDialog(
      vi.fn(),
      {
        id: "plugin-1",
        provider: "claude",
        name: "Review tools",
        description: "Review code",
        sourceType: "git",
        sourceUrl: "https://example.test/review.git",
        sourceRef: "main",
        sourceSubdir: "plugins/review",
        activeVersion: { requirements: {} },
      } as unknown as AgentPlugin,
    );
    await user.click(screen.getByRole("button", { name: /read repository/i }));

    const submit = screen.getByRole("button", { name: "Import version" });
    expect(submit).toBeDisabled();
    await user.click(await screen.findByRole("combobox", { name: "Plugin" }));
    await user.click(screen.getByText("Replacement tools"));
    expect(submit).toBeEnabled();
  });

  it("rejects malformed manifest JSON before calling the API", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("tab", { name: /local folder/i }));
    fireEvent.change(screen.getByLabelText("Plugin folder"), {
      target: {
        files: [directoryFile("broken/.claude-plugin/plugin.json", "[]")],
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The plugin manifest must be a valid JSON object.",
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
