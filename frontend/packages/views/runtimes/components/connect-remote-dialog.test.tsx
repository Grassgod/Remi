import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { configStore } from "@multiremi/core/config";
import { runtimeKeys } from "@multiremi/core/runtimes/queries";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { ConnectRemoteDialog } from "./connect-remote-dialog";

const TEST_RESOURCES = { en: { common: enCommon, runtimes: enRuntimes } };

const provisionDaemonCredential = vi.hoisted(() => vi.fn());
const realtime = vi.hoisted(() => ({
  daemonRegisterHandler: null as ((payload: unknown) => void) | null,
}));

const TEST_DAEMON_CREDENTIAL = {
  token: "mdt_testtoken",
  tokenId: "dtk_testtoken",
  workspaceId: "ws-test",
  daemonId: "daemon-test",
};

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-test",
}));

vi.mock("@multiremi/core/api", () => ({
  api: {
    provisionDaemonCredential,
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
  useWSEvent: (event: string, handler: (payload: unknown) => void) => {
    if (event === "daemon:register") realtime.daemonRegisterHandler = handler;
  },
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
  const invalidateQueries = vi.spyOn(qc, "invalidateQueries");
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          <ConnectRemoteDialog onClose={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    ),
    invalidateQueries,
  };
}

const ligatureClasses = [
  "[font-variant-ligatures:none]",
  "[font-feature-settings:'liga'_0]",
];

describe("ConnectRemoteDialog", () => {
  beforeEach(() => {
    provisionDaemonCredential.mockReset();
    provisionDaemonCredential.mockResolvedValue(TEST_DAEMON_CREDENTIAL);
    realtime.daemonRegisterHandler = null;
  });

  it("uses generated self-host setup commands by default", async () => {
    const { baseElement } = renderDialog();

    await waitFor(() =>
      expect(baseElement).toHaveTextContent(
        "remi setup --server-url http://localhost:3000 --workspace-id ws-test --daemon-id daemon-test --token mdt_testtoken --start",
      ),
    );
    expect(baseElement).toHaveTextContent("MULTIREMI_BASE_URL=http://localhost:3000");
    expect(baseElement).not.toHaveTextContent("--device-name");
    expect(provisionDaemonCredential).toHaveBeenCalledWith({
      workspace_id: "ws-test",
      name: expect.stringMatching(/^Remi daemon \d{4}-\d{2}-\d{2}$/),
    });
  });

  it("shell-quotes an optional computer name in the setup command", async () => {
    const { baseElement, getByLabelText } = renderDialog();

    await waitFor(() => expect(getByLabelText("Computer name (optional)")).toBeEnabled());
    fireEvent.change(getByLabelText("Computer name (optional)"), {
      target: { value: "Alice's laptop" },
    });

    expect(baseElement).toHaveTextContent("--device-name 'Alice'\\''s laptop'");
    expect(baseElement).toHaveTextContent("MULTIREMI_BASE_URL=http://localhost:3000");
    expect(baseElement).not.toHaveTextContent("MULTIREMI_BASE_URL='Alice");
  });

  it("renders canonical daemon troubleshooting commands", async () => {
    const { baseElement } = renderDialog();

    await waitFor(() => expect(baseElement).toHaveTextContent("remi daemon status"));
    expect(baseElement).toHaveTextContent("remi daemon logs -f");
    expect(baseElement).not.toHaveTextContent("remi status");
    expect(baseElement).not.toHaveTextContent("remi logs -f");
  });

  it("uses self-host daemon URLs from runtime config", async () => {
    const { baseElement } = renderDialog({
      daemonServerUrl: "https://api.example.com/",
    });

    await waitFor(() =>
      expect(baseElement).toHaveTextContent(
        "remi setup --server-url https://api.example.com --workspace-id ws-test --daemon-id daemon-test --token mdt_testtoken --start",
      ),
    );
  });

  it("disables font ligatures in setup command code", async () => {
    const { baseElement } = renderDialog();

    await waitFor(() =>
      expect(
        Array.from(baseElement.querySelectorAll("code")).find((node) =>
          node.textContent?.includes("remi setup"),
        ),
      ).toBeTruthy(),
    );
    const setupCode = Array.from(baseElement.querySelectorAll("code")).find((node) =>
      node.textContent?.includes("remi setup"),
    );

    expect(setupCode).toHaveClass(...ligatureClasses);
  });

  it("shows a retryable error without exposing a placeholder setup command", async () => {
    provisionDaemonCredential.mockRejectedValueOnce(new Error("offline"));
    const { baseElement, invalidateQueries } = renderDialog();

    await waitFor(() =>
      expect(baseElement).toHaveTextContent("Couldn't create a connection credential."),
    );
    expect(baseElement).toHaveTextContent("Retry");
    expect(baseElement).not.toHaveTextContent("<YOUR_TOKEN>");
    expect(baseElement).not.toHaveTextContent("Waiting for your computer");
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: runtimeKeys.daemonInventory("ws-test"),
      }),
    );
  });

  it("shows the server error message and code under the credential error", async () => {
    provisionDaemonCredential.mockRejectedValueOnce(
      Object.assign(new Error("API error: 409 Conflict"), {
        body: {
          message: "Daemon credential creation is disabled",
          code: "daemon_credential_disabled",
        },
      }),
    );
    const { baseElement } = renderDialog();

    await waitFor(() =>
      expect(baseElement).toHaveTextContent(
        "Reason: Daemon credential creation is disabled (daemon_credential_disabled)",
      ),
    );
    expect(baseElement).not.toHaveTextContent("API error: 409 Conflict");
  });

  it("refreshes daemon inventory after provisioning succeeds", async () => {
    const { baseElement, invalidateQueries } = renderDialog();

    await waitFor(() =>
      expect(baseElement).toHaveTextContent("Waiting for your computer"),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: runtimeKeys.daemonInventory("ws-test"),
    });
  });

  it("only completes for the daemon credential provisioned by this dialog", async () => {
    const { baseElement } = renderDialog();

    await waitFor(() =>
      expect(baseElement).toHaveTextContent("Waiting for your computer"),
    );
    expect(realtime.daemonRegisterHandler).not.toBeNull();

    act(() => {
      realtime.daemonRegisterHandler?.({
        daemon_id: "daemon-from-another-dialog",
        runtime_id: "rt-other",
      });
    });
    expect(baseElement).not.toHaveTextContent("Computer connected");

    act(() => {
      realtime.daemonRegisterHandler?.({
        daemon_id: "daemon-test",
        runtime_id: "rt-test",
      });
    });
    await waitFor(() =>
      expect(baseElement).toHaveTextContent("Computer connected"),
    );
  });

  it("disables font ligatures in self-host install command code", () => {
    const { baseElement } = renderDialog();

    const installCode = Array.from(baseElement.querySelectorAll("code")).find((node) =>
      node.textContent?.includes("MULTIREMI_BASE_URL"),
    );

    expect(installCode).toHaveClass(...ligatureClasses);
  });
});
