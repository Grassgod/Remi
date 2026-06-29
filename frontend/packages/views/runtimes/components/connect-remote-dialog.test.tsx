import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { configStore } from "@multiremi/core/config";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { ConnectRemoteDialog } from "./connect-remote-dialog";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-test",
}));

vi.mock("@multiremi/core/api", () => ({
  api: {
    createPersonalAccessToken: vi.fn(async () => ({
      token: "mul_testtoken",
    })),
  },
}));

vi.mock("@multiremi/core/paths", () => ({
  paths: {
    workspace: () => ({
      agents: () => "/agents",
      runtimeDetail: () => "/runtimes/rt-test",
    }),
  },
  useWorkspaceSlug: () => "workspace-test",
}));

vi.mock("@multiremi/core/realtime", () => ({
  useWSEvent: vi.fn(),
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));

function resetConfigStore() {
  configStore.setState({
    cdnDomain: "",
    allowSignup: true,
    googleClientId: "",
    daemonServerUrl: "",
    workspaceCreationDisabled: false,
  });
}

function renderDialog(config?: {
  daemonServerUrl?: string;
}) {
  resetConfigStore();
  if (config) {
    configStore.getState().setDaemonConfig(config);
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ConnectRemoteDialog onClose={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const ligatureClasses = [
  "[font-variant-ligatures:none]",
  "[font-feature-settings:'liga'_0]",
];

describe("ConnectRemoteDialog", () => {
  it("uses generated self-host setup commands by default", async () => {
    const { baseElement } = renderDialog();

    await waitFor(() =>
      expect(baseElement).toHaveTextContent(
        "multiremi setup --server-url http://localhost:3000 --workspace-id ws-test --token mul_testtoken --start",
      ),
    );
    expect(baseElement).toHaveTextContent("multiremi daemon start");
  });

  it("uses self-host daemon URLs from runtime config", async () => {
    const { baseElement } = renderDialog({
      daemonServerUrl: "https://api.example.com/",
    });

    await waitFor(() =>
      expect(baseElement).toHaveTextContent(
        "multiremi setup --server-url https://api.example.com --workspace-id ws-test --token mul_testtoken --start",
      ),
    );
  });

  it("disables font ligatures in setup command code", () => {
    const { baseElement } = renderDialog();

    const setupCode = Array.from(baseElement.querySelectorAll("code")).find((node) =>
      node.textContent?.includes("remi setup"),
    );

    expect(setupCode).toHaveClass(...ligatureClasses);
  });

  it("disables font ligatures in fallback token command code", () => {
    const { baseElement } = renderDialog();

    const tokenCode = Array.from(baseElement.querySelectorAll("code")).find((node) =>
      node.textContent?.includes("multiremi login --token"),
    );

    expect(tokenCode).toHaveClass(...ligatureClasses);
  });
});
