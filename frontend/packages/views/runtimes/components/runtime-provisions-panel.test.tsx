// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { RuntimeProvision, RuntimeProvisionState } from "@multiremi/core/runtimes";
import enAutopilots from "../../locales/en/autopilots.json";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";

const fixture = vi.hoisted(() => ({
  role: "member",
  provisions: [] as Array<RuntimeProvision & { raw_command?: string }>,
  states: [] as RuntimeProvisionState[],
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/realtime", () => ({ useWSEvent: vi.fn() }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({
    queryKey: ["members", "ws-1"],
    queryFn: () => Promise.resolve([{ user_id: "user-1", role: fixture.role }]),
  }),
}));
vi.mock("@multiremi/core/runtimes/queries", () => ({
  runtimeKeys: {
    provisions: (wsId: string) => ["runtimes", wsId, "provisions"],
    provisionStates: (wsId: string, provisionId: string) => ["runtimes", wsId, "provisions", provisionId, "states"],
  },
  runtimeListOptions: () => ({
    queryKey: ["runtimes", "ws-1", "list"],
    queryFn: () => Promise.resolve([
      { id: "rt-failed", name: "Failed runtime" },
      { id: "rt-pending", name: "Pending runtime" },
      { id: "rt-ready", name: "Ready runtime" },
    ]),
  }),
}));
vi.mock("@multiremi/core/runtimes", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/runtimes")>("@multiremi/core/runtimes");
  return {
    ...actual,
    runtimeProvisionsOptions: () => ({
      queryKey: ["runtimes", "ws-1", "provisions"],
      queryFn: () => Promise.resolve(fixture.provisions),
    }),
    runtimeProvisionStatesOptions: (_wsId: string, provisionId: string | null) => ({
      queryKey: ["runtimes", "ws-1", "provisions", provisionId, "states"],
      queryFn: () => Promise.resolve(fixture.states),
      enabled: Boolean(provisionId),
    }),
    useCreateRuntimeProvision: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpdateRuntimeProvision: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteRuntimeProvision: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

import {
  RuntimeProvisionsPanel,
  sortRuntimeProvisionStates,
} from "./runtime-provisions-panel";

const resources = {
  en: { common: enCommon, runtimes: enRuntimes, autopilots: enAutopilots },
};
const queryClients: QueryClient[] = [];

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  return render(
    <I18nProvider locale="en" resources={resources}>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvisionsPanel />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("RuntimeProvisionsPanel", () => {
  beforeEach(() => {
    fixture.role = "member";
    fixture.provisions = [{
      id: "prov-1",
      workspace_id: "ws-1",
      kind: "command",
      enabled: true,
      package: null,
      version: null,
      version_check: false,
      bin: null,
      registry: null,
      command: "1passport sync --token [REDACTED]",
      args: [],
      trigger_kinds: ["cron"],
      cron_expression: "*/10 * * * *",
      timezone: "UTC",
      next_run_at: null,
      last_fired_at: null,
      timeout_ms: 60_000,
      created_by: "admin-1",
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
      raw_command: "SECRET_SHOULD_NOT_RENDER",
    }];
    fixture.states = [
      state("rt-ready", "converged"),
      state("rt-pending", "pending"),
      state("rt-failed", "failed"),
    ];
  });

  afterEach(() => {
    cleanup();
    for (const client of queryClients.splice(0)) client.clear();
  });

  it("sorts failed and pending Runtime states before converged rows", () => {
    expect(sortRuntimeProvisionStates(fixture.states).map((entry) => entry.status)).toEqual([
      "failed",
      "pending",
      "converged",
    ]);
  });

  it("keeps member access read-only and renders only the redacted command field", async () => {
    renderPanel();

    expect(await screen.findAllByText("1passport sync --token [REDACTED]")).not.toHaveLength(0);
    expect(screen.queryByText("SECRET_SHOULD_NOT_RENDER")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add provision" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit provision" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete provision" })).not.toBeInTheDocument();
    expect(await screen.findByText("Failed runtime")).toBeInTheDocument();
  });
});

function state(runtimeId: string, status: string): RuntimeProvisionState {
  return {
    provision_id: "prov-1",
    runtime_id: runtimeId,
    status,
    observed_version: status === "converged" ? "1.0.0" : null,
    last_command_request_id: null,
    last_checked_at: "2026-08-26T00:00:00.000Z",
    last_error: status === "failed" ? "redacted failure" : null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
}
