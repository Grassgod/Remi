import { Profiler, act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentRuntime } from "@multiremi/core/types";
import { RuntimeList } from "./runtime-list";

const queries = vi.hoisted(() => ({
  agents: { data: undefined },
  members: { data: undefined },
  snapshot: { data: undefined },
  latest: { data: null },
}));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { kind: keyof typeof queries }) => queries[options.kind],
}));
vi.mock("@multiremi/core/workspace/queries", () => ({
  agentListOptions: () => ({ kind: "agents" }),
  memberListOptions: () => ({ kind: "members" }),
}));
vi.mock("@multiremi/core/agents", () => ({
  agentTaskSnapshotOptions: () => ({ kind: "snapshot" }),
}));
vi.mock("@multiremi/core/runtimes", () => ({
  latestCliVersionOptions: () => ({ kind: "latest" }),
}));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) =>
    selector({ user: null }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspaceSlug: () => "workspace",
  paths: {
    workspace: (slug: string) => ({
      runtimeDetail: (runtimeId: string) => `/${slug}/runtimes/${runtimeId}`,
    }),
  },
}));
vi.mock("../../navigation", () => ({ useNavigation: () => navigation }));
vi.mock("../../i18n", () => ({ useT: () => ({ t: String }) }));
vi.mock("./runtime-columns", () => ({
  createRuntimeColumns: () => [
    { accessorKey: "runtime.name", header: "Runtime" },
  ],
}));

const runtimes: AgentRuntime[] = [{
  id: "runtime-1",
  workspace_id: "ws-1",
  daemon_id: "daemon-1",
  name: "Test runtime",
  runtime_mode: "local",
  provider: "claude",
  launch_header: "",
  status: "online",
  device_info: "host",
  metadata: {},
  owner_id: null,
  visibility: "private",
  last_seen_at: "2026-09-08T08:49:00Z",
  created_at: "2026-09-08T08:49:00Z",
  updated_at: "2026-09-08T08:49:00Z",
}];

afterEach(cleanup);

describe("RuntimeList rendering", () => {
  it("settles after a health tick while supporting queries have no data", async () => {
    let commits = 0;
    const onRender = () => {
      commits += 1;
      if (commits > 20) throw new Error("Runtime table did not settle");
    };
    const view = (now: number, data = runtimes) => (
      <Profiler id="runtime-list" onRender={onRender}>
        <RuntimeList runtimes={data} now={now} />
      </Profiler>
    );
    const rendered = render(view(0));
    await act(async () => {});
    await act(async () => rendered.rerender(view(30_000)));
    expect(screen.getByText("Test runtime")).toBeInTheDocument();
    expect(commits).toBeLessThan(6);
    await act(async () => rendered.rerender(view(60_000, [...runtimes])));
    expect(commits).toBeLessThan(9);
    fireEvent.click(screen.getByText("Test runtime"));
    expect(navigation.push).toHaveBeenCalledWith("/workspace/runtimes/runtime-1");
  });
});
