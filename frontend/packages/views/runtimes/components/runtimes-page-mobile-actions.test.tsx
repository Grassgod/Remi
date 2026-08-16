// @vitest-environment jsdom

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import type { DaemonInventoryEntry } from "@multiremi/core/runtimes";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const fixture = vi.hoisted(() => ({
  runtimes: [] as AgentRuntime[],
  daemons: [] as DaemonInventoryEntry[],
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return {
    ...actual,
    useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      const key = queryKey.join(":");
      if (key === "runtimes:ws-1:list") {
        return { data: fixture.runtimes, isLoading: false };
      }
      if (key === "runtimes:daemons:inventory:ws-1") {
        return {
          data: { workspace_id: "ws-1", daemons: fixture.daemons },
          isLoading: false,
        };
      }
      if (key === "workspaces:ws-1:members") {
        return { data: [{ user_id: "user-1", role: "owner" }] };
      }
      return { data: [] };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ isLoading: false, user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/realtime", () => ({ useWSEvent: vi.fn() }));
vi.mock("@multiremi/core/runtimes/hooks", () => ({
  useUpdatableRuntimeIds: () => new Set<string>(),
}));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));
vi.mock("./provider-logo", () => ({ ProviderLogo: () => null }));
vi.mock("./runtime-list", async () => {
  const actual =
    await vi.importActual<typeof import("./runtime-list")>("./runtime-list");
  return {
    ...actual,
    RuntimeList: () => <div data-testid="runtime-list" />,
  };
});
vi.mock("./connect-remote-dialog", () => ({
  ConnectRemoteDialog: () => null,
}));
vi.mock("./cloud-runtime-dialog", () => ({ CloudRuntimeDialog: () => null }));
vi.mock("./retire-daemon-dialog", () => ({
  RetireDaemonDialog: ({ daemonId }: { daemonId: string }) => (
    <div role="dialog">retiring {daemonId}</div>
  ),
}));

import { RuntimesPage, type RuntimesPageProps } from "./runtimes-page";

const resources = { en: { common: enCommon, runtimes: enRuntimes } };

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const now = new Date().toISOString();
  return {
    id: "runtime-1",
    workspace_id: "ws-1",
    daemon_id: "daemon-1",
    name: "Claude (build-host)",
    runtime_mode: "local",
    provider: "claude",
    launch_header: "",
    status: "online",
    device_info: "build-host",
    metadata: {},
    owner_id: "user-1",
    visibility: "private",
    last_seen_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function renderPage(props: RuntimesPageProps = {}) {
  return render(
    <I18nProvider locale="en" resources={resources}>
      <RuntimesPage {...props} />
    </I18nProvider>,
  );
}

describe("RuntimesPage mobile machine actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.runtimes = [makeRuntime()];
    fixture.daemons = [
      {
        daemon_id: "daemon-1",
        runtime_count: 1,
        token_count: 1,
        last_seen: new Date().toISOString(),
        name: "build-host",
      },
    ];
  });

  it("keeps daemon removal reachable in the page header", async () => {
    const user = userEvent.setup();
    renderPage({ cloudRuntimeEnabled: true });

    const action = screen.getByRole("button", { name: "Runtime actions" });
    const pageHeading = screen.getByRole("heading", {
      level: 1,
      name: "Runtimes",
    });
    const pageHeader = pageHeading.parentElement?.parentElement;

    expect(screen.getAllByRole("button", { name: "Runtime actions" })).toHaveLength(1);
    expect(pageHeader).toContainElement(action);

    await user.click(action);
    expect(
      await screen.findByRole("menuitem", { name: "Add a computer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Cloud Runtime" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "Deactivate and remove" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("retiring daemon-1");
  });

  it("bounds a long machine list so the selected machine detail remains mounted", () => {
    fixture.runtimes = Array.from({ length: 12 }, (_, index) =>
      makeRuntime({
        id: `runtime-${index + 1}`,
        daemon_id: `daemon-${index + 1}`,
        name: `Claude (build-host-${index + 1})`,
        device_info: `build-host-${index + 1}`,
      }),
    );
    renderPage();

    expect(screen.getByRole("complementary")).toHaveClass("max-h-[42dvh]");
    expect(
      screen.getByRole("heading", { level: 2, name: "build-host-1" }),
    ).toBeInTheDocument();
  });

  it("keeps a token-only daemon visible and retireable", async () => {
    const user = userEvent.setup();
    fixture.runtimes = [];
    fixture.daemons = [
      {
        daemon_id: "daemon-token-only-123456789",
        runtime_count: 0,
        token_count: 1,
        last_seen: null,
        name: "Provisioning token",
      },
    ];
    renderPage();

    expect(
      screen.getByRole("heading", { level: 2, name: "daemon-t..." }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Provisioning token")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Runtime actions" }),
    );
    await screen.findByRole("menuitem", { name: "Add a computer" });
    await user.click(
      screen.getByRole("menuitem", { name: "Deactivate and remove" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "retiring daemon-token-only-123456789",
    );
  });
});
