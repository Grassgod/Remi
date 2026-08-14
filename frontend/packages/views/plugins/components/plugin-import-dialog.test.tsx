// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentPlugin } from "@multiremi/core/plugins";
import enCommon from "../../locales/en/common.json";
import enPlugins from "../../locales/en/plugins.json";

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/plugins", () => ({
  useImportAgentPlugin: () => ({ mutateAsync, isPending: false }),
}));

import { PluginImportDialog } from "./plugin-import-dialog";

const resources = { en: { common: enCommon, plugins: enPlugins } };

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
  fireEvent.change(screen.getByLabelText("Plugin folder"), {
    target: { files },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /another folder/i })).toBeEnabled(),
  );
}

describe("PluginImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsync.mockResolvedValue({ id: "plugin-1", name: "Review tools" });
  });

  it("reads a Claude directory and supplies SemVer when the native manifest omits it", async () => {
    const user = userEvent.setup();
    const onImported = renderDialog();

    await selectDirectory([
      directoryFile(
        "review/.claude-plugin/plugin.json",
        JSON.stringify({ name: "Review tools", description: "Review code" }),
      ),
      directoryFile("review/skills/review/SKILL.md", "review"),
    ]);

    expect(screen.getByLabelText("Import version")).toHaveValue("0.1.0");
    await user.click(screen.getByRole("button", { name: "Advanced metadata" }));
    await user.type(
      screen.getByLabelText("Source URL"),
      "https://example.test/review.git",
    );
    fireEvent.change(screen.getByLabelText("Runtime requirements JSON"), {
      target: { value: JSON.stringify({ binaries: ["review-cli"] }) },
    });
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          provider: "claude",
          version: "0.1.0",
          manifestPath: ".claude-plugin/plugin.json",
          manifest: { name: "Review tools", description: "Review code" },
          files: [
            {
              path: "skills/review/SKILL.md",
              encoding: "base64",
              content: "cmV2aWV3",
            },
          ],
          requirements: { binaries: ["review-cli"] },
          sourceUrl: "https://example.test/review.git",
          activate: true,
        }),
      ),
    );
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plugin-1" }),
    );
  });

  it("auto-detects a Codex directory independently of the active catalog tab", async () => {
    const user = userEvent.setup();
    renderDialog();
    await selectDirectory([
      directoryFile(
        "codex-tools/.codex-plugin/plugin.json",
        JSON.stringify({ name: "Codex tools", version: "2.1.0" }),
      ),
    ]);

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByLabelText("Import version")).toHaveValue("2.1.0");
    await user.click(screen.getByRole("button", { name: /^Import$/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "codex",
          version: "2.1.0",
          manifestPath: ".codex-plugin/plugin.json",
        }),
      ),
    );
  });

  it("imports a candidate version into the selected plugin and preserves requirements", async () => {
    const user = userEvent.setup();
    renderDialog(
      vi.fn(),
      {
        id: "plugin-1",
        provider: "claude",
        name: "Review tools",
        description: "Review code",
        sourceType: "manifest",
        sourceUrl: null,
        sourceRef: null,
        activeVersion: {
          requirements: { binaries: ["review-cli"] },
        },
      } as unknown as AgentPlugin,
    );
    await selectDirectory([
      directoryFile(
        "review/.claude-plugin/plugin.json",
        JSON.stringify({ name: "Upstream name" }),
      ),
    ]);
    await user.click(screen.getByRole("button", { name: "Advanced metadata" }));
    expect(screen.getByLabelText("Runtime requirements JSON")).toHaveValue(
      JSON.stringify({ binaries: ["review-cli"] }, null, 2),
    );
    await user.click(screen.getByRole("button", { name: "Import version" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "plugin-1",
          name: "Review tools",
          provider: "claude",
          version: "0.1.0",
          requirements: { binaries: ["review-cli"] },
          activate: false,
        }),
      ),
    );
  });

  it("rejects malformed manifest JSON before calling the API", async () => {
    renderDialog();
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
