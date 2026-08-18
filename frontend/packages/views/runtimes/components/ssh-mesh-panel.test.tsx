// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiContractError, ApiError } from "@multiremi/core/api";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { SshMeshOverview } from "@multiremi/core/runtimes";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const fixture = vi.hoisted(() => ({
  role: "owner",
  overview: null as SshMeshOverview | null,
  memberError: false,
  togglePending: false,
  rotatePending: false,
  testPending: false,
  testVariables: undefined as
    | { sourceDaemonId: string; targetDaemonId?: string }
    | undefined,
}));
const actions = vi.hoisted(() => ({
  toggle: vi.fn(),
  rotate: vi.fn(),
  test: vi.fn(),
}));
const notices = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/realtime", () => ({ useWSEvent: vi.fn() }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({
    queryKey: ["members", "ws-1"],
    queryFn: () => fixture.memberError
      ? Promise.reject(new Error("members unavailable"))
      : Promise.resolve([{ user_id: "user-1", role: fixture.role }]),
  }),
}));
vi.mock("@multiremi/core/runtimes", async () => {
  const actual =
    await vi.importActual<typeof import("@multiremi/core/runtimes")>(
      "@multiremi/core/runtimes",
    );
  return {
    ...actual,
    sshMeshOptions: () => ({
      queryKey: ["ssh-mesh", "ws-1"],
      queryFn: () => Promise.resolve(fixture.overview),
    }),
    useSetSshMeshEnabled: () => ({
      mutate: actions.toggle,
      isPending: fixture.togglePending,
    }),
    useRotateSshMeshKey: () => ({
      mutate: actions.rotate,
      isPending: fixture.rotatePending,
    }),
    useTestSshMeshConnection: () => ({
      mutate: actions.test,
      isPending: fixture.testPending,
      variables: fixture.testVariables,
    }),
  };
});
vi.mock("sonner", () => ({
  toast: notices,
}));

import { SshMeshPanel } from "./ssh-mesh-panel";

const resources = { en: { common: enCommon, runtimes: enRuntimes } };
const queryClients: QueryClient[] = [];

