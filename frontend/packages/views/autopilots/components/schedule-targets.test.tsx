import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { ScheduleTargets } from "@multiremi/core/types";
import { renderWithI18n } from "../../test/i18n";
import { ScheduleTargetsSection, emptyScheduleTargets } from "./schedule-targets";

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "local" }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "projects"
      ? [{ id: "project-one", title: "Remi", archived_at: null }, { id: "archived", title: "Old", archived_at: "date" }]
      : { repositories: [{ id: "repo-one", name: "Remi" }] },
    isLoading: false, isError: false,
  }),
}));

function Harness({ initial = emptyScheduleTargets() }: { initial?: ScheduleTargets }) {
  const [value, setValue] = useState<ScheduleTargets | null>(initial);
  return <><ScheduleTargetsSection value={value} onChange={setValue} /><output data-testid="value">{JSON.stringify(value)}</output></>;
}

describe("schedule target selection", () => {
  it("selects projects and repositories independently and preserves all as a dynamic selector", () => {
    renderWithI18n(<Harness />, { locale: "zh-Hans" });
    fireEvent.click(within(screen.getByRole("group", { name: "项目" })).getByRole("checkbox", { name: "Remi" }));
    fireEvent.click(within(screen.getByRole("group", { name: "代码仓库" })).getByRole("checkbox", { name: "Remi" }));
    expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({ projects: { all: false, ids: ["project-one"] }, repositories: { all: false, ids: ["repo-one"] } });
    fireEvent.click(within(screen.getByRole("group", { name: "项目" })).getByRole("checkbox", { name: "全部（含后续新增）" }));
    expect(JSON.parse(screen.getByTestId("value").textContent!)).toMatchObject({ projects: { all: true, ids: [] }, repositories: { all: false, ids: ["repo-one"] } });
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
  });

  it("retains missing selections for correction and supports clearing target mode", () => {
    renderWithI18n(<Harness initial={{ projects: { all: false, ids: ["missing"] }, repositories: { all: false, ids: [] } }} />);
    expect(screen.getByText("Unavailable target: missing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Run sequentially per target" }));
    expect(screen.getByTestId("value")).toHaveTextContent("null");
  });

  it("shows the empty selection error and saves schedule-specific instructions", () => {
    renderWithI18n(<Harness />);
    expect(screen.getByRole("alert")).toHaveTextContent("Select at least one project or repository");
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule instructions (blank uses automation description)" }), { target: { value: "Use llm-wiki-lint" } });
    expect(JSON.parse(screen.getByTestId("value").textContent!).prompt).toBe("Use llm-wiki-lint");
  });
});
