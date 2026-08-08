// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
import {
  AvailabilityChip,
  WorkloadChip,
  workloadTone,
} from "./agent-presence-indicator";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

function renderWithI18n(node: ReactNode) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {node}
    </I18nProvider>
  );
}

afterEach(() => cleanup());

describe("AvailabilityChip", () => {
  it("renders the dot in the availability colour next to the label", () => {
    const { container } = renderWithI18n(
      <AvailabilityChip availability="online" />
    );

    expect(screen.getByText("Online")).toBeInTheDocument();
    const dot = container.querySelector("span > span");
    expect(dot?.className).toContain("rounded-full");
    expect(dot?.className).toContain("bg-success");
  });

  it("greys the dot for offline and archived agents", () => {
    const { container } = renderWithI18n(
      <AvailabilityChip availability="offline" />
    );
    expect(container.querySelector("span > span")?.className).toContain(
      "bg-muted-foreground/40"
    );
  });

  it("uses the warning colour for unstable runtimes", () => {
    const { container } = renderWithI18n(
      <AvailabilityChip availability="unstable" />
    );
    expect(container.querySelector("span > span")?.className).toContain(
      "bg-warning"
    );
  });
});

describe("workloadTone", () => {
  it("keeps the workload colour for non-queued states", () => {
    expect(workloadTone("working", "online")).toBe("text-brand");
    expect(workloadTone("idle", "offline")).toBe("text-muted-foreground");
  });

  it("mutes queued on a healthy runtime — that is a transient race", () => {
    expect(workloadTone("queued", "online")).toBe("text-muted-foreground");
  });

  it("keeps queued amber everywhere else — that is the stuck signal", () => {
    expect(workloadTone("queued", "offline")).toBe("text-warning");
    expect(workloadTone("queued", "unstable")).toBe("text-warning");
  });
});

describe("WorkloadChip", () => {
  it("renders a spinning icon and the counts while working", () => {
    const { container } = renderWithI18n(
      <WorkloadChip workload="working" counts="2/3" />
    );

    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "animate-spin"
    );
  });

  it("renders no icon when idle", () => {
    const { container } = renderWithI18n(<WorkloadChip workload="idle" />);

    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("applies the caller's tone to both icon and label", () => {
    const { container } = renderWithI18n(
      <WorkloadChip workload="queued" tone="text-muted-foreground" counts="2" />
    );

    expect(screen.getByText("Queued").className).toContain(
      "text-muted-foreground"
    );
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "text-muted-foreground"
    );
  });

  it("defaults the tone to the workload colour", () => {
    renderWithI18n(<WorkloadChip workload="queued" />);
    expect(screen.getByText("Queued").className).toContain("text-warning");
  });

  it("lets the runtimes table tabular-align its counts", () => {
    renderWithI18n(
      <WorkloadChip
        workload="working"
        counts="4"
        countsClassName="font-mono tabular-nums"
      />
    );
    expect(screen.getByText("4").className).toBe(
      "truncate font-mono tabular-nums text-muted-foreground"
    );
  });

  it("keeps the agents table's plain counts span", () => {
    renderWithI18n(<WorkloadChip workload="working" counts="1/3" />);
    expect(screen.getByText("1/3").className).toBe(
      "truncate text-muted-foreground"
    );
  });
});