function overview(enabled = true): SshMeshOverview {
  return {
    workspace_id: "ws-1",
    enabled,
    key_version: enabled ? 2 : 0,
    fingerprint: enabled ? "SHA256:dedicated-workspace-key" : null,
    rotation_state: "stable",
    config_revision: enabled ? "revision-4" : "",
    rotation_ready_daemons: enabled ? 2 : 0,
    rotation_total_daemons: enabled ? 2 : 0,
    created_at: "2026-08-18T00:00:00Z",
    updated_at: "2026-08-18T00:00:00Z",
    runtimes: enabled
      ? [
          {
            daemon_id: "daemon-source",
            runtime_ids: ["runtime-1"],
            name: "source-host",
            status: "ready",
            protocol_version: 1,
            key_version: 2,
            config_revision: "revision-4",
            desired_config_revision: "revision-4",
            ssh_user: "runner",
            ssh_alias: "remi-source",
            hostname: "source-host",
            port: 22,
            addresses: ["10.37.206.133"],
            host_keys: ["SHA256:source-host"],
            public_key_installed: true,
            config_installed: true,
            last_error_code: null,
            last_error: null,
            last_reported_at: "2026-08-18T00:00:00Z",
            probe_revision: 3,
            desired_probe_revision: 3,
            peer_tests: [
              {
                daemon_id: "daemon-peer",
                status: "auth_failed",
                latency_ms: null,
                error_code: "ssh_auth_failed",
                error: "Permission denied (publickey).",
                checked_at: "2026-08-18T00:00:00Z",
              },
            ],
          },
          {
            daemon_id: "daemon-peer",
            runtime_ids: ["runtime-2"],
            name: "worker-host",
            status: "ready",
            protocol_version: 1,
            key_version: 2,
            config_revision: "revision-4",
            desired_config_revision: "revision-4",
            ssh_user: "runner",
            ssh_alias: "remi-worker",
            hostname: "worker-host",
            port: 2222,
            addresses: ["10.37.66.8"],
            host_keys: ["SHA256:worker-host"],
            public_key_installed: true,
            config_installed: true,
            last_error_code: null,
            last_error: null,
            last_reported_at: "2026-08-18T00:00:00Z",
            probe_revision: 3,
            desired_probe_revision: 3,
            peer_tests: [],
          },
        ]
      : [],
  };
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClients.push(queryClient);
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <SshMeshPanel
          sourceDaemonId="daemon-source"
          sourceName="source-host"
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("SshMeshPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.role = "owner";
    fixture.overview = overview();
    fixture.memberError = false;
    fixture.togglePending = false;
    fixture.rotatePending = false;
    fixture.testPending = false;
    fixture.testVariables = undefined;
  });

  afterEach(() => {
    cleanup();
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
  });

  it("shows the workspace key, managed endpoints, and selected-machine peers", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText("SHA256:dedicated-workspace-key")).toBeInTheDocument();
    expect(screen.getByText("ssh remi-source")).toBeInTheDocument();
    expect(screen.getByText("runner@10.37.66.8:2222")).toBeInTheDocument();
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.getByText("Permission denied (publickey).")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Test all" }));
    expect(actions.test).toHaveBeenCalledWith(
      { sourceDaemonId: "daemon-source", targetDaemonId: undefined },
      expect.any(Object),
    );

    const workerNames = screen.getAllByText("worker-host");
    const peerRow = workerNames.at(-1)?.closest("li") ?? null;
    expect(peerRow).not.toBeNull();
    await user.click(within(peerRow!).getByRole("button", { name: "Retry" }));
    expect(actions.test).toHaveBeenCalledWith(
      { sourceDaemonId: "daemon-source", targetDaemonId: "daemon-peer" },
      expect.any(Object),
    );
  });

  it("enables an unconfigured workspace without collecting private key input", async () => {
    fixture.overview = overview(false);
    const user = userEvent.setup();
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Enabled" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(actions.toggle).toHaveBeenCalledWith(
      { enabled: true },
      expect.any(Object),
    );
  });

  it("requires an explicit confirmation before rotating the shared key", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Rotate key" }));
    await user.click(
      await screen.findByRole("button", { name: "Start rotation" }),
    );

    expect(actions.rotate).toHaveBeenCalledWith(undefined, expect.any(Object));
  });

  it("requires emergency confirmation before disabling during key rotation", async () => {
    fixture.overview = { ...overview(), rotation_state: "rolling_out" };
    const user = userEvent.setup();
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Enabled" });
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Rolling out key" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test all" })).toBeDisabled();

    await user.click(toggle);
    expect(
      await screen.findByText(
        "Disable SSH access during key rotation?",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Revoke both the current and previous workspace keys immediately.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "All daemons will lose mutual SSH trust until access is enabled again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Enabling SSH access again will generate and distribute a new workspace key.",
      ),
    ).toBeInTheDocument();
    expect(actions.toggle).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Disable SSH access during key rotation?"),
      ).not.toBeInTheDocument(),
    );
    expect(actions.toggle).not.toHaveBeenCalled();

    await user.click(toggle);
    act(() => {
      queryClients.at(-1)?.setQueryData(
        ["ssh-mesh", "ws-1"],
        overview(),
      );
    });
    await user.click(
      await screen.findByRole("button", { name: "Revoke keys and disable" }),
    );
    expect(actions.toggle).toHaveBeenCalledTimes(1);
    expect(actions.toggle).toHaveBeenCalledWith(
      { enabled: false, invalidateKeys: true },
      expect.any(Object),
    );
  });

  it("disables immediately without a warning when key state is stable", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("switch", { name: "Enabled" }));

    expect(
      screen.queryByText("Disable SSH access during key rotation?"),
    ).not.toBeInTheDocument();
    expect(actions.toggle).toHaveBeenCalledTimes(1);
    expect(actions.toggle).toHaveBeenCalledWith(
      { enabled: false },
      expect.any(Object),
    );
  });

  it("does not start a probe from an offline source", async () => {
    const current = overview();
    current.runtimes[0] = { ...current.runtimes[0]!, status: "offline" };
    fixture.overview = current;
    const user = userEvent.setup();
    renderPanel();

    const testAll = await screen.findByRole("button", { name: "Test all" });
    expect(testAll).toBeDisabled();
    const workerNames = screen.getAllByText("worker-host");
    const peerRow = workerNames.at(-1)?.closest("li") ?? null;
    expect(peerRow).not.toBeNull();
    expect(within(peerRow!).getByRole("button", { name: "Retry" })).toBeDisabled();

    await user.click(testAll);
    await user.click(within(peerRow!).getByRole("button", { name: "Retry" }));
    expect(actions.test).not.toHaveBeenCalled();
  });

  it("blocks all probes while another SSH action is pending", async () => {
    fixture.rotatePending = true;
    renderPanel();

    expect(
      await screen.findByRole("button", { name: "Test all" }),
    ).toBeDisabled();
    const workerNames = screen.getAllByText("worker-host");
    const peerRow = workerNames.at(-1)?.closest("li") ?? null;
    expect(peerRow).not.toBeNull();
    expect(within(peerRow!).getByRole("button", { name: "Retry" })).toBeDisabled();
  });

  it("does not load or expose the mesh to regular members", async () => {
    fixture.role = "member";
    renderPanel();

    expect(
      await screen.findByText("SSH access is restricted"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("SHA256:dedicated-workspace-key")).not.toBeInTheDocument(),
    );
  });

  it("distinguishes a membership loading failure from permission denial", async () => {
    fixture.memberError = true;
    renderPanel();

    expect(
      await screen.findByText("Couldn't verify SSH access permissions"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("SSH access is restricted")).not.toBeInTheDocument();
  });

  it.each([
    {
      error: new ApiContractError("PUT /api/workspaces/:id/ssh-mesh"),
      expected: "The server returned an invalid SSH access response. Refresh and try again.",
    },
    {
      error: new ApiError("raw forbidden detail", 403, "Forbidden"),
      expected: "Your permission to manage SSH access has changed. Refresh the page.",
    },
    {
      error: new ApiError("raw conflict detail", 409, "Conflict"),
      expected: "SSH access changed in another session. Refresh and try again.",
    },
    {
      error: new ApiError("raw setup detail", 503, "Unavailable"),
      expected: "SSH access isn't configured on the server. Check the encryption key and ssh-keygen setup.",
    },
    {
      error: new TypeError("raw network detail"),
      expected: "The server couldn't be reached. Check the connection and try again.",
    },
  ])("maps action failures to safe guidance", async ({ error, expected }) => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("switch", { name: "Enabled" }));
    const callbacks = actions.toggle.mock.calls[0]?.[1] as
      | { onError?: (cause: unknown) => void }
      | undefined;
    callbacks?.onError?.(error);

    expect(notices.error).toHaveBeenLastCalledWith(expected);
    expect(JSON.stringify(notices.error.mock.calls)).not.toContain("raw ");
  });

  it("uses the expiring-credentials conflict code without exposing daemon details", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("switch", { name: "Enabled" }));
    const callbacks = actions.toggle.mock.calls[0]?.[1] as
      | { onError?: (cause: unknown) => void }
      | undefined;
    callbacks?.onError?.(
      new ApiError("raw credential detail", 409, "Conflict", {
        code: "ssh_mesh_expiring_daemon_credentials",
        daemon_ids: ["private-daemon-id"],
      }),
    );

    expect(notices.error).toHaveBeenLastCalledWith(
      "One or more daemons use expiring credentials. Remove and reconnect them before enabling SSH access.",
    );
    expect(JSON.stringify(notices.error.mock.calls)).not.toContain("private-daemon-id");
  });
});
